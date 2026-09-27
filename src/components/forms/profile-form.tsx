"use client";

import { useActionState } from "react";
import { updateDisplayNameAction } from "@/actions/user";

export function ProfileForm({ currentDisplayName }: { currentDisplayName: string }) {
  const [state, formAction, pending] = useActionState(updateDisplayNameAction, null);

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="displayName" className="mb-1 block text-sm font-medium">
          Display name
        </label>
        <input
          id="displayName"
          name="displayName"
          className="input"
          defaultValue={currentDisplayName}
          maxLength={60}
          required
        />
      </div>

      {state && !state.ok && (
        <p className="text-sm text-danger" role="alert">
          {state.error}
        </p>
      )}
      {state?.ok && <p className="text-sm text-success">Saved.</p>}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
