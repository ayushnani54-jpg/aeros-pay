-- ===========================================================================
-- AEROS PAY — GOVERNMENT-SET LIMIT ON COMPANIES PER PERSON
-- ===========================================================================
-- One purely additive change: the Government can now choose how many
-- companies one person may own at the same time (before, the app simply never
-- showed a second "Create company" form).
--
--   * max_companies_per_user  (default 1 = exactly the behaviour that existed
--     before this migration, so nothing changes until the Government raises it)
--
-- Strictly ADDITIVE and IDEMPOTENT, exactly like 0004/0006: safe to run
-- start to finish in one go, and safe to run again as a no-op. Nothing is
-- deleted or rewritten; no balance, ledger row or password is touched.
-- ===========================================================================

ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "max_companies_per_user" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "max_companies_per_user_updated_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "government" DROP CONSTRAINT IF EXISTS "government_max_companies_per_user_bounds";
--> statement-breakpoint
ALTER TABLE "government" ADD CONSTRAINT "government_max_companies_per_user_bounds"
  CHECK ("max_companies_per_user" >= 1 AND "max_companies_per_user" <= 100);
