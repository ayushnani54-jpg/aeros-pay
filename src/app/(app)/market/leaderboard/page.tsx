import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import { getLeaderboard, type LeaderboardSort } from "@/lib/leaderboard";
import { RatingStars } from "@/components/rating-stars";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDate } from "@/lib/datetime";

/**
 * THE LEADERBOARD — last 30 days, computed live (V3 Phase F, spec §23).
 *
 * Every number on this page is derived on THIS request from orders, ratings and
 * listings that already exist. Loading the page writes nothing: there is no
 * leaderboard table, no daily snapshot, no rank history and no per-viewer
 * record that anyone looked (src/lib/leaderboard.ts explains why that is
 * structural rather than a promise).
 *
 * It is deliberately NOT a rich list. The columns are activity — orders
 * completed, what they were worth, how recent buyers rated, how busy the
 * listing page has been — so a dormant company with a large balance appears
 * nowhere. No balance column is read to build it.
 */

const TABS: { value: LeaderboardSort; label: string }[] = [
  { value: "orders", label: "Completed orders" },
  { value: "sales", label: "Sales value" },
  { value: "rating", label: "Recent rating" },
  { value: "activity", label: "Activity" },
];

export default async function LeaderboardPage({
  searchParams,
}: PageProps<"/market/leaderboard">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const params = await searchParams;
  const raw = typeof params.sort === "string" ? params.sort : "";
  const sort: LeaderboardSort = TABS.some((t) => t.value === raw)
    ? (raw as LeaderboardSort)
    : "orders";

  const board = await getLeaderboard({ sort });

  return (
    <div className="space-y-5">
      <div>
        <Link href="/market" className="text-sm text-muted hover:text-foreground">
          ← Market
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Leaderboard</h1>
        <p className="mt-1 text-sm text-muted" data-testid="leaderboard-window">
          The last {board.windowDays} days, from {formatDate(board.windowStart)} onwards. Worked
          out live each time this page opens — nothing is stored, and there is no ranking by
          balance.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <Link
            key={tab.value}
            href={`/market/leaderboard?sort=${tab.value}`}
            className={
              sort === tab.value ? "btn btn-primary text-xs" : "btn btn-secondary text-xs"
            }
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {board.rows.length === 0 ? (
        <div className="card p-5">
          <p className="text-sm text-muted">
            Nothing to rank yet — no orders, ratings or new listings in the last{" "}
            {board.windowDays} days.
          </p>
        </div>
      ) : (
        <div className="card divide-y divide-border">
          {board.rows.map((row) => (
            <div
              key={row.companyId}
              className="flex flex-wrap items-center gap-3 p-4"
              data-testid="leaderboard-row"
            >
              <span className="w-8 shrink-0 text-lg font-semibold tabular-nums text-muted">
                {row.rank}
              </span>
              <div className="min-w-0 flex-1">
                <Link
                  href={`/c/${row.companyUsername}`}
                  className="font-medium hover:underline"
                >
                  {row.companyName}
                </Link>
                <p className="truncate text-xs text-muted">
                  @{row.companyUsername} · {row.category}
                  {row.governmentOwned ? " · Government stewardship" : ""}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  <span>
                    {row.completedOrders.toLocaleString()} completed{" "}
                    {row.completedOrders === 1 ? "order" : "orders"}
                  </span>
                  <span>
                    {row.salesValue.toLocaleString()} {CURRENCY_NAME} in sales
                  </span>
                  <span>{row.marketplaceActivity.toLocaleString()} market activity</span>
                </div>
              </div>
              <div className="shrink-0 text-right">
                {row.recentRating === null ? (
                  <span className="text-xs text-muted">No recent ratings</span>
                ) : (
                  <span className="flex items-center justify-end gap-2 text-sm">
                    <RatingStars stars={row.recentRating} />
                    <span className="font-medium">{row.recentRating.toFixed(1)}</span>
                    <span className="text-xs text-muted">({row.recentRatingCount})</span>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-muted">
        Ranked on what companies did, not on what they hold. Balances are private and are never
        used here.
      </p>
    </div>
  );
}
