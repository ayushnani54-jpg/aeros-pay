"use client";

import { useActionState } from "react";
import { createIssuanceRequestAction } from "@/actions/government";
import { MAX_ISSUANCE_AMOUNT } from "@/lib/constants";

export function CreateIssuanceForm() {
  const [state, formAction, pending] = useActionState(createIssuanceRequestAction, null);

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor="amount" className="mb-1 block text-sm font-medium">
          Requested amount (max {MAX_ISSUANCE_AMOUNT.toLocaleString()})
        </label>
        <input
          id="amount"
          name="amount"
          type="number"
          min={1}
          max={MAX_ISSUANCE_AMOUNT}
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
