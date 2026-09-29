import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import { getOffersForCompany } from "@/lib/marketplace";
import { OfferStatusBadge } from "@/components/status-badge";
import {
  CreateOfferForm,
  EditOfferForm,
  OfferStatusButton,
} from "@/components/forms/marketplace-forms";
import { CURRENCY_NAME } from "@/lib/constants";
import { effectiveCompanyStatus } from "@/lib/status";
import { formatDate, formatDateTime } from "@/lib/datetime";

/**
 * MY LISTINGS (spec §§11,12).
 *
 * Creating or changing a listing requires ACTING AS the company — the wallet
 * switcher's context, re-verified server-side by every action. A company owner
 * looking at this page from their personal wallet can read it but not act.
 */
export default async function CompanyOffersPage({ searchParams }: PageProps<"/my-company/offers">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const company = ctx.company ?? ctx.availableCompanies[0] ?? null;
  if (!company) {
    return (
      <div className="card p-6">
        <p className="text-sm text-muted">
          You need an approved company to list goods or services.{" "}
          <Link href="/my-company" className="underline">
            Apply for one
          </Link>
          .
        </p>
      </div>
    );
  }

  const params = await searchParams;
  const filter = typeof params.status === "string" ? params.status : "ALL";

  const rows = await getOffersForCompany(company.id, 200);
  const filtered = filter === "ALL" ? rows : rows.filter((o) => o.status === filter);

  const canList = effectiveCompanyStatus(company) === "APPROVED";
  const isActingAsThisCompany = ctx.company?.id === company.id;
  const tabs = ["ALL", "ACTIVE", "PAUSED", "CLOSED"];

  return (
    <div className="space-y-6">
      <div>
        <Link href="/my-company" className="text-sm text-muted hover:text-foreground">
          ← {company.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">My listings</h1>
        <p className="mt-1 text-sm text-muted">
          What {company.name} offers in the{" "}
          <Link href="/market" className="underline">
            Market
          </Link>
          . Active listings are visible to everyone; paused ones are hidden but keep their orders.
        </p>
      </div>

      {canList ? (
        isActingAsThisCompany ? (
          <CreateOfferForm />
        ) : (
          <div className="card p-5">
            <p className="text-sm text-muted">
              Switch to {company.name} from your dashboard to add or change a listing.
            </p>
          </div>
        )
      ) : (
        <div className="card p-5">
          <p className="text-sm text-muted">
            This company cannot list anything in its current state.
          </p>
        </div>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <Link
              key={tab}
              href={`/my-company/offers?status=${tab}`}
              className={filter === tab ? "btn btn-primary text-xs" : "btn btn-secondary text-xs"}
            >
              {tab}
            </Link>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="card p-5">
            <p className="text-sm text-muted">No listings here.</p>
          </div>
        ) : (
          <div className="card divide-y divide-border">
            {filtered.map((offer) => (
              <div key={offer.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/market/offers/${offer.id}`}
                      className="font-medium hover:underline"
                    >
                      {offer.title}
                    </Link>
                    <p className="text-sm text-muted">{offer.category}</p>
                    <p className="mt-1 text-xs text-muted">
                      {offer.unitPrice.toLocaleString()} {CURRENCY_NAME} ·{" "}
                      {offer.quantityAvailable === null
                        ? "unlimited"
                        : `${offer.quantityAvailable.toLocaleString()} available`}{" "}
                      · listed {formatDate(offer.createdAt)}
                    </p>
                    {offer.status === "PAUSED" && offer.pausedAt && (
                      <p className="mt-1 text-xs text-muted">
                        Paused {formatDateTime(offer.pausedAt)}. A long-paused listing is closed
                        automatically.
                      </p>
                    )}
                    {offer.status === "CLOSED" && offer.closedAt && (
                      <p className="mt-1 text-xs text-muted">
                        Closed {formatDateTime(offer.closedAt)}.
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <OfferStatusBadge status={offer.status} />
                    {isActingAsThisCompany && offer.status !== "CLOSED" && (
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <EditOfferForm offer={offer} />
                        {offer.status === "ACTIVE" ? (
                          <OfferStatusButton
                            offerId={offer.id}
                            status="PAUSED"
                            label="Pause"
                          />
                        ) : (
                          <OfferStatusButton
                            offerId={offer.id}
                            status="ACTIVE"
                            label="Resume"
                          />
                        )}
                        <OfferStatusButton
                          offerId={offer.id}
                          status="CLOSED"
                          label="Close"
                          tone="danger"
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
