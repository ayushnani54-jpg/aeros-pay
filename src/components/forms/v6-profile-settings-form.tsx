"use client";

import { useState } from "react";
import {
  v6UpdateProfilePrivacyAction,
  v6ActivateMembershipAction,
  v6SubmitExistingUserEmailAction,
  v6VerifyExistingUserEmailAction,
} from "@/actions/auth";

interface ProfileSettingsProps {
  user: {
    id: string;
    username: string;
    displayName: string;
    authEmail: string | null;
    authEmailVerified: boolean;
    publicContactEmail: string | null;
    phoneNumber: string | null;
    whatsappConsent: boolean;
    accessLevel: string;
    emailMigrationRequired: boolean;
    bio: string | null;
  };
}

export function V6ProfileSettings({ user }: ProfileSettingsProps) {
  // 1. Contact & Privacy Settings
  const [profilePending, setProfilePending] = useState(false);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  // 2. Government Activation
  const [actCode, setActCode] = useState("");
  const [actPending, setActPending] = useState(false);
  const [actMessage, setActMessage] = useState<string | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  const [currentLevel, setCurrentLevel] = useState(user.accessLevel);

  // 3. Email Migration
  const [migStep, setMigStep] = useState<"EMAIL" | "VERIFY">("EMAIL");
  const [migEmail, setMigEmail] = useState("");
  const [migCode, setMigCode] = useState("");
  const [migPending, setMigPending] = useState(false);
  const [migMessage, setMigMessage] = useState<string | null>(null);
  const [migError, setMigError] = useState<string | null>(null);
  const [migRequired, setMigRequired] = useState(user.emailMigrationRequired);

  const handleUpdateProfile = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProfilePending(true);
    setProfileMessage(null);
    setProfileError(null);

    const formData = new FormData(e.currentTarget);
    const res = await v6UpdateProfilePrivacyAction(null, formData);

    setProfilePending(false);
    if (!res.ok) {
      setProfileError(res.error);
    } else {
      setProfileMessage(res.message ?? "Profile saved successfully.");
    }
  };

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    setActPending(true);
    setActError(null);
    setActMessage(null);

    const formData = new FormData();
    formData.set("code", actCode.trim());
    const res = await v6ActivateMembershipAction(null, formData);

    setActPending(false);
    if (!res.ok) {
      setActError(res.error);
    } else {
      setActMessage(res.message ?? "Membership activated!");
      setCurrentLevel("ACTIVE_MEMBER");
    }
  };

  const handleMigrateEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMigPending(true);
    setMigError(null);
    setMigMessage(null);

    const formData = new FormData();
    formData.set("email", migEmail.trim().toLowerCase());
    const res = await v6SubmitExistingUserEmailAction(null, formData);

    setMigPending(false);
    if (!res.ok) {
      setMigError(res.error);
    } else {
      setMigStep("VERIFY");
      setMigMessage(res.message ?? "Verification code sent to your email.");
    }
  };

  const handleMigrateVerifySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMigPending(true);
    setMigError(null);

    const formData = new FormData();
    formData.set("email", migEmail.trim().toLowerCase());
    formData.set("code", migCode.trim());
    const res = await v6VerifyExistingUserEmailAction(null, formData);

    setMigPending(false);
    if (!res.ok) {
      setMigError(res.error);
    } else {
      setMigRequired(false);
      setMigMessage("Email verified and account migrated successfully!");
    }
  };

  return (
    <div className="space-y-8">
      {/* Email Migration Warning Banner if required */}
      {migRequired && (
        <div className="card p-6 border-amber-500/40 bg-amber-500/10 space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-amber-500 font-bold text-lg">⚠️</span>
            <h3 className="font-semibold text-foreground">Action Required: Mandatory Email Verification</h3>
          </div>
          <p className="text-xs text-muted leading-relaxed">
            As part of the V6 Identity Upgrade, all registered accounts must link and verify an email address to participate in platform transactions. Your balances, username, and history are completely safe.
          </p>

          {migStep === "EMAIL" ? (
            <form onSubmit={handleMigrateEmailSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold uppercase text-muted mb-1">
                  Your Email Address
                </label>
                <input
                  type="email"
                  value={migEmail}
                  onChange={(e) => setMigEmail(e.target.value)}
                  className="input text-sm"
                  placeholder="name@example.com"
                  required
                />
              </div>
              {migError && <p className="text-xs text-danger">{migError}</p>}
              <button type="submit" className="btn btn-primary text-xs" disabled={migPending}>
                {migPending ? "Sending Code…" : "Send 8-Digit Verification Code"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleMigrateVerifySubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold uppercase text-muted mb-1">
                  Enter 8-Digit Verification Code sent to {migEmail}
                </label>
                <input
                  type="text"
                  value={migCode}
                  onChange={(e) => setMigCode(e.target.value)}
                  className="input font-mono tracking-widest text-sm text-center"
                  placeholder="12345678"
                  maxLength={8}
                  minLength={8}
                  required
                />
              </div>
              {migMessage && <p className="text-xs text-success">{migMessage}</p>}
              {migError && <p className="text-xs text-danger">{migError}</p>}
              <div className="flex items-center gap-2">
                <button type="submit" className="btn btn-primary text-xs" disabled={migPending}>
                  {migPending ? "Verifying…" : "Confirm Email & Complete Migration"}
                </button>
                <button
                  type="button"
                  onClick={() => setMigStep("EMAIL")}
                  className="btn btn-secondary text-xs"
                >
                  Change Email
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Limited Member Activation Card */}
      {currentLevel === "VERIFIED_LIMITED" && (
        <div className="card p-6 border-blue-500/40 bg-blue-500/5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-500/20 text-blue-600 dark:text-blue-400 font-bold">
                TIER: VERIFIED LIMITED
              </span>
              <h3 className="mt-2 text-base font-semibold text-foreground">
                Activate Full Platform Membership
              </h3>
            </div>
          </div>
          <p className="text-xs text-muted leading-relaxed">
            Your email is verified! To unlock financial balance transfers, marketplace seller features, and job creation, enter the 6-digit activation code issued by the Government administration.
          </p>

          <form onSubmit={handleActivate} className="space-y-3 max-w-sm">
            <div>
              <label className="block text-xs font-semibold uppercase text-muted mb-1">
                6-Digit Government Code
              </label>
              <input
                type="text"
                value={actCode}
                onChange={(e) => setActCode(e.target.value)}
                placeholder="123456"
                maxLength={6}
                minLength={6}
                className="input font-mono text-center tracking-widest text-base"
                required
              />
            </div>
            {actError && <p className="text-xs text-danger">{actError}</p>}
            {actMessage && <p className="text-xs text-success">{actMessage}</p>}
            <button type="submit" className="btn btn-primary text-xs w-full" disabled={actPending}>
              {actPending ? "Activating…" : "Unlock Active Membership"}
            </button>
          </form>
        </div>
      )}

      {/* Main Profile & Privacy Form */}
      <form onSubmit={handleUpdateProfile} className="card p-6 space-y-6">
        <h3 className="font-semibold text-base text-foreground border-b border-border pb-3">
          Citizen Public Information & Contact Channels
        </h3>

        <div>
          <label className="block text-xs font-semibold uppercase text-muted mb-1">
            Bio / Public Status
          </label>
          <textarea
            name="bio"
            defaultValue={user.bio || ""}
            rows={3}
            className="input text-sm"
            placeholder="Tell fellow citizens about yourself, your services, or your economic expertise..."
            maxLength={500}
          />
          <p className="text-[11px] text-muted mt-1">Visible on your public citizen passport profile.</p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-semibold uppercase text-muted mb-1">
              Public Contact Email (Optional)
            </label>
            <input
              name="publicContactEmail"
              type="email"
              defaultValue={user.publicContactEmail || ""}
              className="input text-sm"
              placeholder="public-contact@example.com"
            />
            <p className="text-[11px] text-muted mt-1">
              Displayed publicly on your profile. Your private sign-in email is never published.
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase text-muted mb-1">
              Optional Phone Number (E.164)
            </label>
            <input
              name="phoneNumber"
              type="tel"
              defaultValue={user.phoneNumber || ""}
              className="input text-sm font-mono"
              placeholder="+919876543210"
              pattern="^\+[1-9]\d{7,14}$|^$"
            />
            <p className="text-[11px] text-muted mt-1">
              International format starting with +. Strictly optional.
            </p>
          </div>
        </div>

        {/* WhatsApp Explicit Opt-in (Mandatory Privacy Separation) */}
        <div className="rounded-lg bg-surface p-4 border border-border space-y-2">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              name="whatsappConsent"
              defaultChecked={user.whatsappConsent}
              className="mt-1 h-4 w-4 rounded border-border text-foreground focus:ring-accent"
            />
            <div>
              <span className="text-sm font-medium text-foreground">
                Opt-in to Official Aeros Pay WhatsApp Community & Direct Alerts
              </span>
              <p className="text-xs text-muted mt-0.5 leading-relaxed">
                By enabling this, you authorize Aeros Pay administration to contact you via WhatsApp regarding important account notices and official community updates. We never auto-enroll phone numbers.
              </p>
            </div>
          </label>
        </div>

        {profileError && <p className="text-sm text-danger">{profileError}</p>}
        {profileMessage && <p className="text-sm text-success">{profileMessage}</p>}

        <button type="submit" className="btn btn-primary" disabled={profilePending}>
          {profilePending ? "Saving Settings…" : "Save Privacy & Profile Settings"}
        </button>
      </form>
    </div>
  );
}
