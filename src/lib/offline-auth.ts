import "server-only";
import { db } from "@/db/client";
import { government, offlineAuthTokens, users } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { signOfflineAuthToken, verifyOfflineAuthToken } from "./session";
import { canUserSend } from "./status";
import { MIN_TRANSACTION_AMOUNT } from "./constants";

/**
 * PWA OFFLINE PAYMENTS — AUTHORIZATION AND ALLOWANCE ENFORCEMENT
 * ===========================================================================
 *
 * WHAT AN "OFFLINE AUTHORIZATION" IS
 * -----------------------------------
 * A short, signed JWT (src/lib/session.ts `signOfflineAuthToken`, reusing the
 * exact same `jose`/`AUTH_SECRET` primitive as every session cookie) that a
 * client fetches while online and stores itself (IndexedDB — never a cookie,
 * since the client must be able to read and queue against it). It carries a
 * SNAPSHOT: the user id, a token id (`jti`, an `offline_auth_tokens.id`), how
 * much of the Government's offline allowance this user has left, and the
 * per-transaction cap — all fixed at issue and never renegotiated by the
 * client.
 *
 * WHY ISSUING A TOKEN NEVER ITSELF SPENDS ANYTHING
 * -------------------------------------------------
 * `users.offline_allowance_used` is only ever incremented by a SYNCED
 * payment (`consumeOfflineAllowance`, called from inside the same database
 * transaction as the real transfer). Issuing a token is a read plus an
 * insert of a bookkeeping row; it never touches `offline_allowance_used`. A
 * user who requests ten tokens and never goes offline has spent nothing.
 *
 * THE DOUBLE-SPEND-ACROSS-DEVICES CASE, HANDLED PRECISELY
 * -----------------------------------------------------------------------
 * Two devices can each hold a token whose `allowance` snapshot was computed
 * from the SAME starting point (neither has synced anything yet), so in
 * isolation each token looks good for up to the full per-user allowance. That
 * is fine, because a token's snapshot is only ever a LOCAL UI ceiling and a
 * per-token ceiling (enforced by the guarded UPDATE on `offline_auth_tokens.
 * consumed_amount`, backstopped by that table's own CHECK constraint — see
 * schema.ts). The GLOBAL, per-user ceiling is enforced separately and
 * independently at every sync, by a guarded conditional UPDATE on the SAME
 * `users.offline_allowance_used` row both devices' syncs contend for:
 *
 *   UPDATE users SET offline_allowance_used = offline_allowance_used + :amt
 *   WHERE id = :userId
 *     AND offline_allowance_used + :amt <= (government's LIVE total allowance)
 *
 * Postgres serializes concurrent UPDATEs to the same row via the row's own
 * lock — there is no gap between "check" and "write" for a second syncing
 * device to land in, exactly the same guarantee `debitWallet` in
 * src/lib/wallets.ts already relies on for balances. So the precise worst
 * case is: a user with two tokens, each snapshotting the full allowance, can
 * split their spend across both devices in whatever order their syncs happen
 * to commit in, but the SUM across every token they ever hold can never
 * exceed the Government's per-user ceiling — never more, regardless of how
 * many tokens were issued or how the syncs interleave. The real ledger debit
 * inside `transferInTx` (from `users.balance`, an entirely separate
 * conditional UPDATE) is a second, independent guarantee against overdraft
 * even if this allowance bookkeeping had a bug.
 */

export const DEFAULT_OFFLINE_TOKEN_EXPIRY_MINUTES = 60;

export class OfflineAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineAuthError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type OfflineAuthorization = {
  token: string;
  tokenId: string;
  allowance: number;
  perTransactionMax: number;
  issuedAt: string;
  expiresAt: string;
};

/**
 * Issues a fresh offline authorization for a user's PERSONAL wallet.
 *
 * Callers (the server action) are responsible for confirming the caller is
 * acting as their personal wallet, not a company — this function only knows
 * about `users`, so there is no company or Government code path through it
 * at all; a company or Government id passed here simply will not be found as
 * a `users` row (Government uses an entirely separate table and session).
 */
export async function issueOfflineAuthorization(userId: string): Promise<OfflineAuthorization> {
  return db.transaction(async (tx) => {
    const [g] = await tx.select().from(government).limit(1);
    if (!g) throw new OfflineAuthError("Government account is not initialized.");
    if (!g.offlineTransactionsEnabled) {
      throw new OfflineAuthError("Offline transactions are currently disabled by the Government.");
    }

    const [userRow] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!userRow) throw new OfflineAuthError("Account not found.");
    if (!canUserSend(userRow)) {
      throw new OfflineAuthError(
        userRow.status === "BANNED"
          ? "This account is banned and cannot use offline payments."
          : "This account is suspended and cannot use offline payments right now.",
      );
    }

    const remaining = Math.max(0, g.offlineTotalAllowance - userRow.offlineAllowanceUsed);
    if (remaining < MIN_TRANSACTION_AMOUNT) {
      throw new OfflineAuthError(
        "You have no offline allowance remaining. This resets only if the Government raises the policy limit.",
      );
    }

    const expiryMinutes = g.offlineAuthExpiryMinutes ?? DEFAULT_OFFLINE_TOKEN_EXPIRY_MINUTES;
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + expiryMinutes * 60_000);

    const [row] = await tx
      .insert(offlineAuthTokens)
      .values({
        userId,
        allowanceAtIssue: remaining,
        perTransactionMax: g.offlineMaxPerTransaction,
        expiresAt,
      })
      .returning();

    const token = await signOfflineAuthToken(
      {
        purpose: "offline_payment_auth",
        sub: userId,
        jti: row.id,
        allowance: remaining,
        perTxMax: g.offlineMaxPerTransaction,
      },
      expiryMinutes * 60,
    );

    return {
      token,
      tokenId: row.id,
      allowance: remaining,
      perTransactionMax: g.offlineMaxPerTransaction,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  });
}

export type VerifiedOfflineAuthorization = {
  tokenId: string;
  userId: string;
  perTxMaxFromToken: number;
};

/**
 * Signature + expiry + ownership check for a token presented at sync time.
 * Does NOT touch the database and does NOT spend any allowance — it only
 * proves "this token really was issued by us, really is unexpired, and
 * really belongs to the session presenting it". The actual spend is
 * `consumeOfflineAllowance`, which re-reads and re-locks the DB row (the JWT
 * claims are a cache of that row at issue time, never the final word).
 */
export async function verifyOfflineAuthorizationForSync(params: {
  token: string;
  sessionUserId: string;
}): Promise<VerifiedOfflineAuthorization> {
  const payload = await verifyOfflineAuthToken(params.token);
  if (!payload) {
    throw new OfflineAuthError("This offline authorization is invalid or has expired.");
  }
  if (payload.sub !== params.sessionUserId) {
    throw new OfflineAuthError("This offline authorization does not belong to your session.");
  }
  return { tokenId: payload.jti, userId: payload.sub, perTxMaxFromToken: payload.perTxMax };
}

/**
 * THE STRUCTURAL GUARD (matches src/lib/settlement.ts's philosophy: enforced
 * where the money actually moves, not just checked earlier and trusted).
 *
 * Must be called from INSIDE the same transaction (`tx`) that then calls
 * `transferInTx` for the real payment — never before it opens, never after it
 * commits — so the allowance spend and the transfer either both land or
 * neither does. Throws `OfflineAuthError` (and therefore rolls back the whole
 * transaction, spending nothing) unless every one of these holds:
 *
 *   - the token row exists and belongs to `userId`
 *   - the token's DB-stored expiry has not passed (independent of, and in
 *     addition to, the JWT's own `exp` already checked by `jwtVerify`)
 *   - `amount` does not exceed that token's per-transaction snapshot
 *   - the token's own guarded `consumed_amount` has room (per-token ceiling,
 *     backstopped by the table's own CHECK constraint)
 *   - the user's LIVE, guarded `offline_allowance_used` has room against the
 *     Government's CURRENT total allowance (per-user ceiling, closes the
 *     cross-device/cross-token gap — see the module comment above)
 */
export async function consumeOfflineAllowance(
  tx: Tx,
  params: { tokenId: string; userId: string; amount: number },
): Promise<void> {
  const { tokenId, userId, amount } = params;

  if (!Number.isInteger(amount) || amount < MIN_TRANSACTION_AMOUNT) {
    throw new OfflineAuthError(`Minimum payment is ${MIN_TRANSACTION_AMOUNT} Aeros.`);
  }

  const [tokenRow] = await tx
    .select()
    .from(offlineAuthTokens)
    .where(eq(offlineAuthTokens.id, tokenId))
    .for("update");
  if (!tokenRow) {
    throw new OfflineAuthError("This offline authorization could not be found.");
  }
  if (tokenRow.userId !== userId) {
    throw new OfflineAuthError("This offline authorization does not belong to this account.");
  }
  if (tokenRow.expiresAt.getTime() < Date.now()) {
    throw new OfflineAuthError("This offline authorization has expired. Go online to get a new one.");
  }
  if (amount > tokenRow.perTransactionMax) {
    throw new OfflineAuthError(
      `This payment exceeds the ${tokenRow.perTransactionMax.toLocaleString()} Aeros per-transaction limit for this offline authorization.`,
    );
  }

  const tokenUpdate = await tx
    .update(offlineAuthTokens)
    .set({ consumedAmount: sql`${offlineAuthTokens.consumedAmount} + ${amount}` })
    .where(
      and(
        eq(offlineAuthTokens.id, tokenId),
        sql`${offlineAuthTokens.consumedAmount} + ${amount} <= ${offlineAuthTokens.allowanceAtIssue}`,
      ),
    )
    .returning({ id: offlineAuthTokens.id });
  if (tokenUpdate.length === 0) {
    throw new OfflineAuthError("This offline authorization's allowance has already been used up.");
  }

  const [g] = await tx.select({ cap: government.offlineTotalAllowance }).from(government).limit(1);
  if (!g) throw new OfflineAuthError("Government account is not initialized.");

  const userUpdate = await tx
    .update(users)
    .set({ offlineAllowanceUsed: sql`${users.offlineAllowanceUsed} + ${amount}` })
    .where(
      and(eq(users.id, userId), sql`${users.offlineAllowanceUsed} + ${amount} <= ${g.cap}`),
    )
    .returning({ id: users.id });
  if (userUpdate.length === 0) {
    throw new OfflineAuthError(
      "Your total offline allowance has been used up. Go online to renew it.",
    );
  }
}
