import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { getInvoicesForBuyer, expireOverdueInvoices } from "@/lib/invoices";
import { InvoiceStatusBadge } from "@/components/status-badge";
import { CURRENCY_NAME } from "@/lib/constants";

export default async function InvoicesPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  await expireOverdueInvoices().catch(() => undefined);
  const rows = await getInvoicesForBuyer(user.id, 150);

  const pending = rows.filter((r) => r.invoice.status === "PENDING");
  const settled = rows.filter((r) => r.invoice.status !== "PENDING");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Invoices</h1>
        <p className="mt-1 text-sm text-muted">Bills sent to you by companies.</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted">Awaiting payment</h2>
        {pending.length === 0 ? (
          <div className="card p-5">
            <p className="text-sm text-muted">Nothing to pay right now.</p>
          </div>
        ) : (
          pending.map(({ invoice, companyName, companyUsername }) => (
            <Link key={invoice.id} href={`/invoices/${invoice.id}`} className="card block p-5 hover:bg-surface">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{invoice.itemName}</p>
                  <p className="text-sm text-muted">
                    {companyName} (@{companyUsername}) · {invoice.invoiceNumber}
                  </p>
                  {invoice.dueAt && (
                    <p className="mt-1 text-xs text-muted">
                      Due {new Date(invoice.dueAt).toLocaleDateString()}
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <p className="font-semibold">
                    {invoice.total.toLocaleString()} {CURRENCY_NAME}
                  </p>
                  <InvoiceStatusBadge status={invoice.status} />
                </div>
              </div>
            </Link>
          ))
        )}
      </section>

      {settled.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted">Past invoices</h2>
          <div className="card divide-y divide-border">
            {settled.map(({ invoice, companyName }) => (
              <Link
                key={invoice.id}
                href={`/invoices/${invoice.id}`}
                className="flex items-center justify-between gap-3 p-4 text-sm hover:bg-surface"
              >
                <div>
                  <p className="font-medium">{invoice.itemName}</p>
                  <p className="text-xs text-muted">
                    {companyName} · {invoice.invoiceNumber} ·{" "}
                    {new Date(invoice.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-mono">
                    {invoice.total.toLocaleString()} {CURRENCY_NAME}
                  </p>
                  <InvoiceStatusBadge status={invoice.status} />
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
