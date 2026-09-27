CREATE TYPE "public"."account_status" AS ENUM('ACTIVE', 'SUSPENDED', 'BANNED');--> statement-breakpoint
CREATE TYPE "public"."code_status" AS ENUM('UNUSED', 'USED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."issuance_status" AS ENUM('OPEN', 'EXECUTED');--> statement-breakpoint
CREATE TYPE "public"."party_type" AS ENUM('USER', 'GOVERNMENT');--> statement-breakpoint
CREATE TYPE "public"."tx_type" AS ENUM('TRANSFER', 'GOVERNMENT_FUNDING', 'ADMIN_ADJUSTMENT_CREDIT', 'ADMIN_ADJUSTMENT_DEBIT', 'ISSUANCE_CREDIT');--> statement-breakpoint
CREATE TYPE "public"."vote_choice" AS ENUM('APPROVE', 'REJECT');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"actor_type" "party_type" NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "government" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(64) NOT NULL,
	"password_hash" text NOT NULL,
	"security_code_hash" text NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"total_supply" integer DEFAULT 0 NOT NULL,
	"tax_rate_bp" integer DEFAULT 500 NOT NULL,
	"tax_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "government_username_unique" UNIQUE("username"),
	CONSTRAINT "government_balance_nonnegative" CHECK ("government"."balance" >= 0),
	CONSTRAINT "government_tax_rate_bounds" CHECK ("government"."tax_rate_bp" >= 0 AND "government"."tax_rate_bp" <= 10000)
);
--> statement-breakpoint
CREATE TABLE "issuance_eligible_voters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issuance_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"status" "issuance_status" DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone,
	"executed_tx_ref" varchar(32),
	CONSTRAINT "issuance_amount_bounds" CHECK ("issuance_requests"."amount" >= 1 AND "issuance_requests"."amount" <= 5000)
);
--> statement-breakpoint
CREATE TABLE "issuance_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"vote" "vote_choice" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(48) NOT NULL,
	"message" text NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registration_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(4) NOT NULL,
	"status" "code_status" DEFAULT 'UNUSED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "registration_codes_code_unique" UNIQUE("code"),
	CONSTRAINT "registration_code_format" CHECK ("registration_codes"."code" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tx_ref" varchar(32) NOT NULL,
	"type" "tx_type" NOT NULL,
	"sender_type" "party_type" NOT NULL,
	"sender_id" uuid,
	"sender_username" varchar(32) NOT NULL,
	"receiver_type" "party_type" NOT NULL,
	"receiver_id" uuid,
	"receiver_username" varchar(32) NOT NULL,
	"gross_amount" integer NOT NULL,
	"tax_amount" integer DEFAULT 0 NOT NULL,
	"net_amount" integer NOT NULL,
	"tax_rate_bp_applied" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_tx_ref_unique" UNIQUE("tx_ref"),
	CONSTRAINT "transactions_gross_positive" CHECK ("transactions"."gross_amount" >= 1),
	CONSTRAINT "transactions_tax_nonnegative" CHECK ("transactions"."tax_amount" >= 0),
	CONSTRAINT "transactions_net_nonnegative" CHECK ("transactions"."net_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(160) NOT NULL,
	"content" text NOT NULL,
	"author_label" varchar(64) DEFAULT 'Government' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(32) NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" varchar(80) NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"status" "account_status" DEFAULT 'ACTIVE' NOT NULL,
	"registration_code_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_username_lowercase" CHECK ("users"."username" = lower("users"."username")),
	CONSTRAINT "users_balance_nonnegative" CHECK ("users"."balance" >= 0)
);
--> statement-breakpoint
ALTER TABLE "issuance_eligible_voters" ADD CONSTRAINT "issuance_eligible_voters_request_id_issuance_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."issuance_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_eligible_voters" ADD CONSTRAINT "issuance_eligible_voters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_votes" ADD CONSTRAINT "issuance_votes_request_id_issuance_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."issuance_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_votes" ADD CONSTRAINT "issuance_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_registration_code_id_registration_codes_id_fk" FOREIGN KEY ("registration_code_id") REFERENCES "public"."registration_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eligible_voter_unique" ON "issuance_eligible_voters" USING btree ("request_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issuance_vote_unique" ON "issuance_votes" USING btree ("request_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_registration_code_unique" ON "users" USING btree ("registration_code_id");