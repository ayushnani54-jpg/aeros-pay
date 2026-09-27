"use client";

import { useActionState, useState } from "react";
import { adjustBalanceAction } from "@/actions/government";

export function AdjustBalanceForm({ userId }: { userId: string }) {
  const [direction, setDirection] = useState<"CREDIT" | "DEBIT">("CREDIT");
  const [state, formAction, pending] = useActionState(adjustBalanceAction, null);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="userId" value={userId} />
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
        <label htmlFor="amount" className="mb-1 block text-sm font-medium">
          Amount
        </label>
        <input id="amount" name="amount" type="number" min={1} step={1} className="input" required />
      </div>
      <div>
        <label htmlFor="reason" className="mb-1 block text-sm font-medium">
          Reason (required)
        </label>
        <textarea id="reason" name="reason" className="input" rows={2} required maxLength={500} />
      </div>

      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-success">Adjustment applied.</p>}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Applying…" : "Apply adjustment"}
      </button>
    </form>
  );
}
