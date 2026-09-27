"use client";

import { useActionState, useState } from "react";
import { createInvoiceAction, cancelInvoiceAction } from "@/actions/company";
import { payInvoiceAction } from "@/actions/invoice";
import { CURRENCY_NAME } from "@/lib/constants";

export function CreateInvoiceForm({ taxPercent }: { taxPercent: number }) {
  const [state, formAction, pending] = useActionState(createInvoiceAction, null);
  const [quantity, setQuantity] = useState<number | "">(1);
  const [unitPrice, setUnitPrice] = useState<number | "">("");

  const q = typeof quantity === "number" ? quantity : 0;
  const p = typeof unitPrice === "number" ? unitPrice : 0;
  const subtotal = q * p;
  const tax = Math.floor((subtotal * taxPercent * 100) / 10000);
  const total = subtotal + tax;

  return (
    <form action={formAction} className="card space-y-4 p-6">
      <div>
        <h3 className="font-medium">Create an invoice</h3>
        <p className="mt-1 text-sm text-muted">
          Tax is added on top of your price, so you receive the full amount you quote.
        </p>
      </div>

      <div>
        <label htmlFor="buyerUsername" className="mb-1 block text-sm font-medium">
          Send to (username)
        </label>
        <input id="buyerUsername" name="buyerUsername" className="input" required maxLength={24} />
      </div>

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
          <div className="flex justify-between">
            <dt className="text-muted">Tax ({taxPercent.toFixed(2)}%)</dt>
            <dd>
              {tax.toLocaleString()} {CURRENCY_NAME}
            </dd>
          </div>
          <div className="flex justify-between border-t border-border pt-1 font-medium">
            <dt>Total payable by buyer</dt>
            <dd>
              {total.toLocaleString()} {CURRENCY_NAME}
            </dd>
          </div>
          <div className="flex justify-between text-xs text-muted">
            <dt>You receive</dt>
            <dd>
              {subtotal.toLocaleString()} {CURRENCY_NAME}
            </dd>
          </div>
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

export function PayInvoiceButton({
  invoiceId,
  total,
  companyName,
  canAfford,
}: {
  invoiceId: string;
  total: number;
  companyName: string;
  canAfford: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(payInvoiceAction, null);

  if (state?.ok) {
    return (
      <div className="card p-5 text-center">
        <p className="font-semibold text-success">Invoice paid</p>
        <p className="mt-2 text-sm">
          {state.data.invoiceNumber} · {state.data.total.toLocaleString()} {CURRENCY_NAME}
        </p>
        <p className="mt-1 font-mono text-xs text-muted">Ref {state.data.txRef}</p>
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
          <p className="text-xs text-danger">Your balance is not enough to pay this invoice.</p>
        )}
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3 rounded-md border border-border p-4">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <p className="text-sm">
        Pay {companyName} {total.toLocaleString()} {CURRENCY_NAME} from your personal wallet?
      </p>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
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
