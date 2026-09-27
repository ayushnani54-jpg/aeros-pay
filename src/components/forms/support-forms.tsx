"use client";

import { useActionState } from "react";
import {
  replyToSupportAction,
  sendSupportMessageAction,
  setSupportStatusAction,
} from "@/actions/support";

export function SupportMessageForm() {
  const [state, formAction, pending] = useActionState(sendSupportMessageAction, null);

  return (
    <form action={formAction} className="card space-y-3 p-5">
      <label htmlFor="supportBody" className="block text-sm font-medium">
        Message the Government
      </label>
      <textarea
        id="supportBody"
        name="body"
        className="input"
        rows={4}
        required
        maxLength={2000}
        placeholder="Ask a question or report a problem…"
      />
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-success">Message sent.</p>}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Sending…" : "Send message"}
      </button>
    </form>
  );
}

export function SupportReplyForm({ threadId }: { threadId: string }) {
  const [state, formAction, pending] = useActionState(replyToSupportAction, null);

  return (
    <form action={formAction} className="card space-y-3 p-5">
      <input type="hidden" name="threadId" value={threadId} />
      <label htmlFor="replyBody" className="block text-sm font-medium">
        Reply
      </label>
      <textarea id="replyBody" name="body" className="input" rows={4} required maxLength={2000} />
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-success">Reply sent.</p>}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Sending…" : "Send reply"}
      </button>
    </form>
  );
}

export function SupportStatusButtons({
  threadId,
  current,
}: {
  threadId: string;
  current: "OPEN" | "WAITING" | "RESOLVED";
}) {
  const [state, formAction, pending] = useActionState(setSupportStatusAction, null);
  const options: ("OPEN" | "WAITING" | "RESOLVED")[] = ["OPEN", "WAITING", "RESOLVED"];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {options.map((status) => (
          <form key={status} action={formAction}>
            <input type="hidden" name="threadId" value={threadId} />
            <input type="hidden" name="status" value={status} />
            <button
              type="submit"
              disabled={pending || current === status}
              className={
                current === status ? "btn btn-primary text-xs" : "btn btn-secondary text-xs"
              }
            >
              {status}
            </button>
          </form>
        ))}
      </div>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
    </div>
  );
}
