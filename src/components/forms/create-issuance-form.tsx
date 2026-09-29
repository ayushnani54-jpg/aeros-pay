"use client";

import { useActionState } from "react";
import { createIssuanceRequestAction } from "@/actions/government";

/** `maxAmount` is the LIVE, Government-configurable value (government.max_issuance_amount),
 * passed down from a server component reading the government row — not a
 * hardcoded constant. */
export function CreateIssuanceForm({ maxAmount }: { maxAmount: number }) {
  const [state, formAction, pending] = useActionState(createIssuanceRequestAction, null);

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor="amount" className="mb-1 block text-sm font-medium">
          Requested amount (max {maxAmount.toLocaleString()})
        </label>
        <input
          id="amount"
          name="amount"
          type="number"
          min={1}
          max={maxAmount}
          step={1}
          className="input"
          required
        />
      </div>
      <div>
        <label htmlFor="reason" className="mb-1 block text-sm font-medium">
          Reason
        </label>
        <textarea id="reason" name="reason" className="input" rows={3} required maxLength={1000} />
      </div>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-success">Issuance request created.</p>}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Submitting…" : "Create issuance request"}
      </button>
    </form>
  );
}
