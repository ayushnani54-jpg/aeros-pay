import "server-only";
import { db } from "@/db/client";
import { companies, invoices, users } from "@/db/schema";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { computeInvoiceTotals } from "./tax";
import { transferInTx } from "./payments";
import { companyWallet, userWallet } from "./wallets";
import { notifyUser } from "./notify";
import { recordAudit } from "./audit";
import { canUserReceive, canCompanyReceive, effectiveCompanyStatus } from "./status";
import { resolveCompanyTaxRateBp } from "./companies";
import type { Company, Invoice } from "@/db/schema";

export class InvoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
// Creation
// ---------------------------------------------------------------------------

export async function createInvoice(params: {
  company: Company;
  buyerUsername: string;
  itemName: string;
  description?: string | null;
  quantity: number;
  unitPrice: number;
  note?: string | null;
  dueAt?: Date | null;
}): Promise<Invoice> {
  const { company, buyerUsername, itemName, quantity, unitPrice } = params;

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
  const taxRateBp = await resolveCompanyTaxRateBp(company);
  const totals = computeInvoiceTotals(subtotal, taxRateBp);

  return db.transaction(async (tx) => {
    const [buyer] = await tx
      .select()
      .from(users)
      .where(eq(users.username, buyerUsername))
      .limit(1);
    if (!buyer) throw new InvoiceError("No user found with that username.");
    if (!canUserReceive(buyer)) {
      throw new InvoiceError("That account cannot be invoiced right now.");
    }

    const invoiceNumber = await nextInvoiceNumber(tx);

    const [invoice] = await tx
      .insert(invoices)
      .values({
        invoiceNumber,
        companyId: company.id,
        buyerUserId: buyer.id,
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
      })
      .returning();

    await notifyUser(
      tx,
      buyer.id,
      "INVOICE_RECEIVED",
      `${company.name} sent you invoice ${invoiceNumber} for ${totals.total.toLocaleString()} Aeros (${itemName}).`,
      `/invoices/${invoice.id}`,
    );

    return invoice;
  });
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

/**
 * Pays an invoice atomically.
 *
 * Duplicate-payment protection: the invoice row is locked FOR UPDATE and the
 * status transition to PAID is a conditional UPDATE guarded on it still being
 * PENDING. If the user double-submits, the second attempt finds the row
 * already PAID (or fails the guarded UPDATE) and is rejected without moving
 * any Aeros (spec §25).
 */
export async function payInvoice(params: {
  invoiceId: string;
  payerUserId: string;
}): Promise<{ invoice: Invoice; txRef: string }> {
  const { invoiceId, payerUserId } = params;

  return db.transaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .for("update");

    if (!invoice) throw new InvoiceError("Invoice not found.");
    if (invoice.buyerUserId !== payerUserId) {
      throw new InvoiceError("This invoice was not issued to you.");
    }
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
      await tx.update(invoices).set({ status: "EXPIRED" }).where(eq(invoices.id, invoice.id));
      throw new InvoiceError("This invoice has expired.");
    }

    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, invoice.companyId))
      .limit(1);
    if (!company) throw new InvoiceError("The issuing company no longer exists.");
    if (!canCompanyReceive(company)) {
      throw new InvoiceError("The issuing company cannot receive payments right now.");
    }

    // Tax was added on top of the quoted subtotal when the invoice was
    // created, so the breakdown is fixed here rather than recomputed — the
    // buyer pays exactly the total they were shown, at the rate that was in
    // force when the invoice was issued.
    const result = await transferInTx(tx, {
      from: userWallet(payerUserId),
      to: companyWallet(invoice.companyId),
      amount: invoice.total,
      type: "INVOICE_PAYMENT",
      invoiceId: invoice.id,
      reason: `Invoice ${invoice.invoiceNumber} — ${invoice.itemName}`,
      forcedBreakdown: {
        grossAmount: invoice.total,
        taxAmount: invoice.taxAmount,
        netAmount: invoice.subtotal,
        taxRateBpApplied: invoice.taxAmount > 0 ? invoice.taxRateBp : 0,
      },
      notify: {
        senderType: "INVOICE_PAID",
        senderMessage: (r) =>
          `You paid invoice ${invoice.invoiceNumber} — ${r.grossAmount.toLocaleString()} Aeros to ${company.name}. Ref ${r.txRef}.`,
        receiverType: "INVOICE_PAID",
        receiverMessage: (r) =>
          `Invoice ${invoice.invoiceNumber} was paid — ${r.netAmount.toLocaleString()} Aeros received. Ref ${r.txRef}.`,
        href: `/invoices/${invoice.id}`,
      },
    });

    // Guarded status transition: only flips a still-PENDING invoice.
    const marked = await tx
      .update(invoices)
      .set({ status: "PAID", paidAt: new Date(), paidTxRef: result.txRef })
      .where(and(eq(invoices.id, invoice.id), eq(invoices.status, "PENDING")))
      .returning();

    if (marked.length === 0) {
      // Another concurrent request settled it first — roll everything back.
      throw new InvoiceError("This invoice has already been paid.");
    }

    return { invoice: marked[0], txRef: result.txRef };
  });
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

    await notifyUser(
      tx,
      invoice.buyerUserId,
      "INVOICE_CANCELLED",
      `Invoice ${invoice.invoiceNumber} was cancelled by ${actorLabel}.`,
      `/invoices/${invoice.id}`,
    );

    return updated;
  });
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
// ---------------------------------------------------------------------------

export async function getInvoiceById(invoiceId: string) {
  const [row] = await db
    .select({
      invoice: invoices,
      company: companies,
      buyer: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
      },
    })
    .from(invoices)
    .innerJoin(companies, eq(companies.id, invoices.companyId))
    .innerJoin(users, eq(users.id, invoices.buyerUserId))
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  return row ?? null;
}

export async function getInvoicesForCompany(companyId: string, limit = 100) {
  return db
    .select({
      invoice: invoices,
      buyerUsername: users.username,
      buyerDisplayName: users.displayName,
    })
    .from(invoices)
    .innerJoin(users, eq(users.id, invoices.buyerUserId))
    .where(eq(invoices.companyId, companyId))
    .orderBy(desc(invoices.createdAt))
    .limit(limit);
}

export async function getInvoicesForBuyer(buyerUserId: string, limit = 100) {
  return db
    .select({
      invoice: invoices,
      companyName: companies.name,
      companyUsername: companies.username,
    })
    .from(invoices)
    .innerJoin(companies, eq(companies.id, invoices.companyId))
    .where(eq(invoices.buyerUserId, buyerUserId))
    .orderBy(desc(invoices.createdAt))
    .limit(limit);
}

export async function getPendingInvoiceCountForBuyer(buyerUserId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(invoices)
    .where(and(eq(invoices.buyerUserId, buyerUserId), eq(invoices.status, "PENDING")));
  return row?.count ?? 0;
}
