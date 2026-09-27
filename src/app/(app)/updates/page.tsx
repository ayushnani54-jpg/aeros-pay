import { getCurrentUser } from "@/lib/auth";
import { getAllUpdates, getOpenIssuanceRequestsForUser } from "@/lib/queries";
import { getApprovalProgress } from "@/lib/issuance";
import { IssuanceVoteButtons } from "@/components/forms/issuance-vote-buttons";
import { CURRENCY_NAME } from "@/lib/constants";

export default async function UpdatesPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const [updates, openIssuances] = await Promise.all([
    getAllUpdates(),
    getOpenIssuanceRequestsForUser(user.id),
  ]);

  const withProgress = await Promise.all(
    openIssuances.map(async (row) => ({
      ...row,
      progress: await getApprovalProgress(row.request.id),
    })),
  );

  return (
    <div className="space-y-6">
      {withProgress.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Open Aeros issuance votes</h2>
          {withProgress.map(({ request, myVote, progress }) => (
            <div key={request.id} className="card p-5">
              <p className="font-medium">
                Government requests {request.amount.toLocaleString()} {CURRENCY_NAME}
              </p>
              <p className="mt-1 text-sm text-muted">&ldquo;{request.reason}&rdquo;</p>
              {request.note && <p className="mt-1 text-sm text-muted">{request.note}</p>}
              <p className="mt-2 text-xs text-muted">
                Opened {new Date(request.createdAt).toLocaleString()}
              </p>

              <div className="mt-3">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface">
                  <div
                    className="h-full bg-black"
                    style={{
                      width: `${Math.min(100, (progress.approveCount / Math.max(1, progress.requiredToPass)) * 100)}%`,
                    }}
                  />
                </div>
                <p className="mt-1 text-xs text-muted">
                  {progress.approveCount} of {progress.requiredToPass} approvals needed ·{" "}
                  {progress.eligibleCount} eligible voters · a simple majority passes
                </p>
              </div>

              <div className="mt-3">
                {myVote ? (
                  <p className="text-sm">
                    Your vote: <span className="font-medium">{myVote}</span>
                  </p>
                ) : (
                  <IssuanceVoteButtons requestId={request.id} />
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Announcements</h2>
        {updates.length === 0 ? (
          <div className="card p-6">
            <p className="text-sm text-muted">No announcements yet.</p>
          </div>
        ) : (
          updates.map((update) => (
            <article key={update.id} className="card p-5">
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-medium">{update.title}</h3>
                <span className="shrink-0 text-xs text-muted">
                  {new Date(update.createdAt).toLocaleDateString()}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-line text-sm text-muted">{update.content}</p>
              <p className="mt-2 text-xs text-muted">— {update.authorLabel}</p>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
