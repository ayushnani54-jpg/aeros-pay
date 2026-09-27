"use client";

import { useActionState } from "react";
import { govLoginAction } from "@/actions/auth";

export function GovLoginForm() {
  const [state, formAction, pending] = useActionState(govLoginAction, null);

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="username" className="mb-1 block text-sm font-medium">
          Government username
        </label>
        <input id="username" name="username" className="input" autoComplete="username" required />
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
          autoComplete="current-password"
          required
        />
      </div>
      <div>
        <label htmlFor="securityCode" className="mb-1 block text-sm font-medium">
          Security code
        </label>
        <input
          id="securityCode"
          name="securityCode"
          className="input font-mono tracking-widest"
          placeholder="G7K2P"
          required
          minLength={5}
        />
      </div>

      {state && !state.ok && (
        <p className="text-sm text-danger" role="alert">
          {state.error}
        </p>
      )}

      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Verifying…" : "Access Government Panel"}
      </button>
    </form>
  );
}
