import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import { getComplaintsForCompany } from "@/lib/ip";
import { IpComplaintForm } from "@/components/forms/company-forms";
import { IpStatusBadge } from "@/components/status-badge";
import { effectiveCompanyStatus } from "@/lib/status";
import { formatDate } from "@/lib/datetime";

export default async function CompanyComplaintsPage() {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const company = ctx.company ?? ctx.availableCompanies[0] ?? null;
  if (!company) {
    return (
      <div className="card p-6">
        <p className="text-sm text-muted">
          You need an approved company first.{" "}
          <Link href="/my-company" className="underline">
            Apply for one
          </Link>
          .
        </p>
      </div>
    );
  }

  const { filed, against } = await getComplaintsForCompany(company.id);
  const canFile = effectiveCompanyStatus(company) === "APPROVED";

  return (
    <div className="space-y-6">
      <div>
        <Link href="/my-company" className="text-sm text-muted hover:text-foreground">
          ← {company.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">IP & copyright</h1>
      </div>

      {canFile && <IpComplaintForm />}

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted">Complaints you filed</h2>
        {filed.length === 0 ? (
          <div className="card p-5">
            <p className="text-sm text-muted">You have not filed any complaints.</p>
          </div>
        ) : (
          <div className="card divide-y divide-border">
            {filed.map((row) => (
              <div key={row.complaint.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{row.complaint.reason}</p>
                    <p className="text-sm text-muted">
                      Against {row.accusedName} (@{row.accusedUsername})
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {row.complaint.complaintNumber} ·{" "}
                      {formatDate(row.complaint.createdAt)}
                    </p>
                  </div>
                  <IpStatusBadge status={row.complaint.status} />
                </div>
                {row.complaint.decision && (
                  <p className="mt-2 text-sm">
                    <span className="text-muted">Decision: </span>
                    {row.complaint.decision.replace(/_/g, " ").toLowerCase()}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted">Complaints about your company</h2>
        {against.length === 0 ? (
          <div className="card p-5">
            <p className="text-sm text-muted">No complaints have been filed against you.</p>
          </div>
        ) : (
          <div className="card divide-y divide-border">
            {against.map((row) => (
              <div key={row.complaint.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{row.complaint.reason}</p>
                    <p className="text-sm text-muted">Filed by {row.complainantName}</p>
                    <p className="mt-1 text-xs text-muted">
                      {row.complaint.complaintNumber} ·{" "}
                      {formatDate(row.complaint.createdAt)}
                    </p>
                  </div>
                  <IpStatusBadge status={row.complaint.status} />
                </div>
                {row.complaint.decision && (
                  <p className="mt-2 text-sm">
                    <span className="text-muted">Government decision: </span>
                    {row.complaint.decision.replace(/_/g, " ").toLowerCase()}
                    {row.complaint.decisionReason ? ` — ${row.complaint.decisionReason}` : ""}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-xs text-muted">
        The Government reviews each complaint on its evidence. Sales figures are context only —
        there is no rule that the bigger company automatically wins.
      </p>
    </div>
  );
}
