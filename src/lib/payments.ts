import "server-only";
import { db } from "@/db/client";
import { companies, government, notifications, transactions, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  computeTax,
  resolveTaxRateBp,
  resolveTransactionType,
  type TaxBreakdown,
} from "./tax";
import { nextTxRef } from "./txref";
import { MIN_TRANSACTION_AMOUNT } from "./constants";
import { recordAudit } from "./audit";
import {
  canCompanyReceive,
  canCompanyTrade,
  canUserReceive,
  canUserSend,
} from "./status";
import {
  companyWallet,
  creditWallet,
  debitWallet,
  governmentWallet,
  ledgerPartyId,
  lockWallets,
  partyTypeOf,
  pickWallet,
  sameWallet,
  userWallet,
  type LockedWallet,
  type WalletRef,
} from "./wallets";

export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentError";
  }
}

export type TransferResult = {
  txRef: string;
  grossAmount: number;
  taxAmount: number;
  netAmount: number;
  taxRateBpApplied: number;
  senderUsername: string;
  senderLabel: string;
  receiverUsername: string;
  receiverLabel: string;
};

/** Kept for backwards compatibility with V1 call sites. */
export type SendAerosResult = TransferResult & {
  receiverDisplayName: string;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

async function assertCanSend(tx: Tx, wallet: LockedWallet): Promise<void> {
  if (wallet.ref.kind === "GOVERNMENT") return;

  if (wallet.ref.kind === "USER") {
    const [row] = await tx.select().from(users).where(eq(users.id, wallet.ref.id));
    if (!row) throw new PaymentError("Sender account not found.");
    if (!canUserSend(row)) {
      throw new PaymentError(
        row.status === "BANNED"
          ? "This account is banned and cannot send Aeros."
          : "This account is suspended and cannot send Aeros right now.",
      );
    }
    return;
  }

  const [row] = await tx.select().from(companies).where(eq(companies.id, wallet.ref.id));
  if (!row) throw new PaymentError("Company not found.");
  if (!canCompanyTrade(row)) {
    throw new PaymentError("This company cannot send Aeros in its current state.");
  }

  // A company's economic activity also depends on its owner being in good
  // standing — a banned owner cannot trade through their company.
  const [owner] = await tx.select().from(users).where(eq(users.id, row.ownerUserId));
  if (!owner || !canUserSend(owner)) {
    throw new PaymentError("The company owner's account cannot transact right now.");
  }
}

async function assertCanReceive(tx: Tx, wallet: LockedWallet): Promise<void> {
  if (wallet.ref.kind === "GOVERNMENT") return;

  if (wallet.ref.kind === "USER") {
    const [row] = await tx.select().from(users).where(eq(users.id, wallet.ref.id));
    if (!row) throw new PaymentError("Recipient account not found.");
    if (!canUserReceive(row)) {
      throw new PaymentError("Recipient account cannot receive Aeros.");
    }
    return;
  }

  const [row] = await tx.select().from(companies).where(eq(companies.id, wallet.ref.id));
  if (!row) throw new PaymentError("Company not found.");
  if (!canCompanyReceive(row)) {
    throw new PaymentError("This company cannot receive Aeros in its current state.");
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Resolves the user who should be notified about activity on a wallet. */
async function notifyTargetUserId(tx: Tx, ref: WalletRef): Promise<string | null> {
  if (ref.kind === "USER") return ref.id;
  if (ref.kind === "COMPANY") {
    const [row] = await tx
      .select({ ownerUserId: companies.ownerUserId })
      .from(companies)
      .where(eq(companies.id, ref.id));
    return row?.ownerUserId ?? null;
  }
  return null; // Government has no notification inbox; it has the audit log.
}

function walletDisplay(wallet: LockedWallet): string {
  if (wallet.ref.kind === "GOVERNMENT") return "Government";
  return `@${wallet.username}`;
}

// ---------------------------------------------------------------------------
// The universal transfer
// ---------------------------------------------------------------------------

export type TransferOptions = {
  from: WalletRef;
  to: WalletRef;
  amount: number;
  /** Overrides the resolved rate. Used by invoices (tax already computed) and
   * by tax-free administrative movements. */
  forcedTaxRateBp?: number;
  /** Overrides the breakdown entirely — used by invoice settlement where tax
   * was added on top of the quoted subtotal rather than deducted from it. */
  forcedBreakdown?: TaxBreakdown;
  /** Overrides the ledger transaction type. */
  type?: string;
  reason?: string | null;
  invoiceId?: string | null;
  /** Skip the sender's "can send" check — only for Government-initiated
   * administrative movements, never for user-initiated payments. */
  skipSenderCheck?: boolean;
  /** Skip the receiver's "can receive" check. */
  skipReceiverCheck?: boolean;
  notify?: {
    senderMessage?: (ctx: TransferResult) => string;
    receiverMessage?: (ctx: TransferResult) => string;
    senderType?: string;
    receiverType?: string;
    href?: string;
  };
};

/**
 * Moves Aeros between any two wallets atomically.
 *
 * Everything — both balance changes, the tax credit to the treasury, the
 * immutable ledger row and both parties' notifications — happens inside one
 * database transaction. Either the whole payment succeeds or none of it does.
 *
 * Total supply is never changed here. Only `executeIssuance` creates Aeros.
 */
export async function transferInTx(
  tx: Tx,
  options: TransferOptions,
): Promise<TransferResult> {
  const { from, to, amount } = options;

  if (!Number.isInteger(amount) || amount < MIN_TRANSACTION_AMOUNT) {
    throw new PaymentError(`Minimum payment is ${MIN_TRANSACTION_AMOUNT} Aeros.`);
  }
  if (sameWallet(from, to)) {
    throw new PaymentError("You cannot send Aeros to yourself.");
  }

  // The treasury is always involved: it receives the tax.
  const [govRow] = await tx.select({ id: government.id }).from(government).limit(1);
  if (!govRow) throw new PaymentError("Government account is not initialized.");
  const treasury = governmentWallet(govRow.id);

  const locked = await lockWallets(tx, [from, to, treasury]);
  const sender = pickWallet(locked, from);
  const receiver = pickWallet(locked, to);

  if (!options.skipSenderCheck) await assertCanSend(tx, sender);
  if (!options.skipReceiverCheck) await assertCanReceive(tx, receiver);

  // --- tax ------------------------------------------------------------------
  let breakdown: TaxBreakdown;
  if (options.forcedBreakdown) {
    breakdown = options.forcedBreakdown;
  } else {
    const [govFull] = await tx.select().from(government).where(eq(government.id, govRow.id));
    const rateBp =
      options.forcedTaxRateBp ??
      resolveTaxRateBp(from, to, {
        personalRateBp: govFull.taxRateBp,
        defaultCompanyRateBp: govFull.companyTaxRateBp,
        senderCompanyRateBp: sender.ref.kind === "COMPANY" ? sender.taxRateBp : null,
        receiverCompanyRateBp: receiver.ref.kind === "COMPANY" ? receiver.taxRateBp : null,
      });
    breakdown = computeTax(amount, rateBp);
  }

  const { grossAmount, taxAmount, netAmount, taxRateBpApplied } = breakdown;

  // --- move the money -------------------------------------------------------
  const debited = await debitWallet(tx, from, grossAmount);
  if (!debited) {
    throw new PaymentError(
      from.kind === "GOVERNMENT"
        ? "Government treasury has insufficient Aeros."
        : "Insufficient Aeros balance.",
    );
  }

  await creditWallet(tx, to, netAmount);

  if (taxAmount > 0) {
    // Tax goes to the treasury — unless the treasury is already one of the
    // counterparties, in which case it was handled by the debit/credit above.
    await creditWallet(tx, treasury, taxAmount);
  }

  // --- ledger ---------------------------------------------------------------
  const txRef = await nextTxRef(tx);
  const type = (options.type ?? resolveTransactionType(from, to)) as
    (typeof transactions.$inferInsert)["type"];

  await tx.insert(transactions).values({
    txRef,
    type,
    senderType: partyTypeOf(from),
    senderId: ledgerPartyId(from),
    senderUsername: sender.username,
    receiverType: partyTypeOf(to),
    receiverId: ledgerPartyId(to),
    receiverUsername: receiver.username,
    grossAmount,
    taxAmount,
    netAmount,
    taxRateBpApplied,
    reason: options.reason ?? null,
    invoiceId: options.invoiceId ?? null,
  });

  const result: TransferResult = {
    txRef,
    grossAmount,
    taxAmount,
    netAmount,
    taxRateBpApplied,
    senderUsername: sender.username,
    senderLabel: sender.label,
    receiverUsername: receiver.username,
    receiverLabel: receiver.label,
  };

  // --- notifications --------------------------------------------------------
  const rows: (typeof notifications.$inferInsert)[] = [];

  const senderUserId = await notifyTargetUserId(tx, from);
  if (senderUserId) {
    rows.push({
      userId: senderUserId,
      type: options.notify?.senderType ?? "PAYMENT_SENT",
      message:
        options.notify?.senderMessage?.(result) ??
        `${from.kind === "COMPANY" ? `${sender.label} sent` : "You sent"} ${grossAmount.toLocaleString()} Aeros to ${walletDisplay(receiver)}${
          taxAmount > 0 ? ` (tax: ${taxAmount.toLocaleString()} Aeros)` : ""
        }. Ref ${txRef}.`,
      href: options.notify?.href ?? null,
    });
  }

  const receiverUserId = await notifyTargetUserId(tx, to);
  if (receiverUserId && receiverUserId !== senderUserId) {
    rows.push({
      userId: receiverUserId,
      type: options.notify?.receiverType ?? "PAYMENT_RECEIVED",
      message:
        options.notify?.receiverMessage?.(result) ??
        `${to.kind === "COMPANY" ? `${receiver.label} received` : "You received"} ${netAmount.toLocaleString()} Aeros from ${walletDisplay(sender)}. Ref ${txRef}.`,
      href: options.notify?.href ?? null,
    });
  } else if (receiverUserId && receiverUserId === senderUserId) {
    // Owner paying their own company (or vice versa): one combined notice.
    rows.push({
      userId: receiverUserId,
      type: options.notify?.receiverType ?? "PAYMENT_RECEIVED",
      message: `${walletDisplay(sender)} → ${walletDisplay(receiver)}: ${grossAmount.toLocaleString()} Aeros. Ref ${txRef}.`,
      href: options.notify?.href ?? null,
    });
  }

  if (rows.length > 0) await tx.insert(notifications).values(rows);

  return result;
}

/** Standalone wrapper that opens its own database transaction. */
export async function transfer(options: TransferOptions): Promise<TransferResult> {
  return db.transaction((tx) => transferInTx(tx, options));
}

// ---------------------------------------------------------------------------
// V1-compatible helpers
// ---------------------------------------------------------------------------

/**
 * User-to-user payment by recipient username. Preserved from V1 so existing
 * call sites keep working unchanged.
 */
export async function sendAeros(params: {
  senderId: string;
  recipientUsername: string;
  amount: number;
}): Promise<SendAerosResult> {
  const { senderId, recipientUsername, amount } = params;

  return db.transaction(async (tx) => {
    const [receiver] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, recipientUsername))
      .limit(1);

    if (!receiver) throw new PaymentError("Username not found.");

    const result = await transferInTx(tx, {
      from: userWallet(senderId),
      to: userWallet(receiver.id),
      amount,
    });

    return { ...result, receiverDisplayName: result.receiverLabel };
  });
}

/**
 * Payment from a wallet the caller controls to any recipient resolved by
 * username. Handles user→user, user→company, company→user, company→company
 * and →Government, with the right tax rule for each (spec §22).
 */
export async function payByUsername(params: {
  from: WalletRef;
  recipientUsername: string;
  /** Set when the user explicitly chose to pay the Government. */
  toGovernment?: boolean;
  amount: number;
  reason?: string | null;
}): Promise<TransferResult> {
  const { from, recipientUsername, amount, toGovernment } = params;

  return db.transaction(async (tx) => {
    let to: WalletRef;

    if (toGovernment) {
      const [gov] = await tx.select({ id: government.id }).from(government).limit(1);
      if (!gov) throw new PaymentError("Government account is not initialized.");
      to = governmentWallet(gov.id);
    } else {
      const [userRow] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, recipientUsername))
        .limit(1);

      if (userRow) {
        to = userWallet(userRow.id);
      } else {
        const [companyRow] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(eq(companies.username, recipientUsername))
          .limit(1);
        if (!companyRow) throw new PaymentError("Username not found.");
        to = companyWallet(companyRow.id);
      }
    }

    return transferInTx(tx, {
      from,
      to,
      amount,
      reason: params.reason ?? null,
    });
  });
}

/**
 * Government → user funding transfer (new-user funding or an ad-hoc send from
 * the treasury). Tax-free by design: the Government is not taxing itself.
 */
export async function fundUserFromTreasury(params: {
  governmentId: string;
  receiverUserId: string;
  amount: number;
  reason: string;
  type?: "GOVERNMENT_FUNDING" | "GOVERNMENT_PAYMENT";
}): Promise<SendAerosResult> {
  const { governmentId, receiverUserId, amount, reason } = params;

  return db.transaction(async (tx) => {
    const result = await transferInTx(tx, {
      from: governmentWallet(governmentId),
      to: userWallet(receiverUserId),
      amount,
      forcedTaxRateBp: 0,
      type: params.type ?? "GOVERNMENT_FUNDING",
      reason,
      notify: {
        receiverType: "PAYMENT_RECEIVED",
        receiverMessage: (r) =>
          `You received ${r.netAmount.toLocaleString()} Aeros from Government. Ref ${r.txRef}.`,
      },
    });

    await recordAudit(tx, {
      action: params.type === "GOVERNMENT_PAYMENT" ? "GOVERNMENT_PAYMENT" : "GOVERNMENT_FUNDING",
      actorType: "GOVERNMENT",
      actorId: governmentId,
      actorLabel: result.senderUsername,
      targetType: "USER",
      targetId: receiverUserId,
      reason,
      metadata: { amount, reason, txRef: result.txRef },
    });

    return { ...result, receiverDisplayName: result.receiverLabel };
  });
}

/** Government → company payment from the treasury. Tax-free. */
export async function payCompanyFromTreasury(params: {
  governmentId: string;
  companyId: string;
  amount: number;
  reason: string;
  type?: "COMPANY_FUNDING" | "GOVERNMENT_PAYMENT";
}): Promise<TransferResult> {
  const { governmentId, companyId, amount, reason } = params;

  return db.transaction(async (tx) => {
    const result = await transferInTx(tx, {
      from: governmentWallet(governmentId),
      to: companyWallet(companyId),
      amount,
      forcedTaxRateBp: 0,
      type: params.type ?? "GOVERNMENT_PAYMENT",
      reason,
      skipReceiverCheck: params.type === "COMPANY_FUNDING",
      notify: {
        receiverType: "COMPANY_FUNDED",
        receiverMessage: (r) =>
          `${r.receiverLabel} received ${r.netAmount.toLocaleString()} Aeros from Government. Ref ${r.txRef}.`,
      },
    });

    await recordAudit(tx, {
      action: params.type === "COMPANY_FUNDING" ? "COMPANY_FUNDED" : "GOVERNMENT_PAYMENT",
      actorType: "GOVERNMENT",
      actorId: governmentId,
      actorLabel: result.senderUsername,
      targetType: "COMPANY",
      targetId: companyId,
      reason,
      metadata: { amount, reason, txRef: result.txRef },
    });

    return result;
  });
}
