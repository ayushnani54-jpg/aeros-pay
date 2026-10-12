// Central constants for game-economy rules. Keeping these in one place makes
// the "do not silently change a core rule" requirement easy to audit.

export const CURRENCY_NAME = "Aeros";
export const APP_NAME = "Aeros Pay";

export const INITIAL_GOVERNMENT_TREASURY = 10_000;
export const NEW_USER_FUNDING_AMOUNT = 2_000;

export const MIN_TRANSACTION_AMOUNT = 1;
export const TAX_FREE_AMOUNT_THRESHOLD = 1; // exactly 1 Aeros is always tax-free

export const DEFAULT_TAX_RATE_BP = 500; // 5.00%
export const MAX_TAX_RATE_BP = 10000; // 100%
export const MIN_TAX_RATE_BP = 0;

/** V2.1: no longer the runtime source of truth. The live value is
 * `government.max_issuance_amount`, editable from the Government panel
 * (src/app/gov/tax). This constant only seeds that column's default (see
 * drizzle/0004_configurable_policy.sql) and is kept here for reference. */
export const MAX_ISSUANCE_AMOUNT = 10_000;
export const MIN_ISSUANCE_AMOUNT = 1;
/** V2.1: no longer the runtime source of truth. The live value is
 * `government.issuance_cooldown_days`, editable from the Government panel
 * (src/app/gov/tax). This constant only seeds that column's default (see
 * drizzle/0004_configurable_policy.sql) and is kept here for reference. */
export const ISSUANCE_COOLDOWN_DAYS = 1;

export const REGISTRATION_CODE_LENGTH = 4;

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 24;
export const USERNAME_PATTERN = /^[a-z0-9_]+$/; // normalized lowercase, digits, underscore

export const PASSWORD_MIN_LENGTH = 8;

export const DISPLAY_NAME_MIN_LENGTH = 1;
export const DISPLAY_NAME_MAX_LENGTH = 60;

export const GOV_SECURITY_CODE_MIN_LENGTH = 5;
export const GOV_SECURITY_CODE_PATTERN = /^[A-Z0-9]+$/;

export const USER_SESSION_COOKIE = "aeros_session";
export const GOV_SESSION_COOKIE = "aeros_gov_session";

export const USER_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days
export const GOV_SESSION_MAX_AGE_SECONDS = 60 * 60 * 8; // 8 hours (tighter for admin)

// ---------------------------------------------------------------------------
// V2 — companies
// ---------------------------------------------------------------------------

/** Aeros the Government funds a company with on approval (from the treasury —
 * this is a transfer, never newly created supply).
 *
 * V2.1: this is no longer the runtime source of truth. The live value is
 * `government.company_approval_funding_amount`, editable from the Government
 * panel (src/app/gov/tax). This constant only seeds that column's default
 * (see drizzle/0004_configurable_policy.sql) and is kept here for reference. */
export const COMPANY_APPROVAL_FUNDING_AMOUNT = 3_000;

/** Default tax rate applied to company transactions when the Government has
 * not set a company-specific rate. Configurable from the Government panel. */
export const DEFAULT_COMPANY_TAX_RATE_BP = 500; // 5.00%

export const COMPANY_NAME_MIN_LENGTH = 2;
export const COMPANY_NAME_MAX_LENGTH = 80;

export const COMPANY_USERNAME_MIN_LENGTH = 3;
export const COMPANY_USERNAME_MAX_LENGTH = 24;
export const COMPANY_USERNAME_PATTERN = /^[a-z0-9_]+$/;

export const COMPANY_CATEGORY_MAX_LENGTH = 60;
export const COMPANY_REASON_MAX_LENGTH = 1_000;

/** Hard cap on the company description, enforced server-side (spec §14). */
export const COMPANY_DESCRIPTION_MAX_WORDS = 500;

/** Cookie holding the active company context for a logged-in user. It is only
 * ever a hint: the server re-verifies ownership and approval on every use, so
 * forging this cookie grants nothing. */
export const COMPANY_CONTEXT_COOKIE = "aeros_ctx";

// ---------------------------------------------------------------------------
// V2 — invoices
// ---------------------------------------------------------------------------

export const INVOICE_ITEM_MAX_LENGTH = 160;
export const INVOICE_DESCRIPTION_MAX_LENGTH = 1_000;
export const INVOICE_NOTE_MAX_LENGTH = 500;
export const INVOICE_MAX_QUANTITY = 100_000;
export const INVOICE_MAX_UNIT_PRICE = 1_000_000;

// ---------------------------------------------------------------------------
// V2 — support & IP
// ---------------------------------------------------------------------------

export const SUPPORT_MESSAGE_MAX_LENGTH = 2_000;
export const IP_COMPLAINT_REASON_MAX_LENGTH = 160;
export const IP_COMPLAINT_TEXT_MAX_LENGTH = 2_000;

/** Strike count at which a company is automatically flagged for Government
 * attention. Enforcement itself always stays a manual Government decision —
 * there is deliberately no automatic "more sales wins" rule (spec §46). */
export const IP_STRIKE_REVIEW_THRESHOLD = 2;

// ---------------------------------------------------------------------------
// V2 — data retention
// ---------------------------------------------------------------------------

/** Data classes the Government may set a retention period for. Financial
 * ledger data is deliberately absent: transactions are never auto-deleted
 * (spec §50). */
export const RETENTION_CLASSES = [
  "UPDATES",
  "NOTIFICATIONS",
  "SUPPORT_MESSAGES",
] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

/** Phrase the Government must type to confirm a destructive maintenance
 * action. */
export const MAINTENANCE_CONFIRM_PHRASE = "CONFIRM CLEANUP";

// ---------------------------------------------------------------------------
// V3 — marketplace (offers, orders), wanted requests, contracts, promotions
// ---------------------------------------------------------------------------

export const MARKETPLACE_TITLE_MAX_LENGTH = 160;
export const MARKETPLACE_DESCRIPTION_MAX_LENGTH = 2_000;
export const MARKETPLACE_CATEGORY_MAX_LENGTH = 60;
export const MARKETPLACE_MAX_UNIT_PRICE = 1_000_000;
export const MARKETPLACE_MAX_QUANTITY = 100_000;

/** Days an unsettled order stays live before it lapses. */
export const MARKETPLACE_ORDER_EXPIRY_DAYS = 7;
export const MARKETPLACE_BROWSE_PAGE_SIZE = 12;

/**
 * The order statuses that can still change on their own — the ones an expiry
 * sweep, a cancellation or an invoice can act on. PAID, COMPLETED, CANCELLED
 * and EXPIRED are deliberately absent: they are terminal, and the partial
 * unique indexes that stop duplicate orders use exactly this set.
 */
export const MARKETPLACE_OPEN_ORDER_STATUSES = [
  "PENDING",
  "ACCEPTED",
  "WAITING_FOR_INVOICE",
  "PAYMENT_DUE",
] as const;

export const WANTED_HEADING_MAX_LENGTH = 160;
export const WANTED_DESCRIPTION_MAX_LENGTH = 2_000;
export const WANTED_RESPONSE_MAX_LENGTH = 1_000;
/** Days a wanted request stays OPEN before it lapses. */
export const WANTED_EXPIRY_DAYS = 30;
export const WANTED_MAX_BUDGET = 1_000_000;

export const CONTRACT_TITLE_MAX_LENGTH = 160;
export const CONTRACT_TEXT_MAX_LENGTH = 2_000;
export const CONTRACT_PROPOSAL_MAX_LENGTH = 2_000;
export const CONTRACT_MAX_BUDGET = 1_000_000;
/** Days a contract stays OPEN for applications before it lapses. */
export const CONTRACT_EXPIRY_DAYS = 30;

export const PROMOTION_HEADING_MAX_LENGTH = 160;
export const PROMOTION_DESCRIPTION_MAX_LENGTH = 240;
export const PROMOTION_CTA_MAX_LENGTH = 48;
export const PROMOTION_MAX_DURATION_DAYS = 365;
/** Seeds `government.promotion_daily_rate`; the live value is that column. */
export const PROMOTION_DEFAULT_DAILY_RATE = 50;

/**
 * The official promotions the Government may run itself. No company, no
 * charge — the Treasury is not billing itself.
 */
export const OFFICIAL_PROMOTION_KINDS = [
  "NEW_PLAYER_BONUS",
  "GOVERNMENT_DEMAND",
  "LIMITED_OPPORTUNITY",
] as const;
export type OfficialPromotionKind = (typeof OFFICIAL_PROMOTION_KINDS)[number];

// ---------------------------------------------------------------------------
// V3 — ratings, leaderboard, QR (Phase F)
// ---------------------------------------------------------------------------

export const RATING_MIN_STARS = 1;
export const RATING_MAX_STARS = 5;
export const RATING_COMMENT_MAX_LENGTH = 500;

/** Fallback for `retention_settings.rating_comment_retention_days`, which is
 * the live value. The STAR is permanent; only the comment expires. */
export const RATING_COMMENT_RETENTION_DAYS = 30;

/**
 * The leaderboard is a ROLLING WINDOW, computed live on every view.
 *
 * There is deliberately no snapshot table, no daily rollup row and no
 * per-user analytics row anywhere — see src/lib/leaderboard.ts (spec §23).
 */
export const LEADERBOARD_WINDOW_DAYS = 30;
export const LEADERBOARD_SIZE = 20;

/** Pixel size of the inline company QR code. */
export const COMPANY_QR_PIXEL_SIZE = 220;

// ---------------------------------------------------------------------------
// V3 — payment sound (Phase H, spec §27)
// ---------------------------------------------------------------------------

/**
 * localStorage key holding the per-browser "play the success sound" choice.
 *
 * Per-browser ON PURPOSE. There is no column for this on `users`: a sound
 * preference is not account data, storing it would make it something the
 * Government could read, and it would then also have to be retained and
 * reconciled. `localStorage` is exactly the right scope for it.
 */
export const PAYMENT_SOUND_STORAGE_KEY = "aeros_payment_sound";

// ---------------------------------------------------------------------------
// V4 — Aeros Exchange, Synthetic Market, Refund Center & Archive Center
// ---------------------------------------------------------------------------

export const DEFAULT_EXCHANGE_DISCLOSURE =
  "Aeros is a private virtual-economy unit used solely inside Aeros Pay. It is not legal tender, not a cryptocurrency, and not guaranteed to be redeemable for INR.";

export const DEFAULT_MARKET_DISCLOSURE =
  "The Aeros Market Index (AMI) is an internally generated, deterministic synthetic index within the private Aeros Pay economy. It is not a real-world financial instrument, security, or cryptocurrency feed.";

export const MARKET_METHODOLOGY_VERSION = "V4-SYNTH-1.0";
export const MARKET_TIMEFRAMES = ["5m", "15m", "1h"] as const;
export type MarketTimeframe = (typeof MARKET_TIMEFRAMES)[number];
export const DEFAULT_MARKET_TIMEFRAME: MarketTimeframe = "15m";

/** Explicit confirmation phrase required before clearing verified archives. */
export const ARCHIVE_CLEAR_CONFIRM_PHRASE = "CONFIRM ARCHIVE CLEAR";

export const ARCHIVE_DATASET_KEYS = [
  "transactions_history",
  "settled_market_orders",
  "closed_refunds",
  "old_market_candles",
  "settled_contracts",
  "repaid_loans",
  "settled_invoices",
  "completed_marketplace_orders",
  "closed_company_sales",
  "closed_exchange_purchases",
  "audit_logs_history",
] as const;
export type ArchiveDatasetKey = (typeof ARCHIVE_DATASET_KEYS)[number];

// ---------------------------------------------------------------------------
// V4.1 — 5-Repository GitHub Permanent Archive Architecture & 24h Workflow
// ---------------------------------------------------------------------------

export const GITHUB_ARCHIVE_REPO_KEYS = [
  "aeros-archive-ledger",
  "aeros-archive-contracts",
  "aeros-archive-market",
  "aeros-archive-economy",
  "aeros-archive-audit",
] as const;
export type GithubArchiveRepoKey = (typeof GITHUB_ARCHIVE_REPO_KEYS)[number];

export const GITHUB_ARCHIVE_REPOS: Record<
  GithubArchiveRepoKey,
  {
    repoKey: GithubArchiveRepoKey;
    defaultRepoName: string;
    envVarName: string;
    title: string;
    description: string;
    datasets: readonly ArchiveDatasetKey[];
  }
> = {
  "aeros-archive-ledger": {
    repoKey: "aeros-archive-ledger",
    defaultRepoName: "aeros-archive-ledger",
    envVarName: "GITHUB_REPO_LEDGER",
    title: "Repository 1 — Ledger & Settlements Archive",
    description:
      "Completed transfers, tax records, fee settlements, closed refunds, and credited/closed Exchange acquisitions.",
    datasets: ["transactions_history", "closed_refunds", "closed_exchange_purchases"],
  },
  "aeros-archive-contracts": {
    repoKey: "aeros-archive-contracts",
    defaultRepoName: "aeros-archive-contracts",
    envVarName: "GITHUB_REPO_CONTRACTS",
    title: "Repository 2 — Contracts & Loans Archive",
    description:
      "Completed/expired contracts, contract applications, repaid/closed company loans, and instalment schedules.",
    datasets: ["settled_contracts", "repaid_loans"],
  },
  "aeros-archive-market": {
    repoKey: "aeros-archive-market",
    defaultRepoName: "aeros-archive-market",
    envVarName: "GITHUB_REPO_MARKET",
    title: "Repository 3 — Synthetic Market & Trading Archive",
    description:
      "Historical 5m/15m/1h OHLCV candles, executed BUY/SELL/SHORT/COVER orders, and closed position settlements.",
    datasets: ["settled_market_orders", "old_market_candles"],
  },
  "aeros-archive-economy": {
    repoKey: "aeros-archive-economy",
    defaultRepoName: "aeros-archive-economy",
    envVarName: "GITHUB_REPO_ECONOMY",
    title: "Repository 4 — Commercial Economy Archive",
    description:
      "Paid/cancelled/expired invoices, completed/closed marketplace orders, and closed company sale listings/offers.",
    datasets: [
      "settled_invoices",
      "completed_marketplace_orders",
      "closed_company_sales",
    ],
  },
  "aeros-archive-audit": {
    repoKey: "aeros-archive-audit",
    defaultRepoName: "aeros-archive-audit",
    envVarName: "GITHUB_REPO_AUDIT",
    title: "Repository 5 — Government & System Audit Archive",
    description:
      "Administrative actions, policy changes, reconciliation history, and archive verification events.",
    datasets: ["audit_logs_history"],
  },
};

export const DATASET_TO_GITHUB_REPO: Record<ArchiveDatasetKey, GithubArchiveRepoKey> = {
  transactions_history: "aeros-archive-ledger",
  closed_refunds: "aeros-archive-ledger",
  closed_exchange_purchases: "aeros-archive-ledger",
  settled_contracts: "aeros-archive-contracts",
  repaid_loans: "aeros-archive-contracts",
  settled_market_orders: "aeros-archive-market",
  old_market_candles: "aeros-archive-market",
  settled_invoices: "aeros-archive-economy",
  completed_marketplace_orders: "aeros-archive-economy",
  closed_company_sales: "aeros-archive-economy",
  audit_logs_history: "aeros-archive-audit",
};

/** Default 24-hour eligibility window before terminal records are archived to GitHub. */
export const DEFAULT_GITHUB_ARCHIVE_MIN_AGE_HOURS = 24;

/** Conservative GitHub repository storage limits (400 MB soft warning, 750 MB hard shard rotation). */
export const GITHUB_REPO_WARNING_BYTES = 400 * 1024 * 1024; // 419,430,400 bytes
export const GITHUB_REPO_HARD_LIMIT_BYTES = 750 * 1024 * 1024; // 786,432,000 bytes
export const GITHUB_BATCH_MAX_RECORDS = 500;

// ---------------------------------------------------------------------------
// V5 — 15 Dedicated Private GitHub Historical Archive Repositories (900 MB Threshold)
// ---------------------------------------------------------------------------

export const GITHUB_ARCHIVE_REPO_KEYS_V5 = [
  "aeros-archive-market-index",
  "aeros-archive-trading-ledger",
  "aeros-archive-payments",
  "aeros-archive-exchange",
  "aeros-archive-refunds",
  "aeros-archive-marketplace-listings",
  "aeros-archive-marketplace-orders",
  "aeros-archive-jobs",
  "aeros-archive-contracts",
  "aeros-archive-company-partnerships",
  "aeros-archive-company-finances",
  "aeros-archive-loans",
  "aeros-archive-media",
  "aeros-archive-government",
  "aeros-archive-audit",
] as const;
export type GithubArchiveRepoKeyV5 = (typeof GITHUB_ARCHIVE_REPO_KEYS_V5)[number];

export const ARCHIVE_DATASET_KEYS_V5 = [
  "old_market_candles",
  "settled_market_orders",
  "transactions_history",
  "closed_exchange_purchases",
  "closed_refunds",
  "closed_marketplace_listings",
  "completed_marketplace_orders",
  "completed_jobs",
  "settled_contracts",
  "settled_partnerships",
  "settled_invoices",
  "repaid_loans",
  "archived_media_posts",
  "government_decisions",
  "audit_logs_history",
] as const;
export type ArchiveDatasetKeyV5 = (typeof ARCHIVE_DATASET_KEYS_V5)[number];

export const GITHUB_ARCHIVE_REPOS_V5: Record<
  GithubArchiveRepoKeyV5,
  {
    repoKey: GithubArchiveRepoKeyV5;
    defaultRepoName: string;
    envVarName: string;
    title: string;
    description: string;
    datasets: readonly string[];
  }
> = {
  "aeros-archive-market-index": {
    repoKey: "aeros-archive-market-index",
    defaultRepoName: "aeros-archive-market-index",
    envVarName: "GITHUB_REPO_MARKET_INDEX",
    title: "Repository 1 — Market Index Archive",
    description: "Historical 5m, 15m, and 1h OHLCV candles, price snapshots, and AMI index records.",
    datasets: ["old_market_candles"],
  },
  "aeros-archive-trading-ledger": {
    repoKey: "aeros-archive-trading-ledger",
    defaultRepoName: "aeros-archive-trading-ledger",
    envVarName: "GITHUB_REPO_TRADING_LEDGER",
    title: "Repository 2 — Trading Ledger Archive",
    description: "Closed hedge-style trading positions, execution orders, and realized P&L settlements.",
    datasets: ["settled_market_orders"],
  },
  "aeros-archive-payments": {
    repoKey: "aeros-archive-payments",
    defaultRepoName: "aeros-archive-payments",
    envVarName: "GITHUB_REPO_PAYMENTS",
    title: "Repository 3 — Payments & Transfers Archive",
    description: "Settled P2P transfers, user-to-company transactions, and tax deductions.",
    datasets: ["transactions_history"],
  },
  "aeros-archive-exchange": {
    repoKey: "aeros-archive-exchange",
    defaultRepoName: "aeros-archive-exchange",
    envVarName: "GITHUB_REPO_EXCHANGE",
    title: "Repository 4 — Aeros Exchange Archive",
    description: "Settled INR-to-Aeros package acquisitions and immutable policy snapshots.",
    datasets: ["closed_exchange_purchases"],
  },
  "aeros-archive-refunds": {
    repoKey: "aeros-archive-refunds",
    defaultRepoName: "aeros-archive-refunds",
    envVarName: "GITHUB_REPO_REFUNDS",
    title: "Repository 5 — Virtual Refunds Archive",
    description: "Resolved virtual refund claims, clawbacks, and Government refund determinations.",
    datasets: ["closed_refunds"],
  },
  "aeros-archive-marketplace-listings": {
    repoKey: "aeros-archive-marketplace-listings",
    defaultRepoName: "aeros-archive-marketplace-listings",
    envVarName: "GITHUB_REPO_MARKETPLACE_LISTINGS",
    title: "Repository 6 — Marketplace Listings Archive",
    description: "Expired or closed public listings, buyer wanted requests, and seller promotions.",
    datasets: ["closed_marketplace_listings"],
  },
  "aeros-archive-marketplace-orders": {
    repoKey: "aeros-archive-marketplace-orders",
    defaultRepoName: "aeros-archive-marketplace-orders",
    envVarName: "GITHUB_REPO_MARKETPLACE_ORDERS",
    title: "Repository 7 — Marketplace Orders Archive",
    description: "Settled escrow orders, buyer ratings, and order delivery confirmations.",
    datasets: ["completed_marketplace_orders"],
  },
  "aeros-archive-jobs": {
    repoKey: "aeros-archive-jobs",
    defaultRepoName: "aeros-archive-jobs",
    envVarName: "GITHUB_REPO_JOBS",
    title: "Repository 8 — Jobs & Employment Archive",
    description: "Completed citizen employment jobs, accepted applications, and milestone disbursements.",
    datasets: ["completed_jobs"],
  },
  "aeros-archive-contracts": {
    repoKey: "aeros-archive-contracts",
    defaultRepoName: "aeros-archive-contracts",
    envVarName: "GITHUB_REPO_CONTRACTS",
    title: "Repository 9 — Contracts Archive",
    description: "Completed milestone and bounty contracts, submissions, and award records.",
    datasets: ["settled_contracts"],
  },
  "aeros-archive-company-partnerships": {
    repoKey: "aeros-archive-company-partnerships",
    defaultRepoName: "aeros-archive-company-partnerships",
    envVarName: "GITHUB_REPO_PARTNERSHIPS",
    title: "Repository 10 — Company Partnerships Archive",
    description: "Approved inter-company agreements, 50/50 profit distributions, and settlement audits.",
    datasets: ["settled_partnerships"],
  },
  "aeros-archive-company-finances": {
    repoKey: "aeros-archive-company-finances",
    defaultRepoName: "aeros-archive-company-finances",
    envVarName: "GITHUB_REPO_COMPANY_FINANCES",
    title: "Repository 11 — Company Finances Archive",
    description: "Paid itemized invoices, company acquisition records, and transfer agreements.",
    datasets: ["settled_invoices"],
  },
  "aeros-archive-loans": {
    repoKey: "aeros-archive-loans",
    defaultRepoName: "aeros-archive-loans",
    envVarName: "GITHUB_REPO_LOANS",
    title: "Repository 12 — Government Loans Archive",
    description: "Fully repaid or restructured company loans, instalment schedules, and audit records.",
    datasets: ["repaid_loans"],
  },
  "aeros-archive-media": {
    repoKey: "aeros-archive-media",
    defaultRepoName: "aeros-archive-media",
    envVarName: "GITHUB_REPO_MEDIA",
    title: "Repository 13 — Aeros Media Archive",
    description: "Historical social posts exceeding 7-day public retention, comments, and moderation logs.",
    datasets: ["archived_media_posts"],
  },
  "aeros-archive-government": {
    repoKey: "aeros-archive-government",
    defaultRepoName: "aeros-archive-government",
    envVarName: "GITHUB_REPO_GOVERNMENT",
    title: "Repository 14 — Government Decisions Archive",
    description: "Administrative policy updates, tax matrix revisions, and monetary issuance voting.",
    datasets: ["government_decisions"],
  },
  "aeros-archive-audit": {
    repoKey: "aeros-archive-audit",
    defaultRepoName: "aeros-archive-audit",
    envVarName: "GITHUB_REPO_AUDIT",
    title: "Repository 15 — System Audit Archive",
    description: "System audit events, security validations, and archive verification checkpoints.",
    datasets: ["audit_logs_history"],
  },
};

export const DATASET_TO_GITHUB_REPO_V5: Record<ArchiveDatasetKeyV5, GithubArchiveRepoKeyV5> = {
  old_market_candles: "aeros-archive-market-index",
  settled_market_orders: "aeros-archive-trading-ledger",
  transactions_history: "aeros-archive-payments",
  closed_exchange_purchases: "aeros-archive-exchange",
  closed_refunds: "aeros-archive-refunds",
  closed_marketplace_listings: "aeros-archive-marketplace-listings",
  completed_marketplace_orders: "aeros-archive-marketplace-orders",
  completed_jobs: "aeros-archive-jobs",
  settled_contracts: "aeros-archive-contracts",
  settled_partnerships: "aeros-archive-company-partnerships",
  settled_invoices: "aeros-archive-company-finances",
  repaid_loans: "aeros-archive-loans",
  archived_media_posts: "aeros-archive-media",
  government_decisions: "aeros-archive-government",
  audit_logs_history: "aeros-archive-audit",
};

/** V5 Operating Threshold: 900 MB hard limit, 800 MB warning (approaching threshold) */
export const GITHUB_V5_REPO_WARNING_BYTES = 800 * 1024 * 1024; // 838,860,800 bytes
export const GITHUB_V5_REPO_HARD_LIMIT_BYTES = 900 * 1024 * 1024; // 943,718,400 bytes

// V5 Market Update Intervals (1 minute default, 5 minutes option)
export const MARKET_UPDATE_INTERVALS = [1, 5] as const;
export type MarketUpdateInterval = (typeof MARKET_UPDATE_INTERVALS)[number];
export const DEFAULT_MARKET_UPDATE_INTERVAL: MarketUpdateInterval = 1;

// V5 Leverage Progression (2x -> 4x -> 8x -> 10x, maximum 10x)
export const LEVERAGE_LEVELS = [2, 4, 8, 10] as const;
export type LeverageLevel = (typeof LEVERAGE_LEVELS)[number];
export const DEFAULT_LEVERAGE: LeverageLevel = 2;
export const MAX_LEVERAGE: LeverageLevel = 10;

// V5 Jobs
export const JOB_TITLE_MAX_LENGTH = 160;
export const JOB_DESCRIPTION_MAX_LENGTH = 2000;
export const JOB_REQUIREMENTS_MAX_LENGTH = 1000;
export const JOB_MAX_COMPENSATION = 1_000_000;

// V5 Company Partnerships
export const PARTNERSHIP_TITLE_MAX_LENGTH = 160;
export const PARTNERSHIP_TERMS_MAX_LENGTH = 2000;
export const DEFAULT_PARTNERSHIP_SHARE_BP = 5000; // 50.00%
export const DEFAULT_PARTNERSHIP_TAX_RATE_BP = 500; // 5.00%

// V5 Aeros Media (Text-Only, 7-Day Public Retention)
export const MEDIA_POST_MAX_LENGTH = 500;
export const MEDIA_COMMENT_MAX_LENGTH = 300;
export const MEDIA_RETENTION_DAYS = 7;


