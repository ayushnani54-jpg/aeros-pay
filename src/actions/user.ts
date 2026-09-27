"use server";

import { requireUser, requireActingContext } from "@/lib/auth";
import { payByUsername, PaymentError } from "@/lib/payments";
import {
  changePasswordSchema,
  paySchema,
  switchContextSchema,
  updateDisplayNameSchema,
} from "@/lib/validators";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { setCompanyContext } from "@/lib/session";
import { requireOwnedCompany, CompanyError } from "@/lib/companies";
import { hashSecret, verifySecret } from "@/lib/password";
import { markNotificationsRead } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { canUserSend } from "@/lib/status";
import type { ActionResult } from "./auth";

export type PaymentData = {
  txRef: string;
  grossAmount: number;
  taxAmount: number;
  netAmount: number;
  receiverUsername: string;
  receiverLabel: string;
  senderLabel: string;
};

/**
 * Pays from whichever wallet the user is currently acting as (personal or one
 * of their companies). The active wallet comes from the server-verified
 * acting context, never from the form — a client cannot choose to spend a
 * wallet it does not own.
 */
export async function payAction(
  _prev: ActionResult<PaymentData> | null,
  formData: FormData,
): Promise<ActionResult<PaymentData>> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  if (!canUserSend(ctx.user)) {
    return {
      ok: false,
      error:
        ctx.effectiveStatus === "BANNED"
          ? "Your account is banned and cannot send Aeros."
          : "Your account is suspended and cannot send Aeros right now.",
    };
  }

  const parsed = paySchema.safeParse({
    recipientUsername: formData.get("recipientUsername"),
    amount: formData.get("amount"),
    note: formData.get("note") ?? "",
    toGovernment: formData.get("toGovernment") === "1",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const recipient = parsed.data.recipientUsername.trim().toLowerCase().replace(/^@/, "");

  try {
    const result = await payByUsername({
      from: ctx.wallet,
      recipientUsername: recipient,
      toGovernment: parsed.data.toGovernment,
      amount: parsed.data.amount,
      reason: parsed.data.note || null,
    });

    revalidatePath("/dashboard");
    revalidatePath("/transactions");
    revalidatePath("/my-company");

    return {
      ok: true,
      data: {
        txRef: result.txRef,
        grossAmount: result.grossAmount,
        taxAmount: result.taxAmount,
        netAmount: result.netAmount,
        receiverUsername: result.receiverUsername,
        receiverLabel: result.receiverLabel,
        senderLabel: result.senderLabel,
      },
    };
  } catch (e) {
    if (e instanceof PaymentError) return { ok: false, error: e.message };
    return { ok: false, error: "Payment could not be completed." };
  }
}

/**
 * Kept so any existing V1 call site keeps working.
 *
 * Declared as a real async function rather than a const alias, because a
 * "use server" module may only export async functions.
 */
export async function sendAerosAction(
  prev: ActionResult<PaymentData> | null,
  formData: FormData,
): Promise<ActionResult<PaymentData>> {
  return payAction(prev, formData);
}

/**
 * Switches the active wallet between personal and one of the user's approved
 * companies. Ownership is re-verified server-side before the context cookie
 * is written.
 */
export async function switchContextAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = switchContextSchema.safeParse({ context: formData.get("context") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  if (parsed.data.context === "personal") {
    await setCompanyContext(null);
  } else {
    try {
      await requireOwnedCompany(user.id, parsed.data.context);
    } catch (e) {
      if (e instanceof CompanyError) return { ok: false, error: e.message };
      return { ok: false, error: "Could not switch to that company." };
    }
    await setCompanyContext(parsed.data.context);
  }

  revalidatePath("/", "layout");
  return { ok: true, data: undefined };
}

export async function updateDisplayNameAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = updateDisplayNameSchema.safeParse({
    displayName: formData.get("displayName"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  await db
    .update(users)
    .set({ displayName: parsed.data.displayName })
    .where(eq(users.id, user.id));

  revalidatePath("/profile");
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}

/**
 * Lets a user change their own password. Requires the current password, and
 * bumps the session epoch so any other session is signed out.
 */
export async function changePasswordAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = changePasswordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const valid = await verifySecret(parsed.data.currentPassword, user.passwordHash);
  if (!valid) return { ok: false, error: "Your current password is incorrect." };

  const passwordHash = await hashSecret(parsed.data.newPassword);

  await db
    .update(users)
    .set({
      passwordHash,
      mustChangePassword: false,
      passwordUpdatedAt: new Date(),
      sessionEpoch: sql`${users.sessionEpoch} + 1`,
    })
    .where(eq(users.id, user.id));

  await recordAudit(db, {
    action: "PASSWORD_CHANGED",
    actorType: "USER",
    actorId: user.id,
    actorLabel: user.username,
    targetType: "USER",
    targetId: user.id,
  });

  // The epoch bump invalidates the current cookie too, so the user is asked
  // to sign in again with the new password.
  revalidatePath("/profile");
  return { ok: true, data: undefined };
}

export async function markNotificationsReadAction(): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  await markNotificationsRead(user.id);
  revalidatePath("/notifications");
  revalidatePath("/", "layout");
  return { ok: true, data: undefined };
}
