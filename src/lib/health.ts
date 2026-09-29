import "server-only";
import { db } from "@/db/client";
import { retentionSettings } from "@/db/schema";
import { sql } from "drizzle-orm";
import { getHealthCheckStatus } from "./reconcile";

/**
 * SYSTEM HEALTH (V3 Phase K, spec §49)
 * ===========================================================================
 *
 * A Government-only, ON-DEMAND view of how much room the database is using and
 * how much of what it holds is temporary.
 *
 * NOTHING HERE IS STORED. Every number below is produced by a query at the
 * moment somebody opens the page and is thrown away when the response ends.
 * There is no metrics table, no history, no daily snapshot and no analytics of
 * any kind (spec §57) — because a size history is exactly the sort of table
 * that quietly becomes the largest thing in a small database.
 *
 * WHY THESE PARTICULAR NUMBERS
 * ---------------------------------------------------------------------------
 * The deployment target is Neon's free tier, where storage is the binding
 * constraint (spec §38). So the questions worth answering are: how big is the
 * database, what is making it big, how much of that is index rather than data,
 * and how much of it is scheduled to go away by itself. Everything else is
 * decoration.
 *
 * NEON COMPATIBILITY
 * ---------------------------------------------------------------------------
 * These are the standard Postgres administration functions — `pg_database_size`,
 * `pg_total_relation_size`, `pg_relation_size`, `pg_indexes_size` — reading the
 * ordinary `pg_class` / `pg_stat_user_tables` catalogs. They need no extension
 * and no superuser, which is what makes them safe on Neon, where a project's
 * role is not a superuser and `pg_stat_statements`-style tooling is not
 * something to rely on.
 *
 * `pg_stat_user_tables.n_live_tup` is an ESTIMATE maintained by the statistics
 * collector, and that is deliberate: an exact `count(*)` per table would scan
 * every table on every page view. The one place exactness matters — the
 * temporary-row counts the Government is deciding whether to clean — is
 * counted properly, because those predicates are narrow and indexed.
 */

export type TableSize = {
  table: string;
  /** Data + indexes + TOAST. */
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  /** Planner estimate, not an exact count — see the note above. */
  estimatedRows: number;
};

export type IndexSize = {
  index: string;
  table: string;
  bytes: number;
};

export type CleanableCount = {
  key: string;
  label: string;
  rows: number;
  /** What the retention engine does to these rows when it runs. */
  disposition: string;
};

export type SystemHealth = {
  generatedAt: Date;
  databaseName: string;
  databaseBytes: number;
  tables: TableSize[];
  indexes: IndexSize[];
  cleanable: CleanableCount[];
  cleanableTotal: number;
  lastCleanupAt: Date | null;
  lastCleanupSuccessAt: Date | null;
  lastCleanupSummary: unknown;
  lastScrubAt: Date | null;
  reconciliation: Awaited<ReturnType<typeof getHealthCheckStatus>> | null;
};

/** Human-readable bytes. Binary units, because that is what Postgres reports. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

type Rows<T> = { rows: T[] };

async function readTableSizes(limit: number): Promise<TableSize[]> {
  const result = await db.execute(sql`
    SELECT
      c.relname::text                                       AS table_name,
      pg_total_relation_size(c.oid)::bigint                 AS total_bytes,
      pg_relation_size(c.oid)::bigint                       AS table_bytes,
      pg_indexes_size(c.oid)::bigint                        AS index_bytes,
      coalesce(s.n_live_tup, 0)::bigint                     AS estimated_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE c.relkind = 'r' AND n.nspname = 'public'
    ORDER BY pg_total_relation_size(c.oid) DESC
    LIMIT ${limit}
  `);
  const rows = (result as unknown as Rows<Record<string, unknown>>).rows ?? [];
  return rows.map((r) => ({
    table: String(r.table_name),
    totalBytes: Number(r.total_bytes ?? 0),
    tableBytes: Number(r.table_bytes ?? 0),
    indexBytes: Number(r.index_bytes ?? 0),
    estimatedRows: Number(r.estimated_rows ?? 0),
  }));
}

async function readIndexSizes(limit: number): Promise<IndexSize[]> {
  const result = await db.execute(sql`
    SELECT
      i.relname::text               AS index_name,
      t.relname::text               AS table_name,
      pg_relation_size(i.oid)::bigint AS bytes
    FROM pg_class i
    JOIN pg_index x   ON x.indexrelid = i.oid
    JOIN pg_class t   ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = i.relnamespace
    WHERE i.relkind = 'i' AND n.nspname = 'public'
    ORDER BY pg_relation_size(i.oid) DESC
    LIMIT ${limit}
  `);
  const rows = (result as unknown as Rows<Record<string, unknown>>).rows ?? [];
  return rows.map((r) => ({
    index: String(r.index_name),
    table: String(r.table_name),
    bytes: Number(r.bytes ?? 0),
  }));
}

/**
 * How many rows each cleanable target currently holds.
 *
 * These are EXACT counts, because they are the numbers the Government acts on.
 * Each predicate is the same one the retention engine uses (src/lib/retention.ts)
 * without its age cut-off, so the figure answers "how much temporary data
 * exists", not "how much is due right now" — the second number moves every day
 * and would make the page look unstable for no benefit.
 */
async function readCleanableCounts(): Promise<CleanableCount[]> {
  const result = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM notifications)                                          AS notifications,
      (SELECT count(*) FROM support_messages)                                       AS support_messages,
      (SELECT count(*) FROM updates)                                                AS updates,
      (SELECT count(*) FROM audit_logs)                                             AS audit_logs,
      (SELECT count(*) FROM idempotency_keys)                                       AS idempotency_keys,
      (SELECT count(*) FROM marketplace_offers WHERE status = 'PAUSED')             AS paused_offers,
      (SELECT count(*) FROM marketplace_order_ratings WHERE comment IS NOT NULL)    AS rating_comments,
      (SELECT count(*) FROM marketplace_wanted_requests
         WHERE status IN ('EXPIRED', 'CANCELLED'))                                  AS closed_wanted,
      (SELECT count(*) FROM marketplace_orders
         WHERE status IN ('EXPIRED', 'CANCELLED'))                                  AS closed_orders,
      (SELECT count(*) FROM marketplace_contract_applications a
         JOIN marketplace_contracts c ON c.id = a.contract_id
         WHERE c.status IN ('EXPIRED', 'CANCELLED'))                                AS closed_applications,
      (SELECT count(*) FROM promotion_campaigns
         WHERE status IN ('REJECTED', 'CANCELLED') AND total_charged = 0)           AS dead_campaigns
  `);
  const row = (result as unknown as Rows<Record<string, unknown>>).rows[0] ?? {};
  const n = (k: string) => Number(row[k] ?? 0);

  return [
    {
      key: "notifications",
      label: "Notifications",
      rows: n("notifications"),
      disposition: "Deleted once older than the configured period.",
    },
    {
      key: "support_messages",
      label: "Support messages",
      rows: n("support_messages"),
      disposition: "Deleted once older than the configured period.",
    },
    {
      key: "updates",
      label: "Government updates",
      rows: n("updates"),
      disposition: "Deleted once older than the configured period (NULL = keep forever).",
    },
    {
      key: "audit_logs",
      label: "Audit log entries",
      rows: n("audit_logs"),
      disposition: "Archived on request only — never deleted by the schedule.",
    },
    {
      key: "idempotency_keys",
      label: "Idempotency keys",
      rows: n("idempotency_keys"),
      disposition: "Purged after their own expiry (24 hours by default).",
    },
    {
      key: "paused_offers",
      label: "Paused marketplace listings",
      rows: n("paused_offers"),
      disposition: "Closed out after the paused-offer period. The row stays; only the status changes.",
    },
    {
      key: "rating_comments",
      label: "Rating comments still present",
      rows: n("rating_comments"),
      disposition: "The comment text is blanked at its expiry. The star is permanent.",
    },
    {
      key: "closed_wanted",
      label: "Expired / cancelled wanted requests",
      rows: n("closed_wanted"),
      disposition: "Deleted with their responses after the configured period.",
    },
    {
      key: "closed_orders",
      label: "Expired / cancelled orders",
      rows: n("closed_orders"),
      disposition: "Deleted after the configured period. A paid or completed order is never deleted.",
    },
    {
      key: "closed_applications",
      label: "Applications on closed contracts",
      rows: n("closed_applications"),
      disposition: "Deleted after the configured period. The contract itself is kept.",
    },
    {
      key: "dead_campaigns",
      label: "Rejected / cancelled promotions never charged",
      rows: n("dead_campaigns"),
      disposition: "Deleted after the configured period. A charged campaign is kept.",
    },
  ];
}

/**
 * Everything the system-health page shows, gathered in one pass.
 *
 * Read-only from first line to last: no counter is incremented, no row is
 * written, and calling this twice costs exactly twice as much as calling it
 * once and changes nothing.
 */
export async function getSystemHealth(options?: {
  tableLimit?: number;
  indexLimit?: number;
}): Promise<SystemHealth> {
  const tableLimit = options?.tableLimit ?? 15;
  const indexLimit = options?.indexLimit ?? 12;

  const [dbResult, tables, indexes, cleanable, settingsRows, reconciliation] = await Promise.all([
    db.execute(sql`
      SELECT current_database()::text AS name,
             pg_database_size(current_database())::bigint AS bytes
    `),
    readTableSizes(tableLimit),
    readIndexSizes(indexLimit),
    readCleanableCounts(),
    db
      .select({
        lastCleanupAt: retentionSettings.lastCleanupAt,
        lastCleanupSuccessAt: retentionSettings.lastCleanupSuccessAt,
        lastCleanupSummary: retentionSettings.lastCleanupSummary,
        lastScrubAt: retentionSettings.lastScrubAt,
      })
      .from(retentionSettings)
      .limit(1),
    getHealthCheckStatus().catch(() => null),
  ]);

  const dbRow = (dbResult as unknown as Rows<Record<string, unknown>>).rows[0] ?? {};
  const settings = settingsRows[0] ?? null;

  return {
    generatedAt: new Date(),
    databaseName: String(dbRow.name ?? "unknown"),
    databaseBytes: Number(dbRow.bytes ?? 0),
    tables,
    indexes,
    cleanable,
    cleanableTotal: cleanable.reduce((sum, c) => sum + c.rows, 0),
    lastCleanupAt: settings?.lastCleanupAt ?? null,
    lastCleanupSuccessAt: settings?.lastCleanupSuccessAt ?? null,
    lastCleanupSummary: settings?.lastCleanupSummary ?? null,
    lastScrubAt: settings?.lastScrubAt ?? null,
    reconciliation,
  };
}
