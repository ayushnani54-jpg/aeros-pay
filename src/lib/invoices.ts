import "server-only";
import { db } from "@/db/client";
import {
  companies,
  government,
  invoices,
  marketplaceContracts,
  marketplaceOrders,
  users,
} from "@/db/schema";
import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, isNull, lt, sql, type SQL } from "drizzle-orm";
import { computeInvoiceTotals } from "./tax";
import { transferInTx } from "./payments";
import { companyWallet, governmentWallet, sameWallet, userWallet, type WalletRef } from "./wallets";
import { notifyUser } from "./notify";
import { recordAudit } from "./audit";
import {
  canUserReceive,
  canCompanyReceive,
  effectiveCompanyStatus,
} from "./status";
import { resolveEffectiveTaxRateBp } from "./taxmatrix";
import { deriveCompanySettlement, type SettlementDestination } from "./settlement";
import { runIdempotent, IdempotencyInProgressError } from "./idempotency";
import type { Company, Invoice } from "@/db/schema";

/**
 * UNIVERSAL INVOICES (V3 Phase B — spec §§4,5,6,7,8,9,10)
 * ===========================================================================
 *
 * An approved company can invoice a USER, another COMPANY, or the GOVERNMENT.
 * Three properties matter more than the rest and are worth stating plainly:
 *
 * 1. THE RECIPIENT IS RESOLVED SERVER-SIDE. `resolveInvoiceRecipient` takes a
 *    username plus an EXPLICIT recipient type and reads the entity itself. A
 *    GOVERNMENT invoice resolves to the `government` singleton — this module
 *    never touches `users` on that branch, so a Government official's personal
 *    wallet can never end up as the recipient of a Government invoice.
 *
 * 2. THE PAYABLE AMOUNT IS FROZEN AT ISSUE. `taxRateBp`, `taxAmount`,
 *    `subtotal` and `total` are SNAPSHOT onto the row when the invoice is
 *    created. Payment settles `invoice.total` from the snapshot and never
 *    re-resolves a rate, so a Government tax or matrix change after issue
 *    cannot alter what an existing invoice costs.
 *
 * 3. THE MONEY GOES TO THE COMPANY. `payInvoice` has NO destination parameter.
 *    The destination is derived from `invoices.company_id` by
 *    `src/lib/settlement.ts`, and `transferInTx` re-derives and re-asserts it
 *    inside the transaction. See that file for the full argument.
 *
 * Tax on invoices is taken from the COMPANY's proceeds, never added on top:
 * an 800 invoice at 5% means the payer pays 800, the tax is 40 and the company
 * receives 760. The snapshot already contains the tax, so payment passes it
 * through as a `forcedBreakdown` and can never charge tax twice.
 *
 * Invoices issued before this rule were add-on (total = subtotal + tax: pay
 * 840, company gets 800). They keep working: payInvoiceInTx accepts both
 * shapes and always settles `total`, with the company receiving `total - tax`.
 */

export class InvoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Anything that can run a `select` — `db` or an open transaction. */
type Executor = Pick<typeof db, "select">;

export const INVOICE_RECIPIENT_TYPES = ["USER", "COMPANY", "GOVERNMENT"] as const;
export type InvoiceRecipientType = (typeof INVOICE_RECIPIENT_TYPES)[number];

export function isInvoiceRecipientType(value: unknown): value is InvoiceRecipientType {
  return (
    typeof value === "string" &&
    (INVOICE_RECIPIENT_TYPES as readonly string[]).includes(value)
  );
}

/** A recipient the server has established for itself. */
export type ResolvedInvoiceRecipient = {
  type: InvoiceRecipientType;
  /** The wallet that will pay. Built here from an id read from the database. */
  wallet: WalletRef;
  /** users.id for a USER recipient, else null. */
  userId: string | null;
  /** companies.id for a COMPANY recipient, else null. */
  companyId: string | null;
  username: string;
  label: string;
  /** Who gets the "you have a new invoice" notification, if anyone. */
  notifyUserId: string | null;
};

/** Human-readable invoice number: INV-YYYYMMDD-NNNN, unique per day. */
async function nextInvoiceNumber(tx: Tx): Promise<string> {
  const now = new Date();
  const datePart = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  ].join("");

  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(invoices)
    .where(sql`${invoices.invoiceNumber} LIKE ${`INV-${datePart}-%`}`);

  const seq = (row?.count ?? 0) + 1;
  return `INV-${datePart}-${String(seq).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Recipient resolution
// ---------------------------------------------------------------------------

/**
 * Turns (recipient type, username) into a recipient the server trusts.
 *
 * The type is explicit and is NOT guessed from the username, so a company
 * cannot be invoiced by accident because it happens to share a handle style
 * with a person, and — the important one — a GOVERNMENT invoice is resolved
 * from the `government` table and nothing else. The username is ignored
 * entirely on the GOVERNMENT branch, which is why no user row can ever be
 * substituted for the Treasury.
 */
export async function resolveInvoiceRecipient(
  executor: Executor,
  params: { recipientType: InvoiceRecipientType; username?: string | null },
): Promise<ResolvedInvoiceRecipient> {
  const { recipientType } = params;
  if (!isInvoiceRecipientType(recipientType)) {
    throw new InvoiceError("Choose who this invoice is for.");
  }

  if (recipientType === "GOVERNMENT") {
    // The Treasury entity — never a Government official's personal wallet.
    const [gov] = await executor
      .select({ id: government.id, username: government.username })
      .from(government)
      .limit(1);
    if (!gov) throw new InvoiceError("Government account is not initialized.");
    return {
      type: "GOVERNMENT",
      wallet: governmentWallet(gov.id),
      userId: null,
      companyId: null,
      username: gov.username,
      label: "Government",
      // The Government has no notification inbox; it has the audit log.
      notifyUserId: null,
    };
  }

  const username = (params.username ?? "").trim().toLowerCase().replace(/^@/, "");
  if (username.length === 0) {
    throw new InvoiceError("A recipient username is required.");
  }

  if (recipientType === "USER") {
    const [row] = await executor
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        status: users.status,
        suspendedUntil: users.suspendedUntil,
      })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (!row) throw new InvoiceError("No user found with that username.");
    if (!canUserReceive(row)) {
      throw new InvoiceError("That account cannot be invoiced right now.");
    }
    return {
      type: "USER",
      wallet: userWallet(row.id),
      userId: row.id,
      companyId: null,
      username: row.username,
      label: row.displayName,
      notifyUserId: row.id,
    };
  }

  const [row] = await executor
    .select({
      id: companies.id,
      username: companies.username,
      name: companies.name,
      ownerUserId: companies.ownerUserId,
      status: companies.status,
      suspendedUntil: companies.suspendedUntil,
    })
    .from(companies)
    .where(eq(companies.username, username))
    .limit(1);
  if (!row) throw new InvoiceError("No company found with that username.");
  if (!canCompanyReceive(row)) {
    // PENDING, REJECTED and REVOKED companies are not economic participants.
    throw new InvoiceError("That company cannot be invoiced right now.");
  }
  return {
    type: "COMPANY",
    wallet: companyWallet(row.id),
    userId: null,
    companyId: row.id,
    username: row.username,
    label: row.name,
    notifyUserId: row.ownerUserId,
  };
}

/**
 * The (recipient type, handle) pair for a wallet the SERVER established.
 *
 * Phase C's marketplace orders and Phase D's contracts know their counterparty
 * as a wallet read from their own row, not as a typed-in username. Rather than
 * give `createInvoiceInTx` a second way to name a recipient, they turn that
 * wallet back into the handle the one existing resolver already understands —
 * so there is still exactly one recipient-resolution path in the app.
 */
export async function recipientTypeAndHandleFor(
  executor: Executor,
  wallet: WalletRef,
): Promise<{ recipientType: InvoiceRecipientType; username: string }> {
  if (wallet.kind === "USER") {
    const [row] = await executor
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, wallet.id))
      .limit(1);
    if (!row) throw new InvoiceError("The recipient account no longer exists.");
    return { recipientType: "USER", username: row.username };
  }
  if (wallet.kind === "COMPANY") {
    const [row] = await executor
      .select({ username: companies.username })
      .from(companies)
      .where(eq(companies.id, wallet.id))
      .limit(1);
    if (!row) throw new InvoiceError("The recipient company no longer exists.");
    return { recipientType: "COMPANY", username: row.username };
  }
  const [row] = await executor
    .select({ username: government.username })
    .from(government)
    .limit(1);
  if (!row) throw new InvoiceError("Government account is not initialized.");
  return { recipientType: "GOVERNMENT", username: row.username };
}

/** The wallet that must pay a given invoice row. Derived, never supplied. */
export async function invoicePayerWallet(
  executor: Executor,
  invoice: Pick<Invoice, "recipientType" | "buyerUserId" | "recipientCompanyId">,
): Promise<WalletRef> {
  if (invoice.recipientType === "USER") {
    if (!invoice.buyerUserId) throw new InvoiceError("This invoice has no recipient.");
    return userWallet(invoice.buyerUserId);
  }
  if (invoice.recipientType === "COMPANY") {
    if (!invoice.recipientCompanyId) throw new InvoiceError("This invoice has no recipient.");
    return companyWallet(invoice.recipientCompanyId);
  }
  const [gov] = await executor.select({ id: government.id }).from(government).limit(1);
  if (!gov) throw new InvoiceError("Government account is not initialized.");
  return governmentWallet(gov.id);
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export type CreateInvoiceParams = {
  company: Company;
  /**
   * V3: which kind of entity is being invoiced. Defaults to "USER" so every
   * V2 call site keeps its exact meaning.
   */
  recipientType?: InvoiceRecipientType;
  /** Recipient handle. Ignored for GOVERNMENT. */
  recipientUsername?: string | null;
  /** V2 alias for `recipientUsername` with `recipientType: "USER"`. */
  buyerUsername?: string;
  itemName: string;
  description?: string | null;
  quantity: number;
  unitPrice: number;
  note?: string | null;
  dueAt?: Date | null;
  /**
   * V3 Phase C: the marketplace order this invoice settles. `invoices`
   * carries a partial UNIQUE index on this column, so the database itself
   * refuses a second invoice for one order.
   */
  sourceOrderId?: string | null;
  /**
   * V3: which KIND of movement the future payment is, for the tax matrix. A
   * TypeScript literal chosen by the calling code path — never a request
   * value. Defaults to INVOICE_PAYMENT, which is what every V2/Phase B call
   * site means; the marketplace passes MARKETPLACE_ORDER and contracts pass
   * CONTRACT_PAYMENT so the Government can price those differently.
   */
  taxContext?: "INVOICE_PAYMENT" | "MARKETPLACE_ORDER" | "CONTRACT_PAYMENT";
};

export async function createInvoice(params: CreateInvoiceParams): Promise<Invoice> {
  return db.transaction((tx) => createInvoiceInTx(tx, params));
}

/**
 * The part of issuing an invoice that must happen in one transaction.
 *
 * Exported so a caller that is ALREADY inside a transaction — a marketplace
 * order raising its invoice, an awarded contract raising its invoice — can
 * reuse this one engine instead of writing a parallel one. That is what keeps
 * the frozen tax snapshot, the recipient resolution and the numbering
 * identical for every invoice in the app, whatever created it.
 */
export async function createInvoiceInTx(
  tx: Tx,
  params: CreateInvoiceParams,
): Promise<Invoice> {
  const { company, itemName, quantity, unitPrice } = params;
  const recipientType: InvoiceRecipientType = params.recipientType ?? "USER";
  const recipientUsername = params.recipientUsername ?? params.buyerUsername ?? null;

  if (effectiveCompanyStatus(company) !== "APPROVED") {
    throw new InvoiceError("Only an active company can issue invoices.");
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new InvoiceError("Quantity must be a whole number of at least 1.");
  }
  if (!Number.isInteger(unitPrice) || unitPrice < 1) {
    throw new InvoiceError("Unit price must be a whole number of at least 1 Aeros.");
  }

  const subtotal = quantity * unitPrice;

  {
    // The issuing company is re-read under a lock: the `company` argument is a
    // snapshot the caller loaded earlier and may be stale by now.
    const [issuer] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, company.id))
      .for("update");
    if (!issuer) throw new InvoiceError("The issuing company no longer exists.");
    if (effectiveCompanyStatus(issuer) !== "APPROVED") {
      throw new InvoiceError("Only an active company can issue invoices.");
    }

    const recipient = await resolveInvoiceRecipient(tx, {
      recipientType,
      username: recipientUsername,
    });

    // Self-invoicing is meaningless and would be a way to manufacture ledger
    // noise: the payer and the beneficiary would be the same wallet.
    const issuerWallet = companyWallet(issuer.id);
    if (sameWallet(recipient.wallet, issuerWallet)) {
      throw new InvoiceError("A company cannot invoice itself.");
    }

    // V3: the quoted rate comes from the one resolver (src/lib/taxmatrix.ts)
    // for the REAL pair of wallets, with context INVOICE_PAYMENT. With the
    // matrix unconfigured this returns the V2 answer, so existing invoices are
    // priced exactly as before.
    //
    // The rate and the amounts are then SNAPSHOT onto the invoice row, which
    // is what makes a later matrix change unable to re-price this invoice.
    const taxRateBp = await resolveEffectiveTaxRateBp(tx, {
      payer: recipient.wallet,
      recipient: issuerWallet,
      context: params.taxContext ?? "INVOICE_PAYMENT",
    });
    const totals = computeInvoiceTotals(subtotal, taxRateBp);

    const invoiceNumber = await nextInvoiceNumber(tx);

    const [invoice] = await tx
      .insert(invoices)
      .values({
        invoiceNumber,
        companyId: issuer.id,
        recipientType: recipient.type,
        buyerUserId: recipient.userId,
        recipientCompanyId: recipient.companyId,
        itemName,
        description: params.description ?? null,
        quantity,
        unitPrice,
        subtotal: totals.subtotal,
        taxRateBp,
        taxAmount: totals.taxAmount,
        total: totals.total,
        note: params.note ?? null,
        dueAt: params.dueAt ?? null,
        sourceOrderId: params.sourceOrderId ?? null,
      })
      .returning();

    const message = `${issuer.name} sent ${
      recipient.type === "COMPANY" ? `${recipient.label} ` : ""
    }invoice ${invoiceNumber} for ${totals.total.toLocaleString()} Aeros (${itemName}).`;

    if (recipient.notifyUserId) {
      await notifyUser(tx, recipient.notifyUserId, "INVOICE_RECEIVED", message, `/invoices/${invoice.id}`);
    }

    // A Government-addressed invoice has no inbox to land in, so it is
    // recorded in the audit log instead — it is never silently invisible.
    if (recipient.type === "GOVERNMENT") {
      await recordAudit(tx, {
        action: "INVOICE_ISSUED_TO_GOVERNMENT",
        actorType: "COMPANY",
        actorId: issuer.id,
        actorLabel: issuer.name,
        targetType: "INVOICE",
        targetId: invoice.id,
        newValue: String(totals.total),
        metadata: {
          invoiceNumber,
          itemName,
          subtotal: totals.subtotal,
          taxAmount: totals.taxAmount,
          total: totals.total,
        },
      });
    }

    return invoice;
  }
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

export type InvoicePaymentReceipt = {
  invoice: Invoice;
  txRef: string;
  /** True when this call replayed an earlier identical payment (§42). */
  replayed: boolean;
  /** Where the money actually went — always the issuing company's wallet. */
  settledTo: { kind: "COMPANY"; companyId: string; companyUsername: string };
};

/**
 * The idempotency key for an invoice payment.
 *
 * Derived entirely from server-established facts, so there is no client field
 * to forge or omit: the same payer retrying the same invoice always produces
 * the same key, which is exactly what makes a duplicate click, a double
 * submit, or a network retry replay instead of paying twice.
 */
function invoicePaymentKey(invoiceId: string, payer: WalletRef): string {
  return `INVPAY:${invoiceId}:${payer.kind}:${payer.id}`;
}

/** The part of paying an invoice that must happen in one transaction. */
async function payInvoiceInTx(
  tx: Tx,
  params: { invoiceId: string; payer: WalletRef },
): Promise<InvoicePaymentReceipt> {
  const { invoiceId, payer } = params;

  // Locked FOR UPDATE: every later check in this function reads a row no
  // concurrent payment can change underneath it.
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .for("update");

  if (!invoice) throw new InvoiceError("Invoice not found.");

  // Authorization: the payer must BE the invoice's recipient, and that
  // recipient is derived from the row, not from the request.
  const payerWallet = await invoicePayerWallet(tx, invoice);
  if (!sameWallet(payerWallet, payer)) {
    throw new InvoiceError("This invoice was not issued to you.");
  }

  // Re-verified INSIDE the transaction, after the lock (spec §41).
  if (invoice.status === "PAID") {
    throw new InvoiceError("This invoice has already been paid.");
  }
  if (invoice.status === "CANCELLED") {
    throw new InvoiceError("This invoice was cancelled.");
  }
  if (invoice.status === "EXPIRED") {
    throw new InvoiceError("This invoice has expired.");
  }
  if (invoice.dueAt && invoice.dueAt.getTime() < Date.now()) {
    // No UPDATE here: throwing rolls this transaction back, so marking the row
    // inside it would be undone. `expireInvoiceIfOverdue` does it durably in its
    // own transaction before we get here (and again on the next attempt if the
    // due date passed in between).
    throw new InvoiceError("This invoice has expired.");
  }

  const [issuer] = await tx
    .select()
    .from(companies)
    .where(eq(companies.id, invoice.companyId))
    .limit(1);
  if (!issuer) throw new InvoiceError("The issuing company no longer exists.");
  if (!canCompanyReceive(issuer)) {
    throw new InvoiceError("The issuing company cannot receive payments right now.");
  }

  // THE DESTINATION. Derived from the invoice's issuer by settlement.ts, which
  // can only ever produce that company's own wallet. `transferInTx` re-derives
  // it from `invoiceId` and asserts it again before moving anything, so this
  // cannot be redirected even by a caller that wanted to.
  const destination: SettlementDestination = await deriveCompanySettlement(tx, invoice.companyId);

  // The exact payable amount, computed server-side from the frozen snapshot.
  // The tax was fixed when the invoice was issued, so it is passed through
  // rather than resolved again — an invoice that already carries a tax amount
  // can never be taxed a second time.
  //
  // Two shapes exist and both are valid: the current one (total = subtotal,
  // tax comes out of the company's proceeds) and the older add-on one
  // (total = subtotal + tax). Anything else is refused.
  const currentShape = invoice.total === invoice.subtotal;
  const legacyAddOnShape = invoice.total === invoice.subtotal + invoice.taxAmount;
  if ((!currentShape && !legacyAddOnShape) || invoice.taxAmount > invoice.total) {
    throw new InvoiceError("This invoice's amounts are inconsistent and it cannot be paid.");
  }

  const result = await transferInTx(tx, {
    from: payer,
    to: destination.wallet,
    settlement: destination,
    amount: invoice.total,
    // An invoice raised for a marketplace order is recorded on the ledger as
    // the marketplace payment it is. The destination guarantee is unchanged:
    // `settlement` and `invoiceId` are both present, so `transferInTx` still
    // re-derives the issuing company's wallet and refuses anything else.
    type: invoice.sourceOrderId ? "MARKETPLACE_PAYMENT" : "INVOICE_PAYMENT",
    taxContext: invoice.sourceOrderId ? "MARKETPLACE_ORDER" : "INVOICE_PAYMENT",
    invoiceId: invoice.id,
    reason: `Invoice ${invoice.invoiceNumber} — ${invoice.itemName}`,
    forcedBreakdown: {
      grossAmount: invoice.total,
      taxAmount: invoice.taxAmount,
      netAmount: invoice.total - invoice.taxAmount,
      taxRateBpApplied: invoice.taxAmount > 0 ? invoice.taxRateBp : 0,
    },
    notify: {
      senderType: "INVOICE_PAID",
      senderMessage: (r) =>
        `You paid invoice ${invoice.invoiceNumber} — ${r.grossAmount.toLocaleString()} Aeros to ${issuer.name}. Ref ${r.txRef}.`,
      receiverType: "INVOICE_PAID",
      receiverMessage: (r) =>
        `Invoice ${invoice.invoiceNumber} was paid — ${r.netAmount.toLocaleString()} Aeros received. Ref ${r.txRef}.`,
      href: `/invoices/${invoice.id}`,
    },
  });

  // Guarded status transition: only flips a still-PENDING invoice, so two
  // concurrent payments can never both mark it PAID.
  const marked = await tx
    .update(invoices)
    .set({ status: "PAID", paidAt: new Date(), paidTxRef: result.txRef })
    .where(and(eq(invoices.id, invoice.id), eq(invoices.status, "PENDING")))
    .returning();

  if (marked.length === 0) {
    // Another concurrent request settled it first — roll everything back.
    throw new InvoiceError("This invoice has already been paid.");
  }

  // The entity this invoice was raised FOR moves with it, in the SAME
  // transaction, so an order can never be PAYMENT_DUE while its invoice says
  // PAID (or the reverse). Both updates are guarded on the state they expect,
  // so a cancelled or expired order rolls the whole payment back instead of
  // being quietly resurrected.
  await settleSourceOrder(tx, invoice, result.txRef);
  await settleSourceContract(tx, invoice, result.txRef);

  return {
    invoice: marked[0],
    txRef: result.txRef,
    replayed: false,
    settledTo: {
      kind: "COMPANY",
      companyId: destination.companyId,
      companyUsername: destination.companyUsername,
    },
  };
}

/**
 * Moves the marketplace order this invoice was raised for, in the payment's own
 * transaction.
 *
 * Deliberately written against the `marketplace_orders` table directly rather
 * than by calling into src/lib/marketplace.ts: marketplace.ts uses the invoice
 * engine, so importing it back would be a cycle. The guard is the point — only
 * an order that is genuinely PAYMENT_DUE moves, so paying the invoice of an
 * order that has meanwhile been cancelled or expired rolls the entire payment
 * back instead of quietly reviving it.
 */
async function settleSourceOrder(tx: Tx, invoice: Invoice, txRef: string): Promise<void> {
  if (!invoice.sourceOrderId) return;

  const [order] = await tx
    .select({ id: marketplaceOrders.id, status: marketplaceOrders.status, orderNumber: marketplaceOrders.orderNumber })
    .from(marketplaceOrders)
    .where(eq(marketplaceOrders.id, invoice.sourceOrderId))
    .for("update");
  if (!order) throw new InvoiceError("The order this invoice belongs to no longer exists.");

  if (order.status === "CANCELLED") {
    throw new InvoiceError("The order this invoice belongs to was cancelled.");
  }
  if (order.status === "EXPIRED") {
    throw new InvoiceError("The order this invoice belongs to has expired.");
  }

  const moved = await tx
    .update(marketplaceOrders)
    .set({ status: "PAID", paidAt: new Date() })
    .where(and(eq(marketplaceOrders.id, order.id), eq(marketplaceOrders.status, "PAYMENT_DUE")))
    .returning({ id: marketplaceOrders.id });

  if (moved.length === 0) {
    throw new InvoiceError(
      `Order ${order.orderNumber} is ${order.status} and cannot take this payment.`,
    );
  }

  void txRef;
}

/**
 * Completes the contract this invoice was raised for, in the payment's own
 * transaction. `contract_status` has no PAID state: paying the contract's
 * invoice IS the completion, so AWARDED → COMPLETED here.
 */
async function settleSourceContract(tx: Tx, invoice: Invoice, txRef: string): Promise<void> {
  const [contract] = await tx
    .select({
      id: marketplaceContracts.id,
      status: marketplaceContracts.status,
      contractNumber: marketplaceContracts.contractNumber,
    })
    .from(marketplaceContracts)
    .where(eq(marketplaceContracts.invoiceId, invoice.id))
    .for("update");
  if (!contract) return;

  if (contract.status !== "AWARDED") {
    throw new InvoiceError(
      `Contract ${contract.contractNumber} is ${contract.status} and cannot take this payment.`,
    );
  }

  const moved = await tx
    .update(marketplaceContracts)
    .set({ status: "COMPLETED", closedAt: new Date(), paidTxRef: txRef })
    .where(
      and(eq(marketplaceContracts.id, contract.id), eq(marketplaceContracts.status, "AWARDED")),
    )
    .returning({ id: marketplaceContracts.id });

  if (moved.length === 0) {
    throw new InvoiceError("This contract changed while the payment was being made.");
  }
}

/**
 * Pays an invoice atomically and idempotently.
 *
 * Everything — the payability re-check, the funds check, the balance moves, the
 * tax credit, the ledger row, the invoice ↔ transaction link, the status flip
 * and both notifications — happens in one transaction, wrapped in one
 * idempotency key (spec §§41,42,46,47).
 *
 * Failure modes, all of them handled rather than assumed away:
 *
 *   already paid / cancelled / expired   rejected inside the transaction
 *   insufficient funds                   the conditional debit fails, the whole
 *                                        transaction rolls back
 *   duplicate click / network retry       same derived key → the first result is
 *                                        replayed, no second ledger row
 *   two concurrent payments              one claims the key, the other is told
 *                                        the request is in progress; and even
 *                                        without the key, the row lock plus the
 *                                        guarded UPDATE leaves exactly one winner
 *
 * `payer` is the wallet the server established from the session's acting
 * context. `payerUserId` is the V2 spelling and still means "this user's
 * personal wallet".
 */
export async function payInvoice(params: {
  invoiceId: string;
  payer?: WalletRef;
  payerUserId?: string;
  /**
   * Set false only by library callers that already sit inside their own
   * retry-safe boundary (the existing V2 test suites). Product code leaves it
   * alone: idempotency is on by default.
   */
  idempotent?: boolean;
}): Promise<InvoicePaymentReceipt> {
  const payer =
    params.payer ?? (params.payerUserId ? userWallet(params.payerUserId) : null);
  if (!payer) throw new InvoiceError("A paying wallet is required.");

  const { invoiceId } = params;

  // Durable, guarded expiry BEFORE the payment transaction: a PENDING invoice
  // whose due date has passed is marked EXPIRED in its own committed statement,
  // so the stored row agrees with what the payment path is about to refuse.
  await expireInvoiceIfOverdue(invoiceId);

  if (params.idempotent === false) {
    return db.transaction((tx) => payInvoiceInTx(tx, { invoiceId, payer }));
  }

  // The facts are all server-established; a key can therefore never be reused
  // to push through a different payment.
  const outcome = await runIdempotent<InvoicePaymentReceipt>({
    key: invoicePaymentKey(invoiceId, payer),
    scope: "INVOICE_PAYMENT",
    actor: { type: payer.kind, id: payer.id },
    facts: { invoiceId, payerKind: payer.kind, payerId: payer.id },
    perform: async (tx) => {
      const receipt = await payInvoiceInTx(tx, { invoiceId, payer });
      return {
        value: receipt,
        txRef: receipt.txRef,
        entityType: "INVOICE",
        entityId: receipt.invoice.id,
      };
    },
    replay: async (record) => {
      // Rebuild the original receipt from the recorded reference. The invoice
      // row is the authority for the amounts; the txRef is the one that was
      // actually written.
      const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
      if (!row || !record.resultTxRef) {
        throw new InvoiceError("This payment was already made but its receipt could not be read.");
      }
      const destination = await deriveCompanySettlement(db, row.companyId);
      return {
        invoice: row,
        txRef: record.resultTxRef,
        replayed: true,
        settledTo: {
          kind: "COMPANY",
          companyId: destination.companyId,
          companyUsername: destination.companyUsername,
        },
      };
    },
  });

  return { ...outcome.value, replayed: outcome.replayed };
}

/** True when the error means "another attempt at this same payment is live". */
export function isPaymentInProgress(e: unknown): boolean {
  return e instanceof IdempotencyInProgressError;
}

// ---------------------------------------------------------------------------
// Cancellation & expiry
// ---------------------------------------------------------------------------

export async function cancelInvoice(params: {
  invoiceId: string;
  companyId: string;
  actorLabel: string;
}): Promise<Invoice> {
  const { invoiceId, companyId, actorLabel } = params;

  return db.transaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .for("update");

    if (!invoice) throw new InvoiceError("Invoice not found.");
    if (invoice.companyId !== companyId) {
      throw new InvoiceError("This invoice does not belong to your company.");
    }
    if (invoice.status === "PAID") {
      throw new InvoiceError("A paid invoice cannot be cancelled.");
    }
    if (invoice.status === "CANCELLED") return invoice;

    const [updated] = await tx
      .update(invoices)
      .set({ status: "CANCELLED", cancelledAt: new Date() })
      .where(eq(invoices.id, invoiceId))
      .returning();

    await recordAudit(tx, {
      action: "INVOICE_CANCELLED",
      actorType: "COMPANY",
      actorId: companyId,
      actorLabel,
      targetType: "INVOICE",
      targetId: invoiceId,
      previousValue: invoice.status,
      newValue: "CANCELLED",
      metadata: { invoiceNumber: invoice.invoiceNumber },
    });

    // Only a wallet with an inbox can be notified: a USER recipient directly,
    // a COMPANY recipient through its owner, the Government not at all.
    const notifyUserId = await recipientInboxUserId(tx, invoice);
    if (notifyUserId) {
      await notifyUser(
        tx,
        notifyUserId,
        "INVOICE_CANCELLED",
        `Invoice ${invoice.invoiceNumber} was cancelled by ${actorLabel}.`,
        `/invoices/${invoice.id}`,
      );
    }

    return updated;
  });
}

/** The user who should hear about activity on an invoice's recipient side. */
async function recipientInboxUserId(
  executor: Executor,
  invoice: Pick<Invoice, "recipientType" | "buyerUserId" | "recipientCompanyId">,
): Promise<string | null> {
  if (invoice.recipientType === "USER") return invoice.buyerUserId ?? null;
  if (invoice.recipientType === "COMPANY" && invoice.recipientCompanyId) {
    const [row] = await executor
      .select({ ownerUserId: companies.ownerUserId })
      .from(companies)
      .where(eq(companies.id, invoice.recipientCompanyId))
      .limit(1);
    return row?.ownerUserId ?? null;
  }
  return null;
}

/**
 * Marks ONE overdue PENDING invoice EXPIRED, in its own transaction.
 *
 * Guarded on `status = 'PENDING'`, so it can never touch a paid or cancelled
 * invoice and is safe to call concurrently. Returns true when it changed the row.
 */
export async function expireInvoiceIfOverdue(invoiceId: string): Promise<boolean> {
  const rows = await db
    .update(invoices)
    .set({ status: "EXPIRED" })
    .where(
      and(
        eq(invoices.id, invoiceId),
        eq(invoices.status, "PENDING"),
        lt(invoices.dueAt, new Date()),
      ),
    )
    .returning({ id: invoices.id });
  return rows.length > 0;
}

/** Marks overdue PENDING invoices EXPIRED. Cheap and safe to call often. */
export async function expireOverdueInvoices(): Promise<number> {
  const rows = await db
    .update(invoices)
    .set({ status: "EXPIRED" })
    .where(and(eq(invoices.status, "PENDING"), lt(invoices.dueAt, new Date())))
    .returning({ id: invoices.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Lookups
//
// Every read path below is recipient-type agnostic. The recipient joins are
// LEFT joins, so a COMPANY- or GOVERNMENT-addressed invoice is as readable and
// as listable as a USER-addressed one. (Phase A left `getInvoiceById` with an
// inner join on `users`, which made non-user invoices invisible; that is fixed
// here.)
// ---------------------------------------------------------------------------

const issuerCompany = alias(companies, "issuer_company");
const recipientCompany = alias(companies, "recipient_company");
const recipientUser = alias(users, "recipient_user");

export type InvoiceRecipientSummary = {
  type: InvoiceRecipientType;
  username: string;
  label: string;
  userId: string | null;
  companyId: string | null;
};

const invoiceRecipientColumns = {
  recipientUserId: recipientUser.id,
  recipientUserUsername: recipientUser.username,
  recipientUserDisplayName: recipientUser.displayName,
  recipientCompanyId: recipientCompany.id,
  recipientCompanyUsername: recipientCompany.username,
  recipientCompanyName: recipientCompany.name,
} as const;

type RawRecipientColumns = {
  recipientUserId: string | null;
  recipientUserUsername: string | null;
  recipientUserDisplayName: string | null;
  recipientCompanyId: string | null;
  recipientCompanyUsername: string | null;
  recipientCompanyName: string | null;
};

let governmentHandle: string | null = null;

/** The Treasury's handle, for labelling GOVERNMENT-addressed invoices. */
async function govHandle(): Promise<string> {
  if (governmentHandle) return governmentHandle;
  const [row] = await db.select({ username: government.username }).from(government).limit(1);
  governmentHandle = row?.username ?? "government";
  return governmentHandle;
}

function summariseRecipient(
  invoice: Pick<Invoice, "recipientType">,
  raw: RawRecipientColumns,
  govUsername: string,
): InvoiceRecipientSummary {
  if (invoice.recipientType === "COMPANY") {
    return {
      type: "COMPANY",
      username: raw.recipientCompanyUsername ?? "unknown",
      label: raw.recipientCompanyName ?? "Unknown company",
      userId: null,
      companyId: raw.recipientCompanyId,
    };
  }
  if (invoice.recipientType === "GOVERNMENT") {
    return {
      type: "GOVERNMENT",
      username: govUsername,
      label: "Government",
      userId: null,
      companyId: null,
    };
  }
  return {
    type: "USER",
    username: raw.recipientUserUsername ?? "unknown",
    label: raw.recipientUserDisplayName ?? "Unknown user",
    userId: raw.recipientUserId,
    companyId: null,
  };
}

export type InvoiceWithParties = {
  invoice: Invoice;
  /** The issuing company. */
  company: Company;
  recipient: InvoiceRecipientSummary;
  /** V2-compatible shorthand; null unless the recipient is a USER. */
  buyer: { id: string; username: string; displayName: string } | null;
};

export async function getInvoiceById(invoiceId: string): Promise<InvoiceWithParties | null> {
  const [row] = await db
    .select({
      invoice: invoices,
      company: issuerCompany,
      ...invoiceRecipientColumns,
    })
    .from(invoices)
    .innerJoin(issuerCompany, eq(issuerCompany.id, invoices.companyId))
    .leftJoin(recipientUser, eq(recipientUser.id, invoices.buyerUserId))
    .leftJoin(recipientCompany, eq(recipientCompany.id, invoices.recipientCompanyId))
    .where(eq(invoices.id, invoiceId))
    .limit(1);

  if (!row) return null;

  const recipient = summariseRecipient(row.invoice, row, await govHandle());

  return {
    invoice: row.invoice,
    company: row.company,
    recipient,
    buyer:
      recipient.type === "USER" && row.recipientUserId
        ? {
            id: row.recipientUserId,
            username: row.recipientUserUsername ?? "",
            displayName: row.recipientUserDisplayName ?? "",
          }
        : null,
  };
}

export type SentInvoiceRow = {
  invoice: Invoice;
  recipient: InvoiceRecipientSummary;
  /** V2-compatible aliases so existing markup keeps working. */
  buyerUsername: string;
  buyerDisplayName: string;
};

/** Sent Invoices: everything this company has issued, to any recipient type. */
export async function getSentInvoicesForCompany(
  companyId: string,
  limit = 100,
): Promise<SentInvoiceRow[]> {
  const rows = await db
    .select({ invoice: invoices, ...invoiceRecipientColumns })
    .from(invoices)
    .leftJoin(recipientUser, eq(recipientUser.id, invoices.buyerUserId))
    .leftJoin(recipientCompany, eq(recipientCompany.id, invoices.recipientCompanyId))
    .where(eq(invoices.companyId, companyId))
    .orderBy(desc(invoices.createdAt))
    .limit(limit);

  const gov = await govHandle();
  return rows.map((row) => {
    const recipient = summariseRecipient(row.invoice, row, gov);
    return {
      invoice: row.invoice,
      recipient,
      buyerUsername: recipient.username,
      buyerDisplayName: recipient.label,
    };
  });
}

/** Kept as the V2 name. */
export async function getInvoicesForCompany(companyId: string, limit = 100) {
  return getSentInvoicesForCompany(companyId, limit);
}

export type ReceivedInvoiceRow = {
  invoice: Invoice;
  companyName: string;
  companyUsername: string;
};

async function receivedInvoices(
  where: SQL<unknown>,
  limit: number,
): Promise<ReceivedInvoiceRow[]> {
  return db
    .select({
      invoice: invoices,
      companyName: issuerCompany.name,
      companyUsername: issuerCompany.username,
    })
    .from(invoices)
    .innerJoin(issuerCompany, eq(issuerCompany.id, invoices.companyId))
    .where(where)
    .orderBy(desc(invoices.createdAt))
    .limit(limit);
}

/** Received Invoices for a personal wallet. */
export async function getReceivedInvoicesForUser(userId: string, limit = 100) {
  return receivedInvoices(
    and(eq(invoices.recipientType, "USER"), eq(invoices.buyerUserId, userId)) as SQL<unknown>,
    limit,
  );
}

/** Received Invoices for a company wallet. */
export async function getReceivedInvoicesForCompany(companyId: string, limit = 100) {
  return receivedInvoices(
    and(
      eq(invoices.recipientType, "COMPANY"),
      eq(invoices.recipientCompanyId, companyId),
    ) as SQL<unknown>,
    limit,
  );
}

/** Received Invoices addressed to the Treasury. */
export async function getReceivedInvoicesForGovernment(limit = 100) {
  return receivedInvoices(eq(invoices.recipientType, "GOVERNMENT"), limit);
}

/** Received Invoices for whichever wallet the viewer is acting as. */
export async function getReceivedInvoicesForWallet(
  wallet: WalletRef,
  limit = 100,
): Promise<ReceivedInvoiceRow[]> {
  if (wallet.kind === "USER") return getReceivedInvoicesForUser(wallet.id, limit);
  if (wallet.kind === "COMPANY") return getReceivedInvoicesForCompany(wallet.id, limit);
  return getReceivedInvoicesForGovernment(limit);
}

/** Kept as the V2 name. */
export async function getInvoicesForBuyer(buyerUserId: string, limit = 100) {
  return getReceivedInvoicesForUser(buyerUserId, limit);
}

async function pendingCount(where: SQL<unknown>): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(invoices)
    .where(and(where, eq(invoices.status, "PENDING")));
  return row?.count ?? 0;
}

export async function getPendingInvoiceCountForWallet(wallet: WalletRef): Promise<number> {
  if (wallet.kind === "USER") {
    return pendingCount(
      and(eq(invoices.recipientType, "USER"), eq(invoices.buyerUserId, wallet.id)) as SQL<unknown>,
    );
  }
  if (wallet.kind === "COMPANY") {
    return pendingCount(
      and(
        eq(invoices.recipientType, "COMPANY"),
        eq(invoices.recipientCompanyId, wallet.id),
      ) as SQL<unknown>,
    );
  }
  return pendingCount(eq(invoices.recipientType, "GOVERNMENT"));
}

export async function getPendingInvoiceCountForBuyer(buyerUserId: string): Promise<number> {
  return getPendingInvoiceCountForWallet(userWallet(buyerUserId));
}

/**
 * Every invoice with no recipient row at all. Exists so a reader can prove the
 * widened read paths are not silently hiding anything.
 */
export async function countOrphanedInvoices(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(invoices)
    .where(and(eq(invoices.recipientType, "USER"), isNull(invoices.buyerUserId)));
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Who may see (and pay) an invoice
// ---------------------------------------------------------------------------

export type InvoiceViewerRole = {
  canView: boolean;
  /** The viewer owns the issuing company. */
  isIssuer: boolean;
  /** The viewer is acting AS the wallet that must pay. */
  isPayer: boolean;
  /** The viewer owns the recipient company but is not acting as it. */
  isRecipientOwnerInWrongContext: boolean;
};

/**
 * An invoice is private to the issuing company's owner and to its recipient.
 *
 * A company-addressed invoice can only be PAID while acting as that company —
 * the payer is the wallet, not the person — so the owner reading it from their
 * personal wallet is shown the invoice and told to switch context rather than
 * being handed a Pay button that would debit the wrong wallet.
 */
export function invoiceViewerRole(
  row: Pick<InvoiceWithParties, "invoice" | "company" | "recipient">,
  viewer: { userId: string; wallet: WalletRef; ownedCompanyIds: string[] },
): InvoiceViewerRole {
  const { invoice, company, recipient } = row;

  const isIssuer = company.ownerUserId === viewer.userId;

  const isPayer =
    (invoice.recipientType === "USER" &&
      viewer.wallet.kind === "USER" &&
      viewer.wallet.id === invoice.buyerUserId) ||
    (invoice.recipientType === "COMPANY" &&
      viewer.wallet.kind === "COMPANY" &&
      viewer.wallet.id === invoice.recipientCompanyId);

  const ownsRecipientCompany =
    invoice.recipientType === "COMPANY" &&
    !!recipient.companyId &&
    viewer.ownedCompanyIds.includes(recipient.companyId);

  const isRecipientUser =
    invoice.recipientType === "USER" && invoice.buyerUserId === viewer.userId;

  return {
    canView: isIssuer || isPayer || ownsRecipientCompany || isRecipientUser,
    isIssuer,
    isPayer,
    isRecipientOwnerInWrongContext: ownsRecipientCompany && !isPayer,
  };
}
