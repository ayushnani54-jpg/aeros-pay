"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import {
  createInvoiceAction,
  cancelInvoiceAction,
  quoteInvoiceAction,
  type InvoiceQuote,
} from "@/actions/company";
import { payInvoiceAction } from "@/actions/invoice";
import { CURRENCY_NAME } from "@/lib/constants";
import { PaymentSuccessSound } from "@/components/payment-sound";
import { VoiceInput } from "./voice-input";

type RecipientType = "USER" | "COMPANY" | "GOVERNMENT";

const RECIPIENT_TABS: { value: RecipientType; label: string }[] = [
  { value: "USER", label: "A person" },
  { value: "COMPANY", label: "A company" },
  { value: "GOVERNMENT", label: "The Government" },
];

/**
 * Create-invoice form (V3: any of the three recipient types).
 *
 * The tax figure shown here is not computed in the browser. It comes from
 * `quoteInvoiceAction`, which resolves the recipient server-side and asks the
 * tax matrix for the rate that will actually be snapshot onto the invoice — so
 * the issuer is never shown a number the server would disagree with.
 */
export function CreateInvoiceForm() {
  const [state, formAction, pending] = useActionState(createInvoiceAction, null);
  const [recipientType, setRecipientType] = useState<RecipientType>("USER");
  const [recipientUsername, setRecipientUsername] = useState("");
  const [quantity, setQuantity] = useState<number | "">(1);
  const [unitPrice, setUnitPrice] = useState<number | "">("");

  const [quote, setQuote] = useState<InvoiceQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, startQuote] = useTransition();

  const q = typeof quantity === "number" ? quantity : 0;
  const p = typeof unitPrice === "number" ? unitPrice : 0;
  const subtotal = q * p;
  const recipientReady = recipientType === "GOVERNMENT" || recipientUsername.length >= 3;

  // Asks the server for the real quote once the fields make sense. Debounced so
  // typing a username does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!recipientReady || q < 1 || p < 1) {
        setQuote(null);
        setQuoteError(null);
        return;
      }
      startQuote(async () => {
        const result = await quoteInvoiceAction({
          recipientType,
          recipientUsername,
          quantity: q,
          unitPrice: p,
        });
        if (result.ok) {
          setQuote(result.data);
          setQuoteError(null);
        } else {
          setQuote(null);
          setQuoteError(result.error);
        }
      });
    }, 450);
    return () => clearTimeout(timer);
  }, [recipientType, recipientUsername, q, p, recipientReady]);

  return (
    <form action={formAction} className="card space-y-4 p-6">
      <div>
        <h3 className="font-medium">Create an invoice</h3>
        <p className="mt-1 text-sm text-muted">
          Tax is added on top of your price, so you receive the full amount you quote.
        </p>
      </div>

      <input type="hidden" name="recipientType" value={recipientType} />

      <div>
        <label className="mb-1 block text-sm font-medium">Invoice</label>
        <div className="flex flex-wrap gap-2">
          {RECIPIENT_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setRecipientType(tab.value)}
              className={
                recipientType === tab.value
                  ? "btn btn-primary text-xs"
                  : "btn btn-secondary text-xs"
              }
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {recipientType === "GOVERNMENT" ? (
        <p className="rounded-md bg-surface p-3 text-sm text-muted">
          This invoice will be addressed to the Government Treasury. Payment settles from the
          Treasury to your company wallet.
        </p>
      ) : (
        <div>
          <label htmlFor="recipientUsername" className="mb-1 block text-sm font-medium">
            Send to ({recipientType === "COMPANY" ? "company username" : "username"})
          </label>
          <input
            id="recipientUsername"
            name="recipientUsername"
            className="input"
            required
            maxLength={24}
            value={recipientUsername}
            onChange={(e) =>
              setRecipientUsername(e.target.value.trim().toLowerCase().replace(/^@/, ""))
            }
          />
        </div>
      )}

      <div>
        <label htmlFor="itemName" className="mb-1 block text-sm font-medium">
          Item or service
        </label>
        <input
          id="itemName"
          name="itemName"
          className="input"
          required
          maxLength={160}
          placeholder="e.g. Cotton Shirt"
        />
      </div>

      <div>
        <label htmlFor="invDescription" className="mb-1 block text-sm font-medium">
          Description (optional)
        </label>
        <textarea id="invDescription" name="description" className="input" rows={2} maxLength={1000} />
        <VoiceInput targetId="invDescription" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="quantity" className="mb-1 block text-sm font-medium">
            Quantity
          </label>
          <input
            id="quantity"
            name="quantity"
            type="number"
            min={1}
            step={1}
            className="input"
            required
            value={quantity}
            onChange={(e) =>
              setQuantity(e.target.value === "" ? "" : Math.floor(Number(e.target.value)))
            }
          />
        </div>
        <div>
          <label htmlFor="unitPrice" className="mb-1 block text-sm font-medium">
            Unit price ({CURRENCY_NAME})
          </label>
          <input
            id="unitPrice"
            name="unitPrice"
            type="number"
            min={1}
            step={1}
            className="input"
            required
            value={unitPrice}
            onChange={(e) =>
              setUnitPrice(e.target.value === "" ? "" : Math.floor(Number(e.target.value)))
            }
          />
        </div>
      </div>

      {subtotal > 0 && (
        <dl className="space-y-1 rounded-md bg-surface p-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">Subtotal</dt>
            <dd>
              {subtotal.toLocaleString()} {CURRENCY_NAME}
            </dd>
          </div>
          {quote ? (
            <>
              <div className="flex justify-between">
                <dt className="text-muted">Tax ({(quote.taxRateBp / 100).toFixed(2)}%)</dt>
                <dd>
                  {quote.taxAmount.toLocaleString()} {CURRENCY_NAME}
                </dd>
              </div>
              <div className="flex justify-between border-t border-border pt-1 font-medium">
                <dt>Total payable by {quote.recipientLabel}</dt>
                <dd>
                  {quote.total.toLocaleString()} {CURRENCY_NAME}
                </dd>
              </div>
              <div className="flex justify-between text-xs text-muted">
                <dt>You receive</dt>
                <dd>
                  {quote.subtotal.toLocaleString()} {CURRENCY_NAME}
                </dd>
              </div>
            </>
          ) : (
            <div className="flex justify-between text-xs text-muted">
              <dt>Tax and total</dt>
              <dd>
                {quoting
                  ? "Checking with the server…"
                  : quoteError
                    ? quoteError
                    : "Enter a recipient to see the tax"}
              </dd>
            </div>
          )}
        </dl>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="dueDate" className="mb-1 block text-sm font-medium">
            Due date (optional)
          </label>
          <input id="dueDate" name="dueDate" type="date" className="input" />
        </div>
        <div>
          <label htmlFor="invNote" className="mb-1 block text-sm font-medium">
            Note (optional)
          </label>
          <input id="invNote" name="note" className="input" maxLength={500} />
        </div>
      </div>

      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-success">Invoice sent.</p>}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Creating…" : "Send invoice"}
      </button>
    </form>
  );
}

/**
 * Pay Invoice.
 *
 * There is NO optimistic success anywhere here: the receipt is rendered only
 * from `state.data`, which only exists once the server has committed the
 * payment and handed back a real transaction reference (spec §47). The confirm
 * button is disabled while the action is in flight, and because Next dispatches
 * one action at a time per client a double click cannot outrun the first
 * request — and if it somehow does, the server's idempotency key replays the
 * first result rather than paying twice.
 */
export function PayInvoiceButton({
  invoiceId,
  total,
  issuerName,
  payerLabel,
  canAfford,
}: {
  invoiceId: string;
  total: number;
  issuerName: string;
  payerLabel: string;
  canAfford: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(payInvoiceAction, null);

  if (state?.ok) {
    return (
      <div className="card p-5 text-center" data-testid="invoice-receipt">
        {/* Only a payment that actually happened sounds. A REPLAYED receipt is
            the idempotency key returning the original one — nothing moved this
            time, so there is nothing to celebrate. */}
        {!state.data.replayed && <PaymentSuccessSound key={state.data.txRef} />}
        <p className="font-semibold text-success">Invoice paid</p>
        <p className="mt-2 text-sm">
          {state.data.invoiceNumber} · {state.data.total.toLocaleString()} {CURRENCY_NAME}
        </p>
        <p className="mt-1 text-xs text-muted">
          Paid to @{state.data.paidToUsername} · tax {state.data.taxAmount.toLocaleString()}{" "}
          {CURRENCY_NAME}
        </p>
        <p className="mt-1 font-mono text-xs text-muted">Ref {state.data.txRef}</p>
        {state.data.replayed && (
          <p className="mt-2 text-xs text-muted">
            This invoice had already been paid by this wallet — showing the original receipt.
          </p>
        )}
      </div>
    );
  }

  if (!confirming) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setConfirming(true)}
          disabled={!canAfford}
        >
          Pay {total.toLocaleString()} {CURRENCY_NAME}
        </button>
        {!canAfford && (
          <p className="text-xs text-danger">
            {payerLabel} does not hold enough {CURRENCY_NAME} to pay this invoice.
          </p>
        )}
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3 rounded-md border border-border p-4">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <p className="text-sm">
        Pay {issuerName} {total.toLocaleString()} {CURRENCY_NAME} from {payerLabel}?
      </p>
      {state && !state.ok && (
        <p className="text-sm text-danger" role="alert">
          {state.error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-secondary flex-1"
          onClick={() => setConfirming(false)}
          disabled={pending}
        >
          Back
        </button>
        <button type="submit" className="btn btn-primary flex-1" disabled={pending}>
          {pending ? "Paying…" : "Confirm payment"}
        </button>
      </div>
    </form>
  );
}

export function CancelInvoiceButton({ invoiceId }: { invoiceId: string }) {
  const [state, formAction, pending] = useActionState(cancelInvoiceAction, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <button type="submit" className="btn btn-danger text-xs" disabled={pending}>
        {pending ? "Cancelling…" : "Cancel"}
      </button>
      {state && !state.ok && <p className="text-xs text-danger">{state.error}</p>}
    </form>
  );
}
