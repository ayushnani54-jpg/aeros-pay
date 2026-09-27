import Link from "next/link";
import { notFound } from "next/navigation";
import { getActingContext } from "@/lib/auth";
import { getCompanyProfileByUsername } from "@/lib/queries";
import { getActiveListingForCompany } from "@/lib/sales";
import { CompanyStatusBadge } from "@/components/status-badge";
import { BuyCompanyButton, MakeOfferForm } from "@/components/forms/company-forms";
import { effectiveCompanyStatus } from "@/lib/status";
import { CURRENCY_NAME } from "@/lib/constants";

/**
 * Public company profile.
 *
 * Shows what a customer needs — who runs it, what it does, how to pay it —
 * and deliberately never exposes the company's balance or private financial
 * history (spec §27).
 */
export default async function PublicCompanyProfile({ params }: PageProps<"/c/[username]">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const { username } = await params;
  const row = await getCompanyProfileByUsername(username.toLowerCase());
  if (!row) notFound();

  const { company, ownerUsername, ownerDisplayName } = row;
  const status = effectiveCompanyStatus(company);
  const listing = await getActiveListingForCompany(company.id);
  const isOwner = company.ownerUserId === ctx.user.id;

  return (
    <div className="space-y-5">
      <Link href="/companies" className="text-sm text-muted hover:text-foreground">
        ← Companies
      </Link>

      <div className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{company.name}</h1>
            <p className="mt-1 font-mono text-sm text-muted">@{company.username}</p>
            <p className="mt-1 text-sm text-muted">{company.category}</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <CompanyStatusBadge status={status} />
            {listing && <span className="badge badge-suspended">For sale</span>}
          </div>
        </div>

        <p className="mt-4 whitespace-pre-line text-sm">{company.description}</p>

        <p className="mt-4 text-sm text-muted">
          {company.governmentOwned ? (
            "Currently under Government stewardship."
          ) : (
            <>
              Run by{" "}
              <Link href={`/u/${ownerUsername}`} className="underline">
                {ownerDisplayName}
              </Link>{" "}
              (@{ownerUsername})
            </>
          )}
        </p>
        <p className="mt-1 text-xs text-muted">
          Trading since {new Date(company.createdAt).toLocaleDateString()}
        </p>

        {status === "APPROVED" && !isOwner && (
          <Link href={`/pay?to=${company.username}`} className="btn btn-primary mt-5 inline-block">
            Pay {company.name}
          </Link>
        )}
        {isOwner && (
          <Link href="/my-company" className="btn btn-secondary mt-5 inline-block">
            Manage this company
          </Link>
        )}
        {status === "SUSPENDED" && (
          <p className="mt-5 text-sm text-muted">
            This company is currently suspended and cannot trade.
          </p>
        )}
      </div>

      {listing && !isOwner && status === "APPROVED" && (
        <div className="card p-5">
          <h2 className="font-medium">This company is for sale</h2>
          <p className="mt-1 text-sm text-muted">&ldquo;{listing.reason}&rdquo;</p>
          <p className="mt-3 text-xl font-semibold">
            {listing.valuation.toLocaleString()}{" "}
            <span className="text-sm font-medium text-muted">{CURRENCY_NAME}</span>
          </p>
          <p className="text-xs text-muted">
            {listing.salesFigure.toLocaleString()} lifetime sales ×{" "}
            {(listing.multiplierBp / 10000).toFixed(2)}
          </p>
          <div className="mt-4 flex flex-wrap items-start gap-2">
            <BuyCompanyButton
              listingId={listing.id}
              price={listing.valuation}
              companyName={company.name}
              canAfford={ctx.user.balance >= listing.valuation}
            />
            <MakeOfferForm companyId={company.id} />
          </div>
        </div>
      )}

      {!listing && !isOwner && status === "APPROVED" && !company.governmentOwned && (
        <div className="card p-5">
          <h2 className="font-medium">Interested in buying?</h2>
          <p className="mt-1 text-sm text-muted">
            This company is not listed, but you can still make the owner an offer. Nothing moves
            unless they accept.
          </p>
          <div className="mt-3">
            <MakeOfferForm companyId={company.id} />
          </div>
        </div>
      )}

      <p className="text-xs text-muted">
        Company balances and private financial history are never shown publicly.
      </p>
    </div>
  );
}
