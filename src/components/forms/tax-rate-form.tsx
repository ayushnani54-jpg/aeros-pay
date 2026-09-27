"use client";

import { useActionState } from "react";
import { setTaxRateAction } from "@/actions/government";

export function TaxRateForm({ currentPercent }: { currentPercent: number }) {
  const [state, formAction, pending] = useActionState(setTaxRateAction, null);

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor="taxRatePercent" className="mb-1 block text-sm font-medium">
          Tax rate (%)
        </label>
        <input
          id="taxRatePercent"
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
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-success">Tax rate updated.</p>}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Saving…" : "Update tax rate"}
      </button>
    </form>
  );
}
