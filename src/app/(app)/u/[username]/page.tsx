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
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="h-16 w-16 rounded-full bg-surface border border-border flex items-center justify-center font-bold text-xl text-foreground select-none">
              {person.displayName.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold tracking-tight text-foreground">{person.displayName}</h1>
                <span className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold ${
                  person.accessLevel === "ACTIVE_MEMBER"
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                }`}>
                  {person.accessLevel === "ACTIVE_MEMBER" ? "ACTIVE CITIZEN" : "LIMITED CITIZEN"}
                </span>
              </div>
              <p className="mt-0.5 font-mono text-sm text-muted">@{person.username}</p>
              <div className="mt-2">
                <UserBadges official={badges.official} member={badges.member} />
              </div>
            </div>
          </div>
          <StatusBadge status={status} />
        </div>

        {person.bio && (
          <div className="mt-4 p-3.5 rounded-lg bg-surface text-sm text-foreground border border-border/70">
            <p className="text-xs font-semibold uppercase text-muted mb-1">About</p>
            <p className="whitespace-pre-line leading-relaxed">{person.bio}</p>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted">
          <span>Member since {formatDate(person.createdAt)}</span>
          {person.publicContactEmail && (
            <>
              <span>•</span>
              <span>
                Public Contact:{" "}
                <a
                  href={`mailto:${person.publicContactEmail}`}
                  className="font-semibold text-foreground underline"
                >
                  {person.publicContactEmail}
                </a>
              </span>
            </>
          )}
        </div>

        {(badges.official || badges.member) && (
          <p className="mt-3 text-xs text-muted">
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
        {isSelf && <p className="mt-5 text-sm text-muted">This is your public citizen profile.</p>}
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
