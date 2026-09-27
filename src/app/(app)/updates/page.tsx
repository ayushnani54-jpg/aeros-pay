import { getCurrentUser } from "@/lib/auth";
import { getAllUpdates, getNotificationsForUser, getOpenIssuanceRequestsForUser } from "@/lib/queries";
import { IssuanceVoteButtons } from "@/components/forms/issuance-vote-buttons";
import { CURRENCY_NAME } from "@/lib/constants";

export default async function UpdatesPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const [updates, notifications, issuances] = await Promise.all([
    getAllUpdates(),
    getNotificationsForUser(user.id),
    getOpenIssuanceRequestsForUser(user.id),
  ]);

  return (
    <div className="space-y-8">
      {issuances.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Open Aeros issuance votes</h2>
          <div className="space-y-3">
            {issuances.map(({ request, myVote }) => (
              <div key={request.id} className="card p-5">
                <p className="font-medium">
                  Government requests {request.amount.toLocaleString()} {CURRENCY_NAME}
                </p>
                <p className="mt-1 text-sm text-muted">&ldquo;{request.reason}&rdquo;</p>
                <p className="mt-2 text-xs text-muted">
                  Opened {new Date(request.createdAt).toLocaleString()}
                </p>
                {myVote ? (
                  <p className="mt-3 text-sm">
                    Your vote: <span className="font-medium">{myVote}</span>
                  </p>
                ) : (
                  <IssuanceVoteButtons requestId={request.id} />
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold">Notifications</h2>
        {notifications.length === 0 ? (
          <p className="text-sm text-muted">You have no notifications yet.</p>
        ) : (
          <div className="card divide-y divide-border p-1">
            {notifications.map((n) => (
              <div key={n.id} className="px-4 py-3 text-sm">
                <p>{n.message}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {new Date(n.createdAt).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Announcements</h2>
        {updates.length === 0 ? (
          <p className="text-sm text-muted">No announcements yet.</p>
        ) : (
          <div className="space-y-3">
            {updates.map((u) => (
              <div key={u.id} className="card p-5">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">{u.title}</h3>
                  <span className="text-xs text-muted">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{u.content}</p>
                <p className="mt-2 text-xs text-muted">— {u.authorLabel}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
