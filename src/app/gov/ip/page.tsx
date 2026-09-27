import Link from "next/link";
import { getAllComplaints } from "@/lib/ip";
import { IpStatusBadge } from "@/components/status-badge";

export default async function GovIpPage() {
  const complaints = await getAllComplaints();
  const open = complaints.filter((c) => c.complaint.status !== "RESOLVED");
  const resolved = complaints.filter((c) => c.complaint.status === "RESOLVED");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">IP & copyright complaints</h1>
        <p className="mt-1 text-sm text-muted">
          Decide each complaint on its evidence. Sales and activity figures are context only —
          there is deliberately no rule that the busier company wins.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted">Awaiting a decision ({open.length})</h2>
        {open.length === 0 ? (
          <div className="card p-5">
            <p className="text-sm text-muted">Nothing awaiting review.</p>
          </div>
        ) : (
          <div className="card divide-y divide-border">
            {open.map((row) => (
              <Link
                key={row.complaint.id}
                href={`/gov/ip/${row.complaint.id}`}
                className="flex flex-wrap items-start justify-between gap-3 p-4 hover:bg-surface"
              >
                <div className="min-w-0">
                  <p className="font-medium">{row.complaint.reason}</p>
                  <p className="text-sm text-muted">
                    {row.complainantName} → {row.accusedName} (@{row.accusedUsername})
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {row.complaint.complaintNumber} ·{" "}
                    {new Date(row.complaint.createdAt).toLocaleDateString()}
                    {row.accusedStrikes > 0
                      ? ` · accused has ${row.accusedStrikes} strike(s)`
                      : ""}
                  </p>
                </div>
                <IpStatusBadge status={row.complaint.status} />
              </Link>
            ))}
          </div>
        )}
      </section>

      {resolved.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted">Decided</h2>
          <div className="card divide-y divide-border">
            {resolved.map((row) => (
              <Link
                key={row.complaint.id}
                href={`/gov/ip/${row.complaint.id}`}
                className="flex flex-wrap items-start justify-between gap-3 p-4 text-sm hover:bg-surface"
              >
                <div>
                  <p className="font-medium">{row.complaint.reason}</p>
                  <p className="text-xs text-muted">
                    {row.complainantName} → {row.accusedName} ·{" "}
                    {row.complaint.complaintNumber}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-medium">
                    {row.complaint.decision?.replace(/_/g, " ").toLowerCase()}
                  </p>
                  <p className="text-xs text-muted">
                    {row.complaint.decidedAt
                      ? new Date(row.complaint.decidedAt).toLocaleDateString()
                      : ""}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
