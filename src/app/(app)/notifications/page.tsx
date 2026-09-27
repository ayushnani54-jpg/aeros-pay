import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { getNotificationsForUser } from "@/lib/queries";
import { MarkAllReadButton } from "@/components/forms/mark-read-button";

/**
 * Personal notifications — separate from the public Updates feed (spec §34).
 */
export default async function NotificationsPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const notifications = await getNotificationsForUser(user.id, 150);
  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
          <p className="mt-1 text-sm text-muted">
            Things that happened to your account. Community announcements live in{" "}
            <Link href="/updates" className="underline">
              Updates
            </Link>
            .
          </p>
        </div>
        {unread > 0 && <MarkAllReadButton unread={unread} />}
      </div>

      {notifications.length === 0 ? (
        <div className="card p-6">
          <p className="text-sm text-muted">Nothing yet.</p>
        </div>
      ) : (
        <div className="card divide-y divide-border">
          {notifications.map((n) => {
            const body = (
              <>
                <p className={n.read ? "text-sm text-muted" : "text-sm font-medium"}>
                  {n.message}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {new Date(n.createdAt).toLocaleString()}
                </p>
              </>
            );

            return (
              <div key={n.id} className="flex items-start gap-3 p-4">
                <span
                  className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                    n.read ? "bg-transparent" : "bg-[#111111]"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  {n.href ? (
                    <Link href={n.href} className="block hover:underline">
                      {body}
                    </Link>
                  ) : (
                    body
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
