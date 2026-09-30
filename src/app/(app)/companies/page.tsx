import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import { searchCompanies } from "@/lib/queries";
import { getMyCompanyAllowance } from "@/lib/companies";
import { getOpenListingsForViewer } from "@/lib/sales";
import { CURRENCY_NAME } from "@/lib/constants";

export default async function CompaniesPage({ searchParams }: PageProps<"/companies">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : "";

  const [companies, listings, allowance] = await Promise.all([
    searchCompanies(q),
    getOpenListingsForViewer(ctx.user.id),
    getMyCompanyAllowance(ctx.user.id),
  ]);

  const forSale = new Map(listings.map((l) => [l.company.id, l.listing]));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Companies</h1>
          <p className="mt-1 text-sm text-muted">
            Browse businesses in the community and pay them directly.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/marketplace" className="btn btn-secondary text-sm">
            Companies for sale ({listings.length})
          </Link>
          {ctx.availableCompanies.length === 0 && (
            <Link href="/my-company" className="btn btn-primary text-sm">
              Create a company
            </Link>
          )}
          {ctx.availableCompanies.length > 0 && allowance.canCreate && (
            <Link href="/my-company/new" className="btn btn-secondary text-sm">
              Create another company
            </Link>
          )}
        </div>
      </div>

      <form className="flex gap-2">
        <input
          name="q"
          defaultValue={q}
          className="input"
          placeholder="Search by name, username or category"
        />
        <button type="submit" className="btn btn-secondary">
          Search
        </button>
      </form>

      {companies.length === 0 ? (
        <p className="text-sm text-muted">No companies matched that search.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {companies.map((company) => {
            const listing = forSale.get(company.id);
            return (
              <div key={company.id} className="card flex flex-col p-5">
                <div className="flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/c/${company.username}`} className="font-medium hover:underline">
                      {company.name}
                    </Link>
                    {listing && <span className="badge badge-suspended">For sale</span>}
                  </div>
                  <p className="text-sm text-muted">@{company.username}</p>
                  <p className="mt-1 text-xs text-muted">{company.category}</p>
                  <p className="mt-2 line-clamp-3 text-sm text-muted">{company.description}</p>
                  <p className="mt-2 text-xs text-muted">
                    {company.governmentOwned
                      ? "Under Government stewardship"
                      : `Run by @${company.ownerUsername}`}
                  </p>
                  {listing && (
                    <p className="mt-1 text-xs text-muted">
                      Asking {listing.valuation.toLocaleString()} {CURRENCY_NAME}
                    </p>
                  )}
                </div>
                <div className="mt-4 flex gap-2">
                  <Link href={`/pay?to=${company.username}`} className="btn btn-primary text-sm">
                    Pay
                  </Link>
                  <Link href={`/c/${company.username}`} className="btn btn-secondary text-sm">
                    View
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
