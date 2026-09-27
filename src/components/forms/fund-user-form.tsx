"use client";

import { useActionState } from "react";
import { fundUserAction } from "@/actions/government";
import { NEW_USER_FUNDING_AMOUNT } from "@/lib/constants";

export function FundUserForm({ userId }: { userId: string }) {
  const [state, formAction, pending] = useActionState(fundUserAction, null);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="userId" value={userId} />
      <div>
        <label htmlFor="fundAmount" className="mb-1 block text-sm font-medium">
          Amount to send from treasury
        </label>
        <input
          id="fundAmount"
          name="amount"
          type="number"
          min={1}
          step={1}
          className="input"
          defaultValue={NEW_USER_FUNDING_AMOUNT}
          required
        />
      </div>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-success">Sent.</p>}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Sending…" : "Send from treasury"}
      </button>
    </form>
  );
}
