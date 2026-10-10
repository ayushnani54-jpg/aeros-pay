import Link from "next/link";
import { getCurrentGovernment } from "@/lib/auth";
import { getGovRefundRequests } from "@/lib/refunds";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDateTime } from "@/lib/datetime";
import { GovRefundDecisionForm } from "@/components/v4/v4-forms";

export default async function GovRefundsPage() {
  const gov = await getCurrentGovernment();
  if (!gov) return null;

  const rows = await getGovRefundRequests(100);
  const openRows = rows.filter(
    (r) => r.refund.status !== "COMPLETED" && r.refund.status !== "REJECTED",
  );
  const closedRows = rows.filter(
    (r) => r.refund.status === "COMPLETED" || r.refund.status === "REJECTED",
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Refund Center — Government Decisions
          </h1>
          <p className="mt-1 text-sm text-muted">
            Review user refund requests, record delay notices, and execute virtual {CURRENCY_NAME}{" "}
            Treasury settlements.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`badge ${
              gov.refundCenterEnabled ? "badge-active" : "badge-suspended"
            }`}
          >
            Refund Center: {gov.refundCenterEnabled ? "ENABLED" : "DISABLED"}
          </span>
          <Link href="/gov/control-room" className="btn btn-secondary text-xs">
            Feature Controls
          </Link>
        </div>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="card p-4">
          <p className="text-xs text-muted">Open / Pending</p>
          <p className="mt-1 text-xl font-semibold">{openRows.length}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">Delayed</p>
          <p className="mt-1 text-xl font-semibold">
            {rows.filter((r) => r.refund.status === "DELAYED").length}
          </p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">Completed</p>
          <p className="mt-1 text-xl font-semibold">
            {rows.filter((r) => r.refund.status === "COMPLETED").length}
          </p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">Rejected</p>
          <p className="mt-1 text-xl font-semibold">
            {rows.filter((r) => r.refund.status === "REJECTED").length}
          </p>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">
          Active refund requests ({openRows.length})
        </h2>
        {openRows.length === 0 ? (
          <p className="text-sm text-muted">
            No open refund requests require attention right now.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {openRows.map(({ refund: r, username, displayName }) => (
              <div key={r.id} className="py-4 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-semibold">{r.refundNumber}</span>
                      <Link
                        href={`/gov/users/${r.userId}`}
                        className="font-medium hover:underline"
                      >
                        {displayName} (@{username})
                      </Link>
                      <span className="rounded bg-surface px-2 py-0.5 text-xs text-muted">
                        {r.refundType}
                      </span>
                      <span className="badge badge-pending">{r.status}</span>
                    </div>
                    <p className="mt-1 text-xs">
                      <span className="text-muted">User reason:</span> {r.reason}
                    </p>
                    {r.userNotes && (
                      <p className="mt-0.5 text-xs text-muted">
                        User notes: {r.userNotes}
                      </p>
                    )}
                    {r.sourceTxRef && (
                      <p className="mt-0.5 text-xs text-muted">
                        Referenced tx:{" "}
                        <Link
                          href={`/gov/transactions?txRef=${r.sourceTxRef}`}
                          className="font-mono underline"
                        >
                          {r.sourceTxRef}
                        </Link>
                      </p>
                    )}
                    <p className="mt-0.5 text-[11px] text-muted">
                      Submitted {formatDateTime(r.createdAt)}
                      {r.settlementTxRef ? ` · Settled (${r.settlementTxRef})` : ""}
                    </p>
                  </div>
                  <div className="text-right font-semibold">
                    {r.requestedAerosAmount.toLocaleString()} {CURRENCY_NAME}
                    {r.inrReferenceAmount !== null && (
                      <p className="text-xs font-normal text-muted">
                        ₹{r.inrReferenceAmount.toLocaleString("en-IN")} package tier
                      </p>
                    )}
                  </div>
                </div>

                <div className="mt-3">
                  <GovRefundDecisionForm
                    refund={{
                      id: r.id,
                      refundNumber: r.refundNumber,
                      refundType: r.refundType,
                      requestedAerosAmount: r.requestedAerosAmount,
                      approvedAerosAmount: r.approvedAerosAmount,
                      status: r.status,
                      settlementTxRef: r.settlementTxRef,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">
          Completed &amp; rejected refund history ({closedRows.length})
        </h2>
        {closedRows.length === 0 ? (
          <p className="text-sm text-muted">No closed refund requests yet.</p>
        ) : (
          <div className="divide-y divide-border text-sm">
            {closedRows.map(({ refund: r, username, displayName }) => (
              <div
                key={r.id}
                className="flex flex-wrap items-start justify-between gap-3 py-3"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-medium">{r.refundNumber}</span>
                    <Link
                      href={`/gov/users/${r.userId}`}
                      className="font-medium hover:underline"
                    >
                      {displayName} (@{username})
                    </Link>
                    <span className="rounded bg-surface px-2 py-0.5 text-xs text-muted">
                      {r.refundType}
                    </span>
                    <span
                      className={`badge ${
                        r.status === "COMPLETED" ? "badge-active" : "badge-banned"
                      }`}
                    >
                      {r.status}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">Reason: {r.reason}</p>
                  {r.governmentDecisionNote && (
                    <p className="mt-0.5 text-xs">
                      <span className="text-muted">Decision note:</span>{" "}
                      {r.governmentDecisionNote}
                    </p>
                  )}
                  <p className="mt-0.5 text-[11px] text-muted">
                    Submitted {formatDateTime(r.createdAt)}
                    {r.settlementTxRef ? ` · Settlement ref ${r.settlementTxRef}` : ""}
                  </p>
                </div>
                <div className="text-right font-semibold">
                  {(r.approvedAerosAmount ?? r.requestedAerosAmount).toLocaleString()}{" "}
                  {CURRENCY_NAME}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
