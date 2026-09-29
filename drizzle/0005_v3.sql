-- ===========================================================================
-- AEROS PAY V3 — MARKETPLACE, UNIVERSAL INVOICES, PROMOTIONS, RATINGS,
--                TAX MATRIX, IDEMPOTENCY, REVERSALS, RETENTION
-- ===========================================================================
-- ONE migration for the WHOLE of V3. Later V3 phases add UI and server
-- actions on top of this schema; they do not need another migration.
--
-- Strictly ADDITIVE and IDEMPOTENT, exactly like 0002/0003/0004:
--   * It creates new types, new tables, new columns, new constraints and new
--     indexes only.
--   * It never DROPs a table or column, never TRUNCATEs, never rewrites or
--     deletes an existing row.
--   * The only change to an existing column is LOOSENING one NOT NULL
--     (invoices.buyer_user_id) and adding two DEFAULTs on
--     retention_settings. A DEFAULT applies to future inserts only, so no
--     stored value changes.
--   * Every statement is guarded, so running it twice (or resuming after a
--     partial failure) is a harmless no-op.
--
-- BEHAVIOUR GUARANTEE
-- -------------------
-- Nothing here is seeded. In particular `tax_matrix` is created EMPTY, and an
-- empty tax matrix means "inherit", so tax is computed by the exact V2 rules
-- (government.tax_rate_bp / government.company_tax_rate_bp / a per-company
-- override) until the Government configures a row. See src/lib/taxmatrix.ts.
--
-- NOT STORED, ON PURPOSE
-- ----------------------
-- There is no impressions, clicks, dismissals or view-event column or table
-- for promotions anywhere below. The spec forbids collecting them, so they do
-- not exist.
--
-- APPLYING IT BY HAND (Neon SQL Editor):
--   Run PART 1 on its own and let it finish, THEN run PART 2.
--   They are split because PostgreSQL will not let a newly created enum type's
--   values be used in the same transaction that creates them.
--   Re-running either part on its own is safe.
-- ===========================================================================


-- ===========================================================================
-- PART 1 — enum types and new enum values (run this block first, on its own)
-- ===========================================================================

DO $$ BEGIN
  CREATE TYPE "public"."contract_application_status" AS ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."contract_status" AS ENUM('OPEN', 'AWARDED', 'COMPLETED', 'CANCELLED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."idempotency_status" AS ENUM('IN_PROGRESS', 'SUCCEEDED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."marketplace_offer_status" AS ENUM('ACTIVE', 'PAUSED', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."marketplace_order_status" AS ENUM('PENDING', 'ACCEPTED', 'WAITING_FOR_INVOICE', 'PAYMENT_DUE', 'PAID', 'COMPLETED', 'CANCELLED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."promotion_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'ACTIVE', 'PAUSED', 'COMPLETED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."tax_context" AS ENUM('DIRECT_TRANSFER', 'INVOICE_PAYMENT', 'MARKETPLACE_ORDER', 'CONTRACT_PAYMENT', 'LOAN_REPAYMENT', 'PROMOTION_CHARGE', 'GOVERNMENT_ON_BEHALF');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."wanted_request_status" AS ENUM('OPEN', 'FULFILLED', 'CANCELLED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."wanted_response_status" AS ENUM('PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'MARKETPLACE_PAYMENT';
--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'CONTRACT_PAYMENT';
--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'PROMOTION_CHARGE';
--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'GOVERNMENT_ON_BEHALF';
--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'TRANSACTION_REVERSAL';
--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'TRANSACTION_ADJUSTMENT';


-- ===========================================================================
-- PART 2 — tables, columns, constraints, indexes (run after PART 1)
-- ===========================================================================

-- --- new tables -------------------------------------------------------------
-- Note on ordering: the circular pair of links between `invoices` and
-- `marketplace_orders` is added in the foreign-key section further down, so
-- the CREATE TABLE order below does not matter.

CREATE TABLE IF NOT EXISTS "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(120) NOT NULL,
	"scope" varchar(64) NOT NULL,
	"actor_type" "party_type" NOT NULL,
	"actor_id" uuid,
	"request_hash" varchar(64) NOT NULL,
	"status" "idempotency_status" DEFAULT 'IN_PROGRESS' NOT NULL,
	"result_tx_ref" varchar(32),
	"result_entity_type" varchar(48),
	"result_entity_id" uuid,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketplace_contract_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"applicant_type" "party_type" NOT NULL,
	"applicant_user_id" uuid,
	"applicant_company_id" uuid,
	"proposal" text NOT NULL,
	"quoted_price" integer,
	"status" "contract_application_status" DEFAULT 'PENDING' NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_applications_price_positive" CHECK ("marketplace_contract_applications"."quoted_price" IS NULL OR "marketplace_contract_applications"."quoted_price" >= 1),
	CONSTRAINT "contract_applications_applicant_consistent" CHECK (("marketplace_contract_applications"."applicant_type" = 'USER' AND "marketplace_contract_applications"."applicant_user_id" IS NOT NULL AND "marketplace_contract_applications"."applicant_company_id" IS NULL)
     OR ("marketplace_contract_applications"."applicant_type" = 'COMPANY' AND "marketplace_contract_applications"."applicant_company_id" IS NOT NULL AND "marketplace_contract_applications"."applicant_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketplace_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_number" varchar(32) NOT NULL,
	"issuer_type" "party_type" NOT NULL,
	"issuer_company_id" uuid,
	"title" varchar(160) NOT NULL,
	"requirement" text NOT NULL,
	"description" text NOT NULL,
	"conditions" text,
	"budget" integer NOT NULL,
	"deadline" timestamp with time zone,
	"status" "contract_status" DEFAULT 'OPEN' NOT NULL,
	"awarded_to_type" "party_type",
	"awarded_to_user_id" uuid,
	"awarded_to_company_id" uuid,
	"awarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "marketplace_contracts_contract_number_unique" UNIQUE("contract_number"),
	CONSTRAINT "contracts_budget_positive" CHECK ("marketplace_contracts"."budget" >= 1),
	CONSTRAINT "contracts_issuer_consistent" CHECK (("marketplace_contracts"."issuer_type" = 'COMPANY' AND "marketplace_contracts"."issuer_company_id" IS NOT NULL)
     OR ("marketplace_contracts"."issuer_type" = 'GOVERNMENT' AND "marketplace_contracts"."issuer_company_id" IS NULL)),
	CONSTRAINT "contracts_award_consistent" CHECK (("marketplace_contracts"."awarded_to_type" IS NULL AND "marketplace_contracts"."awarded_to_user_id" IS NULL AND "marketplace_contracts"."awarded_to_company_id" IS NULL)
     OR ("marketplace_contracts"."awarded_to_type" = 'USER' AND "marketplace_contracts"."awarded_to_user_id" IS NOT NULL AND "marketplace_contracts"."awarded_to_company_id" IS NULL)
     OR ("marketplace_contracts"."awarded_to_type" = 'COMPANY' AND "marketplace_contracts"."awarded_to_company_id" IS NOT NULL AND "marketplace_contracts"."awarded_to_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketplace_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" varchar(160) NOT NULL,
	"description" text NOT NULL,
	"category" varchar(60) NOT NULL,
	"unit_price" integer NOT NULL,
	"quantity_available" integer,
	"status" "marketplace_offer_status" DEFAULT 'ACTIVE' NOT NULL,
	"paused_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_offers_price_positive" CHECK ("marketplace_offers"."unit_price" >= 1),
	CONSTRAINT "marketplace_offers_quantity_nonnegative" CHECK ("marketplace_offers"."quantity_available" IS NULL OR "marketplace_offers"."quantity_available" >= 0),
	CONSTRAINT "marketplace_offers_paused_at_present" CHECK ("marketplace_offers"."status" <> 'PAUSED' OR "marketplace_offers"."paused_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketplace_order_ratings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"rater_type" "party_type" NOT NULL,
	"rater_user_id" uuid,
	"rater_company_id" uuid,
	"rated_company_id" uuid NOT NULL,
	"stars" integer NOT NULL,
	"comment" text,
	"comment_expires_at" timestamp with time zone,
	"comment_cleared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_order_ratings_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "ratings_stars_bounds" CHECK ("marketplace_order_ratings"."stars" >= 1 AND "marketplace_order_ratings"."stars" <= 5),
	CONSTRAINT "ratings_comment_expiry_consistent" CHECK (("marketplace_order_ratings"."comment" IS NULL) OR ("marketplace_order_ratings"."comment_expires_at" IS NOT NULL)),
	CONSTRAINT "ratings_rater_consistent" CHECK (("marketplace_order_ratings"."rater_type" = 'USER' AND "marketplace_order_ratings"."rater_user_id" IS NOT NULL AND "marketplace_order_ratings"."rater_company_id" IS NULL)
     OR ("marketplace_order_ratings"."rater_type" = 'COMPANY' AND "marketplace_order_ratings"."rater_company_id" IS NOT NULL AND "marketplace_order_ratings"."rater_user_id" IS NULL)
     OR ("marketplace_order_ratings"."rater_type" = 'GOVERNMENT' AND "marketplace_order_ratings"."rater_user_id" IS NULL AND "marketplace_order_ratings"."rater_company_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketplace_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" varchar(32) NOT NULL,
	"offer_id" uuid NOT NULL,
	"seller_company_id" uuid NOT NULL,
	"buyer_type" "party_type" NOT NULL,
	"buyer_user_id" uuid,
	"buyer_company_id" uuid,
	"quantity" integer NOT NULL,
	"unit_price" integer NOT NULL,
	"subtotal" integer NOT NULL,
	"status" "marketplace_order_status" DEFAULT 'PENDING' NOT NULL,
	"invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "marketplace_orders_order_number_unique" UNIQUE("order_number"),
	CONSTRAINT "marketplace_orders_quantity_positive" CHECK ("marketplace_orders"."quantity" >= 1),
	CONSTRAINT "marketplace_orders_unit_price_positive" CHECK ("marketplace_orders"."unit_price" >= 1),
	CONSTRAINT "marketplace_orders_subtotal_matches" CHECK ("marketplace_orders"."subtotal" = "marketplace_orders"."quantity" * "marketplace_orders"."unit_price"),
	CONSTRAINT "marketplace_orders_buyer_consistent" CHECK (("marketplace_orders"."buyer_type" = 'USER' AND "marketplace_orders"."buyer_user_id" IS NOT NULL AND "marketplace_orders"."buyer_company_id" IS NULL)
     OR ("marketplace_orders"."buyer_type" = 'COMPANY' AND "marketplace_orders"."buyer_company_id" IS NOT NULL AND "marketplace_orders"."buyer_user_id" IS NULL)
     OR ("marketplace_orders"."buyer_type" = 'GOVERNMENT' AND "marketplace_orders"."buyer_user_id" IS NULL AND "marketplace_orders"."buyer_company_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketplace_wanted_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_type" "party_type" NOT NULL,
	"requester_user_id" uuid,
	"requester_company_id" uuid,
	"heading" varchar(160) NOT NULL,
	"description" text NOT NULL,
	"category" varchar(60) NOT NULL,
	"quantity" integer NOT NULL,
	"budget" integer NOT NULL,
	"deadline" timestamp with time zone,
	"status" "wanted_request_status" DEFAULT 'OPEN' NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wanted_requests_quantity_positive" CHECK ("marketplace_wanted_requests"."quantity" >= 1),
	CONSTRAINT "wanted_requests_budget_positive" CHECK ("marketplace_wanted_requests"."budget" >= 1),
	CONSTRAINT "wanted_requests_requester_consistent" CHECK (("marketplace_wanted_requests"."requester_type" = 'USER' AND "marketplace_wanted_requests"."requester_user_id" IS NOT NULL AND "marketplace_wanted_requests"."requester_company_id" IS NULL)
     OR ("marketplace_wanted_requests"."requester_type" = 'COMPANY' AND "marketplace_wanted_requests"."requester_company_id" IS NOT NULL AND "marketplace_wanted_requests"."requester_user_id" IS NULL)
     OR ("marketplace_wanted_requests"."requester_type" = 'GOVERNMENT' AND "marketplace_wanted_requests"."requester_user_id" IS NULL AND "marketplace_wanted_requests"."requester_company_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketplace_wanted_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"responder_type" "party_type" NOT NULL,
	"responder_user_id" uuid,
	"responder_company_id" uuid,
	"message" text NOT NULL,
	"offered_price" integer,
	"status" "wanted_response_status" DEFAULT 'PENDING' NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wanted_responses_price_positive" CHECK ("marketplace_wanted_responses"."offered_price" IS NULL OR "marketplace_wanted_responses"."offered_price" >= 1),
	CONSTRAINT "wanted_responses_responder_consistent" CHECK (("marketplace_wanted_responses"."responder_type" = 'USER' AND "marketplace_wanted_responses"."responder_user_id" IS NOT NULL AND "marketplace_wanted_responses"."responder_company_id" IS NULL)
     OR ("marketplace_wanted_responses"."responder_type" = 'COMPANY' AND "marketplace_wanted_responses"."responder_company_id" IS NOT NULL AND "marketplace_wanted_responses"."responder_user_id" IS NULL)
     OR ("marketplace_wanted_responses"."responder_type" = 'GOVERNMENT' AND "marketplace_wanted_responses"."responder_user_id" IS NULL AND "marketplace_wanted_responses"."responder_company_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "promotion_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"offer_id" uuid,
	"heading" varchar(160) NOT NULL,
	"short_description" varchar(240) NOT NULL,
	"cta_label" varchar(48) NOT NULL,
	"destination" varchar(200) NOT NULL,
	"requested_duration_days" integer NOT NULL,
	"daily_rate" integer NOT NULL,
	"status" "promotion_status" DEFAULT 'PENDING' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" varchar(64),
	"rejection_reason" text,
	"activated_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_charged_on" date,
	"total_charged" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_duration_bounds" CHECK ("promotion_campaigns"."requested_duration_days" >= 1 AND "promotion_campaigns"."requested_duration_days" <= 365),
	CONSTRAINT "promotion_daily_rate_nonnegative" CHECK ("promotion_campaigns"."daily_rate" >= 0),
	CONSTRAINT "promotion_total_charged_nonnegative" CHECK ("promotion_campaigns"."total_charged" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconciliation_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"healthy" boolean NOT NULL,
	"checks_run" integer NOT NULL,
	"checks_failed" integer NOT NULL,
	"failed_check_keys" text,
	"summary" text,
	"ran_by" varchar(64),
	CONSTRAINT "reconciliation_status_singleton" CHECK ("reconciliation_status"."singleton" = true),
	CONSTRAINT "reconciliation_status_counts_nonnegative" CHECK ("reconciliation_status"."checks_run" >= 0 AND "reconciliation_status"."checks_failed" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tax_matrix" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_type" "party_type" NOT NULL,
	"recipient_type" "party_type" NOT NULL,
	"context" "tax_context" NOT NULL,
	"rate_bp" integer,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64),
	CONSTRAINT "tax_matrix_rate_bounds" CHECK ("tax_matrix"."rate_bp" IS NULL OR ("tax_matrix"."rate_bp" >= 0 AND "tax_matrix"."rate_bp" <= 10000))
);
--> statement-breakpoint
-- --- loosened constraints / new defaults on existing tables -----------------
-- `invoices.buyer_user_id` becomes nullable so a COMPANY or GOVERNMENT invoice
-- recipient is representable. Loosening a NOT NULL rewrites no row and changes
-- no stored value; V2 code always sets this column.
--
-- The two retention DEFAULTs give the spec's stated numbers (30 days for
-- notifications, 7 for support) to FUTURE inserts only. The live singleton row
-- keeps whatever the Government already configured.

ALTER TABLE "invoices" ALTER COLUMN "buyer_user_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "retention_settings" ALTER COLUMN "notifications_retention_days" SET DEFAULT 30;
--> statement-breakpoint
ALTER TABLE "retention_settings" ALTER COLUMN "support_retention_days" SET DEFAULT 7;
--> statement-breakpoint
-- --- new columns on existing tables (all nullable or defaulted) -------------

ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "promotions_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "promotion_daily_rate" integer DEFAULT 50 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "promotion_policy_updated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "recipient_type" "party_type" DEFAULT 'USER' NOT NULL;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "recipient_company_id" uuid;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "source_order_id" uuid;
--> statement-breakpoint
ALTER TABLE "retention_settings" ADD COLUMN IF NOT EXISTS "paused_offer_retention_days" integer DEFAULT 14;
--> statement-breakpoint
ALTER TABLE "retention_settings" ADD COLUMN IF NOT EXISTS "rating_comment_retention_days" integer DEFAULT 30;
--> statement-breakpoint
ALTER TABLE "retention_settings" ADD COLUMN IF NOT EXISTS "expired_wanted_retention_days" integer DEFAULT 30;
--> statement-breakpoint
ALTER TABLE "retention_settings" ADD COLUMN IF NOT EXISTS "expired_order_retention_days" integer DEFAULT 30;
--> statement-breakpoint
ALTER TABLE "retention_settings" ADD COLUMN IF NOT EXISTS "idempotency_key_retention_days" integer DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "reverses_transaction_id" uuid;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_official_government_user" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_government_member" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "badges_updated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "badges_updated_by" varchar(64);
--> statement-breakpoint
-- --- foreign keys -----------------------------------------------------------
-- Five of these are named explicitly in src/db/schema.ts because the
-- convention-generated name would exceed Postgres's 63-byte identifier limit
-- and be silently truncated, leaving this file and the database disagreeing.

DO $$ BEGIN
  ALTER TABLE "marketplace_contract_applications" ADD CONSTRAINT "marketplace_contract_applications_applicant_user_id_users_id_fk" FOREIGN KEY ("applicant_user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_contract_applications" ADD CONSTRAINT "contract_applications_contract_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."marketplace_contracts"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_contract_applications" ADD CONSTRAINT "contract_applications_applicant_company_fk" FOREIGN KEY ("applicant_company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_contracts" ADD CONSTRAINT "marketplace_contracts_issuer_company_id_companies_id_fk" FOREIGN KEY ("issuer_company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_contracts" ADD CONSTRAINT "marketplace_contracts_awarded_to_user_id_users_id_fk" FOREIGN KEY ("awarded_to_user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_contracts" ADD CONSTRAINT "marketplace_contracts_awarded_to_company_id_companies_id_fk" FOREIGN KEY ("awarded_to_company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_offers" ADD CONSTRAINT "marketplace_offers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_order_ratings" ADD CONSTRAINT "marketplace_order_ratings_order_id_marketplace_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."marketplace_orders"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_order_ratings" ADD CONSTRAINT "marketplace_order_ratings_rater_user_id_users_id_fk" FOREIGN KEY ("rater_user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_order_ratings" ADD CONSTRAINT "marketplace_order_ratings_rater_company_id_companies_id_fk" FOREIGN KEY ("rater_company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_order_ratings" ADD CONSTRAINT "marketplace_order_ratings_rated_company_id_companies_id_fk" FOREIGN KEY ("rated_company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_orders" ADD CONSTRAINT "marketplace_orders_offer_id_marketplace_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."marketplace_offers"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_orders" ADD CONSTRAINT "marketplace_orders_seller_company_id_companies_id_fk" FOREIGN KEY ("seller_company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_orders" ADD CONSTRAINT "marketplace_orders_buyer_user_id_users_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_orders" ADD CONSTRAINT "marketplace_orders_buyer_company_id_companies_id_fk" FOREIGN KEY ("buyer_company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_orders" ADD CONSTRAINT "marketplace_orders_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_wanted_requests" ADD CONSTRAINT "marketplace_wanted_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_wanted_requests" ADD CONSTRAINT "wanted_requests_requester_company_fk" FOREIGN KEY ("requester_company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_wanted_responses" ADD CONSTRAINT "marketplace_wanted_responses_responder_user_id_users_id_fk" FOREIGN KEY ("responder_user_id") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_wanted_responses" ADD CONSTRAINT "wanted_responses_request_fk" FOREIGN KEY ("request_id") REFERENCES "public"."marketplace_wanted_requests"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_wanted_responses" ADD CONSTRAINT "wanted_responses_responder_company_fk" FOREIGN KEY ("responder_company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_offer_id_marketplace_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."marketplace_offers"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
-- --- indexes ----------------------------------------------------------------
-- Deliberately narrow. Each one exists for a specific query:
--   * `*_browse_idx`      public listing, newest-first within a status
--   * `*_expiry_idx`      the retention/expiry sweep, partial so only rows
--                         that can still lapse are indexed at all
--   * `promotion_single_active_slot`
--                         NOT a lookup index — it is the DATABASE guarantee
--                         that at most one promotion campaign can ever be
--                         ACTIVE, enforced even under a race
--   * `*_unique` on (parent, party)
--                         one response/application per party per parent, and
--                         they double as the parent lookup index

CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_idx" ON "idempotency_keys" USING btree ("expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contract_application_user_unique" ON "marketplace_contract_applications" USING btree ("contract_id","applicant_user_id") WHERE "marketplace_contract_applications"."applicant_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contract_application_company_unique" ON "marketplace_contract_applications" USING btree ("contract_id","applicant_company_id") WHERE "marketplace_contract_applications"."applicant_company_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contracts_browse_idx" ON "marketplace_contracts" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contracts_issuer_idx" ON "marketplace_contracts" USING btree ("issuer_company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contracts_expiry_idx" ON "marketplace_contracts" USING btree ("expires_at") WHERE "marketplace_contracts"."status" = 'OPEN';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_offers_company_idx" ON "marketplace_offers" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_offers_browse_idx" ON "marketplace_offers" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_offers_paused_idx" ON "marketplace_offers" USING btree ("paused_at") WHERE "marketplace_offers"."status" = 'PAUSED';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ratings_rated_company_idx" ON "marketplace_order_ratings" USING btree ("rated_company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ratings_comment_expiry_idx" ON "marketplace_order_ratings" USING btree ("comment_expires_at") WHERE "marketplace_order_ratings"."comment" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_orders_offer_idx" ON "marketplace_orders" USING btree ("offer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_orders_seller_idx" ON "marketplace_orders" USING btree ("seller_company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_orders_buyer_user_idx" ON "marketplace_orders" USING btree ("buyer_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_orders_buyer_company_idx" ON "marketplace_orders" USING btree ("buyer_company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_orders_open_expiry_idx" ON "marketplace_orders" USING btree ("expires_at") WHERE "marketplace_orders"."status" IN ('PENDING', 'ACCEPTED', 'WAITING_FOR_INVOICE', 'PAYMENT_DUE');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_orders_invoice_unique" ON "marketplace_orders" USING btree ("invoice_id") WHERE "marketplace_orders"."invoice_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wanted_requests_browse_idx" ON "marketplace_wanted_requests" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wanted_requests_requester_user_idx" ON "marketplace_wanted_requests" USING btree ("requester_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wanted_requests_expiry_idx" ON "marketplace_wanted_requests" USING btree ("expires_at") WHERE "marketplace_wanted_requests"."status" = 'OPEN';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wanted_response_user_unique" ON "marketplace_wanted_responses" USING btree ("request_id","responder_user_id") WHERE "marketplace_wanted_responses"."responder_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wanted_response_company_unique" ON "marketplace_wanted_responses" USING btree ("request_id","responder_company_id") WHERE "marketplace_wanted_responses"."responder_company_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "promotion_single_active_slot" ON "promotion_campaigns" USING btree ("status") WHERE "promotion_campaigns"."status" = 'ACTIVE';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotion_campaigns_company_idx" ON "promotion_campaigns" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotion_campaigns_status_idx" ON "promotion_campaigns" USING btree ("status","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reconciliation_status_singleton_unique" ON "reconciliation_status" USING btree ("singleton");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tax_matrix_combo_unique" ON "tax_matrix" USING btree ("payer_type","recipient_type","context");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "invoices" ADD CONSTRAINT "invoices_recipient_company_id_companies_id_fk" FOREIGN KEY ("recipient_company_id") REFERENCES "public"."companies"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "invoices" ADD CONSTRAINT "invoices_source_order_id_marketplace_orders_id_fk" FOREIGN KEY ("source_order_id") REFERENCES "public"."marketplace_orders"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reverses_transaction_id_transactions_id_fk" FOREIGN KEY ("reverses_transaction_id") REFERENCES "public"."transactions"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_source_order_unique" ON "invoices" USING btree ("source_order_id") WHERE "invoices"."source_order_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_reverses_idx" ON "transactions" USING btree ("reverses_transaction_id") WHERE "transactions"."reverses_transaction_id" IS NOT NULL;
--> statement-breakpoint
-- --- check constraints on existing tables -----------------------------------
-- Guarded drop/add so re-running this file is a safe no-op, exactly like 0004.
-- Every existing invoice row satisfies the USER branch of
-- `invoices_recipient_consistent` unchanged: recipient_type defaults to 'USER'
-- and buyer_user_id is already populated on every one of them.

ALTER TABLE "government" DROP CONSTRAINT IF EXISTS "government_promotion_daily_rate_bounds";
--> statement-breakpoint
ALTER TABLE "government" ADD CONSTRAINT "government_promotion_daily_rate_bounds" CHECK ("government"."promotion_daily_rate" >= 0 AND "government"."promotion_daily_rate" <= 1000000);
--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_recipient_consistent";
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_recipient_consistent" CHECK (("invoices"."recipient_type" = 'USER' AND "invoices"."buyer_user_id" IS NOT NULL AND "invoices"."recipient_company_id" IS NULL)
     OR ("invoices"."recipient_type" = 'COMPANY' AND "invoices"."recipient_company_id" IS NOT NULL AND "invoices"."buyer_user_id" IS NULL)
     OR ("invoices"."recipient_type" = 'GOVERNMENT' AND "invoices"."buyer_user_id" IS NULL AND "invoices"."recipient_company_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_reversal_not_self";
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reversal_not_self" CHECK ("transactions"."reverses_transaction_id" IS NULL OR "transactions"."reverses_transaction_id" <> "transactions"."id");
--> statement-breakpoint

-- ===========================================================================
-- PART 2 (continued) — Phase C/D additions
-- ===========================================================================
-- Added while building Phases C–E, in the same PART and the same idempotent
-- style, because Phase A shipped the contract table with no link to the
-- invoice that settles it and the orders table with no database-level
-- duplicate-order rule. Both are additive; re-running this block is a no-op.

ALTER TABLE "marketplace_contracts" ADD COLUMN IF NOT EXISTS "invoice_id" uuid;
--> statement-breakpoint
ALTER TABLE "marketplace_contracts" ADD COLUMN IF NOT EXISTS "paid_tx_ref" varchar(32);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketplace_contracts" ADD CONSTRAINT "marketplace_contracts_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contract_invoice_unique" ON "marketplace_contracts" USING btree ("invoice_id") WHERE "marketplace_contracts"."invoice_id" IS NOT NULL;
--> statement-breakpoint
-- NO DUPLICATE ORDERS: at most one UNSETTLED order per buyer per offer. The
-- partial predicate deliberately excludes PAID/COMPLETED/CANCELLED/EXPIRED, so
-- a buyer may order the same offer again once the previous order is settled.
CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_order_open_user_unique" ON "marketplace_orders" USING btree ("offer_id","buyer_user_id") WHERE "marketplace_orders"."buyer_user_id" IS NOT NULL AND "marketplace_orders"."status" IN ('PENDING', 'ACCEPTED', 'WAITING_FOR_INVOICE', 'PAYMENT_DUE');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_order_open_company_unique" ON "marketplace_orders" USING btree ("offer_id","buyer_company_id") WHERE "marketplace_orders"."buyer_company_id" IS NOT NULL AND "marketplace_orders"."status" IN ('PENDING', 'ACCEPTED', 'WAITING_FOR_INVOICE', 'PAYMENT_DUE');
--> statement-breakpoint

-- ===========================================================================
-- PART 2 (continued) — Phase F addition
-- ===========================================================================
-- The leaderboard (spec §23) is a ROLLING 30-DAY WINDOW computed live: there is
-- no leaderboard table, no daily snapshot row and no analytics row to read
-- instead, so this window scan is the entire storage cost of the feature. The
-- index is partial on COMPLETED and holds only `completed_at`, which is exactly
-- what src/lib/leaderboard.ts filters on. Additive and idempotent, like
-- everything above it.

CREATE INDEX IF NOT EXISTS "marketplace_orders_completed_idx" ON "marketplace_orders" USING btree ("completed_at") WHERE "marketplace_orders"."status" = 'COMPLETED';

--> statement-breakpoint

-- ===========================================================================
-- PART 2 (continued) — Phase I addition
-- ===========================================================================
-- The retention engine (spec §§31,36,37,58) needs a configurable period for
-- the last two temporary V3 classes Phase A did not name, plus a column that
-- records when cleanup last SUCCEEDED rather than merely ran. Additive and
-- idempotent, like everything above it; a DEFAULT applies to future inserts
-- only, so the live singleton row keeps whatever it already holds and the
-- engine falls back to the same numbers in code.

ALTER TABLE "retention_settings" ADD COLUMN IF NOT EXISTS "expired_contract_retention_days" integer DEFAULT 30;
--> statement-breakpoint
ALTER TABLE "retention_settings" ADD COLUMN IF NOT EXISTS "promotion_campaign_retention_days" integer DEFAULT 90;
--> statement-breakpoint
ALTER TABLE "retention_settings" ADD COLUMN IF NOT EXISTS "last_cleanup_success_at" timestamp with time zone;
--> statement-breakpoint
-- Cleanup sweeps "applications against a contract that closed long enough
-- ago". The application side of that join is driven by contract_id, which had
-- no index of its own (the two partial unique indexes lead with contract_id
-- but are restricted to a non-null applicant column, so neither serves a plain
-- "all applications for this contract" probe).
CREATE INDEX IF NOT EXISTS "contract_applications_contract_idx" ON "marketplace_contract_applications" USING btree ("contract_id");
--> statement-breakpoint
-- Cleanup sweeps "terminal contracts older than the cutoff" to find those
-- applications. contracts_browse_idx leads with status and is not partial, so
-- it already serves this; no second index is added for it.
-- Cleanup also sweeps "terminal, never-charged promotion campaigns", which
-- promotion_campaigns_status_idx (status, created_at) already serves.
CREATE INDEX IF NOT EXISTS "wanted_responses_request_idx" ON "marketplace_wanted_responses" USING btree ("request_id");
