import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompanyAdminProfile, getGovernmentSingleton } from "@/lib/queries";
import { previewValuation } from "@/lib/sales";
import {
  AdjustCompanyBalanceForm,
  CompanyReviewActions,
  CompanyStatusActions,
  CompanyTaxForm,
  EditCompanyForm,
  GovernmentOfferForm,
} from "@/components/forms/gov-forms";
import {
  CompanyStatusBadge,
  InvoiceStatusBadge,
  LoanStatusBadge,
  SaleStatusBadge,
} from "@/components/status-badge";
import { TransactionRow } from "@/components/transaction-row";
import { COMPANY_APPROVAL_FUNDING_AMOUNT, CURRENCY_NAME } from "@/lib/constants";
import { effectiveCompanyStatus } from "@/lib/status";

export default async function GovCompanyDetail({ params }: PageProps<"/gov/companies/[id]">) {
  const { id } = await params;
  const [profile, gov] = await Promise.all([
    getCompanyAdminProfile(id),
    getGovernmentSingleton(),
  ]);
  if (!profile) notFound();

  const { company, ownerUsername, ownerDisplayName, ownerId } = profile;
  const status = effectiveCompanyStatus(company);
  const defaultTaxPercent = (gov?.companyTaxRateBp ?? 500) / 100;
  const valuation = await previewValuation(company);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/gov/companies" className="text-sm text-muted hover:text-foreground">
          ← Companies
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{company.name}</h1>
            <p className="mt-1 font-mono text-sm text-muted">@{company.username}</p>
          </div>
          <CompanyStatusBadge status={status} />
        </div>
      </div>

      {/* Application details */}
      <section className="card p-5">
        <h2 className="mb-3 font-medium">Application</h2>
        <dl className="space-y-2 text-sm">
          <Row label="Owner">
            <Link href={`/gov/users/${ownerId}`} className="underline">
              {ownerDisplayName} (@{ownerUsername})
            </Link>
          </Row>
          <Row label="Category">{company.category}</Row>
          <Row label="Applied">{new Date(company.createdAt).toLocaleString()}</Row>
          {company.reviewedAt && (
            <Row label="Reviewed">
              {new Date(company.reviewedAt).toLocaleString()} by {company.reviewedBy}
            </Row>
          )}
          {company.fundedAt && (
            <Row label="Funded">{new Date(company.fundedAt).toLocaleString()}</Row>
          )}
          {company.rejectionReason && (
            <Row label="Rejection reason">{company.rejectionReason}</Row>
          )}
        </dl>
        <div className="mt-4">
          <p className="text-sm font-medium">Why they wanted this company</p>
          <p className="mt-1 whitespace-pre-line text-sm text-muted">{company.reason}</p>
        </div>
        <div className="mt-4">
          <p className="text-sm font-medium">Description</p>
          <p className="mt-1 whitespace-pre-line text-sm text-muted">{company.description}</p>
        </div>
      </section>

      {company.status === "PENDING" && (
        <section className="card border-[#111111] p-5">
          <h2 className="mb-3 font-medium">Review this application</h2>
          <CompanyReviewActions
            companyId={company.id}
            fundingAmount={COMPANY_APPROVAL_FUNDING_AMOUNT}
          />
        </section>
      )}

      {/* Figures */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Balance" value={company.balance} />
        <Stat label="Lifetime sales" value={profile.salesTotal} />
        <Stat label="Tax paid" value={profile.taxPaid} />
        <Stat label="IP strikes" value={company.strikes} plain />
      </section>

      <section className="card p-5">
        <h2 className="mb-2 font-medium">Current sale valuation</h2>
        <p className="text-sm text-muted">
          {valuation.salesFigure.toLocaleString()} lifetime sales ×{" "}
          {(valuation.multiplierBp / 10000).toFixed(2)} ={" "}
          <span className="font-medium text-foreground">
            {valuation.valuation.toLocaleString()} {CURRENCY_NAME}
          </span>
        </p>
        <p className="mt-1 text-xs text-muted">
          {valuation.eligibility.eligible
            ? "Eligible to be listed for sale by its owner."
            : valuation.eligibility.reason}
        </p>
        {status === "APPROVED" && !company.governmentOwned && (
          <div className="mt-4">
            <GovernmentOfferForm companyId={company.id} />
          </div>
        )}
        {company.governmentOwned && (
          <p className="mt-3 text-sm">
            This company is under Government stewardship (acquired{" "}
            {company.governmentAcquiredAt
              ? new Date(company.governmentAcquiredAt).toLocaleDateString()
              : "—"}
            ).
          </p>
        )}
      </section>

      {/* Administration */}
      <section className="card p-5">
        <h2 className="mb-3 font-medium">Status</h2>
        <CompanyStatusActions companyId={company.id} status={company.status} />
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Tax rate</h2>
        <CompanyTaxForm
          companyId={company.id}
          currentPercent={company.taxRateBp === null ? null : company.taxRateBp / 100}
          defaultPercent={defaultTaxPercent}
        />
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Balance adjustment</h2>
        <AdjustCompanyBalanceForm companyId={company.id} />
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Edit profile</h2>
        <EditCompanyForm
          companyId={company.id}
          name={company.name}
          username={company.username}
          category={company.category}
          description={company.description}
        />
      </section>

      {/* Records */}
      {profile.loans.length > 0 && (
        <section className="card p-5">
          <h2 className="mb-3 font-medium">Loans</h2>
          <div className="divide-y divide-border">
            {profile.loans.map((loan) => (
              <Link
                key={loan.id}
                href={`/gov/loans/${loan.id}`}
                className="flex items-center justify-between gap-3 py-3 text-sm hover:underline"
              >
                <div>
                  <p className="font-medium">{loan.loanNumber}</p>
                  <p className="text-xs text-muted">
                    {(loan.principal ?? loan.requestedAmount).toLocaleString()} {CURRENCY_NAME} ·{" "}
                    {new Date(loan.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <LoanStatusBadge status={loan.status} />
              </Link>
            ))}
          </div>
        </section>
      )}

      {profile.offers.length > 0 && (
        <section className="card p-5">
          <h2 className="mb-3 font-medium">Sale offers</h2>
          <div className="divide-y divide-border">
            {profile.offers.map((offer) => (
              <div key={offer.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div>
                  <p className="font-medium">
                    {offer.amount.toLocaleString()} {CURRENCY_NAME}
                  </p>
                  <p className="text-xs text-muted">
                    from {offer.offerorType === "GOVERNMENT" ? "Government" : "a user"} ·{" "}
                    {new Date(offer.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <SaleStatusBadge status={offer.status} />
              </div>
            ))}
          </div>
        </section>
      )}

      {profile.invoices.length > 0 && (
        <section className="card p-5">
          <h2 className="mb-3 font-medium">Invoices</h2>
          <div className="divide-y divide-border">
            {profile.invoices.slice(0, 20).map((invoice) => (
              <div
                key={invoice.id}
                className="flex items-center justify-between gap-3 py-3 text-sm"
              >
                <div>
                  <p className="font-medium">{invoice.itemName}</p>
                  <p className="text-xs text-muted">
                    {invoice.invoiceNumber} ·{" "}
                    {new Date(invoice.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-mono">
                    {invoice.total.toLocaleString()} {CURRENCY_NAME}
                  </p>
                  <InvoiceStatusBadge status={invoice.status} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Company transactions</h2>
        {profile.transactions.length === 0 ? (
          <p className="text-sm text-muted">No transactions yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {profile.transactions.map((tx) => (
              <TransactionRow
                key={tx.id}
                tx={tx}
                viewerId={company.id}
                viewerUsername={company.username}
              />
            ))}
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Government actions on this company</h2>
        {profile.governmentActions.length === 0 ? (
          <p className="text-sm text-muted">None recorded.</p>
        ) : (
          <div className="divide-y divide-border">
            {profile.governmentActions.map((log) => (
              <div key={log.id} className="py-3 text-sm">
                <p className="font-medium">{log.action.replace(/_/g, " ")}</p>
                <p className="text-xs text-muted">
                  {log.actorLabel} · {new Date(log.createdAt).toLocaleString()}
                  {log.previousValue || log.newValue
                    ? ` · ${log.previousValue ?? "—"} → ${log.newValue ?? "—"}`
                    : ""}
                </p>
                {log.reason && <p className="mt-1 text-xs text-muted">{log.reason}</p>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function Stat({ label, value, plain = false }: { label: string; value: number; plain?: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold">
        {value.toLocaleString()}
        {!plain && <span className="ml-1 text-xs font-medium text-muted">{CURRENCY_NAME}</span>}
      </p>
    </div>
  );
}
