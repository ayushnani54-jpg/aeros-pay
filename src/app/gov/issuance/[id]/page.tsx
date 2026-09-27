import { notFound } from "next/navigation";
import { getIssuanceRequestById, getIssuanceVotesDetailed } from "@/lib/queries";
import { getApprovalProgress } from "@/lib/issuance";
import { IssuanceStatusBadge } from "@/components/status-badge";
import { ExecuteIssuanceButton } from "@/components/forms/execute-issuance-button";
import { CURRENCY_NAME } from "@/lib/constants";

export default async function GovIssuanceDetailPage({
  params,
}: PageProps<"/gov/issuance/[id]">) {
  const { id } = await params;
  const request = await getIssuanceRequestById(id);
  if (!request) notFound();

  const [progress, votes] = await Promise.all([
    getApprovalProgress(request.id),
    getIssuanceVotesDetailed(request.id),
  ]);

  // V2: a simple majority of eligible voters is enough (spec §37).
  const canExecute =
    request.status === "OPEN" && progress.thresholdReached && progress.eligibleCount > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">
            {request.amount.toLocaleString()} {CURRENCY_NAME} issuance request
          </h1>
          <p className="mt-1 text-sm text-muted">{request.reason}</p>
        </div>
        <IssuanceStatusBadge status={request.status} />
      </div>

      <section className="card p-5">
        <p className="text-sm text-muted">
          {progress.approveCount} approvals · {progress.requiredToPass} needed to pass ·{" "}
          {progress.eligibleCount} eligible voters
        </p>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface">
          <div
            className="h-full bg-black"
            style={{
              width: `${progress.eligibleCount > 0 ? (progress.approveCount / progress.eligibleCount) * 100 : 0}%`,
            }}
          />
        </div>
        <p className="mt-2 text-xs text-muted">
          {progress.rejectCount} rejected · {progress.pendingCount} not yet voted
        </p>

        {request.status === "OPEN" && (
          <div className="mt-4">
            <ExecuteIssuanceButton requestId={request.id} disabled={!canExecute} />
            {!canExecute && (
              <p className="mt-2 text-xs text-muted">
                Execution requires 100% approval from every eligible user.
              </p>
            )}
          </div>
        )}
        {request.status === "EXECUTED" && (
          <p className="mt-4 text-sm text-success">
            Executed {request.executedAt ? new Date(request.executedAt).toLocaleString() : ""} —
            ref {request.executedTxRef}
          </p>
        )}
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Votes</h2>
        <div className="divide-y divide-border">
          {votes.map((v) => (
            <div key={v.userId} className="flex items-center justify-between py-2 text-sm">
              <span className="font-mono">@{v.username}</span>
              <span
                className={
                  v.vote === "APPROVE"
                    ? "text-success"
                    : v.vote === "REJECT"
                      ? "text-danger"
                      : "text-muted"
                }
              >
                {v.vote ?? "Not voted"}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
