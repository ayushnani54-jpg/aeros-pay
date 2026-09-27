import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const accountStatusEnum = pgEnum("account_status", [
  "ACTIVE",
  "SUSPENDED",
  "BANNED",
]);

export const codeStatusEnum = pgEnum("code_status", [
  "UNUSED",
  "USED",
  "REVOKED",
]);

export const partyTypeEnum = pgEnum("party_type", ["USER", "GOVERNMENT"]);

export const txTypeEnum = pgEnum("tx_type", [
  "TRANSFER", // user -> user
  "GOVERNMENT_FUNDING", // government -> user (new user funding, manual send)
  "ADMIN_ADJUSTMENT_CREDIT", // government -> user, administrative credit
  "ADMIN_ADJUSTMENT_DEBIT", // user -> government, administrative debit
  "ISSUANCE_CREDIT", // system -> government treasury, new supply
]);

export const voteChoiceEnum = pgEnum("vote_choice", ["APPROVE", "REJECT"]);

export const issuanceStatusEnum = pgEnum("issuance_status", [
  "OPEN",
  "EXECUTED",
]);

// ---------------------------------------------------------------------------
// Government (singleton row for V1 — schema allows future multi-admin use)
// ---------------------------------------------------------------------------

export const government = pgTable("government", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: varchar("username", { length: 64 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  securityCodeHash: text("security_code_hash").notNull(),
  balance: integer("balance").notNull().default(0),
  totalSupply: integer("total_supply").notNull().default(0),
  taxRateBp: integer("tax_rate_bp").notNull().default(500), // basis points; 500 = 5.00%
  taxUpdatedAt: timestamp("tax_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => ([
  check("government_balance_nonnegative", sql`${t.balance} >= 0`),
  check("government_tax_rate_bounds", sql`${t.taxRateBp} >= 0 AND ${t.taxRateBp} <= 10000`),
]));

// ---------------------------------------------------------------------------
// Registration codes
// ---------------------------------------------------------------------------

export const registrationCodes = pgTable("registration_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 4 }).notNull().unique(),
  status: codeStatusEnum("status").notNull().default("UNUSED"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  usedByUserId: uuid("used_by_user_id"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => ([
  check("registration_code_format", sql`${t.code} ~ '^[0-9]{4}$'`),
]));

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: varchar("username", { length: 32 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: varchar("display_name", { length: 80 }).notNull(),
  balance: integer("balance").notNull().default(0),
  status: accountStatusEnum("status").notNull().default("ACTIVE"),
  registrationCodeId: uuid("registration_code_id")
    .notNull()
    .references(() => registrationCodes.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => ([
  uniqueIndex("users_registration_code_unique").on(t.registrationCodeId),
  check("users_username_lowercase", sql`${t.username} = lower(${t.username})`),
  check("users_balance_nonnegative", sql`${t.balance} >= 0`),
]));

// ---------------------------------------------------------------------------
// Transactions (immutable ledger)
// ---------------------------------------------------------------------------

export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  txRef: varchar("tx_ref", { length: 32 }).notNull().unique(),
  type: txTypeEnum("type").notNull(),

  senderType: partyTypeEnum("sender_type").notNull(),
  senderId: uuid("sender_id"), // fk users.id when senderType = USER
  senderUsername: varchar("sender_username", { length: 32 }).notNull(),

  receiverType: partyTypeEnum("receiver_type").notNull(),
  receiverId: uuid("receiver_id"), // fk users.id when receiverType = USER
  receiverUsername: varchar("receiver_username", { length: 32 }).notNull(),

  grossAmount: integer("gross_amount").notNull(),
  taxAmount: integer("tax_amount").notNull().default(0),
  netAmount: integer("net_amount").notNull(),
  taxRateBpApplied: integer("tax_rate_bp_applied").notNull().default(0),

  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => ([
  check("transactions_gross_positive", sql`${t.grossAmount} >= 1`),
  check("transactions_tax_nonnegative", sql`${t.taxAmount} >= 0`),
  check("transactions_net_nonnegative", sql`${t.netAmount} >= 0`),
]));

// ---------------------------------------------------------------------------
// Aeros issuance requests + votes
// ---------------------------------------------------------------------------

export const issuanceRequests = pgTable("issuance_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  amount: integer("amount").notNull(),
  reason: text("reason").notNull(),
  status: issuanceStatusEnum("status").notNull().default("OPEN"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  executedTxRef: varchar("executed_tx_ref", { length: 32 }),
}, (t) => ([
  check("issuance_amount_bounds", sql`${t.amount} >= 1 AND ${t.amount} <= 5000`),
]));

// Snapshot of eligible voters at request creation time — immutable, so
// Government cannot alter who is required to vote after the fact.
export const issuanceEligibleVoters = pgTable("issuance_eligible_voters", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestId: uuid("request_id")
    .notNull()
    .references(() => issuanceRequests.id),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
}, (t) => ([
  uniqueIndex("eligible_voter_unique").on(t.requestId, t.userId),
]));

export const issuanceVotes = pgTable("issuance_votes", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestId: uuid("request_id")
    .notNull()
    .references(() => issuanceRequests.id),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  vote: voteChoiceEnum("vote").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => ([
  uniqueIndex("issuance_vote_unique").on(t.requestId, t.userId),
]));

// ---------------------------------------------------------------------------
// Audit log (administrative / system events)
// ---------------------------------------------------------------------------

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  action: text("action").notNull(),
  actorType: partyTypeEnum("actor_type").notNull(),
  actorId: text("actor_id"),
  actorLabel: text("actor_label"),
  targetType: text("target_type"),
  targetId: text("target_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Updates (public announcements feed)
// ---------------------------------------------------------------------------

export const updates = pgTable("updates", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 160 }).notNull(),
  content: text("content").notNull(),
  authorLabel: varchar("author_label", { length: 64 })
    .notNull()
    .default("Government"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Per-user in-app notifications
// ---------------------------------------------------------------------------

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  type: varchar("type", { length: 48 }).notNull(),
  message: text("message").notNull(),
  read: boolean("read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Government = typeof government.$inferSelect;
export type RegistrationCode = typeof registrationCodes.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type IssuanceRequest = typeof issuanceRequests.$inferSelect;
export type IssuanceVote = typeof issuanceVotes.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type Update = typeof updates.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
