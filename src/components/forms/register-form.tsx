"use client";

import { useState } from "react";
import {
  v6InitiateRegistrationAction,
  v6VerifyEmailAndCreateAccountAction,
} from "@/actions/auth";

export function RegisterForm() {
  const [step, setStep] = useState<"INITIATE" | "VERIFY">("INITIATE");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  const handleInitiate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    setInfoMessage(null);
    setDevCode(null);

    const formData = new FormData(e.currentTarget);
    const result = await v6InitiateRegistrationAction(null, formData);

    setPending(false);
    if (!result.ok) {
      setError(result.error);
    } else {
      const emailVal = (formData.get("email") as string).trim().toLowerCase();
      setEmail(emailVal);
      setUsername((formData.get("username") as string).trim().toLowerCase());
      setStep("VERIFY");
      if (result.message) {
        setInfoMessage(result.message);
      }
      if (result.data?.devCode) {
        setDevCode(result.data.devCode);
      }
    }
  };

  const handleVerify = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPending(true);
    setError(null);

    const formData = new FormData(e.currentTarget);
    formData.set("email", email);
    const result = await v6VerifyEmailAndCreateAccountAction(null, formData);

    if (result && !result.ok) {
      setPending(false);
      setError(result.error);
    }
    // If successful, the action redirects to /dashboard
  };

  if (step === "VERIFY") {
    return (
      <div className="space-y-4">
        <div className="rounded-lg bg-surface p-3 text-sm text-foreground border border-border">
          <p className="font-medium text-foreground">Verification Code Required</p>
          <p className="text-xs text-muted mt-1">
            We sent an 8-digit verification code to <span className="font-semibold text-foreground">{email}</span>.
          </p>
          {infoMessage && (
            <p className="mt-2 text-xs text-muted font-mono bg-surface p-2 rounded border border-border">
              {infoMessage}
            </p>
          )}
        </div>

        {devCode && (
          <div className="rounded-lg bg-amber-500/10 p-3 text-xs border border-amber-500/25 space-y-2">
            <p className="font-semibold text-amber-600 dark:text-amber-400">
              ⚡ Sandbox / Demo Access Code
            </p>
            <p className="text-muted leading-relaxed">
              Real inbox delivery is awaiting <code>GMAIL_APP_PASSWORD</code> in Vercel. For immediate registration, your code is:
            </p>
            <div className="flex items-center gap-2 pt-1">
              <span className="font-mono text-base font-bold tracking-widest text-foreground bg-surface px-3 py-1 rounded border border-border">
                {devCode}
              </span>
              <button
                type="button"
                onClick={() => {
                  const input = document.getElementById("code") as HTMLInputElement;
                  if (input) {
                    input.value = devCode;
                    input.dispatchEvent(new Event("input", { bubbles: true }));
                  }
                }}
                className="btn btn-secondary text-xs py-1 px-3 font-medium"
              >
                Auto-fill Code
              </button>
            </div>
          </div>
        )}

        <form onSubmit={handleVerify} className="space-y-4">
          <div>
            <label htmlFor="code" className="mb-1 block text-sm font-medium">
              8-Digit Verification Code
            </label>
            <input
              id="code"
              name="code"
              className="input font-mono tracking-widest text-center text-lg"
              placeholder="12345678"
              required
              maxLength={8}
              minLength={8}
              pattern="[0-9]{8}"
              inputMode="numeric"
              autoFocus
            />
          </div>

          {error && (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="btn btn-primary w-full" disabled={pending}>
            {pending ? "Verifying…" : "Complete Registration & Sign In"}
          </button>
        </form>

        <div className="text-center pt-2">
          <button
            type="button"
            onClick={() => {
              setStep("INITIATE");
              setError(null);
              setInfoMessage(null);
            }}
            className="text-xs text-muted hover:text-foreground underline"
          >
            ← Back to account details
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleInitiate} className="space-y-4">
      <div>
        <label htmlFor="username" className="mb-1 block text-sm font-medium">
          Username
        </label>
        <input
          id="username"
          name="username"
          className="input"
          placeholder="lowercase, e.g. citizen_ray"
          autoComplete="off"
          autoCapitalize="off"
          value={username}
          onChange={(e) => setUsername(e.target.value.trim().toLowerCase())}
          required
          minLength={3}
          maxLength={24}
          pattern="[A-Za-z0-9_]+"
        />
        {username && (
          <p className="mt-1 text-xs text-muted">
            Permanent citizen handle: <span className="font-mono">@{username}</span>
          </p>
        )}
      </div>

      <div>
        <label htmlFor="email" className="mb-1 block text-sm font-medium">
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          className="input"
          placeholder="citizen@example.com"
          autoComplete="email"
          required
        />
        <p className="mt-1 text-xs text-muted">
          Your private authentication email. Never shared publicly.
        </p>
      </div>

      <div>
        <label htmlFor="displayName" className="mb-1 block text-sm font-medium">
          Display name
        </label>
        <input
          id="displayName"
          name="displayName"
          className="input"
          placeholder="e.g. Ray Charles"
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

      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Sending Verification Code…" : "Continue with Email Verification"}
      </button>
    </form>
  );
}
