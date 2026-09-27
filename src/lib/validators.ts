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

export const createInvoiceSchema = z.object({
  buyerUsername: usernameSchema,
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
});

export const invoiceIdSchema = z.object({
  invoiceId: z.string().uuid(),
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
