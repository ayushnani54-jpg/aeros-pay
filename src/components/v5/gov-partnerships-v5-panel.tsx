"use client";

import { V5ActionForm } from "@/components/v5/action-feedback";
import { reviewPartnershipByGovAction } from "@/actions/v5";
import { CURRENCY_NAME } from "@/lib/constants";
import type { CompanyPartnership, PartnershipSettlement } from "@/db/schema";

interface GovPartnershipItem {
  partnership: CompanyPartnership;
  initiatorName: string;
  initiatorUsername: string;
  partnerName: string;
  partnerUsername: string;
  settlements: PartnershipSettlement[];
}

export function GovPartnershipsV5Panel({
  partnerships,
  defaultTaxRateBp,
}: {
  partnerships: GovPartnershipItem[];
  defaultTaxRateBp: number;
}) {
  const awaitingGov = partnerships.filter(
    (p) => p.partnership.status === "ACCEPTED_BY_PARTNER",
  );
  const activeOrOther = partnerships.filter(
    (p) => p.partnership.status !== "ACCEPTED_BY_PARTNER",
  );

  return (
    <section className="card border-blue-200 bg-gradient-to-br from-blue-50/40 via-white to-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-blue-900 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white">
              V5 Corporate Alliances
            </span>
            <h2 className="text-base font-semibold">
              Company-to-Company Partnerships &amp; 50/50 Revenue Sharing
            </h2>
          </div>
          <p className="mt-1 text-xs text-muted">
            Once a partner company accepts a proposal, the Government reviews the joint venture,
            configures the regulatory tax rate (in basis points), and activates atomic revenue
            settlements.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded-full bg-amber-100 px-2.5 py-1 font-semibold text-amber-900">
            {awaitingGov.length} Awaiting Approval
          </span>
          <span className="rounded-full bg-surface px-2.5 py-1 font-semibold">
            {partnerships.length} Total
          </span>
        </div>
      </div>

      {/* Pending Government Review Queue */}
      {awaitingGov.length > 0 && (
        <div className="mt-4 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-900">
            Pending Regulatory Approval ({awaitingGov.length})
          </h3>
          {awaitingGov.map((item) => {
            const p = item.partnership;
            return (
              <div
                key={p.id}
                className="rounded-lg border border-amber-300 bg-amber-50/50 p-4 text-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-muted">
                        {p.partnershipNumber}
                      </span>
                      <span className="font-semibold">{p.title}</span>
                      <span className="rounded bg-blue-100 px-2 py-0.5 font-mono text-xs font-semibold text-blue-900">
                        Split: {(p.initiatorShareBp / 100).toFixed(0)}% /{" "}
                        {(p.partnerShareBp / 100).toFixed(0)}%
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      Initiator: <strong>{item.initiatorName}</strong> (@{item.initiatorUsername}) ↔
                      Partner: <strong>{item.partnerName}</strong> (@{item.partnerUsername})
                    </p>
                    <p className="mt-1.5 rounded border border-amber-200 bg-white/80 p-2 text-xs text-foreground">
                      {p.termsDescription}
                    </p>
                  </div>

                  <div className="flex flex-col gap-2 sm:items-end">
                    <V5ActionForm
                      action={reviewPartnershipByGovAction}
                      label={`Approving partnership ${p.partnershipNumber}`}
                      bannerTitle="Activating Company Partnership"
                      bannerDetail="Recording Government approval and tax rate..."
                      className="flex flex-wrap items-center gap-2"
                    >
                      <input type="hidden" name="partnershipId" value={p.id} />
                      <input type="hidden" name="decision" value="APPROVE" />
                      <div className="flex items-center gap-1.5">
                        <label className="text-xs text-muted">Tax (bp):</label>
                        <input
                          type="number"
                          name="govTaxRateBp"
                          min={0}
                          max={3000}
                          defaultValue={defaultTaxRateBp}
                          className="input h-8 w-20 font-mono text-xs"
                        />
                      </div>
                      <button
                        type="submit"
                        className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800"
                      >
                        Approve &amp; Activate
                      </button>
                    </V5ActionForm>

                    <V5ActionForm
                      action={reviewPartnershipByGovAction}
                      label={`Rejecting partnership ${p.partnershipNumber}`}
                      className="flex flex-wrap items-center gap-2"
                    >
                      <input type="hidden" name="partnershipId" value={p.id} />
                      <input type="hidden" name="decision" value="REJECT" />
                      <input
                        type="text"
                        name="rejectionReason"
                        placeholder="Rejection reason..."
                        className="input h-8 w-44 text-xs"
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
            );
          })}
        </div>
      )}

      {/* All Partnerships & Settlement Ledger */}
      <div className="mt-4">
        {activeOrOther.length === 0 && awaitingGov.length === 0 ? (
          <p className="text-xs text-muted">
            No company-to-company partnerships have been proposed yet.
          </p>
        ) : (
          <div className="divide-y divide-border text-xs">
            {activeOrOther.map((item) => {
              const p = item.partnership;
              return (
                <div key={p.id} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-semibold">{p.partnershipNumber}</span>
                      <span className="font-medium text-sm">{p.title}</span>
                      <span className="text-muted">
                        @{item.initiatorUsername} ({(p.initiatorShareBp / 100).toFixed(0)}%) ↔ @
                        {item.partnerUsername} ({(p.partnerShareBp / 100).toFixed(0)}%)
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono">
                        Settled: {p.totalSettledVolumeAeros.toLocaleString("en-IN")} {CURRENCY_NAME}
                      </span>
                      <span className="text-muted">
                        Tax: {(p.govTaxRateBp / 100).toFixed(2)}%
                      </span>
                      <span
                        className={`rounded px-2 py-0.5 font-semibold ${
                          p.status === "APPROVED_BY_GOVERNMENT"
                            ? "bg-emerald-50 text-emerald-800"
                            : p.status === "PROPOSED"
                              ? "bg-blue-50 text-blue-800"
                              : "bg-red-50 text-red-700"
                        }`}
                      >
                        {p.status}
                      </span>
                    </div>
                  </div>
                  {item.settlements.length > 0 && (
                    <div className="mt-2 rounded bg-surface/60 p-2 text-[11px] text-muted">
                      Recent settlements:{" "}
                      {item.settlements
                        .slice(0, 3)
                        .map(
                          (s) =>
                            `${s.settlementNumber} (Gross: ${s.grossAmount} A → Init: ${s.initiatorPayout} A, Partner: ${s.partnerPayout} A, Tax: ${s.govTaxDeducted} A)`,
                        )
                        .join(" · ")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

