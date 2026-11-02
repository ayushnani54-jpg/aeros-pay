"use client";

import { useState } from "react";
import {
  togglePlatformFeatureFlagAction,
  generateCitizenActivationCodeAction,
  updateGovernmentPublicContentAction,
} from "@/actions/government-v6";
import type { PlatformFeatureFlag, GovernmentPublicContent } from "@/db/schema";

interface GovV6PanelProps {
  initialFlags: PlatformFeatureFlag[];
  initialContent: GovernmentPublicContent[];
}

export function GovV6ControlRoomPanel({ initialFlags, initialContent }: GovV6PanelProps) {
  const [flags, setFlags] = useState<PlatformFeatureFlag[]>(initialFlags);
  const [flagPending, setFlagPending] = useState<string | null>(null);
  const [flagFeedback, setFlagFeedback] = useState<string | null>(null);

  // Activation Code Generator
  const [targetUsername, setTargetUsername] = useState("");
  const [adminNotes, setAdminNotes] = useState("");
  const [codePending, setCodePending] = useState(false);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);

  // Content links
  const [contentItems, setContentItems] = useState<GovernmentPublicContent[]>(initialContent);
  const [contentPending, setContentPending] = useState<string | null>(null);
  const [contentSuccess, setContentSuccess] = useState<string | null>(null);

  const handleToggle = async (flagId: string, currentEnabled: boolean) => {
    setFlagPending(flagId);
    setFlagFeedback(null);

    const formData = new FormData();
    formData.set("featureId", flagId);
    formData.set("enabled", currentEnabled ? "false" : "true");
    formData.set("reason", "Government administrative override via Control Room");

    const res = await togglePlatformFeatureFlagAction(null, formData);
    setFlagPending(null);

    if (res.ok) {
      setFlags((prev) =>
        prev.map((f) => (f.id === flagId ? { ...f, enabled: !currentEnabled } : f)),
      );
      setFlagFeedback(res.message ?? "Flag updated successfully.");
    } else {
      setFlagFeedback(`Error: ${res.error}`);
    }
  };

  const handleGenerateCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setCodePending(true);
    setCodeError(null);
    setGeneratedCode(null);

    const formData = new FormData();
    formData.set("username", targetUsername.trim().toLowerCase());
    formData.set("adminNotes", adminNotes.trim());

    const res = await generateCitizenActivationCodeAction(null, formData);
    setCodePending(false);

    if (!res.ok) {
      setCodeError(res.error);
    } else {
      setGeneratedCode(res.data.code);
    }
  };

  const handleSaveContent = async (key: string, value: string) => {
    setContentPending(key);
    setContentSuccess(null);

    const formData = new FormData();
    formData.set("key", key);
    formData.set("value", value);

    const res = await updateGovernmentPublicContentAction(null, formData);
    setContentPending(null);

    if (res.ok) {
      setContentItems((prev) =>
        prev.map((c) => (c.key === key ? { ...c, value } : c)),
      );
      setContentSuccess(`Updated '${key}' successfully.`);
    } else {
      setContentSuccess(`Error: ${res.error}`);
    }
  };

  return (
    <div className="space-y-6">
      {/* 1. Feature Flags Panel */}
      <section className="card p-5 space-y-4">
        <div>
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted bg-surface px-2 py-0.5 rounded border border-border">
            V6 Feature Governance
          </span>
          <h2 className="mt-2 text-lg font-semibold text-foreground">
            Platform Master Feature Flags
          </h2>
          <p className="text-xs text-muted">
            Instantly enable or disable subsystems across public pages, server actions, and transaction mutation paths.
          </p>
        </div>

        {flagFeedback && (
          <p className="text-xs font-mono p-2 rounded bg-surface border border-border text-foreground">
            {flagFeedback}
          </p>
        )}

        <div className="divide-y divide-border">
          {flags.map((flag) => (
            <div key={flag.id} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm text-foreground">{flag.displayName}</span>
                  <span className="font-mono text-[10px] text-muted">({flag.id})</span>
                  <span
                    className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold ${
                      flag.enabled
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    }`}
                  >
                    {flag.enabled ? "ENABLED" : "DISABLED"}
                  </span>
                </div>
                <p className="text-xs text-muted mt-0.5">{flag.description}</p>
                {flag.reason && (
                  <p className="text-[11px] text-muted font-mono mt-0.5">Status reason: {flag.reason}</p>
                )}
              </div>

              <button
                type="button"
                onClick={() => handleToggle(flag.id, flag.enabled)}
                disabled={flagPending === flag.id}
                className={`btn text-xs px-3 py-1.5 shrink-0 ${
                  flag.enabled ? "btn-danger" : "btn-primary"
                }`}
              >
                {flagPending === flag.id
                  ? "Toggling…"
                  : flag.enabled
                  ? "Disable Module"
                  : "Enable Module"}
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* 2. Citizen Activation Code Generator */}
      <section className="card p-5 space-y-4">
        <div>
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted bg-surface px-2 py-0.5 rounded border border-border">
            Identity Authorization
          </span>
          <h2 className="mt-2 text-lg font-semibold text-foreground">
            Generate 6-Digit Government Activation Code
          </h2>
          <p className="text-xs text-muted">
            Issues a single-use, 24-hour cryptographic code to promote a citizen from Limited to Active Member.
          </p>
        </div>

        <form onSubmit={handleGenerateCode} className="grid gap-3 sm:grid-cols-3 max-w-2xl">
          <div>
            <label className="block text-xs font-semibold text-muted mb-1">Citizen Username</label>
            <input
              type="text"
              value={targetUsername}
              onChange={(e) => setTargetUsername(e.target.value)}
              placeholder="e.g. citizen_ray"
              className="input text-xs"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-muted mb-1">Internal Admin Note</label>
            <input
              type="text"
              value={adminNotes}
              onChange={(e) => setAdminNotes(e.target.value)}
              placeholder="e.g. Identity approved via community verification"
              className="input text-xs"
            />
          </div>

          <div className="flex items-end">
            <button
              type="submit"
              disabled={codePending}
              className="btn btn-primary text-xs w-full h-[38px]"
            >
              {codePending ? "Generating…" : "Generate Activation Code"}
            </button>
          </div>
        </form>

        {codeError && <p className="text-xs text-danger">{codeError}</p>}

        {generatedCode && (
          <div className="rounded-lg bg-emerald-500/10 p-4 border border-emerald-500/30 space-y-1">
            <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
              Single-Use 6-Digit Activation Code Generated for @{targetUsername}:
            </p>
            <p className="font-mono text-2xl font-bold tracking-widest text-foreground">
              {generatedCode}
            </p>
            <p className="text-[11px] text-muted">
              Share this code securely with the citizen. It will expire in 24 hours and can be redeemed once.
            </p>
          </div>
        )}
      </section>

      {/* 3. Public Community Links Manager */}
      <section className="card p-5 space-y-4">
        <div>
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted bg-surface px-2 py-0.5 rounded border border-border">
            Public Presence
          </span>
          <h2 className="mt-2 text-lg font-semibold text-foreground">
            Official Community & Support Links
          </h2>
          <p className="text-xs text-muted">
            Manage links displayed on the public landing page, official footers, and support headers.
          </p>
        </div>

        {contentSuccess && (
          <p className="text-xs font-mono p-2 rounded bg-surface border border-border text-foreground">
            {contentSuccess}
          </p>
        )}

        <div className="divide-y divide-border">
          {contentItems.map((item) => (
            <div key={item.key} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-1 max-w-sm">
                <span className="font-semibold text-xs text-foreground">{item.label}</span>
                <p className="font-mono text-[10px] text-muted">{item.key}</p>
              </div>

              <div className="flex items-center gap-2 flex-1 max-w-md">
                <input
                  type="text"
                  defaultValue={item.value}
                  id={`input-${item.key}`}
                  className="input text-xs font-mono"
                />
                <button
                  type="button"
                  onClick={() => {
                    const el = document.getElementById(`input-${item.key}`) as HTMLInputElement;
                    if (el) handleSaveContent(item.key, el.value);
                  }}
                  disabled={contentPending === item.key}
                  className="btn btn-secondary text-xs shrink-0"
                >
                  {contentPending === item.key ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
