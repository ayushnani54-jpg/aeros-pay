-- ===========================================================================
-- AEROS PAY V2.1 — CONFIGURABLE POLICY + TEXT-FIELD SCRUBBING
-- ===========================================================================
-- Two independent, purely additive changes:
--
-- 1. Moves three previously-hardcoded TypeScript constants onto the
--    `government` row so the Government can edit them at runtime, following
--    the exact same shape as tax_rate_bp / sale_multiplier_bp / loan policy:
--      * company_approval_funding_amount (was COMPANY_APPROVAL_FUNDING_AMOUNT = 5000, now 3000)
--      * max_issuance_amount             (was MAX_ISSUANCE_AMOUNT = 5000, now 10000)
--      * issuance_cooldown_days          (was ISSUANCE_COOLDOWN_DAYS = 7, now 1 —
--        and its meaning changed from a rolling N×24h cooldown to "N India
--        Standard Time calendar days since the last execution"; see
--        src/lib/issuance.ts)
--
-- 2. Adds Government-configurable ages for TEXT-FIELD SCRUBBING on
--    retention_settings — a capability separate from (and additive to) the
--    existing disposable-row deletion columns already on this table. Scrubbing
--    never deletes a row and never touches an amount, party, id, status or
--    timestamp column; it only blanks specific free-text columns (a
--    transaction's `reason`, an invoice's description/note, a loan's
--    purpose/rejection/default/restructure text, an issuance request's
--    `note`) once the row is older than the configured age. NULL means never
--    scrub that class. See src/lib/retention.ts for exactly which columns
--    each class covers.
--
-- Strictly ADDITIVE and IDEMPOTENT, exactly like 0002/0003. No new enum
-- types are introduced, so unlike 0002/0003 this file does not need a
-- PART 1 / PART 2 split — it is safe to run start to finish in one go, and
-- safe to run again as a no-op.
-- ===========================================================================

-- --- configurable policy on `government` -----------------------------------

ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "company_approval_funding_amount" integer DEFAULT 3000 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "company_approval_funding_updated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "max_issuance_amount" integer DEFAULT 10000 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "max_issuance_amount_updated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "issuance_cooldown_days" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "issuance_cooldown_updated_at" timestamp with time zone;
--> statement-breakpoint

-- --- bounding CHECK constraints on the new columns -------------------------
-- Guarded drop/add so re-running this file is a safe no-op.

ALTER TABLE "government" DROP CONSTRAINT IF EXISTS "government_company_approval_funding_bounds";
--> statement-breakpoint
ALTER TABLE "government" ADD CONSTRAINT "government_company_approval_funding_bounds"
  CHECK ("company_approval_funding_amount" >= 0 AND "company_approval_funding_amount" <= 1000000);
--> statement-breakpoint

ALTER TABLE "government" DROP CONSTRAINT IF EXISTS "government_max_issuance_amount_bounds";
--> statement-breakpoint
ALTER TABLE "government" ADD CONSTRAINT "government_max_issuance_amount_bounds"
  CHECK ("max_issuance_amount" >= 1 AND "max_issuance_amount" <= 1000000);
--> statement-breakpoint

ALTER TABLE "government" DROP CONSTRAINT IF EXISTS "government_issuance_cooldown_bounds";
--> statement-breakpoint
ALTER TABLE "government" ADD CONSTRAINT "government_issuance_cooldown_bounds"
  CHECK ("issuance_cooldown_days" >= 0 AND "issuance_cooldown_days" <= 365);
--> statement-breakpoint

-- --- loosen the old hardcoded ceiling on issuance_requests.amount ----------
-- The real, Government-configurable limit now lives in application logic
-- (src/lib/issuance.ts, reading government.max_issuance_amount). This
-- constraint becomes a generous sanity ceiling only — defense-in-depth, not
-- the source of truth, same as the tax-rate check.

ALTER TABLE "issuance_requests" DROP CONSTRAINT IF EXISTS "issuance_amount_bounds";
--> statement-breakpoint
ALTER TABLE "issuance_requests" ADD CONSTRAINT "issuance_amount_bounds"
  CHECK ("amount" >= 1 AND "amount" <= 1000000);
--> statement-breakpoint

-- --- text-field scrubbing settings on `retention_settings` -----------------

ALTER TABLE "retention_settings" ADD COLUMN IF NOT EXISTS "transaction_reason_max_age_days" integer;
--> statement-breakpoint
ALTER TABLE "retention_settings" ADD COLUMN IF NOT EXISTS "invoice_text_max_age_days" integer;
--> statement-breakpoint
ALTER TABLE "retention_settings" ADD COLUMN IF NOT EXISTS "loan_text_max_age_days" integer;
--> statement-breakpoint
ALTER TABLE "retention_settings" ADD COLUMN IF NOT EXISTS "issuance_note_max_age_days" integer;
--> statement-breakpoint
ALTER TABLE "retention_settings" ADD COLUMN IF NOT EXISTS "last_scrub_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "retention_settings" ADD COLUMN IF NOT EXISTS "last_scrub_summary" jsonb;
