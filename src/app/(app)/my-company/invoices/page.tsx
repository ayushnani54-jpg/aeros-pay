import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import { getSentInvoicesForCompany, expireOverdueInvoices } from "@/lib/invoices";
import { CreateInvoiceForm, CancelInvoiceButton } from "@/components/forms/invoice-forms";
import { InvoiceStatusBadge } from "@/components/status-badge";
import { CURRENCY_NAME } from "@/lib/constants";
import { effectiveCompanyStatus } from "@/lib/status";
import { formatDate } from "@/lib/datetime";

/**
 * SENT INVOICES (spec §7). Lists everything this company has issued, to any of
 * the three recipient types, with the same filter tabs and the same list rows
 * V2 had.
 */
export default async function CompanyInvoicesPage({
  searchParams,
}: PageProps<"/my-company/invoices">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const company = ctx.company ?? ctx.availableCompanies[0] ?? null;
  if (!company) {
    return (
      <div className="card p-6">
        <p className="text-sm text-muted">
          You need an approved company to issue invoices.{" "}
          <Link href="/my-company" className="underline">
            Apply for one
          </Link>
          .
        </p>
      </div>
    );
  }

  await expireOverdueInvoices().catch(() => undefined);

  const params = await searchParams;
  const filter = typeof params.status === "string" ? params.status : "ALL";

  const rows = await getSentInvoicesForCompany(company.id, 200);

  const filtered = filter === "ALL" ? rows : rows.filter((r) => r.invoice.status === filter);
  const canIssue = effectiveCompanyStatus(company) === "APPROVED";
  const isActingAsThisCompany = ctx.company?.id === company.id;

  const tabs = ["ALL", "PENDING", "PAID", "CANCELLED", "EXPIRED"];

  return (
    <div className="space-y-6">
      <div>
        <Link href="/my-company" className="text-sm text-muted hover:text-foreground">
          ← {company.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Sent invoices</h1>
        <p className="mt-1 text-sm text-muted">
          Invoices {company.name} has issued to people, companies and the Government.
        </p>
      </div>

      {canIssue ? (
        isActingAsThisCompany ? (
          <CreateInvoiceForm />
        ) : (
          <div className="card p-5">
            <p className="text-sm text-muted">
              Switch to {company.name} from your dashboard to issue an invoice from this company.
            </p>
          </div>
        )
      ) : (
        <div className="card p-5">
          <p className="text-sm text-muted">
            This company cannot issue invoices in its current state.
          </p>
        </div>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <Link
              key={tab}
              href={`/my-company/invoices?status=${tab}`}
              className={
                filter === tab ? "btn btn-primary text-xs" : "btn btn-secondary text-xs"
              }
            >
              {tab}
            </Link>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="card p-5">
            <p className="text-sm text-muted">No invoices here.</p>
          </div>
        ) : (
          <div className="card divide-y divide-border">
            {filtered.map(({ invoice, recipient }) => (
              <div key={invoice.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
                <div className="min-w-0">
                  <Link href={`/invoices/${invoice.id}`} className="font-medium hover:underline">
                    {invoice.itemName}
                  </Link>
                  <p className="text-sm text-muted">
                    {recipient.label}
                    {recipient.type === "GOVERNMENT" ? " (Treasury)" : ` (@${recipient.username})`}{" "}
                    · {invoice.invoiceNumber}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {invoice.quantity} × {invoice.unitPrice.toLocaleString()} ={" "}
                    {invoice.subtotal.toLocaleString()} + {invoice.taxAmount.toLocaleString()}{" "}
                    tax · {formatDate(invoice.createdAt)}
                  </p>
                  {invoice.paidTxRef && (
                    <p className="mt-1 font-mono text-xs text-muted">Ref {invoice.paidTxRef}</p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <p className="font-mono font-medium">
                    {invoice.total.toLocaleString()} {CURRENCY_NAME}
                  </p>
                  <InvoiceStatusBadge status={invoice.status} />
                  {invoice.status === "PENDING" && isActingAsThisCompany && (
                    <CancelInvoiceButton invoiceId={invoice.id} />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
