-- ===========================================================================
-- AEROS PAY V2 — COMPANY SALES + GOVERNMENT LOANS
-- ===========================================================================
-- Strictly ADDITIVE and IDEMPOTENT, exactly like 0002.
-- Creates new tables/columns only. Never drops, truncates or rewrites a row.
--
-- APPLYING BY HAND (Neon SQL Editor): run PART 1, let it finish, then PART 2.
-- ===========================================================================


-- ===========================================================================
-- PART 1 — enum types (run first, on its own)
-- ===========================================================================

DO $$ BEGIN
  CREATE TYPE "public"."instalment_status" AS ENUM('PENDING', 'PAID', 'OVERDUE', 'WAIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."loan_status" AS ENUM('PENDING', 'APPROVED', 'ACTIVE', 'PAID', 'REJECTED', 'CANCELLED', 'DEFAULTED', 'RESTRUCTURED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."sale_listing_status" AS ENUM('OPEN', 'SOLD', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."sale_offer_status" AS ENUM('PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'COMPANY_SALE_PURCHASE';
--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'LOAN_DISBURSEMENT';
--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'LOAN_REPAYMENT';


-- ===========================================================================
-- PART 2 — tables, columns, constraints, indexes (run after PART 1)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "company_sale_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "government_owned" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "government_acquired_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_sale_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"seller_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"sales_figure" integer NOT NULL,
	"multiplier_bp" integer NOT NULL,
	"valuation" integer NOT NULL,
	"valued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "sale_listing_status" DEFAULT 'OPEN' NOT NULL,
	"buyer_user_id" uuid,
	"sale_price" integer,
	"sold_at" timestamp with time zone,
	"sold_tx_ref" varchar(32),
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_listing_valuation_nonnegative" CHECK ("company_sale_listings"."valuation" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_sale_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"listing_id" uuid,
	"offeror_type" "party_type" NOT NULL,
	"offeror_user_id" uuid,
	"owner_user_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"message" text,
	"status" "sale_offer_status" DEFAULT 'PENDING' NOT NULL,
	"responded_at" timestamp with time zone,
	"response_note" text,
	"settled_tx_ref" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_offer_amount_positive" CHECK ("company_sale_offers"."amount" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_sale_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"listing_id" uuid,
	"offer_id" uuid,
	"seller_user_id" uuid NOT NULL,
	"buyer_user_id" uuid NOT NULL,
	"price" integer NOT NULL,
	"sales_figure" integer NOT NULL,
	"multiplier_bp" integer NOT NULL,
	"company_balance_at_sale" integer NOT NULL,
	"tx_ref" varchar(32) NOT NULL,
	"sale_type" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loan_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL,
	"action" varchar(32) NOT NULL,
	"reason" text NOT NULL,
	"actor_label" varchar(64) NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loan_instalments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"principal_portion" integer NOT NULL,
	"interest_portion" integer NOT NULL,
	"total_due" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" "instalment_status" DEFAULT 'PENDING' NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_tx_ref" varchar(32),
	"paid_amount" integer,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"last_reminder_at" timestamp with time zone,
	"last_reminder_stage" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instalment_total_positive" CHECK ("loan_instalments"."total_due" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loan_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL,
	"instalment_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"principal_paid" integer NOT NULL,
	"interest_paid" integer NOT NULL,
	"remaining_balance" integer NOT NULL,
	"tx_ref" varchar(32) NOT NULL,
	"paid_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_number" varchar(32) NOT NULL,
	"company_id" uuid NOT NULL,
	"applied_by_user_id" uuid NOT NULL,
	"requested_amount" integer NOT NULL,
	"purpose" text NOT NULL,
	"principal" integer,
	"interest_rate_bp" integer,
	"total_interest" integer,
	"total_payable" integer,
	"instalment_count" integer,
	"instalment_interval_days" integer,
	"principal_paid" integer DEFAULT 0 NOT NULL,
	"interest_paid" integer DEFAULT 0 NOT NULL,
	"status" "loan_status" DEFAULT 'PENDING' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" varchar(64),
	"rejection_reason" text,
	"accepted_at" timestamp with time zone,
	"disbursed_at" timestamp with time zone,
	"disbursement_tx_ref" varchar(32),
	"next_due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"defaulted_at" timestamp with time zone,
	"default_reason" text,
	"restructured_at" timestamp with time zone,
	"restructure_note" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loans_loan_number_unique" UNIQUE("loan_number"),
	CONSTRAINT "loans_requested_positive" CHECK ("loans"."requested_amount" >= 1),
	CONSTRAINT "loans_principal_paid_nonnegative" CHECK ("loans"."principal_paid" >= 0),
	CONSTRAINT "loans_interest_paid_nonnegative" CHECK ("loans"."interest_paid" >= 0)
);
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "sale_multiplier_bp" integer DEFAULT 15000 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "sale_min_company_age_days" integer DEFAULT 7 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "loans_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "loan_interest_rate_bp" integer DEFAULT 1000 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "loan_min_amount" integer DEFAULT 100 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "loan_max_amount" integer DEFAULT 10000 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "loan_instalment_count" integer DEFAULT 2 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "loan_instalment_interval_days" integer DEFAULT 7 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "loan_min_company_age_days" integer DEFAULT 7 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "loan_min_company_sales" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "loan_default_grace_days" integer DEFAULT 7 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "loan_policy_updated_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "company_sale_dismissals" ADD CONSTRAINT "company_sale_dismissals_listing_id_company_sale_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."company_sale_listings"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "company_sale_dismissals" ADD CONSTRAINT "company_sale_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "company_sale_listings" ADD CONSTRAINT "company_sale_listings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "company_sale_listings" ADD CONSTRAINT "company_sale_listings_seller_user_id_users_id_fk" FOREIGN KEY ("seller_user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "company_sale_listings" ADD CONSTRAINT "company_sale_listings_buyer_user_id_users_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "company_sale_offers" ADD CONSTRAINT "company_sale_offers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "company_sale_offers" ADD CONSTRAINT "company_sale_offers_listing_id_company_sale_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."company_sale_listings"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "company_sale_offers" ADD CONSTRAINT "company_sale_offers_offeror_user_id_users_id_fk" FOREIGN KEY ("offeror_user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "company_sale_offers" ADD CONSTRAINT "company_sale_offers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "company_sale_records" ADD CONSTRAINT "company_sale_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "company_sale_records" ADD CONSTRAINT "company_sale_records_listing_id_company_sale_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."company_sale_listings"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "company_sale_records" ADD CONSTRAINT "company_sale_records_offer_id_company_sale_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."company_sale_offers"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "company_sale_records" ADD CONSTRAINT "company_sale_records_seller_user_id_users_id_fk" FOREIGN KEY ("seller_user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "company_sale_records" ADD CONSTRAINT "company_sale_records_buyer_user_id_users_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "loan_actions" ADD CONSTRAINT "loan_actions_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "loan_instalments" ADD CONSTRAINT "loan_instalments_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_instalment_id_loan_instalments_id_fk" FOREIGN KEY ("instalment_id") REFERENCES "public"."loan_instalments"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_paid_by_user_id_users_id_fk" FOREIGN KEY ("paid_by_user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "loans" ADD CONSTRAINT "loans_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "loans" ADD CONSTRAINT "loans_applied_by_user_id_users_id_fk" FOREIGN KEY ("applied_by_user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sale_dismissal_unique" ON "company_sale_dismissals" USING btree ("listing_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sale_listings_company_idx" ON "company_sale_listings" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sale_listings_status_idx" ON "company_sale_listings" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sale_offers_company_idx" ON "company_sale_offers" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sale_offers_owner_idx" ON "company_sale_offers" USING btree ("owner_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sale_offers_status_idx" ON "company_sale_offers" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sale_records_company_idx" ON "company_sale_records" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loan_actions_loan_idx" ON "loan_actions" USING btree ("loan_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "loan_instalment_unique" ON "loan_instalments" USING btree ("loan_id","sequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loan_instalments_due_idx" ON "loan_instalments" USING btree ("due_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loan_instalments_status_idx" ON "loan_instalments" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loan_payments_loan_idx" ON "loan_payments" USING btree ("loan_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loans_company_idx" ON "loans" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loans_status_idx" ON "loans" USING btree ("status");
