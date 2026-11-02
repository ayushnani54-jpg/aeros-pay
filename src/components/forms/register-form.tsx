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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  const handleInitiate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    setInfoMessage(null);

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
            <p className="mt-2 text-xs text-success font-mono bg-success-bg p-2 rounded border border-success/20">
              {infoMessage}
            </p>
          )}
        </div>

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
