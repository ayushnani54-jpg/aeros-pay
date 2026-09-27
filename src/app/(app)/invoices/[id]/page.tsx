import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getInvoiceById } from "@/lib/invoices";
import { InvoiceStatusBadge } from "@/components/status-badge";
import { PayInvoiceButton } from "@/components/forms/invoice-forms";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatTaxRateBp } from "@/lib/tax";
import { formatDateTime } from "@/lib/datetime";

export default async function InvoiceDetailPage({ params }: PageProps<"/invoices/[id]">) {
  const user = await getCurrentUser();
  if (!user) return null;

  const { id } = await params;
  const row = await getInvoiceById(id);
  if (!row) notFound();

  const { invoice, company } = row;

  // An invoice is private to its buyer and the issuing company's owner.
  const canView = invoice.buyerUserId === user.id || company.ownerUserId === user.id;
  if (!canView) notFound();

  const isBuyer = invoice.buyerUserId === user.id;

  return (
    <div className="space-y-5">
      <Link href="/invoices" className="text-sm text-muted hover:text-foreground">
        ← Invoices
      </Link>

      <div className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{invoice.itemName}</h1>
            <p className="mt-1 text-sm text-muted">
              {company.name} (@{company.username})
            </p>
          </div>
          <div className="text-right">
            <InvoiceStatusBadge status={invoice.status} />
            <p className="mt-1 font-mono text-xs text-muted">{invoice.invoiceNumber}</p>
          </div>
        </div>

        {invoice.description && (
          <p className="mt-4 whitespace-pre-line text-sm text-muted">{invoice.description}</p>
        )}

        <dl className="mt-5 space-y-1 text-sm">
          <Row label="Quantity" value={invoice.quantity.toLocaleString()} />
          <Row
            label="Unit price"
            value={`${invoice.unitPrice.toLocaleString()} ${CURRENCY_NAME}`}
          />
          <Row
            label="Subtotal"
            value={`${invoice.subtotal.toLocaleString()} ${CURRENCY_NAME}`}
          />
          <Row
            label={`Tax (${formatTaxRateBp(invoice.taxRateBp)})`}
            value={`${invoice.taxAmount.toLocaleString()} ${CURRENCY_NAME}`}
          />
          <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
            <dt>Total payable</dt>
            <dd>
              {invoice.total.toLocaleString()} {CURRENCY_NAME}
            </dd>
          </div>
        </dl>

        <p className="mt-3 text-xs text-muted">
          Tax is added on top of the quoted price, so {company.name} receives the full{" "}
          {invoice.subtotal.toLocaleString()} {CURRENCY_NAME} and the tax goes to the Government.
        </p>

        <dl className="mt-5 space-y-1 text-xs text-muted">
          <Row label="Issued" value={formatDateTime(invoice.createdAt)} />
          {invoice.dueAt && (
            <Row label="Due" value={formatDateTime(invoice.dueAt)} />
          )}
          {invoice.paidAt && (
            <Row label="Paid" value={formatDateTime(invoice.paidAt)} />
          )}
          {invoice.paidTxRef && <Row label="Transaction" value={invoice.paidTxRef} />}
        </dl>

        {invoice.note && (
          <p className="mt-4 rounded-md bg-surface p-3 text-sm">{invoice.note}</p>
        )}

        {isBuyer && invoice.status === "PENDING" && (
          <div className="mt-6">
            <PayInvoiceButton
              invoiceId={invoice.id}
              total={invoice.total}
              companyName={company.name}
              canAfford={user.balance >= invoice.total}
            />
          </div>
        )}

        {isBuyer && invoice.status === "PAID" && (
          <p className="mt-6 text-sm text-success">This invoice has been paid.</p>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
