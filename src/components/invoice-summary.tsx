import { InvoiceStatusBadge } from "@/components/status-badge";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatTaxRateBp } from "@/lib/tax";
import { formatDateTime } from "@/lib/datetime";
import type { InvoiceRecipientSummary } from "@/lib/invoices";
import type { Company, Invoice } from "@/db/schema";

/**
 * The body of an invoice, shared by the on-screen detail page and the
 * print/"Save as PDF" view so the two can never drift apart. It uses the same
 * `dl`/`Row` layout the V2 detail page used — no new visual language.
 */
export function InvoiceSummary({
  invoice,
  company,
  recipient,
  showBadge = true,
}: {
  invoice: Invoice;
  company: Company;
  recipient: InvoiceRecipientSummary;
  showBadge?: boolean;
}) {
  // Invoices issued before "the company pays the tax" quote the tax on top
  // (total = subtotal + tax). They are shown the way they were issued.
  const isAddOn = invoice.taxAmount > 0 && invoice.total !== invoice.subtotal;
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{invoice.itemName}</h1>
          <p className="mt-1 text-sm text-muted">
            From {company.name} (@{company.username})
          </p>
          <p className="text-sm text-muted">
            To {recipient.label}
            {recipient.type === "GOVERNMENT" ? " (Treasury)" : ` (@${recipient.username})`}
          </p>
        </div>
        <div className="text-right">
          {showBadge && <InvoiceStatusBadge status={invoice.status} />}
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
        {isAddOn ? (
          <>
            <Row label="Subtotal" value={`${invoice.subtotal.toLocaleString()} ${CURRENCY_NAME}`} />
            <Row
              label={`Tax (${formatTaxRateBp(invoice.taxRateBp)})`}
              value={`${invoice.taxAmount.toLocaleString()} ${CURRENCY_NAME}`}
            />
          </>
        ) : (
          <>
            <Row label="Price" value={`${invoice.subtotal.toLocaleString()} ${CURRENCY_NAME}`} />
            <Row
              label={`Tax (${formatTaxRateBp(invoice.taxRateBp)}) — paid by the company`}
              value={`${invoice.taxAmount.toLocaleString()} ${CURRENCY_NAME}`}
            />
          </>
        )}
        <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
          <dt>Total payable</dt>
          <dd>
            {invoice.total.toLocaleString()} {CURRENCY_NAME}
          </dd>
        </div>
        {!isAddOn && (
          <Row
            label={`${company.name} receives`}
            value={`${(invoice.total - invoice.taxAmount).toLocaleString()} ${CURRENCY_NAME}`}
          />
        )}
      </dl>

      <p className="mt-3 text-xs text-muted">
        {isAddOn
          ? `Tax is added on top of the quoted price, so ${company.name} receives the full ${invoice.subtotal.toLocaleString()} ${CURRENCY_NAME} and the tax goes to the Government. `
          : `The buyer pays only the price. The tax is taken out of what ${company.name} receives and goes to the Government. `}
        These amounts were fixed when the invoice was issued and do not change.
      </p>

      <dl className="mt-5 space-y-1 text-xs text-muted">
        <Row label="Status" value={invoice.status} />
        <Row label="Issued" value={formatDateTime(invoice.createdAt)} />
        {invoice.dueAt && <Row label="Due" value={formatDateTime(invoice.dueAt)} />}
        {invoice.paidAt && <Row label="Paid" value={formatDateTime(invoice.paidAt)} />}
        {invoice.paidTxRef && <Row label="Transaction" value={invoice.paidTxRef} />}
      </dl>

      {invoice.note && (
        <p className="mt-4 rounded-md bg-surface p-3 text-sm">{invoice.note}</p>
      )}
    </>
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
