import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  date,
  jsonb,
  uniqueIndex,
  index,
  check,
  foreignKey,
  type AnyPgColumn,
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
  // --- V3 ---
  "MARKETPLACE_PAYMENT", // buyer -> seller, settling a marketplace order
  "CONTRACT_PAYMENT", // contract issuer -> awarded party
  "PROMOTION_CHARGE", // company -> government, daily promotion slot charge
  "GOVERNMENT_ON_BEHALF", // government -> party, paid on behalf of a third party
  // A refund is a NEW ledger event pointing at the row it undoes via
  // `reverses_transaction_id`. No completed transaction is ever edited or
  // deleted, so the ledger stays append-only (see the column's comment).
  "TRANSACTION_REVERSAL", // full reversal of an earlier transaction
  "TRANSACTION_ADJUSTMENT", // partial correction of an earlier transaction
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

// --- V3 enums ---------------------------------------------------------------

/**
 * The KIND of movement a tax decision is being made about. This is always a
 * fact the SERVER established (which code path is running), never a value a
 * client can choose — see src/lib/taxmatrix.ts.
 */
export const taxContextEnum = pgEnum("tax_context", [
  "DIRECT_TRANSFER",
  "INVOICE_PAYMENT",
  "MARKETPLACE_ORDER",
  "CONTRACT_PAYMENT",
  "LOAN_REPAYMENT",
  "PROMOTION_CHARGE",
  "GOVERNMENT_ON_BEHALF",
]);

export const idempotencyStatusEnum = pgEnum("idempotency_status", [
  "IN_PROGRESS",
  "SUCCEEDED",
  "FAILED",
]);

export const marketplaceOfferStatusEnum = pgEnum("marketplace_offer_status", [
  "ACTIVE",
  "PAUSED",
  "CLOSED",
]);

export const marketplaceOrderStatusEnum = pgEnum("marketplace_order_status", [
  "PENDING", // buyer placed it, seller has not responded
  "ACCEPTED", // seller accepted, no invoice raised yet
  "WAITING_FOR_INVOICE", // accepted and the buyer is waiting on the invoice
  "PAYMENT_DUE", // invoice raised, buyer has not paid
  "PAID", // invoice settled
  "COMPLETED", // goods/service delivered and confirmed
  "CANCELLED",
  "EXPIRED",
]);

export const wantedRequestStatusEnum = pgEnum("wanted_request_status", [
  "OPEN",
  "FULFILLED",
  "CANCELLED",
  "EXPIRED",
]);

export const wantedResponseStatusEnum = pgEnum("wanted_response_status", [
  "PENDING",
  "ACCEPTED",
  "DECLINED",
  "WITHDRAWN",
]);

export const contractStatusEnum = pgEnum("contract_status", [
  "OPEN",
  "AWARDED",
  "COMPLETED",
  "CANCELLED",
  "EXPIRED",
]);

export const contractApplicationStatusEnum = pgEnum("contract_application_status", [
  "PENDING",
  "ACCEPTED",
  "REJECTED",
  "WITHDRAWN",
]);

export const promotionStatusEnum = pgEnum("promotion_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
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

  // --- V2.1: configurable policy (previously hardcoded constants) -----------
  /** Aeros the Government funds a company with on approval, when the
   * approval action does not supply a one-off override amount. */
  companyApprovalFundingAmount: integer("company_approval_funding_amount")
    .notNull()
    .default(3000),
  companyApprovalFundingUpdatedAt: timestamp("company_approval_funding_updated_at", {
    withTimezone: true,
  }),
  /** Hard cap on a single issuance request/execution. */
  maxIssuanceAmount: integer("max_issuance_amount").notNull().default(10000),
  maxIssuanceAmountUpdatedAt: timestamp("max_issuance_amount_updated_at", {
    withTimezone: true,
  }),
  /** Days that must elapse after an executed issuance before another may be
   * executed. */
  issuanceCooldownDays: integer("issuance_cooldown_days").notNull().default(1),
  issuanceCooldownUpdatedAt: timestamp("issuance_cooldown_updated_at", {
    withTimezone: true,
  }),

  // --- V3: promotion (ad slot) policy ---------------------------------------
  /** Master switch for the single promotion slot. */
  promotionsEnabled: boolean("promotions_enabled").notNull().default(true),
  /** Aeros charged per IST calendar day an approved campaign is ACTIVE. The
   * rate is SNAPSHOT onto the campaign at approval, so a later rate change
   * never re-prices a running campaign. */
  promotionDailyRate: integer("promotion_daily_rate").notNull().default(50),
  promotionPolicyUpdatedAt: timestamp("promotion_policy_updated_at", {
    withTimezone: true,
  }),

  // --- V3: PWA offline-payment allowance policy ------------------------------
  //
  // Governs the single offline capability the app has: a personal wallet may
  // fetch a short, signed offline authorization while online (spec: PWA
  // offline payments) and spend against it while disconnected. Nothing else
  // is ever authorized offline — see src/lib/offline-auth.ts.
  //
  // `offlineTotalAllowance` is a PER-USER lifetime ceiling: at issue, a token
  // carries `offlineTotalAllowance - users.offline_allowance_used` as its
  // snapshot remaining allowance, and `users.offline_allowance_used` is only
  // ever incremented — atomically, guarded, in the same transaction as the
  // real transfer — when a queued offline payment actually SYNCS
  // successfully. Issuing a token never spends allowance; only a synced
  // payment does.
  offlineTransactionsEnabled: boolean("offline_transactions_enabled").notNull().default(false),
  offlineTotalAllowance: integer("offline_total_allowance").notNull().default(2000),
  offlineMaxPerTransaction: integer("offline_max_per_transaction").notNull().default(500),
  /** Minutes an issued offline authorization stays valid. NULL = use the
   * built-in default (see DEFAULT_OFFLINE_TOKEN_EXPIRY_MINUTES) — every token
   * always carries a real, server-set expiry; this column only lets the
   * Government shorten or lengthen it. */
  offlineAuthExpiryMinutes: integer("offline_auth_expiry_minutes"),
  offlinePolicyUpdatedAt: timestamp("offline_policy_updated_at", { withTimezone: true }),

  // --- Multi-company policy -------------------------------------------------
  /** How many companies one person may own at the same time (Government-set).
   * Counted as: the owner's companies that are not REJECTED (so a pending
   * application counts, a rejected one does not). Default 1 keeps the
   * behaviour every existing deployment already had. */
  maxCompaniesPerUser: integer("max_companies_per_user").notNull().default(1),
  maxCompaniesPerUserUpdatedAt: timestamp("max_companies_per_user_updated_at", {
    withTimezone: true,
  }),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => ([
  check("government_balance_nonnegative", sql`${t.balance} >= 0`),
  check("government_tax_rate_bounds", sql`${t.taxRateBp} >= 0 AND ${t.taxRateBp} <= 10000`),
  check(
    "government_company_approval_funding_bounds",
    sql`${t.companyApprovalFundingAmount} >= 0 AND ${t.companyApprovalFundingAmount} <= 1000000`,
  ),
  check(
    "government_max_issuance_amount_bounds",
    sql`${t.maxIssuanceAmount} >= 1 AND ${t.maxIssuanceAmount} <= 1000000`,
  ),
  check(
    "government_issuance_cooldown_bounds",
    sql`${t.issuanceCooldownDays} >= 0 AND ${t.issuanceCooldownDays} <= 365`,
  ),
  check(
    "government_promotion_daily_rate_bounds",
    sql`${t.promotionDailyRate} >= 0 AND ${t.promotionDailyRate} <= 1000000`,
  ),
  check(
    "government_offline_total_allowance_bounds",
    sql`${t.offlineTotalAllowance} >= 0 AND ${t.offlineTotalAllowance} <= 1000000`,
  ),
  check(
    "government_offline_max_per_transaction_bounds",
    sql`${t.offlineMaxPerTransaction} >= 1 AND ${t.offlineMaxPerTransaction} <= 1000000`,
  ),
  check(
    "government_offline_auth_expiry_bounds",
    sql`${t.offlineAuthExpiryMinutes} IS NULL OR (${t.offlineAuthExpiryMinutes} >= 1 AND ${t.offlineAuthExpiryMinutes} <= 43200)`,
  ),
  check(
    "government_max_companies_per_user_bounds",
    sql`${t.maxCompaniesPerUser} >= 1 AND ${t.maxCompaniesPerUser} <= 100`,
  ),
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

  // --- V3: GOVERNMENT BADGES — DECORATION ONLY, NEVER AUTHORITY ------------
  //
  // These two flags are LABELS. They exist so the Government can visibly mark
  // an account, and nothing else. They grant no permission whatsoever:
  //
  //   * Authorization for the Government panel is decided exclusively by the
  //     Government session cookie (src/lib/session.ts + src/lib/auth.ts
  //     `requireGovernment`), which is minted only by a successful
  //     username + password + security-code login against the `government`
  //     row. It never reads the `users` table at all.
  //   * Every user-side capability is decided by `users.status` and wallet
  //     ownership (src/lib/status.ts). No code path anywhere branches on the
  //     two columns below.
  //
  // If you are about to write `if (user.isGovernmentMember) { ...allow... }`,
  // that is a privilege-escalation bug: a badge is not a credential. Grep for
  // these column names before changing this comment — the only readers should
  // be presentation code that renders a badge.
  isOfficialGovernmentUser: boolean("is_official_government_user").notNull().default(false),
  isGovernmentMember: boolean("is_government_member").notNull().default(false),
  badgesUpdatedAt: timestamp("badges_updated_at", { withTimezone: true }),
  badgesUpdatedBy: varchar("badges_updated_by", { length: 64 }),

  // --- V3: PWA offline-payment allowance, spent-to-date ----------------------
  // Lifetime Aeros this user has synced through an offline authorization.
  // Only ever incremented, by a guarded conditional UPDATE inside the same
  // transaction as the real transfer it accompanies (src/lib/offline-auth.ts)
  // — never by issuing a token, only by a payment actually landing. Compared
  // against `government.offline_total_allowance` at issue time (to compute a
  // new token's remaining allowance) and again, live, at every sync.
  offlineAllowanceUsed: integer("offline_allowance_used").notNull().default(0),
}, (t) => ([
  uniqueIndex("users_registration_code_unique").on(t.registrationCodeId),
  check("users_username_lowercase", sql`${t.username} = lower(${t.username})`),
  check("users_balance_nonnegative", sql`${t.balance} >= 0`),
  check("users_offline_allowance_used_nonnegative", sql`${t.offlineAllowanceUsed} >= 0`),
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

  /**
   * V3: REVERSALS ARE NEW ROWS, NEVER EDITS.
   *
   * When a payment has to be undone or corrected, a fresh ledger row is
   * written with type TRANSACTION_REVERSAL / TRANSACTION_ADJUSTMENT and this
   * column pointing at the row it undoes. The original row is never updated
   * and never deleted, so the ledger stays strictly append-only and the
   * audit trail shows both the mistake and the correction.
   */
  reversesTransactionId: uuid("reverses_transaction_id").references(
    (): AnyPgColumn => transactions.id,
  ),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => ([
  check("transactions_gross_positive", sql`${t.grossAmount} >= 1`),
  check("transactions_tax_nonnegative", sql`${t.taxAmount} >= 0`),
  check("transactions_net_nonnegative", sql`${t.netAmount} >= 0`),
  check(
    "transactions_reversal_not_self",
    sql`${t.reversesTransactionId} IS NULL OR ${t.reversesTransactionId} <> ${t.id}`,
  ),
  index("transactions_sender_idx").on(t.senderId),
  index("transactions_receiver_idx").on(t.receiverId),
  index("transactions_created_idx").on(t.createdAt),
  // Narrow: only reversal rows are indexed, so "has this transaction been
  // reversed?" is a single index probe without bloating the main ledger index.
  index("transactions_reverses_idx")
    .on(t.reversesTransactionId)
    .where(sql`${t.reversesTransactionId} IS NOT NULL`),
]));

// ---------------------------------------------------------------------------
// Invoices (V2)
//
// Quoting convention: `subtotal` is the price the company quotes and `total`
// is what the buyer pays - the same number, because the tax is taken out of
// the company's proceeds (net = total - tax) and is never added on top.
// (Invoices issued before that rule had total = subtotal + tax; they still
// pay as quoted.) The ledger row written on payment satisfies the
// system-wide invariant gross = tax + net, with gross = total (buyer paid)
// and net = total - tax (company received).
// ---------------------------------------------------------------------------

export const invoices = pgTable("invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceNumber: varchar("invoice_number", { length: 32 }).notNull().unique(),

  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  /**
   * The user being invoiced. Kept as the ONLY recipient column for
   * `recipientType = 'USER'`, which is every invoice that existed before V3.
   *
   * V3 loosened this from NOT NULL to nullable so a COMPANY or GOVERNMENT
   * recipient is representable. Loosening a constraint rewrites no row and
   * changes no existing value; V2 code always sets it, so V2 invoices are
   * byte-identical.
   */
  buyerUserId: uuid("buyer_user_id").references(() => users.id),

  /**
   * V3: which kind of wallet this invoice is addressed to. Defaults to 'USER'
   * precisely so every pre-V3 row keeps its exact existing meaning.
   */
  recipientType: partyTypeEnum("recipient_type").notNull().default("USER"),
  /** Set only when `recipientType = 'COMPANY'`. */
  recipientCompanyId: uuid("recipient_company_id").references(() => companies.id),

  /**
   * V3: the marketplace order this invoice was raised for, when it came from
   * one. `marketplace_orders.invoice_id` is the authoritative forward link;
   * this is the reverse pointer so an invoice can name its origin.
   */
  sourceOrderId: uuid("source_order_id").references(
    (): AnyPgColumn => marketplaceOrders.id,
  ),

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
  // Exactly one recipient column is populated, and it matches recipientType.
  // Every pre-V3 row satisfies the USER branch unchanged.
  check(
    "invoices_recipient_consistent",
    sql`(${t.recipientType} = 'USER' AND ${t.buyerUserId} IS NOT NULL AND ${t.recipientCompanyId} IS NULL)
     OR (${t.recipientType} = 'COMPANY' AND ${t.recipientCompanyId} IS NOT NULL AND ${t.buyerUserId} IS NULL)
     OR (${t.recipientType} = 'GOVERNMENT' AND ${t.buyerUserId} IS NULL AND ${t.recipientCompanyId} IS NULL)`,
  ),
  index("invoices_company_idx").on(t.companyId),
  index("invoices_buyer_idx").on(t.buyerUserId),
  index("invoices_status_idx").on(t.status),
  // One invoice per marketplace order — a real integrity guarantee, and it
  // doubles as the lookup index for "the invoice for this order".
  uniqueIndex("invoices_source_order_unique")
    .on(t.sourceOrderId)
    .where(sql`${t.sourceOrderId} IS NOT NULL`),
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
  // The real, Government-configurable limit lives on `government.max_issuance_amount`
  // and is enforced in application logic (src/lib/issuance.ts). This check is
  // just a generous sanity ceiling — defense-in-depth, not the source of truth.
  check("issuance_amount_bounds", sql`${t.amount} >= 1 AND ${t.amount} <= 1000000`),
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
  /** V3 gave these two the spec's stated defaults (30d / 7d). A DEFAULT only
   * applies to rows inserted from now on — the live singleton row keeps
   * whatever the Government already configured, so behaviour is unchanged. */
  notificationsRetentionDays: integer("notifications_retention_days").default(30),
  supportRetentionDays: integer("support_retention_days").default(7),
  lastCleanupAt: timestamp("last_cleanup_at", { withTimezone: true }),
  lastCleanupSummary: jsonb("last_cleanup_summary"),

  // --- V2.1: TEXT-FIELD SCRUBBING ---------------------------------------
  // A separate, narrower capability from the row-deletion settings above.
  // This never deletes a row and never touches a financial column (amount,
  // party, id, status, timestamp) — it only blanks specific free-text
  // columns on rows older than the configured age, so storage on Neon's
  // free tier can be trimmed without losing any ledger data. NULL = never
  // scrub that class. See src/lib/retention.ts for exactly which columns
  // each class covers.
  transactionReasonMaxAgeDays: integer("transaction_reason_max_age_days"),
  invoiceTextMaxAgeDays: integer("invoice_text_max_age_days"),
  loanTextMaxAgeDays: integer("loan_text_max_age_days"),
  issuanceNoteMaxAgeDays: integer("issuance_note_max_age_days"),
  lastScrubAt: timestamp("last_scrub_at", { withTimezone: true }),
  lastScrubSummary: jsonb("last_scrub_summary"),

  // --- V3: retention periods for the new temporary V3 data -----------------
  // Each of these targets a table that carries its own createdAt/expiresAt (or
  // a deterministic equivalent), so batched cleanup is a narrow indexed sweep.
  // NULL = never clean that class.
  /** PAUSED marketplace offers are closed out this many days after pausedAt. */
  pausedOfferRetentionDays: integer("paused_offer_retention_days").default(14),
  /** A rating's free-text comment is nulled this long after it was written.
   * The STAR is permanent — only the comment is removed. */
  ratingCommentRetentionDays: integer("rating_comment_retention_days").default(30),
  /** EXPIRED/CANCELLED wanted requests (and their responses) are deleted this
   * many days after they expired. */
  expiredWantedRetentionDays: integer("expired_wanted_retention_days").default(30),
  /** EXPIRED/CANCELLED marketplace orders are deleted this many days after
   * they expired. A PAID or COMPLETED order is financial data and is never
   * deleted by retention. */
  expiredOrderRetentionDays: integer("expired_order_retention_days").default(30),
  /** Idempotency keys are short-lived by design; the table stores its own
   * expiresAt and this is the period used when minting it. */
  idempotencyKeyRetentionDays: integer("idempotency_key_retention_days").default(1),
  /** Applications against an EXPIRED/CANCELLED contract are deleted this many
   * days after the contract closed. The CONTRACT itself is never deleted — it
   * can carry `paid_tx_ref` / `invoice_id` and is therefore financial. */
  expiredContractRetentionDays: integer("expired_contract_retention_days").default(30),
  /** REJECTED/CANCELLED promotion campaigns that were NEVER CHARGED are
   * deleted this many days after they closed. A campaign with
   * `total_charged > 0` has ledger rows behind it and is never deleted. */
  promotionCampaignRetentionDays: integer("promotion_campaign_retention_days").default(90),

  /** V3 Phase I: when the last cleanup run SUCCEEDED (as opposed to merely
   * ran). `lastCleanupAt` is the last attempt; this is the last clean one, so
   * a failing schedule is visible as a widening gap between the two. */
  lastCleanupSuccessAt: timestamp("last_cleanup_success_at", { withTimezone: true }),

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

// ===========================================================================
// V3 — TAX MATRIX
// ===========================================================================
//
// Lets the Government configure a rate per
//   (payer wallet type, recipient wallet type, transaction context)
// combination. Absence is meaningful: a missing row — or a present row whose
// `rateBp` is NULL — means "inherit", and the resolver falls straight back to
// the V2 rules in src/lib/tax.ts (`government.taxRateBp` /
// `government.companyTaxRateBp` / a per-company override).
//
// The table is therefore seeded with NOTHING. An untouched V3 install taxes
// exactly like V2, to the Aero. See src/lib/taxmatrix.ts.
// ===========================================================================

export const taxMatrix = pgTable("tax_matrix", {
  id: uuid("id").primaryKey().defaultRandom(),

  payerType: partyTypeEnum("payer_type").notNull(),
  recipientType: partyTypeEnum("recipient_type").notNull(),
  context: taxContextEnum("context").notNull(),

  /** Basis points (500 = 5.00%). NULL = inherit the V2 fallback. */
  rateBp: integer("rate_bp"),

  note: text("note"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: varchar("updated_by", { length: 64 }),
}, (t) => ([
  // One row per combination. This unique constraint is also the only index the
  // table needs — every read is an exact three-column lookup.
  uniqueIndex("tax_matrix_combo_unique").on(t.payerType, t.recipientType, t.context),
  check(
    "tax_matrix_rate_bounds",
    sql`${t.rateBp} IS NULL OR (${t.rateBp} >= 0 AND ${t.rateBp} <= 10000)`,
  ),
]));

// ===========================================================================
// V3 — IDEMPOTENCY KEYS
// ===========================================================================
//
// One row per retryable financial action. The unique key is what makes a
// second identical request return the FIRST result instead of performing the
// action twice. Rows are short-lived and cleanable by the retention engine
// (see `expiresAt`). See src/lib/idempotency.ts.
// ===========================================================================

export const idempotencyKeys = pgTable("idempotency_keys", {
  id: uuid("id").primaryKey().defaultRandom(),

  /** Client- or server-supplied key, unique across the whole table. */
  key: varchar("key", { length: 120 }).notNull().unique(),
  /** Which action this key belongs to, e.g. "MARKETPLACE_ORDER_PAY". A key is
   * only ever replayed for its own scope. */
  scope: varchar("scope", { length: 64 }).notNull(),

  actorType: partyTypeEnum("actor_type").notNull(),
  /** users.id or companies.id; NULL when the actor is the Government. */
  actorId: uuid("actor_id"),

  /**
   * Hex digest of the server-normalised request facts. A retry that reuses a
   * key with DIFFERENT facts is rejected rather than silently replayed, so a
   * key can never be used to make a payment look like a different one.
   */
  requestHash: varchar("request_hash", { length: 64 }).notNull(),

  status: idempotencyStatusEnum("status").notNull().default("IN_PROGRESS"),

  /** What the first successful call produced, so a replay can return it. */
  resultTxRef: varchar("result_tx_ref", { length: 32 }),
  resultEntityType: varchar("result_entity_type", { length: 48 }),
  resultEntityId: uuid("result_entity_id"),
  /** Set when status = FAILED, for the operator; a FAILED key may be retried. */
  errorMessage: text("error_message"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => ([
  // The only index cleanup needs: "every key already past its expiry".
  index("idempotency_keys_expires_idx").on(t.expiresAt),
]));

// ---------------------------------------------------------------------------
// PWA offline payments — issued offline authorizations (V3)
//
// One row per token issued by `issueOfflineAuthorization` (src/lib/
// offline-auth.ts). `id` IS the token's `jti`: the signed JWT handed to the
// client carries this row's id, so a sync can look the row up directly.
//
// STRUCTURAL SAFETY (matches src/lib/settlement.ts's philosophy, applied with
// a database CHECK rather than a branded type): `consumed_amount` can never
// exceed `allowance_at_issue` for ANY reason, including a future bug in the
// application code that forgets to guard an UPDATE — Postgres itself refuses
// the row. The application also never relies on this constraint alone: every
// increment is its own conditional `UPDATE ... WHERE consumed_amount +
// :amount <= allowance_at_issue`, run inside the SAME transaction as the real
// transfer it authorizes, so the check and the money movement commit or fail
// together (see `consumeOfflineAllowance`).
// ---------------------------------------------------------------------------

export const offlineAuthTokens = pgTable("offline_auth_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),

  /** Snapshot taken at issue: min(government policy, remaining lifetime
   * allowance for this user) at that moment. Immutable afterwards — a later
   * policy change never retroactively changes an already-issued token. */
  allowanceAtIssue: integer("allowance_at_issue").notNull(),
  /** Snapshot of `government.offline_max_per_transaction` at issue. */
  perTransactionMax: integer("per_transaction_max").notNull(),
  /** Running total successfully synced against this token, across every
   * device or sync attempt that ever presents it. */
  consumedAmount: integer("consumed_amount").notNull().default(0),

  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => ([
  check("offline_auth_tokens_allowance_nonnegative", sql`${t.allowanceAtIssue} >= 0`),
  check("offline_auth_tokens_per_tx_max_positive", sql`${t.perTransactionMax} >= 1`),
  check("offline_auth_tokens_consumed_nonnegative", sql`${t.consumedAmount} >= 0`),
  check(
    "offline_auth_tokens_consumed_within_allowance",
    sql`${t.consumedAmount} <= ${t.allowanceAtIssue}`,
  ),
  index("offline_auth_tokens_user_idx").on(t.userId),
]));

// ===========================================================================
// V3 — MARKETPLACE
// ===========================================================================

/** A thing a company offers for sale. */
export const marketplaceOffers = pgTable("marketplace_offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),

  title: varchar("title", { length: 160 }).notNull(),
  description: text("description").notNull(),
  category: varchar("category", { length: 60 }).notNull(),

  unitPrice: integer("unit_price").notNull(),
  /** NULL = unlimited availability. 0 = temporarily out of stock. */
  quantityAvailable: integer("quantity_available"),

  status: marketplaceOfferStatusEnum("status").notNull().default("ACTIVE"),
  /** Set whenever status becomes PAUSED; the deterministic basis for the
   * 14-day paused-offer cleanup rule. Cleared on resume. */
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ([
  check("marketplace_offers_price_positive", sql`${t.unitPrice} >= 1`),
  check(
    "marketplace_offers_quantity_nonnegative",
    sql`${t.quantityAvailable} IS NULL OR ${t.quantityAvailable} >= 0`,
  ),
  // A PAUSED offer must carry the timestamp the 14-day rule is measured from.
  // The reverse is deliberately NOT required: once retention closes a paused
  // offer, `pausedAt` stays on the row as the record of why.
  check(
    "marketplace_offers_paused_at_present",
    sql`${t.status} <> 'PAUSED' OR ${t.pausedAt} IS NOT NULL`,
  ),
  // "My company's offers".
  index("marketplace_offers_company_idx").on(t.companyId),
  // Public browse: newest ACTIVE offers first.
  index("marketplace_offers_browse_idx").on(t.status, t.createdAt),
  // Retention sweep only: paused offers past the 14-day cutoff.
  index("marketplace_offers_paused_idx")
    .on(t.pausedAt)
    .where(sql`${t.status} = 'PAUSED'`),
]));

/** A buyer's order against an offer. Prices are SNAPSHOT at order time. */
export const marketplaceOrders = pgTable("marketplace_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderNumber: varchar("order_number", { length: 32 }).notNull().unique(),

  offerId: uuid("offer_id")
    .notNull()
    .references(() => marketplaceOffers.id),
  /** Snapshot of the offer's owner, so a later company sale cannot rewrite
   * who the order was placed with. */
  sellerCompanyId: uuid("seller_company_id")
    .notNull()
    .references(() => companies.id),

  buyerType: partyTypeEnum("buyer_type").notNull(),
  buyerUserId: uuid("buyer_user_id").references(() => users.id),
  buyerCompanyId: uuid("buyer_company_id").references(() => companies.id),

  quantity: integer("quantity").notNull(),
  /** Snapshots — the price the buyer saw is the price they owe. */
  unitPrice: integer("unit_price").notNull(),
  subtotal: integer("subtotal").notNull(),

  status: marketplaceOrderStatusEnum("status").notNull().default("PENDING"),
  /** Authoritative link to the invoice raised for this order. */
  invoiceId: uuid("invoice_id").references(() => invoices.id),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelReason: text("cancel_reason"),
  /** When an unsettled order lapses. Also the retention basis for expired ones. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => ([
  check("marketplace_orders_quantity_positive", sql`${t.quantity} >= 1`),
  check("marketplace_orders_unit_price_positive", sql`${t.unitPrice} >= 1`),
  check("marketplace_orders_subtotal_matches", sql`${t.subtotal} = ${t.quantity} * ${t.unitPrice}`),
  check(
    "marketplace_orders_buyer_consistent",
    sql`(${t.buyerType} = 'USER' AND ${t.buyerUserId} IS NOT NULL AND ${t.buyerCompanyId} IS NULL)
     OR (${t.buyerType} = 'COMPANY' AND ${t.buyerCompanyId} IS NOT NULL AND ${t.buyerUserId} IS NULL)
     OR (${t.buyerType} = 'GOVERNMENT' AND ${t.buyerUserId} IS NULL AND ${t.buyerCompanyId} IS NULL)`,
  ),
  index("marketplace_orders_offer_idx").on(t.offerId),
  // "Orders for my company" / "my orders", per wallet context.
  index("marketplace_orders_seller_idx").on(t.sellerCompanyId),
  index("marketplace_orders_buyer_user_idx").on(t.buyerUserId),
  index("marketplace_orders_buyer_company_idx").on(t.buyerCompanyId),
  // Expiry sweep: only orders that can still lapse.
  index("marketplace_orders_open_expiry_idx")
    .on(t.expiresAt)
    .where(sql`${t.status} IN ('PENDING', 'ACCEPTED', 'WAITING_FOR_INVOICE', 'PAYMENT_DUE')`),
  // V3 Phase F: the leaderboard's rolling 30-day window
  // (src/lib/leaderboard.ts) scans exactly "COMPLETED orders whose
  // completed_at is inside the window", so the index is partial on that status
  // and holds only the one column the range filter uses. It is narrow on
  // purpose: no leaderboard table exists to read instead, so this window scan
  // is the whole cost of the feature and it is the one query worth an index.
  index("marketplace_orders_completed_idx")
    .on(t.completedAt)
    .where(sql`${t.status} = 'COMPLETED'`),
  // At most one order per invoice (the mirror of invoices_source_order_unique).
  uniqueIndex("marketplace_orders_invoice_unique")
    .on(t.invoiceId)
    .where(sql`${t.invoiceId} IS NOT NULL`),
  // V3 Phase C: NO DUPLICATE ORDERS, guaranteed by Postgres.
  //
  // A buyer may hold at most ONE unsettled order against a given offer. The
  // partial predicate is what makes that a rule about live orders only: once
  // an order reaches PAID, COMPLETED, CANCELLED or EXPIRED it leaves the
  // index, so the same buyer may order the same thing again afterwards.
  //
  // `placeOrder` also serialises on the offer row (SELECT ... FOR UPDATE), so
  // the duplicate is normally refused with a readable message; these indexes
  // are the independent second guarantee that survives any future code path.
  uniqueIndex("marketplace_order_open_user_unique")
    .on(t.offerId, t.buyerUserId)
    .where(
      sql`${t.buyerUserId} IS NOT NULL AND ${t.status} IN ('PENDING', 'ACCEPTED', 'WAITING_FOR_INVOICE', 'PAYMENT_DUE')`,
    ),
  uniqueIndex("marketplace_order_open_company_unique")
    .on(t.offerId, t.buyerCompanyId)
    .where(
      sql`${t.buyerCompanyId} IS NOT NULL AND ${t.status} IN ('PENDING', 'ACCEPTED', 'WAITING_FOR_INVOICE', 'PAYMENT_DUE')`,
    ),
]));

/** "I am looking for X" — a request posted by a user or a company. */
export const marketplaceWantedRequests = pgTable("marketplace_wanted_requests", {
  id: uuid("id").primaryKey().defaultRandom(),

  requesterType: partyTypeEnum("requester_type").notNull(),
  requesterUserId: uuid("requester_user_id").references(() => users.id),
  // Named explicitly: the auto-generated name would exceed Postgres's 63-byte
  // identifier limit and be silently truncated, leaving the migration SQL and
  // the real constraint name disagreeing.
  requesterCompanyId: uuid("requester_company_id"),

  heading: varchar("heading", { length: 160 }).notNull(),
  description: text("description").notNull(),
  category: varchar("category", { length: 60 }).notNull(),
  quantity: integer("quantity").notNull(),
  /** Maximum the requester is willing to pay, in whole Aeros. */
  budget: integer("budget").notNull(),
  deadline: timestamp("deadline", { withTimezone: true }),

  status: wantedRequestStatusEnum("status").notNull().default("OPEN"),
  closedAt: timestamp("closed_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => ([
  check("wanted_requests_quantity_positive", sql`${t.quantity} >= 1`),
  check("wanted_requests_budget_positive", sql`${t.budget} >= 1`),
  check(
    "wanted_requests_requester_consistent",
    sql`(${t.requesterType} = 'USER' AND ${t.requesterUserId} IS NOT NULL AND ${t.requesterCompanyId} IS NULL)
     OR (${t.requesterType} = 'COMPANY' AND ${t.requesterCompanyId} IS NOT NULL AND ${t.requesterUserId} IS NULL)
     OR (${t.requesterType} = 'GOVERNMENT' AND ${t.requesterUserId} IS NULL AND ${t.requesterCompanyId} IS NULL)`,
  ),
  foreignKey({
    name: "wanted_requests_requester_company_fk",
    columns: [t.requesterCompanyId],
    foreignColumns: [companies.id],
  }),
  index("wanted_requests_browse_idx").on(t.status, t.createdAt),
  index("wanted_requests_requester_user_idx").on(t.requesterUserId),
  index("wanted_requests_expiry_idx").on(t.expiresAt).where(sql`${t.status} = 'OPEN'`),
]));

/** A compact reply to a wanted request. */
export const marketplaceWantedResponses = pgTable("marketplace_wanted_responses", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Both of these FKs are named explicitly below: their auto-generated names
  // would exceed Postgres's 63-byte identifier limit.
  requestId: uuid("request_id").notNull(),

  responderType: partyTypeEnum("responder_type").notNull(),
  responderUserId: uuid("responder_user_id").references(() => users.id),
  responderCompanyId: uuid("responder_company_id"),

  message: text("message").notNull(),
  /** Optional quote, in whole Aeros. */
  offeredPrice: integer("offered_price"),

  status: wantedResponseStatusEnum("status").notNull().default("PENDING"),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ([
  check(
    "wanted_responses_price_positive",
    sql`${t.offeredPrice} IS NULL OR ${t.offeredPrice} >= 1`,
  ),
  check(
    "wanted_responses_responder_consistent",
    sql`(${t.responderType} = 'USER' AND ${t.responderUserId} IS NOT NULL AND ${t.responderCompanyId} IS NULL)
     OR (${t.responderType} = 'COMPANY' AND ${t.responderCompanyId} IS NOT NULL AND ${t.responderUserId} IS NULL)
     OR (${t.responderType} = 'GOVERNMENT' AND ${t.responderUserId} IS NULL AND ${t.responderCompanyId} IS NULL)`,
  ),
  foreignKey({
    name: "wanted_responses_request_fk",
    columns: [t.requestId],
    foreignColumns: [marketplaceWantedRequests.id],
  }),
  foreignKey({
    name: "wanted_responses_responder_company_fk",
    columns: [t.responderCompanyId],
    foreignColumns: [companies.id],
  }),
  // V3 Phase I: "every response to this request", which retention needs to
  // delete a lapsed request's responses before the request itself. The two
  // unique indexes below also lead with request_id, but both are PARTIAL on a
  // responder column being non-null, so Postgres cannot use either for a plain
  // request_id probe — this is the index that query actually gets.
  index("wanted_responses_request_idx").on(t.requestId),
  // One response per responder per request.
  uniqueIndex("wanted_response_user_unique")
    .on(t.requestId, t.responderUserId)
    .where(sql`${t.responderUserId} IS NOT NULL`),
  uniqueIndex("wanted_response_company_unique")
    .on(t.requestId, t.responderCompanyId)
    .where(sql`${t.responderCompanyId} IS NOT NULL`),
]));

/** A piece of work put out to tender by the Government or by a company. */
export const marketplaceContracts = pgTable("marketplace_contracts", {
  id: uuid("id").primaryKey().defaultRandom(),
  contractNumber: varchar("contract_number", { length: 32 }).notNull().unique(),

  issuerType: partyTypeEnum("issuer_type").notNull(),
  /** NULL when the issuer is the Government. */
  issuerCompanyId: uuid("issuer_company_id").references(() => companies.id),

  title: varchar("title", { length: 160 }).notNull(),
  requirement: text("requirement").notNull(),
  description: text("description").notNull(),
  conditions: text("conditions"),
  budget: integer("budget").notNull(),
  deadline: timestamp("deadline", { withTimezone: true }),

  status: contractStatusEnum("status").notNull().default("OPEN"),

  awardedToType: partyTypeEnum("awarded_to_type"),
  awardedToUserId: uuid("awarded_to_user_id").references(() => users.id),
  awardedToCompanyId: uuid("awarded_to_company_id").references(() => companies.id),
  awardedAt: timestamp("awarded_at", { withTimezone: true }),

  /**
   * V3 Phase D: the invoice raised against this contract, when the awarded
   * party is a COMPANY and therefore issues one. Phase A shipped no link at
   * all, which left "which invoice settles this contract?" unanswerable from
   * the row; the partial unique index below makes it one invoice per contract.
   * A USER payee cannot issue invoices, so that branch records `paidTxRef`
   * instead.
   */
  invoiceId: uuid("invoice_id").references((): AnyPgColumn => invoices.id),
  /** Ledger reference of the payment that settled this contract. */
  paidTxRef: varchar("paid_tx_ref", { length: 32 }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => ([
  check("contracts_budget_positive", sql`${t.budget} >= 1`),
  check(
    "contracts_issuer_consistent",
    sql`(${t.issuerType} = 'COMPANY' AND ${t.issuerCompanyId} IS NOT NULL)
     OR (${t.issuerType} = 'GOVERNMENT' AND ${t.issuerCompanyId} IS NULL)`,
  ),
  check(
    "contracts_award_consistent",
    sql`(${t.awardedToType} IS NULL AND ${t.awardedToUserId} IS NULL AND ${t.awardedToCompanyId} IS NULL)
     OR (${t.awardedToType} = 'USER' AND ${t.awardedToUserId} IS NOT NULL AND ${t.awardedToCompanyId} IS NULL)
     OR (${t.awardedToType} = 'COMPANY' AND ${t.awardedToCompanyId} IS NOT NULL AND ${t.awardedToUserId} IS NULL)`,
  ),
  index("contracts_browse_idx").on(t.status, t.createdAt),
  index("contracts_issuer_idx").on(t.issuerCompanyId),
  index("contracts_expiry_idx").on(t.expiresAt).where(sql`${t.status} = 'OPEN'`),
  // One invoice per contract, guaranteed by Postgres rather than by a check
  // some caller has to remember (the mirror of invoices_source_order_unique).
  uniqueIndex("contract_invoice_unique")
    .on(t.invoiceId)
    .where(sql`${t.invoiceId} IS NOT NULL`),
]));

/** A compact application against a contract. */
export const marketplaceContractApplications = pgTable(
  "marketplace_contract_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Both of these FKs are named explicitly below: their auto-generated names
    // would exceed Postgres's 63-byte identifier limit.
    contractId: uuid("contract_id").notNull(),

    applicantType: partyTypeEnum("applicant_type").notNull(),
    applicantUserId: uuid("applicant_user_id").references(() => users.id),
    applicantCompanyId: uuid("applicant_company_id"),

    proposal: text("proposal").notNull(),
    /** Optional quote, in whole Aeros. */
    quotedPrice: integer("quoted_price"),

    status: contractApplicationStatusEnum("status").notNull().default("PENDING"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ([
    check(
      "contract_applications_price_positive",
      sql`${t.quotedPrice} IS NULL OR ${t.quotedPrice} >= 1`,
    ),
    check(
      "contract_applications_applicant_consistent",
      sql`(${t.applicantType} = 'USER' AND ${t.applicantUserId} IS NOT NULL AND ${t.applicantCompanyId} IS NULL)
     OR (${t.applicantType} = 'COMPANY' AND ${t.applicantCompanyId} IS NOT NULL AND ${t.applicantUserId} IS NULL)`,
    ),
    foreignKey({
      name: "contract_applications_contract_fk",
      columns: [t.contractId],
      foreignColumns: [marketplaceContracts.id],
    }),
    foreignKey({
      name: "contract_applications_applicant_company_fk",
      columns: [t.applicantCompanyId],
      foreignColumns: [companies.id],
    }),
    // V3 Phase I: "every application against this contract", which retention
    // needs once a contract has been closed long enough. Same reasoning as
    // wanted_responses_request_idx — the two unique indexes below lead with
    // contract_id but are partial, so neither serves a plain probe.
    index("contract_applications_contract_idx").on(t.contractId),
    uniqueIndex("contract_application_user_unique")
      .on(t.contractId, t.applicantUserId)
      .where(sql`${t.applicantUserId} IS NOT NULL`),
    uniqueIndex("contract_application_company_unique")
      .on(t.contractId, t.applicantCompanyId)
      .where(sql`${t.applicantCompanyId} IS NOT NULL`),
  ]),
);

// ===========================================================================
// V3 — PROMOTIONS / ADS
// ===========================================================================
//
// NO ANALYTICS, BY DESIGN AND BY SCHEMA.
//
// There is deliberately no impressions column, no clicks column, no
// dismissals table and no view-event table anywhere in this file. The spec
// forbids storing them, so the only way to keep that promise honestly is for
// the columns not to exist. If a later phase "needs" an impression counter,
// that is a spec change, not a schema oversight.
//
// The single global ACTIVE slot is enforced by the DATABASE, not by
// application code: `promotion_single_active_slot` is a UNIQUE index on
// `status` restricted to rows where status = 'ACTIVE', so a second ACTIVE
// campaign is rejected by Postgres even under a race.
// ===========================================================================

export const promotionCampaigns = pgTable("promotion_campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),

  /** NULL for a Government / system promotion. */
  companyId: uuid("company_id").references(() => companies.id),
  /** Optional marketplace offer the promotion points at. */
  offerId: uuid("offer_id").references(() => marketplaceOffers.id),

  heading: varchar("heading", { length: 160 }).notNull(),
  shortDescription: varchar("short_description", { length: 240 }).notNull(),
  ctaLabel: varchar("cta_label", { length: 48 }).notNull(),
  /** In-app destination path, e.g. "/marketplace/offers/<id>". */
  destination: varchar("destination", { length: 200 }).notNull(),

  requestedDurationDays: integer("requested_duration_days").notNull(),
  /** `government.promotion_daily_rate` frozen at approval, so a later policy
   * change never re-prices a running campaign. */
  dailyRate: integer("daily_rate").notNull(),

  status: promotionStatusEnum("status").notNull().default("PENDING"),

  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewedBy: varchar("reviewed_by", { length: 64 }),
  rejectionReason: text("rejection_reason"),

  activatedAt: timestamp("activated_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),

  /** IST calendar day the daily charge was last applied. A plain `date` so
   * "already charged today (IST)" is one equality test and can never be
   * double-charged by a clock skew. */
  lastChargedOn: date("last_charged_on"),
  totalCharged: integer("total_charged").notNull().default(0),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ([
  check(
    "promotion_duration_bounds",
    sql`${t.requestedDurationDays} >= 1 AND ${t.requestedDurationDays} <= 365`,
  ),
  check("promotion_daily_rate_nonnegative", sql`${t.dailyRate} >= 0`),
  check("promotion_total_charged_nonnegative", sql`${t.totalCharged} >= 0`),
  // ONE global active slot, guaranteed by Postgres.
  uniqueIndex("promotion_single_active_slot")
    .on(t.status)
    .where(sql`${t.status} = 'ACTIVE'`),
  index("promotion_campaigns_company_idx").on(t.companyId),
  // The Government's pending-approval queue.
  index("promotion_campaigns_status_idx").on(t.status, t.createdAt),
]));

// ===========================================================================
// V3 — RATINGS
// ===========================================================================
//
// One rating per eligible completed order. The STAR is permanent; only the
// free-text comment is temporary, and `commentExpiresAt` is the deterministic
// basis the retention engine uses to null it while keeping the star.
// ===========================================================================

export const marketplaceOrderRatings = pgTable("marketplace_order_ratings", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .unique()
    .references(() => marketplaceOrders.id),

  raterType: partyTypeEnum("rater_type").notNull(),
  raterUserId: uuid("rater_user_id").references(() => users.id),
  raterCompanyId: uuid("rater_company_id").references(() => companies.id),

  /** The company being rated (the seller on the order). */
  ratedCompanyId: uuid("rated_company_id")
    .notNull()
    .references(() => companies.id),

  stars: integer("stars").notNull(),
  comment: text("comment"),
  /** Set alongside a non-null comment; NULL when there is no comment. */
  commentExpiresAt: timestamp("comment_expires_at", { withTimezone: true }),
  /** Stamped when retention removed the comment, so the row stays readable as
   * "there was a comment and it has been cleared". */
  commentClearedAt: timestamp("comment_cleared_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ([
  check("ratings_stars_bounds", sql`${t.stars} >= 1 AND ${t.stars} <= 5`),
  check(
    "ratings_comment_expiry_consistent",
    sql`(${t.comment} IS NULL) OR (${t.commentExpiresAt} IS NOT NULL)`,
  ),
  check(
    "ratings_rater_consistent",
    sql`(${t.raterType} = 'USER' AND ${t.raterUserId} IS NOT NULL AND ${t.raterCompanyId} IS NULL)
     OR (${t.raterType} = 'COMPANY' AND ${t.raterCompanyId} IS NOT NULL AND ${t.raterUserId} IS NULL)
     OR (${t.raterType} = 'GOVERNMENT' AND ${t.raterUserId} IS NULL AND ${t.raterCompanyId} IS NULL)`,
  ),
  // Average / count of stars for a company.
  index("ratings_rated_company_idx").on(t.ratedCompanyId),
  // Retention sweep only: comments that still exist and are due for removal.
  index("ratings_comment_expiry_idx")
    .on(t.commentExpiresAt)
    .where(sql`${t.comment} IS NOT NULL`),
]));

// ===========================================================================
// V3 — RECONCILIATION STATUS (single latest-status row, no history)
// ===========================================================================
//
// `reconcile.ts` computes everything on demand and returns it. This table
// exists only so the Government panel can show "last health check: ... ".
// There is deliberately NO history table: a reconciliation result is derived
// data, and keeping snapshots of it would create a second, stale source of
// truth about the ledger.
//
// The `singleton` column plus its CHECK and UNIQUE make "at most one row" a
// database guarantee.
// ===========================================================================

export const reconciliationStatus = pgTable("reconciliation_status", {
  id: uuid("id").primaryKey().defaultRandom(),
  singleton: boolean("singleton").notNull().default(true),

  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull().defaultNow(),
  healthy: boolean("healthy").notNull(),
  checksRun: integer("checks_run").notNull(),
  checksFailed: integer("checks_failed").notNull(),
  /** Comma-separated check keys that failed. Display only — never queried, so
   * it is a plain text field rather than a structured table. */
  failedCheckKeys: text("failed_check_keys"),
  summary: text("summary"),
  ranBy: varchar("ran_by", { length: 64 }),
}, (t) => ([
  check("reconciliation_status_singleton", sql`${t.singleton} = true`),
  check("reconciliation_status_counts_nonnegative", sql`${t.checksRun} >= 0 AND ${t.checksFailed} >= 0`),
  uniqueIndex("reconciliation_status_singleton_unique").on(t.singleton),
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

// --- V3 ---------------------------------------------------------------------
export type TaxMatrixRow = typeof taxMatrix.$inferSelect;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type OfflineAuthToken = typeof offlineAuthTokens.$inferSelect;
export type MarketplaceOffer = typeof marketplaceOffers.$inferSelect;
export type MarketplaceOrder = typeof marketplaceOrders.$inferSelect;
export type MarketplaceWantedRequest = typeof marketplaceWantedRequests.$inferSelect;
export type MarketplaceWantedResponse = typeof marketplaceWantedResponses.$inferSelect;
export type MarketplaceContract = typeof marketplaceContracts.$inferSelect;
export type MarketplaceContractApplication =
  typeof marketplaceContractApplications.$inferSelect;
export type PromotionCampaign = typeof promotionCampaigns.$inferSelect;
export type MarketplaceOrderRating = typeof marketplaceOrderRatings.$inferSelect;
export type ReconciliationStatus = typeof reconciliationStatus.$inferSelect;
