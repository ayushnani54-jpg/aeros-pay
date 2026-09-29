import "server-only";
import { db } from "@/db/client";
import {
  companies,
  invoices,
  marketplaceOrderRatings,
  marketplaceOrders,
  retentionSettings,
  users,
} from "@/db/schema";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { companyWallet, sameWallet, userWallet, type WalletRef } from "./wallets";
import { notifyUser } from "./notify";
import { isUniqueViolation } from "./db-errors";
import { addIstDays } from "./datetime";
import {
  RATING_COMMENT_MAX_LENGTH,
  RATING_COMMENT_RETENTION_DAYS,
  RATING_MAX_STARS,
  RATING_MIN_STARS,
} from "./constants";
import type { MarketplaceOrder, MarketplaceOrderRating } from "@/db/schema";

/**
 * RATINGS (V3 Phase F, spec §22)
 * ===========================================================================
 *
 * A rating is one row, written once, by the person who actually bought the
 * thing. Four rules carry it, and each is enforced where it cannot be talked
 * around:
 *
 * 1. ONLY THE BUYER, AND ONLY FROM THE ORDER ROW.
 *    `rateOrder` never accepts a rater, a seller or a company id. It takes an
 *    order id and the wallet the caller is genuinely acting as, locks the
 *    ORDER row, and derives the rater from `orderBuyerWallet(order)` and the
 *    rated company from `order.sellerCompanyId`. There is no parameter a
 *    caller could use to rate on someone else's behalf or to aim a rating at
 *    a company they never bought from.
 *
 * 2. ONLY A FINISHED ORDER.
 *    The order must be COMPLETED, and its invoice must be PAID. Both are
 *    re-read inside the transaction under the order's lock, so an order that
 *    is cancelled, expired, unpaid or merely paid-but-not-completed is
 *    refused however the caller got here.
 *
 * 3. ONCE.
 *    `marketplace_order_ratings.order_id` is UNIQUE in the database. The
 *    application also checks first, for a readable message, but the guarantee
 *    is Postgres's: a second rating for the same order is rejected even under
 *    a race, and the unique violation is turned into a normal error rather
 *    than a crash.
 *
 * 4. THE STAR IS PERMANENT; THE COMMENT IS NOT.
 *    A non-empty comment is stored with `commentExpiresAt` set to IST midnight
 *    30 calendar days later (the live period is
 *    `retention_settings.rating_comment_retention_days`). The Phase I
 *    retention engine nulls the comment and stamps `commentClearedAt`; the
 *    `stars` column is untouched by that, so the aggregate never changes when
 *    a comment ages out. `ratings_comment_expiry_consistent` makes "a comment
 *    without an expiry" impossible at the database level.
 *
 * NO COPIES OF FINANCIAL DATA. The row holds stars, an optional comment, who
 * rated, which company was rated and which order it belongs to. It does not
 * copy the amount, the tax, the invoice number, the transaction ref or the
 * quantity: those live on the order and the invoice, which are the canonical
 * records, and duplicating them here would create a second version of the
 * truth that could drift.
 */

export class RatingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RatingError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The buyer's wallet for an order row. Derived from the row, never supplied. */
function buyerWalletOf(order: MarketplaceOrder): WalletRef {
  if (order.buyerType === "USER" && order.buyerUserId) return userWallet(order.buyerUserId);
  if (order.buyerType === "COMPANY" && order.buyerCompanyId) {
    return companyWallet(order.buyerCompanyId);
  }
  throw new RatingError("This order has no buyer who could rate it.");
}

function cleanComment(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.replace(/\s+/g, " ").trim().slice(0, RATING_COMMENT_MAX_LENGTH);
  return trimmed.length === 0 ? null : trimmed;
}

/** The configured comment lifetime in IST calendar days. */
async function commentRetentionDays(executor: Pick<typeof db, "select">): Promise<number> {
  const [row] = await executor
    .select({ days: retentionSettings.ratingCommentRetentionDays })
    .from(retentionSettings)
    .limit(1);
  const days = row?.days ?? RATING_COMMENT_RETENTION_DAYS;
  return days != null && days > 0 ? days : RATING_COMMENT_RETENTION_DAYS;
}

/**
 * Whether this viewer could rate this order, for deciding what to SHOW.
 *
 * It is a convenience only. `rateOrder` re-derives every one of these facts
 * inside its own transaction, so a form that appears when it should not still
 * cannot produce a rating.
 */
export function orderIsRateableBy(
  order: Pick<MarketplaceOrder, "status" | "buyerType" | "buyerUserId" | "buyerCompanyId">,
  actor: WalletRef,
): boolean {
  if (order.status !== "COMPLETED") return false;
  try {
    return sameWallet(buyerWalletOf(order as MarketplaceOrder), actor);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Writing a rating
// ---------------------------------------------------------------------------

export async function rateOrder(params: {
  orderId: string;
  /** The wallet the caller is genuinely acting as (from the session). */
  actor: WalletRef;
  stars: number;
  comment?: string | null;
}): Promise<MarketplaceOrderRating> {
  const stars = params.stars;
  if (!Number.isInteger(stars) || stars < RATING_MIN_STARS || stars > RATING_MAX_STARS) {
    throw new RatingError(
      `A rating must be a whole number of stars from ${RATING_MIN_STARS} to ${RATING_MAX_STARS}.`,
    );
  }
  const comment = cleanComment(params.comment);

  return db.transaction(async (tx: Tx) => {
    const [order] = await tx
      .select()
      .from(marketplaceOrders)
      .where(eq(marketplaceOrders.id, params.orderId))
      .for("update");
    if (!order) throw new RatingError("That order does not exist.");

    // --- rule 1: the actual buyer, derived from the row ---------------------
    const buyer = buyerWalletOf(order);
    if (!sameWallet(buyer, params.actor)) {
      throw new RatingError("Only the buyer of this order can rate it.");
    }

    // --- rule 2: a finished order ------------------------------------------
    if (order.status !== "COMPLETED") {
      throw new RatingError(
        order.status === "PAID"
          ? "This order is paid but not completed yet — it can be rated once it is complete."
          : `This order is ${order.status} and cannot be rated.`,
      );
    }
    if (!order.invoiceId) {
      throw new RatingError("This order has no settled invoice and cannot be rated.");
    }
    const [invoice] = await tx
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, order.invoiceId))
      .limit(1);
    if (!invoice || invoice.status !== "PAID") {
      throw new RatingError("This order has not been paid for and cannot be rated.");
    }

    // --- rule 3: once (checked, then guaranteed by the unique index) --------
    const [existing] = await tx
      .select({ id: marketplaceOrderRatings.id })
      .from(marketplaceOrderRatings)
      .where(eq(marketplaceOrderRatings.orderId, order.id))
      .limit(1);
    if (existing) throw new RatingError("You have already rated this order.");

    // --- rule 4: the comment carries its own expiry ------------------------
    const days = await commentRetentionDays(tx);
    const commentExpiresAt = comment ? addIstDays(new Date(), days) : null;

    let inserted: MarketplaceOrderRating;
    try {
      const rows = await tx
        .insert(marketplaceOrderRatings)
        .values({
          orderId: order.id,
          raterType: buyer.kind,
          raterUserId: buyer.kind === "USER" ? buyer.id : null,
          raterCompanyId: buyer.kind === "COMPANY" ? buyer.id : null,
          // The rated party is the order's own seller column — never a
          // caller-supplied company.
          ratedCompanyId: order.sellerCompanyId,
          stars,
          comment,
          commentExpiresAt,
        })
        .returning();
      inserted = rows[0];
    } catch (e) {
      if (isUniqueViolation(e)) throw new RatingError("You have already rated this order.");
      throw e;
    }

    const [seller] = await tx
      .select({ ownerUserId: companies.ownerUserId, name: companies.name })
      .from(companies)
      .where(eq(companies.id, order.sellerCompanyId))
      .limit(1);
    if (seller?.ownerUserId) {
      await notifyUser(
        tx,
        seller.ownerUserId,
        "ORDER_RATED",
        `${seller.name} received a ${stars}-star rating for order ${order.orderNumber}.`,
        "/my-company/orders",
      );
    }

    return inserted;
  });
}

// ---------------------------------------------------------------------------
// Reading ratings
// ---------------------------------------------------------------------------

export type RatingSummary = {
  count: number;
  /** Mean stars to one decimal place, or null when there are no ratings. */
  average: number | null;
  /** How many ratings gave each star count, 1..5. */
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
};

const EMPTY_SUMMARY: RatingSummary = {
  count: 0,
  average: null,
  distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
};

/** Aggregate stars for one company. Derived on read — nothing is cached. */
export async function getCompanyRatingSummary(companyId: string): Promise<RatingSummary> {
  const rows = await db
    .select({ stars: marketplaceOrderRatings.stars, n: sql<number>`count(*)::int` })
    .from(marketplaceOrderRatings)
    .where(eq(marketplaceOrderRatings.ratedCompanyId, companyId))
    .groupBy(marketplaceOrderRatings.stars);

  if (rows.length === 0) return { ...EMPTY_SUMMARY, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };

  const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0;
  let total = 0;
  for (const row of rows) {
    const stars = row.stars as 1 | 2 | 3 | 4 | 5;
    distribution[stars] = row.n;
    count += row.n;
    total += stars * row.n;
  }
  return {
    count,
    average: count === 0 ? null : Math.round((total / count) * 10) / 10,
    distribution,
  };
}

export type PublicRating = {
  id: string;
  stars: number;
  /** Null once the comment has aged out (or if there never was one). */
  comment: string | null;
  commentCleared: boolean;
  raterLabel: string;
  raterHandle: string | null;
  createdAt: Date;
};

/**
 * The ratings shown on a company's public profile.
 *
 * The rater's display name and handle are JOINED at read time rather than
 * copied onto the rating row, so a later name change is reflected and the row
 * itself stays free of duplicated identity data.
 */
export async function getRatingsForCompany(
  companyId: string,
  limit = 20,
): Promise<PublicRating[]> {
  const rows = await db
    .select({
      id: marketplaceOrderRatings.id,
      stars: marketplaceOrderRatings.stars,
      comment: marketplaceOrderRatings.comment,
      commentClearedAt: marketplaceOrderRatings.commentClearedAt,
      createdAt: marketplaceOrderRatings.createdAt,
      raterType: marketplaceOrderRatings.raterType,
      userName: users.displayName,
      userHandle: users.username,
      companyName: companies.name,
      companyHandle: companies.username,
    })
    .from(marketplaceOrderRatings)
    .leftJoin(users, eq(users.id, marketplaceOrderRatings.raterUserId))
    .leftJoin(companies, eq(companies.id, marketplaceOrderRatings.raterCompanyId))
    .where(eq(marketplaceOrderRatings.ratedCompanyId, companyId))
    .orderBy(desc(marketplaceOrderRatings.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    stars: row.stars,
    comment: row.comment,
    commentCleared: row.comment === null && row.commentClearedAt !== null,
    raterLabel:
      row.raterType === "COMPANY" ? (row.companyName ?? "A company") : (row.userName ?? "A buyer"),
    raterHandle: row.raterType === "COMPANY" ? row.companyHandle : row.userHandle,
    createdAt: row.createdAt,
  }));
}

/** The rating for one order, if it has been rated. */
export async function getRatingForOrder(
  orderId: string,
): Promise<MarketplaceOrderRating | null> {
  const [row] = await db
    .select()
    .from(marketplaceOrderRatings)
    .where(eq(marketplaceOrderRatings.orderId, orderId))
    .limit(1);
  return row ?? null;
}

/**
 * Mean stars per company over the last `windowDays` IST days.
 *
 * Used by the leaderboard's "recent rating" column. Returned as a Map so the
 * leaderboard can join it in memory without a second round trip.
 */
export async function getRecentRatingAverages(
  windowStart: Date,
): Promise<Map<string, { count: number; average: number }>> {
  const rows = await db
    .select({
      companyId: marketplaceOrderRatings.ratedCompanyId,
      n: sql<number>`count(*)::int`,
      avg: sql<string>`avg(${marketplaceOrderRatings.stars})`,
    })
    .from(marketplaceOrderRatings)
    .where(gte(marketplaceOrderRatings.createdAt, windowStart))
    .groupBy(marketplaceOrderRatings.ratedCompanyId);

  const out = new Map<string, { count: number; average: number }>();
  for (const row of rows) {
    out.set(row.companyId, {
      count: row.n,
      average: Math.round(Number(row.avg) * 10) / 10,
    });
  }
  return out;
}

/**
 * Comments that are past their expiry and have not been cleared yet.
 *
 * Read-only: this is here so Phase I's retention engine (and the Government's
 * preview screen) can see what is due WITHOUT this module gaining the power to
 * delete anything. Nothing in Phase F calls a clearing function, because there
 * isn't one here.
 */
export async function countExpiredRatingComments(now = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(marketplaceOrderRatings)
    .where(
      and(
        isNotNull(marketplaceOrderRatings.comment),
        isNotNull(marketplaceOrderRatings.commentExpiresAt),
        sql`${marketplaceOrderRatings.commentExpiresAt} <= ${now}`,
      ),
    );
  return row?.n ?? 0;
}
