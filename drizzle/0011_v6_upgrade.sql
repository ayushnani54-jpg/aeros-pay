-- =============================================================================
-- AEROS PAY V6 UPGRADE MIGRATION (0011_v6_upgrade.sql)
-- =============================================================================
-- Additive, reversible & idempotent migration for Neon PostgreSQL:
-- 1. Adds auth_email, access_level, phone and privacy fields to users table.
-- 2. Adds access_path_code and support_email to government table.
-- 3. Creates email_verification_codes table (8-digit, 10m expiry, hashed).
-- 4. Creates government_activation_codes table (6-digit, 24h expiry, hashed).
-- 5. Creates platform_feature_flags central registry (disabling exchange and trading).
-- 6. Creates government_public_content table for community and official links.
-- 7. Creates support_requests outbox table for Web3Forms support requests.
-- =============================================================================

-- 1. Safe Columns on users table
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_email" varchar(255);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_email_verified" boolean DEFAULT false NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_email_verified_at" timestamp with time zone;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "public_contact_email" varchar(255);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone_number" varchar(32);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone_verified" boolean DEFAULT false NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone_verified_at" timestamp with time zone;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "whatsapp_consent" boolean DEFAULT false NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "whatsapp_consent_at" timestamp with time zone;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone_reminder_last_dismissed_at" timestamp with time zone;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone_reminder_opt_out" boolean DEFAULT false NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "access_level" varchar(32) DEFAULT 'VERIFIED_LIMITED' NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_migration_required" boolean DEFAULT false NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "theme_preference" varchar(16) DEFAULT 'system' NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "bio" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_url" text;

-- Make registration_code_id nullable for direct email signups
ALTER TABLE "users" ALTER COLUMN "registration_code_id" DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "users_auth_email_idx" ON "users" ("auth_email") WHERE "auth_email" IS NOT NULL;

-- 2. Safe Columns on government table
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "access_path_code" varchar(32) DEFAULT '2027' NOT NULL;
ALTER TABLE "government" ADD COLUMN IF NOT EXISTS "support_email" varchar(255) DEFAULT 'aerospay.official@gmail.com' NOT NULL;

-- 3. Email Verification Codes table
CREATE TABLE IF NOT EXISTS "email_verification_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" varchar(255) NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "username" varchar(32),
  "password_hash" text,
  "code_hash" varchar(128) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 5 NOT NULL,
  "consumed_at" timestamp with time zone,
  "ip_address" varchar(45),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "email_verif_email_idx" ON "email_verification_codes" ("email");
CREATE INDEX IF NOT EXISTS "email_verif_user_idx" ON "email_verification_codes" ("user_id");

-- 4. Government Activation Codes table
CREATE TABLE IF NOT EXISTS "government_activation_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code_hash" varchar(128) NOT NULL UNIQUE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "generated_by" varchar(64) DEFAULT 'GOVERNMENT' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "consumed_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "status" varchar(20) DEFAULT 'ACTIVE' NOT NULL,
  "admin_notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "gov_activation_user_idx" ON "government_activation_codes" ("user_id");
CREATE INDEX IF NOT EXISTS "gov_activation_status_idx" ON "government_activation_codes" ("status");

-- 5. Platform Feature Flags central registry
CREATE TABLE IF NOT EXISTS "platform_feature_flags" (
  "id" varchar(64) PRIMARY KEY NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "display_name" varchar(120) NOT NULL,
  "description" text NOT NULL,
  "reason" text,
  "updated_by" varchar(64) DEFAULT 'GOVERNMENT' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Seed initial feature flags (Exchange & Trading initially DISABLED)
INSERT INTO "platform_feature_flags" ("id", "enabled", "display_name", "description", "reason")
VALUES
  ('aeros_exchange', false, 'Aeros Exchange', 'INR-to-Aeros purchases and package policies', 'Temporarily paused for V6 rollout'),
  ('trading_terminal', false, 'Synthetic Trading Terminal', 'AMI spot trading and hedge-style leverage positions', 'Temporarily paused for V6 rollout'),
  ('marketplace', true, 'Public Marketplace', 'Goods, services, and order escrow', 'Active'),
  ('aeros_media', true, 'Aeros Media', 'Text-only community feed and social posts', 'Active'),
  ('jobs', true, 'Citizen Jobs & Employment', 'Corporate and government job bounties', 'Active'),
  ('partnerships', true, 'Corporate Partnerships', 'Inter-company joint ventures and 50/50 revenue sharing', 'Active'),
  ('companies', true, 'Corporate Accounts & Invoicing', 'Company registration, invoicing, and corporate balances', 'Active')
ON CONFLICT ("id") DO NOTHING;

-- 6. Government Public Content & Community Links
CREATE TABLE IF NOT EXISTS "government_public_content" (
  "key" varchar(64) PRIMARY KEY NOT NULL,
  "value" text NOT NULL,
  "label" varchar(120) NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "is_private" boolean DEFAULT false NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "updated_by" varchar(64) DEFAULT 'GOVERNMENT' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Seed default public content & community links
INSERT INTO "government_public_content" ("key", "value", "label", "enabled", "is_private", "sort_order")
VALUES
  ('support_email', 'aerospay.official@gmail.com', 'Official Support Email', true, false, 1),
  ('instagram_url', 'https://instagram.com/aerospay', 'Instagram Community', true, false, 2),
  ('whatsapp_community_url', 'https://chat.whatsapp.com/invite/aerospay-community', 'WhatsApp Community', true, false, 3),
  ('whatsapp_group_url', 'https://chat.whatsapp.com/invite/aerospay-official', 'WhatsApp Official Group', true, false, 4),
  ('interdream_url', 'https://interdream.io/c/aerospay', 'Interdream / Entodream Platform', true, false, 5),
  ('public_dock_url', 'https://docs.aerospay.com', 'Public Documentation & Dock', true, false, 6),
  ('private_dock_url', 'https://docs.aerospay.com/members', 'Member Private Updates Dock', true, true, 7)
ON CONFLICT ("key") DO NOTHING;

-- 7. In-App Support Requests outbox
CREATE TABLE IF NOT EXISTS "support_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ticket_number" varchar(32) NOT NULL UNIQUE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "username" varchar(32),
  "email" varchar(255) NOT NULL,
  "category" varchar(32) NOT NULL,
  "subject" varchar(200) NOT NULL,
  "description" text NOT NULL,
  "severity" varchar(20) DEFAULT 'NORMAL' NOT NULL,
  "relevant_module" varchar(64),
  "steps_to_reproduce" text,
  "expected_behaviour" text,
  "actual_behaviour" text,
  "delivery_status" varchar(32) DEFAULT 'PENDING' NOT NULL,
  "web3forms_message_id" varchar(120),
  "delivery_error" text,
  "retry_count" integer DEFAULT 0 NOT NULL,
  "user_agent" text,
  "ip_address" varchar(45),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "support_req_ticket_idx" ON "support_requests" ("ticket_number");
CREATE INDEX IF NOT EXISTS "support_req_user_idx" ON "support_requests" ("user_id");
CREATE INDEX IF NOT EXISTS "support_req_status_idx" ON "support_requests" ("delivery_status");
