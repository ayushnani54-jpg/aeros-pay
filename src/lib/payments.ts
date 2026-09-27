import "server-only";
import { db } from "@/db/client";
import { users, government, transactions, notifications } from "@/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { computeTax } from "./tax";
import { nextTxRef } from "./txref";
import { MIN_TRANSACTION_AMOUNT } from "./constants";
import { recordAudit } from "./audit";

export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentError";
  }
}

export type SendAerosResult = {
  txRef: string;
  grossAmount: number;
  taxAmount: number;
  netAmount: number;
  receiverUsername: string;
  receiverDisplayName: string;
};

/**
 * Executes a user-to-user Aeros transfer atomically. All balance changes,
 * the tax credit to the Government treasury, the immutable ledger row, and
 * both parties' notifications happen inside a single database transaction —
 * either the whole payment succeeds, or none of it does.
 *
 * Double-spend protection: the sender's row is locked with SELECT ... FOR
 * UPDATE for the duration of the transaction, and the balance debit itself
 * is a conditional UPDATE (balance >= amount) so a stale read can never
 * produce a negative balance even under concurrent requests.
 */
export async function sendAeros(params: {
  senderId: string;
  recipientUsername: string;
  amount: number;
}): Promise<SendAerosResult> {
  const { senderId, recipientUsername, amount } = params;

  if (!Number.isInteger(amount) || amount < MIN_TRANSACTION_AMOUNT) {
    throw new PaymentError(`Minimum payment is ${MIN_TRANSACTION_AMOUNT} Aeros.`);
  }

  return db.transaction(async (tx) => {
    // Lock sender row for the duration of this transaction.
    const [sender] = await tx
      .select()
      .from(users)
      .where(eq(users.id, senderId))
      .for("update");

    if (!sender) throw new PaymentError("Sender account not found.");
    if (sender.status === "SUSPENDED") throw new PaymentError("Account is suspended.");
    if (sender.status === "BANNED") throw new PaymentError("Account is banned.");

    // Lock receiver row too, serializing concurrent credits to the same
    // recipient and letting us validate their eligibility consistently.
    const [receiver] = await tx
      .select()
      .from(users)
      .where(eq(users.username, recipientUsername))
      .for("update");

    if (!receiver) throw new PaymentError("Username not found.");
    if (receiver.id === sender.id) {
      throw new PaymentError("You cannot send Aeros to yourself.");
    }
    if (receiver.status === "BANNED") {
      throw new PaymentError("Recipient account cannot receive Aeros.");
    }

    const [gov] = await tx.select().from(government).limit(1).for("update");
    if (!gov) throw new PaymentError("Government account is not initialized.");

    const { grossAmount, taxAmount, netAmount, taxRateBpApplied } = computeTax(
      amount,
      gov.taxRateBp,
    );

    // Conditional, atomic debit — this is the statement that actually
    // prevents double-spending. If two concurrent requests race, the row
    // lock above already serializes them, and this WHERE clause is a second,
    // independent guarantee against a negative balance.
    const debited = await tx
      .update(users)
      .set({ balance: sql`${users.balance} - ${grossAmount}` })
      .where(and(eq(users.id, sender.id), gte(users.balance, grossAmount)))
      .returning({ balance: users.balance });

    if (debited.length === 0) {
      throw new PaymentError("Insufficient Aeros balance.");
    }

    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${netAmount}` })
      .where(eq(users.id, receiver.id));

    if (taxAmount > 0) {
      await tx
        .update(government)
        .set({ balance: sql`${government.balance} + ${taxAmount}` })
        .where(eq(government.id, gov.id));
    }

    const txRef = await nextTxRef(tx);

    await tx.insert(transactions).values({
      txRef,
      type: "TRANSFER",
      senderType: "USER",
      senderId: sender.id,
      senderUsername: sender.username,
      receiverType: "USER",
      receiverId: receiver.id,
      receiverUsername: receiver.username,
      grossAmount,
      taxAmount,
      netAmount,
      taxRateBpApplied,
    });

    await tx.insert(notifications).values([
      {
        userId: sender.id,
        type: "PAYMENT_SENT",
        message: `You sent ${grossAmount} Aeros to @${receiver.username}${
          taxAmount > 0 ? ` (tax: ${taxAmount} Aeros)` : ""
        }. Ref ${txRef}.`,
      },
      {
        userId: receiver.id,
        type: "PAYMENT_RECEIVED",
        message: `You received ${netAmount} Aeros from @${sender.username}. Ref ${txRef}.`,
      },
    ]);

    return {
      txRef,
      grossAmount,
      taxAmount,
      netAmount,
      receiverUsername: receiver.username,
      receiverDisplayName: receiver.displayName,
    };
  });
}

/**
 * Government -> user funding transfer (new-user funding or an ad-hoc send
 * from the treasury). Tax-free by design: the Government is not taxing
 * itself. Debits the treasury with the same conditional-UPDATE technique
 * used for user transfers.
 */
export async function fundUserFromTreasury(params: {
  governmentId: string;
  receiverUserId: string;
  amount: number;
  reason: string;
  type?: "GOVERNMENT_FUNDING";
}): Promise<SendAerosResult> {
  const { governmentId, receiverUserId, amount, reason } = params;

  if (!Number.isInteger(amount) || amount < MIN_TRANSACTION_AMOUNT) {
    throw new PaymentError(`Minimum payment is ${MIN_TRANSACTION_AMOUNT} Aeros.`);
  }

  return db.transaction(async (tx) => {
    const [gov] = await tx
      .select()
      .from(government)
      .where(eq(government.id, governmentId))
      .for("update");
    if (!gov) throw new PaymentError("Government account not found.");

    const [receiver] = await tx
      .select()
      .from(users)
      .where(eq(users.id, receiverUserId))
      .for("update");
    if (!receiver) throw new PaymentError("Recipient user not found.");
    if (receiver.status === "BANNED") {
      throw new PaymentError("Recipient account cannot receive Aeros.");
    }

    const debited = await tx
      .update(government)
      .set({ balance: sql`${government.balance} - ${amount}` })
      .where(and(eq(government.id, gov.id), gte(government.balance, amount)))
      .returning({ balance: government.balance });

    if (debited.length === 0) {
      throw new PaymentError("Government treasury has insufficient Aeros.");
    }

    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${amount}` })
      .where(eq(users.id, receiver.id));

    const txRef = await nextTxRef(tx);

    await tx.insert(transactions).values({
      txRef,
      type: "GOVERNMENT_FUNDING",
      senderType: "GOVERNMENT",
      senderId: null,
      senderUsername: gov.username,
      receiverType: "USER",
      receiverId: receiver.id,
      receiverUsername: receiver.username,
      grossAmount: amount,
      taxAmount: 0,
      netAmount: amount,
      taxRateBpApplied: 0,
      reason,
    });

    await tx.insert(notifications).values({
      userId: receiver.id,
      type: "PAYMENT_RECEIVED",
      message: `You received ${amount} Aeros from Government. Ref ${txRef}.`,
    });

    await recordAudit(tx, {
      action: "GOVERNMENT_FUNDING",
      actorType: "GOVERNMENT",
      actorId: gov.id,
      actorLabel: gov.username,
      targetType: "USER",
      targetId: receiver.id,
      metadata: { amount, reason, txRef },
    });

    return {
      txRef,
      grossAmount: amount,
      taxAmount: 0,
      netAmount: amount,
      receiverUsername: receiver.username,
      receiverDisplayName: receiver.displayName,
    };
  });
}
