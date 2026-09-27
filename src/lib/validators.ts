import { z } from "zod";
import {
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
  GOV_SECURITY_CODE_MIN_LENGTH,
  GOV_SECURITY_CODE_PATTERN,
  PASSWORD_MIN_LENGTH,
  REGISTRATION_CODE_LENGTH,
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

export const updateDisplayNameSchema = z.object({
  displayName: displayNameSchema,
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

export const issuanceRequestSchema = z.object({
  amount: z.coerce
    .number()
    .int("Amount must be a whole number.")
    .positive("Amount must be greater than zero."),
  reason: z.string().trim().min(1, "A reason is required.").max(1000),
});

export const issuanceVoteSchema = z.object({
  requestId: z.string().uuid(),
  vote: z.enum(["APPROVE", "REJECT"]),
});

export const publishUpdateSchema = z.object({
  title: z.string().trim().min(1, "Title is required.").max(160),
  content: z.string().trim().min(1, "Content is required.").max(5000),
});
