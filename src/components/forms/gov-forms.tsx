"use client";

import { useActionState, useState } from "react";
import {
  adjustCompanyBalanceAction,
  approveCompanyAction,
  approveLoanAction,
  archiveAuditAction,
  banUserAction,
  clearUpdatesAction,
  decideIpComplaintAction,
  editCompanyAction,
  governmentOfferAction,
  governmentPaymentAction,
  loanActionAction,
  rejectCompanyAction,
  rejectLoanAction,
  resetUserPasswordAction,
  runCleanupAction,
  setCompanyDefaultTaxAction,
  setCompanyStatusAction,
  setCompanyTaxAction,
  setLoanPolicyAction,
  setRetentionAction,
  setSalePolicyAction,
  suspendUserUntilAction,
  unarchiveAuditAction,
} from "@/actions/government";
import { CURRENCY_NAME, MAINTENANCE_CONFIRM_PHRASE } from "@/lib/constants";

function Err({ state }: { state: { ok: boolean; error?: string } | null }) {
  if (!state || state.ok) return null;
  return (
    <p className="text-sm text-danger" role="alert">
      {state.error}
    </p>
  );
}

function Ok({ state, text }: { state: { ok: boolean } | null; text: string }) {
  if (!state?.ok) return null;
  return <p className="text-sm text-success">{text}</p>;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Timed suspension with an exact end date and time (spec §8). */
export function TimedSuspendForm({ userId }: { userId: string }) {
  const [state, formAction, pending] = useActionState(suspendUserUntilAction, null);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="userId" value={userId} />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="untilDate" className="mb-1 block text-sm font-medium">
            Suspend until — date
          </label>
          <input id="untilDate" name="untilDate" type="date" className="input" required />
        </div>
        <div>
          <label htmlFor="untilTime" className="mb-1 block text-sm font-medium">
            Time
          </label>
          <input id="untilTime" name="untilTime" type="time" className="input" required />
        </div>
      </div>
      <div>
        <label htmlFor="suspendReason" className="mb-1 block text-sm font-medium">
          Reason
        </label>
        <input id="suspendReason" name="reason" className="input" required maxLength={500} />
      </div>
      <p className="text-xs text-muted">
        The account becomes active again by itself once this moment passes. They can still log in
        and receive Aeros while suspended, but cannot send.
      </p>
      <Err state={state} />
      <Ok state={state} text="Suspension applied." />
      <button type="submit" className="btn btn-danger text-sm" disabled={pending}>
        {pending ? "Applying…" : "Suspend until this time"}
      </button>
    </form>
  );
}

/** Permanent ban — requires typing the username to confirm (spec §9). */
export function BanUserForm({ userId, username }: { userId: string; username: string }) {
  const [state, formAction, pending] = useActionState(banUserAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn btn-danger text-sm" onClick={() => setOpen(true)}>
        Permanently ban…
      </button>
    );
  }

  return (
    <form action={formAction} className="space-y-3 rounded-md border border-[#e3b3ae] p-3">
      <input type="hidden" name="userId" value={userId} />
      <p className="text-sm font-medium text-danger">Permanent ban</p>
      <p className="text-xs text-muted">
        Blocks login, sending and receiving. The account, its balance and its full history are
        kept — nothing is deleted. This can be undone with Restore.
      </p>
      <div>
        <label htmlFor="banReason" className="mb-1 block text-sm font-medium">
          Reason
        </label>
        <input id="banReason" name="reason" className="input" required maxLength={500} />
      </div>
      <div>
        <label htmlFor="banConfirm" className="mb-1 block text-sm font-medium">
          Type <span className="font-mono">{username}</span> to confirm
        </label>
        <input id="banConfirm" name="confirm" className="input" required autoComplete="off" />
      </div>
      <Err state={state} />
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-secondary flex-1 text-sm"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
        <button type="submit" className="btn btn-danger flex-1 text-sm" disabled={pending}>
          {pending ? "Banning…" : "Confirm ban"}
        </button>
      </div>
    </form>
  );
}

/**
 * Password reset. The Government never sees the original password — it is
 * stored only as an irreversible hash. This issues a new temporary one and
 * signs the user out everywhere.
 */
export function ResetPasswordForm({ userId }: { userId: string }) {
  const [state, formAction, pending] = useActionState(resetUserPasswordAction, null);

  if (state?.ok) {
    return (
      <div className="rounded-md border border-border p-3">
        <p className="text-sm font-medium">Temporary password set</p>
        <p className="mt-2 break-all rounded bg-surface p-2 font-mono text-sm">
          {state.data.temporaryPassword}
        </p>
        <p className="mt-2 text-xs text-muted">
          Shown once. Give it to the user directly — they will be asked to change it. All of
          their existing sessions have been signed out.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="userId" value={userId} />
      <p className="text-xs text-muted">
        Passwords are stored as irreversible hashes, so they can never be revealed — only reset.
      </p>
      <div>
        <label htmlFor="resetReason" className="mb-1 block text-sm font-medium">
          Reason
        </label>
        <input id="resetReason" name="reason" className="input" required maxLength={500} />
      </div>
      <Err state={state} />
      <button type="submit" className="btn btn-secondary text-sm" disabled={pending}>
        {pending ? "Resetting…" : "Reset password"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Treasury payments
// ---------------------------------------------------------------------------

export function GovernmentPaymentForm() {
  const [state, formAction, pending] = useActionState(governmentPaymentAction, null);

  return (
    <form action={formAction} className="card space-y-4 p-6">
      <div>
        <h3 className="font-medium">Send Aeros from the treasury</h3>
        <p className="mt-1 text-sm text-muted">
          Pays any user or company by username. Tax-free, and never creates new supply.
        </p>
      </div>
      <div>
        <label htmlFor="govPayTo" className="mb-1 block text-sm font-medium">
          Recipient username
        </label>
        <input id="govPayTo" name="recipientUsername" className="input" required maxLength={32} />
      </div>
      <div>
        <label htmlFor="govPayAmount" className="mb-1 block text-sm font-medium">
          Amount ({CURRENCY_NAME})
        </label>
        <input id="govPayAmount" name="amount" type="number" min={1} step={1} className="input" required />
      </div>
      <div>
        <label htmlFor="govPayReason" className="mb-1 block text-sm font-medium">
          Reason
        </label>
        <input id="govPayReason" name="reason" className="input" required maxLength={500} />
      </div>
      <Err state={state} />
      {state?.ok && (
        <p className="text-sm text-success">Payment sent. Ref {state.data.txRef}</p>
      )}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Sending…" : "Send payment"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export function CompanyReviewActions({
  companyId,
  fundingAmount,
}: {
  companyId: string;
  fundingAmount: number;
}) {
  const [approveState, approveAction, approving] = useActionState(approveCompanyAction, null);
  const [rejectState, rejectAction, rejecting] = useActionState(rejectCompanyAction, null);
  const [showReject, setShowReject] = useState(false);

  return (
    <div className="space-y-3">
      <form action={approveAction}>
        <input type="hidden" name="companyId" value={companyId} />
        <button type="submit" className="btn btn-primary text-sm" disabled={approving}>
          {approving
            ? "Approving…"
            : `Approve and fund ${fundingAmount.toLocaleString()} ${CURRENCY_NAME}`}
        </button>
      </form>
      <Err state={approveState} />

      {!showReject ? (
        <button
          type="button"
          className="btn btn-danger text-sm"
          onClick={() => setShowReject(true)}
        >
          Reject…
        </button>
      ) : (
        <form action={rejectAction} className="space-y-2 rounded-md border border-border p-3">
          <input type="hidden" name="companyId" value={companyId} />
          <label htmlFor="rejectReason" className="block text-sm font-medium">
            Rejection reason
          </label>
          <input id="rejectReason" name="reason" className="input" required maxLength={500} />
          <Err state={rejectState} />
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-secondary flex-1 text-sm"
              onClick={() => setShowReject(false)}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-danger flex-1 text-sm" disabled={rejecting}>
              {rejecting ? "Rejecting…" : "Confirm rejection"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export function EditCompanyForm({
  companyId,
  name,
  username,
  category,
  description,
}: {
  companyId: string;
  name: string;
  username: string;
  category: string;
  description: string;
}) {
  const [state, formAction, pending] = useActionState(editCompanyAction, null);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="companyId" value={companyId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="ecName" className="mb-1 block text-sm font-medium">
            Name
          </label>
          <input id="ecName" name="name" className="input" defaultValue={name} required maxLength={80} />
        </div>
        <div>
          <label htmlFor="ecUsername" className="mb-1 block text-sm font-medium">
            Username
          </label>
          <input
            id="ecUsername"
            name="username"
            className="input"
            defaultValue={username}
            required
            maxLength={24}
          />
        </div>
      </div>
      <div>
        <label htmlFor="ecCategory" className="mb-1 block text-sm font-medium">
          Category
        </label>
        <input
          id="ecCategory"
          name="category"
          className="input"
          defaultValue={category}
          required
          maxLength={60}
        />
      </div>
      <div>
        <label htmlFor="ecDescription" className="mb-1 block text-sm font-medium">
          Description
        </label>
        <textarea
          id="ecDescription"
          name="description"
          className="input"
          rows={5}
          defaultValue={description}
          required
        />
      </div>
      <Err state={state} />
      <Ok state={state} text="Company updated." />
      <button type="submit" className="btn btn-secondary text-sm" disabled={pending}>
        {pending ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}

export function CompanyStatusActions({
  companyId,
  status,
}: {
  companyId: string;
  status: string;
}) {
  const [state, formAction, pending] = useActionState(setCompanyStatusAction, null);
  const [showSuspend, setShowSuspend] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {status !== "APPROVED" && (
          <form action={formAction}>
            <input type="hidden" name="companyId" value={companyId} />
            <input type="hidden" name="status" value="APPROVED" />
            <button type="submit" className="btn btn-secondary text-sm" disabled={pending}>
              Restore to active
            </button>
          </form>
        )}
        {status === "APPROVED" && (
          <button
            type="button"
            className="btn btn-danger text-sm"
            onClick={() => setShowSuspend((v) => !v)}
          >
            Suspend…
          </button>
        )}
        {status !== "REVOKED" && (
          <form action={formAction}>
            <input type="hidden" name="companyId" value={companyId} />
            <input type="hidden" name="status" value="REVOKED" />
            <input type="hidden" name="reason" value="Revoked by Government" />
            <button type="submit" className="btn btn-danger text-sm" disabled={pending}>
              Revoke
            </button>
          </form>
        )}
      </div>

      {showSuspend && (
        <form action={formAction} className="space-y-2 rounded-md border border-border p-3">
          <input type="hidden" name="companyId" value={companyId} />
          <input type="hidden" name="status" value="SUSPENDED" />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="csDate" className="mb-1 block text-xs font-medium">
                Until date (optional)
              </label>
              <input id="csDate" name="suspendUntilDate" type="date" className="input" />
            </div>
            <div>
              <label htmlFor="csTime" className="mb-1 block text-xs font-medium">
                Time
              </label>
              <input id="csTime" name="suspendUntilTime" type="time" className="input" />
            </div>
          </div>
          <input name="reason" className="input" placeholder="Reason" maxLength={500} />
          <p className="text-xs text-muted">
            Leave the date blank to suspend indefinitely. Suspending the company does not touch
            the owner&apos;s personal account.
          </p>
          <button type="submit" className="btn btn-danger text-sm" disabled={pending}>
            {pending ? "Suspending…" : "Suspend company"}
          </button>
        </form>
      )}
      <Err state={state} />
    </div>
  );
}

export function CompanyTaxForm({
  companyId,
  currentPercent,
  defaultPercent,
}: {
  companyId: string;
  currentPercent: number | null;
  defaultPercent: number;
}) {
  const [state, formAction, pending] = useActionState(setCompanyTaxAction, null);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="companyId" value={companyId} />
      <label htmlFor="ctRate" className="block text-sm font-medium">
        Company tax rate (%)
      </label>
      <input
        id="ctRate"
        name="taxRatePercent"
        className="input"
        defaultValue={currentPercent === null ? "" : currentPercent.toFixed(2)}
        placeholder={`Leave blank for the default (${defaultPercent.toFixed(2)}%)`}
      />
      <p className="text-xs text-muted">
        Changing this never alters tax already charged on past transactions.
      </p>
      <Err state={state} />
      <Ok state={state} text="Company tax rate updated." />
      <button type="submit" className="btn btn-secondary text-sm" disabled={pending}>
        {pending ? "Saving…" : "Save rate"}
      </button>
    </form>
  );
}

export function CompanyDefaultTaxForm({ currentPercent }: { currentPercent: number }) {
  const [state, formAction, pending] = useActionState(setCompanyDefaultTaxAction, null);
  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor="cdRate" className="mb-1 block text-sm font-medium">
          Default company tax rate (%)
        </label>
        <input
          id="cdRate"
          name="taxRatePercent"
          type="number"
          min={0}
          max={100}
          step={0.01}
          className="input"
          defaultValue={currentPercent}
          required
        />
      </div>
      <Err state={state} />
      <Ok state={state} text="Default company tax updated." />
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Saving…" : "Update company tax"}
      </button>
    </form>
  );
}

export function AdjustCompanyBalanceForm({ companyId }: { companyId: string }) {
  const [direction, setDirection] = useState<"CREDIT" | "DEBIT">("CREDIT");
  const [state, formAction, pending] = useActionState(adjustCompanyBalanceAction, null);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="companyId" value={companyId} />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setDirection("CREDIT")}
          className={direction === "CREDIT" ? "btn btn-primary" : "btn btn-secondary"}
        >
          Credit
        </button>
        <button
          type="button"
          onClick={() => setDirection("DEBIT")}
          className={direction === "DEBIT" ? "btn btn-primary" : "btn btn-secondary"}
        >
          Debit
        </button>
      </div>
      <input type="hidden" name="direction" value={direction} />
      <div>
        <label htmlFor="acbAmount" className="mb-1 block text-sm font-medium">
          Amount
        </label>
        <input id="acbAmount" name="amount" type="number" min={1} step={1} className="input" required />
      </div>
      <div>
        <label htmlFor="acbReason" className="mb-1 block text-sm font-medium">
          Reason (required)
        </label>
        <textarea id="acbReason" name="reason" className="input" rows={2} required maxLength={500} />
      </div>
      <p className="text-xs text-muted">
        Moves Aeros to or from the treasury, so total supply never changes.
      </p>
      <Err state={state} />
      <Ok state={state} text="Adjustment applied." />
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Applying…" : "Apply adjustment"}
      </button>
    </form>
  );
}

export function GovernmentOfferForm({ companyId }: { companyId: string }) {
  const [state, formAction, pending] = useActionState(governmentOfferAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn btn-secondary text-sm" onClick={() => setOpen(true)}>
        Offer to buy this company
      </button>
    );
  }

  return (
    <form action={formAction} className="space-y-3 rounded-md border border-border p-3">
      <input type="hidden" name="companyId" value={companyId} />
      <p className="text-sm font-medium">Government offer</p>
      <p className="text-xs text-muted">
        The owner must accept. Nothing is transferred and no Aeros moves unless they do.
      </p>
      <div>
        <label htmlFor="goAmount" className="mb-1 block text-sm font-medium">
          Offer amount ({CURRENCY_NAME})
        </label>
        <input id="goAmount" name="amount" type="number" min={1} className="input" required />
      </div>
      <div>
        <label htmlFor="goMessage" className="mb-1 block text-sm font-medium">
          Message (optional)
        </label>
        <textarea id="goMessage" name="message" className="input" rows={2} maxLength={500} />
      </div>
      <Err state={state} />
      <Ok state={state} text="Offer sent to the owner." />
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

export function SalePolicyForm({
  multiplier,
  minAgeDays,
}: {
  multiplier: number;
  minAgeDays: number;
}) {
  const [state, formAction, pending] = useActionState(setSalePolicyAction, null);

  return (
    <form action={formAction} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="spMultiplier" className="mb-1 block text-sm font-medium">
            Valuation multiplier (× lifetime sales)
          </label>
          <input
            id="spMultiplier"
            name="multiplier"
            type="number"
            min={0}
            max={100}
            step={0.01}
            className="input"
            defaultValue={multiplier}
            required
          />
        </div>
        <div>
          <label htmlFor="spAge" className="mb-1 block text-sm font-medium">
            Minimum age before listing (days)
          </label>
          <input
            id="spAge"
            name="minAgeDays"
            type="number"
            min={0}
            max={365}
            step={1}
            className="input"
            defaultValue={minAgeDays}
            required
          />
        </div>
      </div>
      <p className="text-xs text-muted">
        Applies to new listings only — existing listings keep the price they were created with.
      </p>
      <Err state={state} />
      <Ok state={state} text="Sale policy updated." />
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Saving…" : "Save sale policy"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------

export function LoanPolicyForm({
  policy,
}: {
  policy: {
    loansEnabled: boolean;
    interestRateBp: number;
    minAmount: number;
    maxAmount: number;
    instalmentCount: number;
    instalmentIntervalDays: number;
    minCompanyAgeDays: number;
    minCompanySales: number;
    defaultGraceDays: number;
  };
}) {
  const [state, formAction, pending] = useActionState(setLoanPolicyAction, null);
  const [enabled, setEnabled] = useState(policy.loansEnabled);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="loansEnabled" value={enabled ? "1" : "0"} />
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={enabled ? "btn btn-primary text-sm" : "btn btn-secondary text-sm"}
          onClick={() => setEnabled(true)}
        >
          Lending open
        </button>
        <button
          type="button"
          className={!enabled ? "btn btn-primary text-sm" : "btn btn-secondary text-sm"}
          onClick={() => setEnabled(false)}
        >
          Lending closed
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Interest rate (%)" name="interestRatePercent" defaultValue={policy.interestRateBp / 100} step={0.01} />
        <Field label="Instalments" name="instalmentCount" defaultValue={policy.instalmentCount} />
        <Field label="Days between instalments" name="instalmentIntervalDays" defaultValue={policy.instalmentIntervalDays} />
        <Field label={`Minimum loan (${CURRENCY_NAME})`} name="minAmount" defaultValue={policy.minAmount} />
        <Field label={`Maximum loan (${CURRENCY_NAME})`} name="maxAmount" defaultValue={policy.maxAmount} />
        <Field label="Grace days before default" name="defaultGraceDays" defaultValue={policy.defaultGraceDays} />
        <Field label="Min. company age (days)" name="minCompanyAgeDays" defaultValue={policy.minCompanyAgeDays} />
        <Field label={`Min. lifetime sales (${CURRENCY_NAME})`} name="minCompanySales" defaultValue={policy.minCompanySales} />
      </div>

      <p className="text-xs text-muted">
        Loans already approved keep the terms they were agreed on — changing this only affects
        new applications.
      </p>
      <Err state={state} />
      <Ok state={state} text="Loan policy updated." />
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Saving…" : "Save loan policy"}
      </button>
    </form>
  );
}

function Field({
  label,
  name,
  defaultValue,
  step = 1,
}: {
  label: string;
  name: string;
  defaultValue: number;
  step?: number;
}) {
  return (
    <div>
      <label htmlFor={`lp-${name}`} className="mb-1 block text-xs font-medium">
        {label}
      </label>
      <input
        id={`lp-${name}`}
        name={name}
        type="number"
        min={0}
        step={step}
        className="input"
        defaultValue={defaultValue}
        required
      />
    </div>
  );
}

export function LoanReviewActions({
  loanId,
  requestedAmount,
  defaultRatePercent,
  defaultCount,
  defaultInterval,
}: {
  loanId: string;
  requestedAmount: number;
  defaultRatePercent: number;
  defaultCount: number;
  defaultInterval: number;
}) {
  const [approveState, approveAction, approving] = useActionState(approveLoanAction, null);
  const [rejectState, rejectAction, rejecting] = useActionState(rejectLoanAction, null);
  const [showReject, setShowReject] = useState(false);

  return (
    <div className="space-y-4">
      <form action={approveAction} className="space-y-3 rounded-md border border-border p-3">
        <input type="hidden" name="loanId" value={loanId} />
        <p className="text-sm font-medium">Approve with these terms</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="laAmount" className="mb-1 block text-xs font-medium">
              Amount ({CURRENCY_NAME})
            </label>
            <input
              id="laAmount"
              name="approvedAmount"
              type="number"
              min={1}
              className="input"
              defaultValue={requestedAmount}
            />
          </div>
          <div>
            <label htmlFor="laRate" className="mb-1 block text-xs font-medium">
              Interest (%)
            </label>
            <input
              id="laRate"
              name="interestRatePercent"
              type="number"
              min={0}
              step={0.01}
              className="input"
              defaultValue={defaultRatePercent}
            />
          </div>
          <div>
            <label htmlFor="laCount" className="mb-1 block text-xs font-medium">
              Instalments
            </label>
            <input
              id="laCount"
              name="instalmentCount"
              type="number"
              min={1}
              className="input"
              defaultValue={defaultCount}
            />
          </div>
          <div>
            <label htmlFor="laInterval" className="mb-1 block text-xs font-medium">
              Days apart
            </label>
            <input
              id="laInterval"
              name="instalmentIntervalDays"
              type="number"
              min={1}
              className="input"
              defaultValue={defaultInterval}
            />
          </div>
        </div>
        <p className="text-xs text-muted">
          Approving reserves nothing yet — the company must accept, and only then is the
          principal paid out of the treasury.
        </p>
        <Err state={approveState} />
        <button type="submit" className="btn btn-primary text-sm" disabled={approving}>
          {approving ? "Approving…" : "Approve loan"}
        </button>
      </form>

      {!showReject ? (
        <button type="button" className="btn btn-danger text-sm" onClick={() => setShowReject(true)}>
          Reject application…
        </button>
      ) : (
        <form action={rejectAction} className="space-y-2 rounded-md border border-border p-3">
          <input type="hidden" name="loanId" value={loanId} />
          <label htmlFor="lrReason" className="block text-sm font-medium">
            Reason
          </label>
          <input id="lrReason" name="reason" className="input" required maxLength={1000} />
          <Err state={rejectState} />
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-secondary flex-1 text-sm"
              onClick={() => setShowReject(false)}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-danger flex-1 text-sm" disabled={rejecting}>
              {rejecting ? "Rejecting…" : "Confirm rejection"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

const LOAN_ACTIONS = [
  { value: "WARNING", label: "Issue warning" },
  { value: "DEMAND", label: "Formal demand" },
  { value: "RESTRICTION", label: "Apply restriction" },
  { value: "RESTRUCTURE", label: "Restructure schedule" },
  { value: "DEFAULT", label: "Declare default" },
  { value: "SUSPENSION", label: "Suspend loan activity" },
  { value: "CLEARED", label: "Clear action" },
];

export function LoanActionForm({ loanId }: { loanId: string }) {
  const [state, formAction, pending] = useActionState(loanActionAction, null);
  const [action, setAction] = useState("WARNING");

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="loanId" value={loanId} />
      <div>
        <label htmlFor="laAction" className="mb-1 block text-sm font-medium">
          Action
        </label>
        <select
          id="laAction"
          name="action"
          className="input"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        >
          {LOAN_ACTIONS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </div>

      {action === "RESTRUCTURE" && (
        <div>
          <label htmlFor="laRestructure" className="mb-1 block text-sm font-medium">
            New interval between remaining instalments (days)
          </label>
          <input
            id="laRestructure"
            name="restructureIntervalDays"
            type="number"
            min={1}
            className="input"
            placeholder="Leave blank to keep the original interval"
          />
        </div>
      )}

      <div>
        <label htmlFor="laReason" className="mb-1 block text-sm font-medium">
          Written reason (required)
        </label>
        <textarea id="laReason" name="reason" className="input" rows={3} required maxLength={1000} />
      </div>

      <p className="text-xs text-muted">
        Every action is recorded in the audit log and the company is notified. No action here
        seizes the company wallet or transfers ownership.
      </p>
      <Err state={state} />
      <Ok state={state} text="Action recorded." />
      <button type="submit" className="btn btn-danger text-sm" disabled={pending}>
        {pending ? "Recording…" : "Record action"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// IP decisions
// ---------------------------------------------------------------------------

const IP_DECISIONS = [
  { value: "DISMISSED", label: "Dismiss complaint" },
  { value: "WARNING", label: "Warning" },
  { value: "STRIKE", label: "Strike" },
  { value: "SECOND_STRIKE", label: "Second strike" },
  { value: "TEMPORARY_SUSPENSION", label: "Temporary suspension" },
  { value: "PERMANENT_REVOCATION", label: "Permanent revocation" },
];

export function IpDecisionForm({ complaintId }: { complaintId: string }) {
  const [state, formAction, pending] = useActionState(decideIpComplaintAction, null);
  const [decision, setDecision] = useState("DISMISSED");

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="complaintId" value={complaintId} />
      <div>
        <label htmlFor="ipDecision" className="mb-1 block text-sm font-medium">
          Decision
        </label>
        <select
          id="ipDecision"
          name="decision"
          className="input"
          value={decision}
          onChange={(e) => setDecision(e.target.value)}
        >
          {IP_DECISIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      {decision === "TEMPORARY_SUSPENSION" && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="ipDate" className="mb-1 block text-xs font-medium">
              Suspend until — date
            </label>
            <input id="ipDate" name="suspendUntilDate" type="date" className="input" />
          </div>
          <div>
            <label htmlFor="ipTime" className="mb-1 block text-xs font-medium">
              Time
            </label>
            <input id="ipTime" name="suspendUntilTime" type="time" className="input" />
          </div>
        </div>
      )}

      <div>
        <label htmlFor="ipDecisionReason" className="mb-1 block text-sm font-medium">
          Written reason (required)
        </label>
        <textarea
          id="ipDecisionReason"
          name="reason"
          className="input"
          rows={4}
          required
          maxLength={1000}
        />
      </div>

      <p className="text-xs text-muted">
        Base the decision on the complaint and its evidence. Sales and activity figures are
        context only — there is deliberately no rule that the busier company wins.
      </p>
      <Err state={state} />
      <Ok state={state} text="Decision recorded." />
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Recording…" : "Record decision"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Retention & maintenance
// ---------------------------------------------------------------------------

export function RetentionSettingsForm({
  updatesDays,
  notificationsDays,
  supportDays,
}: {
  updatesDays: number | null;
  notificationsDays: number | null;
  supportDays: number | null;
}) {
  const [state, formAction, pending] = useActionState(setRetentionAction, null);

  return (
    <form action={formAction} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="rtUpdates" className="mb-1 block text-sm font-medium">
            Updates (days)
          </label>
          <input
            id="rtUpdates"
            name="updatesRetentionDays"
            className="input"
            defaultValue={updatesDays ?? ""}
            placeholder="Keep forever"
          />
        </div>
        <div>
          <label htmlFor="rtNotifications" className="mb-1 block text-sm font-medium">
            Notifications (days)
          </label>
          <input
            id="rtNotifications"
            name="notificationsRetentionDays"
            className="input"
            defaultValue={notificationsDays ?? ""}
            placeholder="Keep forever"
          />
        </div>
        <div>
          <label htmlFor="rtSupport" className="mb-1 block text-sm font-medium">
            Support messages (days)
          </label>
          <input
            id="rtSupport"
            name="supportRetentionDays"
            className="input"
            defaultValue={supportDays ?? ""}
            placeholder="Keep forever"
          />
        </div>
      </div>
      <p className="text-xs text-muted">
        Leave a field blank to keep that data forever. Transactions, users, companies, invoices
        and loans are never covered by retention — deleting ledger data would corrupt balances
        and supply.
      </p>
      <Err state={state} />
      <Ok state={state} text="Retention settings saved." />
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Saving…" : "Save retention settings"}
      </button>
    </form>
  );
}

export function RunCleanupForm() {
  const [state, formAction, pending] = useActionState(runCleanupAction, null);

  return (
    <form action={formAction} className="space-y-3">
      <label htmlFor="cleanupConfirm" className="block text-sm font-medium">
        Type <span className="font-mono">{MAINTENANCE_CONFIRM_PHRASE}</span> to confirm
      </label>
      <input id="cleanupConfirm" name="confirm" className="input" autoComplete="off" required />
      <Err state={state} />
      {state?.ok && <p className="text-sm text-success">{state.data.summary}</p>}
      <button type="submit" className="btn btn-danger text-sm" disabled={pending}>
        {pending ? "Cleaning…" : "Run cleanup now"}
      </button>
    </form>
  );
}

export function ClearUpdatesForm() {
  const [state, formAction, pending] = useActionState(clearUpdatesAction, null);

  return (
    <form action={formAction} className="space-y-3">
      <label htmlFor="clearConfirm" className="block text-sm font-medium">
        Type <span className="font-mono">{MAINTENANCE_CONFIRM_PHRASE}</span> to clear all updates
      </label>
      <input id="clearConfirm" name="confirm" className="input" autoComplete="off" required />
      <Err state={state} />
      {state?.ok && (
        <p className="text-sm text-success">{state.data.deleted} updates removed.</p>
      )}
      <button type="submit" className="btn btn-danger text-sm" disabled={pending}>
        {pending ? "Clearing…" : "Clear all updates"}
      </button>
    </form>
  );
}

export function ArchiveAuditForm() {
  const [state, formAction, pending] = useActionState(archiveAuditAction, null);
  const [unState, unAction, unPending] = useActionState(unarchiveAuditAction, null);

  return (
    <div className="space-y-4">
      <form action={formAction} className="space-y-3">
        <label htmlFor="archiveDays" className="block text-sm font-medium">
          Archive audit entries older than (days)
        </label>
        <input
          id="archiveDays"
          name="olderThanDays"
          type="number"
          min={1}
          max={3650}
          className="input"
          defaultValue={90}
          required
        />
        <p className="text-xs text-muted">
          Archiving hides entries from the active view. Nothing is deleted — audit rows stay in
          the database permanently and can be restored at any time.
        </p>
        <Err state={state} />
        {state?.ok && (
          <p className="text-sm text-success">{state.data.archived} entries archived.</p>
        )}
        <button type="submit" className="btn btn-secondary text-sm" disabled={pending}>
          {pending ? "Archiving…" : "Archive old entries"}
        </button>
      </form>

      <form action={unAction}>
        <button type="submit" className="btn btn-secondary text-sm" disabled={unPending}>
          {unPending ? "Restoring…" : "Restore all archived entries"}
        </button>
        {unState?.ok && (
          <p className="mt-2 text-sm text-success">{unState.data.restored} entries restored.</p>
        )}
      </form>
    </div>
  );
}
