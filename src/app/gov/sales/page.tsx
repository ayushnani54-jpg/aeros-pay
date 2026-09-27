import Link from "next/link";
import { getAllOpenListings, getAllSaleRecords } from "@/lib/sales";
import { getGovernmentSingleton } from "@/lib/queries";
import { SalePolicyForm } from "@/components/forms/gov-forms";
import { CURRENCY_NAME } from "@/lib/constants";

export default async function GovSalesPage() {
  const [listings, records, gov] = await Promise.all([
    getAllOpenListings(),
    getAllSaleRecords(100),
    getGovernmentSingleton(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Company sales</h1>
        <p className="mt-1 text-sm text-muted">
          A company can be listed once it has been approved for long enough. The price is its
          lifetime sales multiplied by the rate below, frozen at listing time.
        </p>
      </div>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Sale policy</h2>
        <SalePolicyForm
          multiplier={(gov?.saleMultiplierBp ?? 15000) / 10000}
          minAgeDays={gov?.saleMinCompanyAgeDays ?? 7}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted">
          Currently listed ({listings.length})
        </h2>
        {listings.length === 0 ? (
          <div className="card p-5">
            <p className="text-sm text-muted">No companies are for sale right now.</p>
          </div>
        ) : (
          <div className="card divide-y divide-border">
            {listings.map(({ listing, company, sellerUsername }) => (
              <div
                key={listing.id}
                className="flex flex-wrap items-start justify-between gap-3 p-4"
              >
                <div className="min-w-0">
                  <Link
                    href={`/gov/companies/${company.id}`}
                    className="font-medium hover:underline"
                  >
                    {company.name}
                  </Link>
                  <p className="text-sm text-muted">
                    @{company.username} · seller @{sellerUsername}
                  </p>
                  <p className="mt-1 text-xs text-muted">&ldquo;{listing.reason}&rdquo;</p>
                  <p className="mt-1 text-xs text-muted">
                    Listed {new Date(listing.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-semibold">
                    {listing.valuation.toLocaleString()} {CURRENCY_NAME}
                  </p>
                  <p className="text-xs text-muted">
                    {listing.salesFigure.toLocaleString()} ×{" "}
                    {(listing.multiplierBp / 10000).toFixed(2)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted">Completed sales</h2>
        {records.length === 0 ? (
          <div className="card p-5">
            <p className="text-sm text-muted">No companies have changed hands yet.</p>
          </div>
        ) : (
          <div className="card divide-y divide-border">
            {records.map(({ record, companyName, companyUsername }) => (
              <div key={record.id} className="p-4 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <Link
                      href={`/gov/companies/${record.companyId}`}
                      className="font-medium hover:underline"
                    >
                      {companyName}
                    </Link>
                    <p className="text-xs text-muted">
                      @{companyUsername} ·{" "}
                      {record.saleType.replace(/_/g, " ").toLowerCase()}
                    </p>
                    <p className="mt-1 font-mono text-xs text-muted">Ref {record.txRef}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono font-medium">
                      {record.price.toLocaleString()} {CURRENCY_NAME}
                    </p>
                    <p className="text-xs text-muted">
                      {new Date(record.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted">
                  Valued from {record.salesFigure.toLocaleString()} sales ×{" "}
                  {(record.multiplierBp / 10000).toFixed(2)} · company wallet held{" "}
                  {record.companyBalanceAtSale.toLocaleString()} {CURRENCY_NAME} at transfer
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
