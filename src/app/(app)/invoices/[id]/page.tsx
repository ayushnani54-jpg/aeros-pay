import Link from "next/link";
import { notFound } from "next/navigation";
import { getActingContext } from "@/lib/auth";
import { getInvoiceById, invoiceViewerRole } from "@/lib/invoices";
import { PayInvoiceButton } from "@/components/forms/invoice-forms";
import { InvoiceSummary } from "@/components/invoice-summary";
import { CURRENCY_NAME } from "@/lib/constants";

export default async function InvoiceDetailPage({ params }: PageProps<"/invoices/[id]">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const { id } = await params;
  const row = await getInvoiceById(id);
  if (!row) notFound();

  const { invoice, company, recipient } = row;

  const role = invoiceViewerRole(row, {
    userId: ctx.user.id,
    wallet: ctx.wallet,
    ownedCompanyIds: ctx.availableCompanies.map((c) => c.id),
  });
  if (!role.canView) notFound();

  const payable = invoice.status === "PENDING";

  return (
    <div className="space-y-5">
      <Link href="/invoices" className="text-sm text-muted hover:text-foreground">
        ← Invoices
      </Link>

      <div className="card p-6">
        <InvoiceSummary invoice={invoice} company={company} recipient={recipient} />

        <div className="mt-5">
          <Link
            href={`/invoices/${invoice.id}/print`}
            target="_blank"
            className="btn btn-secondary text-sm"
          >
            Print / Save as PDF
          </Link>
        </div>

        {role.isPayer && payable && (
          <div className="mt-6">
            <PayInvoiceButton
              invoiceId={invoice.id}
              total={invoice.total}
              issuerName={company.name}
              payerLabel={ctx.company ? `${ctx.company.name} (${ctx.handle})` : "your personal wallet"}
              canAfford={ctx.balance >= invoice.total}
            />
          </div>
        )}

        {role.isRecipientOwnerInWrongContext && payable && (
          <p className="mt-6 rounded-md bg-surface p-3 text-sm text-muted">
            This invoice is addressed to {recipient.label} (@{recipient.username}). Switch to that
            company wallet from your dashboard to pay it — a company&apos;s bills are always paid
            from the company wallet.
          </p>
        )}

        {invoice.status === "PAID" && (
          <p className="mt-6 text-sm text-success" data-testid="invoice-paid">
            This invoice has been paid
            {invoice.paidTxRef ? (
              <>
                {" ("}
                <Link href="/transactions" className="underline">
                  ref {invoice.paidTxRef}
                </Link>
                {")"}
              </>
            ) : null}
            .
          </p>
        )}

        {invoice.status === "CANCELLED" && (
          <p className="mt-6 text-sm text-muted">This invoice was cancelled.</p>
        )}

        {invoice.status === "EXPIRED" && (
          <p className="mt-6 text-sm text-muted">
            This invoice passed its due date and can no longer be paid. Ask {company.name} to issue
            a new one.
          </p>
        )}

        {role.isIssuer && !role.isPayer && (
          <p className="mt-6 text-xs text-muted">
            You are viewing this as the issuer. When it is paid, the{" "}
            {invoice.subtotal.toLocaleString()} {CURRENCY_NAME} lands in the {company.name} company
            wallet.
          </p>
        )}
      </div>
    </div>
  );
}
