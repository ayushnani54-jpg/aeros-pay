import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import {
  browseWantedRequests,
  expireOverdueWantedRequests,
  getWantedRequestsForRequester,
} from "@/lib/wanted";
import { CreateWantedForm } from "@/components/forms/marketplace-forms";
import { WantedStatusBadge } from "@/components/status-badge";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDate } from "@/lib/datetime";

/**
 * WANTED REQUESTS (spec §16).
 *
 * Browse is server-side and paginated. Nothing about the query is stored, and
 * lapsed requests are flipped to EXPIRED lazily here (the retention engine that
 * removes them arrives in Phase I; this only maintains the status).
 */
export default async function WantedPage({ searchParams }: PageProps<"/market/wanted">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  await expireOverdueWantedRequests().catch(() => undefined);

  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : "";
  const page = Math.max(
    Number.parseInt(typeof params.page === "string" ? params.page : "1", 10) || 1,
    1,
  );

  const [result, mine] = await Promise.all([
    browseWantedRequests({ q, page }),
    getWantedRequestsForRequester(ctx.wallet, 50),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/market" className="text-sm text-muted hover:text-foreground">
            ← Market
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Wanted</h1>
          <p className="mt-1 text-sm text-muted">
            What people and companies are looking for. Each party may reply once.
          </p>
        </div>
      </div>

      <form className="flex gap-2">
        <input
          name="q"
          defaultValue={q}
          className="input"
          maxLength={120}
          placeholder="Search requests by heading, description or category"
        />
        <button type="submit" className="btn btn-secondary">
          Search
        </button>
      </form>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted">
          Open requests
          {result.total > 0 ? ` (${result.total.toLocaleString()})` : ""}
        </h2>
        {result.rows.length === 0 ? (
          <div className="card p-5">
            <p className="text-sm text-muted">No open requests right now.</p>
          </div>
        ) : (
          <div className="card divide-y divide-border">
            {result.rows.map((row) => (
              <div
                key={row.request.id}
                className="flex flex-wrap items-start justify-between gap-3 p-4"
              >
                <div className="min-w-0">
                  <Link
                    href={`/market/wanted/${row.request.id}`}
                    className="font-medium hover:underline"
                  >
                    {row.request.heading}
                  </Link>
                  <p className="text-sm text-muted">
                    {row.requesterLabel} (@{row.requesterHandle}) · {row.request.category}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Wants {row.request.quantity.toLocaleString()} · budget{" "}
                    {row.request.budget.toLocaleString()} {CURRENCY_NAME} ·{" "}
                    {row.responseCount} repl{row.responseCount === 1 ? "y" : "ies"} ·{" "}
                    {formatDate(row.request.createdAt)}
                  </p>
                </div>
                <WantedStatusBadge status={row.request.status} />
              </div>
            ))}
          </div>
        )}

        {result.pageCount > 1 && (
          <div className="flex items-center justify-between gap-3">
            {result.page > 1 ? (
              <Link
                href={`/market/wanted?${new URLSearchParams({ q, page: String(result.page - 1) })}`}
                className="btn btn-secondary text-sm"
              >
                ← Previous
              </Link>
            ) : (
              <span />
            )}
            <span className="text-xs text-muted">
              Page {result.page} of {result.pageCount}
            </span>
            {result.page < result.pageCount ? (
              <Link
                href={`/market/wanted?${new URLSearchParams({ q, page: String(result.page + 1) })}`}
                className="btn btn-secondary text-sm"
              >
                Next →
              </Link>
            ) : (
              <span />
            )}
          </div>
        )}
      </section>

      {mine.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted">
            Posted by {ctx.company ? ctx.company.name : "you"}
          </h2>
          <div className="card divide-y divide-border">
            {mine.map((row) => (
              <div
                key={row.request.id}
                className="flex flex-wrap items-start justify-between gap-3 p-4"
              >
                <div className="min-w-0">
                  <Link
                    href={`/market/wanted/${row.request.id}`}
                    className="font-medium hover:underline"
                  >
                    {row.request.heading}
                  </Link>
                  <p className="mt-1 text-xs text-muted">
                    {row.responseCount} repl{row.responseCount === 1 ? "y" : "ies"} ·{" "}
                    {formatDate(row.request.createdAt)}
                  </p>
                </div>
                <WantedStatusBadge status={row.request.status} />
              </div>
            ))}
          </div>
        </section>
      )}

      <CreateWantedForm />
    </div>
  );
}
