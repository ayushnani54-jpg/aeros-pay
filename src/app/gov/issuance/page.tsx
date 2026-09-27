import Link from "next/link";
import { getAllIssuanceRequests } from "@/lib/queries";
import { getApprovalProgress } from "@/lib/issuance";
import { IssuanceStatusBadge } from "@/components/status-badge";
import { CreateIssuanceForm } from "@/components/forms/create-issuance-form";
import { CURRENCY_NAME } from "@/lib/constants";

export default async function GovIssuancePage() {
  const requests = await getAllIssuanceRequests();
  const withProgress = await Promise.all(
    requests.map(async (r) => ({ request: r, progress: await getApprovalProgress(r.id) })),
  );

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Aeros Issuance</h1>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">New issuance request</h2>
        <CreateIssuanceForm />
      </section>

      <section className="space-y-3">
        {withProgress.map(({ request, progress }) => (
          <Link
            key={request.id}
            href={`/gov/issuance/${request.id}`}
            className="card block p-5 hover:bg-surface"
          >
            <div className="flex items-center justify-between">
              <p className="font-medium">
                {request.amount.toLocaleString()} {CURRENCY_NAME}
              </p>
              <IssuanceStatusBadge status={request.status} />
            </div>
            <p className="mt-1 text-sm text-muted">{request.reason}</p>
            <p className="mt-2 text-xs text-muted">
              {progress.approveCount} of {progress.eligibleCount} users approved ·{" "}
              {new Date(request.createdAt).toLocaleString()}
            </p>
          </Link>
        ))}
        {withProgress.length === 0 && (
          <p className="text-sm text-muted">No issuance requests yet.</p>
        )}
      </section>
    </div>
  );
}
