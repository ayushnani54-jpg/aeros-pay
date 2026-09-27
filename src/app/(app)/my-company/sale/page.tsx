import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import {
  getActiveListingForCompany,
  getOffersForCompany,
  getPendingOffersForOwner,
  getSaleHistoryForCompany,
  previewValuation,
} from "@/lib/sales";
import {
  CancelListingButton,
  ListForSaleForm,
  RespondToOfferForm,
} from "@/components/forms/company-forms";
import { SaleStatusBadge } from "@/components/status-badge";
import { CURRENCY_NAME } from "@/lib/constants";

export default async function CompanySalePage() {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const company = ctx.company ?? ctx.availableCompanies[0] ?? null;
  if (!company) {
    return (
      <div className="card p-6">
        <p className="text-sm text-muted">
          You need an approved company first.{" "}
          <Link href="/my-company" className="underline">
            Apply for one
          </Link>
          .
        </p>
      </div>
    );
  }

  const [preview, listing, offers, history, pendingOffers] = await Promise.all([
    previewValuation(company),
    getActiveListingForCompany(company.id),
    getOffersForCompany(company.id),
    getSaleHistoryForCompany(company.id),
    getPendingOffersForOwner(ctx.user.id),
  ]);

  const myPendingOffers = pendingOffers.filter((o) => o.company.id === company.id);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/my-company" className="text-sm text-muted hover:text-foreground">
          ← {company.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Sell this company</h1>
        <p className="mt-1 text-sm text-muted">
          Selling transfers ownership and the company&apos;s wallet to the buyer. The price is
          paid into your personal wallet.
        </p>
      </div>

      {/* Offers needing a decision come first. */}
      {myPendingOffers.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Offers awaiting your decision</h2>
          {myPendingOffers.map(({ offer }) => (
            <div key={offer.id} className="card border-[#111111] p-5">
              <RespondToOfferForm
                offerId={offer.id}
                amount={offer.amount}
                fromLabel={offer.offerorType === "GOVERNMENT" ? "The Government" : "A buyer"}
              />
              {offer.message && (
                <p className="mt-3 rounded-md bg-surface p-3 text-sm">{offer.message}</p>
              )}
              <p className="mt-2 text-xs text-muted">
                Received {new Date(offer.createdAt).toLocaleString()}
              </p>
            </div>
          ))}
        </section>
      )}

      {listing ? (
        <section className="card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-medium">Currently listed for sale</h2>
              <p className="mt-1 text-sm text-muted">&ldquo;{listing.reason}&rdquo;</p>
              <p className="mt-2 text-xs text-muted">
                Listed {new Date(listing.createdAt).toLocaleString()}
              </p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-semibold">
                {listing.valuation.toLocaleString()}{" "}
                <span className="text-sm font-medium text-muted">{CURRENCY_NAME}</span>
              </p>
              <p className="text-xs text-muted">
                {listing.salesFigure.toLocaleString()} sales ×{" "}
                {(listing.multiplierBp / 10000).toFixed(2)}
              </p>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted">
            This price is frozen. It will not change even if your sales grow or the Government
            changes the multiplier.
          </p>
          <div className="mt-4">
            <CancelListingButton listingId={listing.id} />
          </div>
        </section>
      ) : (
        <ListForSaleForm
          companyId={company.id}
          valuation={preview.valuation}
          salesFigure={preview.salesFigure}
          multiplier={preview.multiplierBp / 10000}
          eligible={preview.eligibility.eligible}
          eligibilityReason={
            preview.eligibility.reason
              ? preview.eligibility.daysRemaining
                ? `${preview.eligibility.reason} You can list it in ${preview.eligibility.daysRemaining} day${preview.eligibility.daysRemaining === 1 ? "" : "s"}.`
                : preview.eligibility.reason
              : undefined
          }
        />
      )}

      {offers.length > 0 && (
        <section className="card p-5">
          <h2 className="mb-3 font-medium">Offer history</h2>
          <div className="divide-y divide-border">
            {offers.map((offer) => (
              <div key={offer.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div>
                  <p className="font-medium">
                    {offer.amount.toLocaleString()} {CURRENCY_NAME}
                  </p>
                  <p className="text-xs text-muted">
                    {offer.offerorType === "GOVERNMENT" ? "Government" : "User"} ·{" "}
                    {new Date(offer.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <SaleStatusBadge status={offer.status} />
              </div>
            ))}
          </div>
        </section>
      )}

      {history.length > 0 && (
        <section className="card p-5">
          <h2 className="mb-3 font-medium">Ownership history</h2>
          <div className="divide-y divide-border">
            {history.map((record) => (
              <div key={record.id} className="py-3 text-sm">
                <p className="font-medium">
                  Sold for {record.price.toLocaleString()} {CURRENCY_NAME}
                </p>
                <p className="text-xs text-muted">
                  {record.saleType.replace(/_/g, " ").toLowerCase()} ·{" "}
                  {new Date(record.createdAt).toLocaleString()} · Ref {record.txRef}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
