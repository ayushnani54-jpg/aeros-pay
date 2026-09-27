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
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Enums
//
// V2 note: every enum below is EXTENDED, never redefined. New values are
// appended so existing rows (and every V1 value) keep their exact meaning.
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

/** Parties that can hold a wallet and appear on a ledger row. COMPANY is a
 * V2 addition. */
export const partyTypeEnum = pgEnum("party_type", [
  "USER",
  "GOVERNMENT",
  "COMPANY",
]);

export const txTypeEnum = pgEnum("tx_type", [
  // --- V1 ---
  "TRANSFER", // user -> user
  "GOVERNMENT_FUNDING", // government -> user (new user funding)
  "ADMIN_ADJUSTMENT_CREDIT", // government -> user, administrative credit
  "ADMIN_ADJUSTMENT_DEBIT", // user -> government, administrative debit
  "ISSUANCE_CREDIT", // system -> government treasury, new supply
  // --- V2 ---
  "COMPANY_FUNDING", // government -> company, approval funding
  "COMPANY_SALE", // user/company -> company (company is the seller)
  "COMPANY_PAYMENT", // company -> user/company (company is the payer)
  "INVOICE_PAYMENT", // user -> company, settling an invoice
  "GOVERNMENT_PAYMENT", // government -> user/company, general payment
  "GOVERNMENT_RECEIPT", // user/company -> government, general payment in
  "COMPANY_ADJUSTMENT_CREDIT", // government -> company, administrative credit
  "COMPANY_ADJUSTMENT_DEBIT", // company -> government, administrative debit
  "COMPANY_SALE_PURCHASE", // buyer (user) -> seller (user), buying a company
  "LOAN_DISBURSEMENT", // government -> company, loan principal paid out
  "LOAN_REPAYMENT", // company -> government, instalment repayment
]);

export const voteChoiceEnum = pgEnum("vote_choice", ["APPROVE", "REJECT"]);

export const issuanceStatusEnum = pgEnum("issuance_status", [
  "OPEN",
  "EXECUTED",
]);

// --- V2 enums ---------------------------------------------------------------

export const companyStatusEnum = pgEnum("company_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
  "REVOKED",
]);

export const invoiceStatusEnum = pgEnum("invoice_status", [
  "PENDING",
  "PAID",
  "CANCELLED",
  "EXPIRED",
]);

export const supportStatusEnum = pgEnum("support_status", [
  "OPEN",
  "WAITING",
  "RESOLVED",
]);

export const ipComplaintStatusEnum = pgEnum("ip_complaint_status", [
  "OPEN",
  "UNDER_REVIEW",
  "RESOLVED",
]);

export const ipDecisionEnum = pgEnum("ip_decision", [
  "DISMISSED",
  "WARNING",
  "STRIKE",
  "SECOND_STRIKE",
  "TEMPORARY_SUSPENSION",
  "PERMANENT_REVOCATION",
]);

export const saleListingStatusEnum = pgEnum("sale_listing_status", [
  "OPEN",
  "SOLD",
  "CANCELLED",
]);

export const saleOfferStatusEnum = pgEnum("sale_offer_status", [
  "PENDING",
  "ACCEPTED",
  "DECLINED",
  "WITHDRAWN",
]);

export const loanStatusEnum = pgEnum("loan_status", [
  "PENDING", // company applied, awaiting Government review
  "APPROVED", // Government approved, awaiting company acceptance
  "ACTIVE", // accepted and disbursed, repayment in progress
  "PAID", // fully repaid
  "REJECTED", // Government declined the application
  "CANCELLED", // withdrawn by the company before disbursement
  "DEFAULTED", // Government declared default after overdue instalments
  "RESTRUCTURED", // Government rescheduled the remaining instalments
]);

export const instalmentStatusEnum = pgEnum("instalment_status", [
  "PENDING",
  "PAID",
  "OVERDUE",
  "WAIVED",
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
  // --- V2: default tax rate for company transactions, overridable per company
  companyTaxRateBp: integer("company_tax_rate_bp").notNull().default(500),
  companyTaxUpdatedAt: timestamp("company_tax_updated_at", { withTimezone: true }),

  // --- V2: company sale policy ----------------------------------------------
  /** Valuation multiplier in basis points: 15000 = 1.50x lifetime sales. */
  saleMultiplierBp: integer("sale_multiplier_bp").notNull().default(15000),
  /** Days a company must have been approved before it can be listed. */
  saleMinCompanyAgeDays: integer("sale_min_company_age_days").notNull().default(7),

  // --- V2: loan policy ------------------------------------------------------
  loansEnabled: boolean("loans_enabled").notNull().default(true),
  loanInterestRateBp: integer("loan_interest_rate_bp").notNull().default(1000), // 10.00%
  loanMinAmount: integer("loan_min_amount").notNull().default(100),
  loanMaxAmount: integer("loan_max_amount").notNull().default(10000),
  loanInstalmentCount: integer("loan_instalment_count").notNull().default(2),
  loanInstalmentIntervalDays: integer("loan_instalment_interval_days").notNull().default(7),
  /** Eligibility: minimum days since company approval. */
  loanMinCompanyAgeDays: integer("loan_min_company_age_days").notNull().default(7),
  /** Eligibility: minimum lifetime sales the company must have made. */
  loanMinCompanySales: integer("loan_min_company_sales").notNull().default(0),
  /** Days overdue before Government may declare a default. */
  loanDefaultGraceDays: integer("loan_default_grace_days").notNull().default(7),
  loanPolicyUpdatedAt: timestamp("loan_policy_updated_at", { withTimezone: true }),

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

  // --- V2: timed suspension -------------------------------------------------
  // When status = SUSPENDED and suspendedUntil is in the past, the account is
  // treated as ACTIVE by the server without any Government action required.
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedUntil: timestamp("suspended_until", { withTimezone: true }),
  suspendedBy: varchar("suspended_by", { length: 64 }),
  suspensionReason: text("suspension_reason"),

  // --- V2: permanent ban ----------------------------------------------------
  bannedAt: timestamp("banned_at", { withTimezone: true }),
  bannedBy: varchar("banned_by", { length: 64 }),
  banReason: text("ban_reason"),

  // --- V2: session invalidation --------------------------------------------
  // Incremented whenever the Government resets a password. Sessions carry the
  // epoch they were minted at; a mismatch invalidates the session server-side.
  sessionEpoch: integer("session_epoch").notNull().default(0),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  passwordUpdatedAt: timestamp("password_updated_at", { withTimezone: true }),
}, (t) => ([
  uniqueIndex("users_registration_code_unique").on(t.registrationCodeId),
  check("users_username_lowercase", sql`${t.username} = lower(${t.username})`),
  check("users_balance_nonnegative", sql`${t.balance} >= 0`),
]));

// ---------------------------------------------------------------------------
// Companies (V2)
//
// A company is a wallet owned by exactly one user. It has no login of its own:
// the owner switches context inside their existing session.
// ---------------------------------------------------------------------------

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 80 }).notNull(),
  username: varchar("username", { length: 32 }).notNull().unique(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id),
  category: varchar("category", { length: 60 }).notNull(),
  reason: text("reason").notNull(),
  description: text("description").notNull(),

  status: companyStatusEnum("status").notNull().default("PENDING"),
  balance: integer("balance").notNull().default(0),

  /**
   * True once the Government has acquired the company through an accepted
   * offer. `ownerUserId` keeps pointing at the last private owner so the
   * history and the foreign key stay intact, but while this flag is set the
   * previous owner no longer has access and the company is under Government
   * stewardship.
   */
  governmentOwned: boolean("government_owned").notNull().default(false),
  governmentAcquiredAt: timestamp("government_acquired_at", { withTimezone: true }),

  /** NULL means "use the Government's default company tax rate". */
  taxRateBp: integer("tax_rate_bp"),
  taxUpdatedAt: timestamp("tax_updated_at", { withTimezone: true }),

  strikes: integer("strikes").notNull().default(0),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewedBy: varchar("reviewed_by", { length: 64 }),
  rejectionReason: text("rejection_reason"),

  fundedAt: timestamp("funded_at", { withTimezone: true }),

  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedUntil: timestamp("suspended_until", { withTimezone: true }),
  suspensionReason: text("suspension_reason"),

  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokeReason: text("revoke_reason"),
}, (t) => ([
  check("companies_username_lowercase", sql`${t.username} = lower(${t.username})`),
  check("companies_balance_nonnegative", sql`${t.balance} >= 0`),
  check(
    "companies_tax_rate_bounds",
    sql`${t.taxRateBp} IS NULL OR (${t.taxRateBp} >= 0 AND ${t.taxRateBp} <= 10000)`,
  ),
  index("companies_owner_idx").on(t.ownerUserId),
  index("companies_status_idx").on(t.status),
]));

// ---------------------------------------------------------------------------
// Transactions (immutable ledger)
//
// V2 note: no columns were removed or repurposed. senderId/receiverId are
// plain uuids interpreted according to senderType/receiverType, so a COMPANY
// party slots in without touching a single existing row.
// ---------------------------------------------------------------------------

export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  txRef: varchar("tx_ref", { length: 32 }).notNull().unique(),
  type: txTypeEnum("type").notNull(),

  senderType: partyTypeEnum("sender_type").notNull(),
  senderId: uuid("sender_id"), // users.id or companies.id, per senderType
  senderUsername: varchar("sender_username", { length: 32 }).notNull(),

  receiverType: partyTypeEnum("receiver_type").notNull(),
  receiverId: uuid("receiver_id"), // users.id or companies.id, per receiverType
  receiverUsername: varchar("receiver_username", { length: 32 }).notNull(),

  grossAmount: integer("gross_amount").notNull(),
  taxAmount: integer("tax_amount").notNull().default(0),
  netAmount: integer("net_amount").notNull(),
  taxRateBpApplied: integer("tax_rate_bp_applied").notNull().default(0),

  reason: text("reason"),

  /** V2: set when this ledger row settled an invoice. */
  invoiceId: uuid("invoice_id"),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => ([
  check("transactions_gross_positive", sql`${t.grossAmount} >= 1`),
  check("transactions_tax_nonnegative", sql`${t.taxAmount} >= 0`),
  check("transactions_net_nonnegative", sql`${t.netAmount} >= 0`),
  index("transactions_sender_idx").on(t.senderId),
  index("transactions_receiver_idx").on(t.receiverId),
  index("transactions_created_idx").on(t.createdAt),
]));

// ---------------------------------------------------------------------------
// Invoices (V2)
//
// Quoting convention: `subtotal` is the price the company quotes, tax is added
// on top, and `total` is what the buyer pays. The ledger row written on
// payment still satisfies the system-wide invariant gross = tax + net, with
// gross = total (buyer paid), net = subtotal (company received).
// ---------------------------------------------------------------------------

export const invoices = pgTable("invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceNumber: varchar("invoice_number", { length: 32 }).notNull().unique(),

  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  buyerUserId: uuid("buyer_user_id")
    .notNull()
    .references(() => users.id),

  itemName: varchar("item_name", { length: 160 }).notNull(),
  description: text("description"),
  quantity: integer("quantity").notNull(),
  unitPrice: integer("unit_price").notNull(),

  subtotal: integer("subtotal").notNull(),
  taxRateBp: integer("tax_rate_bp").notNull(),
  taxAmount: integer("tax_amount").notNull(),
  total: integer("total").notNull(),

  status: invoiceStatusEnum("status").notNull().default("PENDING"),
  note: text("note"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  paidTxRef: varchar("paid_tx_ref", { length: 32 }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
}, (t) => ([
  check("invoices_quantity_positive", sql`${t.quantity} >= 1`),
  check("invoices_unit_price_positive", sql`${t.unitPrice} >= 1`),
  check("invoices_total_positive", sql`${t.total} >= 1`),
  check("invoices_tax_nonnegative", sql`${t.taxAmount} >= 0`),
  index("invoices_company_idx").on(t.companyId),
  index("invoices_buyer_idx").on(t.buyerUserId),
  index("invoices_status_idx").on(t.status),
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
  /** V2: optional Government note shown alongside the request. */
  note: text("note"),
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
// Government support conversations (V2)
//
// Exactly one private thread per user. There is no user-to-user messaging.
// ---------------------------------------------------------------------------

export const supportThreads = pgTable("support_threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  status: supportStatusEnum("status").notNull().default("OPEN"),
  unreadForGovernment: integer("unread_for_government").notNull().default(0),
  unreadForUser: integer("unread_for_user").notNull().default(0),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ([
  uniqueIndex("support_thread_user_unique").on(t.userId),
]));

export const supportMessages = pgTable("support_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id")
    .notNull()
    .references(() => supportThreads.id),
  senderType: partyTypeEnum("sender_type").notNull(),
  senderLabel: varchar("sender_label", { length: 64 }).notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ([
  index("support_messages_thread_idx").on(t.threadId),
]));

// ---------------------------------------------------------------------------
// IP / copyright complaints between companies (V2)
// ---------------------------------------------------------------------------

export const ipComplaints = pgTable("ip_complaints", {
  id: uuid("id").primaryKey().defaultRandom(),
  complaintNumber: varchar("complaint_number", { length: 32 }).notNull().unique(),

  complainantCompanyId: uuid("complainant_company_id")
    .notNull()
    .references(() => companies.id),
  accusedCompanyId: uuid("accused_company_id")
    .notNull()
    .references(() => companies.id),

  reason: varchar("reason", { length: 160 }).notNull(),
  description: text("description").notNull(),
  evidence: text("evidence").notNull(),
  referenceMaterial: text("reference_material"),

  status: ipComplaintStatusEnum("status").notNull().default("OPEN"),
  decision: ipDecisionEnum("decision"),
  decisionReason: text("decision_reason"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedBy: varchar("decided_by", { length: 64 }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ([
  index("ip_complaints_status_idx").on(t.status),
  index("ip_complaints_accused_idx").on(t.accusedCompanyId),
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
  /** V2: explicit before/after and reason columns so an audit row is readable
   * without having to interpret the metadata blob. */
  previousValue: text("previous_value"),
  newValue: text("new_value"),
  reason: text("reason"),
  /** V2: archived rows stay in the table but drop out of the active view. */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => ([
  index("audit_logs_created_idx").on(t.createdAt),
]));

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
  /** V2: optional deep link, e.g. to an invoice. */
  href: varchar("href", { length: 200 }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => ([
  index("notifications_user_idx").on(t.userId),
]));

// ---------------------------------------------------------------------------
// Data retention settings (V2, singleton row)
//
// Deliberately covers only disposable data. Transactions, users, companies,
// invoices and issuance records are never auto-deleted (spec §50).
// ---------------------------------------------------------------------------

export const retentionSettings = pgTable("retention_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** NULL = keep forever. */
  updatesRetentionDays: integer("updates_retention_days"),
  notificationsRetentionDays: integer("notifications_retention_days"),
  supportRetentionDays: integer("support_retention_days"),
  lastCleanupAt: timestamp("last_cleanup_at", { withTimezone: true }),
  lastCleanupSummary: jsonb("last_cleanup_summary"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Company sale marketplace (V2)
//
// A listing is created by the owner once the company is old enough. The
// valuation is computed and FROZEN at listing time from the company's
// lifetime sales and the Government's multiplier, so the price a buyer sees
// is the price they pay.
// ---------------------------------------------------------------------------

export const companySaleListings = pgTable("company_sale_listings", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  /** Owner at the time of listing. */
  sellerUserId: uuid("seller_user_id")
    .notNull()
    .references(() => users.id),

  reason: text("reason").notNull(),

  /** Lifetime sales figure used for the valuation, frozen at listing time. */
  salesFigure: integer("sales_figure").notNull(),
  /** Multiplier in basis points, frozen at listing time (15000 = 1.50x). */
  multiplierBp: integer("multiplier_bp").notNull(),
  /** salesFigure * multiplierBp / 10000, rounded. */
  valuation: integer("valuation").notNull(),
  valuedAt: timestamp("valued_at", { withTimezone: true }).notNull().defaultNow(),

  status: saleListingStatusEnum("status").notNull().default("OPEN"),

  buyerUserId: uuid("buyer_user_id").references(() => users.id),
  salePrice: integer("sale_price"),
  soldAt: timestamp("sold_at", { withTimezone: true }),
  soldTxRef: varchar("sold_tx_ref", { length: 32 }),

  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelReason: text("cancel_reason"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ([
  check("sale_listing_valuation_nonnegative", sql`${t.valuation} >= 0`),
  index("sale_listings_company_idx").on(t.companyId),
  index("sale_listings_status_idx").on(t.status),
]));

/**
 * Per-viewer dismissals.
 *
 * Dismissing a listing hides it for THAT user only. The listing itself stays
 * OPEN and visible to everyone else until it is sold or cancelled — one
 * person's "not interested" must never remove a live listing for the whole
 * community.
 */
export const companySaleDismissals = pgTable("company_sale_dismissals", {
  id: uuid("id").primaryKey().defaultRandom(),
  listingId: uuid("listing_id")
    .notNull()
    .references(() => companySaleListings.id),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ([
  uniqueIndex("sale_dismissal_unique").on(t.listingId, t.userId),
]));

/**
 * Offers that require the owner's acceptance.
 *
 * A Government offer is recorded here like any other: the Government can
 * propose a price at any time, but ownership only ever moves when the owner
 * accepts. There is deliberately no path that transfers a company without
 * the owner's consent (spec: "no forced automatic acquisition").
 */
export const companySaleOffers = pgTable("company_sale_offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  /** Null for a Government offer made without an active listing. */
  listingId: uuid("listing_id").references(() => companySaleListings.id),

  offerorType: partyTypeEnum("offeror_type").notNull(),
  /** Null when the offeror is the Government. */
  offerorUserId: uuid("offeror_user_id").references(() => users.id),

  /** Owner at the time the offer was made. */
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id),

  amount: integer("amount").notNull(),
  message: text("message"),

  status: saleOfferStatusEnum("status").notNull().default("PENDING"),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  responseNote: text("response_note"),
  settledTxRef: varchar("settled_tx_ref", { length: 32 }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ([
  check("sale_offer_amount_positive", sql`${t.amount} >= 1`),
  index("sale_offers_company_idx").on(t.companyId),
  index("sale_offers_owner_idx").on(t.ownerUserId),
  index("sale_offers_status_idx").on(t.status),
]));

/** Permanent record of every completed ownership transfer. */
export const companySaleRecords = pgTable("company_sale_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  listingId: uuid("listing_id").references(() => companySaleListings.id),
  offerId: uuid("offer_id").references(() => companySaleOffers.id),

  sellerUserId: uuid("seller_user_id")
    .notNull()
    .references(() => users.id),
  buyerUserId: uuid("buyer_user_id")
    .notNull()
    .references(() => users.id),

  price: integer("price").notNull(),
  salesFigure: integer("sales_figure").notNull(),
  multiplierBp: integer("multiplier_bp").notNull(),
  /** Company wallet balance at the moment of transfer, for the record. */
  companyBalanceAtSale: integer("company_balance_at_sale").notNull(),

  txRef: varchar("tx_ref", { length: 32 }).notNull(),
  /** "LISTING_PURCHASE" or "GOVERNMENT_OFFER" or "USER_OFFER". */
  saleType: varchar("sale_type", { length: 32 }).notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ([
  index("sale_records_company_idx").on(t.companyId),
]));

// ---------------------------------------------------------------------------
// Government (Aeros Bank) company loans (V2)
//
// Loans never create Aeros. Principal is paid out of the Government treasury
// and repayments flow back into it, so total supply is unchanged by the whole
// loan lifecycle — only `executeIssuance` ever changes supply.
// ---------------------------------------------------------------------------

export const loans = pgTable("loans", {
  id: uuid("id").primaryKey().defaultRandom(),
  loanNumber: varchar("loan_number", { length: 32 }).notNull().unique(),

  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  /** Owner at application time, for the audit trail. */
  appliedByUserId: uuid("applied_by_user_id")
    .notNull()
    .references(() => users.id),

  requestedAmount: integer("requested_amount").notNull(),
  purpose: text("purpose").notNull(),

  /** Set at approval. Terms are frozen here so a later policy change never
   * alters an existing loan. */
  principal: integer("principal"),
  interestRateBp: integer("interest_rate_bp"),
  totalInterest: integer("total_interest"),
  totalPayable: integer("total_payable"),
  instalmentCount: integer("instalment_count"),
  instalmentIntervalDays: integer("instalment_interval_days"),

  principalPaid: integer("principal_paid").notNull().default(0),
  interestPaid: integer("interest_paid").notNull().default(0),

  status: loanStatusEnum("status").notNull().default("PENDING"),

  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewedBy: varchar("reviewed_by", { length: 64 }),
  rejectionReason: text("rejection_reason"),

  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  disbursedAt: timestamp("disbursed_at", { withTimezone: true }),
  disbursementTxRef: varchar("disbursement_tx_ref", { length: 32 }),

  nextDueAt: timestamp("next_due_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),

  defaultedAt: timestamp("defaulted_at", { withTimezone: true }),
  defaultReason: text("default_reason"),
  restructuredAt: timestamp("restructured_at", { withTimezone: true }),
  restructureNote: text("restructure_note"),

  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ([
  check("loans_requested_positive", sql`${t.requestedAmount} >= 1`),
  check("loans_principal_paid_nonnegative", sql`${t.principalPaid} >= 0`),
  check("loans_interest_paid_nonnegative", sql`${t.interestPaid} >= 0`),
  index("loans_company_idx").on(t.companyId),
  index("loans_status_idx").on(t.status),
]));

export const loanInstalments = pgTable("loan_instalments", {
  id: uuid("id").primaryKey().defaultRandom(),
  loanId: uuid("loan_id")
    .notNull()
    .references(() => loans.id),
  sequence: integer("sequence").notNull(),

  principalPortion: integer("principal_portion").notNull(),
  interestPortion: integer("interest_portion").notNull(),
  totalDue: integer("total_due").notNull(),

  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  status: instalmentStatusEnum("status").notNull().default("PENDING"),

  paidAt: timestamp("paid_at", { withTimezone: true }),
  paidTxRef: varchar("paid_tx_ref", { length: 32 }),
  paidAmount: integer("paid_amount"),

  /** Escalating reminder bookkeeping. */
  remindersSent: integer("reminders_sent").notNull().default(0),
  lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
  lastReminderStage: varchar("last_reminder_stage", { length: 32 }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ([
  uniqueIndex("loan_instalment_unique").on(t.loanId, t.sequence),
  check("instalment_total_positive", sql`${t.totalDue} >= 1`),
  index("loan_instalments_due_idx").on(t.dueAt),
  index("loan_instalments_status_idx").on(t.status),
]));

/** One row per repayment, kept permanently for reconciliation. */
export const loanPayments = pgTable("loan_payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  loanId: uuid("loan_id")
    .notNull()
    .references(() => loans.id),
  instalmentId: uuid("instalment_id")
    .notNull()
    .references(() => loanInstalments.id),

  amount: integer("amount").notNull(),
  principalPaid: integer("principal_paid").notNull(),
  interestPaid: integer("interest_paid").notNull(),
  /** Outstanding total payable AFTER this payment. */
  remainingBalance: integer("remaining_balance").notNull(),

  txRef: varchar("tx_ref", { length: 32 }).notNull(),
  paidByUserId: uuid("paid_by_user_id")
    .notNull()
    .references(() => users.id),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ([
  index("loan_payments_loan_idx").on(t.loanId),
]));

/** Audited Government actions taken on a loan in default. */
export const loanActions = pgTable("loan_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  loanId: uuid("loan_id")
    .notNull()
    .references(() => loans.id),
  /** WARNING | RESTRICTION | DEMAND | RESTRUCTURE | DEFAULT | SUSPENSION | CLEARED */
  action: varchar("action", { length: 32 }).notNull(),
  reason: text("reason").notNull(),
  actorLabel: varchar("actor_label", { length: 64 }).notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ([
  index("loan_actions_loan_idx").on(t.loanId),
]));

export type User = typeof users.$inferSelect;
export type Government = typeof government.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type RegistrationCode = typeof registrationCodes.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type IssuanceRequest = typeof issuanceRequests.$inferSelect;
export type IssuanceVote = typeof issuanceVotes.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type Update = typeof updates.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type SupportThread = typeof supportThreads.$inferSelect;
export type SupportMessage = typeof supportMessages.$inferSelect;
export type IpComplaint = typeof ipComplaints.$inferSelect;
export type RetentionSettings = typeof retentionSettings.$inferSelect;
export type CompanySaleListing = typeof companySaleListings.$inferSelect;
export type CompanySaleOffer = typeof companySaleOffers.$inferSelect;
export type CompanySaleRecord = typeof companySaleRecords.$inferSelect;
export type Loan = typeof loans.$inferSelect;
export type LoanInstalment = typeof loanInstalments.$inferSelect;
export type LoanPayment = typeof loanPayments.$inferSelect;
export type LoanAction = typeof loanActions.$inferSelect;
