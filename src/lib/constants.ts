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
