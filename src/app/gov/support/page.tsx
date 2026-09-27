import Link from "next/link";
import { getSupportInbox } from "@/lib/support";
import { SupportStatusBadge } from "@/components/status-badge";
import { formatDate } from "@/lib/datetime";

export default async function GovSupportPage() {
  const threads = await getSupportInbox();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Support inbox</h1>
        <p className="mt-1 text-sm text-muted">
          Private conversations between the Government and individual users. There is no
          user-to-user messaging.
        </p>
      </div>

      {threads.length === 0 ? (
        <div className="card p-6">
          <p className="text-sm text-muted">No one has written in yet.</p>
        </div>
      ) : (
        <div className="card divide-y divide-border">
          {threads.map(({ thread, username, displayName, lastMessage }) => (
            <Link
              key={thread.id}
              href={`/gov/support/${thread.id}`}
              className="flex flex-wrap items-start justify-between gap-3 p-4 hover:bg-surface"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-medium">{displayName}</p>
                  {thread.unreadForGovernment > 0 && (
                    <span className="badge badge-suspended">
                      {thread.unreadForGovernment} new
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted">@{username}</p>
                {lastMessage && (
                  <p className="mt-1 line-clamp-1 text-sm text-muted">{lastMessage}</p>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <SupportStatusBadge status={thread.status} />
                {thread.lastMessageAt && (
                  <p className="text-xs text-muted">
                    {formatDate(thread.lastMessageAt)}
                  </p>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
