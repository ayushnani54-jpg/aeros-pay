"use client";

import Link from "next/link";
import { useState } from "react";

/**
 * THE AD SLOT (V3 Phase E, spec §24)
 * ===========================================================================
 *
 * One promotion, rendered as an ordinary card in the existing design language —
 * the same `.card` border and the same `.badge` as everything else on the page.
 *
 * DISMISSAL STORES NOTHING. ANYWHERE.
 * -----------------------------------
 * The X is `useState(false) → true` and that is the entire mechanism. It is not
 * written to a row, not to a cookie, not to localStorage and not sent to the
 * server, so the ad comes back on the next page load. That is deliberate: the
 * spec says store nothing about dismissals, and a localStorage key would still
 * be storing something about what a viewer did.
 *
 * There is likewise no impression ping when this renders and no click handler
 * that reports anything — the CTA is a plain `<Link>`. The server never learns
 * that this component was shown or used.
 */
export type PromotionSlotAd = {
  id: string;
  heading: string;
  shortDescription: string;
  ctaLabel: string;
  destination: string;
  companyName: string | null;
  companyUsername: string | null;
  official: boolean;
};

export function PromotionSlot({ ad }: { ad: PromotionSlotAd | null }) {
  // Per-render state only. Nothing leaves this component.
  const [dismissed, setDismissed] = useState(false);

  if (!ad || dismissed) return null;

  return (
    <section className="card p-5" data-testid="promotion-slot">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="badge badge-suspended">
              {ad.official ? "Government notice" : "Promoted"}
            </span>
            {ad.companyName && (
              <span className="text-xs text-muted">
                {ad.companyName}
                {ad.companyUsername ? ` (@${ad.companyUsername})` : ""}
              </span>
            )}
          </div>
          <h2 className="mt-2 font-medium">{ad.heading}</h2>
          <p className="mt-1 text-sm text-muted">{ad.shortDescription}</p>
          <Link href={ad.destination} className="btn btn-secondary mt-3 inline-block text-sm">
            {ad.ctaLabel}
          </Link>
        </div>
        <button
          type="button"
          aria-label="Dismiss this promotion"
          title="Dismiss"
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-muted hover:bg-surface hover:text-foreground"
        >
          ✕
        </button>
      </div>
      <p className="mt-3 text-xs text-muted">
        Dismissing this hides it for now only — nothing about ads is recorded.
      </p>
    </section>
  );
}
