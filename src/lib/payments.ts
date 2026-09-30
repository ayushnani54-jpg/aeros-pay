import "server-only";
import { db } from "@/db/client";
import { companies, government, notifications, transactions, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { computeTax, resolveTransactionType, type TaxBreakdown } from "./tax";
import {
  resolveEffectiveTaxRateBp,
  type TaxTransactionContext,
} from "./taxmatrix";
import {
  assertSettlementDestination,
  deriveInvoiceSettlement,
  type SettlementDestination,
} from "./settlement";
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
  /** Overrides the breakdown entirely — used by invoice settlement, where the
   * tax was already fixed when the invoice was issued (and, for old add-on
   * invoices, was added on top of the quoted subtotal). */
  forcedBreakdown?: TaxBreakdown;
  /**
   * WHICH KIND of movement this is, for the V3 tax matrix. It is a TypeScript
   * literal picked by the calling code path — never a value read from a
   * request — and it cannot change the rate except through a matrix row the
   * Government configured. Defaults to DIRECT_TRANSFER, which with an
   * unconfigured matrix reproduces V2 behaviour exactly.
   */
  taxContext?: TaxTransactionContext;
  /** Overrides the ledger transaction type. */
  type?: string;
  reason?: string | null;
  invoiceId?: string | null;
  /**
   * V3 (spec §18): the ledger row this movement UNDOES. Set only by
   * src/lib/reversals.ts. The original row is never touched — the link lives on
   * the new row, which is what keeps the ledger append-only.
   */
  reversesTransactionId?: string | null;
  /**
   * V3 anti-tax-routing (spec §4). A destination derived by
   * `src/lib/settlement.ts` from a company row the server read itself. When
   * present, `to` MUST be exactly that wallet or the transfer is refused
   * before any balance moves. Phase C's marketplace orders pass this and
   * inherit the guarantee with no extra checks.
   */
  settlement?: SettlementDestination;
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

  // --- V3 anti-tax-routing enforcement (spec §4) ---------------------------
  //
  // This runs BEFORE the wallets are locked and before anything moves, and it
  // is not optional: any transfer that claims to settle an invoice has its
  // destination re-derived from that invoice's own issuer column, inside this
  // transaction, and compared. A company invoice therefore cannot be made to
  // settle to the owner's personal wallet by ANY caller — not by a form field,
  // not by a server action, not by a future module assembling a transfer by
  // hand — because the layer that writes the balances refuses first.
  if (options.settlement) {
    assertSettlementDestination(options.settlement, to);
  }
  if (options.invoiceId) {
    assertSettlementDestination(await deriveInvoiceSettlement(tx, options.invoiceId), to);
  }
  if (options.type === "INVOICE_PAYMENT" && to.kind !== "COMPANY") {
    throw new PaymentError("An invoice payment must settle to a company wallet.");
  }

  // A forced breakdown replaces tax resolution entirely, so it is checked for
  // internal consistency here rather than trusted: it must describe exactly
  // the amount being moved and must satisfy gross = tax + net in integers.
  if (options.forcedBreakdown) {
    const b = options.forcedBreakdown;
    const parts = [b.grossAmount, b.taxAmount, b.netAmount, b.taxRateBpApplied];
    if (!parts.every((n) => Number.isInteger(n))) {
      throw new PaymentError("Payment amounts must be whole numbers of Aeros.");
    }
    if (b.grossAmount !== amount) {
      throw new PaymentError("Payment breakdown does not match the amount being paid.");
    }
    if (b.taxAmount < 0 || b.netAmount < 0 || b.taxAmount + b.netAmount !== b.grossAmount) {
      throw new PaymentError("Payment breakdown does not balance.");
    }
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
    // V3: the rate is decided in exactly one place (src/lib/taxmatrix.ts),
    // which consults the Government's tax matrix and falls back to the V2
    // rules when it is unconfigured. It reads every rate it uses from the
    // database inside THIS transaction, under the row locks taken above, so
    // the values are the same ones V2 read from the locked rows.
    //
    // `forcedTaxRateBp` is still honoured and still bypasses resolution
    // entirely: it is only ever set by server-side administrative paths
    // (treasury funding, company funding) that are tax-free by design.
    const rateBp =
      options.forcedTaxRateBp ??
      (await resolveEffectiveTaxRateBp(tx, {
        payer: from,
        recipient: to,
        context: options.taxContext ?? "DIRECT_TRANSFER",
      }));
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
    reversesTransactionId: options.reversesTransactionId ?? null,
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

// ---------------------------------------------------------------------------
// Server-side payee resolution (spec §10)
// ---------------------------------------------------------------------------

/**
 * What the payer is shown before they confirm. Deliberately carries NO
 * balance: a payer must never learn what anyone else holds (spec §10).
 */
export type ResolvedPayee = {
  kind: "USER" | "COMPANY" | "GOVERNMENT";
  /** The handle that was resolved, as stored. */
  username: string;
  /** Display name: a person's display name, a company's name, "Government". */
  label: string;
  /** One-word noun for the confirm line: "person", "company", "Government". */
  what: string;
};

type AnyExecutor = Pick<typeof db, "select">;

/**
 * Resolves a typed-in username to the wallet that should be paid.
 *
 * The resolution order is users → companies → the Government handle, so an
 * existing personal or company handle always wins and V2 behaviour is
 * unchanged; the Government is only matched when nothing else owns the handle.
 * `toGovernment` remains an explicit, authoritative choice.
 *
 * The returned `WalletRef` is built here from an id this function read from the
 * database. A wallet id supplied by a client is never accepted anywhere in the
 * payment path — there is no parameter for one.
 */
async function resolvePayeeRef(
  executor: AnyExecutor,
  params: { username: string; toGovernment?: boolean },
): Promise<{ wallet: WalletRef; payee: ResolvedPayee }> {
  const username = params.username.trim().toLowerCase().replace(/^@/, "");

  const [gov] = await executor
    .select({ id: government.id, username: government.username })
    .from(government)
    .limit(1);
  if (!gov) throw new PaymentError("Government account is not initialized.");

  if (params.toGovernment) {
    return {
      wallet: governmentWallet(gov.id),
      payee: { kind: "GOVERNMENT", username: gov.username, label: "Government", what: "Government" },
    };
  }

  if (username.length === 0) throw new PaymentError("Recipient is required.");

  const [userRow] = await executor
    .select({ id: users.id, username: users.username, displayName: users.displayName })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (userRow) {
    return {
      wallet: userWallet(userRow.id),
      payee: {
        kind: "USER",
        username: userRow.username,
        label: userRow.displayName,
        what: "person",
      },
    };
  }

  const [companyRow] = await executor
    .select({ id: companies.id, username: companies.username, name: companies.name })
    .from(companies)
    .where(eq(companies.username, username))
    .limit(1);
  if (companyRow) {
    return {
      wallet: companyWallet(companyRow.id),
      payee: {
        kind: "COMPANY",
        username: companyRow.username,
        label: companyRow.name,
        what: "company",
      },
    };
  }

  if (username === gov.username.toLowerCase()) {
    return {
      wallet: governmentWallet(gov.id),
      payee: { kind: "GOVERNMENT", username: gov.username, label: "Government", what: "Government" },
    };
  }

  throw new PaymentError("Username not found.");
}

/** Public, read-only resolution for the Pay screen's search step. */
export async function resolvePayee(params: {
  username: string;
  toGovernment?: boolean;
}): Promise<ResolvedPayee> {
  const { payee } = await resolvePayeeRef(db, params);
  return payee;
}

/**
 * Resolves a recipient username to a `WalletRef`, INSIDE an already-open
 * transaction, so a caller that needs to do other guarded work (checking and
 * spending an allowance, for instance) in the same transaction as the
 * transfer can still resolve "who is this username" from the database under
 * that same transaction rather than opening a second one.
 *
 * V3 offline-payment sync (src/lib/offline-auth.ts) is the reason this
 * exists: it needs the allowance check, the allowance spend and the transfer
 * itself to commit or fail together. This is a thin, additive wrapper around
 * the exact resolution `payByUsername` already uses — no new lookup logic,
 * and `payByUsername`/`transfer`/`transferInTx` themselves are unchanged.
 */
export async function resolvePayeeRefInTx(
  tx: Tx,
  params: { username: string; toGovernment?: boolean },
): Promise<WalletRef> {
  const { wallet } = await resolvePayeeRef(tx, params);
  return wallet;
}

/**
 * Server-computed quote for the Pay screen: amount → tax → what the recipient
 * receives. The rate comes from `src/lib/taxmatrix.ts` for the real, resolved
 * pair of wallets, so the number the payer confirms is the number the server
 * will charge. Nothing here is taken from the client except the amount.
 */
export async function quotePayment(params: {
  from: WalletRef;
  username: string;
  toGovernment?: boolean;
  amount: number;
}): Promise<{
  payee: ResolvedPayee;
  grossAmount: number;
  taxAmount: number;
  netAmount: number;
  taxRateBp: number;
}> {
  if (!Number.isInteger(params.amount) || params.amount < MIN_TRANSACTION_AMOUNT) {
    throw new PaymentError(`Minimum payment is ${MIN_TRANSACTION_AMOUNT} Aeros.`);
  }

  const { wallet, payee } = await resolvePayeeRef(db, params);
  if (sameWallet(params.from, wallet)) {
    throw new PaymentError("You cannot send Aeros to yourself.");
  }

  const rateBp = await resolveEffectiveTaxRateBp(db, {
    payer: params.from,
    recipient: wallet,
    context: "DIRECT_TRANSFER",
  });
  const breakdown = computeTax(params.amount, rateBp);

  return {
    payee,
    grossAmount: breakdown.grossAmount,
    taxAmount: breakdown.taxAmount,
    netAmount: breakdown.netAmount,
    taxRateBp: breakdown.taxRateBpApplied,
  };
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
    // Resolved inside the transaction, from the database, by username only.
    const { wallet: to } = await resolvePayeeRef(tx, {
      username: recipientUsername,
      toGovernment,
    });

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
