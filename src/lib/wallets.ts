import "server-only";
import { db } from "@/db/client";
import { companies, government, users } from "@/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";

/**
 * WALLET MODEL (V2)
 * =================
 *
 * Aeros Pay has three kinds of wallet: the Government treasury, a user's
 * personal wallet, and a company wallet.
 *
 * Deliberate design decision: the wallet model is a LOGICAL abstraction over
 * the existing columns (`users.balance`, `government.balance`, and the new
 * `companies.balance`), not a physical `wallets` table that V1 balances were
 * migrated into.
 *
 * Why: moving live balances between tables is the single most dangerous thing
 * a migration can do, and it buys nothing here — every operation the spec
 * asks for is expressible over the columns that already exist. V1 balances,
 * ledger rows and history are therefore never touched by the upgrade, while
 * the rest of the codebase still gets to program against one clean
 * `WalletRef` type. (Spec §58 asks to move *conceptually* toward wallets;
 * §59 forbids destructive migration. This satisfies both.)
 *
 * DEADLOCK SAFETY
 * ---------------
 * Every wallet touched by a transfer is locked with SELECT ... FOR UPDATE in
 * a deterministic global order (see `lockWallets`). Without this, two
 * concurrent transfers in opposite directions between the same pair of
 * wallets could each hold one row and wait for the other forever.
 *
 * DOUBLE-SPEND SAFETY
 * -------------------
 * Debits are conditional atomic UPDATEs (`WHERE balance >= amount`). The row
 * lock serializes racing transactions and the WHERE clause is an independent
 * second guarantee that a balance can never go negative, even if a lock were
 * somehow missed.
 */

export type WalletKind = "USER" | "COMPANY" | "GOVERNMENT";

export type WalletRef = {
  kind: WalletKind;
  /** users.id, companies.id, or government.id depending on `kind`. */
  id: string;
};

export type LockedWallet = {
  ref: WalletRef;
  /** Username used on ledger rows (`@name` for users/companies). */
  username: string;
  /** Human-facing label, e.g. "Ayush N." or "Ayush Fitness" or "Government". */
  label: string;
  balance: number;
  /** Raw status column; interpret with lib/status helpers. */
  status: string;
  /** Only set for company wallets. */
  ownerUserId?: string;
  /** Only set for company wallets: per-company tax override, may be null. */
  taxRateBp?: number | null;
  suspendedUntil?: Date | null;
};

export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function userWallet(id: string): WalletRef {
  return { kind: "USER", id };
}
export function companyWallet(id: string): WalletRef {
  return { kind: "COMPANY", id };
}
export function governmentWallet(id: string): WalletRef {
  return { kind: "GOVERNMENT", id };
}

export function sameWallet(a: WalletRef, b: WalletRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** Stable ordering key so concurrent transfers always lock in the same order. */
function lockKey(ref: WalletRef): string {
  return `${ref.kind}:${ref.id}`;
}

async function lockOne(tx: Tx, ref: WalletRef): Promise<LockedWallet> {
  if (ref.kind === "USER") {
    const [row] = await tx.select().from(users).where(eq(users.id, ref.id)).for("update");
    if (!row) throw new WalletError("User account not found.");
    return {
      ref,
      username: row.username,
      label: row.displayName,
      balance: row.balance,
      status: row.status,
      suspendedUntil: row.suspendedUntil,
    };
  }

  if (ref.kind === "COMPANY") {
    const [row] = await tx.select().from(companies).where(eq(companies.id, ref.id)).for("update");
    if (!row) throw new WalletError("Company not found.");
    return {
      ref,
      username: row.username,
      label: row.name,
      balance: row.balance,
      status: row.status,
      ownerUserId: row.ownerUserId,
      taxRateBp: row.taxRateBp,
      suspendedUntil: row.suspendedUntil,
    };
  }

  const [row] = await tx.select().from(government).where(eq(government.id, ref.id)).for("update");
  if (!row) throw new WalletError("Government account is not initialized.");
  return {
    ref,
    username: row.username,
    label: "Government",
    balance: row.balance,
    status: "ACTIVE",
  };
}

/**
 * Locks every given wallet inside the current transaction, in a deterministic
 * order, and returns them keyed by `lockKey`. Duplicate refs are collapsed so
 * callers can pass e.g. sender/receiver/treasury without worrying about
 * overlap.
 */
export async function lockWallets(
  tx: Tx,
  refs: WalletRef[],
): Promise<Map<string, LockedWallet>> {
  const unique = new Map<string, WalletRef>();
  for (const ref of refs) unique.set(lockKey(ref), ref);

  const ordered = [...unique.values()].sort((a, b) => lockKey(a).localeCompare(lockKey(b)));

  const result = new Map<string, LockedWallet>();
  for (const ref of ordered) {
    result.set(lockKey(ref), await lockOne(tx, ref));
  }
  return result;
}

export function pickWallet(
  locked: Map<string, LockedWallet>,
  ref: WalletRef,
): LockedWallet {
  const wallet = locked.get(lockKey(ref));
  if (!wallet) throw new WalletError("Wallet was not locked for this operation.");
  return wallet;
}

/**
 * Conditional atomic debit. Returns false when the wallet did not have
 * enough Aeros — callers must treat that as a failed payment and abort the
 * whole transaction.
 */
export async function debitWallet(
  tx: Tx,
  ref: WalletRef,
  amount: number,
): Promise<boolean> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new WalletError("Debit amount must be a positive whole number.");
  }

  if (ref.kind === "USER") {
    const rows = await tx
      .update(users)
      .set({ balance: sql`${users.balance} - ${amount}` })
      .where(and(eq(users.id, ref.id), gte(users.balance, amount)))
      .returning({ balance: users.balance });
    return rows.length > 0;
  }

  if (ref.kind === "COMPANY") {
    const rows = await tx
      .update(companies)
      .set({ balance: sql`${companies.balance} - ${amount}` })
      .where(and(eq(companies.id, ref.id), gte(companies.balance, amount)))
      .returning({ balance: companies.balance });
    return rows.length > 0;
  }

  const rows = await tx
    .update(government)
    .set({ balance: sql`${government.balance} - ${amount}` })
    .where(and(eq(government.id, ref.id), gte(government.balance, amount)))
    .returning({ balance: government.balance });
  return rows.length > 0;
}

export async function creditWallet(
  tx: Tx,
  ref: WalletRef,
  amount: number,
): Promise<void> {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new WalletError("Credit amount must be a non-negative whole number.");
  }
  if (amount === 0) return;

  if (ref.kind === "USER") {
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${amount}` })
      .where(eq(users.id, ref.id));
    return;
  }

  if (ref.kind === "COMPANY") {
    await tx
      .update(companies)
      .set({ balance: sql`${companies.balance} + ${amount}` })
      .where(eq(companies.id, ref.id));
    return;
  }

  await tx
    .update(government)
    .set({ balance: sql`${government.balance} + ${amount}` })
    .where(eq(government.id, ref.id));
}

/** Ledger-facing party type for a wallet. */
export function partyTypeOf(ref: WalletRef): "USER" | "GOVERNMENT" | "COMPANY" {
  return ref.kind;
}

/**
 * `senderId`/`receiverId` on the ledger are NULL for the Government (matching
 * how every V1 row was written) and the entity id otherwise.
 */
export function ledgerPartyId(ref: WalletRef): string | null {
  return ref.kind === "GOVERNMENT" ? null : ref.id;
}
