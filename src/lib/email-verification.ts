import { db } from "@/db/client";
import { emailVerificationCodes, users } from "@/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { createHash, randomInt } from "crypto";
import { isUniqueViolation } from "@/lib/db-errors";

export const EMAIL_VERIFICATION_EXPIRY_MINUTES = 10;
export const MAX_VERIFICATION_ATTEMPTS = 5;

export function hashVerificationCode(code: string): string {
  return createHash("sha256").update(`aeros_email_verif_${code.trim()}`).digest("hex");
}

export function generate8DigitNumericCode(): string {
  return String(randomInt(10000000, 100000000));
}

/**
 * Creates or resets an email verification challenge.
 * Automatically invalidates previous unconsumed challenges for this email or user.
 */
export async function createEmailVerificationChallenge(params: {
  email: string;
  userId?: string | null;
  username?: string | null;
  passwordHash?: string | null;
  ipAddress?: string | null;
}): Promise<{ code: string; expiresAt: Date }> {
  const normalizedEmail = params.email.trim().toLowerCase();
  const code = generate8DigitNumericCode();
  const codeHash = hashVerificationCode(code);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_EXPIRY_MINUTES * 60 * 1000);

  await db.transaction(async (tx) => {
    // Invalidate existing pending codes for this email
    await tx
      .update(emailVerificationCodes)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(emailVerificationCodes.email, normalizedEmail),
          isNull(emailVerificationCodes.consumedAt),
        ),
      );

    await tx.insert(emailVerificationCodes).values({
      email: normalizedEmail,
      userId: params.userId ?? null,
      username: params.username ?? null,
      passwordHash: params.passwordHash ?? null,
      codeHash,
      expiresAt,
      attempts: 0,
      maxAttempts: MAX_VERIFICATION_ATTEMPTS,
      ipAddress: params.ipAddress ?? null,
    });
  });

  return { code, expiresAt };
}

/**
 * Verifies an 8-digit code for a given email address.
 * Enforces single-use, 10-minute expiration, and strict attempt limits.
 */
export async function verifyEmailCode(params: {
  email: string;
  code: string;
}): Promise<{
  ok: boolean;
  error?: string;
  userId?: string | null;
  username?: string | null;
  passwordHash?: string | null;
}> {
  const normalizedEmail = params.email.trim().toLowerCase();
  const codeHash = hashVerificationCode(params.code);
  const now = new Date();

  return db.transaction(async (tx) => {
    // Retrieve latest active challenge for this email
    const [challenge] = await tx
      .select()
      .from(emailVerificationCodes)
      .where(
        and(
          eq(emailVerificationCodes.email, normalizedEmail),
          isNull(emailVerificationCodes.consumedAt),
        ),
      )
      .orderBy(desc(emailVerificationCodes.createdAt))
      .limit(1)
      .for("update");

    if (!challenge) {
      return { ok: false, error: "No active verification request found for this email. Please request a new code." };
    }

    if (challenge.expiresAt.getTime() < now.getTime()) {
      await tx
        .update(emailVerificationCodes)
        .set({ consumedAt: now })
        .where(eq(emailVerificationCodes.id, challenge.id));
      return { ok: false, error: "Verification code has expired. Please request a new code." };
    }

    if (challenge.attempts >= challenge.maxAttempts) {
      await tx
        .update(emailVerificationCodes)
        .set({ consumedAt: now })
        .where(eq(emailVerificationCodes.id, challenge.id));
      return { ok: false, error: "Maximum verification attempts exceeded. Please request a new code." };
    }

    if (challenge.codeHash !== codeHash) {
      await tx
        .update(emailVerificationCodes)
        .set({ attempts: challenge.attempts + 1 })
        .where(eq(emailVerificationCodes.id, challenge.id));
      const remaining = challenge.maxAttempts - (challenge.attempts + 1);
      return {
        ok: false,
        error: `Incorrect verification code. ${remaining > 0 ? `${remaining} attempts remaining.` : "Please request a new code."}`,
      };
    }

    // Mark challenge as successfully consumed
    await tx
      .update(emailVerificationCodes)
      .set({ consumedAt: now })
      .where(eq(emailVerificationCodes.id, challenge.id));

    // If challenge was for an existing user email update
    if (challenge.userId) {
      try {
        await tx
          .update(users)
          .set({
            authEmail: normalizedEmail,
            authEmailVerified: true,
            authEmailVerifiedAt: now,
            emailMigrationRequired: false,
          })
          .where(eq(users.id, challenge.userId));
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: "This email address is already bound to another account." };
        }
        throw err;
      }
    }

    return {
      ok: true,
      userId: challenge.userId,
      username: challenge.username,
      passwordHash: challenge.passwordHash,
    };
  });
}
