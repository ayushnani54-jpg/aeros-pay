import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

// A single pooled connection, reused across server actions / route handlers.
// On serverless platforms (Vercel), the pool is scoped per lambda instance;
// keep max connections modest since Postgres connection limits are finite.
declare global {
  var __aerosPgPool: Pool | undefined;
  var __aerosV5SchemaReady: boolean | undefined;
  var __aerosV5SchemaPromise: Promise<void> | undefined;
}

const rawPool =
  global.__aerosPgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: process.env.NODE_ENV === "production" ? 5 : 10,
  });

if (process.env.NODE_ENV !== "production") {
  global.__aerosPgPool = rawPool;
}

const origConnect = rawPool.connect.bind(rawPool) as () => Promise<PoolClient>;
const origQuery = rawPool.query.bind(rawPool) as (...args: unknown[]) => Promise<unknown>;

const V5_AUTO_MIGRATION_STATEMENTS: string[] = [
  // --- V4.1 safety checks (0009) ---
  `ALTER TYPE "public"."market_order_side" ADD VALUE IF NOT EXISTS 'SHORT'`,
  `ALTER TYPE "public"."market_order_side" ADD VALUE IF NOT EXISTS 'COVER'`,
  `ALTER TABLE "market_state" ADD COLUMN IF NOT EXISTS "short_selling_enabled" boolean DEFAULT true NOT NULL`,
  `ALTER TABLE "market_state" ADD COLUMN IF NOT EXISTS "short_collateral_ratio_bp" integer DEFAULT 10000 NOT NULL`,
  `ALTER TABLE "market_state" ADD COLUMN IF NOT EXISTS "max_short_units_per_user" integer DEFAULT 1000 NOT NULL`,
  `ALTER TABLE "market_positions" ADD COLUMN IF NOT EXISTS "short_units_held" integer DEFAULT 0 NOT NULL`,
  `ALTER TABLE "market_positions" ADD COLUMN IF NOT EXISTS "short_entry_notional" integer DEFAULT 0 NOT NULL`,
  `ALTER TABLE "market_positions" ADD COLUMN IF NOT EXISTS "short_collateral_locked" integer DEFAULT 0 NOT NULL`,
  `ALTER TABLE "market_positions" ADD COLUMN IF NOT EXISTS "total_shorted_units" integer DEFAULT 0 NOT NULL`,
  `ALTER TABLE "market_positions" ADD COLUMN IF NOT EXISTS "total_covered_units" integer DEFAULT 0 NOT NULL`,
  `CREATE TABLE IF NOT EXISTS "archive_repositories" (
    "repo_key" varchar(48) PRIMARY KEY NOT NULL,
    "repo_owner" varchar(120) DEFAULT '' NOT NULL,
    "repo_name" varchar(120) NOT NULL,
    "branch" varchar(64) DEFAULT 'main' NOT NULL,
    "shard_generation" integer DEFAULT 1 NOT NULL,
    "estimated_bytes_used" integer DEFAULT 0 NOT NULL,
    "warning_threshold_bytes" integer DEFAULT 419430400 NOT NULL,
    "hard_limit_bytes" integer DEFAULT 786432000 NOT NULL,
    "total_batches_pushed" integer DEFAULT 0 NOT NULL,
    "total_records_archived" integer DEFAULT 0 NOT NULL,
    "last_commit_sha" varchar(64),
    "last_push_at" timestamp with time zone,
    "last_verified_at" timestamp with time zone,
    "health_status" varchar(32) DEFAULT 'HEALTHY' NOT NULL,
    "last_error" text,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "repo_key" varchar(48) DEFAULT 'aeros-archive-ledger' NOT NULL`,
  `ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "repo_name" varchar(120) DEFAULT 'aeros-archive-ledger' NOT NULL`,
  `ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "shard_generation" integer DEFAULT 1 NOT NULL`,
  `ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "state_machine_status" varchar(32) DEFAULT 'COMPLETED' NOT NULL`,
  `ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "remote_commit_sha" varchar(64)`,
  `ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "remote_batch_path" varchar(240)`,
  `ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "remote_manifest_path" varchar(240)`,
  `ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "remote_index_path" varchar(240)`,
  `ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "verified_remote_sha256" varchar(64)`,
  `ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "retry_count" integer DEFAULT 0 NOT NULL`,
  `ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "last_error" text`,
  `ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "next_retry_at" timestamp with time zone`,
  `ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "is_download_all_bundle" boolean DEFAULT false NOT NULL`,
  `CREATE TABLE IF NOT EXISTS "archived_record_ledger" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "dataset_key" varchar(48) NOT NULL,
    "record_id" varchar(64) NOT NULL,
    "batch_id" uuid NOT NULL REFERENCES "archive_batches"("id"),
    "repo_key" varchar(48) NOT NULL,
    "remote_batch_path" varchar(240),
    "record_created_at" timestamp with time zone,
    "archived_at" timestamp with time zone DEFAULT now() NOT NULL,
    "cleared_from_neon_at" timestamp with time zone
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "archived_record_dataset_record_unique" ON "archived_record_ledger" USING btree ("dataset_key", "record_id")`,

  // --- V5 Upgrade (0010_v5_upgrade.sql) ---
  `DO $$ BEGIN
    CREATE TYPE "public"."trade_position_direction" AS ENUM('LONG', 'SHORT');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    CREATE TYPE "public"."trade_position_status" AS ENUM('OPEN', 'CLOSED');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    CREATE TYPE "public"."leverage_request_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    CREATE TYPE "public"."employer_type" AS ENUM('GOVERNMENT', 'COMPANY');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    CREATE TYPE "public"."job_status" AS ENUM('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'CLOSED');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    CREATE TYPE "public"."job_application_status" AS ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    CREATE TYPE "public"."partnership_status" AS ENUM('PROPOSED', 'ACCEPTED_BY_PARTNER', 'REJECTED_BY_PARTNER', 'APPROVED_BY_GOVERNMENT', 'REJECTED_BY_GOVERNMENT', 'TERMINATED');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    CREATE TYPE "public"."media_moderation_status" AS ENUM('ACTIVE', 'FLAGGED', 'MODERATED_HIDDEN');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    CREATE TYPE "public"."archive_job_status" AS ENUM('IDLE', 'RUNNING', 'COMPLETED', 'FAILED', 'PAUSED');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

  `ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "market_update_interval_minutes" integer DEFAULT 1 NOT NULL`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "max_leverage" integer DEFAULT 2 NOT NULL`,
  `ALTER TABLE "archive_repositories" ADD COLUMN IF NOT EXISTS "continuation_repo_key" varchar(64)`,
  `ALTER TABLE "archive_repositories" ADD COLUMN IF NOT EXISTS "continuation_repo_name" varchar(120)`,
  `ALTER TABLE "archive_repositories" ADD COLUMN IF NOT EXISTS "is_active_for_writes" boolean DEFAULT true NOT NULL`,

  `INSERT INTO "archive_repositories" ("repo_key", "repo_owner", "repo_name", "branch", "warning_threshold_bytes", "hard_limit_bytes")
   VALUES
     ('aeros-archive-market-index', 'ayushnani54-jpg', 'aeros-archive-market-index', 'main', 838860800, 943718400),
     ('aeros-archive-trading-ledger', 'ayushnani54-jpg', 'aeros-archive-trading-ledger', 'main', 838860800, 943718400),
     ('aeros-archive-payments', 'ayushnani54-jpg', 'aeros-archive-payments', 'main', 838860800, 943718400),
     ('aeros-archive-exchange', 'ayushnani54-jpg', 'aeros-archive-exchange', 'main', 838860800, 943718400),
     ('aeros-archive-refunds', 'ayushnani54-jpg', 'aeros-archive-refunds', 'main', 838860800, 943718400),
     ('aeros-archive-marketplace-listings', 'ayushnani54-jpg', 'aeros-archive-marketplace-listings', 'main', 838860800, 943718400),
     ('aeros-archive-marketplace-orders', 'ayushnani54-jpg', 'aeros-archive-marketplace-orders', 'main', 838860800, 943718400),
     ('aeros-archive-jobs', 'ayushnani54-jpg', 'aeros-archive-jobs', 'main', 838860800, 943718400),
     ('aeros-archive-contracts', 'ayushnani54-jpg', 'aeros-archive-contracts', 'main', 838860800, 943718400),
     ('aeros-archive-company-partnerships', 'ayushnani54-jpg', 'aeros-archive-company-partnerships', 'main', 838860800, 943718400),
     ('aeros-archive-company-finances', 'ayushnani54-jpg', 'aeros-archive-company-finances', 'main', 838860800, 943718400),
     ('aeros-archive-loans', 'ayushnani54-jpg', 'aeros-archive-loans', 'main', 838860800, 943718400),
     ('aeros-archive-media', 'ayushnani54-jpg', 'aeros-archive-media', 'main', 838860800, 943718400),
     ('aeros-archive-government', 'ayushnani54-jpg', 'aeros-archive-government', 'main', 838860800, 943718400),
     ('aeros-archive-audit', 'ayushnani54-jpg', 'aeros-archive-audit', 'main', 838860800, 943718400)
   ON CONFLICT ("repo_key") DO UPDATE SET
     "warning_threshold_bytes" = EXCLUDED."warning_threshold_bytes",
     "hard_limit_bytes" = EXCLUDED."hard_limit_bytes"`,

  `CREATE TABLE IF NOT EXISTS "archive_job_runs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "job_number" varchar(32) NOT NULL UNIQUE,
    "status" "archive_job_status" DEFAULT 'IDLE' NOT NULL,
    "current_phase" varchar(48) DEFAULT 'IDLE' NOT NULL,
    "current_category" varchar(64),
    "current_repo" varchar(120),
    "batches_total" integer DEFAULT 0 NOT NULL,
    "batches_completed" integer DEFAULT 0 NOT NULL,
    "records_processed" integer DEFAULT 0 NOT NULL,
    "records_verified" integer DEFAULT 0 NOT NULL,
    "records_retained_errors" integer DEFAULT 0 NOT NULL,
    "last_error" text,
    "initiated_by_gov_id" uuid REFERENCES "government"("id"),
    "is_locked" boolean DEFAULT false NOT NULL,
    "started_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "completed_at" timestamp with time zone
  )`,
  `CREATE INDEX IF NOT EXISTS "archive_job_runs_status_idx" ON "archive_job_runs" ("status", "started_at")`,
  `CREATE INDEX IF NOT EXISTS "archive_job_runs_locked_idx" ON "archive_job_runs" ("is_locked")`,

  `CREATE TABLE IF NOT EXISTS "market_trade_positions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "position_number" varchar(32) NOT NULL UNIQUE,
    "user_id" uuid NOT NULL REFERENCES "users"("id"),
    "direction" "trade_position_direction" NOT NULL,
    "status" "trade_position_status" DEFAULT 'OPEN' NOT NULL,
    "quantity" integer NOT NULL,
    "entry_price" integer NOT NULL,
    "leverage" integer DEFAULT 2 NOT NULL,
    "margin_locked" integer NOT NULL,
    "cost_basis" integer NOT NULL,
    "close_price" integer,
    "realized_pnl" integer DEFAULT 0 NOT NULL,
    "open_tx_ref" varchar(32),
    "close_tx_ref" varchar(32),
    "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
    "closed_at" timestamp with time zone,
    CONSTRAINT "market_trade_positions_quantity_positive" CHECK ("quantity" >= 1),
    CONSTRAINT "market_trade_positions_entry_price_positive" CHECK ("entry_price" >= 1),
    CONSTRAINT "market_trade_positions_margin_positive" CHECK ("margin_locked" >= 1),
    CONSTRAINT "market_trade_positions_leverage_valid" CHECK ("leverage" IN (2, 4, 8, 10))
  )`,
  `CREATE INDEX IF NOT EXISTS "market_trade_positions_user_status_idx" ON "market_trade_positions" ("user_id", "status")`,
  `CREATE INDEX IF NOT EXISTS "market_trade_positions_opened_at_idx" ON "market_trade_positions" ("opened_at")`,

  `CREATE TABLE IF NOT EXISTS "leverage_requests" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid NOT NULL REFERENCES "users"("id"),
    "requested_leverage" integer NOT NULL,
    "current_leverage" integer DEFAULT 2 NOT NULL,
    "status" "leverage_request_status" DEFAULT 'PENDING' NOT NULL,
    "rejection_reason" text,
    "admin_notes" text,
    "user_stats_snapshot" jsonb,
    "reviewed_by_gov_id" uuid REFERENCES "government"("id"),
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "reviewed_at" timestamp with time zone,
    CONSTRAINT "leverage_requests_target_valid" CHECK ("requested_leverage" IN (4, 8, 10))
  )`,
  `CREATE INDEX IF NOT EXISTS "leverage_requests_user_status_idx" ON "leverage_requests" ("user_id", "status")`,
  `CREATE INDEX IF NOT EXISTS "leverage_requests_status_created_idx" ON "leverage_requests" ("status", "created_at")`,

  `CREATE TABLE IF NOT EXISTS "jobs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "job_number" varchar(32) NOT NULL UNIQUE,
    "employer_type" "employer_type" NOT NULL,
    "employer_company_id" uuid REFERENCES "companies"("id"),
    "title" varchar(160) NOT NULL,
    "category" varchar(64) NOT NULL,
    "description" text NOT NULL,
    "requirements" text NOT NULL,
    "compensation_aeros" integer NOT NULL,
    "status" "job_status" DEFAULT 'OPEN' NOT NULL,
    "hired_user_id" uuid REFERENCES "users"("id"),
    "contract_id" uuid REFERENCES "marketplace_contracts"("id"),
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "jobs_compensation_positive" CHECK ("compensation_aeros" >= 1)
  )`,
  `CREATE INDEX IF NOT EXISTS "jobs_status_category_idx" ON "jobs" ("status", "category")`,
  `CREATE INDEX IF NOT EXISTS "jobs_employer_idx" ON "jobs" ("employer_type", "employer_company_id")`,

  `CREATE TABLE IF NOT EXISTS "job_applications" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "job_id" uuid NOT NULL REFERENCES "jobs"("id"),
    "user_id" uuid NOT NULL REFERENCES "users"("id"),
    "cover_note" text NOT NULL,
    "status" "job_application_status" DEFAULT 'PENDING' NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "reviewed_at" timestamp with time zone,
    CONSTRAINT "job_applications_user_job_unique" UNIQUE ("job_id", "user_id")
  )`,
  `CREATE INDEX IF NOT EXISTS "job_applications_job_status_idx" ON "job_applications" ("job_id", "status")`,

  `CREATE TABLE IF NOT EXISTS "company_partnerships" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "partnership_number" varchar(32) NOT NULL UNIQUE,
    "initiator_company_id" uuid NOT NULL REFERENCES "companies"("id"),
    "partner_company_id" uuid NOT NULL REFERENCES "companies"("id"),
    "title" varchar(160) NOT NULL,
    "terms_description" text NOT NULL,
    "initiator_share_bp" integer DEFAULT 5000 NOT NULL,
    "partner_share_bp" integer DEFAULT 5000 NOT NULL,
    "status" "partnership_status" DEFAULT 'PROPOSED' NOT NULL,
    "rejection_reason" text,
    "gov_tax_rate_bp" integer DEFAULT 500 NOT NULL,
    "total_settled_volume_aeros" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "company_partnerships_not_self" CHECK ("initiator_company_id" <> "partner_company_id"),
    CONSTRAINT "company_partnerships_share_sum" CHECK ("initiator_share_bp" + "partner_share_bp" = 10000),
    CONSTRAINT "company_partnerships_tax_valid" CHECK ("gov_tax_rate_bp" >= 0 AND "gov_tax_rate_bp" <= 5000)
  )`,
  `CREATE INDEX IF NOT EXISTS "company_partnerships_initiator_idx" ON "company_partnerships" ("initiator_company_id", "status")`,
  `CREATE INDEX IF NOT EXISTS "company_partnerships_partner_idx" ON "company_partnerships" ("partner_company_id", "status")`,

  `CREATE TABLE IF NOT EXISTS "partnership_settlements" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "settlement_number" varchar(32) NOT NULL UNIQUE,
    "partnership_id" uuid NOT NULL REFERENCES "company_partnerships"("id"),
    "gross_amount" integer NOT NULL,
    "initiator_payout" integer NOT NULL,
    "partner_payout" integer NOT NULL,
    "gov_tax_deducted" integer NOT NULL,
    "reference_note" text NOT NULL,
    "initiator_tx_ref" varchar(32) NOT NULL,
    "partner_tx_ref" varchar(32) NOT NULL,
    "gov_tx_ref" varchar(32) NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "partnership_settlements_gross_positive" CHECK ("gross_amount" >= 1),
    CONSTRAINT "partnership_settlements_balanced" CHECK ("initiator_payout" + "partner_payout" + "gov_tax_deducted" = "gross_amount")
  )`,
  `CREATE INDEX IF NOT EXISTS "partnership_settlements_partnership_idx" ON "partnership_settlements" ("partnership_id", "created_at")`,

  `CREATE TABLE IF NOT EXISTS "media_posts" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "post_number" varchar(32) NOT NULL UNIQUE,
    "author_id" uuid NOT NULL REFERENCES "users"("id"),
    "content" text NOT NULL,
    "moderation_status" "media_moderation_status" DEFAULT 'ACTIVE' NOT NULL,
    "moderator_reason" text,
    "moderated_at" timestamp with time zone,
    "likes_count" integer DEFAULT 0 NOT NULL,
    "comments_count" integer DEFAULT 0 NOT NULL,
    "shares_count" integer DEFAULT 0 NOT NULL,
    "is_expired" boolean DEFAULT false NOT NULL,
    "archived_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "media_posts_likes_nonnegative" CHECK ("likes_count" >= 0),
    CONSTRAINT "media_posts_comments_nonnegative" CHECK ("comments_count" >= 0),
    CONSTRAINT "media_posts_shares_nonnegative" CHECK ("shares_count" >= 0)
  )`,
  `CREATE INDEX IF NOT EXISTS "media_posts_feed_idx" ON "media_posts" ("moderation_status", "is_expired", "created_at")`,
  `CREATE INDEX IF NOT EXISTS "media_posts_author_idx" ON "media_posts" ("author_id", "created_at")`,

  `CREATE TABLE IF NOT EXISTS "media_comments" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "post_id" uuid NOT NULL REFERENCES "media_posts"("id"),
    "author_id" uuid NOT NULL REFERENCES "users"("id"),
    "content" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "media_comments_post_idx" ON "media_comments" ("post_id", "created_at")`,

  `CREATE TABLE IF NOT EXISTS "media_likes" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "post_id" uuid NOT NULL REFERENCES "media_posts"("id"),
    "user_id" uuid NOT NULL REFERENCES "users"("id"),
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "media_likes_post_user_unique" UNIQUE ("post_id", "user_id")
  )`,

  `CREATE TABLE IF NOT EXISTS "media_shares" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "post_id" uuid NOT NULL REFERENCES "media_posts"("id"),
    "user_id" uuid NOT NULL REFERENCES "users"("id"),
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "media_shares_post_user_idx" ON "media_shares" ("post_id", "user_id")`,
];

async function runV5AutoMigrationInternal(): Promise<void> {
  if (global.__aerosV5SchemaReady || !process.env.DATABASE_URL) {
    global.__aerosV5SchemaReady = true;
    return;
  }

  let client: PoolClient | null = null;
  try {
    client = await origConnect();
    const colCheck = await client.query<{ cnt: string }>(`
      SELECT count(*)::text AS cnt
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'users' AND column_name = 'max_leverage')
          OR (table_name = 'government' AND column_name = 'market_update_interval_minutes')
        )
    `);
    const tblCheck = await client.query<{ cnt: string }>(`
      SELECT count(*)::text AS cnt
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('archive_job_runs', 'market_trade_positions', 'jobs', 'company_partnerships', 'media_posts', 'media_shares')
    `);

    const hasCols = Number(colCheck.rows[0]?.cnt ?? 0) >= 2;
    const hasTables = Number(tblCheck.rows[0]?.cnt ?? 0) >= 6;

    if (!hasCols || !hasTables) {
      for (const stmt of V5_AUTO_MIGRATION_STATEMENTS) {
        try {
          await client.query(stmt);
        } catch (stmtErr) {
          console.warn("[AerosPay V5 Auto-Migrate] Non-fatal DDL statement notice:", stmtErr);
        }
      }
    }
    global.__aerosV5SchemaReady = true;
  } catch (err) {
    console.error("[AerosPay V5 Auto-Migrate] Schema check error:", err);
  } finally {
    if (client) {
      client.release();
    }
  }
}

export async function ensureV5SchemaMigrated(): Promise<void> {
  if (global.__aerosV5SchemaReady) return;
  if (!global.__aerosV5SchemaPromise) {
    global.__aerosV5SchemaPromise = runV5AutoMigrationInternal().finally(() => {
      if (!global.__aerosV5SchemaReady) {
        global.__aerosV5SchemaPromise = undefined;
      }
    });
  }
  await global.__aerosV5SchemaPromise;
}

// Wrap pool.query and pool.connect so that the very first Drizzle query on any
// serverless cold start automatically ensures the V5 schema is present in Neon.
rawPool.query = (async (...args: unknown[]) => {
  if (!global.__aerosV5SchemaReady) {
    await ensureV5SchemaMigrated();
  }
  return origQuery(...args);
}) as typeof rawPool.query;

rawPool.connect = (async (...args: unknown[]) => {
  if (!global.__aerosV5SchemaReady && args.length === 0) {
    await ensureV5SchemaMigrated();
  }
  return (origConnect as (...a: unknown[]) => Promise<PoolClient>)(...args);
}) as typeof rawPool.connect;

export const pool = rawPool;
export const db = drizzle(pool, { schema });
