import React from "react";
import { AerosLogo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { MAINTENANCE_DETAILS } from "@/lib/maintenance";

export function MaintenanceView() {
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground transition-colors selection:bg-zinc-800 selection:text-zinc-100">
      {/* 1. Header Navigation */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <AerosLogo size={32} />
            <span className="text-xl font-bold tracking-tight text-foreground">
              {MAINTENANCE_DETAILS.appName}
            </span>
          </div>

          <div className="flex items-center gap-3 sm:gap-4">
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* 2. Main Maintenance Screen */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-16 sm:py-24">
        <div className="w-full max-w-2xl text-center">
          {/* Status Badge */}
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted mb-8 shadow-sm">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
            </span>
            <span>{MAINTENANCE_DETAILS.badge}</span>
          </div>

          {/* Central Logo & Headline */}
          <div className="mb-6 flex justify-center">
            <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
              <AerosLogo size={56} />
            </div>
          </div>

          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-foreground mb-4">
            {MAINTENANCE_DETAILS.title}
          </h1>

          <p className="text-base sm:text-lg text-muted max-w-xl mx-auto leading-relaxed mb-10">
            {MAINTENANCE_DETAILS.message}
          </p>

          {/* Institutional Assurances Cards */}
          <div className="grid gap-4 sm:grid-cols-3 text-left mb-10">
            {MAINTENANCE_DETAILS.assurances.map((item, idx) => (
              <div
                key={idx}
                className="card p-5 border border-border bg-surface/70 hover:bg-surface transition-colors"
              >
                <div className="flex items-center gap-2 mb-2 text-foreground font-semibold text-sm">
                  <svg
                    className="w-4 h-4 text-emerald-500 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  <span>{item.title}</span>
                </div>
                <p className="text-xs text-muted leading-relaxed">
                  {item.description}
                </p>
              </div>
            ))}
          </div>

          {/* Status & Official Contact Box */}
          <div className="card p-6 border border-border bg-surface/90 text-center max-w-lg mx-auto shadow-sm">
            <div className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
              Current System Status
            </div>
            <div className="text-sm font-medium text-foreground mb-4">
              {MAINTENANCE_DETAILS.status}
            </div>

            <div className="border-t border-border pt-4 mt-2">
              <p className="text-xs text-muted mb-3">
                For administrative inquiries, emergency governance, or questions, please contact the official desk:
              </p>
              <a
                href={`mailto:${MAINTENANCE_DETAILS.supportEmail}`}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-foreground text-background hover:opacity-90 transition-opacity shadow-sm"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                  />
                </svg>
                <span>{MAINTENANCE_DETAILS.supportEmail}</span>
              </a>
            </div>
          </div>
        </div>
      </main>

      {/* 3. Institutional Footer */}
      <footer className="border-t border-border py-6 text-center text-xs text-muted">
        <div className="mx-auto max-w-6xl px-6">
          <p>© {new Date().getFullYear()} Aeros Pay. Sovereign Financial & Virtual Economy Infrastructure.</p>
          <p className="mt-1 text-[11px] text-muted/80">
            All user accounts, corporate entities, balances, and historical archives are strictly preserved.
          </p>
        </div>
      </footer>
    </div>
  );
}

