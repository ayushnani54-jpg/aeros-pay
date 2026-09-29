import { getCurrentUser } from "@/lib/auth";
import {
  getMessagesForThread,
  getOrCreateThread,
  markThreadReadByUser,
} from "@/lib/support";
import { SupportMessageForm } from "@/components/forms/support-forms";
import { SupportStatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/datetime";

/**
 * The user's private conversation with the Government. There is exactly one
 * thread per user, and a user can only ever see their own (spec §32).
 */
export default async function ContactGovernmentPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const thread = await getOrCreateThread(user.id);
  const messages = await getMessagesForThread(thread.id);
  await markThreadReadByUser(user.id).catch(() => undefined);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contact Government</h1>
          <p className="mt-1 text-sm text-muted">
            A private conversation between you and the Government. No one else can see it.
          </p>
        </div>
        <SupportStatusBadge status={thread.status} />
      </div>

      {messages.length === 0 ? (
        <div className="card p-6">
          <p className="text-sm text-muted">
            No messages yet. Send the first one below and the Government will reply here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {messages.map((message) => {
            const fromGov = message.senderType === "GOVERNMENT";
            return (
              <div
                key={message.id}
                className={`card p-4 ${fromGov ? "bg-surface" : ""}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-medium">
                    {fromGov ? "Government" : "You"}
                  </p>
                  <p className="text-xs text-muted">
                    {formatDateTime(message.createdAt)}
                  </p>
                </div>
                <p className="mt-2 whitespace-pre-line text-sm">{message.body}</p>
              </div>
            );
          })}
        </div>
      )}

      <SupportMessageForm />
    </div>
  );
}
