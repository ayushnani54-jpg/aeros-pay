"use client";

import React, { useState } from "react";
import {
  proposePartnershipAction,
  respondToPartnershipAction,
  executePartnershipSettlementAction,
} from "@/actions/v5";
import { V5ActionForm } from "./action-feedback";
import { CURRENCY_NAME } from "@/lib/constants";

export interface SerializedPartnershipSettlement {
  id: string;
  settlementNumber: string;
  grossAmount: number;
  initiatorPayout: number;
  partnerPayout: number;
  govTaxDeducted: number;
  referenceNote: string;
  partnerTxRef: string;
  createdAt: string;
}

export interface SerializedCompanyPartnership {
  id: string;
  partnershipNumber: string;
  initiatorCompanyId: string;
  initiatorName: string;
  initiatorUsername: string;
  partnerCompanyId: string;
  partnerName: string;
  partnerUsername: string;
  title: string;
  termsDescription: string;
  initiatorShareBp: number;
  partnerShareBp: number;
  govTaxRateBp: number;
  totalSettledVolumeAeros: number;
  status: string;
  rejectionReason: string | null;
  settlements: SerializedPartnershipSettlement[];
  createdAt: string;
}

export function CompanyPartnershipsPanel({
  activeCompanyId,
  activeCompanyName,
  activeCompanyUsername,
  partnerships,
}: {
  activeCompanyId: string;
  activeCompanyName: string;
  activeCompanyUsername: string;
  partnerships: SerializedCompanyPartnership[];
}) {
  const [initiatorPct, setInitiatorPct] = useState<number>(50);
  const partnerPct = 100 - initiatorPct;

  return (
    <section className="card overflow-hidden">
      <div className="theme-partnership-banner p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <span className="rounded bg-amber-400/20 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-200">
              Corporate Alliances
            </span>
            <h2 className="mt-1 text-lg font-semibold">
              Company-to-Company Partnerships &amp; 50/50 Revenue Settlement
            </h2>
            <p className="mt-0.5 text-xs text-amber-100/85">
              Propose joint ventures with other Registered Companies, obtain Government regulatory
              approval, and execute atomic revenue/profit divisions preserving total Aeros supply.
            </p>
          </div>
          <span className="rounded-lg bg-black/25 px-3 py-1.5 font-mono text-xs font-semibold">
            @{activeCompanyUsername} · {partnerships.length} Partnership
            {partnerships.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      <div className="space-y-5 p-4 sm:p-5">
        {/* Propose New Partnership Form */}
        <div className="rounded-xl border border-border bg-surface/60 p-4">
          <h3 className="text-sm font-semibold">
            Propose Partnership from {activeCompanyName} (@{activeCompanyUsername})
          </h3>
          <V5ActionForm
            action={proposePartnershipAction}
            operationKey={`propose-partnership-${activeCompanyId}`}
            operationTitle="Proposing Company Partnership"
            processingDetail="Creating partnership proposal and notifying partner company..."
            className="mt-3 space-y-3"
            onSuccessReset
          >
            {(pending) => (
              <>
                <input type="hidden" name="initiatorCompanyId" value={activeCompanyId} />
                <input
                  type="hidden"
                  name="initiatorShareBp"
                  value={String(initiatorPct * 100)}
                />
                <input type="hidden" name="partnerShareBp" value={String(partnerPct * 100)} />

                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <label className="text-xs font-medium">Partner Company @username</label>
                    <input
                      name="partnerCompanyUsername"
                      placeholder="e.g. apex_logistics"
                      required
                      className="input mt-1 font-mono text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium">Partnership Title</label>
                    <input
                      name="title"
                      placeholder="e.g. Joint Supply Chain Venture"
                      required
                      minLength={3}
                      maxLength={160}
                      className="input mt-1 text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium">
                      Profit / Revenue Division ({initiatorPct}% / {partnerPct}%)
                    </label>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        type="range"
                        min={10}
                        max={90}
                        step={5}
                        value={initiatorPct}
                        onChange={(e) => setInitiatorPct(Number(e.target.value))}
                        className="w-full"
                      />
                      <button
                        type="button"
                        onClick={() => setInitiatorPct(50)}
                        className="rounded border border-border bg-white px-2 py-1 font-mono text-[11px] font-semibold"
                      >
                        50/50
                      </button>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium">
                    Partnership Terms, Responsibilities &amp; Expense/Profit Sharing Rules
                  </label>
                  <textarea
                    name="termsDescription"
                    rows={2}
                    required
                    minLength={10}
                    placeholder="Specify how revenue, expenses, and joint deliverables will be divided between both companies..."
                    className="input mt-1 text-xs"
                  />
                </div>

                <button type="submit" disabled={pending} className="btn btn-primary text-xs">
                  {pending ? "Submitting Proposal..." : "Send Partnership Proposal"}
                </button>
              </>
            )}
          </V5ActionForm>
        </div>

        {/* Active & Pending Partnerships List */}
        {partnerships.length === 0 ? (
          <p className="text-xs text-muted">
            No company partnerships recorded for @{activeCompanyUsername} yet.
          </p>
        ) : (
          <div className="space-y-3">
            {partnerships.map((p) => {
              const isInvitedPartner = p.partnerCompanyId === activeCompanyId;
              const isApproved = p.status === "APPROVED_BY_GOVERNMENT";

              return (
                <div
                  key={p.id}
                  className="rounded-xl border border-border p-4 transition-all hover:border-black/30"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-bold">{p.partnershipNumber}</span>
                        <span className="font-semibold">{p.title}</span>
                        <span
                          className={`badge ${
                            isApproved
                              ? "badge-active"
                              : p.status.includes("REJECTED")
                                ? "badge-banned"
                                : "badge-suspended"
                          }`}
                        >
                          {p.status}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted">
                        <strong>{p.initiatorName}</strong> (@{p.initiatorUsername},{" "}
                        {(p.initiatorShareBp / 100).toFixed(0)}%) ⇄{" "}
                        <strong>{p.partnerName}</strong> (@{p.partnerUsername},{" "}
                        {(p.partnerShareBp / 100).toFixed(0)}%) · Gov Tax:{" "}
                        {(p.govTaxRateBp / 100).toFixed(2)}%
                      </p>
                      <p className="mt-1 text-xs">{p.termsDescription}</p>
                    </div>

                    <div className="text-right text-xs">
                      <span className="text-muted">Total Settled Volume</span>
                      <p className="font-mono text-sm font-bold">
                        {p.totalSettledVolumeAeros.toLocaleString("en-IN")} {CURRENCY_NAME}
                      </p>
                    </div>
                  </div>

                  {/* Partner Response Controls when status is PROPOSED */}
                  {p.status === "PROPOSED" && isInvitedPartner && (
                    <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                      <V5ActionForm
                        action={respondToPartnershipAction}
                        operationKey={`accept-part-${p.id}`}
                        operationTitle={`Accepting Partnership ${p.partnershipNumber}`}
                        className="inline-block"
                      >
                        {(pending) => (
                          <>
                            <input type="hidden" name="partnershipId" value={p.id} />
                            <input type="hidden" name="decision" value="ACCEPT" />
                            <button
                              type="submit"
                              disabled={pending}
                              className="btn btn-primary px-3 py-1 text-xs"
                            >
                              {pending ? "Accepting..." : "Accept Partnership (Send to Gov)"}
                            </button>
                          </>
                        )}
                      </V5ActionForm>

                      <V5ActionForm
                        action={respondToPartnershipAction}
                        operationKey={`reject-part-${p.id}`}
                        operationTitle={`Declining Partnership ${p.partnershipNumber}`}
                        className="inline-block"
                      >
                        {(pending) => (
                          <>
                            <input type="hidden" name="partnershipId" value={p.id} />
                            <input type="hidden" name="decision" value="REJECT" />
                            <button
                              type="submit"
                              disabled={pending}
                              className="btn btn-danger px-3 py-1 text-xs"
                            >
                              Decline
                            </button>
                          </>
                        )}
                      </V5ActionForm>
                    </div>
                  )}

                  {/* Atomic 50/50 Revenue Settlement Form when APPROVED_BY_GOVERNMENT */}
                  {isApproved && (
                    <div className="mt-3 border-t border-border pt-3">
                      <V5ActionForm
                        action={executePartnershipSettlementAction}
                        operationKey={`settle-part-${p.id}`}
                        operationTitle={`Executing Partnership Settlement (${p.partnershipNumber})`}
                        processingDetail="Atomically splitting gross revenue between partner companies and Treasury..."
                        className="flex flex-wrap items-end gap-2"
                        onSuccessReset
                      >
                        {(pending) => (
                          <>
                            <input type="hidden" name="partnershipId" value={p.id} />
                            <div className="w-36">
                              <label className="text-[11px] font-medium text-muted">
                                Gross Revenue ({CURRENCY_NAME})
                              </label>
                              <input
                                name="grossAmount"
                                type="number"
                                min={1}
                                step={1}
                                placeholder="1000"
                                required
                                className="input mt-0.5 font-mono text-xs"
                              />
                            </div>
                            <div className="min-w-[200px] flex-1">
                              <label className="text-[11px] font-medium text-muted">
                                Settlement Reference Note
                              </label>
                              <input
                                name="referenceNote"
                                placeholder="e.g. Q3 Joint Contract Revenue Split"
                                required
                                minLength={2}
                                className="input mt-0.5 text-xs"
                              />
                            </div>
                            <button
                              type="submit"
                              disabled={pending}
                              className="btn btn-primary text-xs"
                            >
                              {pending
                                ? "Settling..."
                                : `Settle ${(p.initiatorShareBp / 100).toFixed(0)}/${(p.partnerShareBp / 100).toFixed(0)} Split`}
                            </button>
                          </>
                        )}
                      </V5ActionForm>
                    </div>
                  )}

                  {/* Recent Settlements History */}
                  {p.settlements.length > 0 && (
                    <div className="mt-3 space-y-1.5 rounded-lg bg-surface p-2.5 text-[11px]">
                      <p className="font-semibold text-muted">Recent Atomic Settlements</p>
                      {p.settlements.map((s) => (
                        <div
                          key={s.id}
                          className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-1"
                        >
                          <span>
                            <strong className="font-mono">{s.settlementNumber}</strong> · Gross{" "}
                            <strong>{s.grossAmount.toLocaleString("en-IN")} A</strong> → Initiator{" "}
                            {s.initiatorPayout.toLocaleString("en-IN")} A / Partner{" "}
                            {s.partnerPayout.toLocaleString("en-IN")} A / Tax{" "}
                            {s.govTaxDeducted.toLocaleString("en-IN")} A
                          </span>
                          <span className="font-mono text-muted">Tx: {s.partnerTxRef}</span>
                        </div>
                      ))}
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

