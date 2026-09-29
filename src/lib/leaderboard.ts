import "server-only";
import { db } from "@/db/client";
import {
  companies,
  marketplaceOffers,
  marketplaceOrders,
} from "@/db/schema";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { addIstDays } from "./datetime";
import { getRecentRatingAverages } from "./ratings";
import { LEADERBOARD_SIZE, LEADERBOARD_WINDOW_DAYS } from "./constants";

/**
 * LEADERBOARD (V3 Phase F, spec §23)
 * ===========================================================================
 *
 * A rolling "last 30 days" board, COMPUTED LIVE from data that already exists
 * for other reasons. This file is the whole feature, and the two things that
 * matter about it are both absences.
 *
 * 1. IT STORES NOTHING. There is no leaderboard table, no daily snapshot row,
 *    no rank history and no per-user analytics row — not in this file and not
 *    in src/db/schema.ts. Every function here is a SELECT. The module does not
 *    import `insert`, `update` or `delete` at all, so "computing the
 *    leaderboard writes nothing" is a property of the code rather than a
 *    promise: there is no write statement to audit. test_v3_social.ts proves
 *    it from the outside too, by counting every row in the database before and
 *    after a computation and asserting the counts are identical.
 *
 * 2. IT IS NOT A WEALTH RANKING. `companies.balance` and `users.balance` are
 *    never selected here, and no metric is derived from either. The board
 *    ranks ACTIVITY — orders a company actually completed, what those orders
 *    were worth, how recent buyers rated it, and how much it is listing — so
 *    a rich dormant company ranks nowhere and a busy new one ranks well. The
 *    spec explicitly rules out a balance leaderboard and the only honest way
 *    to keep that is not to have the column in the query.
 *
 * WINDOW. "Last 30 days" is 30 IST CALENDAR days: the window starts at IST
 * midnight 30 days ago (`addIstDays(now, -30)`), so everybody looking at the
 * board sees the same window boundary regardless of their own timezone or the
 * server's, and the boundary moves once a day rather than continuously.
 *
 * COST. Three grouped SELECTs and one small join in memory, then a sort. The
 * order query is served by `marketplace_orders_completed_idx`, the partial
 * index on `completed_at WHERE status = 'COMPLETED'` that exists for exactly
 * this window scan; ratings use `ratings_rated_company_idx` and listings use
 * `marketplace_offers_company_idx`.
 */

export type LeaderboardSort = "orders" | "sales" | "rating" | "activity";

export type LeaderboardRow = {
  rank: number;
  companyId: string;
  companyName: string;
  companyUsername: string;
  category: string;
  governmentOwned: boolean;
  /** Orders that reached COMPLETED inside the window. */
  completedOrders: number;
  /** Sum of those orders' subtotals, in whole Aeros. */
  salesValue: number;
  /** Mean stars from ratings written inside the window, or null. */
  recentRating: number | null;
  recentRatingCount: number;
  /** Orders received plus listings published inside the window. */
  marketplaceActivity: number;
};

export type Leaderboard = {
  windowDays: number;
  /** IST midnight, `windowDays` IST days ago. */
  windowStart: Date;
  generatedAt: Date;
  sort: LeaderboardSort;
  rows: LeaderboardRow[];
};

/** The start of the rolling window: IST midnight, `windowDays` IST days ago. */
export function leaderboardWindowStart(
  now: Date = new Date(),
  windowDays: number = LEADERBOARD_WINDOW_DAYS,
): Date {
  return addIstDays(now, -windowDays);
}

/**
 * Computes the board. Read-only.
 *
 * `sort` only changes the ORDER of the rows, never which companies are
 * eligible: a company appears when it did something in the window.
 */
export async function getLeaderboard(
  options: { sort?: LeaderboardSort; limit?: number; now?: Date } = {},
): Promise<Leaderboard> {
  const now = options.now ?? new Date();
  const sort: LeaderboardSort = options.sort ?? "orders";
  const limit = options.limit ?? LEADERBOARD_SIZE;
  const windowStart = leaderboardWindowStart(now);

  // --- completed orders and what they were worth ---------------------------
  const completedRows = await db
    .select({
      companyId: marketplaceOrders.sellerCompanyId,
      orders: sql<number>`count(*)::int`,
      value: sql<number>`coalesce(sum(${marketplaceOrders.subtotal}), 0)::int`,
    })
    .from(marketplaceOrders)
    .where(
      and(
        eq(marketplaceOrders.status, "COMPLETED"),
        gte(marketplaceOrders.completedAt, windowStart),
      ),
    )
    .groupBy(marketplaceOrders.sellerCompanyId);

  // --- orders received in the window, whatever became of them --------------
  const receivedRows = await db
    .select({
      companyId: marketplaceOrders.sellerCompanyId,
      received: sql<number>`count(*)::int`,
    })
    .from(marketplaceOrders)
    .where(gte(marketplaceOrders.createdAt, windowStart))
    .groupBy(marketplaceOrders.sellerCompanyId);

  // --- listings published in the window ------------------------------------
  const listingRows = await db
    .select({
      companyId: marketplaceOffers.companyId,
      listings: sql<number>`count(*)::int`,
    })
    .from(marketplaceOffers)
    .where(gte(marketplaceOffers.createdAt, windowStart))
    .groupBy(marketplaceOffers.companyId);

  const ratings = await getRecentRatingAverages(windowStart);

  const ids = new Set<string>();
  for (const row of completedRows) ids.add(row.companyId);
  for (const row of receivedRows) ids.add(row.companyId);
  for (const row of listingRows) ids.add(row.companyId);
  for (const id of ratings.keys()) ids.add(id);
  if (ids.size === 0) {
    return { windowDays: LEADERBOARD_WINDOW_DAYS, windowStart, generatedAt: now, sort, rows: [] };
  }

  // Only companies the public can actually visit appear on a public board.
  // Note what is NOT selected here: no balance column, from either table.
  const companyRows = await db
    .select({
      id: companies.id,
      name: companies.name,
      username: companies.username,
      category: companies.category,
      governmentOwned: companies.governmentOwned,
      status: companies.status,
      suspendedUntil: companies.suspendedUntil,
    })
    .from(companies)
    .where(inArray(companies.id, [...ids]));

  const completedById = new Map(completedRows.map((r) => [r.companyId, r]));
  const receivedById = new Map(receivedRows.map((r) => [r.companyId, r.received]));
  const listingsById = new Map(listingRows.map((r) => [r.companyId, r.listings]));

  const rows: Omit<LeaderboardRow, "rank">[] = [];
  for (const company of companyRows) {
    // Mirrors `effectiveCompanyStatus`: APPROVED, or a suspension that has
    // already elapsed. A revoked or rejected company is not listed publicly.
    const tradeable =
      company.status === "APPROVED" ||
      (company.status === "SUSPENDED" &&
        company.suspendedUntil != null &&
        company.suspendedUntil.getTime() <= now.getTime());
    if (!tradeable) continue;

    const completed = completedById.get(company.id);
    const received = receivedById.get(company.id) ?? 0;
    const listings = listingsById.get(company.id) ?? 0;
    const rating = ratings.get(company.id);

    rows.push({
      companyId: company.id,
      companyName: company.name,
      companyUsername: company.username,
      category: company.category,
      governmentOwned: company.governmentOwned,
      completedOrders: completed?.orders ?? 0,
      salesValue: completed?.value ?? 0,
      recentRating: rating?.average ?? null,
      recentRatingCount: rating?.count ?? 0,
      marketplaceActivity: received + listings,
    });
  }

  const compare = (a: Omit<LeaderboardRow, "rank">, b: Omit<LeaderboardRow, "rank">): number => {
    switch (sort) {
      case "sales":
        return b.salesValue - a.salesValue || b.completedOrders - a.completedOrders;
      case "rating":
        // A company with no recent ratings sorts below every rated one rather
        // than counting as zero stars.
        return (
          (b.recentRating ?? -1) - (a.recentRating ?? -1) ||
          b.recentRatingCount - a.recentRatingCount ||
          b.completedOrders - a.completedOrders
        );
      case "activity":
        return b.marketplaceActivity - a.marketplaceActivity || b.completedOrders - a.completedOrders;
      case "orders":
      default:
        return b.completedOrders - a.completedOrders || b.salesValue - a.salesValue;
    }
  };

  rows.sort((a, b) => compare(a, b) || a.companyName.localeCompare(b.companyName));

  return {
    windowDays: LEADERBOARD_WINDOW_DAYS,
    windowStart,
    generatedAt: now,
    sort,
    rows: rows.slice(0, limit).map((row, index) => ({ ...row, rank: index + 1 })),
  };
}
