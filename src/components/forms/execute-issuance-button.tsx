"use client";

import { useActionState } from "react";
import { executeIssuanceAction } from "@/actions/government";

export function ExecuteIssuanceButton({ requestId, disabled }: { requestId: string; disabled: boolean }) {
  const [state, formAction, pending] = useActionState(executeIssuanceAction, null);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="requestId" value={requestId} />
      <button type="submit" className="btn btn-primary" disabled={disabled || pending}>
        {pending ? "Executing…" : "Execute Issuance"}
      </button>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-success">Issuance executed.</p>}
    </form>
  );
}
