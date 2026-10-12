-- =============================================================================
-- AEROS PAY V5 UPGRADE MIGRATION (0010_v5_upgrade.sql)
-- =============================================================================
-- Strictly additive, reversible & idempotent migration for Neon PostgreSQL:
-- 1. Creates V5 enums for trading positions, leverage requests, jobs,
--    company partnerships, media moderation, and archive job runs.
-- 2. Adds market_update_interval_minutes to government table.
-- 3. Adds max_leverage to users table (progression: 2x, 4x, 8x, 10x).
-- 4. Extends archive_repositories with continuation repo mapping & write toggles.
-- 5. Seeds the dedicated 15 private archive repositories into archive_repositories
--    with 900 MB operating threshold (800 MB warning / 900 MB critical).
-- 6. Creates archive_job_runs for durable, resumable GitHub archival.
-- 7. Creates market_trade_positions for independent hedge-style positions (LONG/SHORT).
-- 8. Creates leverage_requests for structured citizen leverage progression.
-- 9. Creates jobs and job_applications for government/company citizen employment.
-- 10. Creates company_partnerships and partnership_settlements (50/50 division).
-- 11. Creates media_posts, media_comments, media_likes, media_shares for Aeros Media.
-- =============================================================================

-- 1. Create V5 Enums safely
DO $$ BEGIN
  CREATE TYPE "public"."trade_position_direction" AS ENUM('LONG', 'SHORT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."trade_position_status" AS ENUM('OPEN', 'CLOSED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."leverage_request_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."employer_type" AS ENUM('GOVERNMENT', 'COMPANY');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."job_status" AS ENUM('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'CLOSED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."job_application_status" AS ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."partnership_status" AS ENUM('PROPOSED', 'ACCEPTED_BY_PARTNER', 'REJECTED_BY_PARTNER', 'APPROVED_BY_GOVERNMENT', 'REJECTED_BY_GOVERNMENT', 'TERMINATED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."media_moderation_status" AS ENUM('ACTIVE', 'FLAGGED', 'MODERATED_HIDDEN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."archive_job_status" AS ENUM('IDLE', 'RUNNING', 'COMPLETED', 'FAILED', 'PAUSED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- 2. Update existing tables
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "market_update_interval_minutes" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "government" ADD CONSTRAINT "government_market_interval_bounds"
    CHECK ("market_update_interval_minutes" IN (1, 5));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "max_leverage" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_max_leverage_bounds"
    CHECK ("max_leverage" >= 2 AND "max_leverage" <= 10);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

ALTER TABLE "archive_repositories" ADD COLUMN IF NOT EXISTS "continuation_repo_key" varchar(64);--> statement-breakpoint
ALTER TABLE "archive_repositories" ADD COLUMN IF NOT EXISTS "continuation_repo_name" varchar(120);--> statement-breakpoint
ALTER TABLE "archive_repositories" ADD COLUMN IF NOT EXISTS "is_active_for_writes" boolean DEFAULT true NOT NULL;--> statement-breakpoint

-- 3. Seed/Update 15 Dedicated Repositories in archive_repositories with 900 MB Limits
INSERT INTO "archive_repositories" ("repo_key", "repo_owner", "repo_name", "branch", "warning_threshold_bytes", "hard_limit_bytes")
VALUES
  ('aeros-archive-market-index', '', 'aeros-archive-market-index', 'main', 838860800, 943718400),
  ('aeros-archive-trading-ledger', '', 'aeros-archive-trading-ledger', 'main', 838860800, 943718400),
  ('aeros-archive-payments', '', 'aeros-archive-payments', 'main', 838860800, 943718400),
  ('aeros-archive-exchange', '', 'aeros-archive-exchange', 'main', 838860800, 943718400),
  ('aeros-archive-refunds', '', 'aeros-archive-refunds', 'main', 838860800, 943718400),
  ('aeros-archive-marketplace-listings', '', 'aeros-archive-marketplace-listings', 'main', 838860800, 943718400),
  ('aeros-archive-marketplace-orders', '', 'aeros-archive-marketplace-orders', 'main', 838860800, 943718400),
  ('aeros-archive-jobs', '', 'aeros-archive-jobs', 'main', 838860800, 943718400),
  ('aeros-archive-contracts', '', 'aeros-archive-contracts', 'main', 838860800, 943718400),
  ('aeros-archive-company-partnerships', '', 'aeros-archive-company-partnerships', 'main', 838860800, 943718400),
  ('aeros-archive-company-finances', '', 'aeros-archive-company-finances', 'main', 838860800, 943718400),
  ('aeros-archive-loans', '', 'aeros-archive-loans', 'main', 838860800, 943718400),
  ('aeros-archive-media', '', 'aeros-archive-media', 'main', 838860800, 943718400),
  ('aeros-archive-government', '', 'aeros-archive-government', 'main', 838860800, 943718400),
  ('aeros-archive-audit', '', 'aeros-archive-audit', 'main', 838860800, 943718400)
ON CONFLICT ("repo_key") DO UPDATE SET
  "warning_threshold_bytes" = EXCLUDED."warning_threshold_bytes",
  "hard_limit_bytes" = EXCLUDED."hard_limit_bytes";--> statement-breakpoint

-- 4. Create archive_job_runs
CREATE TABLE IF NOT EXISTS "archive_job_runs" (
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
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "archive_job_runs_status_idx" ON "archive_job_runs" ("status", "started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "archive_job_runs_locked_idx" ON "archive_job_runs" ("is_locked");--> statement-breakpoint

-- 5. Create market_trade_positions
CREATE TABLE IF NOT EXISTS "market_trade_positions" (
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
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "market_trade_positions_user_status_idx" ON "market_trade_positions" ("user_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "market_trade_positions_opened_at_idx" ON "market_trade_positions" ("opened_at");--> statement-breakpoint

-- 6. Create leverage_requests
CREATE TABLE IF NOT EXISTS "leverage_requests" (
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
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "leverage_requests_user_status_idx" ON "leverage_requests" ("user_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leverage_requests_status_created_idx" ON "leverage_requests" ("status", "created_at");--> statement-breakpoint

-- 7. Create jobs
CREATE TABLE IF NOT EXISTS "jobs" (
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
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "jobs_status_category_idx" ON "jobs" ("status", "category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_employer_idx" ON "jobs" ("employer_type", "employer_company_id");--> statement-breakpoint

-- 8. Create job_applications
CREATE TABLE IF NOT EXISTS "job_applications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_id" uuid NOT NULL REFERENCES "jobs"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "cover_note" text NOT NULL,
  "status" "job_application_status" DEFAULT 'PENDING' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reviewed_at" timestamp with time zone,
  CONSTRAINT "job_applications_user_job_unique" UNIQUE ("job_id", "user_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "job_applications_job_status_idx" ON "job_applications" ("job_id", "status");--> statement-breakpoint

-- 9. Create company_partnerships
CREATE TABLE IF NOT EXISTS "company_partnerships" (
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
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "company_partnerships_initiator_idx" ON "company_partnerships" ("initiator_company_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_partnerships_partner_idx" ON "company_partnerships" ("partner_company_id", "status");--> statement-breakpoint

-- 10. Create partnership_settlements
CREATE TABLE IF NOT EXISTS "partnership_settlements" (
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
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "partnership_settlements_partnership_idx" ON "partnership_settlements" ("partnership_id", "created_at");--> statement-breakpoint

-- 11. Create media_posts
CREATE TABLE IF NOT EXISTS "media_posts" (
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
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "media_posts_feed_idx" ON "media_posts" ("moderation_status", "is_expired", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_posts_author_idx" ON "media_posts" ("author_id", "created_at");--> statement-breakpoint

-- 12. Create media_comments
CREATE TABLE IF NOT EXISTS "media_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "post_id" uuid NOT NULL REFERENCES "media_posts"("id"),
  "author_id" uuid NOT NULL REFERENCES "users"("id"),
  "content" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "media_comments_post_idx" ON "media_comments" ("post_id", "created_at");--> statement-breakpoint

-- 13. Create media_likes
CREATE TABLE IF NOT EXISTS "media_likes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "post_id" uuid NOT NULL REFERENCES "media_posts"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "media_likes_post_user_unique" UNIQUE ("post_id", "user_id")
);--> statement-breakpoint

-- 14. Create media_shares
CREATE TABLE IF NOT EXISTS "media_shares" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "post_id" uuid NOT NULL REFERENCES "media_posts"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "media_shares_post_user_idx" ON "media_shares" ("post_id", "user_id");

