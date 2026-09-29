import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getUserByUsername } from "@/lib/queries";
import { getCompaniesForOwner } from "@/lib/companies";
import { StatusBadge, UserBadges } from "@/components/status-badge";
import { badgesOf } from "@/lib/badges";
import { effectiveUserStatus } from "@/lib/status";
import { formatDate } from "@/lib/datetime";

/**
 * Public user profile.
 *
 * Deliberately shows no balance and no transaction history — private
 * financial data stays with the account owner and the Government (spec §30).
 *
 * V3 Phase G: it also shows the Government's identity labels, if any. They are
 * LABELS — rendering them here is the only thing they do. Nothing about what
 * this account may do is derived from them, and no authorization check anywhere
 * reads the columns (src/lib/badges.ts).
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
  const badges = badgesOf(person);

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
            <div className="mt-2">
              <UserBadges official={badges.official} member={badges.member} />
            </div>
          </div>
          <StatusBadge status={status} />
        </div>

        <p className="mt-4 text-sm text-muted">
          Member since {formatDate(person.createdAt)}
        </p>

        {(badges.official || badges.member) && (
          <p className="mt-2 text-xs text-muted">
            {badges.official
              ? "Linked by the Government as an Official Government User."
              : "Tagged by the Government as a Government Member."}{" "}
            This is a label only — it grants no administrative powers, and this account trades
            like any other.
          </p>
        )}

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
