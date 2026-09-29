import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import { browseOffers, listOfferCategories, expireOverdueOrders } from "@/lib/marketplace";
import { getLiveAd, runPromotionCharges } from "@/lib/promotions";
import { MarketSearchBar } from "@/components/forms/marketplace-forms";
import { PromotionSlot } from "@/components/promotion-slot";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDate } from "@/lib/datetime";

/**
 * THE MARKET — goods and services (V3, spec §§11,12,13).
 *
 * NAMING NOTE. `/marketplace` already existed in V2 and means something else
 * entirely: COMPANIES that are for sale, as whole businesses. This route is the
 * V3 goods-and-services market, so it lives at `/market` and calls itself
 * "Market" everywhere, and the two pages cross-link with an explicit sentence
 * saying which is which. The V2 company-sale flow is untouched.
 *
 * Search and filtering happen on the SERVER from the URL's search params, using
 * the indexes Phase A created, and nothing about a search is recorded: no
 * history table, no popular-terms counter, no per-viewer log (§13).
 *
 * This page is also one of the places the lazy promotion charge runs, because
 * the app has no scheduler yet. `runPromotionCharges` is one indexed read when
 * there is nothing to do, and today's charge is claimed by a single conditional
 * UPDATE, so a hundred page loads in a day still bill exactly once.
 */
export default async function MarketPage({ searchParams }: PageProps<"/market">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const params = await searchParams;
  const str = (key: string): string => {
    const value = params[key];
    return typeof value === "string" ? value : "";
  };

  const q = str("q");
  const category = str("category");
  const minPrice = str("minPrice");
  const maxPrice = str("maxPrice");
  const sortParam = str("sort");
  const sort =
    sortParam === "PRICE_ASC" || sortParam === "PRICE_DESC" ? sortParam : ("NEWEST" as const);
  const page = Math.max(Number.parseInt(str("page") || "1", 10) || 1, 1);

  // Lazy maintenance. Both are cheap no-ops when there is nothing to do, and
  // neither can double-charge or double-expire (see the libraries).
  await Promise.all([
    runPromotionCharges().catch(() => undefined),
    expireOverdueOrders().catch(() => undefined),
  ]);

  const [result, categories, ad] = await Promise.all([
    browseOffers({
      q,
      category,
      minPrice: minPrice === "" ? null : Number(minPrice),
      maxPrice: maxPrice === "" ? null : Number(maxPrice),
      sort,
      page,
    }),
    listOfferCategories(),
    getLiveAd(),
  ]);

  function pageHref(target: number): string {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (category) sp.set("category", category);
    if (minPrice) sp.set("minPrice", minPrice);
    if (maxPrice) sp.set("maxPrice", maxPrice);
    if (sort !== "NEWEST") sp.set("sort", sort);
    sp.set("page", String(target));
    return `/market?${sp.toString()}`;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Market</h1>
          <p className="mt-1 text-sm text-muted">
            Goods and services offered by companies in the community. Ordering is free — you only
            pay when the seller sends you an invoice.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/market/orders" className="btn btn-secondary text-sm">
            My orders
          </Link>
          <Link href="/market/wanted" className="btn btn-secondary text-sm">
            Wanted
          </Link>
          <Link href="/market/contracts" className="btn btn-secondary text-sm">
            Contracts
          </Link>
          <Link href="/market/leaderboard" className="btn btn-secondary text-sm">
            Leaderboard
          </Link>
        </div>
      </div>

      <PromotionSlot ad={ad} />

      <MarketSearchBar
        categories={categories}
        initial={{ q, category, minPrice, maxPrice, sort }}
      />

      <p className="text-xs text-muted">
        {result.total === 0
          ? "No listings matched."
          : `${result.total.toLocaleString()} listing${result.total === 1 ? "" : "s"} · page ${result.page} of ${result.pageCount}`}
      </p>

      {result.rows.length === 0 ? (
        <div className="card p-6">
          <p className="text-sm text-muted">
            Nothing here yet. {ctx.availableCompanies.length > 0 ? (
              <>
                <Link href="/my-company/offers" className="underline">
                  Add a listing
                </Link>{" "}
                for your own company.
              </>
            ) : (
              "Companies list goods and services here once they are approved."
            )}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {result.rows.map(({ offer, companyName, companyUsername }) => (
            <div key={offer.id} className="card p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/market/offers/${offer.id}`}
                    className="font-medium hover:underline"
                  >
                    {offer.title}
                  </Link>
                  <p className="text-sm text-muted">
                    {companyName} (@{companyUsername})
                  </p>
                  <p className="mt-1 text-xs text-muted">{offer.category}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-lg font-semibold">
                    {offer.unitPrice.toLocaleString()}{" "}
                    <span className="text-xs font-medium text-muted">{CURRENCY_NAME}</span>
                  </p>
                  <p className="text-xs text-muted">
                    {offer.quantityAvailable === null
                      ? "Unlimited"
                      : offer.quantityAvailable === 0
                        ? "Out of stock"
                        : `${offer.quantityAvailable.toLocaleString()} left`}
                  </p>
                </div>
              </div>
              <p className="mt-3 line-clamp-3 text-sm">{offer.description}</p>
              <p className="mt-2 text-xs text-muted">Listed {formatDate(offer.createdAt)}</p>
            </div>
          ))}
        </div>
      )}

      {result.pageCount > 1 && (
        <div className="flex items-center justify-between gap-3">
          {result.page > 1 ? (
            <Link href={pageHref(result.page - 1)} className="btn btn-secondary text-sm">
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs text-muted">
            Page {result.page} of {result.pageCount}
          </span>
          {result.page < result.pageCount ? (
            <Link href={pageHref(result.page + 1)} className="btn btn-secondary text-sm">
              Next →
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}

      <p className="text-xs text-muted">
        Looking to buy a whole business rather than goods?{" "}
        <Link href="/marketplace" className="underline">
          Companies for sale
        </Link>{" "}
        is a different page.
      </p>
    </div>
  );
}
