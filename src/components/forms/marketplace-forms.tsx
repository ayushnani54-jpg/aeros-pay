"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import {
  acceptOrderAction,
  activatePromotionAction,
  applyForContractAction,
  awardContractAction,
  cancelContractAction,
  cancelOrderAction,
  cancelPromotionAction,
  closeWantedAction,
  completeOrderAction,
  createContractAction,
  createOfferAction,
  createWantedAction,
  decideWantedResponseAction,
  issueContractInvoiceAction,
  issueOrderInvoiceAction,
  pausePromotionAction,
  payContractToUserAction,
  placeOrderAction,
  refundPaymentAction,
  requestOrderInvoiceAction,
  requestPromotionAction,
  respondToWantedAction,
  setOfferStatusAction,
  updateOfferAction,
  withdrawContractApplicationAction,
  withdrawWantedResponseAction,
} from "@/actions/marketplace";
import { CURRENCY_NAME } from "@/lib/constants";
import { VoiceInput } from "./voice-input";

/**
 * MARKETPLACE FORMS (V3 Phases C, D, E)
 *
 * Every form here is the same shape as the V2 forms next to it: a `.card`, the
 * existing `.input` and `.btn` classes, `useActionState` for the pending state
 * and the server's error message rendered verbatim. No new design language and
 * no client-side money arithmetic — totals always come back from the server.
 */

// ---------------------------------------------------------------------------
// Search (debounced, server-side, stores nothing)
// ---------------------------------------------------------------------------

/**
 * The browse filter bar.
 *
 * Typing updates the URL after a pause, and the SERVER re-runs the query for
 * the new search params. There is no client-side filtering of a preloaded list
 * and — the part that matters — no history, no recent-searches list and no
 * request that records the term anywhere. The URL is the only place the query
 * lives, and it disappears when the viewer navigates away.
 */
export function MarketSearchBar({
  categories,
  initial,
}: {
  categories: string[];
  initial: { q: string; category: string; minPrice: string; maxPrice: string; sort: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [q, setQ] = useState(initial.q);
  const first = useRef(true);

  function push(next: Record<string, string>) {
    const sp = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === "") sp.delete(key);
      else sp.set(key, value);
    }
    // Any filter change starts again at page 1; staying on page 4 of a
    // different result set is never what someone means.
    sp.delete("page");
    router.replace(`${pathname}?${sp.toString()}`);
  }

  // Debounced so typing a word is one query, not one per keystroke.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => push({ q }), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div className="card space-y-3 p-4">
      <div>
        <label htmlFor="marketQ" className="mb-1 block text-sm font-medium">
          Search listings
        </label>
        <input
          id="marketQ"
          name="q"
          className="input"
          placeholder="Item, description, category or company"
          value={q}
          maxLength={120}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label htmlFor="marketCategory" className="mb-1 block text-xs text-muted">
            Category
          </label>
          <select
            id="marketCategory"
            className="input"
            defaultValue={initial.category}
            onChange={(e) => push({ category: e.target.value })}
          >
            <option value="">All</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="marketMin" className="mb-1 block text-xs text-muted">
            Min price
          </label>
          <input
            id="marketMin"
            className="input"
            type="number"
            min={1}
            step={1}
            defaultValue={initial.minPrice}
            onBlur={(e) => push({ minPrice: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="marketMax" className="mb-1 block text-xs text-muted">
            Max price
          </label>
          <input
            id="marketMax"
            className="input"
            type="number"
            min={1}
            step={1}
            defaultValue={initial.maxPrice}
            onBlur={(e) => push({ maxPrice: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="marketSort" className="mb-1 block text-xs text-muted">
            Sort
          </label>
          <select
            id="marketSort"
            className="input"
            defaultValue={initial.sort}
            onChange={(e) => push({ sort: e.target.value })}
          >
            <option value="NEWEST">Newest</option>
            <option value="PRICE_ASC">Price: low to high</option>
            <option value="PRICE_DESC">Price: high to low</option>
          </select>
        </div>
      </div>

      <p className="text-xs text-muted">
        Searching stores nothing — no history and no analytics are kept.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Offers (company side)
// ---------------------------------------------------------------------------

export function CreateOfferForm() {
  const [state, formAction, pending] = useActionState(createOfferAction, null);

  return (
    <form action={formAction} className="card space-y-4 p-6">
      <div>
        <h3 className="font-medium">Add a listing</h3>
        <p className="mt-1 text-sm text-muted">
          Buyers see this price; tax is added on top when you invoice the order, so you receive
          the full amount you ask for.
        </p>
      </div>

      <div>
        <label htmlFor="offerTitle" className="mb-1 block text-sm font-medium">
          Title
        </label>
        <input
          id="offerTitle"
          name="title"
          className="input"
          required
          maxLength={160}
          placeholder="e.g. Handwoven Scarf"
        />
      </div>

      <div>
        <label htmlFor="offerDescription" className="mb-1 block text-sm font-medium">
          Description
        </label>
        <textarea
          id="offerDescription"
          name="description"
          className="input"
          rows={3}
          required
          maxLength={2000}
        />
        <VoiceInput targetId="offerDescription" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="offerCategory" className="mb-1 block text-sm font-medium">
            Category
          </label>
          <input
            id="offerCategory"
            name="category"
            className="input"
            required
            maxLength={60}
            placeholder="e.g. Clothing"
          />
        </div>
        <div>
          <label htmlFor="offerPrice" className="mb-1 block text-sm font-medium">
            Price ({CURRENCY_NAME})
          </label>
          <input
            id="offerPrice"
            name="unitPrice"
            className="input"
            type="number"
            min={1}
            step={1}
            required
          />
        </div>
      </div>

      <div>
        <label htmlFor="offerQuantity" className="mb-1 block text-sm font-medium">
          Availability
        </label>
        <input
          id="offerQuantity"
          name="quantityAvailable"
          className="input"
          type="number"
          min={0}
          step={1}
          placeholder="Leave blank for unlimited"
        />
        <p className="mt-1 text-xs text-muted">
          Blank means unlimited. A number is reserved as orders come in.
        </p>
      </div>

      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-success">Listing added.</p>}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Adding…" : "Add listing"}
      </button>
    </form>
  );
}

export function EditOfferForm({
  offer,
}: {
  offer: {
    id: string;
    title: string;
    description: string;
    category: string;
    unitPrice: number;
    quantityAvailable: number | null;
  };
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(updateOfferAction, null);

  if (!open) {
    return (
      <button type="button" className="btn btn-secondary text-xs" onClick={() => setOpen(true)}>
        Edit
      </button>
    );
  }

  return (
    <form action={formAction} className="mt-3 w-full space-y-3 rounded-md border border-border p-4">
      <input type="hidden" name="offerId" value={offer.id} />
      <div>
        <label htmlFor={`t-${offer.id}`} className="mb-1 block text-xs text-muted">
          Title
        </label>
        <input
          id={`t-${offer.id}`}
          name="title"
          className="input"
          defaultValue={offer.title}
          required
          maxLength={160}
        />
      </div>
      <div>
        <label htmlFor={`d-${offer.id}`} className="mb-1 block text-xs text-muted">
          Description
        </label>
        <textarea
          id={`d-${offer.id}`}
          name="description"
          className="input"
          rows={2}
          defaultValue={offer.description}
          required
          maxLength={2000}
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label htmlFor={`c-${offer.id}`} className="mb-1 block text-xs text-muted">
            Category
          </label>
          <input
            id={`c-${offer.id}`}
            name="category"
            className="input"
            defaultValue={offer.category}
            required
            maxLength={60}
          />
        </div>
        <div>
          <label htmlFor={`p-${offer.id}`} className="mb-1 block text-xs text-muted">
            Price
          </label>
          <input
            id={`p-${offer.id}`}
            name="unitPrice"
            className="input"
            type="number"
            min={1}
            step={1}
            defaultValue={offer.unitPrice}
            required
          />
        </div>
        <div>
          <label htmlFor={`q-${offer.id}`} className="mb-1 block text-xs text-muted">
            Stock
          </label>
          <input
            id={`q-${offer.id}`}
            name="quantityAvailable"
            className="input"
            type="number"
            min={0}
            step={1}
            defaultValue={offer.quantityAvailable ?? ""}
            placeholder="Unlimited"
          />
        </div>
      </div>
      {state && !state.ok && <p className="text-xs text-danger">{state.error}</p>}
      {state?.ok && <p className="text-xs text-success">Saved.</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-secondary flex-1 text-xs"
          onClick={() => setOpen(false)}
        >
          Close
        </button>
        <button type="submit" className="btn btn-primary flex-1 text-xs" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

export function OfferStatusButton({
  offerId,
  status,
  label,
  tone = "secondary",
}: {
  offerId: string;
  status: "ACTIVE" | "PAUSED" | "CLOSED";
  label: string;
  tone?: "secondary" | "danger";
}) {
  const [state, formAction, pending] = useActionState(setOfferStatusAction, null);
  return (
    <form action={formAction} className="inline-block">
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="status" value={status} />
      <button
        type="submit"
        className={`btn ${tone === "danger" ? "btn-danger" : "btn-secondary"} text-xs`}
        disabled={pending}
      >
        {pending ? "Working…" : label}
      </button>
      {state && !state.ok && <p className="mt-1 text-xs text-danger">{state.error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Orders (buyer side)
// ---------------------------------------------------------------------------

/**
 * Place an order.
 *
 * The confirm step shows the SERVER's snapshot price multiplied out, and the
 * success panel is rendered only from `state.data`, which exists only once the
 * server has committed the order.
 */
export function PlaceOrderForm({
  offerId,
  unitPrice,
  available,
  buyerLabel,
  disabledReason,
}: {
  offerId: string;
  unitPrice: number;
  available: number | null;
  buyerLabel: string;
  disabledReason: string | null;
}) {
  const [state, formAction, pending] = useActionState(placeOrderAction, null);
  const [quantity, setQuantity] = useState(1);

  if (state?.ok) {
    return (
      <div className="card p-5" data-testid="order-placed">
        <p className="font-semibold text-success">Order placed</p>
        <p className="mt-2 text-sm">
          {state.data.orderNumber} · {state.data.subtotal.toLocaleString()} {CURRENCY_NAME} before
          tax
        </p>
        <p className="mt-1 text-xs text-muted">
          The seller will accept it and send you an invoice. Nothing is charged until you pay that
          invoice.
        </p>
        <Link href="/market/orders" className="btn btn-secondary mt-3 inline-block text-sm">
          View my orders
        </Link>
      </div>
    );
  }

  if (disabledReason) {
    return (
      <div className="card p-5">
        <p className="text-sm text-muted">{disabledReason}</p>
      </div>
    );
  }

  const max = available ?? 100000;
  const subtotal = unitPrice * (Number.isFinite(quantity) ? quantity : 0);

  return (
    <form action={formAction} className="card space-y-4 p-5">
      <input type="hidden" name="offerId" value={offerId} />
      <div>
        <label htmlFor="orderQuantity" className="mb-1 block text-sm font-medium">
          Quantity
        </label>
        <input
          id="orderQuantity"
          name="quantity"
          type="number"
          min={1}
          max={max}
          step={1}
          className="input"
          required
          value={quantity}
          onChange={(e) => setQuantity(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
        />
        {available !== null && (
          <p className="mt-1 text-xs text-muted">{available.toLocaleString()} available.</p>
        )}
      </div>

      <dl className="space-y-1 rounded-md bg-surface p-3 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted">
            {quantity} × {unitPrice.toLocaleString()} {CURRENCY_NAME}
          </dt>
          <dd>
            {subtotal.toLocaleString()} {CURRENCY_NAME}
          </dd>
        </div>
        <div className="flex justify-between text-xs text-muted">
          <dt>Tax</dt>
          <dd>Added by the seller&rsquo;s invoice</dd>
        </div>
      </dl>

      <p className="text-xs text-muted">Ordering as {buyerLabel}. Nothing is charged yet.</p>

      {state && !state.ok && (
        <p className="text-sm text-danger" role="alert">
          {state.error}
        </p>
      )}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Placing…" : "Place order"}
      </button>
    </form>
  );
}

function SimpleOrderButton({
  action,
  orderId,
  label,
  busyLabel,
  tone = "secondary",
}: {
  action: typeof acceptOrderAction;
  orderId: string;
  label: string;
  busyLabel: string;
  tone?: "primary" | "secondary" | "danger";
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="inline-block">
      <input type="hidden" name="orderId" value={orderId} />
      <button type="submit" className={`btn btn-${tone} text-xs`} disabled={pending}>
        {pending ? busyLabel : label}
      </button>
      {state && !state.ok && <p className="mt-1 text-xs text-danger">{state.error}</p>}
    </form>
  );
}

export function AcceptOrderButton({ orderId }: { orderId: string }) {
  return (
    <SimpleOrderButton
      action={acceptOrderAction}
      orderId={orderId}
      label="Accept order"
      busyLabel="Accepting…"
      tone="primary"
    />
  );
}

export function RequestInvoiceButton({ orderId }: { orderId: string }) {
  return (
    <SimpleOrderButton
      action={requestOrderInvoiceAction}
      orderId={orderId}
      label="Ask for the invoice"
      busyLabel="Asking…"
    />
  );
}

export function CompleteOrderButton({ orderId }: { orderId: string }) {
  return (
    <SimpleOrderButton
      action={completeOrderAction}
      orderId={orderId}
      label="Mark completed"
      busyLabel="Saving…"
      tone="primary"
    />
  );
}

export function CancelOrderButton({ orderId }: { orderId: string }) {
  const [state, formAction, pending] = useActionState(cancelOrderAction, null);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" className="btn btn-danger text-xs" onClick={() => setConfirming(true)}>
        Cancel order
      </button>
    );
  }

  return (
    <form action={formAction} className="w-full space-y-2 rounded-md border border-border p-3">
      <input type="hidden" name="orderId" value={orderId} />
      <label htmlFor={`cr-${orderId}`} className="block text-xs text-muted">
        Reason (optional)
      </label>
      <input id={`cr-${orderId}`} name="reason" className="input" maxLength={500} />
      {state && !state.ok && <p className="text-xs text-danger">{state.error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-secondary flex-1 text-xs"
          onClick={() => setConfirming(false)}
        >
          Keep it
        </button>
        <button type="submit" className="btn btn-danger flex-1 text-xs" disabled={pending}>
          {pending ? "Cancelling…" : "Cancel order"}
        </button>
      </div>
    </form>
  );
}

/** The seller raises the order's invoice. No amounts: the order carries them. */
export function IssueOrderInvoiceForm({ orderId, total }: { orderId: string; total: number }) {
  const [state, formAction, pending] = useActionState(issueOrderInvoiceAction, null);

  if (state?.ok) {
    return (
      <div className="rounded-md border border-border p-3" data-testid="order-invoice-issued">
        <p className="text-sm text-success">Invoice {state.data.invoiceNumber} sent.</p>
        <p className="mt-1 text-xs text-muted">
          {state.data.total.toLocaleString()} {CURRENCY_NAME} payable by the buyer.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="w-full space-y-2 rounded-md border border-border p-3">
      <input type="hidden" name="orderId" value={orderId} />
      <p className="text-xs text-muted">
        The invoice uses the order&rsquo;s own {total.toLocaleString()} {CURRENCY_NAME} subtotal.
        Tax is added on top by the server.
      </p>
      <label htmlFor={`due-${orderId}`} className="block text-xs text-muted">
        Due date (optional)
      </label>
      <input id={`due-${orderId}`} name="dueDate" type="date" className="input" />
      {state && !state.ok && <p className="text-xs text-danger">{state.error}</p>}
      <button type="submit" className="btn btn-primary text-xs" disabled={pending}>
        {pending ? "Sending…" : "Send invoice"}
      </button>
    </form>
  );
}

/** A company refunds a payment it received. Never edits the original row. */
export function RefundForm({
  transactionId,
  maxAmount,
}: {
  transactionId: string;
  maxAmount: number;
}) {
  const [state, formAction, pending] = useActionState(refundPaymentAction, null);
  const [open, setOpen] = useState(false);

  if (state?.ok) {
    return (
      <div className="rounded-md border border-border p-3" data-testid="refund-done">
        <p className="text-sm text-success">
          Refunded {state.data.refundedToPayer.toLocaleString()} {CURRENCY_NAME}.
        </p>
        <p className="mt-1 font-mono text-xs text-muted">
          {state.data.originalTxRef} → {state.data.reversalTxRef}
        </p>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-danger text-xs" onClick={() => setOpen(true)}>
        Refund
      </button>
    );
  }

  return (
    <form action={formAction} className="w-full space-y-2 rounded-md border border-border p-3">
      <input type="hidden" name="transactionId" value={transactionId} />
      <p className="text-xs text-muted">
        A refund is a new transaction linked to the original. The original is never changed.
      </p>
      <label htmlFor={`ra-${transactionId}`} className="block text-xs text-muted">
        Amount (blank refunds it all, including the tax)
      </label>
      <input
        id={`ra-${transactionId}`}
        name="amount"
        type="number"
        min={1}
        max={maxAmount}
        step={1}
        className="input"
        placeholder={`Full refund (${maxAmount.toLocaleString()} + tax)`}
      />
      <label htmlFor={`rr-${transactionId}`} className="block text-xs text-muted">
        Reason
      </label>
      <input id={`rr-${transactionId}`} name="reason" className="input" required maxLength={500} />
      {state && !state.ok && <p className="text-xs text-danger">{state.error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-secondary flex-1 text-xs"
          onClick={() => setOpen(false)}
        >
          Back
        </button>
        <button type="submit" className="btn btn-danger flex-1 text-xs" disabled={pending}>
          {pending ? "Refunding…" : "Issue refund"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Wanted
// ---------------------------------------------------------------------------

export function CreateWantedForm() {
  const [state, formAction, pending] = useActionState(createWantedAction, null);

  return (
    <form action={formAction} className="card space-y-4 p-6">
      <div>
        <h3 className="font-medium">Post what you are looking for</h3>
        <p className="mt-1 text-sm text-muted">
          Anyone can reply once. There is no chat — agree the details, then pay or invoice as
          usual.
        </p>
      </div>

      <div>
        <label htmlFor="wantedHeading" className="mb-1 block text-sm font-medium">
          Heading
        </label>
        <input id="wantedHeading" name="heading" className="input" required maxLength={160} />
      </div>
      <div>
        <label htmlFor="wantedDescription" className="mb-1 block text-sm font-medium">
          Description
        </label>
        <textarea
          id="wantedDescription"
          name="description"
          className="input"
          rows={3}
          required
          maxLength={2000}
        />
        <VoiceInput targetId="wantedDescription" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label htmlFor="wantedCategory" className="mb-1 block text-sm font-medium">
            Category
          </label>
          <input id="wantedCategory" name="category" className="input" required maxLength={60} />
        </div>
        <div>
          <label htmlFor="wantedQuantity" className="mb-1 block text-sm font-medium">
            Quantity
          </label>
          <input
            id="wantedQuantity"
            name="quantity"
            type="number"
            min={1}
            step={1}
            className="input"
            defaultValue={1}
            required
          />
        </div>
        <div>
          <label htmlFor="wantedBudget" className="mb-1 block text-sm font-medium">
            Budget
          </label>
          <input
            id="wantedBudget"
            name="budget"
            type="number"
            min={1}
            step={1}
            className="input"
            required
          />
        </div>
        <div>
          <label htmlFor="wantedDeadline" className="mb-1 block text-sm font-medium">
            Deadline
          </label>
          <input id="wantedDeadline" name="deadline" type="date" className="input" />
        </div>
      </div>

      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-success">Request posted.</p>}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Posting…" : "Post request"}
      </button>
    </form>
  );
}

export function RespondToWantedForm({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useActionState(respondToWantedAction, null);

  if (state?.ok) {
    return (
      <div className="card p-5">
        <p className="text-sm text-success">Reply sent. You can only reply once.</p>
      </div>
    );
  }

  return (
    <form action={formAction} className="card space-y-3 p-5">
      <input type="hidden" name="requestId" value={requestId} />
      <h3 className="font-medium">Reply to this request</h3>
      <div>
        <label htmlFor="wrMessage" className="mb-1 block text-sm font-medium">
          What can you offer?
        </label>
        <textarea id="wrMessage" name="message" className="input" rows={3} required maxLength={1000} />
        <VoiceInput targetId="wrMessage" />
      </div>
      <div>
        <label htmlFor="wrPrice" className="mb-1 block text-sm font-medium">
          Your price ({CURRENCY_NAME}, optional)
        </label>
        <input id="wrPrice" name="offeredPrice" type="number" min={1} step={1} className="input" />
      </div>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Sending…" : "Send reply"}
      </button>
    </form>
  );
}

export function WantedDecisionButtons({ responseId }: { responseId: string }) {
  const [state, formAction, pending] = useActionState(decideWantedResponseAction, null);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="responseId" value={responseId} />
      <button
        type="submit"
        name="decision"
        value="ACCEPTED"
        className="btn btn-primary text-xs"
        disabled={pending}
      >
        Accept
      </button>
      <button
        type="submit"
        name="decision"
        value="DECLINED"
        className="btn btn-secondary text-xs"
        disabled={pending}
      >
        Decline
      </button>
      {state && !state.ok && <p className="text-xs text-danger">{state.error}</p>}
    </form>
  );
}

export function WithdrawWantedResponseButton({ responseId }: { responseId: string }) {
  const [state, formAction, pending] = useActionState(withdrawWantedResponseAction, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="responseId" value={responseId} />
      <button type="submit" className="btn btn-secondary text-xs" disabled={pending}>
        {pending ? "Withdrawing…" : "Withdraw"}
      </button>
      {state && !state.ok && <p className="mt-1 text-xs text-danger">{state.error}</p>}
    </form>
  );
}

export function CloseWantedButtons({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useActionState(closeWantedAction, null);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="requestId" value={requestId} />
      <button
        type="submit"
        name="status"
        value="FULFILLED"
        className="btn btn-secondary text-xs"
        disabled={pending}
      >
        Mark fulfilled
      </button>
      <button
        type="submit"
        name="status"
        value="CANCELLED"
        className="btn btn-danger text-xs"
        disabled={pending}
      >
        Cancel request
      </button>
      {state && !state.ok && <p className="text-xs text-danger">{state.error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export function CreateContractForm() {
  const [state, formAction, pending] = useActionState(createContractAction, null);

  return (
    <form action={formAction} className="card space-y-4 p-6">
      <div>
        <h3 className="font-medium">Put work out to tender</h3>
        <p className="mt-1 text-sm text-muted">
          People and companies apply. You award one, they invoice you (or you pay them directly),
          and the contract completes.
        </p>
      </div>

      <div>
        <label htmlFor="ctTitle" className="mb-1 block text-sm font-medium">
          Title
        </label>
        <input id="ctTitle" name="title" className="input" required maxLength={160} />
      </div>
      <div>
        <label htmlFor="ctRequirement" className="mb-1 block text-sm font-medium">
          Requirement
        </label>
        <textarea
          id="ctRequirement"
          name="requirement"
          className="input"
          rows={2}
          required
          maxLength={2000}
        />
        <VoiceInput targetId="ctRequirement" />
      </div>
      <div>
        <label htmlFor="ctDescription" className="mb-1 block text-sm font-medium">
          Description
        </label>
        <textarea
          id="ctDescription"
          name="description"
          className="input"
          rows={3}
          required
          maxLength={2000}
        />
        <VoiceInput targetId="ctDescription" />
      </div>
      <div>
        <label htmlFor="ctConditions" className="mb-1 block text-sm font-medium">
          Conditions (optional)
        </label>
        <textarea id="ctConditions" name="conditions" className="input" rows={2} maxLength={2000} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="ctBudget" className="mb-1 block text-sm font-medium">
            Budget ({CURRENCY_NAME})
          </label>
          <input
            id="ctBudget"
            name="budget"
            type="number"
            min={1}
            step={1}
            className="input"
            required
          />
        </div>
        <div>
          <label htmlFor="ctDeadline" className="mb-1 block text-sm font-medium">
            Deadline (optional)
          </label>
          <input id="ctDeadline" name="deadline" type="date" className="input" />
        </div>
      </div>

      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-success">Contract published.</p>}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Publishing…" : "Publish contract"}
      </button>
    </form>
  );
}

export function ApplyForContractForm({ contractId }: { contractId: string }) {
  const [state, formAction, pending] = useActionState(applyForContractAction, null);

  if (state?.ok) {
    return (
      <div className="card p-5">
        <p className="text-sm text-success">Application sent. You can only apply once.</p>
      </div>
    );
  }

  return (
    <form action={formAction} className="card space-y-3 p-5">
      <input type="hidden" name="contractId" value={contractId} />
      <h3 className="font-medium">Apply for this contract</h3>
      <div>
        <label htmlFor="caProposal" className="mb-1 block text-sm font-medium">
          Your proposal
        </label>
        <textarea
          id="caProposal"
          name="proposal"
          className="input"
          rows={3}
          required
          maxLength={2000}
        />
        <VoiceInput targetId="caProposal" />
      </div>
      <div>
        <label htmlFor="caPrice" className="mb-1 block text-sm font-medium">
          Your price ({CURRENCY_NAME}, optional — the budget is used if you leave it blank)
        </label>
        <input id="caPrice" name="quotedPrice" type="number" min={1} step={1} className="input" />
      </div>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Sending…" : "Apply"}
      </button>
    </form>
  );
}

export function AwardContractButton({
  contractId,
  applicationId,
}: {
  contractId: string;
  applicationId: string;
}) {
  const [state, formAction, pending] = useActionState(awardContractAction, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="contractId" value={contractId} />
      <input type="hidden" name="applicationId" value={applicationId} />
      <button type="submit" className="btn btn-primary text-xs" disabled={pending}>
        {pending ? "Awarding…" : "Award"}
      </button>
      {state && !state.ok && <p className="mt-1 text-xs text-danger">{state.error}</p>}
    </form>
  );
}

export function WithdrawContractApplicationButton({ applicationId }: { applicationId: string }) {
  const [state, formAction, pending] = useActionState(withdrawContractApplicationAction, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="applicationId" value={applicationId} />
      <button type="submit" className="btn btn-secondary text-xs" disabled={pending}>
        {pending ? "Withdrawing…" : "Withdraw application"}
      </button>
      {state && !state.ok && <p className="mt-1 text-xs text-danger">{state.error}</p>}
    </form>
  );
}

export function CancelContractButton({ contractId }: { contractId: string }) {
  const [state, formAction, pending] = useActionState(cancelContractAction, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="contractId" value={contractId} />
      <button type="submit" className="btn btn-danger text-xs" disabled={pending}>
        {pending ? "Cancelling…" : "Cancel contract"}
      </button>
      {state && !state.ok && <p className="mt-1 text-xs text-danger">{state.error}</p>}
    </form>
  );
}

export function IssueContractInvoiceForm({ contractId }: { contractId: string }) {
  const [state, formAction, pending] = useActionState(issueContractInvoiceAction, null);

  if (state?.ok) {
    return <p className="text-sm text-success">Invoice sent to the contract issuer.</p>;
  }

  return (
    <form action={formAction} className="space-y-2 rounded-md border border-border p-3">
      <input type="hidden" name="contractId" value={contractId} />
      <p className="text-xs text-muted">
        The invoice uses the agreed price. Payment settles to your company wallet.
      </p>
      <label htmlFor={`cdue-${contractId}`} className="block text-xs text-muted">
        Due date (optional)
      </label>
      <input id={`cdue-${contractId}`} name="dueDate" type="date" className="input" />
      {state && !state.ok && <p className="text-xs text-danger">{state.error}</p>}
      <button type="submit" className="btn btn-primary text-xs" disabled={pending}>
        {pending ? "Sending…" : "Send invoice"}
      </button>
    </form>
  );
}

export function PayContractToUserButton({
  contractId,
  amount,
}: {
  contractId: string;
  amount: number;
}) {
  const [state, formAction, pending] = useActionState(payContractToUserAction, null);
  const [confirming, setConfirming] = useState(false);

  if (state?.ok) {
    return (
      <div className="rounded-md border border-border p-3" data-testid="contract-paid">
        <p className="text-sm text-success">
          Paid {state.data.amount.toLocaleString()} {CURRENCY_NAME}.
        </p>
        <p className="mt-1 font-mono text-xs text-muted">Ref {state.data.txRef}</p>
      </div>
    );
  }

  if (!confirming) {
    return (
      <button type="button" className="btn btn-primary text-xs" onClick={() => setConfirming(true)}>
        Pay {amount.toLocaleString()} {CURRENCY_NAME}
      </button>
    );
  }

  return (
    <form action={formAction} className="space-y-2 rounded-md border border-border p-3">
      <input type="hidden" name="contractId" value={contractId} />
      <p className="text-sm">
        Pay the awarded person {amount.toLocaleString()} {CURRENCY_NAME} and complete this
        contract?
      </p>
      {state && !state.ok && <p className="text-xs text-danger">{state.error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-secondary flex-1 text-xs"
          onClick={() => setConfirming(false)}
        >
          Back
        </button>
        <button type="submit" className="btn btn-primary flex-1 text-xs" disabled={pending}>
          {pending ? "Paying…" : "Confirm payment"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Promotions (company side)
// ---------------------------------------------------------------------------

export function RequestPromotionForm({
  offers,
  dailyRate,
}: {
  offers: { id: string; title: string }[];
  dailyRate: number;
}) {
  const [state, formAction, pending] = useActionState(requestPromotionAction, null);
  const [days, setDays] = useState(3);

  if (offers.length === 0) {
    return (
      <div className="card p-5">
        <p className="text-sm text-muted">
          Add an active listing first — a promotion always points at one of your own listings.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="card space-y-4 p-6">
      <div>
        <h3 className="font-medium">Request the ad slot</h3>
        <p className="mt-1 text-sm text-muted">
          One promotion runs across Aeros Pay at a time. The Government reviews every request, and
          an approved campaign is charged {dailyRate.toLocaleString()} {CURRENCY_NAME} for each
          day it is live.
        </p>
      </div>

      <div>
        <label htmlFor="promoOffer" className="mb-1 block text-sm font-medium">
          Listing to promote
        </label>
        <select id="promoOffer" name="offerId" className="input" required>
          {offers.map((o) => (
            <option key={o.id} value={o.id}>
              {o.title}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="promoHeading" className="mb-1 block text-sm font-medium">
          Heading
        </label>
        <input id="promoHeading" name="heading" className="input" required maxLength={160} />
      </div>
      <div>
        <label htmlFor="promoDescription" className="mb-1 block text-sm font-medium">
          Short description
        </label>
        <input
          id="promoDescription"
          name="shortDescription"
          className="input"
          required
          maxLength={240}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="promoCta" className="mb-1 block text-sm font-medium">
            Button label
          </label>
          <input
            id="promoCta"
            name="ctaLabel"
            className="input"
            maxLength={48}
            placeholder="View offer"
          />
        </div>
        <div>
          <label htmlFor="promoDays" className="mb-1 block text-sm font-medium">
            Days
          </label>
          <input
            id="promoDays"
            name="requestedDurationDays"
            type="number"
            min={1}
            max={365}
            step={1}
            className="input"
            required
            value={days}
            onChange={(e) => setDays(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
          />
        </div>
      </div>

      <p className="rounded-md bg-surface p-3 text-sm text-muted">
        At today&rsquo;s rate that is up to {(days * dailyRate).toLocaleString()} {CURRENCY_NAME}{" "}
        in total. The rate is frozen when the Government approves the campaign, and each day is
        charged once.
      </p>

      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-success">Request sent to the Government.</p>}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Sending…" : "Request promotion"}
      </button>
    </form>
  );
}

function SimplePromotionButton({
  action,
  campaignId,
  label,
  busyLabel,
  tone = "secondary",
}: {
  action: typeof activatePromotionAction;
  campaignId: string;
  label: string;
  busyLabel: string;
  tone?: "primary" | "secondary" | "danger";
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="inline-block">
      <input type="hidden" name="campaignId" value={campaignId} />
      <button type="submit" className={`btn btn-${tone} text-xs`} disabled={pending}>
        {pending ? busyLabel : label}
      </button>
      {state && !state.ok && <p className="mt-1 text-xs text-danger">{state.error}</p>}
    </form>
  );
}

export function ActivatePromotionButton({ campaignId }: { campaignId: string }) {
  return (
    <SimplePromotionButton
      action={activatePromotionAction}
      campaignId={campaignId}
      label="Start running"
      busyLabel="Starting…"
      tone="primary"
    />
  );
}

export function PausePromotionButton({ campaignId }: { campaignId: string }) {
  return (
    <SimplePromotionButton
      action={pausePromotionAction}
      campaignId={campaignId}
      label="Pause"
      busyLabel="Pausing…"
    />
  );
}

export function CancelPromotionButton({ campaignId }: { campaignId: string }) {
  return (
    <SimplePromotionButton
      action={cancelPromotionAction}
      campaignId={campaignId}
      label="Cancel"
      busyLabel="Cancelling…"
      tone="danger"
    />
  );
}
