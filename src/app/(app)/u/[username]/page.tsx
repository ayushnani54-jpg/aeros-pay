import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getUserByUsername } from "@/lib/queries";
import { getCompaniesForOwner } from "@/lib/companies";
import { StatusBadge } from "@/components/status-badge";
import { effectiveUserStatus } from "@/lib/status";
import { formatDate } from "@/lib/datetime";

/**
 * Public user profile.
 *
 * Deliberately shows no balance and no transaction history — private
 * financial data stays with the account owner and the Government (spec §30).
 */
export default async function PublicUserProfile({ params }: PageProps<"/u/[username]">) {
  const viewer = await getCurrentUser();
  if (!viewer) return null;

  const { username } = await params;
  const person = await getUserByUsername(username.toLowerCase());
  if (!person) notFound();

  const companies = (await getCompaniesForOwner(person.id)).filter(
    (c) => c.status === "APPROVED",
  );
  const status = effectiveUserStatus(person);
  const isSelf = person.id === viewer.id;

  return (
    <div className="space-y-5">
      <Link href="/people" className="text-sm text-muted hover:text-foreground">
        ← People
      </Link>

      <div className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{person.displayName}</h1>
            <p className="mt-1 font-mono text-sm text-muted">@{person.username}</p>
          </div>
          <StatusBadge status={status} />
        </div>

        <p className="mt-4 text-sm text-muted">
          Member since {formatDate(person.createdAt)}
        </p>

        {!isSelf && status !== "BANNED" && (
          <Link href={`/pay?to=${person.username}`} className="btn btn-primary mt-5 inline-block">
            Pay {person.displayName}
          </Link>
        )}
        {isSelf && <p className="mt-5 text-sm text-muted">This is you.</p>}
      </div>

      {companies.length > 0 && (
        <div className="card p-5">
          <h2 className="mb-3 font-medium">Companies</h2>
          <div className="divide-y divide-border">
            {companies.map((company) => (
              <Link
                key={company.id}
                href={`/c/${company.username}`}
                className="flex items-center justify-between py-3 text-sm hover:underline"
              >
                <div>
                  <p className="font-medium">{company.name}</p>
                  <p className="text-xs text-muted">
                    @{company.username} · {company.category}
                  </p>
                </div>
                <span className="text-muted">View →</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-muted">
        Balances and payment history are private. Only the account owner and the Government can
        see them.
      </p>
    </div>
  );
}
