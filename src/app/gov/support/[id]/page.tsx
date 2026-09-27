import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getMessagesForThread,
  getThreadById,
  markThreadReadByGovernment,
} from "@/lib/support";
import { SupportReplyForm, SupportStatusButtons } from "@/components/forms/support-forms";
import { SupportStatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/datetime";

export default async function GovSupportThread({ params }: PageProps<"/gov/support/[id]">) {
  const { id } = await params;
  const row = await getThreadById(id);
  if (!row) notFound();

  const messages = await getMessagesForThread(row.thread.id);
  await markThreadReadByGovernment(row.thread.id).catch(() => undefined);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/gov/support" className="text-sm text-muted hover:text-foreground">
          ← Support inbox
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{row.displayName}</h1>
            <p className="mt-1 text-sm text-muted">
              <Link href={`/gov/users/${row.userId}`} className="underline">
                @{row.username}
              </Link>
            </p>
          </div>
          <SupportStatusBadge status={row.thread.status} />
        </div>
      </div>

      <div className="card p-4">
        <p className="mb-2 text-sm font-medium">Conversation status</p>
        <SupportStatusButtons threadId={row.thread.id} current={row.thread.status} />
      </div>

      {messages.length === 0 ? (
        <div className="card p-6">
          <p className="text-sm text-muted">No messages in this conversation.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {messages.map((message) => {
            const fromGov = message.senderType === "GOVERNMENT";
            return (
              <div key={message.id} className={`card p-4 ${fromGov ? "bg-surface" : ""}`}>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-medium">
                    {fromGov ? `Government (${message.senderLabel})` : `@${message.senderLabel}`}
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

      <SupportReplyForm threadId={row.thread.id} />
    </div>
  );
}
