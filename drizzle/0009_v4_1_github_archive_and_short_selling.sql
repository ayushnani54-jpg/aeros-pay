-- =============================================================================
-- AEROS PAY V4.1 UPGRADE MIGRATION (0009_v4_1_github_archive_and_short_selling.sql)
-- =============================================================================
-- Strictly additive & idempotent migration for Neon PostgreSQL:
-- 1. Extends `market_order_side` enum with 'SHORT' and 'COVER'.
-- 2. Adds collateralized short-selling policy & position columns to
--    `market_state` and `market_positions`.
-- 3. Creates `archive_repositories` (5-repository GitHub permanent archive
--    registry & storage monitor) and seeds the 5 canonical repositories.
-- 4. Adds 12-step resumable GitHub archival state-machine & remote commit/path
--    columns to `archive_batches`.
-- 5. Creates `archived_record_ledger` to track every historical record verified
--    in GitHub so the 24-hour archiver is strictly idempotent.
-- =============================================================================

-- 1. Extend market_order_side enum with SHORT and COVER
ALTER TYPE "public"."market_order_side" ADD VALUE IF NOT EXISTS 'SHORT';--> statement-breakpoint
ALTER TYPE "public"."market_order_side" ADD VALUE IF NOT EXISTS 'COVER';--> statement-breakpoint

-- 2. Add V4.1 short-selling configuration columns to market_state
ALTER TABLE "market_state" ADD COLUMN IF NOT EXISTS "short_selling_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "market_state" ADD COLUMN IF NOT EXISTS "short_collateral_ratio_bp" integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE "market_state" ADD COLUMN IF NOT EXISTS "max_short_units_per_user" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "market_state" ADD CONSTRAINT "market_state_short_collateral_bounds"
    CHECK ("short_collateral_ratio_bp" >= 10000 AND "short_collateral_ratio_bp" <= 20000);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "market_state" ADD CONSTRAINT "market_state_max_short_positive"
    CHECK ("max_short_units_per_user" >= 1);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- 3. Add V4.1 short-position columns to market_positions
ALTER TABLE "market_positions" ADD COLUMN IF NOT EXISTS "short_units_held" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "market_positions" ADD COLUMN IF NOT EXISTS "short_entry_notional" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "market_positions" ADD COLUMN IF NOT EXISTS "short_collateral_locked" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "market_positions" ADD COLUMN IF NOT EXISTS "total_shorted_units" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "market_positions" ADD COLUMN IF NOT EXISTS "total_covered_units" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "market_positions" ADD CONSTRAINT "market_positions_short_units_nonnegative"
    CHECK ("short_units_held" >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "market_positions" ADD CONSTRAINT "market_positions_short_notional_nonnegative"
    CHECK ("short_entry_notional" >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "market_positions" ADD CONSTRAINT "market_positions_short_collateral_nonnegative"
    CHECK ("short_collateral_locked" >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "market_positions" ADD CONSTRAINT "market_positions_zero_short_units_zero_collateral"
    CHECK (("short_units_held" > 0) OR ("short_entry_notional" = 0 AND "short_collateral_locked" = 0));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- 4. Create archive_repositories (5-repository GitHub permanent archive registry)
CREATE TABLE IF NOT EXISTS "archive_repositories" (
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
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "archive_repo_shard_positive" CHECK ("shard_generation" >= 1),
  CONSTRAINT "archive_repo_bytes_nonnegative" CHECK ("estimated_bytes_used" >= 0),
  CONSTRAINT "archive_repo_thresholds_valid" CHECK ("warning_threshold_bytes" >= 1048576 AND "hard_limit_bytes" > "warning_threshold_bytes")
);--> statement-breakpoint

-- Seed the 5 canonical Aeros Pay V4.1 private archive repositories
INSERT INTO "archive_repositories" ("repo_key", "repo_name", "branch", "shard_generation", "health_status")
VALUES
  ('aeros-archive-ledger', 'aeros-archive-ledger', 'main', 1, 'HEALTHY'),
  ('aeros-archive-contracts', 'aeros-archive-contracts', 'main', 1, 'HEALTHY'),
  ('aeros-archive-market', 'aeros-archive-market', 'main', 1, 'HEALTHY'),
  ('aeros-archive-economy', 'aeros-archive-economy', 'main', 1, 'HEALTHY'),
  ('aeros-archive-audit', 'aeros-archive-audit', 'main', 1, 'HEALTHY')
ON CONFLICT ("repo_key") DO NOTHING;--> statement-breakpoint

-- 5. Add V4.1 GitHub state-machine and remote tracking columns to archive_batches
ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "repo_key" varchar(48) DEFAULT 'aeros-archive-ledger' NOT NULL;--> statement-breakpoint
ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "repo_name" varchar(120) DEFAULT 'aeros-archive-ledger' NOT NULL;--> statement-breakpoint
ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "shard_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "state_machine_status" varchar(32) DEFAULT 'COMPLETED' NOT NULL;--> statement-breakpoint
ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "remote_commit_sha" varchar(64);--> statement-breakpoint
ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "remote_batch_path" varchar(240);--> statement-breakpoint
ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "remote_manifest_path" varchar(240);--> statement-breakpoint
ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "remote_index_path" varchar(240);--> statement-breakpoint
ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "verified_remote_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "last_error" text;--> statement-breakpoint
ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "archive_batches" ADD COLUMN IF NOT EXISTS "is_download_all_bundle" boolean DEFAULT false NOT NULL;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "archive_batches" ADD CONSTRAINT "archive_batch_retry_nonnegative"
    CHECK ("retry_count" >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "archive_batches_repo_idx" ON "archive_batches" USING btree ("repo_key", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "archive_batches_sm_status_idx" ON "archive_batches" USING btree ("state_machine_status", "next_retry_at");--> statement-breakpoint

-- 6. Create archived_record_ledger (idempotent GitHub archive index per record)
CREATE TABLE IF NOT EXISTS "archived_record_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dataset_key" varchar(48) NOT NULL,
  "record_id" varchar(64) NOT NULL,
  "batch_id" uuid NOT NULL REFERENCES "archive_batches"("id"),
  "repo_key" varchar(48) NOT NULL,
  "remote_batch_path" varchar(240),
  "record_created_at" timestamp with time zone,
  "archived_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cleared_from_neon_at" timestamp with time zone
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "archived_record_dataset_record_unique"
  ON "archived_record_ledger" USING btree ("dataset_key", "record_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "archived_record_batch_idx"
  ON "archived_record_ledger" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "archived_record_repo_idx"
  ON "archived_record_ledger" USING btree ("repo_key", "archived_at");
