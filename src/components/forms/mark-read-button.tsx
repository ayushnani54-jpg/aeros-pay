"use client";

import { useActionState } from "react";
import { markNotificationsReadAction } from "@/actions/user";

export function MarkAllReadButton({ unread }: { unread: number }) {
  const [state, formAction, pending] = useActionState(markNotificationsReadAction, null);

  return (
    <form action={formAction}>
      <button type="submit" className="btn btn-secondary text-sm" disabled={pending}>
        {pending ? "Marking…" : `Mark all read (${unread})`}
      </button>
      {state && !state.ok && <p className="mt-1 text-xs text-danger">{state.error}</p>}
    </form>
  );
}
