"use client";

import { useActionState, useState } from "react";
import { registerAction } from "@/actions/auth";

export function RegisterForm() {
  const [state, formAction, pending] = useActionState(registerAction, null);
  const [usernamePreview, setUsernamePreview] = useState("");

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="username" className="mb-1 block text-sm font-medium">
          Username
        </label>
        <input
          id="username"
          name="username"
          className="input"
          placeholder="lowercase, e.g. ayush"
          autoComplete="off"
          autoCapitalize="off"
          onChange={(e) => setUsernamePreview(e.target.value.trim().toLowerCase())}
          required
          minLength={3}
          maxLength={24}
          pattern="[A-Za-z0-9_]+"
        />
        {usernamePreview && (
          <p className="mt-1 text-xs text-muted">
            Your permanent username will be: <span className="font-mono">@{usernamePreview}</span>
          </p>
        )}
      </div>

      <div>
        <label htmlFor="displayName" className="mb-1 block text-sm font-medium">
          Display name
        </label>
        <input
          id="displayName"
          name="displayName"
          className="input"
          placeholder="e.g. Ayush N."
          required
          maxLength={60}
        />
      </div>

      <div>
        <label htmlFor="password" className="mb-1 block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          className="input"
          autoComplete="new-password"
          required
          minLength={8}
        />
      </div>

      <div>
        <label htmlFor="registrationCode" className="mb-1 block text-sm font-medium">
          Government registration code
        </label>
        <input
          id="registrationCode"
          name="registrationCode"
          className="input font-mono tracking-widest"
          placeholder="4827"
          required
          inputMode="numeric"
          maxLength={4}
          pattern="[0-9]{4}"
        />
        <p className="mt-1 text-xs text-muted">
          A one-time, 4-digit code provided by the Government.
        </p>
      </div>

      {state && !state.ok && (
        <p className="text-sm text-danger" role="alert">
          {state.error}
        </p>
      )}

      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
