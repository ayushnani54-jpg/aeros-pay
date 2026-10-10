-- ===========================================================================
-- AEROS PAY V4 — EXCHANGE, INTERNAL SYNTHETIC MARKET, TRADING, REFUND CENTER,
--                GOVERNMENT FEATURE CONTROLS, ARCHIVE CENTER & ACCOUNTING
--                PRESERVATION
-- ===========================================================================
-- Strictly ADDITIVE and IDEMPOTENT:
--   * Creates new enum types, extends tx_type, adds V4 columns with safe
--     defaults, creates V4 tables, constraints, sequences, and indexes.
--   * Never DROPs a table or column, never TRUNCATEs, never rewrites or
--     deletes existing V1–V3 rows or balances.
--   * Safe to run via `npm run db:migrate` or in the Neon SQL Editor.
--   * If running manually in the Neon SQL Editor inside a transaction block,
--     run PART 1 first, then PART 2.
-- ===========================================================================

-- ===========================================================================
-- PART 1 — Enum types and new tx_type values
-- ===========================================================================

DO $$ BEGIN
  CREATE TYPE "public"."exchange_purchase_status" AS ENUM('AWAITING_CONFIRMATION', 'CREDITED', 'CANCELLED', 'REFUNDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."market_order_side" AS ENUM('BUY', 'SELL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."market_order_status" AS ENUM('EXECUTED', 'REJECTED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."refund_status" AS ENUM('PENDING', 'UNDER_REVIEW', 'DELAYED', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."refund_type" AS ENUM('VIRTUAL_AEROS_REFUND', 'EXCHANGE_PACKAGE_REFUND');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."archive_batch_status" AS ENUM('CREATED', 'DOWNLOADED', 'VERIFIED', 'CLEARED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'EXCHANGE_PURCHASE';
--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'MARKET_TRADE_BUY';
--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'MARKET_TRADE_SELL';
--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'REFUND_CREDIT';
--> statement-breakpoint
ALTER TYPE "public"."tx_type" ADD VALUE IF NOT EXISTS 'REFUND_DEBIT';
--> statement-breakpoint

-- ===========================================================================
-- PART 2 — Sequences, additive columns, V4 tables, constraints, and indexes
-- ===========================================================================

CREATE SEQUENCE IF NOT EXISTS "public"."exchange_purchase_number_seq" START WITH 1 INCREMENT BY 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."market_order_number_seq" START WITH 1 INCREMENT BY 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."refund_request_number_seq" START WITH 1 INCREMENT BY 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."archive_batch_number_seq" START WITH 1 INCREMENT BY 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."accounting_checkpoint_number_seq" START WITH 1 INCREMENT BY 1;
--> statement-breakpoint

-- --- Additive V4 columns on government -------------------------------------

ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "exchange_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "exchange_live_payments_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "market_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "trading_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "refund_center_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "retention_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "archive_center_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "v4_features_updated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "retired_supply" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "archived_credits" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "archived_debits" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "archived_tax_collected" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "archived_tx_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

ALTER TABLE "government" DROP CONSTRAINT IF EXISTS "government_retired_supply_nonnegative";
--> statement-breakpoint
ALTER TABLE "government" ADD CONSTRAINT "government_retired_supply_nonnegative" CHECK ("retired_supply" >= 0);
--> statement-breakpoint
ALTER TABLE "government" DROP CONSTRAINT IF EXISTS "government_archived_credits_nonnegative";
--> statement-breakpoint
ALTER TABLE "government" ADD CONSTRAINT "government_archived_credits_nonnegative" CHECK ("archived_credits" >= 0);
--> statement-breakpoint
ALTER TABLE "government" DROP CONSTRAINT IF EXISTS "government_archived_debits_nonnegative";
--> statement-breakpoint
ALTER TABLE "government" ADD CONSTRAINT "government_archived_debits_nonnegative" CHECK ("archived_debits" >= 0);
--> statement-breakpoint
ALTER TABLE "government" DROP CONSTRAINT IF EXISTS "government_archived_tax_nonnegative";
--> statement-breakpoint
ALTER TABLE "government" ADD CONSTRAINT "government_archived_tax_nonnegative" CHECK ("archived_tax_collected" >= 0);
--> statement-breakpoint
ALTER TABLE "government" DROP CONSTRAINT IF EXISTS "government_archived_tx_count_nonnegative";
--> statement-breakpoint
ALTER TABLE "government" ADD CONSTRAINT "government_archived_tx_count_nonnegative" CHECK ("archived_tx_count" >= 0);
--> statement-breakpoint

-- --- Additive V4 columns on users ------------------------------------------

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "archived_credits" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "archived_debits" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "archived_tx_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_archived_credits_nonnegative";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_archived_credits_nonnegative" CHECK ("archived_credits" >= 0);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_archived_debits_nonnegative";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_archived_debits_nonnegative" CHECK ("archived_debits" >= 0);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_archived_tx_count_nonnegative";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_archived_tx_count_nonnegative" CHECK ("archived_tx_count" >= 0);
--> statement-breakpoint

-- --- Additive V4 columns on companies --------------------------------------

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "archived_credits" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "archived_debits" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "archived_tx_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "archived_sales_net" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

ALTER TABLE "companies" DROP CONSTRAINT IF EXISTS "companies_archived_credits_nonnegative";
--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_archived_credits_nonnegative" CHECK ("archived_credits" >= 0);
--> statement-breakpoint
ALTER TABLE "companies" DROP CONSTRAINT IF EXISTS "companies_archived_debits_nonnegative";
--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_archived_debits_nonnegative" CHECK ("archived_debits" >= 0);
--> statement-breakpoint
ALTER TABLE "companies" DROP CONSTRAINT IF EXISTS "companies_archived_tx_count_nonnegative";
--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_archived_tx_count_nonnegative" CHECK ("archived_tx_count" >= 0);
--> statement-breakpoint
ALTER TABLE "companies" DROP CONSTRAINT IF EXISTS "companies_archived_sales_net_nonnegative";
--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_archived_sales_net_nonnegative" CHECK ("archived_sales_net" >= 0);
--> statement-breakpoint

-- --- Additive V4 columns on retention_settings -----------------------------

ALTER TABLE "retention_settings" ADD COLUMN IF NOT EXISTS "transaction_history_retention_days" integer;
--> statement-breakpoint
ALTER TABLE "retention_settings" ADD COLUMN IF NOT EXISTS "settled_order_history_retention_days" integer;
--> statement-breakpoint
ALTER TABLE "retention_settings" ADD COLUMN IF NOT EXISTS "closed_refund_retention_days" integer;
--> statement-breakpoint
ALTER TABLE "retention_settings" ADD COLUMN IF NOT EXISTS "market_candle_retention_days" integer DEFAULT 90;
--> statement-breakpoint

-- --- Table: exchange_package_policies --------------------------------------

CREATE TABLE IF NOT EXISTS "exchange_package_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "policy_code" varchar(32) NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "title" varchar(120) NOT NULL,
  "description" text,
  "inr_price" integer NOT NULL,
  "aeros_amount" integer NOT NULL,
  "bonus_aeros" integer DEFAULT 0 NOT NULL,
  "total_aeros" integer NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "disclosure_text" text NOT NULL,
  "created_by_gov_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "superseded_at" timestamp with time zone,
  CONSTRAINT "exchange_policy_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "exchange_policy_inr_positive" CHECK ("inr_price" >= 1),
  CONSTRAINT "exchange_policy_aeros_positive" CHECK ("aeros_amount" >= 1),
  CONSTRAINT "exchange_policy_bonus_nonnegative" CHECK ("bonus_aeros" >= 0),
  CONSTRAINT "exchange_policy_total_consistent" CHECK ("total_aeros" = "aeros_amount" + "bonus_aeros" AND "total_aeros" >= 1)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "exchange_policy_code_version_unique" ON "exchange_package_policies" ("policy_code", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exchange_policy_active_idx" ON "exchange_package_policies" ("active", "policy_code");
--> statement-breakpoint

-- --- Table: exchange_purchases ---------------------------------------------

CREATE TABLE IF NOT EXISTS "exchange_purchases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "purchase_number" varchar(24) NOT NULL UNIQUE,
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "policy_id" uuid NOT NULL REFERENCES "exchange_package_policies"("id"),
  "policy_code_snapshot" varchar(32) NOT NULL,
  "policy_version_snapshot" integer NOT NULL,
  "package_title_snapshot" varchar(120) NOT NULL,
  "inr_price_snapshot" integer NOT NULL,
  "aeros_amount_snapshot" integer NOT NULL,
  "bonus_aeros_snapshot" integer DEFAULT 0 NOT NULL,
  "total_aeros_snapshot" integer NOT NULL,
  "disclosure_snapshot" text NOT NULL,
  "payment_mode" varchar(40) DEFAULT 'MANUAL_GOV_CONFIRMATION' NOT NULL,
  "payment_reference" varchar(120),
  "status" "exchange_purchase_status" DEFAULT 'AWAITING_CONFIRMATION' NOT NULL,
  "credited_tx_ref" varchar(32),
  "reviewed_by_gov_id" uuid,
  "review_note" text,
  "idempotency_key" varchar(80),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "credited_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "refunded_at" timestamp with time zone,
  CONSTRAINT "exchange_purchase_inr_positive" CHECK ("inr_price_snapshot" >= 1),
  CONSTRAINT "exchange_purchase_total_positive" CHECK ("total_aeros_snapshot" >= 1),
  CONSTRAINT "exchange_purchase_credited_tx_consistent" CHECK (("status" NOT IN ('CREDITED', 'REFUNDED')) OR ("credited_tx_ref" IS NOT NULL))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "exchange_purchases_user_idx" ON "exchange_purchases" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exchange_purchases_status_idx" ON "exchange_purchases" ("status", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "exchange_purchases_idempotency_unique" ON "exchange_purchases" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint

-- --- Table: market_state ---------------------------------------------------

CREATE TABLE IF NOT EXISTS "market_state" (
  "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
  "methodology_version" varchar(32) DEFAULT 'V4-SYNTH-1.0' NOT NULL,
  "current_price" integer DEFAULT 100 NOT NULL,
  "previous_price" integer DEFAULT 100 NOT NULL,
  "open_24h_price" integer DEFAULT 100 NOT NULL,
  "high_24h_price" integer DEFAULT 100 NOT NULL,
  "low_24h_price" integer DEFAULT 100 NOT NULL,
  "min_price" integer DEFAULT 10 NOT NULL,
  "max_price" integer DEFAULT 10000 NOT NULL,
  "base_volatility_bp" integer DEFAULT 150 NOT NULL,
  "demand_sensitivity_bp" integer DEFAULT 50 NOT NULL,
  "max_step_change_bp" integer DEFAULT 500 NOT NULL,
  "max_order_units" integer DEFAULT 500 NOT NULL,
  "user_cooldown_seconds" integer DEFAULT 10 NOT NULL,
  "net_order_flow_units" integer DEFAULT 0 NOT NULL,
  "active_bucket_traders" integer DEFAULT 0 NOT NULL,
  "active_bucket_5m" timestamp with time zone DEFAULT now() NOT NULL,
  "seed_key" varchar(64) DEFAULT 'aeros-v4-synth-market-v1' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "market_state_singleton" CHECK ("id" = 1),
  CONSTRAINT "market_state_min_positive" CHECK ("min_price" >= 1),
  CONSTRAINT "market_state_bounds_valid" CHECK ("max_price" > "min_price"),
  CONSTRAINT "market_state_price_within_bounds" CHECK ("current_price" >= "min_price" AND "current_price" <= "max_price"),
  CONSTRAINT "market_state_volatility_bounds" CHECK ("base_volatility_bp" >= 10 AND "base_volatility_bp" <= 2500),
  CONSTRAINT "market_state_demand_bounds" CHECK ("demand_sensitivity_bp" >= 0 AND "demand_sensitivity_bp" <= 1000),
  CONSTRAINT "market_state_step_cap_bounds" CHECK ("max_step_change_bp" >= 25 AND "max_step_change_bp" <= 3000),
  CONSTRAINT "market_state_max_order_positive" CHECK ("max_order_units" >= 1),
  CONSTRAINT "market_state_cooldown_nonnegative" CHECK ("user_cooldown_seconds" >= 0)
);
--> statement-breakpoint

-- --- Table: market_candles -------------------------------------------------

CREATE TABLE IF NOT EXISTS "market_candles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "timeframe" varchar(8) NOT NULL,
  "bucket_start" timestamp with time zone NOT NULL,
  "open_price" integer NOT NULL,
  "high_price" integer NOT NULL,
  "low_price" integer NOT NULL,
  "close_price" integer NOT NULL,
  "volume_units" integer DEFAULT 0 NOT NULL,
  "volume_aeros" integer DEFAULT 0 NOT NULL,
  "trade_count" integer DEFAULT 0 NOT NULL,
  "buy_units" integer DEFAULT 0 NOT NULL,
  "sell_units" integer DEFAULT 0 NOT NULL,
  "is_high_volatility" boolean DEFAULT false NOT NULL,
  "methodology_version" varchar(32) DEFAULT 'V4-SYNTH-1.0' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "market_candles_timeframe_valid" CHECK ("timeframe" IN ('5m', '15m', '1h')),
  CONSTRAINT "market_candles_prices_positive" CHECK ("open_price" >= 1 AND "low_price" >= 1 AND "close_price" >= 1),
  CONSTRAINT "market_candles_ohlc_consistent" CHECK ("high_price" >= "open_price" AND "high_price" >= "close_price" AND "high_price" >= "low_price" AND "low_price" <= "open_price" AND "low_price" <= "close_price"),
  CONSTRAINT "market_candles_volume_nonnegative" CHECK ("volume_units" >= 0 AND "volume_aeros" >= 0 AND "trade_count" >= 0 AND "buy_units" >= 0 AND "sell_units" >= 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "market_candles_tf_bucket_unique" ON "market_candles" ("timeframe", "bucket_start");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "market_candles_tf_bucket_idx" ON "market_candles" ("timeframe", "bucket_start");
--> statement-breakpoint

-- --- Table: market_positions -----------------------------------------------

CREATE TABLE IF NOT EXISTS "market_positions" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") NOT NULL,
  "units_held" integer DEFAULT 0 NOT NULL,
  "total_cost_basis" integer DEFAULT 0 NOT NULL,
  "realized_pnl" integer DEFAULT 0 NOT NULL,
  "total_bought_units" integer DEFAULT 0 NOT NULL,
  "total_sold_units" integer DEFAULT 0 NOT NULL,
  "last_trade_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "market_positions_units_nonnegative" CHECK ("units_held" >= 0),
  CONSTRAINT "market_positions_cost_nonnegative" CHECK ("total_cost_basis" >= 0),
  CONSTRAINT "market_positions_zero_units_zero_cost" CHECK (("units_held" > 0) OR ("total_cost_basis" = 0))
);
--> statement-breakpoint

-- --- Table: market_orders --------------------------------------------------

CREATE TABLE IF NOT EXISTS "market_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_number" varchar(24) NOT NULL UNIQUE,
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "side" "market_order_side" NOT NULL,
  "quantity" integer NOT NULL,
  "expected_price" integer NOT NULL,
  "max_slippage_bp" integer DEFAULT 200 NOT NULL,
  "execution_price" integer NOT NULL,
  "total_aeros" integer NOT NULL,
  "cost_basis_delta" integer DEFAULT 0 NOT NULL,
  "realized_pnl_delta" integer DEFAULT 0 NOT NULL,
  "status" "market_order_status" DEFAULT 'EXECUTED' NOT NULL,
  "rejection_reason" text,
  "tx_ref" varchar(32),
  "idempotency_key" varchar(80),
  "methodology_version" varchar(32) DEFAULT 'V4-SYNTH-1.0' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "market_orders_quantity_positive" CHECK ("quantity" >= 1),
  CONSTRAINT "market_orders_expected_positive" CHECK ("expected_price" >= 1),
  CONSTRAINT "market_orders_exec_positive" CHECK ("execution_price" >= 1),
  CONSTRAINT "market_orders_total_consistent" CHECK ("total_aeros" = "quantity" * "execution_price" AND "total_aeros" >= 1),
  CONSTRAINT "market_orders_executed_has_tx" CHECK (("status" <> 'EXECUTED') OR ("tx_ref" IS NOT NULL))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "market_orders_user_idx" ON "market_orders" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "market_orders_created_idx" ON "market_orders" ("created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "market_orders_idempotency_unique" ON "market_orders" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint

-- --- Table: refund_requests ------------------------------------------------

CREATE TABLE IF NOT EXISTS "refund_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "refund_number" varchar(24) NOT NULL UNIQUE,
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "refund_type" "refund_type" DEFAULT 'VIRTUAL_AEROS_REFUND' NOT NULL,
  "source_tx_ref" varchar(32),
  "exchange_purchase_id" uuid REFERENCES "exchange_purchases"("id"),
  "requested_aeros_amount" integer NOT NULL,
  "approved_aeros_amount" integer,
  "inr_reference_amount" integer,
  "reason" text NOT NULL,
  "user_notes" text,
  "status" "refund_status" DEFAULT 'PENDING' NOT NULL,
  "government_decision_note" text,
  "delay_reason" text,
  "expected_resolution_at" timestamp with time zone,
  "settlement_tx_ref" varchar(32),
  "reviewed_by_gov_id" uuid,
  "idempotency_key" varchar(80),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "rejected_at" timestamp with time zone,
  CONSTRAINT "refund_requested_positive" CHECK ("requested_aeros_amount" >= 1),
  CONSTRAINT "refund_approved_nonnegative" CHECK ("approved_aeros_amount" IS NULL OR "approved_aeros_amount" >= 0)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "refund_requests_user_idx" ON "refund_requests" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refund_requests_status_idx" ON "refund_requests" ("status", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "refund_requests_idempotency_unique" ON "refund_requests" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint

-- --- Table: archive_batches ------------------------------------------------

CREATE TABLE IF NOT EXISTS "archive_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "batch_number" varchar(24) NOT NULL UNIQUE,
  "dataset_key" varchar(48) NOT NULL,
  "archive_version" varchar(16) DEFAULT 'V4.0' NOT NULL,
  "schema_version" varchar(16) DEFAULT '0008' NOT NULL,
  "cutoff_date" timestamp with time zone NOT NULL,
  "period_start" timestamp with time zone,
  "period_end" timestamp with time zone,
  "record_count" integer NOT NULL,
  "sha256_checksum" varchar(64) NOT NULL,
  "verification_token" varchar(32) NOT NULL,
  "manifest_json" jsonb NOT NULL,
  "record_ids_json" jsonb NOT NULL,
  "zip_payload_base64" text NOT NULL,
  "byte_size" integer NOT NULL,
  "status" "archive_batch_status" DEFAULT 'CREATED' NOT NULL,
  "created_by_gov_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "downloaded_at" timestamp with time zone,
  "verified_at" timestamp with time zone,
  "cleared_at" timestamp with time zone,
  "cleared_record_count" integer,
  CONSTRAINT "archive_batch_record_count_nonnegative" CHECK ("record_count" >= 0),
  CONSTRAINT "archive_batch_byte_size_positive" CHECK ("byte_size" >= 1)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "archive_batches_dataset_idx" ON "archive_batches" ("dataset_key", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "archive_batches_status_idx" ON "archive_batches" ("status", "created_at");
--> statement-breakpoint

-- --- Table: accounting_checkpoints -----------------------------------------

CREATE TABLE IF NOT EXISTS "accounting_checkpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "checkpoint_number" varchar(24) NOT NULL UNIQUE,
  "archive_batch_id" uuid NOT NULL UNIQUE REFERENCES "archive_batches"("id"),
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "cleared_tx_count" integer NOT NULL,
  "gross_volume_cleared" integer NOT NULL,
  "tax_volume_cleared" integer NOT NULL,
  "net_volume_cleared" integer NOT NULL,
  "total_supply_snapshot" integer NOT NULL,
  "retired_supply_snapshot" integer DEFAULT 0 NOT NULL,
  "treasury_balance_snapshot" integer NOT NULL,
  "user_held_balance_snapshot" integer NOT NULL,
  "company_held_balance_snapshot" integer NOT NULL,
  "wallet_rollups_json" jsonb NOT NULL,
  "checkpoint_hash" varchar(64) NOT NULL,
  "created_by_gov_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "accounting_checkpoint_tx_count_positive" CHECK ("cleared_tx_count" >= 1),
  CONSTRAINT "accounting_checkpoint_gross_nonnegative" CHECK ("gross_volume_cleared" >= 0),
  CONSTRAINT "accounting_checkpoint_tax_nonnegative" CHECK ("tax_volume_cleared" >= 0),
  CONSTRAINT "accounting_checkpoint_net_nonnegative" CHECK ("net_volume_cleared" >= 0),
  CONSTRAINT "accounting_checkpoint_supply_balanced" CHECK ("treasury_balance_snapshot" + "user_held_balance_snapshot" + "company_held_balance_snapshot" + "retired_supply_snapshot" = "total_supply_snapshot")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "accounting_checkpoints_created_idx" ON "accounting_checkpoints" ("created_at");
--> statement-breakpoint

-- --- Seed singleton market_state & initial Exchange package policies -------

INSERT INTO "market_state" ("id", "methodology_version", "current_price", "previous_price", "open_24h_price", "high_24h_price", "low_24h_price", "min_price", "max_price")
VALUES (1, 'V4-SYNTH-1.0', 100, 100, 100, 100, 100, 10, 10000)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "exchange_package_policies" ("policy_code", "version", "title", "description", "inr_price", "aeros_amount", "bonus_aeros", "total_aeros", "active", "disclosure_text")
VALUES
  (
    'PKG-STARTER',
    1,
    'Starter Aeros Pack',
    'Entry package for acquiring virtual Aeros from the Government Treasury.',
    99,
    500,
    0,
    500,
    true,
    'Aeros is a private virtual-economy unit used solely inside Aeros Pay. It is not legal tender, not a cryptocurrency, and not guaranteed to be redeemable for INR.'
  ),
  (
    'PKG-STANDARD',
    1,
    'Standard Aeros Pack',
    'Mid-size package with a Government-set bonus allocation.',
    249,
    1300,
    100,
    1400,
    true,
    'Aeros is a private virtual-economy unit used solely inside Aeros Pay. It is not legal tender, not a cryptocurrency, and not guaranteed to be redeemable for INR.'
  ),
  (
    'PKG-ENTERPRISE',
    1,
    'Enterprise Aeros Pack',
    'High-allocation virtual Aeros package for active citizens and company founders.',
    499,
    2700,
    300,
    3000,
    true,
    'Aeros is a private virtual-economy unit used solely inside Aeros Pay. It is not legal tender, not a cryptocurrency, and not guaranteed to be redeemable for INR.'
  )
ON CONFLICT ("policy_code", "version") DO NOTHING;
