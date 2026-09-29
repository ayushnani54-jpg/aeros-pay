"use client";

import { useActionState, useState } from "react";
import {
  awardGovernmentContractAction,
  cancelGovernmentContractAction,
  createGovernmentContractAction,
  createOfficialPromotionAction,
  govActivatePromotionAction,
  govCancelPromotionAction,
  payGovernmentContractAction,
  reverseTransactionAction,
  reviewPromotionAction,
  setPromotionPolicyAction,
} from "@/actions/government";
import { CURRENCY_NAME } from "@/lib/constants";

/**
 * Government-side marketplace forms (V3 Phases D and E).
 *
 * Same `.card` / `.input` / `.btn` classes as the rest of the Government panel;
 * no new visual language. As everywhere else, no amount, rate or destination is
 * taken from these forms except the policy numbers the Government is
 * deliberately setting.
 */

export function GovPromotionPolicyForm({
  enabled,
  dailyRate,
}: {
  enabled: boolean;
  dailyRate: number;
}) {
  const [state, formAction, pending] = useActionState(setPromotionPolicyAction, null);

  return (
    <form action={formAction} className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="enabled" defaultChecked={enabled} />
        Allow companies to request the ad slot
      </label>
      <div>
        <label htmlFor="promoRate" className="mb-1 block text-sm font-medium">
          Daily rate ({CURRENCY_NAME} per IST calendar day)
        </label>
        <input
          id="promoRate"
          name="dailyRate"
          type="number"
          min={0}
          step={1}
          className="input"
          defaultValue={dailyRate}
          required
        />
        <p className="mt-1 text-xs text-muted">
          A change applies to campaigns approved from now on. A running campaign keeps the rate it
          was approved at.
        </p>
      </div>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-success">Policy saved.</p>}
      <button type="submit" className="btn btn-primary text-sm" disabled={pending}>
        {pending ? "Saving…" : "Save policy"}
      </button>
    </form>
  );
}

export function GovPromotionActions({
  campaignId,
  status,
  isOfficial,
}: {
  campaignId: string;
  status: string;
  isOfficial: boolean;
}) {
  const [reviewState, reviewAction, reviewPending] = useActionState(reviewPromotionAction, null);
  const [cancelState, cancelAction, cancelPending] = useActionState(
    govCancelPromotionAction,
    null,
  );
  const [activateState, activateAction, activatePending] = useActionState(
    govActivatePromotionAction,
    null,
  );
  const [rejecting, setRejecting] = useState(false);

  return (
    <div className="space-y-2">
      {status === "PENDING" && (
        <form action={reviewAction} className="space-y-2">
          <input type="hidden" name="campaignId" value={campaignId} />
          {rejecting && (
            <input
              name="reason"
              className="input"
              required
              maxLength={500}
              placeholder="Why is this being rejected?"
            />
          )}
          <div className="flex flex-wrap gap-2">
            {!rejecting && (
              <button
                type="submit"
                name="decision"
                value="APPROVE"
                className="btn btn-primary text-xs"
                disabled={reviewPending}
              >
                {reviewPending ? "Working…" : "Approve"}
              </button>
            )}
            {rejecting ? (
              <>
                <button
                  type="button"
                  className="btn btn-secondary text-xs"
                  onClick={() => setRejecting(false)}
                >
                  Back
                </button>
                <button
                  type="submit"
                  name="decision"
                  value="REJECT"
                  className="btn btn-danger text-xs"
                  disabled={reviewPending}
                >
                  {reviewPending ? "Working…" : "Confirm rejection"}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-danger text-xs"
                onClick={() => setRejecting(true)}
              >
                Reject
              </button>
            )}
          </div>
          {reviewState && !reviewState.ok && (
            <p className="text-xs text-danger">{reviewState.error}</p>
          )}
        </form>
      )}

      <div className="flex flex-wrap gap-2">
        {isOfficial && (status === "APPROVED" || status === "PAUSED") && (
          <form action={activateAction}>
            <input type="hidden" name="campaignId" value={campaignId} />
            <button type="submit" className="btn btn-primary text-xs" disabled={activatePending}>
              {activatePending ? "Starting…" : "Start running"}
            </button>
          </form>
        )}
        {["PENDING", "APPROVED", "ACTIVE", "PAUSED"].includes(status) && (
          <form action={cancelAction}>
            <input type="hidden" name="campaignId" value={campaignId} />
            <button type="submit" className="btn btn-danger text-xs" disabled={cancelPending}>
              {cancelPending ? "Cancelling…" : "Cancel campaign"}
            </button>
          </form>
        )}
      </div>
      {activateState && !activateState.ok && (
        <p className="text-xs text-danger">{activateState.error}</p>
      )}
      {cancelState && !cancelState.ok && <p className="text-xs text-danger">{cancelState.error}</p>}
    </div>
  );
}

export function GovOfficialPromotionForm() {
  const [state, formAction, pending] = useActionState(createOfficialPromotionAction, null);

  return (
    <form action={formAction} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="opKind" className="mb-1 block text-sm font-medium">
            Kind
          </label>
          <select id="opKind" name="kind" className="input" required>
            <option value="NEW_PLAYER_BONUS">New Player Bonus</option>
            <option value="GOVERNMENT_DEMAND">Government Demand</option>
            <option value="LIMITED_OPPORTUNITY">Limited Opportunity</option>
          </select>
        </div>
        <div>
          <label htmlFor="opDays" className="mb-1 block text-sm font-medium">
            Days
          </label>
          <input
            id="opDays"
            name="durationDays"
            type="number"
            min={1}
            max={365}
            step={1}
            className="input"
            defaultValue={7}
            required
          />
        </div>
      </div>
      <div>
        <label htmlFor="opHeading" className="mb-1 block text-sm font-medium">
          Heading
        </label>
        <input id="opHeading" name="heading" className="input" required maxLength={160} />
      </div>
      <div>
        <label htmlFor="opDescription" className="mb-1 block text-sm font-medium">
          Short description
        </label>
        <input
          id="opDescription"
          name="shortDescription"
          className="input"
          required
          maxLength={240}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="opCta" className="mb-1 block text-sm font-medium">
            Button label
          </label>
          <input
            id="opCta"
            name="ctaLabel"
            className="input"
            maxLength={48}
            placeholder="Learn more"
          />
        </div>
        <div>
          <label htmlFor="opDestination" className="mb-1 block text-sm font-medium">
            Destination (in-app path)
          </label>
          <input
            id="opDestination"
            name="destination"
            className="input"
            required
            maxLength={200}
            defaultValue="/updates"
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="activate" />
        Start it immediately, if the slot is free
      </label>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-success">Promotion created.</p>}
      <button type="submit" className="btn btn-primary text-sm" disabled={pending}>
        {pending ? "Creating…" : "Create promotion"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export function GovCreateContractForm() {
  const [state, formAction, pending] = useActionState(createGovernmentContractAction, null);

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor="gctTitle" className="mb-1 block text-sm font-medium">
          Title
        </label>
        <input id="gctTitle" name="title" className="input" required maxLength={160} />
      </div>
      <div>
        <label htmlFor="gctRequirement" className="mb-1 block text-sm font-medium">
          Requirement
        </label>
        <textarea
          id="gctRequirement"
          name="requirement"
          className="input"
          rows={2}
          required
          maxLength={2000}
        />
      </div>
      <div>
        <label htmlFor="gctDescription" className="mb-1 block text-sm font-medium">
          Description
        </label>
        <textarea
          id="gctDescription"
          name="description"
          className="input"
          rows={3}
          required
          maxLength={2000}
        />
      </div>
      <div>
        <label htmlFor="gctConditions" className="mb-1 block text-sm font-medium">
          Conditions (optional)
        </label>
        <textarea
          id="gctConditions"
          name="conditions"
          className="input"
          rows={2}
          maxLength={2000}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="gctBudget" className="mb-1 block text-sm font-medium">
            Budget ({CURRENCY_NAME})
          </label>
          <input
            id="gctBudget"
            name="budget"
            type="number"
            min={1}
            step={1}
            className="input"
            required
          />
        </div>
        <div>
          <label htmlFor="gctDeadline" className="mb-1 block text-sm font-medium">
            Deadline (optional)
          </label>
          <input id="gctDeadline" name="deadline" type="date" className="input" />
        </div>
      </div>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-success">Contract published.</p>}
      <button type="submit" className="btn btn-primary text-sm" disabled={pending}>
        {pending ? "Publishing…" : "Publish contract"}
      </button>
    </form>
  );
}

export function GovAwardContractButton({
  contractId,
  applicationId,
}: {
  contractId: string;
  applicationId: string;
}) {
  const [state, formAction, pending] = useActionState(awardGovernmentContractAction, null);
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

export function GovCancelContractButton({ contractId }: { contractId: string }) {
  const [state, formAction, pending] = useActionState(cancelGovernmentContractAction, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="contractId" value={contractId} />
      <button type="submit" className="btn btn-danger text-xs" disabled={pending}>
        {pending ? "Cancelling…" : "Cancel"}
      </button>
      {state && !state.ok && <p className="mt-1 text-xs text-danger">{state.error}</p>}
    </form>
  );
}

export function GovPayContractButton({
  contractId,
  amount,
}: {
  contractId: string;
  amount: number;
}) {
  const [state, formAction, pending] = useActionState(payGovernmentContractAction, null);
  const [confirming, setConfirming] = useState(false);

  if (state?.ok) {
    return (
      <div className="rounded-md border border-border p-3">
        <p className="text-sm text-success">
          Paid {state.data.amount.toLocaleString()} {CURRENCY_NAME} from the Treasury.
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
        Pay the awarded person {amount.toLocaleString()} {CURRENCY_NAME} from the Treasury and
        complete this contract?
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
// Refunds / reversals (spec §18)
// ---------------------------------------------------------------------------

/**
 * Reverse a transaction.
 *
 * The original ledger row is never edited or deleted: the server writes a NEW
 * row linked to it. This form therefore carries no "edit" affordance at all —
 * only an amount (blank for the whole payment) and a mandatory reason.
 */
export function GovReverseTransactionForm({
  transactionId,
  txRef,
  netAmount,
}: {
  transactionId: string;
  txRef: string;
  netAmount: number;
}) {
  const [state, formAction, pending] = useActionState(reverseTransactionAction, null);
  const [open, setOpen] = useState(false);

  if (state?.ok) {
    return (
      <div className="rounded-md border border-border p-3" data-testid="gov-reversal-done">
        <p className="text-sm text-success">
          Reversed — {state.data.refundedToPayer.toLocaleString()} {CURRENCY_NAME} returned to the
          payer.
        </p>
        <p className="mt-1 font-mono text-xs text-muted">
          {txRef} → {state.data.reversalTxRef}
        </p>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-danger text-xs" onClick={() => setOpen(true)}>
        Reverse
      </button>
    );
  }

  return (
    <form action={formAction} className="space-y-2 rounded-md border border-border p-3">
      <input type="hidden" name="transactionId" value={transactionId} />
      <p className="text-xs text-muted">
        A reversal is a new transaction linked to {txRef}. The original row is never changed or
        removed.
      </p>
      <label htmlFor={`gra-${transactionId}`} className="block text-xs text-muted">
        Amount (blank reverses it all, including the tax)
      </label>
      <input
        id={`gra-${transactionId}`}
        name="amount"
        type="number"
        min={1}
        max={netAmount}
        step={1}
        className="input"
        placeholder={`Full reversal (${netAmount.toLocaleString()} + tax)`}
      />
      <label htmlFor={`grr-${transactionId}`} className="block text-xs text-muted">
        Reason
      </label>
      <input id={`grr-${transactionId}`} name="reason" className="input" required maxLength={500} />
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
          {pending ? "Reversing…" : "Confirm reversal"}
        </button>
      </div>
    </form>
  );
}
