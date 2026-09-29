import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getActingContext } from "@/lib/auth";
import { getInvoiceById, invoiceViewerRole } from "@/lib/invoices";
import { InvoiceSummary } from "@/components/invoice-summary";
import { AerosLogo } from "@/components/logo";
import { APP_NAME } from "@/lib/constants";
import { formatDateTime } from "@/lib/datetime";

export const metadata = { title: "Invoice" };

/**
 * Print-friendly invoice (spec §9).
 *
 * Same access rules as the on-screen detail page — the viewer must be the
 * issuing company's owner or the recipient — re-checked here, because this is a
 * separate route and render-time gating elsewhere is not a security boundary.
 */
export default async function InvoicePrintPage({
  params,
}: PageProps<"/invoices/[id]/print">) {
  const ctx = await getActingContext();
  if (!ctx) redirect("/login");

  const { id } = await params;
  const row = await getInvoiceById(id);
  if (!row) notFound();

  const role = invoiceViewerRole(row, {
    userId: ctx.user.id,
    wallet: ctx.wallet,
    ownedCompanyIds: ctx.availableCompanies.map((c) => c.id),
  });
  if (!role.canView) notFound();

  const { invoice, company, recipient } = row;

  return (
    <div className="space-y-5">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <Link href={`/invoices/${invoice.id}`} className="text-sm text-muted hover:text-foreground">
          ← Back to invoice
        </Link>
        <p className="text-xs text-muted">
          Use your browser&apos;s Print dialog and choose &ldquo;Save as PDF&rdquo;.
        </p>
      </div>

      <div className="flex items-center justify-between gap-3 border-b border-border pb-4">
        <div className="flex items-center gap-2">
          <AerosLogo size={26} />
          <span className="font-semibold tracking-tight">{APP_NAME}</span>
        </div>
        <div className="text-right text-xs text-muted">
          <p className="font-mono">{invoice.invoiceNumber}</p>
          <p>Issued {formatDateTime(invoice.createdAt)}</p>
        </div>
      </div>

      <div className="card p-6">
        <InvoiceSummary
          invoice={invoice}
          company={company}
          recipient={recipient}
          showBadge={false}
        />
      </div>

      <p className="border-t border-border pt-4 text-xs text-muted">
        {APP_NAME} is a closed-loop virtual economy. This document is a record of an invoice issued
        inside it and carries no legal weight outside it.
      </p>
    </div>
  );
}
