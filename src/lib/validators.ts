import { z } from "zod";
import {
  COMPANY_CATEGORY_MAX_LENGTH,
  COMPANY_NAME_MAX_LENGTH,
  COMPANY_NAME_MIN_LENGTH,
  COMPANY_REASON_MAX_LENGTH,
  COMPANY_USERNAME_MAX_LENGTH,
  COMPANY_USERNAME_MIN_LENGTH,
  COMPANY_USERNAME_PATTERN,
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
  GOV_SECURITY_CODE_MIN_LENGTH,
  GOV_SECURITY_CODE_PATTERN,
  INVOICE_DESCRIPTION_MAX_LENGTH,
  INVOICE_ITEM_MAX_LENGTH,
  INVOICE_MAX_QUANTITY,
  INVOICE_MAX_UNIT_PRICE,
  INVOICE_NOTE_MAX_LENGTH,
  IP_COMPLAINT_REASON_MAX_LENGTH,
  IP_COMPLAINT_TEXT_MAX_LENGTH,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  PASSWORD_MIN_LENGTH,
  REGISTRATION_CODE_LENGTH,
  SUPPORT_MESSAGE_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
  // --- V3 ---
  CONTRACT_MAX_BUDGET,
  CONTRACT_PROPOSAL_MAX_LENGTH,
  CONTRACT_TEXT_MAX_LENGTH,
  CONTRACT_TITLE_MAX_LENGTH,
  MARKETPLACE_CATEGORY_MAX_LENGTH,
  MARKETPLACE_DESCRIPTION_MAX_LENGTH,
  MARKETPLACE_MAX_QUANTITY,
  MARKETPLACE_MAX_UNIT_PRICE,
  MARKETPLACE_TITLE_MAX_LENGTH,
  PROMOTION_CTA_MAX_LENGTH,
  PROMOTION_DESCRIPTION_MAX_LENGTH,
  PROMOTION_HEADING_MAX_LENGTH,
  PROMOTION_MAX_DURATION_DAYS,
  WANTED_DESCRIPTION_MAX_LENGTH,
  WANTED_HEADING_MAX_LENGTH,
  WANTED_MAX_BUDGET,
  WANTED_RESPONSE_MAX_LENGTH,
  RATING_COMMENT_MAX_LENGTH,
  RATING_MAX_STARS,
  RATING_MIN_STARS,
} from "./constants";

// Normalizes user-typed usernames to their canonical lowercase form before
// any validation happens, per spec section 5 ("prefer converting input to
// lowercase before final validation").
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export const usernameSchema = z
  .string()
  .trim()
  .transform((v) => v.toLowerCase())
  .pipe(
    z
      .string()
      .min(USERNAME_MIN_LENGTH, `Username must be at least ${USERNAME_MIN_LENGTH} characters.`)
      .max(USERNAME_MAX_LENGTH, `Username must be at most ${USERNAME_MAX_LENGTH} characters.`)
      .regex(
        USERNAME_PATTERN,
        "Username can only contain lowercase letters, numbers, and underscores.",
      ),
  );

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);

export const displayNameSchema = z
  .string()
  .trim()
  .min(DISPLAY_NAME_MIN_LENGTH, "Display name is required.")
  .max(DISPLAY_NAME_MAX_LENGTH, `Display name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters.`);

export const registrationCodeSchema = z
  .string()
  .trim()
  .length(REGISTRATION_CODE_LENGTH, `Registration code must be exactly ${REGISTRATION_CODE_LENGTH} digits.`)
  .regex(/^[0-9]+$/, "Registration code must be numeric.");

export const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
  registrationCode: registrationCodeSchema,
});

export const loginSchema = z.object({
  username: z.string().trim().min(1, "Username is required."),
  password: z.string().min(1, "Password is required."),
});

export const govLoginSchema = z.object({
  username: z.string().trim().min(1, "Username is required."),
  password: z.string().min(1, "Password is required."),
  securityCode: z
    .string()
    .trim()
    .min(
      GOV_SECURITY_CODE_MIN_LENGTH,
      `Security code must be at least ${GOV_SECURITY_CODE_MIN_LENGTH} characters.`,
    )
    .regex(
      GOV_SECURITY_CODE_PATTERN,
      "Security code must be uppercase letters and numbers only.",
    ),
});

export const sendAerosSchema = z.object({
  recipientUsername: usernameSchema,
  amount: z.coerce
    .number()
    .int("Amount must be a whole number.")
    .positive("Amount must be greater than zero."),
});

/** V2 pay form: recipient may be a user, a company, or the Government. */
export const paySchema = z.object({
  recipientUsername: z.string().trim().min(1, "Recipient is required."),
  amount: z.coerce
    .number()
    .int("Amount must be a whole number.")
    .positive("Amount must be greater than zero."),
  note: z.string().trim().max(200).optional().or(z.literal("")),
  toGovernment: z.coerce.boolean().optional(),
});

export const updateDisplayNameSchema = z.object({
  displayName: displayNameSchema,
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Your current password is required."),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1, "Please confirm your new password."),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: "The new passwords do not match.",
    path: ["confirmPassword"],
  });

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export const companyUsernameSchema = z
  .string()
  .trim()
  .transform((v) => v.toLowerCase())
  .pipe(
    z
      .string()
      .min(
        COMPANY_USERNAME_MIN_LENGTH,
        `Company username must be at least ${COMPANY_USERNAME_MIN_LENGTH} characters.`,
      )
      .max(
        COMPANY_USERNAME_MAX_LENGTH,
        `Company username must be at most ${COMPANY_USERNAME_MAX_LENGTH} characters.`,
      )
      .regex(
        COMPANY_USERNAME_PATTERN,
        "Company username can only contain lowercase letters, numbers, and underscores.",
      ),
  );

export const createCompanySchema = z.object({
  name: z
    .string()
    .trim()
    .min(COMPANY_NAME_MIN_LENGTH, "Company name is required.")
    .max(COMPANY_NAME_MAX_LENGTH, `Company name must be at most ${COMPANY_NAME_MAX_LENGTH} characters.`),
  username: companyUsernameSchema,
  category: z
    .string()
    .trim()
    .min(1, "Business category is required.")
    .max(COMPANY_CATEGORY_MAX_LENGTH),
  reason: z
    .string()
    .trim()
    .min(1, "Please say why you are creating this company.")
    .max(COMPANY_REASON_MAX_LENGTH),
  // The 500-word cap is enforced in lib/companies.ts so the error message can
  // report the actual word count.
  description: z.string().trim().min(1, "Company description is required."),
});

export const companyIdSchema = z.object({
  companyId: z.string().uuid(),
});

export const reviewCompanySchema = z.object({
  companyId: z.string().uuid(),
  reason: z.string().trim().max(500).optional().or(z.literal("")),
});

export const rejectCompanySchema = z.object({
  companyId: z.string().uuid(),
  reason: z.string().trim().min(1, "A rejection reason is required.").max(500),
});

export const editCompanySchema = z.object({
  companyId: z.string().uuid(),
  name: z.string().trim().min(COMPANY_NAME_MIN_LENGTH).max(COMPANY_NAME_MAX_LENGTH),
  username: companyUsernameSchema,
  category: z.string().trim().min(1).max(COMPANY_CATEGORY_MAX_LENGTH),
  description: z.string().trim().min(1),
});

export const companyStatusSchema = z.object({
  companyId: z.string().uuid(),
  status: z.enum(["APPROVED", "SUSPENDED", "REVOKED"]),
  reason: z.string().trim().max(500).optional().or(z.literal("")),
  suspendUntilDate: z.string().trim().optional().or(z.literal("")),
  suspendUntilTime: z.string().trim().optional().or(z.literal("")),
});

export const setCompanyTaxSchema = z.object({
  companyId: z.string().uuid(),
  /** Empty string means "use the Government default". */
  taxRatePercent: z.string().trim(),
});

export const adjustCompanyBalanceSchema = z.object({
  companyId: z.string().uuid(),
  direction: z.enum(["CREDIT", "DEBIT"]),
  amount: z.coerce.number().int().positive("Amount must be greater than zero."),
  reason: z.string().trim().min(1, "A reason is required.").max(500),
});

export const switchContextSchema = z.object({
  /** "personal" or a company uuid. */
  context: z.string().trim().min(1),
});

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/**
 * V3: an invoice may be addressed to a user, a company, or the Government.
 * The recipient TYPE is explicit and the username is resolved server-side; for
 * a GOVERNMENT invoice the username is not used at all (the server resolves the
 * Treasury entity), so it may be blank.
 */
export const invoiceRecipientTypeSchema = z.enum(["USER", "COMPANY", "GOVERNMENT"]);

/** A handle as typed: normalized, but not tied to the user/company namespace. */
export const recipientHandleSchema = z
  .string()
  .trim()
  .transform((v) => v.toLowerCase().replace(/^@/, ""));

export const createInvoiceSchema = z
  .object({
    recipientType: invoiceRecipientTypeSchema,
    recipientUsername: recipientHandleSchema,
    itemName: z
      .string()
      .trim()
      .min(1, "Item or service name is required.")
      .max(INVOICE_ITEM_MAX_LENGTH),
    description: z.string().trim().max(INVOICE_DESCRIPTION_MAX_LENGTH).optional().or(z.literal("")),
    quantity: z.coerce
      .number()
      .int("Quantity must be a whole number.")
      .positive("Quantity must be at least 1.")
      .max(INVOICE_MAX_QUANTITY, "Quantity is too large."),
    unitPrice: z.coerce
      .number()
      .int("Unit price must be a whole number.")
      .positive("Unit price must be at least 1 Aeros.")
      .max(INVOICE_MAX_UNIT_PRICE, "Unit price is too large."),
    note: z.string().trim().max(INVOICE_NOTE_MAX_LENGTH).optional().or(z.literal("")),
    dueDate: z.string().trim().optional().or(z.literal("")),
  })
  .refine(
    (v) =>
      v.recipientType === "GOVERNMENT" ||
      (v.recipientUsername.length >= USERNAME_MIN_LENGTH &&
        v.recipientUsername.length <= COMPANY_USERNAME_MAX_LENGTH &&
        USERNAME_PATTERN.test(v.recipientUsername)),
    {
      message: "Enter the recipient's username.",
      path: ["recipientUsername"],
    },
  );

/** Server-side quote preview for the create-invoice form (no money moves). */
export const invoiceQuoteSchema = z.object({
  recipientType: invoiceRecipientTypeSchema,
  recipientUsername: recipientHandleSchema,
  quantity: z.coerce
    .number()
    .int("Quantity must be a whole number.")
    .positive("Quantity must be at least 1.")
    .max(INVOICE_MAX_QUANTITY, "Quantity is too large."),
  unitPrice: z.coerce
    .number()
    .int("Unit price must be a whole number.")
    .positive("Unit price must be at least 1 Aeros.")
    .max(INVOICE_MAX_UNIT_PRICE, "Unit price is too large."),
});

export const invoiceIdSchema = z.object({
  invoiceId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Pay screen — server-side recipient resolution and quoting (spec §10)
// ---------------------------------------------------------------------------

export const resolvePayeeSchema = z.object({
  username: recipientHandleSchema,
  toGovernment: z.coerce.boolean().optional(),
});

export const paymentQuoteSchema = z.object({
  username: recipientHandleSchema,
  toGovernment: z.coerce.boolean().optional(),
  amount: z.coerce
    .number()
    .int("Amount must be a whole number.")
    .positive("Amount must be greater than zero."),
});

// ---------------------------------------------------------------------------
// PWA offline payments (V3)
// ---------------------------------------------------------------------------

/** Government-configurable offline-transaction allowance policy. Empty string
 * for the expiry field means "use the built-in default" — same "" = default
 * convention as the retention/text-scrub forms. */
export const offlinePolicySchema = z.object({
  offlineTransactionsEnabled: z.coerce.boolean(),
  offlineTotalAllowance: z.coerce
    .number()
    .int("Must be a whole number.")
    .min(0, "Must be zero or more.")
    .max(1_000_000, "Must be at most 1,000,000."),
  offlineMaxPerTransaction: z.coerce
    .number()
    .int("Must be a whole number.")
    .min(1, "Must be at least 1.")
    .max(1_000_000, "Must be at most 1,000,000."),
  offlineAuthExpiryMinutes: z.string().trim(),
});

/** What the client presents to sync one queued offline payment. */
export const syncOfflinePaymentSchema = z.object({
  token: z.string().trim().min(10, "Missing offline authorization."),
  clientKey: z.string().uuid("Invalid idempotency key."),
  recipientUsername: recipientHandleSchema,
  amount: z.coerce
    .number()
    .int("Amount must be a whole number.")
    .positive("Amount must be greater than zero."),
  note: z.string().trim().max(200).optional().or(z.literal("")),
  clientTimestamp: z.string().trim().optional(),
});

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

export const supportMessageSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Please type a message.")
    .max(SUPPORT_MESSAGE_MAX_LENGTH, "Message is too long."),
});

export const supportReplySchema = z.object({
  threadId: z.string().uuid(),
  body: z
    .string()
    .trim()
    .min(1, "Please type a reply.")
    .max(SUPPORT_MESSAGE_MAX_LENGTH, "Message is too long."),
});

export const supportStatusSchema = z.object({
  threadId: z.string().uuid(),
  status: z.enum(["OPEN", "WAITING", "RESOLVED"]),
});

// ---------------------------------------------------------------------------
// IP complaints
// ---------------------------------------------------------------------------

export const ipComplaintSchema = z.object({
  accusedCompanyUsername: companyUsernameSchema,
  reason: z
    .string()
    .trim()
    .min(1, "A short reason is required.")
    .max(IP_COMPLAINT_REASON_MAX_LENGTH),
  description: z
    .string()
    .trim()
    .min(1, "Please describe the issue.")
    .max(IP_COMPLAINT_TEXT_MAX_LENGTH),
  evidence: z
    .string()
    .trim()
    .min(1, "Please provide your evidence.")
    .max(IP_COMPLAINT_TEXT_MAX_LENGTH),
  referenceMaterial: z
    .string()
    .trim()
    .max(IP_COMPLAINT_TEXT_MAX_LENGTH)
    .optional()
    .or(z.literal("")),
});

export const ipDecisionSchema = z.object({
  complaintId: z.string().uuid(),
  decision: z.enum([
    "DISMISSED",
    "WARNING",
    "STRIKE",
    "SECOND_STRIKE",
    "TEMPORARY_SUSPENSION",
    "PERMANENT_REVOCATION",
  ]),
  reason: z.string().trim().min(1, "A written reason is required.").max(1000),
  suspendUntilDate: z.string().trim().optional().or(z.literal("")),
  suspendUntilTime: z.string().trim().optional().or(z.literal("")),
});

// ---------------------------------------------------------------------------
// Government-only actions
// ---------------------------------------------------------------------------

export const revokeCodeSchema = z.object({
  codeId: z.string().uuid(),
});

export const adjustBalanceSchema = z.object({
  userId: z.string().uuid(),
  direction: z.enum(["CREDIT", "DEBIT"]),
  amount: z.coerce.number().int().positive("Amount must be greater than zero."),
  reason: z.string().trim().min(1, "A reason is required.").max(500),
});

export const fundUserSchema = z.object({
  userId: z.string().uuid(),
  amount: z.coerce.number().int().positive("Amount must be greater than zero."),
});

/** Government paying any wallet from the treasury (spec §5). */
export const governmentPaymentSchema = z.object({
  recipientUsername: z.string().trim().min(1, "Recipient username is required."),
  amount: z.coerce.number().int().positive("Amount must be greater than zero."),
  reason: z.string().trim().min(1, "A reason is required.").max(500),
});

export const setTaxRateSchema = z.object({
  // Accepts a percentage like "5" or "5.25" and converts to basis points.
  taxRatePercent: z.coerce
    .number()
    .min(0, "Tax rate cannot be negative.")
    .max(100, "Tax rate cannot exceed 100%."),
});

export const suspendUserSchema = z.object({
  userId: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
});

/** Timed suspension (spec §8): an exact date and time the suspension ends. */
export const timedSuspendSchema = z.object({
  userId: z.string().uuid(),
  untilDate: z.string().trim().min(1, "Please choose an end date."),
  untilTime: z.string().trim().min(1, "Please choose an end time."),
  reason: z.string().trim().min(1, "A reason is required.").max(500),
});

export const banUserSchema = z.object({
  userId: z.string().uuid(),
  reason: z.string().trim().min(1, "A reason is required.").max(500),
  confirm: z.string().trim(),
});

export const resetPasswordSchema = z.object({
  userId: z.string().uuid(),
  reason: z.string().trim().min(1, "A reason is required.").max(500),
});

export const issuanceRequestSchema = z.object({
  amount: z.coerce
    .number()
    .int("Amount must be a whole number.")
    .positive("Amount must be greater than zero."),
  reason: z.string().trim().min(1, "A reason is required.").max(1000),
  note: z.string().trim().max(1000).optional().or(z.literal("")),
});

export const issuanceVoteSchema = z.object({
  requestId: z.string().uuid(),
  vote: z.enum(["APPROVE", "REJECT"]),
});

export const publishUpdateSchema = z.object({
  title: z.string().trim().min(1, "Title is required.").max(160),
  content: z.string().trim().min(1, "Content is required.").max(5000),
});

export const retentionSettingsSchema = z.object({
  updatesRetentionDays: z.string().trim(),
  notificationsRetentionDays: z.string().trim(),
  supportRetentionDays: z.string().trim(),
});

/** V3 Phase I: the retention periods for the temporary V3 record classes.
 * Same shape and same "" = keep forever convention as the V2 form above; kept
 * separate so submitting one form can never blank the other's columns. */
export const v3RetentionSettingsSchema = z.object({
  pausedOfferRetentionDays: z.string().trim(),
  ratingCommentRetentionDays: z.string().trim(),
  expiredWantedRetentionDays: z.string().trim(),
  expiredOrderRetentionDays: z.string().trim(),
  expiredContractRetentionDays: z.string().trim(),
  promotionCampaignRetentionDays: z.string().trim(),
  idempotencyKeyRetentionDays: z.string().trim(),
});

/** V2.1: Government-configurable economy policy (funding amount, issuance
 * cap, issuance cooldown) — previously hardcoded constants. */
export const economyPolicySchema = z.object({
  companyApprovalFundingAmount: z.coerce
    .number()
    .int()
    .min(0, "Must be zero or more.")
    .max(1_000_000, "Must be at most 1,000,000."),
  maxIssuanceAmount: z.coerce
    .number()
    .int()
    .min(1, "Must be at least 1.")
    .max(1_000_000, "Must be at most 1,000,000."),
  issuanceCooldownDays: z.coerce
    .number()
    .int()
    .min(0, "Must be zero or more.")
    .max(365, "Must be at most 365."),
});

/** Government-set limit on how many companies one person may own at once. */
export const maxCompaniesPolicySchema = z.object({
  maxCompaniesPerUser: z.coerce
    .number({ error: "Enter a whole number." })
    .int("Enter a whole number.")
    .min(1, "Must be at least 1.")
    .max(100, "Must be at most 100."),
});

/** V2.1: text-field scrubbing ages, one per data class. Empty = never scrub
 * that class. */
export const textScrubSettingsSchema = z.object({
  transactionReasonMaxAgeDays: z.string().trim(),
  invoiceTextMaxAgeDays: z.string().trim(),
  loanTextMaxAgeDays: z.string().trim(),
  issuanceNoteMaxAgeDays: z.string().trim(),
});

export const confirmPhraseSchema = z.object({
  confirm: z.string().trim(),
});

export const archiveAuditSchema = z.object({
  olderThanDays: z.coerce
    .number()
    .int()
    .min(MIN_RETENTION_DAYS)
    .max(MAX_RETENTION_DAYS),
});

export const adminSearchSchema = z.object({
  q: z.string().trim().max(120),
});

/** Parses a date + time pair from the timed-suspension form into a Date. */
export function parseDateTime(date: string, time: string): Date | null {
  if (!date) return null;
  const value = new Date(`${date}T${time || "00:00"}`);
  if (Number.isNaN(value.getTime())) return null;
  return value;
}

// ---------------------------------------------------------------------------
// V3 — marketplace offers and orders (spec §§11,12,13,14)
// ---------------------------------------------------------------------------

/** Blank availability means "unlimited"; a number means a real stock figure. */
const availabilitySchema = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : Math.trunc(Number(v))))
  .refine(
    (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= MARKETPLACE_MAX_QUANTITY),
    "Availability must be a whole number, or blank for unlimited.",
  );

export const offerSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "A title is required.")
    .max(MARKETPLACE_TITLE_MAX_LENGTH, "That title is too long."),
  description: z
    .string()
    .trim()
    .min(1, "A description is required.")
    .max(MARKETPLACE_DESCRIPTION_MAX_LENGTH, "That description is too long."),
  category: z
    .string()
    .trim()
    .min(1, "A category is required.")
    .max(MARKETPLACE_CATEGORY_MAX_LENGTH),
  unitPrice: z.coerce
    .number()
    .int("The price must be a whole number of Aeros.")
    .min(1, "The price must be at least 1 Aeros.")
    .max(MARKETPLACE_MAX_UNIT_PRICE, "That price is too large."),
  quantityAvailable: availabilitySchema,
});

export const offerIdSchema = z.object({ offerId: z.string().uuid() });

export const offerStatusSchema = z.object({
  offerId: z.string().uuid(),
  status: z.enum(["ACTIVE", "PAUSED", "CLOSED"]),
});

export const editOfferSchema = offerSchema.extend({ offerId: z.string().uuid() });

export const placeOrderSchema = z.object({
  offerId: z.string().uuid(),
  quantity: z.coerce
    .number()
    .int("Quantity must be a whole number.")
    .min(1, "Order at least 1.")
    .max(MARKETPLACE_MAX_QUANTITY, "That quantity is too large."),
});

export const orderIdSchema = z.object({ orderId: z.string().uuid() });

export const orderActionSchema = z.object({
  orderId: z.string().uuid(),
  reason: z.string().trim().max(500).optional().or(z.literal("")),
});

export const issueOrderInvoiceSchema = z.object({
  orderId: z.string().uuid(),
  dueDate: z.string().trim().optional().or(z.literal("")),
});

/** Refunds and reversals (spec §18). */
export const reverseTransactionSchema = z.object({
  transactionId: z.string().uuid(),
  reason: z.string().trim().min(1, "A reason is required.").max(500),
  /** Blank means a full reversal. */
  amount: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : Math.trunc(Number(v))))
    .refine((v) => v === null || (Number.isInteger(v) && v >= 1), "Enter a whole number of Aeros."),
});

// ---------------------------------------------------------------------------
// V3 — wanted requests (spec §16)
// ---------------------------------------------------------------------------

export const wantedSchema = z.object({
  heading: z
    .string()
    .trim()
    .min(1, "A heading is required.")
    .max(WANTED_HEADING_MAX_LENGTH, "That heading is too long."),
  description: z
    .string()
    .trim()
    .min(1, "A description is required.")
    .max(WANTED_DESCRIPTION_MAX_LENGTH, "That description is too long."),
  category: z.string().trim().min(1, "A category is required.").max(MARKETPLACE_CATEGORY_MAX_LENGTH),
  quantity: z.coerce
    .number()
    .int("Quantity must be a whole number.")
    .min(1, "Ask for at least 1.")
    .max(MARKETPLACE_MAX_QUANTITY, "That quantity is too large."),
  budget: z.coerce
    .number()
    .int("The budget must be a whole number of Aeros.")
    .min(1, "The budget must be at least 1 Aeros.")
    .max(WANTED_MAX_BUDGET, "That budget is too large."),
  deadline: z.string().trim().optional().or(z.literal("")),
});

export const wantedIdSchema = z.object({ requestId: z.string().uuid() });

export const wantedResponseSchema = z.object({
  requestId: z.string().uuid(),
  message: z
    .string()
    .trim()
    .min(1, "Please say what you can offer.")
    .max(WANTED_RESPONSE_MAX_LENGTH, "That message is too long."),
  offeredPrice: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : Math.trunc(Number(v))))
    .refine(
      (v) => v === null || (Number.isInteger(v) && v >= 1 && v <= WANTED_MAX_BUDGET),
      "A quoted price must be a whole number of at least 1 Aeros.",
    ),
});

export const wantedDecisionSchema = z.object({
  responseId: z.string().uuid(),
  decision: z.enum(["ACCEPTED", "DECLINED"]),
});

export const closeWantedSchema = z.object({
  requestId: z.string().uuid(),
  status: z.enum(["FULFILLED", "CANCELLED"]),
});

// ---------------------------------------------------------------------------
// V3 — contracts (spec §17)
// ---------------------------------------------------------------------------

export const contractSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "A title is required.")
    .max(CONTRACT_TITLE_MAX_LENGTH, "That title is too long."),
  requirement: z
    .string()
    .trim()
    .min(1, "State what is required.")
    .max(CONTRACT_TEXT_MAX_LENGTH, "That requirement is too long."),
  description: z
    .string()
    .trim()
    .min(1, "A description is required.")
    .max(CONTRACT_TEXT_MAX_LENGTH, "That description is too long."),
  conditions: z.string().trim().max(CONTRACT_TEXT_MAX_LENGTH).optional().or(z.literal("")),
  budget: z.coerce
    .number()
    .int("The budget must be a whole number of Aeros.")
    .min(1, "The budget must be at least 1 Aeros.")
    .max(CONTRACT_MAX_BUDGET, "That budget is too large."),
  deadline: z.string().trim().optional().or(z.literal("")),
});

export const contractIdSchema = z.object({ contractId: z.string().uuid() });

export const contractApplicationSchema = z.object({
  contractId: z.string().uuid(),
  proposal: z
    .string()
    .trim()
    .min(1, "Please describe your proposal.")
    .max(CONTRACT_PROPOSAL_MAX_LENGTH, "That proposal is too long."),
  quotedPrice: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : Math.trunc(Number(v))))
    .refine(
      (v) => v === null || (Number.isInteger(v) && v >= 1 && v <= CONTRACT_MAX_BUDGET),
      "A quoted price must be a whole number of at least 1 Aeros.",
    ),
});

export const contractAwardSchema = z.object({
  contractId: z.string().uuid(),
  applicationId: z.string().uuid(),
});

export const contractInvoiceSchema = z.object({
  contractId: z.string().uuid(),
  dueDate: z.string().trim().optional().or(z.literal("")),
});

// ---------------------------------------------------------------------------
// V3 — promotions (spec §24)
// ---------------------------------------------------------------------------

export const promotionRequestSchema = z.object({
  offerId: z.string().uuid("Choose one of your listings."),
  heading: z
    .string()
    .trim()
    .min(1, "A heading is required.")
    .max(PROMOTION_HEADING_MAX_LENGTH, "That heading is too long."),
  shortDescription: z
    .string()
    .trim()
    .min(1, "A short description is required.")
    .max(PROMOTION_DESCRIPTION_MAX_LENGTH, "Keep it under 240 characters."),
  ctaLabel: z.string().trim().max(PROMOTION_CTA_MAX_LENGTH).optional().or(z.literal("")),
  requestedDurationDays: z.coerce
    .number()
    .int("Choose a whole number of days.")
    .min(1, "Run it for at least one day.")
    .max(PROMOTION_MAX_DURATION_DAYS, "That is too long."),
});

export const promotionIdSchema = z.object({ campaignId: z.string().uuid() });

export const promotionReviewSchema = z.object({
  campaignId: z.string().uuid(),
  decision: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().trim().max(500).optional().or(z.literal("")),
});

export const promotionPolicySchema = z.object({
  enabled: z.coerce.boolean().optional(),
  dailyRate: z.coerce
    .number()
    .int("The daily rate must be a whole number of Aeros.")
    .min(0, "The daily rate cannot be negative.")
    .max(1_000_000, "That rate is too large."),
});

export const officialPromotionSchema = z.object({
  kind: z.enum(["NEW_PLAYER_BONUS", "GOVERNMENT_DEMAND", "LIMITED_OPPORTUNITY"]),
  heading: z.string().trim().min(1, "A heading is required.").max(PROMOTION_HEADING_MAX_LENGTH),
  shortDescription: z
    .string()
    .trim()
    .min(1, "A short description is required.")
    .max(PROMOTION_DESCRIPTION_MAX_LENGTH),
  ctaLabel: z.string().trim().max(PROMOTION_CTA_MAX_LENGTH).optional().or(z.literal("")),
  destination: z
    .string()
    .trim()
    .min(1, "A destination path is required.")
    .max(200)
    .refine((v) => v.startsWith("/") && !v.startsWith("//"), "Use an in-app path starting with /."),
  durationDays: z.coerce
    .number()
    .int("Choose a whole number of days.")
    .min(1)
    .max(PROMOTION_MAX_DURATION_DAYS),
});

// ---------------------------------------------------------------------------
// V3 Phase F — ratings and the leaderboard
// ---------------------------------------------------------------------------

/**
 * A rating submission carries only an order id, a star count and an optional
 * comment. There is deliberately no company field and no rater field: the
 * server derives the rated company from the order's own seller column and the
 * rater from the session's acting wallet (src/lib/ratings.ts).
 */
export const rateOrderSchema = z.object({
  orderId: z.string().uuid(),
  stars: z.coerce
    .number()
    .int("Choose a whole number of stars.")
    .min(RATING_MIN_STARS, `Choose between ${RATING_MIN_STARS} and ${RATING_MAX_STARS} stars.`)
    .max(RATING_MAX_STARS, `Choose between ${RATING_MIN_STARS} and ${RATING_MAX_STARS} stars.`),
  comment: z
    .string()
    .trim()
    .max(RATING_COMMENT_MAX_LENGTH, "That comment is too long.")
    .optional()
    .or(z.literal("")),
});

export const leaderboardSortSchema = z.enum(["orders", "sales", "rating", "activity"]);

// ---------------------------------------------------------------------------
// V3 Phase G — Government badges
// ---------------------------------------------------------------------------

/**
 * The two identity labels, as a pair. Sending both flags every time makes the
 * form idempotent (it sets a state rather than toggling one) and keeps the
 * audit row's before/after readable.
 *
 * These are LABELS. Nothing in the app reads them to decide what anyone may
 * do — see the comment at the top of src/lib/badges.ts.
 */
/** A checkbox or hidden flag from a form. `Boolean("false")` is true, so the
 * accepted true values are spelled out rather than coerced. */
const formFlagSchema = z
  .union([z.boolean(), z.string(), z.null(), z.undefined()])
  .transform((v) => v === true || v === "1" || v === "true" || v === "on" || v === "yes");

export const userBadgesSchema = z.object({
  userId: z.string().uuid(),
  official: formFlagSchema,
  member: formFlagSchema,
});
