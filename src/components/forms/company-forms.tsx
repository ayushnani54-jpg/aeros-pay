"use client";

import { useActionState, useState } from "react";
import {
  acceptLoanAction,
  applyForLoanAction,
  cancelListingAction,
  cancelLoanAction,
  createCompanyAction,
  dismissListingAction,
  listCompanyForSaleAction,
  makeOfferAction,
  payInstalmentAction,
  purchaseCompanyAction,
  respondToOfferAction,
  submitIpComplaintAction,
  undismissListingAction,
} from "@/actions/company";
import { COMPANY_DESCRIPTION_MAX_WORDS, CURRENCY_NAME } from "@/lib/constants";

function Feedback({
  state,
  successText,
}: {
  state: { ok: boolean; error?: string } | null;
  successText: string;
}) {
  if (!state) return null;
  if (!state.ok) {
    return (
      <p className="text-sm text-danger" role="alert">
        {state.error}
      </p>
    );
  }
  return <p className="text-sm text-success">{successText}</p>;
}

// ---------------------------------------------------------------------------
// Company application
// ---------------------------------------------------------------------------

export function CreateCompanyForm() {
  const [state, formAction, pending] = useActionState(createCompanyAction, null);
  const [description, setDescription] = useState("");

  const wordCount = description.trim() === "" ? 0 : description.trim().split(/\s+/).length;
  const overLimit = wordCount > COMPANY_DESCRIPTION_MAX_WORDS;

  return (
    <form action={formAction} className="card space-y-4 p-6">
      <div>
        <label htmlFor="name" className="mb-1 block text-sm font-medium">
          Company name
        </label>
        <input id="name" name="name" className="input" required maxLength={80} />
      </div>

      <div>
        <label htmlFor="username" className="mb-1 block text-sm font-medium">
          Company username
        </label>
        <input
          id="username"
          name="username"
          className="input"
          required
          maxLength={24}
          placeholder="e.g. ayushfitness"
        />
        <p className="mt-1 text-xs text-muted">
          Lowercase letters, numbers and underscores. This is the handle people will pay.
        </p>
      </div>

      <div>
        <label htmlFor="category" className="mb-1 block text-sm font-medium">
          Business category
        </label>
        <input
          id="category"
          name="category"
          className="input"
          required
          maxLength={60}
          placeholder="e.g. Fitness, Retail, Design"
        />
      </div>

      <div>
        <label htmlFor="reason" className="mb-1 block text-sm font-medium">
          Why are you creating this company?
        </label>
        <textarea id="reason" name="reason" className="input" rows={3} required maxLength={1000} />
      </div>

      <div>
        <label htmlFor="description" className="mb-1 block text-sm font-medium">
          Company description
        </label>
        <textarea
          id="description"
          name="description"
          className="input"
          rows={6}
          required
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <p className={`mt-1 text-xs ${overLimit ? "text-danger" : "text-muted"}`}>
          {wordCount} / {COMPANY_DESCRIPTION_MAX_WORDS} words
          {overLimit ? " — too long, please shorten it." : ""}
        </p>
      </div>

      <Feedback state={state} successText="Application submitted for Government review." />

      <button type="submit" className="btn btn-primary" disabled={pending || overLimit}>
        {pending ? "Submitting…" : "Submit application"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Company sale — listing
// ---------------------------------------------------------------------------

export function ListForSaleForm({
  companyId,
  valuation,
  salesFigure,
  multiplier,
  eligible,
  eligibilityReason,
}: {
  companyId: string;
  valuation: number;
  salesFigure: number;
  multiplier: number;
  eligible: boolean;
  eligibilityReason?: string;
}) {
  const [state, formAction, pending] = useActionState(listCompanyForSaleAction, null);

  return (
    <form action={formAction} className="card space-y-4 p-6">
      <input type="hidden" name="companyId" value={companyId} />

      <div>
        <h3 className="font-medium">List this company for sale</h3>
        <p className="mt-1 text-sm text-muted">
          The price is set from your lifetime sales and the Government&apos;s multiplier, and is
          frozen once you list.
        </p>
      </div>

      <dl className="space-y-1 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted">Lifetime sales</dt>
          <dd>
            {salesFigure.toLocaleString()} {CURRENCY_NAME}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Multiplier</dt>
          <dd>{multiplier.toFixed(2)}×</dd>
        </div>
        <div className="flex justify-between border-t border-border pt-1 font-medium">
          <dt>Asking price</dt>
          <dd>
            {valuation.toLocaleString()} {CURRENCY_NAME}
          </dd>
        </div>
      </dl>

      <div>
        <label htmlFor="reason" className="mb-1 block text-sm font-medium">
          Why are you selling?
        </label>
        <textarea id="reason" name="reason" className="input" rows={3} required maxLength={1000} />
      </div>

      {!eligible && <p className="text-sm text-danger">{eligibilityReason}</p>}
      <Feedback state={state} successText="Your company is now listed for sale." />

      <button type="submit" className="btn btn-primary" disabled={pending || !eligible}>
        {pending ? "Listing…" : "List for sale"}
      </button>
    </form>
  );
}

export function CancelListingButton({ listingId }: { listingId: string }) {
  const [state, formAction, pending] = useActionState(cancelListingAction, null);
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="listingId" value={listingId} />
      <button type="submit" className="btn btn-danger text-sm" disabled={pending}>
        {pending ? "Cancelling…" : "Cancel listing"}
      </button>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Marketplace: buy / dismiss / offer
// ---------------------------------------------------------------------------

export function BuyCompanyButton({
  listingId,
  price,
  companyName,
  canAfford,
}: {
  listingId: string;
  price: number;
  companyName: string;
  canAfford: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(purchaseCompanyAction, null);

  if (!confirming) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          className="btn btn-primary text-sm"
          onClick={() => setConfirming(true)}
          disabled={!canAfford}
        >
          Buy for {price.toLocaleString()} {CURRENCY_NAME}
        </button>
        {!canAfford && (
          <p className="text-xs text-danger">Your personal wallet does not hold enough Aeros.</p>
        )}
        {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-2 rounded-md border border-border p-3">
      <input type="hidden" name="listingId" value={listingId} />
      <p className="text-sm">
        Buy <span className="font-medium">{companyName}</span> for{" "}
        {price.toLocaleString()} {CURRENCY_NAME}? This pays the seller from your personal wallet
        and transfers ownership to you. The company keeps its own balance.
      </p>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-secondary flex-1 text-sm"
          onClick={() => setConfirming(false)}
          disabled={pending}
        >
          Back
        </button>
        <button type="submit" className="btn btn-primary flex-1 text-sm" disabled={pending}>
          {pending ? "Purchasing…" : "Confirm purchase"}
        </button>
      </div>
    </form>
  );
}

/** Hides a listing for this viewer only — it stays live for everyone else. */
export function DismissListingButton({ listingId }: { listingId: string }) {
  const [state, formAction, pending] = useActionState(dismissListingAction, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="listingId" value={listingId} />
      <button type="submit" className="btn btn-secondary text-sm" disabled={pending}>
        {pending ? "Hiding…" : "Not interested"}
      </button>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
    </form>
  );
}

export function UndismissListingButton({ listingId }: { listingId: string }) {
  const [, formAction, pending] = useActionState(undismissListingAction, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="listingId" value={listingId} />
      <button type="submit" className="btn btn-secondary text-sm" disabled={pending}>
        Show again
      </button>
    </form>
  );
}

export function MakeOfferForm({ companyId }: { companyId: string }) {
  const [state, formAction, pending] = useActionState(makeOfferAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn btn-secondary text-sm" onClick={() => setOpen(true)}>
        Make an offer
      </button>
    );
  }

  return (
    <form action={formAction} className="space-y-3 rounded-md border border-border p-3">
      <input type="hidden" name="companyId" value={companyId} />
      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor={`offer-${companyId}`}>
          Your offer ({CURRENCY_NAME})
        </label>
        <input id={`offer-${companyId}`} name="amount" type="number" min={1} className="input" required />
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor={`msg-${companyId}`}>
          Message (optional)
        </label>
        <textarea id={`msg-${companyId}`} name="message" className="input" rows={2} maxLength={500} />
      </div>
      <p className="text-xs text-muted">
        The owner has to accept before anything moves. Nothing is charged until then.
      </p>
      <Feedback state={state} successText="Offer sent to the owner." />
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-secondary flex-1 text-sm"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
        <button type="submit" className="btn btn-primary flex-1 text-sm" disabled={pending}>
          {pending ? "Sending…" : "Send offer"}
        </button>
      </div>
    </form>
  );
}

export function RespondToOfferForm({
  offerId,
  amount,
  fromLabel,
}: {
  offerId: string;
  amount: number;
  fromLabel: string;
}) {
  const [state, formAction, pending] = useActionState(respondToOfferAction, null);

  return (
    <div className="space-y-2">
      <p className="text-sm">
        {fromLabel} offered{" "}
        <span className="font-medium">
          {amount.toLocaleString()} {CURRENCY_NAME}
        </span>
        . Accepting transfers ownership and pays you immediately.
      </p>
      <div className="flex flex-wrap gap-2">
        <form action={formAction}>
          <input type="hidden" name="offerId" value={offerId} />
          <input type="hidden" name="accept" value="yes" />
          <button type="submit" className="btn btn-primary text-sm" disabled={pending}>
            Accept offer
          </button>
        </form>
        <form action={formAction}>
          <input type="hidden" name="offerId" value={offerId} />
          <input type="hidden" name="accept" value="no" />
          <button type="submit" className="btn btn-secondary text-sm" disabled={pending}>
            Decline
          </button>
        </form>
      </div>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loans (company side)
// ---------------------------------------------------------------------------

export function ApplyForLoanForm({
  companyId,
  minAmount,
  maxAmount,
  interestPercent,
  instalmentCount,
  intervalDays,
  eligible,
  reasons,
}: {
  companyId: string;
  minAmount: number;
  maxAmount: number;
  interestPercent: number;
  instalmentCount: number;
  intervalDays: number;
  eligible: boolean;
  reasons: string[];
}) {
  const [state, formAction, pending] = useActionState(applyForLoanAction, null);
  const [amount, setAmount] = useState<number | "">("");

  const principal = typeof amount === "number" ? amount : 0;
  const totalInterest = Math.floor((principal * interestPercent * 100) / 10000);
  const perInstalmentPrincipal = instalmentCount ? Math.floor(principal / instalmentCount) : 0;
  const perInstalmentInterest = instalmentCount ? Math.floor(totalInterest / instalmentCount) : 0;

  return (
    <form action={formAction} className="card space-y-4 p-6">
      <input type="hidden" name="companyId" value={companyId} />

      <div>
        <h3 className="font-medium">Apply for a Government loan</h3>
        <p className="mt-1 text-sm text-muted">
          {interestPercent.toFixed(2)}% interest · {instalmentCount} instalments ·{" "}
          {intervalDays} days apart · {minAmount.toLocaleString()}–
          {maxAmount.toLocaleString()} {CURRENCY_NAME}
        </p>
      </div>

      {!eligible && (
        <ul className="space-y-1 text-sm text-danger">
          {reasons.map((r) => (
            <li key={r}>• {r}</li>
          ))}
        </ul>
      )}

      <div>
        <label htmlFor="loanAmount" className="mb-1 block text-sm font-medium">
          Amount ({CURRENCY_NAME})
        </label>
        <input
          id="loanAmount"
          name="amount"
          type="number"
          className="input"
          min={minAmount}
          max={maxAmount}
          step={1}
          required
          value={amount}
          onChange={(e) =>
            setAmount(e.target.value === "" ? "" : Math.floor(Number(e.target.value)))
          }
        />
      </div>

      {principal > 0 && (
        <div className="rounded-md bg-surface p-3 text-sm">
          <p className="font-medium">If approved on the current terms</p>
          <dl className="mt-2 space-y-1">
            <div className="flex justify-between">
              <dt className="text-muted">Interest</dt>
              <dd>
                {totalInterest.toLocaleString()} {CURRENCY_NAME}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Total payable</dt>
              <dd>
                {(principal + totalInterest).toLocaleString()} {CURRENCY_NAME}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Each instalment</dt>
              <dd>
                ≈ {(perInstalmentPrincipal + perInstalmentInterest).toLocaleString()}{" "}
                {CURRENCY_NAME}
              </dd>
            </div>
          </dl>
        </div>
      )}

      <div>
        <label htmlFor="purpose" className="mb-1 block text-sm font-medium">
          What is the loan for?
        </label>
        <textarea id="purpose" name="purpose" className="input" rows={3} required maxLength={1000} />
      </div>

      <Feedback state={state} successText="Loan application submitted for Government review." />

      <button type="submit" className="btn btn-primary" disabled={pending || !eligible}>
        {pending ? "Submitting…" : "Submit application"}
      </button>
    </form>
  );
}

export function AcceptLoanButton({ loanId, amount }: { loanId: string; amount: number }) {
  const [state, formAction, pending] = useActionState(acceptLoanAction, null);
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="loanId" value={loanId} />
      <button type="submit" className="btn btn-primary text-sm" disabled={pending}>
        {pending
          ? "Accepting…"
          : `Accept and receive ${amount.toLocaleString()} ${CURRENCY_NAME}`}
      </button>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
    </form>
  );
}

export function CancelLoanButton({ loanId }: { loanId: string }) {
  const [state, formAction, pending] = useActionState(cancelLoanAction, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="loanId" value={loanId} />
      <button type="submit" className="btn btn-secondary text-sm" disabled={pending}>
        {pending ? "Cancelling…" : "Withdraw application"}
      </button>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
    </form>
  );
}

export function PayInstalmentButton({
  instalmentId,
  amount,
  canAfford,
}: {
  instalmentId: string;
  amount: number;
  canAfford: boolean;
}) {
  const [state, formAction, pending] = useActionState(payInstalmentAction, null);
  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="instalmentId" value={instalmentId} />
      <button type="submit" className="btn btn-primary text-sm" disabled={pending || !canAfford}>
        {pending ? "Paying…" : `Pay ${amount.toLocaleString()} ${CURRENCY_NAME}`}
      </button>
      {!canAfford && (
        <p className="text-xs text-danger">The company wallet does not hold enough Aeros.</p>
      )}
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// IP complaint
// ---------------------------------------------------------------------------

export function IpComplaintForm() {
  const [state, formAction, pending] = useActionState(submitIpComplaintAction, null);

  return (
    <form action={formAction} className="card space-y-4 p-6">
      <div>
        <h3 className="font-medium">File an IP / copyright complaint</h3>
        <p className="mt-1 text-sm text-muted">
          The Government reviews every complaint individually. Sales figures are context only —
          they never decide the outcome on their own.
        </p>
      </div>

      <div>
        <label htmlFor="accused" className="mb-1 block text-sm font-medium">
          Company username you are reporting
        </label>
        <input id="accused" name="accusedCompanyUsername" className="input" required maxLength={24} />
      </div>

      <div>
        <label htmlFor="ipReason" className="mb-1 block text-sm font-medium">
          Short reason
        </label>
        <input
          id="ipReason"
          name="reason"
          className="input"
          required
          maxLength={160}
          placeholder="e.g. Copied our branding and product descriptions"
        />
      </div>

      <div>
        <label htmlFor="ipDescription" className="mb-1 block text-sm font-medium">
          What happened?
        </label>
        <textarea id="ipDescription" name="description" className="input" rows={4} required maxLength={2000} />
      </div>

      <div>
        <label htmlFor="ipEvidence" className="mb-1 block text-sm font-medium">
          Your evidence
        </label>
        <textarea id="ipEvidence" name="evidence" className="input" rows={4} required maxLength={2000} />
      </div>

      <div>
        <label htmlFor="ipReference" className="mb-1 block text-sm font-medium">
          Reference material (optional)
        </label>
        <textarea id="ipReference" name="referenceMaterial" className="input" rows={2} maxLength={2000} />
      </div>

      <Feedback state={state} successText="Complaint submitted for Government review." />

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Submitting…" : "Submit complaint"}
      </button>
    </form>
  );
}
