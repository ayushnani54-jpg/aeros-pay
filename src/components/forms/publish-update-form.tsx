"use client";

import { useActionState } from "react";
import { publishUpdateAction } from "@/actions/government";

export function PublishUpdateForm() {
  const [state, formAction, pending] = useActionState(publishUpdateAction, null);

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor="title" className="mb-1 block text-sm font-medium">
          Title
        </label>
        <input id="title" name="title" className="input" required maxLength={160} />
      </div>
      <div>
        <label htmlFor="content" className="mb-1 block text-sm font-medium">
          Content
        </label>
        <textarea id="content" name="content" className="input" rows={4} required maxLength={5000} />
      </div>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-success">Published.</p>}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Publishing…" : "Publish update"}
      </button>
    </form>
  );
}
