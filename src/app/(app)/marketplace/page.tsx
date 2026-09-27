import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import { getOpenListingsForViewer, getAllOpenListings } from "@/lib/sales";
import { CURRENCY_NAME } from "@/lib/constants";
import {
  BuyCompanyButton,
  DismissListingButton,
  MakeOfferForm,
} from "@/components/forms/company-forms";

/**
 * Companies currently for sale.
 *
 * Listings a viewer has dismissed drop off THEIR list only — the listing
 * stays open and visible to everyone else until it is sold or cancelled.
 */
export default async function MarketplacePage() {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const [visible, all] = await Promise.all([
    getOpenListingsForViewer(ctx.user.id),
    getAllOpenListings(),
  ]);

  const hiddenCount = all.length - visible.length;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Companies for sale</h1>
        <p className="mt-1 text-sm text-muted">
          Buying a company pays the seller from your personal wallet and transfers ownership to
          you. The company keeps its own balance and history.
        </p>
      </div>

      {hiddenCount > 0 && (
        <p className="text-xs text-muted">
          {hiddenCount} listing{hiddenCount === 1 ? "" : "s"} hidden because you marked them
          &ldquo;not interested&rdquo;. They are still live for everyone else.
        </p>
      )}

      {visible.length === 0 ? (
        <div className="card p-6">
          <p className="text-sm text-muted">
            {all.length === 0
              ? "No companies are for sale right now."
              : "You have hidden every current listing."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map(({ listing, company, sellerUsername, sellerDisplayName }) => {
            const isOwn = company.ownerUserId === ctx.user.id;
            return (
              <div key={listing.id} className="card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/c/${company.username}`} className="font-medium hover:underline">
                      {company.name}
                    </Link>
                    <p className="text-sm text-muted">
                      @{company.username} · {company.category}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Sold by {sellerDisplayName} (@{sellerUsername})
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xl font-semibold">
                      {listing.valuation.toLocaleString()}{" "}
                      <span className="text-sm font-medium text-muted">{CURRENCY_NAME}</span>
                    </p>
                    <p className="text-xs text-muted">
                      {listing.salesFigure.toLocaleString()} sales ×{" "}
                      {(listing.multiplierBp / 10000).toFixed(2)}
                    </p>
                  </div>
                </div>

                <p className="mt-3 text-sm">
                  <span className="text-muted">Reason for selling: </span>
                  {listing.reason}
                </p>

                <p className="mt-2 text-xs text-muted">
                  Company wallet at listing time is included in the sale.
                </p>

                {isOwn ? (
                  <p className="mt-4 text-sm text-muted">This is your own company.</p>
                ) : (
                  <div className="mt-4 flex flex-wrap items-start gap-2">
                    <BuyCompanyButton
                      listingId={listing.id}
                      price={listing.valuation}
                      companyName={company.name}
                      canAfford={ctx.user.balance >= listing.valuation}
                    />
                    <MakeOfferForm companyId={company.id} />
                    <DismissListingButton listingId={listing.id} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
