import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import {
  browseContracts,
  expireOverdueContracts,
  getContractsAwardedTo,
  getContractsForIssuer,
} from "@/lib/contracts";
import { CreateContractForm } from "@/components/forms/marketplace-forms";
import { ContractStatusBadge } from "@/components/status-badge";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDate } from "@/lib/datetime";

/**
 * CONTRACTS (spec §17).
 *
 * Open tenders from the Government and from approved companies, plus the
 * viewer's own issued and awarded contracts. Creating one requires acting AS an
 * approved company (the Government has its own page under /gov/contracts).
 */
export default async function ContractsPage({ searchParams }: PageProps<"/market/contracts">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  await expireOverdueContracts().catch(() => undefined);

  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : "";
  const statusParam = typeof params.status === "string" ? params.status : "OPEN";
  const status =
    statusParam === "AWARDED" || statusParam === "COMPLETED" || statusParam === "ALL"
      ? statusParam
      : ("OPEN" as const);
  const page = Math.max(
    Number.parseInt(typeof params.page === "string" ? params.page : "1", 10) || 1,
    1,
  );

  const [result, issued, awarded] = await Promise.all([
    browseContracts({ q, status, page }),
    ctx.company
      ? getContractsForIssuer({ type: "COMPANY", companyId: ctx.company.id }, 50)
      : Promise.resolve([]),
    getContractsAwardedTo(ctx.wallet, 50),
  ]);

  const tabs = ["OPEN", "AWARDED", "COMPLETED", "ALL"];

  return (
    <div className="space-y-6">
      <div>
        <Link href="/market" className="text-sm text-muted hover:text-foreground">
          ← Market
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Contracts</h1>
        <p className="mt-1 text-sm text-muted">
          Work put out to tender by the Government and by companies. Apply once; the issuer awards
          one applicant.
        </p>
      </div>

      <form className="flex gap-2">
        <input type="hidden" name="status" value={status} />
        <input
          name="q"
          defaultValue={q}
          className="input"
          maxLength={120}
          placeholder="Search contracts by title, requirement or number"
        />
        <button type="submit" className="btn btn-secondary">
          Search
        </button>
      </form>

      <div className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <Link
            key={tab}
            href={`/market/contracts?status=${tab}`}
            className={status === tab ? "btn btn-primary text-xs" : "btn btn-secondary text-xs"}
          >
            {tab}
          </Link>
        ))}
      </div>

      <section className="space-y-3">
        {result.rows.length === 0 ? (
          <div className="card p-5">
            <p className="text-sm text-muted">No contracts here.</p>
          </div>
        ) : (
          <div className="card divide-y divide-border">
            {result.rows.map((row) => (
              <div
                key={row.contract.id}
                className="flex flex-wrap items-start justify-between gap-3 p-4"
              >
                <div className="min-w-0">
                  <Link
                    href={`/market/contracts/${row.contract.id}`}
                    className="font-medium hover:underline"
                  >
                    {row.contract.title}
                  </Link>
                  <p className="text-sm text-muted">
                    {row.issuerLabel} · {row.contract.contractNumber}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Budget {row.contract.budget.toLocaleString()} {CURRENCY_NAME} ·{" "}
                    {row.applicationCount} application{row.applicationCount === 1 ? "" : "s"}
                    {row.contract.deadline ? ` · by ${formatDate(row.contract.deadline)}` : ""}
                  </p>
                  {row.awardedToLabel && (
                    <p className="mt-1 text-xs text-muted">Awarded to {row.awardedToLabel}</p>
                  )}
                </div>
                <ContractStatusBadge status={row.contract.status} />
              </div>
            ))}
          </div>
        )}

        {result.pageCount > 1 && (
          <div className="flex items-center justify-between gap-3">
            {result.page > 1 ? (
              <Link
                href={`/market/contracts?${new URLSearchParams({ q, status, page: String(result.page - 1) })}`}
                className="btn btn-secondary text-sm"
              >
                ← Previous
              </Link>
            ) : (
              <span />
            )}
            <span className="text-xs text-muted">
              Page {result.page} of {result.pageCount}
            </span>
            {result.page < result.pageCount ? (
              <Link
                href={`/market/contracts?${new URLSearchParams({ q, status, page: String(result.page + 1) })}`}
                className="btn btn-secondary text-sm"
              >
                Next →
              </Link>
            ) : (
              <span />
            )}
          </div>
        )}
      </section>

      {awarded.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted">Awarded to you</h2>
          <div className="card divide-y divide-border">
            {awarded.map((row) => (
              <div
                key={row.contract.id}
                className="flex flex-wrap items-start justify-between gap-3 p-4"
              >
                <div className="min-w-0">
                  <Link
                    href={`/market/contracts/${row.contract.id}`}
                    className="font-medium hover:underline"
                  >
                    {row.contract.title}
                  </Link>
                  <p className="text-xs text-muted">
                    {row.issuerLabel} · {row.contract.contractNumber}
                    {row.invoiceNumber ? ` · invoice ${row.invoiceNumber}` : ""}
                  </p>
                </div>
                <ContractStatusBadge status={row.contract.status} />
              </div>
            ))}
          </div>
        </section>
      )}

      {issued.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted">Issued by {ctx.company?.name}</h2>
          <div className="card divide-y divide-border">
            {issued.map((row) => (
              <div
                key={row.contract.id}
                className="flex flex-wrap items-start justify-between gap-3 p-4"
              >
                <div className="min-w-0">
                  <Link
                    href={`/market/contracts/${row.contract.id}`}
                    className="font-medium hover:underline"
                  >
                    {row.contract.title}
                  </Link>
                  <p className="text-xs text-muted">
                    {row.applicationCount} application{row.applicationCount === 1 ? "" : "s"} ·{" "}
                    {row.contract.contractNumber}
                  </p>
                </div>
                <ContractStatusBadge status={row.contract.status} />
              </div>
            ))}
          </div>
        </section>
      )}

      {ctx.company ? (
        <CreateContractForm />
      ) : (
        <div className="card p-5">
          <p className="text-sm text-muted">
            Switch to an approved company wallet from your dashboard to put work out to tender.
          </p>
        </div>
      )}
    </div>
  );
}
