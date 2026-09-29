-- ===========================================================================
-- AEROS PAY V3 — PWA OFFLINE PAYMENTS (spec: offline shell + offline auth)
-- ===========================================================================
-- Adds the Government-controlled offline-transaction allowance policy onto
-- `government` (same additive-columns pattern as the loan/sale/economy policy
-- blocks already on that table), a per-user lifetime "offline allowance
-- spent" counter on `users`, and one new table — `offline_auth_tokens` — that
-- tracks how much of each issued offline authorization has actually been
-- consumed by a synced payment.
--
-- Strictly ADDITIVE and IDEMPOTENT, exactly like 0004: no new enum types, no
-- dropped or rewritten columns, every statement guarded so running this file
-- twice (or resuming after a partial failure) is a harmless no-op. Safe to
-- run start to finish in one go — no PART split needed.
-- ===========================================================================

-- --- new table: one row per issued offline authorization --------------------

CREATE TABLE IF NOT EXISTS "offline_auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"allowance_at_issue" integer NOT NULL,
	"per_transaction_max" integer NOT NULL,
	"consumed_amount" integer DEFAULT 0 NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint

ALTER TABLE "offline_auth_tokens" DROP CONSTRAINT IF EXISTS "offline_auth_tokens_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "offline_auth_tokens" ADD CONSTRAINT "offline_auth_tokens_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "offline_auth_tokens_user_idx" ON "offline_auth_tokens" USING btree ("user_id");
--> statement-breakpoint

ALTER TABLE "offline_auth_tokens" DROP CONSTRAINT IF EXISTS "offline_auth_tokens_allowance_nonnegative";
--> statement-breakpoint
ALTER TABLE "offline_auth_tokens" ADD CONSTRAINT "offline_auth_tokens_allowance_nonnegative"
  CHECK ("allowance_at_issue" >= 0);
--> statement-breakpoint

ALTER TABLE "offline_auth_tokens" DROP CONSTRAINT IF EXISTS "offline_auth_tokens_per_tx_max_positive";
--> statement-breakpoint
ALTER TABLE "offline_auth_tokens" ADD CONSTRAINT "offline_auth_tokens_per_tx_max_positive"
  CHECK ("per_transaction_max" >= 1);
--> statement-breakpoint

ALTER TABLE "offline_auth_tokens" DROP CONSTRAINT IF EXISTS "offline_auth_tokens_consumed_nonnegative";
--> statement-breakpoint
ALTER TABLE "offline_auth_tokens" ADD CONSTRAINT "offline_auth_tokens_consumed_nonnegative"
  CHECK ("consumed_amount" >= 0);
--> statement-breakpoint

-- THE structural guarantee: no row in this table can ever record more spent
-- against a token than that token was ever authorized for, enforced by
-- Postgres itself — see the comment on `offlineAuthTokens` in src/db/schema.ts.
ALTER TABLE "offline_auth_tokens" DROP CONSTRAINT IF EXISTS "offline_auth_tokens_consumed_within_allowance";
--> statement-breakpoint
ALTER TABLE "offline_auth_tokens" ADD CONSTRAINT "offline_auth_tokens_consumed_within_allowance"
  CHECK ("consumed_amount" <= "allowance_at_issue");
--> statement-breakpoint

-- --- offline-allowance policy on `government` -------------------------------

ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "offline_transactions_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "offline_total_allowance" integer DEFAULT 2000 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "offline_max_per_transaction" integer DEFAULT 500 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "offline_auth_expiry_minutes" integer;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "offline_policy_updated_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "government" DROP CONSTRAINT IF EXISTS "government_offline_total_allowance_bounds";
--> statement-breakpoint
ALTER TABLE "government" ADD CONSTRAINT "government_offline_total_allowance_bounds"
  CHECK ("offline_total_allowance" >= 0 AND "offline_total_allowance" <= 1000000);
--> statement-breakpoint

ALTER TABLE "government" DROP CONSTRAINT IF EXISTS "government_offline_max_per_transaction_bounds";
--> statement-breakpoint
ALTER TABLE "government" ADD CONSTRAINT "government_offline_max_per_transaction_bounds"
  CHECK ("offline_max_per_transaction" >= 1 AND "offline_max_per_transaction" <= 1000000);
--> statement-breakpoint

ALTER TABLE "government" DROP CONSTRAINT IF EXISTS "government_offline_auth_expiry_bounds";
--> statement-breakpoint
ALTER TABLE "government" ADD CONSTRAINT "government_offline_auth_expiry_bounds"
  CHECK ("offline_auth_expiry_minutes" IS NULL OR ("offline_auth_expiry_minutes" >= 1 AND "offline_auth_expiry_minutes" <= 43200));
--> statement-breakpoint

-- --- lifetime offline-allowance-spent counter on `users` --------------------

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "offline_allowance_used" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_offline_allowance_used_nonnegative";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_offline_allowance_used_nonnegative"
  CHECK ("offline_allowance_used" >= 0);
