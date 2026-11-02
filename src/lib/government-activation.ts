import { db } from "@/db/client";
import { governmentActivationCodes, users } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { createHash, randomInt } from "crypto";
import { recordAudit } from "@/lib/audit";

export const ACTIVATION_CODE_EXPIRY_HOURS = 24;

export function hashActivationCode(code: string): string {
  return createHash("sha256").update(`aeros_gov_activation_${code.trim()}`).digest("hex");
}

export function generate6DigitActivationCode(): string {
  return String(randomInt(100000, 1000000));
}

/**
 * Government issues a 6-digit activation code for a specific user.
 * Revokes any prior unconsumed activation codes for this user.
 */
export async function generateGovernmentActivationCode(params: {
  userId: string;
  adminUsername: string;
  adminNotes?: string | null;
}): Promise<{ code: string; expiresAt: Date; codeId: string }> {
  const code = generate6DigitActivationCode();
  const codeHash = hashActivationCode(code);
  const expiresAt = new Date(Date.now() + ACTIVATION_CODE_EXPIRY_HOURS * 60 * 60 * 1000);

  return db.transaction(async (tx) => {
    // Revoke previous active codes for this user
    await tx
      .update(governmentActivationCodes)
      .set({ status: "REVOKED" })
      .where(
        and(
          eq(governmentActivationCodes.userId, params.userId),
          eq(governmentActivationCodes.status, "ACTIVE"),
        ),
      );

    const [inserted] = await tx
      .insert(governmentActivationCodes)
      .values({
        codeHash,
        userId: params.userId,
        generatedBy: params.adminUsername,
        expiresAt,
        status: "ACTIVE",
        adminNotes: params.adminNotes ?? null,
      })
      .returning({ id: governmentActivationCodes.id });

    await recordAudit(tx, {
      action: "GOV_ACTIVATION_CODE_GENERATED",
      actorType: "GOVERNMENT",
      actorLabel: params.adminUsername,
      targetType: "USER",
      targetId: params.userId,
      metadata: { codeId: inserted.id, expiresAt: expiresAt.toISOString() },
    });

    return { code, expiresAt, codeId: inserted.id };
  });
}

/**
 * Citizen enters their Government-issued 6-digit code to activate full Aeros Pay membership.
 */
export async function consumeGovernmentActivationCode(params: {
  userId: string;
  code: string;
}): Promise<{ ok: boolean; error?: string }> {
  const trimmedCode = params.code.trim();
  if (!/^\d{6}$/.test(trimmedCode)) {
    return { ok: false, error: "Activation code must be exactly 6 numeric digits." };
  }

  const codeHash = hashActivationCode(trimmedCode);
  const now = new Date();

  return db.transaction(async (tx) => {
    const [record] = await tx
      .select()
      .from(governmentActivationCodes)
      .where(
        and(
          eq(governmentActivationCodes.userId, params.userId),
          eq(governmentActivationCodes.codeHash, codeHash),
        ),
      )
      .orderBy(desc(governmentActivationCodes.createdAt))
      .limit(1)
      .for("update");

    if (!record) {
      return { ok: false, error: "Invalid activation code. Please check and try again." };
    }

    if (record.status !== "ACTIVE") {
      return {
        ok: false,
        error: record.status === "USED"
          ? "This activation code has already been used."
          : "This activation code is no longer active. Please request a new code from Government.",
      };
    }

    if (record.expiresAt.getTime() < now.getTime()) {
      await tx
        .update(governmentActivationCodes)
        .set({ status: "EXPIRED" })
        .where(eq(governmentActivationCodes.id, record.id));
      return { ok: false, error: "This activation code has expired (24-hour limit). Please request a replacement." };
    }

    // Mark code as USED
    await tx
      .update(governmentActivationCodes)
      .set({
        status: "USED",
        consumedAt: now,
        consumedByUserId: params.userId,
      })
      .where(eq(governmentActivationCodes.id, record.id));

    // Update user access level to ACTIVE_MEMBER
    const [user] = await tx
      .update(users)
      .set({
        accessLevel: "ACTIVE_MEMBER",
      })
      .where(eq(users.id, params.userId))
      .returning({ username: users.username });

    await recordAudit(tx, {
      action: "ACCOUNT_ACTIVATED_BY_GOVERNMENT",
      actorType: "USER",
      actorId: params.userId,
      actorLabel: user?.username ?? "unknown",
      targetType: "GOVERNMENT_ACTIVATION_CODE",
      targetId: record.id,
      metadata: { generatedBy: record.generatedBy },
    });

    return { ok: true };
  });
}
