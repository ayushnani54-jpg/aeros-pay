"use client";

import { useState } from "react";
import { submitSupportAction } from "@/actions/support";

export function SupportForm({ defaultEmail = "", username = "" }: { defaultEmail?: string; username?: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successTicket, setSuccessTicket] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("BUG_REPORT");

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPending(true);
    setError(null);

    const formData = new FormData(e.currentTarget);
    const res = await submitSupportAction(null, formData);

    setPending(false);
    if (!res.ok) {
      setError(res.error);
    } else {
      setSuccessTicket(res.data.ticketNumber);
    }
  };

  if (successTicket) {
    return (
      <div className="card p-8 text-center space-y-4">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-bold text-xl">
          ✓
        </div>
        <h3 className="text-xl font-bold text-foreground">Support Ticket Created</h3>
        <p className="text-sm text-muted">
          Your request has been registered in the platform database with ticket reference:
        </p>
        <div className="p-3 bg-surface rounded-lg font-mono text-base font-semibold text-foreground border border-border">
          {successTicket}
        </div>
        <p className="text-xs text-muted">
          Our team will review your report and respond via your verified email address.
        </p>
        <button
          type="button"
          onClick={() => setSuccessTicket(null)}
          className="btn btn-secondary text-sm mt-4"
        >
          Submit Another Request
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="card p-6 space-y-5">
      {/* Honeypot field (hidden from humans) */}
      <input
        type="text"
        name="botcheck"
        className="hidden"
        style={{ display: "none" }}
        tabIndex={-1}
        autoComplete="off"
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="email" className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1">
            Contact Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            defaultValue={defaultEmail}
            className="input"
            placeholder="your-email@example.com"
            required
          />
        </div>

        <div>
          <label htmlFor="category" className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1">
            Category
          </label>
          <select
            id="category"
            name="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="input"
            required
          >
            <option value="BUG_REPORT">Bug / Technical Issue</option>
            <option value="ACCOUNT_ACCESS">Account & Activation</option>
            <option value="GENERAL">General Inquiries</option>
            <option value="FEATURE_REQUEST">Feature Request</option>
            <option value="FEEDBACK">Platform Feedback</option>
            <option value="OTHER">Other</option>
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="severity" className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1">
            Severity
          </label>
          <select id="severity" name="severity" className="input" defaultValue="NORMAL">
            <option value="LOW">Low (Cosmetic / Suggestion)</option>
            <option value="NORMAL">Normal (Standard Query)</option>
            <option value="HIGH">High (Feature Malfunctioning)</option>
            <option value="URGENT">Urgent (Account / Security Issue)</option>
          </select>
        </div>

        <div>
          <label htmlFor="relevantModule" className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1">
            Relevant Subsystem
          </label>
          <select id="relevantModule" name="relevantModule" className="input">
            <option value="IDENTITY">Identity & Login</option>
            <option value="WALLETS">Wallets & Transfers</option>
            <option value="MARKETPLACE">Marketplace & Escrow</option>
            <option value="COMPANIES">Companies & Invoicing</option>
            <option value="JOBS">Jobs & Employment</option>
            <option value="MEDIA">Aeros Media</option>
            <option value="TERMINAL">Trading Terminal</option>
            <option value="OTHER">Other / System Wide</option>
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="subject" className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1">
          Subject
        </label>
        <input
          id="subject"
          name="subject"
          type="text"
          className="input"
          placeholder="Brief summary of the issue or inquiry"
          required
          maxLength={200}
        />
      </div>

      <div>
        <label htmlFor="description" className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1">
          Detailed Description
        </label>
        <textarea
          id="description"
          name="description"
          rows={4}
          className="input"
          placeholder="Provide complete details regarding the situation..."
          required
          minLength={10}
        />
      </div>

      {category === "BUG_REPORT" && (
        <div className="space-y-4 rounded-lg bg-surface p-4 border border-border">
          <p className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Bug Reproduction Details
          </p>
          <div>
            <label htmlFor="stepsToReproduce" className="block text-xs text-muted mb-1">
              Steps to Reproduce
            </label>
            <textarea
              id="stepsToReproduce"
              name="stepsToReproduce"
              rows={2}
              className="input text-xs"
              placeholder="1. Navigate to... 2. Click on... 3. Notice error..."
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="expectedBehaviour" className="block text-xs text-muted mb-1">
                Expected Behaviour
              </label>
              <input
                id="expectedBehaviour"
                name="expectedBehaviour"
                className="input text-xs"
                placeholder="What should have happened"
              />
            </div>
            <div>
              <label htmlFor="actualBehaviour" className="block text-xs text-muted mb-1">
                Actual Behaviour
              </label>
              <input
                id="actualBehaviour"
                name="actualBehaviour"
                className="input text-xs"
                placeholder="What actually occurred"
              />
            </div>
          </div>
        </div>
      )}

      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Submitting Ticket…" : "Submit Support Request"}
      </button>
    </form>
  );
}
