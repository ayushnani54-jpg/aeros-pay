import { getRecentAuditLogs } from "@/lib/queries";

export default async function GovAuditPage() {
  const logs = await getRecentAuditLogs(300);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Audit Log</h1>
      <div className="card overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Actor</th>
              <th className="px-4 py-3">Target</th>
              <th className="px-4 py-3">Details</th>
              <th className="px-4 py-3">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {logs.map((log) => (
              <tr key={log.id}>
                <td className="px-4 py-3 font-medium">{log.action}</td>
                <td className="px-4 py-3">{log.actorLabel ?? log.actorType}</td>
                <td className="px-4 py-3 text-muted">
                  {log.targetType ? `${log.targetType} ${log.targetId ?? ""}` : "—"}
                </td>
                <td className="max-w-xs truncate px-4 py-3 font-mono text-xs text-muted">
                  {log.metadata ? JSON.stringify(log.metadata) : ""}
                </td>
                <td className="px-4 py-3 text-muted">{new Date(log.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted">
                  No audit events yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
