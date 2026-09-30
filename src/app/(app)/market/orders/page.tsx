import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import { expireOverdueOrders, getOrdersForBuyer } from "@/lib/marketplace";
import { OrderStatusBadge } from "@/components/status-badge";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDate } from "@/lib/datetime";
import { ExportLink } from "@/components/forms/export-forms";

/**
 * MY ORDERS — the buyer's side, scoped to the wallet the viewer is acting as.
 *
 * Each row LINKS to the canonical order, invoice and transaction rather than
 * restating their amounts, so there is never a second copy of a figure to
 * disagree with the ledger (§15).
 */
export default async function MyOrdersPage({ searchParams }: PageProps<"/market/orders">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  await expireOverdueOrders().catch(() => undefined);

  const params = await searchParams;
  const filter = typeof params.status === "string" ? params.status : "ALL";

  const rows = await getOrdersForBuyer(ctx.wallet, 200);
  const filtered =
    filter === "ALL"
      ? rows
      : filter === "OPEN"
        ? rows.filter((r) =>
            ["PENDING", "ACCEPTED", "WAITING_FOR_INVOICE", "PAYMENT_DUE"].includes(r.order.status),
          )
        : rows.filter((r) => r.order.status === filter);

  const tabs = ["ALL", "OPEN", "PAYMENT_DUE", "PAID", "COMPLETED", "CANCELLED", "EXPIRED"];

  return (
    <div className="space-y-6">
      <div>
        <Link href="/market" className="text-sm text-muted hover:text-foreground">
          ← Market
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">My orders</h1>
        <p className="mt-1 text-sm text-muted">
          Orders placed by {ctx.company ? `${ctx.company.name} (${ctx.handle})` : "you"}.
        </p>
        <div className="mt-3">
          <ExportLink
            href={
              ctx.company
                ? "/api/export/orders?scope=company&format=csv"
                : "/api/export/orders?format=csv"
            }
            label="Download CSV"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <Link
            key={tab}
            href={`/market/orders?status=${tab}`}
            className={filter === tab ? "btn btn-primary text-xs" : "btn btn-secondary text-xs"}
          >
            {tab.replace(/_/g, " ")}
          </Link>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="card p-5">
          <p className="text-sm text-muted">No orders here.</p>
        </div>
      ) : (
        <div className="card divide-y divide-border">
          {filtered.map((row) => (
            <div key={row.order.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
              <div className="min-w-0">
                <Link
                  href={`/market/orders/${row.order.id}`}
                  className="font-medium hover:underline"
                >
                  {row.offerTitle}
                </Link>
                <p className="text-sm text-muted">
                  {row.sellerName} (@{row.sellerUsername}) · {row.order.orderNumber}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {row.order.quantity} × {row.order.unitPrice.toLocaleString()} ={" "}
                  {row.order.subtotal.toLocaleString()} {CURRENCY_NAME} ·{" "}
                  {formatDate(row.order.createdAt)}
                </p>
                {row.invoiceNumber && (
                  <p className="mt-1 text-xs text-muted">
                    Invoice{" "}
                    <Link
                      href={`/invoices/${row.order.invoiceId}`}
                      className="underline"
                    >
                      {row.invoiceNumber}
                    </Link>
                    {row.invoiceTotal !== null
                      ? ` · ${row.invoiceTotal.toLocaleString()} ${CURRENCY_NAME} payable`
                      : ""}
                  </p>
                )}
                {row.paidTxRef && (
                  <p className="mt-1 font-mono text-xs text-muted">Ref {row.paidTxRef}</p>
                )}
              </div>
              <div className="shrink-0">
                <OrderStatusBadge status={row.order.status} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
