"use server";

import { db } from "@/db/client";
import {
  companies,
  government,
  registrationCodes,
  transactions,
  users,
} from "@/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { requireGovernment, requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { notifyUser, publishUpdate } from "@/lib/notify";
import { generateRegistrationCode } from "@/lib/codes";
import {
  fundUserFromTreasury,
  payCompanyFromTreasury,
  PaymentError,
  transferInTx,
} from "@/lib/payments";
import { companyWallet, governmentWallet } from "@/lib/wallets";
import { nextTxRef } from "@/lib/txref";
import {
  createIssuanceRequest,
  castIssuanceVote,
  executeIssuance,
  IssuanceError,
} from "@/lib/issuance";
import {
  approveCompany,
  CompanyError,
  editCompanyProfile,
  rejectCompany,
  setCompanyStatus,
} from "@/lib/companies";
import { decideComplaint, IpError, setComplaintUnderReview } from "@/lib/ip";
import { makeOffer, SaleError } from "@/lib/sales";
import {
  approveLoan,
  LoanError,
  recordLoanAction,
  rejectLoan,
  runLoanMaintenance,
  type LoanActionType,
} from "@/lib/loans";
import {
  archiveAuditLogs,
  clearAllUpdates,
  runCleanup,
  runTextScrub,
  unarchiveAllAuditLogs,
  updateRetentionSettings,
  updateTextScrubSettings,
} from "@/lib/retention";
import { hashSecret } from "@/lib/password";
import { healExpiredSuspensions } from "@/lib/status";
import { formatDateTime } from "@/lib/datetime";
import {
  adjustBalanceSchema,
  adjustCompanyBalanceSchema,
  archiveAuditSchema,
  banUserSchema,
  companyStatusSchema,
  economyPolicySchema,
  editCompanySchema,
  fundUserSchema,
  governmentPaymentSchema,
  ipDecisionSchema,
  issuanceRequestSchema,
  issuanceVoteSchema,
  parseDateTime,
  publishUpdateSchema,
  rejectCompanySchema,
  resetPasswordSchema,
  retentionSettingsSchema,
  reviewCompanySchema,
  revokeCodeSchema,
  setCompanyTaxSchema,
  setTaxRateSchema,
  suspendUserSchema,
  textScrubSettingsSchema,
  timedSuspendSchema,
} from "@/lib/validators";
import { MAINTENANCE_CONFIRM_PHRASE } from "@/lib/constants";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "./auth";

function errMsg(e: unknown, fallback: string): string {
  if (
    e instanceof CompanyError ||
    e instanceof LoanError ||
    e instanceof SaleError ||
    e instanceof IpError ||
    e instanceof IssuanceError ||
    e instanceof PaymentError
  ) {
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return fallback;
}

async function gov() {
  return requireGovernment();
}

// ---------------------------------------------------------------------------
// Registration codes
// ---------------------------------------------------------------------------

export async function generateCodeAction(): Promise<ActionResult<{ code: string }>> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  try {
    const code = await generateRegistrationCode();
    await recordAudit(db, {
      action: "REGISTRATION_CODE_GENERATED",
      actorType: "GOVERNMENT",
      actorId: g.id,
      actorLabel: g.username,
      targetType: "REGISTRATION_CODE",
      newValue: code,
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
  let g;
  try {
    g = await gov();
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
    actorId: g.id,
    actorLabel: g.username,
    targetType: "REGISTRATION_CODE",
    targetId: code.id,
    previousValue: "UNUSED",
    newValue: "REVOKED",
    metadata: { code: code.code },
  });

  revalidatePath("/gov/codes");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Users: status
// ---------------------------------------------------------------------------

async function applyUserStatus(params: {
  userId: string;
  status: "ACTIVE" | "SUSPENDED" | "BANNED";
  reason: string | null;
  suspendedUntil?: Date | null;
  action: string;
  notifyMessage: string;
  actorLabel: string;
  actorId: string;
}) {
  const [user] = await db.select().from(users).where(eq(users.id, params.userId)).limit(1);
  if (!user) throw new Error("User not found.");

  const changes: Partial<typeof users.$inferInsert> = { status: params.status };

  if (params.status === "SUSPENDED") {
    changes.suspendedAt = new Date();
    changes.suspendedUntil = params.suspendedUntil ?? null;
    changes.suspensionReason = params.reason;
    changes.suspendedBy = params.actorLabel;
  } else if (params.status === "BANNED") {
    changes.bannedAt = new Date();
    changes.banReason = params.reason;
    changes.bannedBy = params.actorLabel;
  } else {
    changes.suspendedAt = null;
    changes.suspendedUntil = null;
    changes.suspensionReason = null;
    changes.suspendedBy = null;
    changes.bannedAt = null;
    changes.banReason = null;
    changes.bannedBy = null;
  }

  await db.update(users).set(changes).where(eq(users.id, params.userId));

  await recordAudit(db, {
    action: params.action,
    actorType: "GOVERNMENT",
    actorId: params.actorId,
    actorLabel: params.actorLabel,
    targetType: "USER",
    targetId: params.userId,
    previousValue: user.status,
    newValue: params.status,
    reason: params.reason,
    metadata: {
      suspendedUntil: params.suspendedUntil?.toISOString() ?? null,
    },
  });

  await notifyUser(db, params.userId, params.action, params.notifyMessage);
}

export async function suspendUserAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = suspendUserSchema.safeParse({
    userId: formData.get("userId"),
    reason: formData.get("reason") || undefined,
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    await applyUserStatus({
      userId: parsed.data.userId,
      status: "SUSPENDED",
      reason: parsed.data.reason ?? null,
      suspendedUntil: null,
      action: "ACCOUNT_SUSPENDED",
      notifyMessage: `Your account has been suspended indefinitely.${parsed.data.reason ? ` Reason: ${parsed.data.reason}` : ""}`,
      actorLabel: g.username,
      actorId: g.id,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not suspend the account.") };
  }

  revalidatePath("/gov/users");
  revalidatePath(`/gov/users/${parsed.data.userId}`);
  return { ok: true, data: undefined };
}

/**
 * Timed suspension: the account is automatically treated as ACTIVE again once
 * the chosen moment passes, with no further Government action needed.
 */
export async function suspendUserUntilAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = timedSuspendSchema.safeParse({
    userId: formData.get("userId"),
    untilDate: formData.get("untilDate"),
    untilTime: formData.get("untilTime"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const until = parseDateTime(parsed.data.untilDate, parsed.data.untilTime);
  if (!until) return { ok: false, error: "That date and time could not be understood." };
  if (until.getTime() <= Date.now()) {
    return { ok: false, error: "The suspension end time must be in the future." };
  }

  try {
    await applyUserStatus({
      userId: parsed.data.userId,
      status: "SUSPENDED",
      reason: parsed.data.reason,
      suspendedUntil: until,
      action: "ACCOUNT_SUSPENDED",
      notifyMessage: `Your account is suspended until ${formatDateTime(until)}. Reason: ${parsed.data.reason}`,
      actorLabel: g.username,
      actorId: g.id,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not suspend the account.") };
  }

  revalidatePath("/gov/users");
  revalidatePath(`/gov/users/${parsed.data.userId}`);
  return { ok: true, data: undefined };
}

export async function unsuspendUserAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = suspendUserSchema.safeParse({
    userId: formData.get("userId"),
    reason: formData.get("reason") || undefined,
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    await applyUserStatus({
      userId: parsed.data.userId,
      status: "ACTIVE",
      reason: parsed.data.reason ?? null,
      action: "ACCOUNT_RESTORED",
      notifyMessage: "Your account has been restored to active status.",
      actorLabel: g.username,
      actorId: g.id,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not restore the account.") };
  }

  revalidatePath("/gov/users");
  revalidatePath(`/gov/users/${parsed.data.userId}`);
  return { ok: true, data: undefined };
}

/**
 * Permanent ban. Requires typing the username as confirmation, because it
 * blocks login as well as all economic activity. History, balance and
 * username are all preserved — the row is never deleted (spec §9).
 */
export async function banUserAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = banUserSchema.safeParse({
    userId: formData.get("userId"),
    reason: formData.get("reason"),
    confirm: formData.get("confirm") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const [target] = await db
    .select()
    .from(users)
    .where(eq(users.id, parsed.data.userId))
    .limit(1);
  if (!target) return { ok: false, error: "User not found." };

  if (parsed.data.confirm.trim().toLowerCase() !== target.username) {
    return {
      ok: false,
      error: `To confirm a permanent ban, type the username "${target.username}" exactly.`,
    };
  }

  try {
    await applyUserStatus({
      userId: parsed.data.userId,
      status: "BANNED",
      reason: parsed.data.reason,
      action: "ACCOUNT_BANNED",
      notifyMessage: `Your account has been permanently banned. Reason: ${parsed.data.reason}`,
      actorLabel: g.username,
      actorId: g.id,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not ban the account.") };
  }

  revalidatePath("/gov/users");
  revalidatePath(`/gov/users/${parsed.data.userId}`);
  return { ok: true, data: undefined };
}

/**
 * Resets a user's password to a freshly generated temporary one and ends all
 * of their existing sessions.
 *
 * The Government never sees the user's original password — it is stored only
 * as a bcrypt hash, which cannot be reversed. The temporary password is shown
 * once, here, so it can be passed to the user.
 */
export async function resetUserPasswordAction(
  _prev: ActionResult<{ temporaryPassword: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ temporaryPassword: string }>> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = resetPasswordSchema.safeParse({
    userId: formData.get("userId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const [target] = await db
    .select()
    .from(users)
    .where(eq(users.id, parsed.data.userId))
    .limit(1);
  if (!target) return { ok: false, error: "User not found." };

  const { randomBytes } = await import("crypto");
  const temporaryPassword = `Aeros-${randomBytes(6).toString("base64url")}`;
  const passwordHash = await hashSecret(temporaryPassword);

  await db
    .update(users)
    .set({
      passwordHash,
      mustChangePassword: true,
      passwordUpdatedAt: new Date(),
      // Invalidates every existing session for this user.
      sessionEpoch: sql`${users.sessionEpoch} + 1`,
    })
    .where(eq(users.id, parsed.data.userId));

  await recordAudit(db, {
    action: "PASSWORD_RESET_BY_GOVERNMENT",
    actorType: "GOVERNMENT",
    actorId: g.id,
    actorLabel: g.username,
    targetType: "USER",
    targetId: parsed.data.userId,
    reason: parsed.data.reason,
    metadata: { username: target.username, sessionsInvalidated: true },
  });

  await notifyUser(
    db,
    parsed.data.userId,
    "PASSWORD_RESET",
    "Government reset your password and signed you out of all sessions. Use the temporary password you were given, then change it from your profile.",
    "/profile",
  );

  revalidatePath(`/gov/users/${parsed.data.userId}`);
  return { ok: true, data: { temporaryPassword } };
}

// ---------------------------------------------------------------------------
// Treasury payments
// ---------------------------------------------------------------------------

export async function fundUserAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
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
      governmentId: g.id,
      receiverUserId: parsed.data.userId,
      amount: parsed.data.amount,
      reason: "Government funding",
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Funding could not be completed.") };
  }

  revalidatePath("/gov");
  revalidatePath("/gov/users");
  revalidatePath(`/gov/users/${parsed.data.userId}`);
  return { ok: true, data: undefined };
}

/**
 * A general Government payment out of the treasury to any user or company,
 * resolved by username. Tax-free and fully ledgered.
 */
export async function governmentPaymentAction(
  _prev: ActionResult<{ txRef: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ txRef: string }>> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = governmentPaymentSchema.safeParse({
    recipientUsername: formData.get("recipientUsername"),
    amount: formData.get("amount"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const handle = parsed.data.recipientUsername.trim().toLowerCase().replace(/^@/, "");

  try {
    const [userRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, handle))
      .limit(1);

    if (userRow) {
      const result = await fundUserFromTreasury({
        governmentId: g.id,
        receiverUserId: userRow.id,
        amount: parsed.data.amount,
        reason: parsed.data.reason,
        type: "GOVERNMENT_PAYMENT",
      });
      revalidatePath("/gov");
      revalidatePath("/gov/treasury");
      return { ok: true, data: { txRef: result.txRef } };
    }

    const [companyRow] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.username, handle))
      .limit(1);

    if (!companyRow) return { ok: false, error: "No user or company found with that username." };

    const result = await payCompanyFromTreasury({
      governmentId: g.id,
      companyId: companyRow.id,
      amount: parsed.data.amount,
      reason: parsed.data.reason,
      type: "GOVERNMENT_PAYMENT",
    });

    revalidatePath("/gov");
    revalidatePath("/gov/treasury");
    return { ok: true, data: { txRef: result.txRef } };
  } catch (e) {
    return { ok: false, error: errMsg(e, "The payment could not be completed.") };
  }
}

// ---------------------------------------------------------------------------
// Balance adjustments (supply-conserving: moves to/from the treasury)
// ---------------------------------------------------------------------------

export async function adjustBalanceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
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
        .where(eq(government.id, g.id))
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

      const afterBalance =
        direction === "CREDIT" ? beforeBalance + amount : beforeBalance - amount;

      await recordAudit(tx, {
        action: "ADMIN_BALANCE_ADJUSTMENT",
        actorType: "GOVERNMENT",
        actorId: g.id,
        actorLabel: g.username,
        targetType: "USER",
        targetId: userId,
        previousValue: String(beforeBalance),
        newValue: String(afterBalance),
        reason,
        metadata: { direction, amount, beforeBalance, afterBalance, txRef },
      });

      await notifyUser(
        tx,
        userId,
        "ADMIN_BALANCE_ADJUSTMENT",
        `Government made an administrative ${direction === "CREDIT" ? "credit of" : "deduction of"} ${amount.toLocaleString()} Aeros to your account. Reason: ${reason}`,
      );
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "The balance adjustment failed.") };
  }

  revalidatePath("/gov/users");
  revalidatePath(`/gov/users/${userId}`);
  revalidatePath("/gov");
  return { ok: true, data: undefined };
}

/** The same supply-conserving adjustment, for a company wallet. */
export async function adjustCompanyBalanceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = adjustCompanyBalanceSchema.safeParse({
    companyId: formData.get("companyId"),
    direction: formData.get("direction"),
    amount: formData.get("amount"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const { companyId, direction, amount, reason } = parsed.data;

  try {
    await db.transaction(async (tx) => {
      const [company] = await tx
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      if (!company) throw new Error("Company not found.");

      const before = company.balance;

      await transferInTx(tx, {
        from: direction === "CREDIT" ? governmentWallet(g.id) : companyWallet(companyId),
        to: direction === "CREDIT" ? companyWallet(companyId) : governmentWallet(g.id),
        amount,
        forcedTaxRateBp: 0,
        type:
          direction === "CREDIT" ? "COMPANY_ADJUSTMENT_CREDIT" : "COMPANY_ADJUSTMENT_DEBIT",
        reason,
        skipSenderCheck: true,
        skipReceiverCheck: true,
        notify: {
          receiverType: "ADMIN_BALANCE_ADJUSTMENT",
          receiverMessage: () =>
            `Government made an administrative ${direction === "CREDIT" ? "credit" : "deduction"} of ${amount.toLocaleString()} Aeros on ${company.name}. Reason: ${reason}`,
          senderType: "ADMIN_BALANCE_ADJUSTMENT",
          senderMessage: () =>
            `Government made an administrative ${direction === "CREDIT" ? "credit" : "deduction"} of ${amount.toLocaleString()} Aeros on ${company.name}. Reason: ${reason}`,
        },
      });

      const after = direction === "CREDIT" ? before + amount : before - amount;

      await recordAudit(tx, {
        action: "COMPANY_BALANCE_ADJUSTMENT",
        actorType: "GOVERNMENT",
        actorId: g.id,
        actorLabel: g.username,
        targetType: "COMPANY",
        targetId: companyId,
        previousValue: String(before),
        newValue: String(after),
        reason,
        metadata: { direction, amount },
      });
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "The company balance adjustment failed.") };
  }

  revalidatePath("/gov/companies");
  revalidatePath(`/gov/companies/${companyId}`);
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Tax configuration
// ---------------------------------------------------------------------------

export async function setTaxRateAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
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
      .where(eq(government.id, g.id))
      .for("update");
    if (!govRow) throw new Error("Government account not found.");

    await tx
      .update(government)
      .set({ taxRateBp: newRateBp, taxUpdatedAt: new Date() })
      .where(eq(government.id, govRow.id));

    await recordAudit(tx, {
      action: "TAX_RATE_CHANGED",
      actorType: "GOVERNMENT",
      actorId: g.id,
      actorLabel: g.username,
      previousValue: `${(govRow.taxRateBp / 100).toFixed(2)}%`,
      newValue: `${(newRateBp / 100).toFixed(2)}%`,
      metadata: { previousRateBp: govRow.taxRateBp, newRateBp },
    });
  });

  revalidatePath("/gov/tax");
  revalidatePath("/gov");
  return { ok: true, data: undefined };
}

/** Default rate used for company transactions when a company has no override. */
export async function setCompanyDefaultTaxAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
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
  const [govRow] = await db.select().from(government).where(eq(government.id, g.id)).limit(1);

  await db
    .update(government)
    .set({ companyTaxRateBp: newRateBp, companyTaxUpdatedAt: new Date() })
    .where(eq(government.id, g.id));

  await recordAudit(db, {
    action: "COMPANY_TAX_DEFAULT_CHANGED",
    actorType: "GOVERNMENT",
    actorId: g.id,
    actorLabel: g.username,
    previousValue: `${((govRow?.companyTaxRateBp ?? 0) / 100).toFixed(2)}%`,
    newValue: `${(newRateBp / 100).toFixed(2)}%`,
  });

  revalidatePath("/gov/tax");
  return { ok: true, data: undefined };
}

/** Per-company override. An empty value clears it back to the default. */
export async function setCompanyTaxAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = setCompanyTaxSchema.safeParse({
    companyId: formData.get("companyId"),
    taxRatePercent: formData.get("taxRatePercent") ?? "",
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const raw = parsed.data.taxRatePercent.trim();
  let newRateBp: number | null = null;

  if (raw !== "") {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return { ok: false, error: "Tax rate must be between 0 and 100%." };
    }
    newRateBp = Math.round(value * 100);
  }

  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, parsed.data.companyId))
    .limit(1);
  if (!company) return { ok: false, error: "Company not found." };

  await db
    .update(companies)
    .set({ taxRateBp: newRateBp, taxUpdatedAt: new Date() })
    .where(eq(companies.id, company.id));

  await recordAudit(db, {
    action: "COMPANY_TAX_RATE_CHANGED",
    actorType: "GOVERNMENT",
    actorId: g.id,
    actorLabel: g.username,
    targetType: "COMPANY",
    targetId: company.id,
    previousValue:
      company.taxRateBp === null ? "default" : `${(company.taxRateBp / 100).toFixed(2)}%`,
    newValue: newRateBp === null ? "default" : `${(newRateBp / 100).toFixed(2)}%`,
  });

  await notifyUser(
    db,
    company.ownerUserId,
    "COMPANY_TAX_RATE_CHANGED",
    newRateBp === null
      ? `The tax rate for "${company.name}" now follows the Government default.`
      : `The tax rate for "${company.name}" is now ${(newRateBp / 100).toFixed(2)}%.`,
    "/my-company",
  );

  revalidatePath("/gov/tax");
  revalidatePath("/gov/companies");
  revalidatePath(`/gov/companies/${company.id}`);
  return { ok: true, data: undefined };
}

/**
 * V2.1 — the economy policy row: company approval funding amount, the
 * per-execution issuance cap, and the issuance cooldown (now measured in IST
 * calendar days — see src/lib/issuance.ts). These used to be hardcoded
 * constants; they follow the exact same validation/audit/revalidate pattern
 * as setTaxRateAction and setSalePolicyAction above.
 */
export async function setEconomyPolicyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = economyPolicySchema.safeParse({
    companyApprovalFundingAmount: formData.get("companyApprovalFundingAmount"),
    maxIssuanceAmount: formData.get("maxIssuanceAmount"),
    issuanceCooldownDays: formData.get("issuanceCooldownDays"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  await db.transaction(async (tx) => {
    const [govRow] = await tx
      .select()
      .from(government)
      .where(eq(government.id, g.id))
      .for("update");
    if (!govRow) throw new Error("Government account not found.");

    const now = new Date();

    await tx
      .update(government)
      .set({
        companyApprovalFundingAmount: parsed.data.companyApprovalFundingAmount,
        companyApprovalFundingUpdatedAt: now,
        maxIssuanceAmount: parsed.data.maxIssuanceAmount,
        maxIssuanceAmountUpdatedAt: now,
        issuanceCooldownDays: parsed.data.issuanceCooldownDays,
        issuanceCooldownUpdatedAt: now,
      })
      .where(eq(government.id, govRow.id));

    await recordAudit(tx, {
      action: "ECONOMY_POLICY_CHANGED",
      actorType: "GOVERNMENT",
      actorId: g.id,
      actorLabel: g.username,
      previousValue: JSON.stringify({
        companyApprovalFundingAmount: govRow.companyApprovalFundingAmount,
        maxIssuanceAmount: govRow.maxIssuanceAmount,
        issuanceCooldownDays: govRow.issuanceCooldownDays,
      }),
      newValue: JSON.stringify(parsed.data),
      metadata: parsed.data,
    });
  });

  revalidatePath("/gov/tax");
  revalidatePath("/gov/issuance");
  revalidatePath("/gov/companies");
  revalidatePath("/gov");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export async function approveCompanyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = reviewCompanySchema.safeParse({
    companyId: formData.get("companyId"),
    reason: formData.get("reason") ?? "",
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    await approveCompany({
      companyId: parsed.data.companyId,
      governmentId: g.id,
      governmentUsername: g.username,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not approve the company.") };
  }

  revalidatePath("/gov/companies");
  revalidatePath(`/gov/companies/${parsed.data.companyId}`);
  revalidatePath("/gov");
  revalidatePath("/companies");
  return { ok: true, data: undefined };
}

export async function rejectCompanyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = rejectCompanySchema.safeParse({
    companyId: formData.get("companyId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "A reason is required." };
  }

  try {
    await rejectCompany({
      companyId: parsed.data.companyId,
      governmentId: g.id,
      governmentUsername: g.username,
      reason: parsed.data.reason,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not reject the company.") };
  }

  revalidatePath("/gov/companies");
  revalidatePath(`/gov/companies/${parsed.data.companyId}`);
  return { ok: true, data: undefined };
}

export async function editCompanyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = editCompanySchema.safeParse({
    companyId: formData.get("companyId"),
    name: formData.get("name"),
    username: formData.get("username"),
    category: formData.get("category"),
    description: formData.get("description"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    await editCompanyProfile({
      companyId: parsed.data.companyId,
      governmentId: g.id,
      governmentUsername: g.username,
      name: parsed.data.name,
      username: parsed.data.username,
      category: parsed.data.category,
      description: parsed.data.description,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not update the company.") };
  }

  revalidatePath("/gov/companies");
  revalidatePath(`/gov/companies/${parsed.data.companyId}`);
  return { ok: true, data: undefined };
}

export async function setCompanyStatusAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = companyStatusSchema.safeParse({
    companyId: formData.get("companyId"),
    status: formData.get("status"),
    reason: formData.get("reason") ?? "",
    suspendUntilDate: formData.get("suspendUntilDate") ?? "",
    suspendUntilTime: formData.get("suspendUntilTime") ?? "",
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const until =
    parsed.data.status === "SUSPENDED" && parsed.data.suspendUntilDate
      ? parseDateTime(parsed.data.suspendUntilDate, parsed.data.suspendUntilTime || "00:00")
      : null;

  try {
    await setCompanyStatus({
      companyId: parsed.data.companyId,
      governmentId: g.id,
      governmentUsername: g.username,
      status: parsed.data.status,
      reason: parsed.data.reason || null,
      suspendedUntil: until,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not update the company status.") };
  }

  revalidatePath("/gov/companies");
  revalidatePath(`/gov/companies/${parsed.data.companyId}`);
  return { ok: true, data: undefined };
}

/** Government proposes to buy a company. The owner must accept. */
export async function governmentOfferAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const schema = z.object({
    companyId: z.string().uuid(),
    amount: z.coerce.number().int().positive("Offer must be greater than zero."),
    message: z.string().trim().max(500).optional().or(z.literal("")),
  });

  const parsed = schema.safeParse({
    companyId: formData.get("companyId"),
    amount: formData.get("amount"),
    message: formData.get("message") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const [govRow] = await db.select().from(government).where(eq(government.id, g.id)).limit(1);
  if (!govRow || govRow.balance < parsed.data.amount) {
    return {
      ok: false,
      error: "The treasury does not hold enough Aeros to honour this offer.",
    };
  }

  try {
    await makeOffer({
      companyId: parsed.data.companyId,
      offerorUserId: null,
      amount: parsed.data.amount,
      message: parsed.data.message || null,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not send the offer.") };
  }

  revalidatePath("/gov/companies");
  revalidatePath(`/gov/companies/${parsed.data.companyId}`);
  return { ok: true, data: undefined };
}

export async function setSalePolicyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const schema = z.object({
    multiplier: z.coerce.number().min(0).max(100),
    minAgeDays: z.coerce.number().int().min(0).max(365),
  });

  const parsed = schema.safeParse({
    multiplier: formData.get("multiplier"),
    minAgeDays: formData.get("minAgeDays"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const [govRow] = await db.select().from(government).where(eq(government.id, g.id)).limit(1);
  const multiplierBp = Math.round(parsed.data.multiplier * 10000);

  await db
    .update(government)
    .set({ saleMultiplierBp: multiplierBp, saleMinCompanyAgeDays: parsed.data.minAgeDays })
    .where(eq(government.id, g.id));

  await recordAudit(db, {
    action: "SALE_POLICY_CHANGED",
    actorType: "GOVERNMENT",
    actorId: g.id,
    actorLabel: g.username,
    previousValue: `${((govRow?.saleMultiplierBp ?? 0) / 10000).toFixed(2)}x / ${govRow?.saleMinCompanyAgeDays} days`,
    newValue: `${parsed.data.multiplier.toFixed(2)}x / ${parsed.data.minAgeDays} days`,
  });

  revalidatePath("/gov/companies");
  revalidatePath("/gov/sales");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------

export async function setLoanPolicyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const schema = z.object({
    loansEnabled: z.coerce.boolean(),
    interestRatePercent: z.coerce.number().min(0).max(100),
    minAmount: z.coerce.number().int().min(1),
    maxAmount: z.coerce.number().int().min(1),
    instalmentCount: z.coerce.number().int().min(1).max(60),
    instalmentIntervalDays: z.coerce.number().int().min(1).max(365),
    minCompanyAgeDays: z.coerce.number().int().min(0).max(365),
    minCompanySales: z.coerce.number().int().min(0),
    defaultGraceDays: z.coerce.number().int().min(0).max(365),
  });

  const parsed = schema.safeParse({
    loansEnabled: formData.get("loansEnabled") === "1",
    interestRatePercent: formData.get("interestRatePercent"),
    minAmount: formData.get("minAmount"),
    maxAmount: formData.get("maxAmount"),
    instalmentCount: formData.get("instalmentCount"),
    instalmentIntervalDays: formData.get("instalmentIntervalDays"),
    minCompanyAgeDays: formData.get("minCompanyAgeDays"),
    minCompanySales: formData.get("minCompanySales"),
    defaultGraceDays: formData.get("defaultGraceDays"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  if (parsed.data.minAmount > parsed.data.maxAmount) {
    return { ok: false, error: "The minimum loan cannot be larger than the maximum." };
  }

  const [govRow] = await db.select().from(government).where(eq(government.id, g.id)).limit(1);

  await db
    .update(government)
    .set({
      loansEnabled: parsed.data.loansEnabled,
      loanInterestRateBp: Math.round(parsed.data.interestRatePercent * 100),
      loanMinAmount: parsed.data.minAmount,
      loanMaxAmount: parsed.data.maxAmount,
      loanInstalmentCount: parsed.data.instalmentCount,
      loanInstalmentIntervalDays: parsed.data.instalmentIntervalDays,
      loanMinCompanyAgeDays: parsed.data.minCompanyAgeDays,
      loanMinCompanySales: parsed.data.minCompanySales,
      loanDefaultGraceDays: parsed.data.defaultGraceDays,
      loanPolicyUpdatedAt: new Date(),
    })
    .where(eq(government.id, g.id));

  await recordAudit(db, {
    action: "LOAN_POLICY_CHANGED",
    actorType: "GOVERNMENT",
    actorId: g.id,
    actorLabel: g.username,
    previousValue: `${((govRow?.loanInterestRateBp ?? 0) / 100).toFixed(2)}% / ${govRow?.loanInstalmentCount} instalments`,
    newValue: `${parsed.data.interestRatePercent.toFixed(2)}% / ${parsed.data.instalmentCount} instalments`,
    metadata: { ...parsed.data },
  });

  revalidatePath("/gov/loans");
  return { ok: true, data: undefined };
}

export async function approveLoanAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const schema = z.object({
    loanId: z.string().uuid(),
    approvedAmount: z.string().trim(),
    interestRatePercent: z.string().trim(),
    instalmentCount: z.string().trim(),
    instalmentIntervalDays: z.string().trim(),
  });

  const parsed = schema.safeParse({
    loanId: formData.get("loanId"),
    approvedAmount: formData.get("approvedAmount") ?? "",
    interestRatePercent: formData.get("interestRatePercent") ?? "",
    instalmentCount: formData.get("instalmentCount") ?? "",
    instalmentIntervalDays: formData.get("instalmentIntervalDays") ?? "",
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const num = (v: string) => (v === "" ? undefined : Number(v));

  try {
    await approveLoan({
      loanId: parsed.data.loanId,
      governmentId: g.id,
      governmentUsername: g.username,
      approvedAmount: num(parsed.data.approvedAmount),
      interestRateBp:
        parsed.data.interestRatePercent === ""
          ? undefined
          : Math.round(Number(parsed.data.interestRatePercent) * 100),
      instalmentCount: num(parsed.data.instalmentCount),
      instalmentIntervalDays: num(parsed.data.instalmentIntervalDays),
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not approve the loan.") };
  }

  revalidatePath("/gov/loans");
  revalidatePath(`/gov/loans/${parsed.data.loanId}`);
  revalidatePath("/my-company/loans");
  return { ok: true, data: undefined };
}

export async function rejectLoanAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const schema = z.object({
    loanId: z.string().uuid(),
    reason: z.string().trim().min(1, "A reason is required.").max(1000),
  });

  const parsed = schema.safeParse({
    loanId: formData.get("loanId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "A reason is required." };
  }

  try {
    await rejectLoan({
      loanId: parsed.data.loanId,
      governmentId: g.id,
      governmentUsername: g.username,
      reason: parsed.data.reason,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not reject the loan.") };
  }

  revalidatePath("/gov/loans");
  revalidatePath(`/gov/loans/${parsed.data.loanId}`);
  return { ok: true, data: undefined };
}

export async function loanActionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const schema = z.object({
    loanId: z.string().uuid(),
    action: z.enum([
      "WARNING",
      "RESTRICTION",
      "DEMAND",
      "RESTRUCTURE",
      "DEFAULT",
      "SUSPENSION",
      "CLEARED",
    ]),
    reason: z.string().trim().min(1, "A written reason is required.").max(1000),
    restructureIntervalDays: z.string().trim().optional().or(z.literal("")),
  });

  const parsed = schema.safeParse({
    loanId: formData.get("loanId"),
    action: formData.get("action"),
    reason: formData.get("reason"),
    restructureIntervalDays: formData.get("restructureIntervalDays") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    await recordLoanAction({
      loanId: parsed.data.loanId,
      governmentId: g.id,
      governmentUsername: g.username,
      action: parsed.data.action as LoanActionType,
      reason: parsed.data.reason,
      restructureIntervalDays:
        parsed.data.restructureIntervalDays && parsed.data.restructureIntervalDays !== ""
          ? Number(parsed.data.restructureIntervalDays)
          : undefined,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not record the loan action.") };
  }

  revalidatePath("/gov/loans");
  revalidatePath(`/gov/loans/${parsed.data.loanId}`);
  revalidatePath("/my-company/loans");
  return { ok: true, data: undefined };
}

export async function runLoanMaintenanceAction(): Promise<ActionResult<{ marked: number; reminders: number }>> {
  try {
    await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const result = await runLoanMaintenance();
  revalidatePath("/gov/loans");
  return {
    ok: true,
    data: { marked: result.markedOverdue, reminders: result.remindersSent },
  };
}

// ---------------------------------------------------------------------------
// IP complaints
// ---------------------------------------------------------------------------

export async function decideIpComplaintAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = ipDecisionSchema.safeParse({
    complaintId: formData.get("complaintId"),
    decision: formData.get("decision"),
    reason: formData.get("reason"),
    suspendUntilDate: formData.get("suspendUntilDate") ?? "",
    suspendUntilTime: formData.get("suspendUntilTime") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const until =
    parsed.data.decision === "TEMPORARY_SUSPENSION" && parsed.data.suspendUntilDate
      ? parseDateTime(parsed.data.suspendUntilDate, parsed.data.suspendUntilTime || "00:00")
      : null;

  try {
    await decideComplaint({
      complaintId: parsed.data.complaintId,
      governmentId: g.id,
      governmentUsername: g.username,
      decision: parsed.data.decision,
      reason: parsed.data.reason,
      suspendUntil: until,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not record the decision.") };
  }

  revalidatePath("/gov/ip");
  revalidatePath(`/gov/ip/${parsed.data.complaintId}`);
  return { ok: true, data: undefined };
}

export async function markComplaintUnderReviewAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const complaintId = String(formData.get("complaintId") ?? "");
  if (!complaintId) return { ok: false, error: "Invalid request." };

  await setComplaintUnderReview(complaintId);
  revalidatePath("/gov/ip");
  revalidatePath(`/gov/ip/${complaintId}`);
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Aeros issuance
// ---------------------------------------------------------------------------

export async function createIssuanceRequestAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = issuanceRequestSchema.safeParse({
    amount: formData.get("amount"),
    reason: formData.get("reason"),
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    await createIssuanceRequest({
      governmentId: g.id,
      governmentUsername: g.username,
      amount: parsed.data.amount,
      reason: parsed.data.reason,
      note: parsed.data.note || null,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not create the issuance request.") };
  }

  revalidatePath("/gov/issuance");
  revalidatePath("/updates");
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
    return { ok: false, error: errMsg(e, "Could not record your vote.") };
  }

  revalidatePath("/updates");
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}

export async function executeIssuanceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const requestId = String(formData.get("requestId") ?? "");
  if (!requestId) return { ok: false, error: "Invalid request." };

  try {
    await executeIssuance({
      requestId,
      governmentId: g.id,
      governmentUsername: g.username,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "The issuance could not be executed.") };
  }

  revalidatePath("/gov/issuance");
  revalidatePath("/gov");
  revalidatePath("/updates");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

export async function publishUpdateAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
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
    authorLabel: g.username,
  });

  await recordAudit(db, {
    action: "UPDATE_PUBLISHED",
    actorType: "GOVERNMENT",
    actorId: g.id,
    actorLabel: g.username,
    newValue: parsed.data.title,
  });

  revalidatePath("/updates");
  revalidatePath("/gov/updates");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Data retention & maintenance
// ---------------------------------------------------------------------------

export async function setRetentionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = retentionSettingsSchema.safeParse({
    updatesRetentionDays: formData.get("updatesRetentionDays") ?? "",
    notificationsRetentionDays: formData.get("notificationsRetentionDays") ?? "",
    supportRetentionDays: formData.get("supportRetentionDays") ?? "",
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const toDays = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value < 1 || value > 3650) {
      throw new Error("Retention periods must be whole numbers of days between 1 and 3650.");
    }
    return value;
  };

  try {
    await updateRetentionSettings({
      updatesRetentionDays: toDays(parsed.data.updatesRetentionDays),
      notificationsRetentionDays: toDays(parsed.data.notificationsRetentionDays),
      supportRetentionDays: toDays(parsed.data.supportRetentionDays),
      governmentId: g.id,
      governmentUsername: g.username,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not save the retention settings.") };
  }

  revalidatePath("/gov/retention");
  return { ok: true, data: undefined };
}

/** V2.1 — text-scrub ages, one per data class. Same pattern as setRetentionAction. */
export async function setTextScrubSettingsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = textScrubSettingsSchema.safeParse({
    transactionReasonMaxAgeDays: formData.get("transactionReasonMaxAgeDays") ?? "",
    invoiceTextMaxAgeDays: formData.get("invoiceTextMaxAgeDays") ?? "",
    loanTextMaxAgeDays: formData.get("loanTextMaxAgeDays") ?? "",
    issuanceNoteMaxAgeDays: formData.get("issuanceNoteMaxAgeDays") ?? "",
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const toDays = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value < 1 || value > 3650) {
      throw new Error("Scrub ages must be whole numbers of days between 1 and 3650.");
    }
    return value;
  };

  try {
    await updateTextScrubSettings({
      transactionReasonMaxAgeDays: toDays(parsed.data.transactionReasonMaxAgeDays),
      invoiceTextMaxAgeDays: toDays(parsed.data.invoiceTextMaxAgeDays),
      loanTextMaxAgeDays: toDays(parsed.data.loanTextMaxAgeDays),
      issuanceNoteMaxAgeDays: toDays(parsed.data.issuanceNoteMaxAgeDays),
      governmentId: g.id,
      governmentUsername: g.username,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not save the text-scrub settings.") };
  }

  revalidatePath("/gov/retention");
  return { ok: true, data: undefined };
}

/**
 * Clears free-text fields (never amounts, ids, parties, balances or
 * timestamps) on transactions/invoices/loans/issuance records older than
 * the configured ages. Idempotent — safe to run repeatedly, and rows already
 * cleared are simply skipped. Gated behind the same confirm phrase as the
 * other destructive-looking maintenance actions, even though nothing
 * financial is ever touched.
 */
export async function runTextScrubAction(
  _prev: ActionResult<{ summary: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ summary: string }>> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const confirm = String(formData.get("confirm") ?? "").trim();
  if (confirm !== MAINTENANCE_CONFIRM_PHRASE) {
    return {
      ok: false,
      error: `Type "${MAINTENANCE_CONFIRM_PHRASE}" exactly to confirm this cleanup.`,
    };
  }

  const result = await runTextScrub({
    governmentId: g.id,
    governmentUsername: g.username,
  });

  revalidatePath("/gov/retention");
  return {
    ok: true,
    data: {
      summary: `${result.transactionsScrubbed} transactions, ${result.invoicesScrubbed} invoices, ${result.loansScrubbed} loans and ${result.issuanceNotesScrubbed} issuance notes scrubbed.`,
    },
  };
}

export async function runCleanupAction(
  _prev: ActionResult<{ summary: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ summary: string }>> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const confirm = String(formData.get("confirm") ?? "").trim();
  if (confirm !== MAINTENANCE_CONFIRM_PHRASE) {
    return {
      ok: false,
      error: `Type "${MAINTENANCE_CONFIRM_PHRASE}" exactly to confirm this cleanup.`,
    };
  }

  const result = await runCleanup({
    governmentId: g.id,
    governmentUsername: g.username,
  });

  revalidatePath("/gov/retention");
  return {
    ok: true,
    data: {
      summary: `${result.updatesDeleted} updates, ${result.notificationsDeleted} notifications and ${result.supportMessagesDeleted} support messages removed.`,
    },
  };
}

export async function clearUpdatesAction(
  _prev: ActionResult<{ deleted: number }> | null,
  formData: FormData,
): Promise<ActionResult<{ deleted: number }>> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const confirm = String(formData.get("confirm") ?? "").trim();
  if (confirm !== MAINTENANCE_CONFIRM_PHRASE) {
    return {
      ok: false,
      error: `Type "${MAINTENANCE_CONFIRM_PHRASE}" exactly to confirm.`,
    };
  }

  const deleted = await clearAllUpdates({
    governmentId: g.id,
    governmentUsername: g.username,
  });

  revalidatePath("/gov/updates");
  revalidatePath("/updates");
  revalidatePath("/gov/retention");
  return { ok: true, data: { deleted } };
}

export async function archiveAuditAction(
  _prev: ActionResult<{ archived: number }> | null,
  formData: FormData,
): Promise<ActionResult<{ archived: number }>> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = archiveAuditSchema.safeParse({
    olderThanDays: formData.get("olderThanDays"),
  });
  if (!parsed.success) {
    return { ok: false, error: "Enter a whole number of days between 1 and 3650." };
  }

  const archived = await archiveAuditLogs({
    olderThanDays: parsed.data.olderThanDays,
    governmentId: g.id,
    governmentUsername: g.username,
  });

  revalidatePath("/gov/audit");
  revalidatePath("/gov/retention");
  return { ok: true, data: { archived } };
}

export async function unarchiveAuditAction(): Promise<ActionResult<{ restored: number }>> {
  let g;
  try {
    g = await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const restored = await unarchiveAllAuditLogs({
    governmentId: g.id,
    governmentUsername: g.username,
  });

  revalidatePath("/gov/audit");
  revalidatePath("/gov/retention");
  return { ok: true, data: { restored } };
}

/** Reflects elapsed timed suspensions in the stored rows. */
export async function healSuspensionsAction(): Promise<ActionResult> {
  try {
    await gov();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  await healExpiredSuspensions();
  revalidatePath("/gov/users");
  return { ok: true, data: undefined };
}
