"use client";

import { useActionState } from "react";
import {
  banUserAction,
  suspendUserAction,
  unsuspendUserAction,
} from "@/actions/government";

export function UserStatusActions({
  userId,
  status,
}: {
  userId: string;
  status: "ACTIVE" | "SUSPENDED" | "BANNED";
}) {
  const [suspendState, suspendFormAction, suspendPending] = useActionState(suspendUserAction, null);
  const [unsuspendState, unsuspendFormAction, unsuspendPending] = useActionState(
    unsuspendUserAction,
    null,
  );
  const [banState, banFormAction, banPending] = useActionState(banUserAction, null);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {status !== "SUSPENDED" && status !== "BANNED" && (
          <form action={suspendFormAction}>
            <input type="hidden" name="userId" value={userId} />
            <button type="submit" className="btn btn-secondary" disabled={suspendPending}>
              {suspendPending ? "Suspending…" : "Suspend"}
            </button>
          </form>
        )}
        {status === "SUSPENDED" && (
          <form action={unsuspendFormAction}>
            <input type="hidden" name="userId" value={userId} />
            <button type="submit" className="btn btn-secondary" disabled={unsuspendPending}>
              {unsuspendPending ? "Restoring…" : "Unsuspend"}
            </button>
          </form>
        )}
        {status !== "BANNED" && (
          <form action={banFormAction}>
            <input type="hidden" name="userId" value={userId} />
            <button type="submit" className="btn btn-danger" disabled={banPending}>
              {banPending ? "Banning…" : "Ban"}
            </button>
          </form>
        )}
        {status === "BANNED" && (
          <form action={unsuspendFormAction}>
            <input type="hidden" name="userId" value={userId} />
            <button type="submit" className="btn btn-secondary" disabled={unsuspendPending}>
              {unsuspendPending ? "Restoring…" : "Restore to Active"}
            </button>
          </form>
        )}
      </div>
      {suspendState && !suspendState.ok && <p className="text-sm text-danger">{suspendState.error}</p>}
      {unsuspendState && !unsuspendState.ok && (
        <p className="text-sm text-danger">{unsuspendState.error}</p>
      )}
      {banState && !banState.ok && <p className="text-sm text-danger">{banState.error}</p>}
    </div>
  );
}
