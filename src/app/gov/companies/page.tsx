import Link from "next/link";
import { getAllCompaniesForGovernment, getGovernmentSingleton } from "@/lib/queries";
import { CompanyStatusBadge } from "@/components/status-badge";
import { CURRENCY_NAME } from "@/lib/constants";
import { effectiveCompanyStatus } from "@/lib/status";

const TABS = ["ALL", "PENDING", "APPROVED", "SUSPENDED", "REJECTED", "REVOKED"];

export default async function GovCompaniesPage({ searchParams }: PageProps<"/gov/companies">) {
  const params = await searchParams;
  const filter = typeof params.status === "string" ? params.status : "ALL";

  const [rows, gov] = await Promise.all([
    getAllCompaniesForGovernment(),
    getGovernmentSingleton(),
  ]);

  const filtered = filter === "ALL" ? rows : rows.filter((r) => r.company.status === filter);
  const defaultTaxPercent = (gov?.companyTaxRateBp ?? 500) / 100;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Companies</h1>
        <p className="mt-1 text-sm text-muted">
          Default company tax: {defaultTaxPercent.toFixed(2)}% · approval funds{" "}
          {(5000).toLocaleString()} {CURRENCY_NAME} from the treasury
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map((tab) => {
          const count =
            tab === "ALL" ? rows.length : rows.filter((r) => r.company.status === tab).length;
          return (
            <Link
              key={tab}
              href={`/gov/companies?status=${tab}`}
              className={filter === tab ? "btn btn-primary text-xs" : "btn btn-secondary text-xs"}
            >
              {tab} ({count})
            </Link>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="card p-6">
          <p className="text-sm text-muted">No companies here.</p>
        </div>
      ) : (
        <div className="card divide-y divide-border">
          {filtered.map(({ company, ownerUsername, ownerDisplayName }) => (
            <Link
              key={company.id}
              href={`/gov/companies/${company.id}`}
              className="flex flex-wrap items-start justify-between gap-3 p-4 hover:bg-surface"
            >
              <div className="min-w-0">
                <p className="font-medium">{company.name}</p>
                <p className="text-sm text-muted">
                  @{company.username} · {company.category}
                </p>
                <p className="mt-1 text-xs text-muted">
                  Owner: {ownerDisplayName} (@{ownerUsername})
                  {company.governmentOwned ? " · Government-held" : ""}
                </p>
                <p className="mt-1 text-xs text-muted">
                  Applied {new Date(company.createdAt).toLocaleDateString()}
                  {company.strikes > 0 ? ` · ${company.strikes} IP strike(s)` : ""}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <CompanyStatusBadge status={effectiveCompanyStatus(company)} />
                <p className="font-mono text-sm">
                  {company.balance.toLocaleString()} {CURRENCY_NAME}
                </p>
                <p className="text-xs text-muted">
                  Tax:{" "}
                  {company.taxRateBp === null
                    ? `${defaultTaxPercent.toFixed(2)}% (default)`
                    : `${(company.taxRateBp / 100).toFixed(2)}%`}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
