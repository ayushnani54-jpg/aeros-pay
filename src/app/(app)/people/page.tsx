import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import { searchUsers } from "@/lib/queries";
import { StatusBadge, UserBadges } from "@/components/status-badge";

export default async function PeoplePage({ searchParams }: PageProps<"/people">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : "";

  const people = await searchUsers(q, ctx.user.id);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">People</h1>
        <p className="mt-1 text-sm text-muted">
          Find someone to pay. Balances and private history are never shown here.
        </p>
      </div>

      <form className="flex gap-2">
        <input
          name="q"
          defaultValue={q}
          className="input"
          placeholder="Search by name or username"
        />
        <button type="submit" className="btn btn-secondary">
          Search
        </button>
      </form>

      {people.length === 0 ? (
        <p className="text-sm text-muted">No one matched that search.</p>
      ) : (
        <div className="card divide-y divide-border">
          {people.map((person) => (
            <div key={person.id} className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <Link href={`/u/${person.username}`} className="font-medium hover:underline">
                    {person.displayName}
                  </Link>
                  <UserBadges official={person.badges.official} member={person.badges.member} />
                </span>
                <p className="truncate text-sm text-muted">@{person.username}</p>
                {person.companies.length > 0 && (
                  <p className="mt-1 truncate text-xs text-muted">
                    Runs{" "}
                    {person.companies.map((c, i) => (
                      <span key={c.username}>
                        {i > 0 && ", "}
                        <Link href={`/c/${c.username}`} className="hover:underline">
                          {c.name}
                        </Link>
                      </span>
                    ))}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {person.effectiveStatus !== "ACTIVE" && (
                  <StatusBadge status={person.effectiveStatus} />
                )}
                <Link href={`/pay?to=${person.username}`} className="btn btn-primary text-sm">
                  Pay
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
