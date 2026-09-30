import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import {
  expireOverdueOrders,
  getCompanyOrderCounts,
  getOrdersForCompany,
} from "@/lib/marketplace";
import { OrderStatusBadge, InvoiceStatusBadge } from "@/components/status-badge";
import {
  AcceptOrderButton,
  CancelOrderButton,
  CompleteOrderButton,
  IssueOrderInvoiceForm,
} from "@/components/forms/marketplace-forms";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDate } from "@/lib/datetime";

/**
 * THE COMPANY'S ORDER AREAS (spec §15).
 *
 * One page with the six buckets the spec asks for — Orders, Pending Orders,
 * Waiting for Invoice, Payment Due, Invoices and Completed Orders — as filter
 * tabs over the same list, because they are six views of one thing rather than
 * six datasets.
 *
 * Every row LINKS to the canonical order, invoice and transaction. The only
 * figures printed here are the order's own snapshot and the invoice's own
 * total, both read from their rows; nothing is recomputed and nothing is
 * duplicated into a second store.
 */
const BUCKETS = [
  { key: "ALL", label: "All orders" },
  { key: "PENDING", label: "Pending" },
  { key: "WAITING_FOR_INVOICE", label: "Waiting for invoice" },
  { key: "PAYMENT_DUE", label: "Payment due" },
  { key: "INVOICES", label: "Invoices" },
  { key: "COMPLETED", label: "Completed" },
] as const;

export default async function CompanyOrdersPage({ searchParams }: PageProps<"/my-company/orders">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const company = ctx.company ?? ctx.availableCompanies[0] ?? null;
  if (!company) {
    return (
      <div className="card p-6">
        <p className="text-sm text-muted">
          You need an approved company to receive orders.{" "}
          <Link href="/my-company" className="underline">
            Apply for one
          </Link>
          .
        </p>
      </div>
    );
  }

  await expireOverdueOrders().catch(() => undefined);

  const params = await searchParams;
  const bucket = typeof params.bucket === "string" ? params.bucket : "ALL";

  const [rows, counts] = await Promise.all([
    getOrdersForCompany(company.id, 200),
    getCompanyOrderCounts(company.id),
  ]);

  const filtered =
    bucket === "ALL"
      ? rows
      : bucket === "WAITING_FOR_INVOICE"
        ? rows.filter((r) => ["ACCEPTED", "WAITING_FOR_INVOICE"].includes(r.order.status))
        : bucket === "INVOICES"
          ? rows.filter((r) => r.order.invoiceId !== null)
          : rows.filter((r) => r.order.status === bucket);

  const isActingAsThisCompany = ctx.company?.id === company.id;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/my-company" className="text-sm text-muted hover:text-foreground">
          ← {company.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Orders</h1>
        <p className="mt-1 text-sm text-muted">
          Orders placed with {company.name}. Accept one, send its invoice, and the payment settles
          to the company wallet.
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="All orders" value={counts.total} />
        <Stat label="Pending" value={counts.pending} />
        <Stat label="Awaiting invoice" value={counts.waitingForInvoice} />
        <Stat label="Payment due" value={counts.paymentDue} />
        <Stat label="Completed" value={counts.completed} />
      </section>

      {!isActingAsThisCompany && (
        <div className="card p-5">
          <p className="text-sm text-muted">
            Switch to {company.name} from your dashboard to accept orders and send invoices.
          </p>
        </div>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {BUCKETS.map((b) => (
            <Link
              key={b.key}
              href={`/my-company/orders?bucket=${b.key}`}
              className={
                bucket === b.key ? "btn btn-primary text-xs" : "btn btn-secondary text-xs"
              }
            >
              {b.label}
            </Link>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="card p-5">
            <p className="text-sm text-muted">Nothing in this list.</p>
          </div>
        ) : (
          <div className="card divide-y divide-border">
            {filtered.map((row) => (
              <div key={row.order.id} className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/market/orders/${row.order.id}`}
                      className="font-medium hover:underline"
                    >
                      {row.offerTitle}
                    </Link>
                    <p className="text-sm text-muted">
                      {row.buyerLabel} (@{row.buyerHandle}) ·{" "}
                      <span className="font-mono">{row.order.orderNumber}</span>
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {row.order.quantity} × {row.order.unitPrice.toLocaleString()} ={" "}
                      {row.order.subtotal.toLocaleString()} {CURRENCY_NAME} ·{" "}
                      {formatDate(row.order.createdAt)}
                    </p>
                    {row.invoiceNumber && (
                      <p className="mt-1 text-xs text-muted">
                        Invoice{" "}
                        <Link href={`/invoices/${row.order.invoiceId}`} className="underline">
                          {row.invoiceNumber}
                        </Link>
                        {row.invoiceTotal !== null
                          ? ` · ${row.invoiceTotal.toLocaleString()} ${CURRENCY_NAME}`
                          : ""}
                        {row.invoiceStatus ? ` · ${row.invoiceStatus}` : ""}
                      </p>
                    )}
                    {row.paidTxRef && (
                      <p className="mt-1 font-mono text-xs text-muted">Ref {row.paidTxRef}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <OrderStatusBadge status={row.order.status} />
                    {row.invoiceStatus && (
                      <InvoiceStatusBadge
                        status={row.invoiceStatus as "PENDING" | "PAID" | "CANCELLED" | "EXPIRED"}
                      />
                    )}
                  </div>
                </div>

                {isActingAsThisCompany && (
                  <div className="flex flex-wrap items-start gap-2">
                    {row.order.status === "PENDING" && (
                      <AcceptOrderButton orderId={row.order.id} />
                    )}
                    {["ACCEPTED", "WAITING_FOR_INVOICE"].includes(row.order.status) && (
                      <IssueOrderInvoiceForm
                        orderId={row.order.id}
                        total={row.order.subtotal}
                      />
                    )}
                    {row.order.status === "PAID" && (
                      <CompleteOrderButton orderId={row.order.id} />
                    )}
                    {["PENDING", "ACCEPTED", "WAITING_FOR_INVOICE", "PAYMENT_DUE"].includes(
                      row.order.status,
                    ) && <CancelOrderButton orderId={row.order.id} />}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-xs text-muted">
        Every invoice raised here also appears under{" "}
        <Link href="/my-company/invoices" className="underline">
          Sent invoices
        </Link>
        , and every payment in{" "}
        <Link href="/transactions" className="underline">
          Activity
        </Link>
        .
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value.toLocaleString()}</p>
    </div>
  );
}
