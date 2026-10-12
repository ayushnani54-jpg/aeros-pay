"use client";

import Link from "next/link";
import { V5ActionForm } from "@/components/v5/action-feedback";
import {
  updateMarketIntervalAction,
  reviewLeverageRequestAction,
} from "@/actions/v5";
import { CURRENCY_NAME, MARKET_UPDATE_INTERVALS } from "@/lib/constants";
import type { LeverageRequest } from "@/db/schema";

interface LeverageRequestRow {
  request: LeverageRequest;
  username: string;
  displayName: string;
  currentMaxLeverage: number;
  balance: number;
}

export function GovMarketV5Panel({
  currentIntervalMinutes,
  leverageRequests,
}: {
  currentIntervalMinutes: number;
  leverageRequests: LeverageRequestRow[];
}) {
  const pendingRequests = leverageRequests.filter((r) => r.request.status === "PENDING");
  const reviewedRequests = leverageRequests.filter((r) => r.request.status !== "PENDING");

  return (
    <div className="space-y-6">
      {/* V5 Market Update Interval Configuration */}
      <section className="card border-indigo-200 bg-gradient-to-br from-indigo-50/50 via-white to-white p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded bg-indigo-900 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white">
                Market Engine
              </span>
              <h2 className="text-base font-semibold">
                Market Price Update Interval &amp; 5m Candle Synchronization
              </h2>
            </div>
            <p className="mt-1 text-xs text-muted">
              Controls the deterministic price tick cadence (<strong>1 minute</strong> default or{" "}
              <strong>5 minutes</strong>). Separate from chart candle timeframes (
              <span className="font-mono">5m</span>, <span className="font-mono">15m</span>,{" "}
              <span className="font-mono">1h</span>), which aggregate all ticks inside their active
              boundary window.
            </p>
          </div>
          <span className="rounded-full border border-indigo-300 bg-indigo-100 px-3 py-1 font-mono text-xs font-semibold text-indigo-950">
            Active Cadence: Every {currentIntervalMinutes} min
          </span>
        </div>

        <V5ActionForm
          action={updateMarketIntervalAction}
          label="Updating market price interval"
          bannerTitle="Synchronizing Market Update Cadence"
          bannerDetail="Persisting new market update interval and writing Government audit log..."
          className="mt-4 flex flex-wrap items-end gap-3"
        >
          <div>
            <label className="label text-xs">Update Interval</label>
            <select
              name="marketUpdateIntervalMinutes"
              defaultValue={String(currentIntervalMinutes === 5 ? 5 : 1)}
              className="input min-w-[220px] text-sm"
            >
              {MARKET_UPDATE_INTERVALS.map((mins) => (
                <option key={mins} value={mins}>
                  Every {mins} minute{mins > 1 ? "s" : ""} {mins === 1 ? "(Default)" : "(Macro Cadence)"}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-primary text-xs">
            Save Interval Setting
          </button>
        </V5ActionForm>
      </section>

      {/* V5 Citizen Leverage Progression Queue */}
      <section className="card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">
              Citizen Leverage Progression Requests (2x → 4x → 8x → 10x)
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              Citizens start at <strong>2x</strong> maximum leverage and must request progressive
              tier unlocks up to the <strong>10x</strong> sovereign ceiling.
            </p>
          </div>
          <span className="rounded-full bg-surface px-2.5 py-1 text-xs font-semibold">
            {pendingRequests.length} Pending Review
          </span>
        </div>

        {pendingRequests.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted">
            No pending Citizen leverage upgrade requests in the queue.
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {pendingRequests.map(({ request: req, username, displayName, currentMaxLeverage, balance }) => (
              <div
                key={req.id}
                className="rounded-lg border border-amber-300 bg-amber-50/40 p-3.5 text-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/gov/users/${req.userId}`}
                        className="font-semibold hover:underline"
                      >
                        {displayName} (@{username})
                      </Link>
                      <span className="rounded bg-amber-200 px-2 py-0.5 font-mono text-xs font-bold text-amber-950">
                        {req.currentLeverage}x → {req.requestedLeverage}x
                      </span>
                      <span className="text-xs text-muted">
                        Current Max: {currentMaxLeverage}x · Wallet: {balance.toLocaleString("en-IN")}{" "}
                        {CURRENCY_NAME}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      Submitted {new Date(req.createdAt).toLocaleString("en-IN")}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <V5ActionForm
                      action={reviewLeverageRequestAction}
                      label={`Approving ${req.requestedLeverage}x leverage for @${username}`}
                      className="flex items-center gap-1.5"
                    >
                      <input type="hidden" name="requestId" value={req.id} />
                      <input type="hidden" name="decision" value="APPROVE" />
                      <input
                        type="text"
                        name="adminNotes"
                        placeholder="Optional approval note..."
                        className="input h-8 w-40 text-xs"
                      />
                      <button
                        type="submit"
                        className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800"
                      >
                        Approve {req.requestedLeverage}x
                      </button>
                    </V5ActionForm>

                    <V5ActionForm
                      action={reviewLeverageRequestAction}
                      label={`Rejecting ${req.requestedLeverage}x leverage for @${username}`}
                      className="flex items-center gap-1.5"
                    >
                      <input type="hidden" name="requestId" value={req.id} />
                      <input type="hidden" name="decision" value="REJECT" />
                      <input
                        type="text"
                        name="rejectionReason"
                        placeholder="Reason for rejection..."
                        className="input h-8 w-40 text-xs"
                      />
                      <button
                        type="submit"
                        className="rounded border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-800 hover:bg-red-100"
                      >
                        Reject
                      </button>
                    </V5ActionForm>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {reviewedRequests.length > 0 && (
          <div className="mt-5 border-t border-border pt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
              Recent Leverage Review History ({reviewedRequests.slice(0, 12).length})
            </h3>
            <div className="divide-y divide-border text-xs">
              {reviewedRequests.slice(0, 12).map(({ request: req, username, displayName }) => (
                <div
                  key={req.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <div>
                    <span className="font-medium">
                      {displayName} (@{username})
                    </span>{" "}
                    ·{" "}
                    <span className="font-mono font-semibold">
                      {req.currentLeverage}x → {req.requestedLeverage}x
                    </span>
                    {req.rejectionReason ? ` · Reason: ${req.rejectionReason}` : ""}
                    {req.adminNotes ? ` · Note: ${req.adminNotes}` : ""}
                  </div>
                  <span
                    className={`rounded px-2 py-0.5 font-semibold ${
                      req.status === "APPROVED"
                        ? "bg-emerald-50 text-emerald-800"
                        : "bg-red-50 text-red-700"
                    }`}
                  >
                    {req.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

