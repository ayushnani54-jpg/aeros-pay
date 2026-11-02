"use client";

import { useActionState, useState } from "react";
import { govLoginAction } from "@/actions/auth";

export function GovLoginForm({ pathCode }: { pathCode?: string }) {
  const [state, formAction, pending] = useActionState(govLoginAction, null);
  const [securityCode, setSecurityCode] = useState("");

  return (
    <form action={formAction} className="space-y-4">
      {pathCode && <input type="hidden" name="pathCode" value={pathCode} />}
      <div>
        <label htmlFor="username" className="mb-1 block text-sm font-medium">
          Government username
        </label>
        <input
          id="username"
          name="username"
          className="input"
          autoComplete="off"
          required
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
          autoComplete="off"
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
          className="input font-mono tracking-widest uppercase"
          placeholder="••••• (5-character passkey)"
          value={securityCode}
          onChange={(e) => setSecurityCode(e.target.value.toUpperCase())}
          autoComplete="off"
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
