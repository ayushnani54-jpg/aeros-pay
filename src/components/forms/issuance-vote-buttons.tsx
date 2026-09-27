"use client";

import { useActionState } from "react";
import { castIssuanceVoteAction } from "@/actions/government";

export function IssuanceVoteButtons({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useActionState(castIssuanceVoteAction, null);

  return (
    <div className="mt-3 space-y-2">
      <div className="flex gap-2">
        <form action={formAction}>
          <input type="hidden" name="requestId" value={requestId} />
          <input type="hidden" name="vote" value="APPROVE" />
          <button type="submit" className="btn btn-primary" disabled={pending}>
            Approve
          </button>
        </form>
        <form action={formAction}>
          <input type="hidden" name="requestId" value={requestId} />
          <input type="hidden" name="vote" value="REJECT" />
          <button type="submit" className="btn btn-secondary" disabled={pending}>
            Reject
          </button>
        </form>
      </div>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-success">Vote recorded.</p>}
    </div>
  );
}
