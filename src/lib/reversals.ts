import "server-only";
import { db } from "@/db/client";
import {
  companies,
  government,
  invoices,
  marketplaceOrders,
  transactions,
  users,
} from "@/db/schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { transferInTx, PaymentError } from "./payments";
import {
  companyWallet,
  governmentWallet,
  userWallet,
  type WalletRef,
} from "./wallets";
import { recordAudit } from "./audit";
import type { Transaction } from "@/db/schema";

/**
 * REFUNDS AND REVERSALS (V3 Phase C, spec §18)
 * ===========================================================================
 *
 * THE RULE: A COMPLETED TRANSACTION IS NEVER EDITED AND NEVER DELETED.
 *
 * Putting a payment right is a NEW ledger event that points back at the one it
 * undoes, through `transactions.reverses_transaction_id`. The original row's
 * amounts, parties, tax and reference all stay exactly as they were written, so
 * the ledger remains append-only and the history shows both the payment and the
 * correction rather than a rewritten past.
 *
 * WHAT A FULL REVERSAL ACTUALLY MOVES
 * -----------------------------------
 * The original payment split the payer's gross three ways: `netAmount` to the
 * recipient and `taxAmount` to the Treasury. Undoing it therefore has to undo
 * both halves, and this module does exactly that as two movements inside one
 * transaction:
 *
 *     recipient  --net-->  original payer     (tax-free)
 *     Treasury   --tax-->  original payer     (tax-free, only if tax > 0)
 *
 * The payer ends up whole, the recipient gives back only what it actually
 * received, and the Treasury gives back only the tax it actually collected. No
 * Aero is created or destroyed, so the supply invariant is untouched. Both
 * movements are `forcedTaxRateBp: 0` — taxing a refund would mean the pair of
 * mistakes cost someone money.
 *
 * A PARTIAL correction moves `amount` from the recipient back to the payer only
 * and is recorded as TRANSACTION_ADJUSTMENT. The tax is not apportioned,
 * because inventing a fractional tax refund would be an invented number.
 *
 * WHY A SECOND REVERSAL IS IMPOSSIBLE
 * -----------------------------------
 * The original row is locked `FOR UPDATE` before anything else happens, and the
 * "has this already been reversed?" query runs under that lock. Two concurrent
 * refunds of one payment therefore serialise on the original row: the first
 * writes its reversal, the second sees it and is refused. No Aeros move twice.
 *
 * ACTOR AND REASON
 * ----------------
 * Both are mandatory. The reason is stored on the new ledger row (so it is
 * visible to both parties in their own activity) and in the audit log together
 * with the actor who authorised it.
 */

export class ReversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReversalError";
  }
}

export type ReversalActor =
  | { type: "GOVERNMENT"; id: string; label: string }
  | { type: "COMPANY"; id: string; label: string };

export type ReversalResult = {
  /** The new ledger row. The original is unchanged. */
  reversalTxRef: string;
  originalTxRef: string;
  kind: "FULL" | "PARTIAL";
  /** What the original payer got back in total. */
  refundedToPayer: number;
  refundedFromRecipient: number;
  refundedFromTreasury: number;
};

/** The wallet a ledger row's party column refers to. */
function walletFromLedgerParty(
  type: "USER" | "COMPANY" | "GOVERNMENT",
  id: string | null,
  governmentId: string,
): WalletRef {
  if (type === "GOVERNMENT") return governmentWallet(governmentId);
  if (!id) throw new ReversalError("That ledger row does not name a party that can be refunded.");
  return type === "USER" ? userWallet(id) : companyWallet(id);
}

/** True when a reversal row already points at this transaction. */
export async function isReversed(transactionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.reversesTransactionId, transactionId))
    .limit(1);
  return !!row;
}

/**
 * Which of these transactions already have a reversal pointing at them.
 *
 * One indexed query for the whole page rather than one per row — the
 * Government's ledger view lists hundreds at a time.
 */
export async function reversedTransactionIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: transactions.reversesTransactionId })
    .from(transactions)
    .where(inArray(transactions.reversesTransactionId, ids));
  return new Set(rows.map((r) => r.id).filter((v): v is string => !!v));
}

export async function getReversalsFor(transactionId: string): Promise<Transaction[]> {
  return db
    .select()
    .from(transactions)
    .where(eq(transactions.reversesTransactionId, transactionId));
}

/** Every reversal row in the ledger, newest first — for the Government panel. */
export async function listReversals(limit = 100): Promise<Transaction[]> {
  return db
    .select()
    .from(transactions)
    .where(isNotNull(transactions.reversesTransactionId))
    .orderBy(sql`${transactions.createdAt} DESC`)
    .limit(limit);
}

/**
 * Reverses (or partially adjusts) an earlier transaction.
 *
 * `actor` is established from a verified Government session or from the company
 * that received the money — never from a request field. `amount` is only
 * consulted for a partial adjustment and is capped at what the recipient
 * actually received, so a "refund" can never pay out more than came in.
 */
export async function reverseTransaction(params: {
  transactionId: string;
  actor: ReversalActor;
  reason: string;
  /** Omit for a full reversal. */
  amount?: number | null;
}): Promise<ReversalResult> {
  const reason = params.reason.trim();
  if (reason.length === 0) throw new ReversalError("A reason is required for a refund.");
  if (reason.length > 500) throw new ReversalError("That reason is too long.");

  return db.transaction(async (tx) => {
    // THE SERIALISATION POINT. Everything below reads a row no concurrent
    // refund can change underneath it, which is what makes the
    // already-reversed check race-proof.
    const [original] = await tx
      .select()
      .from(transactions)
      .where(eq(transactions.id, params.transactionId))
      .for("update");
    if (!original) throw new ReversalError("That transaction does not exist.");

    if (original.reversesTransactionId) {
      throw new ReversalError("A reversal cannot itself be reversed.");
    }

    const [already] = await tx
      .select({ txRef: transactions.txRef })
      .from(transactions)
      .where(eq(transactions.reversesTransactionId, original.id))
      .limit(1);
    if (already) {
      throw new ReversalError(
        `This transaction has already been reversed by ${already.txRef}.`,
      );
    }

    const [gov] = await tx.select({ id: government.id }).from(government).limit(1);
    if (!gov) throw new ReversalError("Government account is not initialized.");

    const payerWallet = walletFromLedgerParty(
      original.senderType,
      original.senderId,
      gov.id,
    );
    const recipientWallet = walletFromLedgerParty(
      original.receiverType,
      original.receiverId,
      gov.id,
    );

    // Authorization: the Government may reverse anything; a company may only
    // refund money IT received.
    if (params.actor.type === "COMPANY") {
      if (recipientWallet.kind !== "COMPANY" || recipientWallet.id !== params.actor.id) {
        throw new ReversalError("A company can only refund a payment it received.");
      }
    }

    const full = params.amount === undefined || params.amount === null;
    let fromRecipient: number;
    if (full) {
      fromRecipient = original.netAmount;
    } else {
      const amount = Math.trunc(params.amount as number);
      if (!Number.isInteger(amount) || amount < 1) {
        throw new ReversalError("A refund must be a whole number of at least 1 Aeros.");
      }
      if (amount > original.netAmount) {
        throw new ReversalError(
          `That is more than the ${original.netAmount.toLocaleString()} Aeros this payment delivered.`,
        );
      }
      fromRecipient = amount;
    }
    const fromTreasury = full ? original.taxAmount : 0;
    const total = fromRecipient + fromTreasury;
    if (total < 1) {
      throw new ReversalError("There is nothing to refund on this transaction.");
    }

    // --- the money, both halves, inside this one transaction ---------------
    const label = `Refund of ${original.txRef}: ${reason}`;

    const back = await transferInTx(tx, {
      from: recipientWallet,
      to: payerWallet,
      amount: fromRecipient,
      // Taxing a refund would mean two mistakes cost the payer money.
      forcedTaxRateBp: 0,
      type: full ? "TRANSACTION_REVERSAL" : "TRANSACTION_ADJUSTMENT",
      reason: label,
      reversesTransactionId: original.id,
      // The refunding party is being made to give money back by the
      // Government or is giving it back itself; a suspension must not be a way
      // to keep it.
      skipSenderCheck: true,
      skipReceiverCheck: true,
      notify: {
        senderType: "REFUND_SENT",
        senderMessage: (r) =>
          `${fromRecipient.toLocaleString()} Aeros refunded against ${original.txRef}. Ref ${r.txRef}.`,
        receiverType: "REFUND_RECEIVED",
        receiverMessage: (r) =>
          `You were refunded ${total.toLocaleString()} Aeros against ${original.txRef}. Ref ${r.txRef}.`,
      },
    });

    if (fromTreasury > 0) {
      // The Treasury gives back exactly the tax it took. This is a second
      // ledger row, also pointing at the original — the reversal is not
      // pretending one party paid the other's tax.
      await transferInTx(tx, {
        from: governmentWallet(gov.id),
        to: payerWallet,
        amount: fromTreasury,
        forcedTaxRateBp: 0,
        type: "TRANSACTION_REVERSAL",
        reason: `Tax refund of ${original.txRef}: ${reason}`,
        reversesTransactionId: original.id,
        skipSenderCheck: true,
        skipReceiverCheck: true,
        notify: {
          receiverType: "REFUND_RECEIVED",
          receiverMessage: (r) =>
            `Tax of ${fromTreasury.toLocaleString()} Aeros refunded against ${original.txRef}. Ref ${r.txRef}.`,
        },
      });
    }

    // --- the paperwork the refund implies ----------------------------------
    // An invoice that has been refunded in full is no longer a settled sale, and
    // the order it belongs to is no longer a completed one. Neither row is
    // deleted; both are moved to CANCELLED with their history intact, and the
    // original PAID ledger row and its `paid_tx_ref` stay exactly as written.
    if (full && original.invoiceId) {
      await tx
        .update(invoices)
        .set({ status: "CANCELLED", cancelledAt: new Date() })
        .where(and(eq(invoices.id, original.invoiceId), eq(invoices.status, "PAID")));

      const [order] = await tx
        .select({ id: marketplaceOrders.id, orderNumber: marketplaceOrders.orderNumber })
        .from(marketplaceOrders)
        .where(eq(marketplaceOrders.invoiceId, original.invoiceId))
        .for("update");
      if (order) {
        await tx
          .update(marketplaceOrders)
          .set({
            status: "CANCELLED",
            cancelledAt: new Date(),
            cancelReason: `Refunded (${back.txRef}): ${reason}`.slice(0, 500),
          })
          .where(eq(marketplaceOrders.id, order.id));
      }
    }

    await recordAudit(tx, {
      action: full ? "TRANSACTION_REVERSED" : "TRANSACTION_ADJUSTED",
      actorType: params.actor.type,
      actorId: params.actor.id,
      actorLabel: params.actor.label,
      targetType: "TRANSACTION",
      targetId: original.id,
      previousValue: original.txRef,
      newValue: back.txRef,
      reason,
      metadata: {
        originalTxRef: original.txRef,
        originalGross: original.grossAmount,
        originalNet: original.netAmount,
        originalTax: original.taxAmount,
        refundedFromRecipient: fromRecipient,
        refundedFromTreasury: fromTreasury,
        refundedToPayer: total,
        kind: full ? "FULL" : "PARTIAL",
      },
    });

    return {
      reversalTxRef: back.txRef,
      originalTxRef: original.txRef,
      kind: full ? "FULL" : "PARTIAL",
      refundedToPayer: total,
      refundedFromRecipient: fromRecipient,
      refundedFromTreasury: fromTreasury,
    };
  });
}

/** Refund-time label for a party, for the Government's refund screen. */
export async function describeLedgerParty(
  type: "USER" | "COMPANY" | "GOVERNMENT",
  id: string | null,
): Promise<string> {
  if (type === "GOVERNMENT") return "Government";
  if (!id) return "Unknown";
  if (type === "USER") {
    const [row] = await db
      .select({ displayName: users.displayName, username: users.username })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return row ? `${row.displayName} (@${row.username})` : "Unknown user";
  }
  const [row] = await db
    .select({ name: companies.name, username: companies.username })
    .from(companies)
    .where(eq(companies.id, id))
    .limit(1);
  return row ? `${row.name} (@${row.username})` : "Unknown company";
}

export { PaymentError };
