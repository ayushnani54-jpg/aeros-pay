"use client";

import { useSyncExternalStore, useState } from "react";
import {
  CURRENT_PLATFORM_VERSION,
  PLATFORM_VERSION_STORAGE_KEY,
  getLatestRelease,
} from "@/lib/platform-version";
import { AerosLogo } from "@/components/logo";

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

function getSnapshot(): boolean {
  try {
    const lastSeen = localStorage.getItem(PLATFORM_VERSION_STORAGE_KEY);
    return lastSeen !== CURRENT_PLATFORM_VERSION;
  } catch {
    return false;
  }
}

function getServerSnapshot(): boolean {
  return false;
}

export function ReleaseUpdatePrompt() {
  const shouldPrompt = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [dismissed, setDismissed] = useState(false);
  const release = getLatestRelease();

  const handleDismiss = () => {
    try {
      localStorage.setItem(PLATFORM_VERSION_STORAGE_KEY, CURRENT_PLATFORM_VERSION);
    } catch {
      // Ignore
    }
    setDismissed(true);
  };

  if (!shouldPrompt || dismissed) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="release-title"
    >
      <div className="card w-full max-w-lg p-6 sm:p-7 shadow-2xl border border-border bg-surface space-y-5 animate-in zoom-in-95 duration-150">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-surface border border-border text-foreground">
              <AerosLogo size={24} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="badge bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 text-[10px] uppercase font-mono">
                  Upgrade • v{release.version}
                </span>
                <span className="text-xs text-muted font-mono">{release.releaseDate}</span>
              </div>
              <h2 id="release-title" className="text-base font-semibold text-foreground mt-0.5">
                {release.title}
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            className="text-muted hover:text-foreground text-xl leading-none p-1 rounded transition-colors"
            aria-label="Close upgrade notice"
          >
            ×
          </button>
        </div>

        <p className="text-xs text-muted leading-relaxed">
          {release.tagline}
        </p>

        <div className="rounded-lg bg-background p-4 border border-border space-y-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted font-mono">
            Key Platform Enhancements:
          </p>
          <ul className="space-y-2 text-xs text-foreground">
            {release.highlights.map((item, idx) => (
              <li key={idx} className="flex items-start gap-2">
                <span className="text-emerald-500 font-bold shrink-0 mt-0.5">✔</span>
                <span className="leading-snug text-muted dark:text-zinc-300">
                  {item}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-[11px] text-muted font-mono">
            Aeros Pay Sovereign Network
          </span>
          <button
            type="button"
            onClick={handleDismiss}
            className="btn btn-primary text-xs px-5 py-2 font-medium"
          >
            Got it, Explore Aeros Pay
          </button>
        </div>
      </div>
    </div>
  );
}
