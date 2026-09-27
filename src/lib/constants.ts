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

export const MAX_ISSUANCE_AMOUNT = 5_000;
export const MIN_ISSUANCE_AMOUNT = 1;
export const ISSUANCE_COOLDOWN_DAYS = 7;
export const ISSUANCE_APPROVAL_THRESHOLD = 1; // 100% of eligible active users

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
