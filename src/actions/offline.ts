"use server";

import { db } from "@/db/client";
import { transactions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireActingContext, requireUser } from "@/lib/auth";
import { canUserSend } from "@/lib/status";
import {
  OfflineAuthError,
  consumeOfflineAllowance,
  issueOfflineAuthorization,
  verifyOfflineAuthorizationForSync,
  type OfflineAuthorization,
} from "@/lib/offline-auth";
import { resolvePayeeRefInTx, transferInTx, type TransferResult } from "@/lib/payments";
import { userWallet } from "@/lib/wallets";
import { runIdempotent } from "@/lib/idempotency";
import { syncOfflinePaymentSchema } from "@/lib/validators";
import {
  consumeRateLimit,
  financialKey,
  rateLimitMessage,
  FINANCIAL_RULE,
} from "@/lib/ratelimit";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "./auth";

/**
 * PWA OFFLINE PAYMENTS — server actions
 * ===========================================================================
 * Two actions only:
 *
 *   issueOfflineAuthorizationAction — while ONLINE, mints the short signed
 *     token the client caches (IndexedDB) alongside the dashboard snapshot.
 *     Personal wallets ONLY: a company acting-context, or no user session at
 *     all (which is what a Government-only login has — see
 *     src/lib/auth.ts), is refused before anything is read or written.
 *
 *   syncOfflinePaymentAction — while back ONLINE, replays one queued offline
 *     payment. Verifies the token, spends against it, and calls the SAME
 *     payment engine every online payment uses (`transferInTx`) — all inside
 *     one `runIdempotent`-wrapped transaction, so a repeated sync of the same
 *     client key can never double-apply, and an allowance/token failure never
 *     leaves a half-applied payment.
 */

export async function issueOfflineAuthorizationAction(): Promise<
  ActionResult<OfflineAuthorization>
> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  // Company and Government wallets never get offline capability. Government
  // cannot even reach this branch under its own login: `requireActingContext`
  // is built entirely on the USER session cookie (see src/lib/auth.ts), and a
  // Government session is a completely separate cookie/table that this call
  // never reads.
  if (ctx.company) {
    return {
      ok: false,
      error: "Offline payments are only available for your personal wallet, not a company.",
    };
  }

  if (!canUserSend(ctx.user)) {
    return {
      ok: false,
      error:
        ctx.effectiveStatus === "BANNED"
          ? "Your account is banned and cannot use offline payments."
          : "Your account is suspended and cannot use offline payments right now.",
    };
  }

  try {
    const authorization = await issueOfflineAuthorization(ctx.user.id);
    return { ok: true, data: authorization };
  } catch (e) {
    if (e instanceof OfflineAuthError) return { ok: false, error: e.message };
    return { ok: false, error: "Could not issue an offline authorization." };
  }
}

export type SyncOfflinePaymentInput = {
  token: string;
  clientKey: string;
  recipientUsername: string;
  amount: number;
  note?: string | null;
  clientTimestamp?: string;
};

export type SyncOfflinePaymentResult = {
  txRef: string;
  grossAmount: number;
  taxAmount: number;
  netAmount: number;
  senderUsername: string;
  receiverUsername: string;
};

export async function syncOfflinePaymentAction(
  input: SyncOfflinePaymentInput,
): Promise<ActionResult<SyncOfflinePaymentResult>> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  if (!canUserSend(user)) {
    return {
      ok: false,
      error:
        user.status === "BANNED"
          ? "Your account is banned and cannot send Aeros."
          : "Your account is suspended and cannot send Aeros right now.",
    };
  }

  const rl = consumeRateLimit(financialKey("offline-sync", userWallet(user.id)), FINANCIAL_RULE);
  if (!rl.allowed) return { ok: false, error: rateLimitMessage(rl) };

  const parsed = syncOfflinePaymentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  let verified;
  try {
    verified = await verifyOfflineAuthorizationForSync({
      token: parsed.data.token,
      sessionUserId: user.id,
    });
  } catch (e) {
    if (e instanceof OfflineAuthError) return { ok: false, error: e.message };
    return { ok: false, error: "This offline authorization could not be verified." };
  }

  const recipient = parsed.data.recipientUsername;
  const amount = parsed.data.amount;

  try {
    const outcome = await runIdempotent<TransferResult>({
      key: parsed.data.clientKey,
      scope: "OFFLINE_PAYMENT_SYNC",
      actor: { type: "USER", id: user.id },
      // Server-established facts only — the client cannot reuse its own key
      // to push a different payment through on retry.
      facts: {
        tokenId: verified.tokenId,
        userId: user.id,
        recipientUsername: recipient,
        amount,
      },
      perform: async (tx) => {
        // The allowance spend and the real transfer share this ONE
        // transaction: either both commit or neither does (see the module
        // comment on `consumeOfflineAllowance`).
        await consumeOfflineAllowance(tx, {
          tokenId: verified.tokenId,
          userId: user.id,
          amount,
        });

        const to = await resolvePayeeRefInTx(tx, { username: recipient });

        const result = await transferInTx(tx, {
          from: userWallet(user.id),
          to,
          amount,
          reason: parsed.data.note || "Offline payment (synced)",
        });

        return { value: result, txRef: result.txRef, entityType: "TRANSACTION", entityId: null };
      },
      replay: async (record) => {
        if (!record.resultTxRef) {
          throw new OfflineAuthError("This offline payment's record could not be found.");
        }
        const [row] = await db
          .select()
          .from(transactions)
          .where(eq(transactions.txRef, record.resultTxRef))
          .limit(1);
        if (!row) {
          throw new OfflineAuthError("This offline payment's record could not be found.");
        }
        return {
          txRef: row.txRef,
          grossAmount: row.grossAmount,
          taxAmount: row.taxAmount,
          netAmount: row.netAmount,
          taxRateBpApplied: row.taxRateBpApplied,
          senderUsername: row.senderUsername,
          senderLabel: row.senderUsername,
          receiverUsername: row.receiverUsername,
          receiverLabel: row.receiverUsername,
        } as TransferResult;
      },
    });

    revalidatePath("/dashboard");
    revalidatePath("/transactions");

    return {
      ok: true,
      data: {
        txRef: outcome.value.txRef,
        grossAmount: outcome.value.grossAmount,
        taxAmount: outcome.value.taxAmount,
        netAmount: outcome.value.netAmount,
        senderUsername: outcome.value.senderUsername,
        receiverUsername: outcome.value.receiverUsername,
      },
    };
  } catch (e) {
    if (e instanceof OfflineAuthError) return { ok: false, error: e.message };
    if (e instanceof Error) return { ok: false, error: e.message };
    return { ok: false, error: "This offline payment could not be synced." };
  }
}
