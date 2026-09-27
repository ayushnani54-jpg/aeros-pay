"use server";

import { db } from "@/db/client";
import { government, registrationCodes, transactions, users } from "@/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { requireGovernment, requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { notifyUser, publishUpdate } from "@/lib/notify";
import { generateRegistrationCode } from "@/lib/codes";
import { fundUserFromTreasury, PaymentError } from "@/lib/payments";
import { nextTxRef } from "@/lib/txref";
import {
  createIssuanceRequest,
  castIssuanceVote,
  executeIssuance,
  IssuanceError,
} from "@/lib/issuance";
import {
  adjustBalanceSchema,
  fundUserSchema,
  issuanceRequestSchema,
  issuanceVoteSchema,
  publishUpdateSchema,
  revokeCodeSchema,
  setTaxRateSchema,
  suspendUserSchema,
} from "@/lib/validators";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "./auth";

function errMsg(e: unknown, fallback: string): string {
  if (e instanceof Error) return e.message;
  return fallback;
}

// ---------------------------------------------------------------------------
// Registration codes
// ---------------------------------------------------------------------------

export async function generateCodeAction(): Promise<ActionResult<{ code: string }>> {
  let gov;
  try {
    gov = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  try {
    const code = await generateRegistrationCode();
    await recordAudit(db, {
      action: "REGISTRATION_CODE_GENERATED",
      actorType: "GOVERNMENT",
      actorId: gov.id,
      actorLabel: gov.username,
      targetType: "REGISTRATION_CODE",
      metadata: { code },
    });
    revalidatePath("/gov/codes");
    return { ok: true, data: { code } };
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not generate a registration code.") };
  }
}

export async function revokeCodeAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let gov;
  try {
    gov = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = revokeCodeSchema.safeParse({ codeId: formData.get("codeId") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const [code] = await db
    .select()
    .from(registrationCodes)
    .where(eq(registrationCodes.id, parsed.data.codeId))
    .limit(1);

  if (!code) return { ok: false, error: "Registration code not found." };
  if (code.status === "USED") {
    return { ok: false, error: "This registration code has already been used." };
  }
  if (code.status === "REVOKED") {
    return { ok: false, error: "This registration code has already been revoked." };
  }

  await db
    .update(registrationCodes)
    .set({ status: "REVOKED", revokedAt: new Date() })
    .where(eq(registrationCodes.id, code.id));

  await recordAudit(db, {
    action: "REGISTRATION_CODE_REVOKED",
    actorType: "GOVERNMENT",
    actorId: gov.id,
    actorLabel: gov.username,
    targetType: "REGISTRATION_CODE",
    targetId: code.id,
    metadata: { code: code.code },
  });

  revalidatePath("/gov/codes");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Users: suspend / unsuspend / ban
// ---------------------------------------------------------------------------

async function setUserStatus(
  userId: string,
  status: "ACTIVE" | "SUSPENDED" | "BANNED",
  reason: string | undefined,
  action: string,
  notifyMessage: string,
) {
  const gov = await requireGovernment();

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error("User not found.");

  await db.update(users).set({ status }).where(eq(users.id, userId));

  await recordAudit(db, {
    action,
    actorType: "GOVERNMENT",
    actorId: gov.id,
    actorLabel: gov.username,
    targetType: "USER",
    targetId: userId,
    metadata: { previousStatus: user.status, newStatus: status, reason: reason ?? null },
  });

  await notifyUser(db, userId, action, notifyMessage);
}

export async function suspendUserAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = suspendUserSchema.safeParse({
    userId: formData.get("userId"),
    reason: formData.get("reason") || undefined,
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    await setUserStatus(
      parsed.data.userId,
      "SUSPENDED",
      parsed.data.reason,
      "ACCOUNT_SUSPENDED",
      "Your account was suspended.",
    );
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not suspend account.") };
  }
  revalidatePath("/gov/users");
  revalidatePath(`/gov/users/${parsed.data.userId}`);
  return { ok: true, data: undefined };
}

export async function unsuspendUserAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = suspendUserSchema.safeParse({
    userId: formData.get("userId"),
    reason: formData.get("reason") || undefined,
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    await setUserStatus(
      parsed.data.userId,
      "ACTIVE",
      parsed.data.reason,
      "ACCOUNT_RESTORED",
      "Your account has been restored to active status.",
    );
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not restore account.") };
  }
  revalidatePath("/gov/users");
  revalidatePath(`/gov/users/${parsed.data.userId}`);
  return { ok: true, data: undefined };
}

export async function banUserAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = suspendUserSchema.safeParse({
    userId: formData.get("userId"),
    reason: formData.get("reason") || undefined,
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    await setUserStatus(
      parsed.data.userId,
      "BANNED",
      parsed.data.reason,
      "ACCOUNT_BANNED",
      "Your account was banned.",
    );
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not ban account.") };
  }
  revalidatePath("/gov/users");
  revalidatePath(`/gov/users/${parsed.data.userId}`);
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Users: fund a newly registered user from the treasury
// ---------------------------------------------------------------------------

export async function fundUserAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let gov;
  try {
    gov = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = fundUserSchema.safeParse({
    userId: formData.get("userId"),
    amount: formData.get("amount"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    await fundUserFromTreasury({
      governmentId: gov.id,
      receiverUserId: parsed.data.userId,
      amount: parsed.data.amount,
      reason: "Government funding",
    });
  } catch (e) {
    if (e instanceof PaymentError) return { ok: false, error: e.message };
    return { ok: false, error: "Funding could not be completed." };
  }

  revalidatePath("/gov");
  revalidatePath("/gov/users");
  revalidatePath(`/gov/users/${parsed.data.userId}`);
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Balance adjustments (administrative correction, conserves total supply by
// moving Aeros to/from the Government treasury rather than creating or
// destroying them — see README "Security & Design Decisions")
// ---------------------------------------------------------------------------

export async function adjustBalanceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let gov;
  try {
    gov = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = adjustBalanceSchema.safeParse({
    userId: formData.get("userId"),
    direction: formData.get("direction"),
    amount: formData.get("amount"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const { userId, direction, amount, reason } = parsed.data;

  try {
    await db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
      if (!user) throw new Error("User not found.");

      const [govRow] = await tx
        .select()
        .from(government)
        .where(eq(government.id, gov.id))
        .for("update");
      if (!govRow) throw new Error("Government account not found.");

      const beforeBalance = user.balance;
      const txRef = await nextTxRef(tx);

      if (direction === "CREDIT") {
        const debited = await tx
          .update(government)
          .set({ balance: sql`${government.balance} - ${amount}` })
          .where(and(eq(government.id, govRow.id), gte(government.balance, amount)))
          .returning({ balance: government.balance });
        if (debited.length === 0) {
          throw new Error("Government treasury has insufficient Aeros for this adjustment.");
        }
        await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${amount}` })
          .where(eq(users.id, userId));

        await tx.insert(transactions).values({
          txRef,
          type: "ADMIN_ADJUSTMENT_CREDIT",
          senderType: "GOVERNMENT",
          senderId: null,
          senderUsername: govRow.username,
          receiverType: "USER",
          receiverId: userId,
          receiverUsername: user.username,
          grossAmount: amount,
          taxAmount: 0,
          netAmount: amount,
          taxRateBpApplied: 0,
          reason,
        });
      } else {
        const debited = await tx
          .update(users)
          .set({ balance: sql`${users.balance} - ${amount}` })
          .where(and(eq(users.id, userId), gte(users.balance, amount)))
          .returning({ balance: users.balance });
        if (debited.length === 0) {
          throw new Error("User has insufficient Aeros for this adjustment.");
        }
        await tx
          .update(government)
          .set({ balance: sql`${government.balance} + ${amount}` })
          .where(eq(government.id, govRow.id));

        await tx.insert(transactions).values({
          txRef,
          type: "ADMIN_ADJUSTMENT_DEBIT",
          senderType: "USER",
          senderId: userId,
          senderUsername: user.username,
          receiverType: "GOVERNMENT",
          receiverId: null,
          receiverUsername: govRow.username,
          grossAmount: amount,
          taxAmount: 0,
          netAmount: amount,
          taxRateBpApplied: 0,
          reason,
        });
      }

      const afterBalance = direction === "CREDIT" ? beforeBalance + amount : beforeBalance - amount;

      await recordAudit(tx, {
        action: "ADMIN_BALANCE_ADJUSTMENT",
        actorType: "GOVERNMENT",
        actorId: gov.id,
        actorLabel: gov.username,
        targetType: "USER",
        targetId: userId,
        metadata: { direction, amount, reason, beforeBalance, afterBalance, txRef },
      });

      await notifyUser(
        tx,
        userId,
        "ADMIN_BALANCE_ADJUSTMENT",
        `Government made an administrative ${direction === "CREDIT" ? "credit of" : "deduction of"} ${amount} Aeros to your account. Reason: ${reason}`,
      );
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Balance adjustment failed.") };
  }

  revalidatePath("/gov/users");
  revalidatePath(`/gov/users/${userId}`);
  revalidatePath("/gov");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Tax configuration
// ---------------------------------------------------------------------------

export async function setTaxRateAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let gov;
  try {
    gov = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = setTaxRateSchema.safeParse({
    taxRatePercent: formData.get("taxRatePercent"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const newRateBp = Math.round(parsed.data.taxRatePercent * 100);

  await db.transaction(async (tx) => {
    const [govRow] = await tx
      .select()
      .from(government)
      .where(eq(government.id, gov.id))
      .for("update");
    if (!govRow) throw new Error("Government account not found.");

    await tx
      .update(government)
      .set({ taxRateBp: newRateBp, taxUpdatedAt: new Date() })
      .where(eq(government.id, govRow.id));

    await recordAudit(tx, {
      action: "TAX_RATE_CHANGED",
      actorType: "GOVERNMENT",
      actorId: gov.id,
      actorLabel: gov.username,
      metadata: { previousRateBp: govRow.taxRateBp, newRateBp },
    });
  });

  revalidatePath("/gov/tax");
  revalidatePath("/gov");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Aeros issuance
// ---------------------------------------------------------------------------

export async function createIssuanceRequestAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let gov;
  try {
    gov = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = issuanceRequestSchema.safeParse({
    amount: formData.get("amount"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    await createIssuanceRequest({
      governmentId: gov.id,
      governmentUsername: gov.username,
      amount: parsed.data.amount,
      reason: parsed.data.reason,
    });
  } catch (e) {
    if (e instanceof IssuanceError) return { ok: false, error: e.message };
    return { ok: false, error: "Could not create issuance request." };
  }

  revalidatePath("/gov/issuance");
  return { ok: true, data: undefined };
}

export async function castIssuanceVoteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = issuanceVoteSchema.safeParse({
    requestId: formData.get("requestId"),
    vote: formData.get("vote"),
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    await castIssuanceVote({
      requestId: parsed.data.requestId,
      userId: user.id,
      vote: parsed.data.vote,
    });
  } catch (e) {
    if (e instanceof IssuanceError) return { ok: false, error: e.message };
    return { ok: false, error: "Could not record your vote." };
  }

  revalidatePath("/updates");
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}

export async function executeIssuanceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let gov;
  try {
    gov = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const requestId = String(formData.get("requestId") ?? "");
  if (!requestId) return { ok: false, error: "Invalid request." };

  try {
    await executeIssuance({
      requestId,
      governmentId: gov.id,
      governmentUsername: gov.username,
    });
  } catch (e) {
    if (e instanceof IssuanceError) return { ok: false, error: e.message };
    return { ok: false, error: "Issuance execution failed." };
  }

  revalidatePath("/gov/issuance");
  revalidatePath("/gov");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Updates feed
// ---------------------------------------------------------------------------

export async function publishUpdateAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let gov;
  try {
    gov = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = publishUpdateSchema.safeParse({
    title: formData.get("title"),
    content: formData.get("content"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  await publishUpdate(db, {
    title: parsed.data.title,
    content: parsed.data.content,
    authorLabel: gov.username,
  });

  await recordAudit(db, {
    action: "UPDATE_PUBLISHED",
    actorType: "GOVERNMENT",
    actorId: gov.id,
    actorLabel: gov.username,
    metadata: { title: parsed.data.title },
  });

  revalidatePath("/updates");
  revalidatePath("/gov/updates");
  return { ok: true, data: undefined };
}
