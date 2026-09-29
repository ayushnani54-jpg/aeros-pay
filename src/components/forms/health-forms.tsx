"use client";

import { useActionState } from "react";
import { runHealthCheckAction } from "@/actions/government";

/**
 * "Run health check" (V3 Phase K, spec §§40, 48).
 *
 * The button only ASKS the server to run the reconciliation; every rule and
 * every query lives in src/lib/reconcile.ts and runs under the Government
 * session, so this component carries no authority and no logic of its own.
 *
 * Same `.btn` / `.card` classes as the rest of the panel — no new visual
 * language for this phase.
 */
export function RunHealthCheckButton() {
  const [state, formAction, pending] = useActionState(runHealthCheckAction, null);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <button type="submit" className="btn btn-primary text-sm" disabled={pending}>
        {pending ? "Checking…" : "Run health check"}
      </button>

      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}

      {state?.ok && (
        <p className={`text-sm ${state.data.healthy ? "text-success" : "text-danger"}`}>
          {state.data.healthy
            ? `All ${state.data.checksRun} checks passed.`
            : `${state.data.checksFailed} of ${state.data.checksRun} checks failed — see below.`}
        </p>
      )}
    </form>
  );
}
