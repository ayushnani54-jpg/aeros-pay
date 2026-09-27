"use client";

import { useActionState } from "react";
import { changePasswordAction } from "@/actions/user";

export function ChangePasswordForm({ mustChange }: { mustChange: boolean }) {
  const [state, formAction, pending] = useActionState(changePasswordAction, null);

  if (state?.ok) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-success">Password changed.</p>
        <p className="text-sm text-muted">
          For safety, every session was signed out — please log in again with your new password.
        </p>
        <a href="/login" className="btn btn-primary text-sm">
          Log in again
        </a>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      {mustChange && (
        <p className="text-sm text-danger">
          You are using a temporary password issued by the Government. Please set your own now.
        </p>
      )}
      <div>
        <label htmlFor="currentPassword" className="mb-1 block text-sm font-medium">
          Current password
        </label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          className="input"
          autoComplete="current-password"
          required
        />
      </div>
      <div>
        <label htmlFor="newPassword" className="mb-1 block text-sm font-medium">
          New password
        </label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          className="input"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </div>
      <div>
        <label htmlFor="confirmPassword" className="mb-1 block text-sm font-medium">
          Confirm new password
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          className="input"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </div>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Saving…" : "Change password"}
      </button>
    </form>
  );
}
