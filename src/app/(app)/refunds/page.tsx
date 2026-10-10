import { getActingContext } from "@/lib/auth";
import { getGovernmentFeatureFlags } from "@/lib/queries";
import { getUserExchangePurchases } from "@/lib/exchange";
import { getUserRefundRequests } from "@/lib/refunds";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDateTime } from "@/lib/datetime";
import { CreateRefundRequestForm } from "@/components/v4/v4-forms";

export default async function RefundCenterPage() {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const { user } = ctx;
  const [flags, refundRequests, purchases] = await Promise.all([
    getGovernmentFeatureFlags(),
    getUserRefundRequests(user.id, 50),
    getUserExchangePurchases(user.id, 50),
  ]);

  const creditedPurchases = purchases
    .filter((p) => p.status === "CREDITED")
    .map((p) => ({
      id: p.id,
      purchaseNumber: p.purchaseNumber,
      packageTitleSnapshot: p.packageTitleSnapshot,
      totalAerosSnapshot: p.totalAerosSnapshot,
      inrPriceSnapshot: p.inrPriceSnapshot,
    }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Refund Center</h1>
        <p className="mt-1 text-sm text-muted">
          Submit a refund request for a virtual {CURRENCY_NAME} transaction or an Aeros Exchange
          package acquisition, and track Government review decisions.
        </p>
      </div>

      <section className="card border-[#111111] p-5 text-xs text-muted space-y-1.5">
        <p className="font-semibold text-foreground">
          How Refund Requests Are Reviewed &amp; Settled
        </p>
        <p>
          • <strong>Virtual {CURRENCY_NAME} Refund / Adjustment:</strong> Requests a virtual{" "}
          {CURRENCY_NAME} credit from the Government Treasury in relation to a ledger transaction or
          platform issue.
        </p>
        <p>
          • <strong>Aeros Exchange Package Refund:</strong> Requests a reversal of a credited
          Exchange package acquisition. When approved and completed, the credited virtual{" "}
          {CURRENCY_NAME} are reclaimed from your personal wallet to the Government Treasury and
          any external INR refund is handled manually outside the virtual ledger.
        </p>
      </section>

      {!flags.refundCenterEnabled ? (
        <section className="card p-6 text-center">
          <h2 className="font-medium">New refund submissions are currently paused</h2>
          <p className="mt-1 text-sm text-muted">
            The Government has temporarily disabled new refund requests. You can still view the
            status and decision notes of your existing requests below.
          </p>
        </section>
      ) : (
        <section className="card p-5">
          <h2 className="mb-3 font-medium">Submit a refund request</h2>
          <CreateRefundRequestForm creditedPurchases={creditedPurchases} />
        </section>
      )}

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Your refund requests</h2>
        {refundRequests.length === 0 ? (
          <p className="text-sm text-muted">
            You have not submitted any refund requests yet.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {refundRequests.map((r) => (
              <div key={r.id} className="space-y-1.5 py-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-semibold">{r.refundNumber}</span>
                    <span className="rounded bg-surface px-2 py-0.5 text-xs text-muted">
                      {r.refundType === "EXCHANGE_PACKAGE_REFUND"
                        ? "Exchange Package Refund"
                        : `Virtual ${CURRENCY_NAME} Refund`}
                    </span>
                    <RefundStatusBadge status={r.status} />
                  </div>
                  <div className="font-semibold">
                    {r.requestedAerosAmount.toLocaleString()} {CURRENCY_NAME}
                    {r.inrReferenceAmount !== null && (
                      <span className="ml-1 text-xs font-normal text-muted">
                        (₹{r.inrReferenceAmount.toLocaleString("en-IN")} ref)
                      </span>
                    )}
                  </div>
                </div>

                <p className="text-xs">
                  <span className="text-muted">Reason:</span> {r.reason}
                </p>
                {r.userNotes && (
                  <p className="text-xs text-muted">Additional details: {r.userNotes}</p>
                )}
                {r.sourceTxRef && (
                  <p className="text-xs text-muted">
                    Referenced transaction: <span className="font-mono">{r.sourceTxRef}</span>
                  </p>
                )}

                {r.delayReason && (
                  <div className="rounded-md border border-[#e6d5a7] bg-[#fdf8e8] p-2.5 text-xs">
                    <p className="font-medium">Delay notice from Government:</p>
                    <p className="mt-0.5 text-muted">{r.delayReason}</p>
                    {r.expectedResolutionAt && (
                      <p className="mt-0.5 text-[11px] text-muted">
                        Expected resolution: {formatDateTime(r.expectedResolutionAt)}
                      </p>
                    )}
                  </div>
                )}

                {r.governmentDecisionNote && (
                  <div className="rounded-md bg-surface p-2.5 text-xs">
                    <p className="font-medium">Government decision note:</p>
                    <p className="mt-0.5 text-muted">{r.governmentDecisionNote}</p>
                    {r.approvedAerosAmount !== null && (
                      <p className="mt-0.5 text-[11px] text-muted">
                        Approved amount: {r.approvedAerosAmount.toLocaleString()} {CURRENCY_NAME}
                        {r.settlementTxRef ? ` · Settlement ref: ${r.settlementTxRef}` : ""}
                      </p>
                    )}
                  </div>
                )}

                <p className="text-[11px] text-muted">
                  Submitted {formatDateTime(r.createdAt)} · Last updated{" "}
                  {formatDateTime(r.updatedAt)}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function RefundStatusBadge({ status }: { status: string }) {
  const cls =
    status === "COMPLETED" || status === "APPROVED"
      ? "badge badge-active"
      : status === "REJECTED"
        ? "badge badge-banned"
        : status === "DELAYED"
          ? "badge badge-suspended"
          : "badge badge-pending";
  return <span className={cls}>{status.replaceAll("_", " ")}</span>;
}
