import Link from "next/link";
import { getRecentAuditLogs } from "@/lib/queries";
import { formatDateTime } from "@/lib/datetime";

/**
 * Audit log. Entries are never deleted — the archive view simply reveals
 * entries that have been hidden from the active list (spec §51).
 */
export default async function GovAuditPage({ searchParams }: PageProps<"/gov/audit">) {
  const sp = await searchParams;
  const showArchived = sp.archived === "1";

  const logs = await getRecentAuditLogs(300, showArchived);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
          <p className="mt-1 text-sm text-muted">
            Every administrative and system action. Entries are permanent; archiving only hides
            them from this view.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/gov/audit"
            className={!showArchived ? "btn btn-primary text-sm" : "btn btn-secondary text-sm"}
          >
            Active
          </Link>
          <Link
            href="/gov/audit?archived=1"
            className={showArchived ? "btn btn-primary text-sm" : "btn btn-secondary text-sm"}
          >
            Include archived
          </Link>
        </div>
      </div>

      {logs.length === 0 ? (
        <div className="card p-6">
          <p className="text-sm text-muted">No audit entries.</p>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Actor</th>
                <th className="px-4 py-3">Target</th>
                <th className="px-4 py-3">Change</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {logs.map((log) => (
                <tr key={log.id} className={log.archivedAt ? "opacity-60" : ""}>
                  <td className="px-4 py-3 font-medium">
                    {log.action.replace(/_/g, " ")}
                    {log.archivedAt && (
                      <span className="ml-2 text-xs text-muted">(archived)</span>
                    )}
                  </td>
                  <td className="px-4 py-3">{log.actorLabel ?? "—"}</td>
                  <td className="px-4 py-3 text-xs text-muted">
                    {log.targetType ? `${log.targetType}` : "—"}
                    {log.targetId ? (
                      <span className="block font-mono">{log.targetId.slice(0, 8)}…</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {log.previousValue || log.newValue ? (
                      <span>
                        {log.previousValue ?? "—"} → {log.newValue ?? "—"}
                      </span>
                    ) : log.metadata ? (
                      <span className="font-mono text-muted">
                        {JSON.stringify(log.metadata).slice(0, 60)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">{log.reason ?? "—"}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-muted">
                    {formatDateTime(log.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
