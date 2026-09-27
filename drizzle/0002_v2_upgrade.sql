-- ===========================================================================
-- AEROS PAY V2 — ADDITIVE UPGRADE MIGRATION
-- ===========================================================================
-- This migration is strictly ADDITIVE and IDEMPOTENT.
--   * It creates new types, new tables, new columns and new indexes only.
--   * It never DROPs, never TRUNCATEs, never rewrites an existing row.
--   * Every statement is guarded, so running it twice (or resuming after a
--     partial failure) is safe.
--
-- Existing V1 users, balances, transactions, issuance history, audit logs and
-- the Government row are untouched.
--
-- APPLYING IT BY HAND (Neon SQL Editor):
--   Run PART 1 on its own and let it finish, then run PART 2.
--   They are split because PostgreSQL will not let a newly added enum value
--   be *used* in the same transaction that adds it.
-- ===========================================================================


-- ===========================================================================
-- PART 1 — enum types (run this block first, on its own)
-- ===========================================================================

DO $$ BEGIN
  CREATE TYPE "public"."company_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', 'REVOKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."invoice_status" AS ENUM('PENDING', 'PAID', 'CANCELLED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."ip_complaint_status" AS ENUM('OPEN', 'UNDER_REVIEW', 'RESOLVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."ip_decision" AS ENUM('DISMISSED', 'WARNING', 'STRIKE', 'SECOND_STRIKE', 'TEMPORARY_SUSPENSION', 'PERMANENT_REVOCATION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."support_status" AS ENUM('OPEN', 'WAITING', 'RESOLVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TYPE "public"."party_type" ADD VALUE IF NOT EXISTS 'COMPANY';--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'COMPANY_FUNDING';--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'COMPANY_SALE';--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'COMPANY_PAYMENT';--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'INVOICE_PAYMENT';--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'GOVERNMENT_PAYMENT';--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'GOVERNMENT_RECEIPT';--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'COMPANY_ADJUSTMENT_CREDIT';--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'COMPANY_ADJUSTMENT_DEBIT';--> statement-breakpoint


-- ===========================================================================
-- PART 2 — tables, columns, constraints, indexes (run after PART 1)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(80) NOT NULL,
	"username" varchar(32) NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"category" varchar(60) NOT NULL,
	"reason" text NOT NULL,
	"description" text NOT NULL,
	"status" "company_status" DEFAULT 'PENDING' NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"tax_rate_bp" integer,
	"tax_updated_at" timestamp with time zone,
	"strikes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" varchar(64),
	"rejection_reason" text,
	"funded_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"suspended_until" timestamp with time zone,
	"suspension_reason" text,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	CONSTRAINT "companies_username_unique" UNIQUE("username"),
	CONSTRAINT "companies_username_lowercase" CHECK ("companies"."username" = lower("companies"."username")),
	CONSTRAINT "companies_balance_nonnegative" CHECK ("companies"."balance" >= 0),
	CONSTRAINT "companies_tax_rate_bounds" CHECK ("companies"."tax_rate_bp" IS NULL OR ("companies"."tax_rate_bp" >= 0 AND "companies"."tax_rate_bp" <= 10000))
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" varchar(32) NOT NULL,
	"company_id" uuid NOT NULL,
	"buyer_user_id" uuid NOT NULL,
	"item_name" varchar(160) NOT NULL,
	"description" text,
	"quantity" integer NOT NULL,
	"unit_price" integer NOT NULL,
	"subtotal" integer NOT NULL,
	"tax_rate_bp" integer NOT NULL,
	"tax_amount" integer NOT NULL,
	"total" integer NOT NULL,
	"status" "invoice_status" DEFAULT 'PENDING' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"paid_tx_ref" varchar(32),
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "invoices_invoice_number_unique" UNIQUE("invoice_number"),
	CONSTRAINT "invoices_quantity_positive" CHECK ("invoices"."quantity" >= 1),
	CONSTRAINT "invoices_unit_price_positive" CHECK ("invoices"."unit_price" >= 1),
	CONSTRAINT "invoices_total_positive" CHECK ("invoices"."total" >= 1),
	CONSTRAINT "invoices_tax_nonnegative" CHECK ("invoices"."tax_amount" >= 0)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ip_complaints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"complaint_number" varchar(32) NOT NULL,
	"complainant_company_id" uuid NOT NULL,
	"accused_company_id" uuid NOT NULL,
	"reason" varchar(160) NOT NULL,
	"description" text NOT NULL,
	"evidence" text NOT NULL,
	"reference_material" text,
	"status" "ip_complaint_status" DEFAULT 'OPEN' NOT NULL,
	"decision" "ip_decision",
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"decided_by" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ip_complaints_complaint_number_unique" UNIQUE("complaint_number")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "retention_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"updates_retention_days" integer,
	"notifications_retention_days" integer,
	"support_retention_days" integer,
	"last_cleanup_at" timestamp with time zone,
	"last_cleanup_summary" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "support_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "support_status" DEFAULT 'OPEN' NOT NULL,
	"unread_for_government" integer DEFAULT 0 NOT NULL,
	"unread_for_user" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "support_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"sender_type" "party_type" NOT NULL,
	"sender_label" varchar(64) NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- --- new columns on existing tables (all nullable or defaulted) -------------

ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "previous_value" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "new_value" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "reason" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "company_tax_rate_bp" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "company_tax_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issuance_requests" ADD COLUMN IF NOT EXISTS "note" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "href" varchar(200);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspended_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspended_by" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspension_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "banned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "banned_by" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ban_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "session_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_updated_at" timestamp with time zone;--> statement-breakpoint

-- --- foreign keys on the new tables ----------------------------------------

DO $$ BEGIN
  ALTER TABLE "companies" ADD CONSTRAINT "companies_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "invoices" ADD CONSTRAINT "invoices_buyer_user_id_users_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "ip_complaints" ADD CONSTRAINT "ip_complaints_complainant_company_id_companies_id_fk" FOREIGN KEY ("complainant_company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "ip_complaints" ADD CONSTRAINT "ip_complaints_accused_company_id_companies_id_fk" FOREIGN KEY ("accused_company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_thread_id_support_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."support_threads"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- --- indexes ----------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "companies_owner_idx" ON "companies" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "companies_status_idx" ON "companies" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_company_idx" ON "invoices" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_buyer_idx" ON "invoices" USING btree ("buyer_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_status_idx" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ip_complaints_status_idx" ON "ip_complaints" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ip_complaints_accused_idx" ON "ip_complaints" USING btree ("accused_company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_messages_thread_idx" ON "support_messages" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_thread_user_unique" ON "support_threads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_sender_idx" ON "transactions" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_receiver_idx" ON "transactions" USING btree ("receiver_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_created_idx" ON "transactions" USING btree ("created_at");--> statement-breakpoint

-- --- singleton row for retention settings ----------------------------------

INSERT INTO "retention_settings" ("id")
SELECT gen_random_uuid()
WHERE NOT EXISTS (SELECT 1 FROM "retention_settings");
