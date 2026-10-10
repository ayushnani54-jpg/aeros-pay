import "server-only";
import { db } from "@/db/client";
import {
  auditLogs,
  government,
  invoices,
  issuanceRequests,
  loans,
  notifications,
  retentionSettings,
  supportMessages,
  transactions,
  updates,
} from "@/db/schema";
import * as schemaTables from "@/db/schema";
import { and, getTableName, is, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { recordAudit } from "./audit";
import { startOfIstDay } from "./datetime";
import type { RetentionSettings } from "@/db/schema";

/**
 * DATA RETENTION (spec §49–52)
 *
 * Hard rule enforced by this module: only DISPOSABLE data is ever deleted.
 *
 *   Deletable   updates, notifications, support messages
 *   Never       transactions, users, companies, invoices, issuance records,
 *               government/treasury rows
 *
 * The transactions table is deliberately absent from every code path here.
 * Deleting ledger rows would silently corrupt balances, supply and tax totals
 * (spec §50), so there is simply no function that can do it.
 *
 * Audit logs are not deleted either — they can only be ARCHIVED, which sets
 * `archived_at` so the row drops out of the active view while remaining in
 * the database and in every reconciliation (spec §51).
 */

export class RetentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionError";
  }
}

export async function getRetentionSettings(): Promise<RetentionSettings> {
  const [existing] = await db.select().from(retentionSettings).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(retentionSettings).values({}).returning();
  return created;
}

export async function updateRetentionSettings(params: {
  updatesRetentionDays: number | null;
  notificationsRetentionDays: number | null;
  supportRetentionDays: number | null;
  governmentId: string;
  governmentUsername: string;
}): Promise<RetentionSettings> {
  const current = await getRetentionSettings();

  const [updated] = await db
    .update(retentionSettings)
    .set({
      updatesRetentionDays: params.updatesRetentionDays,
      notificationsRetentionDays: params.notificationsRetentionDays,
      supportRetentionDays: params.supportRetentionDays,
      updatedAt: new Date(),
    })
    .returning();

  await recordAudit(db, {
    action: "RETENTION_SETTINGS_CHANGED",
    actorType: "GOVERNMENT",
    actorId: params.governmentId,
    actorLabel: params.governmentUsername,
    previousValue: JSON.stringify({
      updates: current.updatesRetentionDays,
      notifications: current.notificationsRetentionDays,
      support: current.supportRetentionDays,
    }),
    newValue: JSON.stringify({
      updates: updated.updatesRetentionDays,
      notifications: updated.notificationsRetentionDays,
      support: updated.supportRetentionDays,
    }),
  });

  return updated;
}


/**
 * V3 note. The V2 preview/run pair that used to live here — three hardcoded
 * classes, one unbounded DELETE each — has been REPLACED by the allowlist-
 * driven, batched engine at the bottom of this file (`previewFullCleanup` /
 * `runFullCleanup`). Updates, notifications and support messages are now the
 * first three entries in `CLEANUP_TARGETS` and behave identically, with the
 * same settings columns and the same "NULL = never" rule; they are simply
 * swept in bounded batches alongside the V3 classes instead of in one
 * statement that could lock the table.
 */

/** Clears the public announcements feed. Never touches financial data. */
export async function clearAllUpdates(params: {
  governmentId: string;
  governmentUsername: string;
}): Promise<number> {
  const rows = await db.delete(updates).returning({ id: updates.id });

  await recordAudit(db, {
    action: "UPDATES_CLEARED",
    actorType: "GOVERNMENT",
    actorId: params.governmentId,
    actorLabel: params.governmentUsername,
    metadata: { deleted: rows.length },
  });

  return rows.length;
}

/**
 * Archives audit entries older than `days` — they stay in the database and
 * remain fully recoverable, they simply stop appearing in the active view.
 * There is no function anywhere that deletes audit rows (spec §51).
 */
export async function archiveAuditLogs(params: {
  olderThanDays: number;
  governmentId: string;
  governmentUsername: string;
}): Promise<number> {
  const cutoff = new Date(Date.now() - params.olderThanDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .update(auditLogs)
    .set({ archivedAt: new Date() })
    .where(and(lt(auditLogs.createdAt, cutoff), isNull(auditLogs.archivedAt)))
    .returning({ id: auditLogs.id });

  await recordAudit(db, {
    action: "AUDIT_LOGS_ARCHIVED",
    actorType: "GOVERNMENT",
    actorId: params.governmentId,
    actorLabel: params.governmentUsername,
    metadata: { archived: rows.length, olderThanDays: params.olderThanDays },
  });

  return rows.length;
}

export async function unarchiveAllAuditLogs(params: {
  governmentId: string;
  governmentUsername: string;
}): Promise<number> {
  const rows = await db
    .update(auditLogs)
    .set({ archivedAt: null })
    .returning({ id: auditLogs.id });

  await recordAudit(db, {
    action: "AUDIT_LOGS_UNARCHIVED",
    actorType: "GOVERNMENT",
    actorId: params.governmentId,
    actorLabel: params.governmentUsername,
    metadata: { restored: rows.length },
  });

  return rows.length;
}

/** Row counts per table, for the Government's storage view. */
export async function getStorageCounts() {
  const [
    updatesCount,
    notifCount,
    supportCount,
    auditCount,
    auditArchivedCount,
  ] = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(updates),
    db.select({ c: sql<number>`count(*)::int` }).from(notifications),
    db.select({ c: sql<number>`count(*)::int` }).from(supportMessages),
    db.select({ c: sql<number>`count(*)::int` }).from(auditLogs),
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(sql`${auditLogs.archivedAt} IS NOT NULL`),
  ]);

  return {
    updates: updatesCount[0]?.c ?? 0,
    notifications: notifCount[0]?.c ?? 0,
    supportMessages: supportCount[0]?.c ?? 0,
    auditLogs: auditCount[0]?.c ?? 0,
    auditLogsArchived: auditArchivedCount[0]?.c ?? 0,
  };
}

// ---------------------------------------------------------------------------
// V2.1 — TEXT-FIELD SCRUBBING
// ---------------------------------------------------------------------------
//
// A separate, narrower capability from row deletion above: this NEVER
// deletes a row and NEVER touches a column that affects a balance, the
// ledger, or an identity — only specific free-text columns, and only once
// the row is older than the configured age. Every column it can touch is
// listed explicitly below; anything not listed is untouched by design.
//
//   transactions        reason                                        (only)
//   invoices             description, note                            (only)
//   loans                purpose, rejection_reason,
//                        default_reason, restructure_note              (only)
//   issuance_requests    note                                          (only)
//
// Idempotent: every scrub is a conditional UPDATE guarded on the column not
// already being cleared, so running it twice (or on a schedule) is always
// safe and the second run reports zero newly-changed rows.

/** Marker left in place of a scrubbed free-text field, so it stays visibly
 * distinguishable from a field that legitimately was never filled in. */
export const TEXT_SCRUB_MARKER = "[cleared]";

function scrubCutoff(maxAgeDays: number): Date {
  return new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
}

/** True for a nullable text column that still holds real, unscrubbed content. */
function holdsUnscrubbedText(column: Parameters<typeof isNotNull>[0]) {
  return and(isNotNull(column), ne(column, TEXT_SCRUB_MARKER));
}

async function scrubTransactionReasons(maxAgeDays: number): Promise<number> {
  const cutoff = scrubCutoff(maxAgeDays);
  const rows = await db
    .update(transactions)
    .set({ reason: TEXT_SCRUB_MARKER })
    .where(and(lt(transactions.createdAt, cutoff), holdsUnscrubbedText(transactions.reason)))
    .returning({ id: transactions.id });
  return rows.length;
}

async function scrubInvoiceText(maxAgeDays: number): Promise<number> {
  const cutoff = scrubCutoff(maxAgeDays);
  const rows = await db
    .update(invoices)
    .set({
      description: sql`CASE WHEN ${invoices.description} IS NOT NULL AND ${invoices.description} <> ${TEXT_SCRUB_MARKER} THEN ${TEXT_SCRUB_MARKER} ELSE ${invoices.description} END`,
      note: sql`CASE WHEN ${invoices.note} IS NOT NULL AND ${invoices.note} <> ${TEXT_SCRUB_MARKER} THEN ${TEXT_SCRUB_MARKER} ELSE ${invoices.note} END`,
    })
    .where(
      and(
        lt(invoices.createdAt, cutoff),
        or(holdsUnscrubbedText(invoices.description), holdsUnscrubbedText(invoices.note)),
      ),
    )
    .returning({ id: invoices.id });
  return rows.length;
}

async function scrubLoanText(maxAgeDays: number): Promise<number> {
  const cutoff = scrubCutoff(maxAgeDays);
  // `purpose` is NOT NULL, so it is compared directly rather than through
  // `holdsUnscrubbedText` (which also accepts NULL as "nothing to do").
  const rows = await db
    .update(loans)
    .set({
      purpose: sql`CASE WHEN ${loans.purpose} <> ${TEXT_SCRUB_MARKER} THEN ${TEXT_SCRUB_MARKER} ELSE ${loans.purpose} END`,
      rejectionReason: sql`CASE WHEN ${loans.rejectionReason} IS NOT NULL AND ${loans.rejectionReason} <> ${TEXT_SCRUB_MARKER} THEN ${TEXT_SCRUB_MARKER} ELSE ${loans.rejectionReason} END`,
      defaultReason: sql`CASE WHEN ${loans.defaultReason} IS NOT NULL AND ${loans.defaultReason} <> ${TEXT_SCRUB_MARKER} THEN ${TEXT_SCRUB_MARKER} ELSE ${loans.defaultReason} END`,
      restructureNote: sql`CASE WHEN ${loans.restructureNote} IS NOT NULL AND ${loans.restructureNote} <> ${TEXT_SCRUB_MARKER} THEN ${TEXT_SCRUB_MARKER} ELSE ${loans.restructureNote} END`,
    })
    .where(
      and(
        lt(loans.createdAt, cutoff),
        or(
          ne(loans.purpose, TEXT_SCRUB_MARKER),
          holdsUnscrubbedText(loans.rejectionReason),
          holdsUnscrubbedText(loans.defaultReason),
          holdsUnscrubbedText(loans.restructureNote),
        ),
      ),
    )
    .returning({ id: loans.id });
  return rows.length;
}

async function scrubIssuanceNotes(maxAgeDays: number): Promise<number> {
  const cutoff = scrubCutoff(maxAgeDays);
  const rows = await db
    .update(issuanceRequests)
    .set({ note: TEXT_SCRUB_MARKER })
    .where(and(lt(issuanceRequests.createdAt, cutoff), holdsUnscrubbedText(issuanceRequests.note)))
    .returning({ id: issuanceRequests.id });
  return rows.length;
}

export type TextScrubPreview = {
  transactions: { maxAgeDays: number | null; eligible: number };
  invoices: { maxAgeDays: number | null; eligible: number };
  loans: { maxAgeDays: number | null; eligible: number };
  issuanceNotes: { maxAgeDays: number | null; eligible: number };
  lastScrubAt: Date | null;
};

/** How many rows each configured scrub policy would touch right now. */
export async function previewTextScrub(): Promise<TextScrubPreview> {
  const settings = await getRetentionSettings();

  const [txCount, invCount, loanCount, issCount] = await Promise.all([
    settings.transactionReasonMaxAgeDays === null
      ? Promise.resolve(0)
      : db
          .select({ c: sql<number>`count(*)::int` })
          .from(transactions)
          .where(
            and(
              lt(transactions.createdAt, scrubCutoff(settings.transactionReasonMaxAgeDays)),
              holdsUnscrubbedText(transactions.reason),
            ),
          )
          .then((r) => r[0]?.c ?? 0),
    settings.invoiceTextMaxAgeDays === null
      ? Promise.resolve(0)
      : db
          .select({ c: sql<number>`count(*)::int` })
          .from(invoices)
          .where(
            and(
              lt(invoices.createdAt, scrubCutoff(settings.invoiceTextMaxAgeDays)),
              or(holdsUnscrubbedText(invoices.description), holdsUnscrubbedText(invoices.note)),
            ),
          )
          .then((r) => r[0]?.c ?? 0),
    settings.loanTextMaxAgeDays === null
      ? Promise.resolve(0)
      : db
          .select({ c: sql<number>`count(*)::int` })
          .from(loans)
          .where(
            and(
              lt(loans.createdAt, scrubCutoff(settings.loanTextMaxAgeDays)),
              or(
                ne(loans.purpose, TEXT_SCRUB_MARKER),
                holdsUnscrubbedText(loans.rejectionReason),
                holdsUnscrubbedText(loans.defaultReason),
                holdsUnscrubbedText(loans.restructureNote),
              ),
            ),
          )
          .then((r) => r[0]?.c ?? 0),
    settings.issuanceNoteMaxAgeDays === null
      ? Promise.resolve(0)
      : db
          .select({ c: sql<number>`count(*)::int` })
          .from(issuanceRequests)
          .where(
            and(
              lt(issuanceRequests.createdAt, scrubCutoff(settings.issuanceNoteMaxAgeDays)),
              holdsUnscrubbedText(issuanceRequests.note),
            ),
          )
          .then((r) => r[0]?.c ?? 0),
  ]);

  return {
    transactions: { maxAgeDays: settings.transactionReasonMaxAgeDays, eligible: txCount },
    invoices: { maxAgeDays: settings.invoiceTextMaxAgeDays, eligible: invCount },
    loans: { maxAgeDays: settings.loanTextMaxAgeDays, eligible: loanCount },
    issuanceNotes: { maxAgeDays: settings.issuanceNoteMaxAgeDays, eligible: issCount },
    lastScrubAt: settings.lastScrubAt,
  };
}

export async function updateTextScrubSettings(params: {
  transactionReasonMaxAgeDays: number | null;
  invoiceTextMaxAgeDays: number | null;
  loanTextMaxAgeDays: number | null;
  issuanceNoteMaxAgeDays: number | null;
  governmentId: string;
  governmentUsername: string;
}): Promise<RetentionSettings> {
  const current = await getRetentionSettings();

  const [updated] = await db
    .update(retentionSettings)
    .set({
      transactionReasonMaxAgeDays: params.transactionReasonMaxAgeDays,
      invoiceTextMaxAgeDays: params.invoiceTextMaxAgeDays,
      loanTextMaxAgeDays: params.loanTextMaxAgeDays,
      issuanceNoteMaxAgeDays: params.issuanceNoteMaxAgeDays,
      updatedAt: new Date(),
    })
    .returning();

  await recordAudit(db, {
    action: "TEXT_SCRUB_SETTINGS_CHANGED",
    actorType: "GOVERNMENT",
    actorId: params.governmentId,
    actorLabel: params.governmentUsername,
    previousValue: JSON.stringify({
      transactionReason: current.transactionReasonMaxAgeDays,
      invoiceText: current.invoiceTextMaxAgeDays,
      loanText: current.loanTextMaxAgeDays,
      issuanceNote: current.issuanceNoteMaxAgeDays,
    }),
    newValue: JSON.stringify({
      transactionReason: updated.transactionReasonMaxAgeDays,
      invoiceText: updated.invoiceTextMaxAgeDays,
      loanText: updated.loanTextMaxAgeDays,
      issuanceNote: updated.issuanceNoteMaxAgeDays,
    }),
  });

  return updated;
}

export type TextScrubResult = {
  transactionsScrubbed: number;
  invoicesScrubbed: number;
  loansScrubbed: number;
  issuanceNotesScrubbed: number;
};

/**
 * Runs every configured scrub class once. A class with no configured max age
 * (`null`) is skipped entirely — nothing is scrubbed unless the Government
 * has explicitly set an age for that class. Safe to call repeatedly: rows
 * already scrubbed are never counted or touched again (see the `holdsUnscrubbedText`
 * guard on every UPDATE above).
 */
export async function runTextScrub(params: {
  governmentId: string;
  governmentUsername: string;
}): Promise<TextScrubResult> {
  const [gov] = await db.select({ retentionEnabled: government.retentionEnabled }).from(government).limit(1);
  if (gov && !gov.retentionEnabled) {
    throw new RetentionError("Data retention is currently disabled in Government Feature Controls.");
  }

  const settings = await getRetentionSettings();

  const transactionsScrubbed =
    settings.transactionReasonMaxAgeDays !== null
      ? await scrubTransactionReasons(settings.transactionReasonMaxAgeDays)
      : 0;
  const invoicesScrubbed =
    settings.invoiceTextMaxAgeDays !== null
      ? await scrubInvoiceText(settings.invoiceTextMaxAgeDays)
      : 0;
  const loansScrubbed =
    settings.loanTextMaxAgeDays !== null ? await scrubLoanText(settings.loanTextMaxAgeDays) : 0;
  const issuanceNotesScrubbed =
    settings.issuanceNoteMaxAgeDays !== null
      ? await scrubIssuanceNotes(settings.issuanceNoteMaxAgeDays)
      : 0;

  const result: TextScrubResult = {
    transactionsScrubbed,
    invoicesScrubbed,
    loansScrubbed,
    issuanceNotesScrubbed,
  };

  await db
    .update(retentionSettings)
    .set({ lastScrubAt: new Date(), lastScrubSummary: result });

  await recordAudit(db, {
    action: "TEXT_SCRUB_RUN",
    actorType: "GOVERNMENT",
    actorId: params.governmentId,
    actorLabel: params.governmentUsername,
    metadata: result,
  });

  return result;
}

// ===========================================================================
// V3 PHASE I — THE RETENTION ENGINE (spec §§31, 36, 37, 58)
// ===========================================================================
//
// Everything below extends the V2/V2.1 machinery above rather than replacing
// it: the same singleton `retention_settings` row, the same "NULL = never"
// convention, the same audit action names. What V3 adds is
//
//   1. an ALLOWLIST. A table is cleanable only by being named in
//      CLEANUP_TARGETS. Nothing else in this module names a table to delete
//      from, and `runCleanupTarget` refuses any target that is not the exact
//      registry object for its key. Financial truth is therefore protected by
//      ABSENCE — it is not on a denylist that a future edit could shorten, it
//      is simply not in the one list that exists (see PROTECTED_TABLE_NAMES,
//      which is computed as "every table in the schema minus the allowlist").
//
//   2. BATCHING. Every target deletes/updates through
//      `DELETE FROM t WHERE id = ANY($ids)` where `$ids` came from a bounded
//      `SELECT ... LIMIT n` on the target's own narrow index. There is no
//      unbounded statement anywhere, so no sweep can lock a large table for
//      long, and an interrupted run simply leaves the remaining rows for the
//      next one.
//
//   3. A BUDGET. `runFullCleanup` stops when its wall-clock budget or batch
//      allowance is spent and reports `completed: false`. Because every
//      predicate is a property of the row (age, status, expiry) rather than a
//      cursor, resuming is just running again.
//
//   4. NO PER-RECORD BOOKKEEPING. A run writes ONE jsonb summary onto the
//      settings row. It writes no log row per deleted record — the whole point
//      of deleting is to stop storing the data, and a deletion log would
//      re-store it. An automatic (cron/lazy) run writes no audit row either;
//      a Government-initiated run writes exactly one, because that is a
//      Government action and the audit log exists for those.
//
// WHAT CANNOT BE REACHED FROM HERE
// --------------------------------
// balances, transactions, taxes (a tax is a column on a transaction), issuance
// requests/votes, treasury movements, company ownership and transfers,
// company funding, loans/instalments/repayments/actions, completed financial
// invoices, financially-relevant orders, sale listings/offers/records, users,
// companies, government, and audit_logs. The last of those is archivable but
// never deletable, exactly as in V2.

/**
 * Binds a batch of ids as an explicit, individually-cast parameter list.
 *
 * Every id is a bound parameter — none is ever interpolated into the SQL text
 * — so a batch is a prepared statement with N placeholders and nothing about
 * the values can change the shape of the statement. The `::uuid` cast on each
 * one makes the type explicit rather than leaving it to inference, which also
 * means the planner uses the primary-key index for the batch.
 */
function uuidList(ids: string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

/** What a target does to the rows it matches. */
export type CleanupOpKind =
  /** The row is removed entirely. Only for genuinely disposable rows. */
  | "DELETE_ROWS"
  /** Specific columns are nulled; the row and every other column survive. */
  | "CLEAR_COLUMNS"
  /** A status column moves to a terminal value; nothing is removed. */
  | "RETIRE_ROWS";

export type CleanupTargetKey =
  | "UPDATES"
  | "NOTIFICATIONS"
  | "SUPPORT_MESSAGES"
  | "PAUSED_OFFERS"
  | "RATING_COMMENTS"
  | "WANTED_RESPONSES"
  | "WANTED_REQUESTS"
  | "EXPIRED_ORDERS"
  | "CONTRACT_APPLICATIONS"
  | "PROMOTION_CAMPAIGNS"
  | "IDEMPOTENCY_KEYS";

export type CleanupTarget = {
  readonly key: CleanupTargetKey;
  readonly label: string;
  /** Exactly the table this target may touch. Checked at run time. */
  readonly tableName: string;
  readonly op: CleanupOpKind;
  /** For CLEAR_COLUMNS / RETIRE_ROWS: the only columns that may change. */
  readonly columnsTouched: readonly string[];
  /** Which `retention_settings` column configures this target. */
  readonly settingKey: RetentionPeriodKey;
  /** Used when the settings column is NULL but the class still has a spec
   * default (idempotency keys). NULL here means "no policy = never". */
  readonly fallbackDays: number | null;
  /** One line the Government panel shows under the period input. */
  readonly note: string;
  /** Bounded id probe: the rows this target would act on right now. */
  readonly eligibleIds: (cutoff: Date, limit: number) => SQL;
  /** Acts on exactly the ids handed to it — never on a predicate. */
  readonly applyToIds: (ids: string[]) => SQL;
  /** How many rows are eligible in total (for the preview). */
  readonly countEligible: (cutoff: Date) => SQL;
};

/** The settings columns that hold a retention period, and nothing else. */
export type RetentionPeriodKey =
  | "updatesRetentionDays"
  | "notificationsRetentionDays"
  | "supportRetentionDays"
  | "pausedOfferRetentionDays"
  | "ratingCommentRetentionDays"
  | "expiredWantedRetentionDays"
  | "expiredOrderRetentionDays"
  | "expiredContractRetentionDays"
  | "promotionCampaignRetentionDays"
  | "idempotencyKeyRetentionDays";

/**
 * THE ALLOWLIST.
 *
 * Order matters: a child target runs before the parent whose rows it
 * references (responses before requests), so a single pass can remove both.
 * Each predicate is ALSO independently safe — a request is only eligible once
 * it has no responses left — so any prefix of this list can run on its own and
 * an interrupted run can never leave a dangling reference.
 */
export const CLEANUP_TARGETS: readonly CleanupTarget[] = Object.freeze([
  {
    key: "UPDATES",
    label: "Announcements",
    tableName: "updates",
    op: "DELETE_ROWS",
    columnsTouched: [],
    settingKey: "updatesRetentionDays",
    fallbackDays: null,
    note: "Public announcements older than this are removed. Blank = keep forever.",
    eligibleIds: (cutoff, limit) =>
      sql`SELECT "id" FROM "updates" WHERE "created_at" < ${cutoff} ORDER BY "created_at" LIMIT ${limit}`,
    applyToIds: (ids) => sql`DELETE FROM "updates" WHERE "id" IN (${uuidList(ids)})`,
    countEligible: (cutoff) =>
      sql`SELECT count(*)::int AS c FROM "updates" WHERE "created_at" < ${cutoff}`,
  },
  {
    key: "NOTIFICATIONS",
    label: "Notifications",
    tableName: "notifications",
    op: "DELETE_ROWS",
    columnsTouched: [],
    settingKey: "notificationsRetentionDays",
    fallbackDays: null,
    note: "Personal in-app notifications. The spec's default is 30 days.",
    eligibleIds: (cutoff, limit) =>
      sql`SELECT "id" FROM "notifications" WHERE "created_at" < ${cutoff} ORDER BY "created_at" LIMIT ${limit}`,
    applyToIds: (ids) => sql`DELETE FROM "notifications" WHERE "id" IN (${uuidList(ids)})`,
    countEligible: (cutoff) =>
      sql`SELECT count(*)::int AS c FROM "notifications" WHERE "created_at" < ${cutoff}`,
  },
  {
    key: "SUPPORT_MESSAGES",
    label: "Support messages",
    tableName: "support_messages",
    op: "DELETE_ROWS",
    columnsTouched: [],
    settingKey: "supportRetentionDays",
    fallbackDays: null,
    note: "Messages in Government support threads. The spec's default is 7 days. The thread itself stays.",
    eligibleIds: (cutoff, limit) =>
      sql`SELECT "id" FROM "support_messages" WHERE "created_at" < ${cutoff} ORDER BY "created_at" LIMIT ${limit}`,
    applyToIds: (ids) => sql`DELETE FROM "support_messages" WHERE "id" IN (${uuidList(ids)})`,
    countEligible: (cutoff) =>
      sql`SELECT count(*)::int AS c FROM "support_messages" WHERE "created_at" < ${cutoff}`,
  },
  {
    key: "PAUSED_OFFERS",
    label: "Paused market listings",
    tableName: "marketplace_offers",
    op: "RETIRE_ROWS",
    columnsTouched: ["status", "closed_at"],
    settingKey: "pausedOfferRetentionDays",
    fallbackDays: null,
    note: "A listing left PAUSED this long is closed and leaves the Market. Spec default: 14 days. The row is NOT deleted — orders placed against it still point at it.",
    // Served by marketplace_offers_paused_idx (partial on status = 'PAUSED').
    eligibleIds: (cutoff, limit) =>
      sql`SELECT "id" FROM "marketplace_offers" WHERE "status" = 'PAUSED' AND "paused_at" IS NOT NULL AND "paused_at" < ${cutoff} ORDER BY "paused_at" LIMIT ${limit}`,
    applyToIds: (ids) =>
      sql`UPDATE "marketplace_offers" SET "status" = 'CLOSED', "closed_at" = now() WHERE "id" IN (${uuidList(ids)}) AND "status" = 'PAUSED'`,
    countEligible: (cutoff) =>
      sql`SELECT count(*)::int AS c FROM "marketplace_offers" WHERE "status" = 'PAUSED' AND "paused_at" IS NOT NULL AND "paused_at" < ${cutoff}`,
  },
  {
    key: "RATING_COMMENTS",
    label: "Rating comments",
    tableName: "marketplace_order_ratings",
    op: "CLEAR_COLUMNS",
    // `stars` is deliberately absent: the star is permanent.
    columnsTouched: ["comment", "comment_cleared_at"],
    settingKey: "ratingCommentRetentionDays",
    fallbackDays: null,
    note: "The free-text comment on a rating is cleared. THE STAR IS PERMANENT and is never touched. Spec default: 30 days.",
    // Served by ratings_comment_expiry_idx (partial on comment IS NOT NULL).
    // `comment_expires_at` was stamped when the comment was written, so the
    // configured period applies to comments written from now on; changing the
    // period does not retroactively re-stamp existing rows.
    eligibleIds: (_cutoff, limit) =>
      sql`SELECT "id" FROM "marketplace_order_ratings" WHERE "comment" IS NOT NULL AND "comment_expires_at" IS NOT NULL AND "comment_expires_at" < now() ORDER BY "comment_expires_at" LIMIT ${limit}`,
    applyToIds: (ids) =>
      sql`UPDATE "marketplace_order_ratings" SET "comment" = NULL, "comment_cleared_at" = now() WHERE "id" IN (${uuidList(ids)}) AND "comment" IS NOT NULL`,
    countEligible: () =>
      sql`SELECT count(*)::int AS c FROM "marketplace_order_ratings" WHERE "comment" IS NOT NULL AND "comment_expires_at" IS NOT NULL AND "comment_expires_at" < now()`,
  },
  {
    key: "WANTED_RESPONSES",
    label: "Replies to lapsed wanted requests",
    tableName: "marketplace_wanted_responses",
    op: "DELETE_ROWS",
    columnsTouched: [],
    settingKey: "expiredWantedRetentionDays",
    fallbackDays: null,
    note: "Replies to a wanted request that expired or was cancelled. A FULFILLED request and its replies are kept.",
    eligibleIds: (cutoff, limit) => sql`
      SELECT r."id" FROM "marketplace_wanted_responses" r
      JOIN "marketplace_wanted_requests" q ON q."id" = r."request_id"
      WHERE q."status" IN ('EXPIRED', 'CANCELLED')
        AND COALESCE(q."closed_at", q."expires_at") < ${cutoff}
      LIMIT ${limit}`,
    applyToIds: (ids) =>
      sql`DELETE FROM "marketplace_wanted_responses" WHERE "id" IN (${uuidList(ids)})`,
    countEligible: (cutoff) => sql`
      SELECT count(*)::int AS c FROM "marketplace_wanted_responses" r
      JOIN "marketplace_wanted_requests" q ON q."id" = r."request_id"
      WHERE q."status" IN ('EXPIRED', 'CANCELLED')
        AND COALESCE(q."closed_at", q."expires_at") < ${cutoff}`,
  },
  {
    key: "WANTED_REQUESTS",
    label: "Lapsed wanted requests",
    tableName: "marketplace_wanted_requests",
    op: "DELETE_ROWS",
    columnsTouched: [],
    settingKey: "expiredWantedRetentionDays",
    fallbackDays: null,
    note: "Wanted requests that expired unfulfilled or were cancelled. A FULFILLED request is kept. Spec default: 30 days.",
    // The NOT EXISTS makes this independently safe: even if the responses
    // target never ran, this can never orphan a reply or violate the FK.
    eligibleIds: (cutoff, limit) => sql`
      SELECT q."id" FROM "marketplace_wanted_requests" q
      WHERE q."status" IN ('EXPIRED', 'CANCELLED')
        AND COALESCE(q."closed_at", q."expires_at") < ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM "marketplace_wanted_responses" r WHERE r."request_id" = q."id"
        )
      LIMIT ${limit}`,
    applyToIds: (ids) =>
      sql`DELETE FROM "marketplace_wanted_requests" WHERE "id" IN (${uuidList(ids)})`,
    countEligible: (cutoff) => sql`
      SELECT count(*)::int AS c FROM "marketplace_wanted_requests" q
      WHERE q."status" IN ('EXPIRED', 'CANCELLED')
        AND COALESCE(q."closed_at", q."expires_at") < ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM "marketplace_wanted_responses" r WHERE r."request_id" = q."id"
        )`,
  },
  {
    key: "EXPIRED_ORDERS",
    label: "Lapsed orders",
    tableName: "marketplace_orders",
    op: "DELETE_ROWS",
    columnsTouched: [],
    settingKey: "expiredOrderRetentionDays",
    fallbackDays: null,
    note: "Orders that EXPIRED unpaid or were CANCELLED, and that produced no invoice, no payment and no rating. A PAID or COMPLETED order is financial truth and is never deleted. Spec default: 30 days.",
    //
    // FOUR independent conditions, each of which alone is enough to keep an
    // order. The status test is the rule; the other three are the proof that
    // nothing financial can slip through a future status bug.
    //
    eligibleIds: (cutoff, limit) => sql`
      SELECT o."id" FROM "marketplace_orders" o
      WHERE o."status" IN ('EXPIRED', 'CANCELLED')
        AND COALESCE(o."cancelled_at", o."expires_at") < ${cutoff}
        AND o."invoice_id" IS NULL
        AND o."paid_at" IS NULL
        AND o."completed_at" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "invoices" i WHERE i."source_order_id" = o."id")
        AND NOT EXISTS (SELECT 1 FROM "marketplace_order_ratings" g WHERE g."order_id" = o."id")
      LIMIT ${limit}`,
    applyToIds: (ids) =>
      sql`DELETE FROM "marketplace_orders" WHERE "id" IN (${uuidList(ids)})
          AND "status" IN ('EXPIRED', 'CANCELLED') AND "invoice_id" IS NULL
          AND "paid_at" IS NULL AND "completed_at" IS NULL`,
    countEligible: (cutoff) => sql`
      SELECT count(*)::int AS c FROM "marketplace_orders" o
      WHERE o."status" IN ('EXPIRED', 'CANCELLED')
        AND COALESCE(o."cancelled_at", o."expires_at") < ${cutoff}
        AND o."invoice_id" IS NULL
        AND o."paid_at" IS NULL
        AND o."completed_at" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "invoices" i WHERE i."source_order_id" = o."id")
        AND NOT EXISTS (SELECT 1 FROM "marketplace_order_ratings" g WHERE g."order_id" = o."id")`,
  },
  {
    key: "CONTRACT_APPLICATIONS",
    label: "Applications to closed contracts",
    tableName: "marketplace_contract_applications",
    op: "DELETE_ROWS",
    columnsTouched: [],
    settingKey: "expiredContractRetentionDays",
    fallbackDays: null,
    note: "Applications against a contract that expired or was cancelled. Applications to an AWARDED or COMPLETED contract are kept, and the contract itself is never deleted. Default: 30 days.",
    eligibleIds: (cutoff, limit) => sql`
      SELECT a."id" FROM "marketplace_contract_applications" a
      JOIN "marketplace_contracts" c ON c."id" = a."contract_id"
      WHERE c."status" IN ('EXPIRED', 'CANCELLED')
        AND c."invoice_id" IS NULL AND c."paid_tx_ref" IS NULL
        AND COALESCE(c."closed_at", c."expires_at") < ${cutoff}
      LIMIT ${limit}`,
    applyToIds: (ids) =>
      sql`DELETE FROM "marketplace_contract_applications" WHERE "id" IN (${uuidList(ids)})`,
    countEligible: (cutoff) => sql`
      SELECT count(*)::int AS c FROM "marketplace_contract_applications" a
      JOIN "marketplace_contracts" c ON c."id" = a."contract_id"
      WHERE c."status" IN ('EXPIRED', 'CANCELLED')
        AND c."invoice_id" IS NULL AND c."paid_tx_ref" IS NULL
        AND COALESCE(c."closed_at", c."expires_at") < ${cutoff}`,
  },
  {
    key: "PROMOTION_CAMPAIGNS",
    label: "Rejected / cancelled promotions",
    tableName: "promotion_campaigns",
    op: "DELETE_ROWS",
    columnsTouched: [],
    settingKey: "promotionCampaignRetentionDays",
    fallbackDays: null,
    note: "Promotion campaigns that were rejected or cancelled and were NEVER CHARGED. A campaign with any charge has ledger rows behind it and is kept forever. Default: 90 days.",
    eligibleIds: (cutoff, limit) => sql`
      SELECT "id" FROM "promotion_campaigns"
      WHERE "status" IN ('REJECTED', 'CANCELLED')
        AND "total_charged" = 0
        AND "last_charged_on" IS NULL
        AND COALESCE("cancelled_at", "reviewed_at", "created_at") < ${cutoff}
      LIMIT ${limit}`,
    applyToIds: (ids) =>
      sql`DELETE FROM "promotion_campaigns" WHERE "id" IN (${uuidList(ids)})
          AND "total_charged" = 0 AND "last_charged_on" IS NULL`,
    countEligible: (cutoff) => sql`
      SELECT count(*)::int AS c FROM "promotion_campaigns"
      WHERE "status" IN ('REJECTED', 'CANCELLED')
        AND "total_charged" = 0
        AND "last_charged_on" IS NULL
        AND COALESCE("cancelled_at", "reviewed_at", "created_at") < ${cutoff}`,
  },
  {
    key: "IDEMPOTENCY_KEYS",
    label: "Idempotency keys",
    tableName: "idempotency_keys",
    op: "DELETE_ROWS",
    columnsTouched: [],
    settingKey: "idempotencyKeyRetentionDays",
    // Short-lived by design, and the row carries its own `expires_at` stamped
    // at mint time — so unlike every other class this one has a real default
    // rather than "never": leaving these forever would grow without bound.
    fallbackDays: 1,
    note: "Replay-protection keys for payments. Each row carries the expiry it was minted with (24h by default); this period is what NEW keys are minted with.",
    // Served by idempotency_keys_expires_idx.
    eligibleIds: (_cutoff, limit) =>
      sql`SELECT "id" FROM "idempotency_keys" WHERE "expires_at" < now() ORDER BY "expires_at" LIMIT ${limit}`,
    applyToIds: (ids) => sql`DELETE FROM "idempotency_keys" WHERE "id" IN (${uuidList(ids)})`,
    countEligible: () =>
      sql`SELECT count(*)::int AS c FROM "idempotency_keys" WHERE "expires_at" < now()`,
  },
]);

const TARGETS_BY_KEY: ReadonlyMap<CleanupTargetKey, CleanupTarget> = new Map(
  CLEANUP_TARGETS.map((t) => [t.key, t]),
);

/** Every table any retention path may touch. Nothing else is reachable. */
export const CLEANABLE_TABLE_NAMES: ReadonlySet<string> = new Set(
  CLEANUP_TARGETS.map((t) => t.tableName),
);

/**
 * Every table in the schema that is NOT cleanable — computed, not typed out.
 *
 * This is what makes the guarantee STRUCTURAL rather than a promise: the set
 * of protected tables is "all of them minus the allowlist", so a table added
 * to the schema in a future phase is protected the moment it exists, without
 * anyone remembering to add it to a denylist.
 */
export const PROTECTED_TABLE_NAMES: ReadonlySet<string> = new Set(
  (Object.values(schemaTables) as unknown[])
    .filter((v) => is(v, PgTable))
    .map((t) => getTableName(t as PgTable))
    .filter((name) => !CLEANABLE_TABLE_NAMES.has(name)),
);

export function isCleanableTable(tableName: string): boolean {
  return CLEANABLE_TABLE_NAMES.has(tableName);
}

/**
 * The gate every cleanup statement passes through.
 *
 * Both halves matter. The name check refuses a table that is not on the
 * allowlist at all; the identity check refuses a hand-built target object that
 * merely CLAIMS an allowlisted name — the only acceptable target is the exact
 * frozen object the registry holds for that key.
 */
export function assertCleanableTarget(target: CleanupTarget): void {
  if (!CLEANABLE_TABLE_NAMES.has(target.tableName)) {
    throw new RetentionError(
      `Refusing to clean "${target.tableName}": it is not an allowlisted cleanable table. Financial records are never deleted by retention.`,
    );
  }
  if (TARGETS_BY_KEY.get(target.key) !== target) {
    throw new RetentionError(
      `Refusing to clean "${target.tableName}": this is not the registered cleanup target for "${target.key}".`,
    );
  }
}

/** Throws unless `tableName` is on the allowlist. Exported for callers (and
 * tests) that want the check without holding a target. */
export function assertCleanableTable(tableName: string): void {
  if (!CLEANABLE_TABLE_NAMES.has(tableName)) {
    throw new RetentionError(
      `Refusing to clean "${tableName}": it is not an allowlisted cleanable table. Financial records are never deleted by retention.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Batched, idempotent, resumable execution
// ---------------------------------------------------------------------------

/** Rows touched per statement. Small enough that no sweep holds row locks on a
 * large table for long; large enough that a normal day is one or two batches. */
export const CLEANUP_BATCH_SIZE = 200;
/** Hard ceiling on statements per target per run, so one huge backlog cannot
 * starve the other targets (or the function timeout). */
export const CLEANUP_MAX_BATCHES_PER_TARGET = 25;
/** Wall-clock budget for a whole run. Well inside any platform function
 * timeout; whatever is left over is picked up by the next run. */
export const CLEANUP_DEFAULT_BUDGET_MS = 8_000;

export type CleanupTargetResult = {
  key: CleanupTargetKey;
  table: string;
  op: CleanupOpKind;
  retentionDays: number | null;
  /** Rows deleted (DELETE_ROWS) or changed (CLEAR_COLUMNS / RETIRE_ROWS). */
  affected: number;
  batches: number;
  /** False when the budget or batch allowance ran out with rows still due. */
  completed: boolean;
  /** Present only when this target failed; the run continues regardless. */
  error?: string;
};

export type CleanupRunOptions = {
  batchSize?: number;
  maxBatchesPerTarget?: number;
  budgetMs?: number;
  /** Test/ops hook: run only these targets. Never widens the allowlist. */
  only?: readonly CleanupTargetKey[];
  now?: Date;
};

function periodFor(settings: RetentionSettings, target: CleanupTarget): number | null {
  const configured = settings[target.settingKey];
  if (typeof configured === "number") return configured;
  return target.fallbackDays;
}

/**
 * Runs ONE target in bounded batches.
 *
 * Idempotent: every `applyToIds` re-states the eligibility conditions, so a
 * concurrent run that already handled an id changes nothing and the batch
 * simply reports fewer affected rows. Resumable: the loop stops on the budget
 * and the next call re-probes from the same predicate.
 */
export async function runCleanupTarget(
  target: CleanupTarget,
  cutoff: Date,
  opts: {
    batchSize?: number;
    maxBatches?: number;
    deadline?: number;
  } = {},
): Promise<{ affected: number; batches: number; completed: boolean }> {
  assertCleanableTarget(target);

  const batchSize = opts.batchSize ?? CLEANUP_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? CLEANUP_MAX_BATCHES_PER_TARGET;
  const deadline = opts.deadline ?? Date.now() + CLEANUP_DEFAULT_BUDGET_MS;

  let affected = 0;
  let batches = 0;

  while (batches < maxBatches) {
    if (Date.now() >= deadline) return { affected, batches, completed: false };

    const probe = await db.execute(target.eligibleIds(cutoff, batchSize));
    const ids = (probe.rows as Array<{ id: string }>).map((r) => r.id);
    if (ids.length === 0) return { affected, batches, completed: true };

    const applied = await db.execute(target.applyToIds(ids));
    batches++;
    affected += applied.rowCount ?? 0;

    // A short batch means the predicate is exhausted.
    if (ids.length < batchSize) return { affected, batches, completed: true };

    // Every id matched the probe but nothing changed: another process (or a
    // guard in `applyToIds`) already handled them. Stop rather than spin.
    if ((applied.rowCount ?? 0) === 0) return { affected, batches, completed: true };
  }

  return { affected, batches, completed: false };
}

export type CleanupSummary = {
  /** ISO strings, because this lives in a jsonb column. */
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** "GOVERNMENT" = a person pressed the button; the rest are automatic. */
  source: CleanupSource;
  ok: boolean;
  completed: boolean;
  totalAffected: number;
  targets: CleanupTargetResult[];
  failures: string[];
  /** Carried forward across failed runs so it is never lost. */
  lastSuccessAt: string | null;
};

export type CleanupSource = "GOVERNMENT" | "CRON" | "LAZY";

/**
 * Runs every configured target once, inside one wall-clock budget.
 *
 * A target with no configured period (and no fallback) is skipped entirely —
 * "no policy" means "never", exactly as in V2. A target that throws is
 * recorded in `failures` and does not stop the others: one bad predicate must
 * not stop notifications being cleaned.
 */
export async function runFullCleanup(
  params: { source: CleanupSource; governmentId?: string; governmentUsername?: string },
  opts: CleanupRunOptions = {},
): Promise<CleanupSummary> {
  const [gov] = await db.select({ retentionEnabled: government.retentionEnabled }).from(government).limit(1);
  if (gov && !gov.retentionEnabled) {
    if (params.source === "GOVERNMENT") {
      throw new RetentionError("Data retention is currently disabled in Government Feature Controls.");
    }
    const nowIso = (opts.now ?? new Date()).toISOString();
    return {
      startedAt: nowIso,
      finishedAt: nowIso,
      durationMs: 0,
      source: params.source,
      ok: true,
      completed: true,
      totalAffected: 0,
      targets: [],
      failures: [],
      lastSuccessAt: null,
    };
  }

  const settings = await getRetentionSettings();
  const started = opts.now ?? new Date();
  const deadline = started.getTime() + (opts.budgetMs ?? CLEANUP_DEFAULT_BUDGET_MS);

  const selected = opts.only
    ? CLEANUP_TARGETS.filter((t) => opts.only!.includes(t.key))
    : CLEANUP_TARGETS;

  const targets: CleanupTargetResult[] = [];
  const failures: string[] = [];
  let totalAffected = 0;
  let completed = true;

  for (const target of selected) {
    const days = periodFor(settings, target);
    if (days === null) {
      targets.push({
        key: target.key,
        table: target.tableName,
        op: target.op,
        retentionDays: null,
        affected: 0,
        batches: 0,
        completed: true,
      });
      continue;
    }

    const cutoff = new Date(started.getTime() - days * 24 * 60 * 60 * 1000);
    try {
      const r = await runCleanupTarget(target, cutoff, {
        batchSize: opts.batchSize,
        maxBatches: opts.maxBatchesPerTarget,
        deadline,
      });
      totalAffected += r.affected;
      if (!r.completed) completed = false;
      targets.push({
        key: target.key,
        table: target.tableName,
        op: target.op,
        retentionDays: days,
        affected: r.affected,
        batches: r.batches,
        completed: r.completed,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failures.push(`${target.key}: ${message}`);
      completed = false;
      targets.push({
        key: target.key,
        table: target.tableName,
        op: target.op,
        retentionDays: days,
        affected: 0,
        batches: 0,
        completed: false,
        error: message,
      });
    }
  }

  const finished = new Date();
  const ok = failures.length === 0;
  const previous = (settings.lastCleanupSummary ?? null) as CleanupSummary | null;

  const summary: CleanupSummary = {
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    source: params.source,
    ok,
    completed,
    totalAffected,
    targets,
    failures,
    lastSuccessAt: ok
      ? finished.toISOString()
      : (settings.lastCleanupSuccessAt?.toISOString() ?? previous?.lastSuccessAt ?? null),
  };

  // THE ONLY ROW THIS RUN WRITES. No per-record log, by design.
  await db.update(retentionSettings).set({
    lastCleanupAt: finished,
    lastCleanupSummary: summary,
    ...(ok ? { lastCleanupSuccessAt: finished } : {}),
  });

  // A Government-initiated run is a Government action and is audited, exactly
  // once. An automatic run is routine and writes nothing to the audit log —
  // a daily row in a table that can never be deleted is a leak, not a record.
  if (params.source === "GOVERNMENT") {
    await recordAudit(db, {
      action: "RETENTION_CLEANUP_RUN",
      actorType: "GOVERNMENT",
      actorId: params.governmentId ?? null,
      actorLabel: params.governmentUsername ?? null,
      metadata: {
        totalAffected,
        completed,
        ok,
        perTarget: Object.fromEntries(targets.map((t) => [t.key, t.affected])),
      },
    });
  }

  return summary;
}

/**
 * The lazy fallback (§37): at most one automatic run per IST calendar day,
 * claimed by a single conditional UPDATE so any number of concurrent page
 * loads produce exactly one run — the same pattern the daily promotion charge
 * uses. This is what keeps the app correct if cron never fires.
 */
export async function runDueCleanupLazily(now = new Date()): Promise<CleanupSummary | null> {
  // Make sure the singleton exists: the claim below is an UPDATE, and an
  // UPDATE against an empty table matches nothing, so a fresh install would
  // otherwise never take the claim and never run a lazy cleanup at all.
  await getRetentionSettings();

  const dayStart = startOfIstDay(now);

  // Claim the day. `lastCleanupAt` doubles as the claim, so a second loader
  // that arrives mid-run sees the claimed timestamp and does nothing.
  const claimed = await db
    .update(retentionSettings)
    .set({ lastCleanupAt: now })
    .where(
      or(isNull(retentionSettings.lastCleanupAt), lt(retentionSettings.lastCleanupAt, dayStart)),
    )
    .returning({ id: retentionSettings.id });

  if (claimed.length === 0) return null;

  // A smaller budget than cron's: this is running inside somebody's page load.
  return runFullCleanup({ source: "LAZY" }, { budgetMs: 3_000 });
}

// ---------------------------------------------------------------------------
// Preview / settings for the V3 classes
// ---------------------------------------------------------------------------

export type CleanupTargetPreview = {
  key: CleanupTargetKey;
  label: string;
  table: string;
  op: CleanupOpKind;
  note: string;
  settingKey: RetentionPeriodKey;
  retentionDays: number | null;
  eligible: number;
  total: number;
};

export type FullCleanupPreview = {
  targets: CleanupTargetPreview[];
  lastCleanupAt: Date | null;
  lastCleanupSuccessAt: Date | null;
  lastSummary: CleanupSummary | null;
};

/** What each target would act on right now, plus the last run's summary. */
export async function previewFullCleanup(now = new Date()): Promise<FullCleanupPreview> {
  const settings = await getRetentionSettings();

  const targets: CleanupTargetPreview[] = [];
  for (const target of CLEANUP_TARGETS) {
    const days = periodFor(settings, target);
    const cutoff =
      days === null ? now : new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const [eligibleRes, totalRes] = await Promise.all([
      days === null
        ? Promise.resolve(0)
        : db
            .execute(target.countEligible(cutoff))
            .then((r) => Number((r.rows[0] as { c: number } | undefined)?.c ?? 0)),
      db
        .execute(sql`SELECT count(*)::int AS c FROM ${sql.identifier(target.tableName)}`)
        .then((r) => Number((r.rows[0] as { c: number } | undefined)?.c ?? 0)),
    ]);

    targets.push({
      key: target.key,
      label: target.label,
      table: target.tableName,
      op: target.op,
      note: target.note,
      settingKey: target.settingKey,
      retentionDays: days,
      eligible: eligibleRes,
      total: totalRes,
    });
  }

  return {
    targets,
    lastCleanupAt: settings.lastCleanupAt,
    lastCleanupSuccessAt: settings.lastCleanupSuccessAt,
    lastSummary: (settings.lastCleanupSummary ?? null) as CleanupSummary | null,
  };
}

/** The V3 periods, saved together. Same shape as `updateRetentionSettings`. */
export async function updateV3RetentionSettings(params: {
  pausedOfferRetentionDays: number | null;
  ratingCommentRetentionDays: number | null;
  expiredWantedRetentionDays: number | null;
  expiredOrderRetentionDays: number | null;
  expiredContractRetentionDays: number | null;
  promotionCampaignRetentionDays: number | null;
  idempotencyKeyRetentionDays: number | null;
  governmentId: string;
  governmentUsername: string;
}): Promise<RetentionSettings> {
  const current = await getRetentionSettings();

  const snapshot = (s: RetentionSettings) => ({
    pausedOffers: s.pausedOfferRetentionDays,
    ratingComments: s.ratingCommentRetentionDays,
    expiredWanted: s.expiredWantedRetentionDays,
    expiredOrders: s.expiredOrderRetentionDays,
    expiredContracts: s.expiredContractRetentionDays,
    promotionCampaigns: s.promotionCampaignRetentionDays,
    idempotencyKeys: s.idempotencyKeyRetentionDays,
  });

  const [updated] = await db
    .update(retentionSettings)
    .set({
      pausedOfferRetentionDays: params.pausedOfferRetentionDays,
      ratingCommentRetentionDays: params.ratingCommentRetentionDays,
      expiredWantedRetentionDays: params.expiredWantedRetentionDays,
      expiredOrderRetentionDays: params.expiredOrderRetentionDays,
      expiredContractRetentionDays: params.expiredContractRetentionDays,
      promotionCampaignRetentionDays: params.promotionCampaignRetentionDays,
      idempotencyKeyRetentionDays: params.idempotencyKeyRetentionDays,
      updatedAt: new Date(),
    })
    .returning();

  await recordAudit(db, {
    action: "RETENTION_SETTINGS_CHANGED",
    actorType: "GOVERNMENT",
    actorId: params.governmentId,
    actorLabel: params.governmentUsername,
    previousValue: JSON.stringify(snapshot(current)),
    newValue: JSON.stringify(snapshot(updated)),
  });

  return updated;
}

/**
 * Updates V4 Archive-Before-Clearing retention periods (`retention_settings`).
 * Note: Setting these periods only defines eligibility for creating Archive
 * Batches in the Archive Center; rows are NEVER deleted without a verified
 * archive batch and explicit Government confirmation (Spec §§8, 10, 11).
 */
export async function updateV4RetentionSettings(params: {
  transactionHistoryRetentionDays: number | null;
  settledOrderHistoryRetentionDays: number | null;
  closedRefundRetentionDays: number | null;
  marketCandleRetentionDays: number | null;
  governmentId: string;
  governmentUsername: string;
}): Promise<RetentionSettings> {
  const current = await getRetentionSettings();

  const snapshot = (s: RetentionSettings) => ({
    transactionHistory: s.transactionHistoryRetentionDays,
    settledMarketOrders: s.settledOrderHistoryRetentionDays,
    closedRefunds: s.closedRefundRetentionDays,
    marketCandles: s.marketCandleRetentionDays,
  });

  const [updated] = await db
    .update(retentionSettings)
    .set({
      transactionHistoryRetentionDays: params.transactionHistoryRetentionDays,
      settledOrderHistoryRetentionDays: params.settledOrderHistoryRetentionDays,
      closedRefundRetentionDays: params.closedRefundRetentionDays,
      marketCandleRetentionDays: params.marketCandleRetentionDays,
      updatedAt: new Date(),
    })
    .returning();

  await recordAudit(db, {
    action: "V4_RETENTION_SETTINGS_CHANGED",
    actorType: "GOVERNMENT",
    actorId: params.governmentId,
    actorLabel: params.governmentUsername,
    previousValue: JSON.stringify(snapshot(current)),
    newValue: JSON.stringify(snapshot(updated)),
  });

  return updated;
}

