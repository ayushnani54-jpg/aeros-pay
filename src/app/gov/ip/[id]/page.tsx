import Link from "next/link";
import { notFound } from "next/navigation";
import { getComplaintById } from "@/lib/ip";
import { getCompanyAdminProfile } from "@/lib/queries";
import { IpDecisionForm } from "@/components/forms/gov-forms";
import { IpStatusBadge } from "@/components/status-badge";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDate, formatDateTime } from "@/lib/datetime";

export default async function GovIpDetail({ params }: PageProps<"/gov/ip/[id]">) {
  const { id } = await params;
  const row = await getComplaintById(id);
  if (!row) notFound();

  const { complaint } = row;
  const [complainant, accused] = await Promise.all([
    getCompanyAdminProfile(complaint.complainantCompanyId),
    getCompanyAdminProfile(complaint.accusedCompanyId),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/gov/ip" className="text-sm text-muted hover:text-foreground">
          ← IP complaints
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{complaint.reason}</h1>
            <p className="mt-1 font-mono text-sm text-muted">{complaint.complaintNumber}</p>
          </div>
          <IpStatusBadge status={complaint.status} />
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-2">
        <PartyCard title="Complainant" profile={complainant} />
        <PartyCard title="Accused" profile={accused} />
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">The complaint</h2>
        <div className="space-y-4 text-sm">
          <div>
            <p className="font-medium">What happened</p>
            <p className="mt-1 whitespace-pre-line text-muted">{complaint.description}</p>
          </div>
          <div>
            <p className="font-medium">Evidence provided</p>
            <p className="mt-1 whitespace-pre-line text-muted">{complaint.evidence}</p>
          </div>
          {complaint.referenceMaterial && (
            <div>
              <p className="font-medium">Reference material</p>
              <p className="mt-1 whitespace-pre-line text-muted">
                {complaint.referenceMaterial}
              </p>
            </div>
          )}
          <p className="text-xs text-muted">
            Filed {formatDateTime(complaint.createdAt)}
          </p>
        </div>
      </section>

      {complaint.status === "RESOLVED" ? (
        <section className="card p-5">
          <h2 className="mb-2 font-medium">Decision</h2>
          <p className="text-sm font-medium">
            {complaint.decision?.replace(/_/g, " ").toLowerCase()}
          </p>
          <p className="mt-2 text-sm text-muted">{complaint.decisionReason}</p>
          <p className="mt-2 text-xs text-muted">
            Decided by {complaint.decidedBy} on{" "}
            {complaint.decidedAt ? formatDateTime(complaint.decidedAt) : ""}
          </p>
        </section>
      ) : (
        <section className="card border-[#111111] p-5">
          <h2 className="mb-3 font-medium">Record a decision</h2>
          <IpDecisionForm complaintId={complaint.id} />
        </section>
      )}
    </div>
  );
}

function PartyCard({
  title,
  profile,
}: {
  title: string;
  profile: Awaited<ReturnType<typeof getCompanyAdminProfile>>;
}) {
  if (!profile) {
    return (
      <div className="card p-5">
        <p className="text-xs text-muted">{title}</p>
        <p className="mt-1 text-sm text-muted">Company no longer exists.</p>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <p className="text-xs text-muted">{title}</p>
      <Link
        href={`/gov/companies/${profile.company.id}`}
        className="mt-1 block font-medium hover:underline"
      >
        {profile.company.name}
      </Link>
      <p className="text-sm text-muted">@{profile.company.username}</p>
      <dl className="mt-3 space-y-1 text-xs text-muted">
        <div className="flex justify-between">
          <dt>Owner</dt>
          <dd>@{profile.ownerUsername}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Lifetime sales</dt>
          <dd>
            {profile.salesTotal.toLocaleString()} {CURRENCY_NAME}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt>IP strikes</dt>
          <dd>{profile.company.strikes}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Registered</dt>
          <dd>{formatDate(profile.company.createdAt)}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-muted">
        Figures are context only and must not decide the outcome on their own.
      </p>
    </div>
  );
}
