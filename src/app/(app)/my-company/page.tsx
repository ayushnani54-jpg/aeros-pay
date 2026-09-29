import Link from "next/link";
import { getActingContext, getOwnedCompanies } from "@/lib/auth";
import { getCompanyDashboardStats, getTransactionsForWallet } from "@/lib/queries";
import { resolveCompanyTaxRateBp } from "@/lib/companies";
import { getPendingOffersForOwner } from "@/lib/sales";
import { getLoansForCompany, runLoanMaintenance } from "@/lib/loans";
import { CreateCompanyForm } from "@/components/forms/company-forms";
import { CompanyStatusBadge, LoanStatusBadge } from "@/components/status-badge";
import { TransactionRow } from "@/components/transaction-row";
import { WalletSwitcher } from "@/components/wallet-switcher";
import { CURRENCY_NAME } from "@/lib/constants";
import { effectiveCompanyStatus, formatSuspensionRemaining } from "@/lib/status";
import { formatDate } from "@/lib/datetime";
import { getCompanyOrderCounts } from "@/lib/marketplace";
import { CompanyQr } from "@/components/company-qr";
import { getRequestOrigin } from "@/lib/origin";
import { getCompanyRatingSummary } from "@/lib/ratings";
import { RatingSummaryLine } from "@/components/rating-stars";
import { ExportLink } from "@/components/forms/export-forms";

export default async function MyCompanyPage() {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const owned = await getOwnedCompanies(ctx.user.id);

  // No company yet — show the application form.
  if (owned.length === 0) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Create a company</h1>
          <p className="mt-1 text-sm text-muted">
            A company gets its own wallet and username, separate from your personal account.
            The Government reviews every application and funds approved companies from the
            treasury.
          </p>
        </div>
        <CreateCompanyForm />
      </div>
    );
  }

  const pending = owned.filter((c) => c.status === "PENDING");
  const rejected = owned.filter((c) => c.status === "REJECTED");
  const active = owned.filter((c) => effectiveCompanyStatus(c) === "APPROVED");

  // The company being managed: the active context, else the first approved one.
  const company = ctx.company ?? active[0] ?? null;

  if (!company) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-semibold tracking-tight">My company</h1>
        {pending.map((c) => (
          <div key={c.id} className="card p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium">{c.name}</p>
                <p className="text-sm text-muted">@{c.username}</p>
              </div>
              <CompanyStatusBadge status={c.status} />
            </div>
            <p className="mt-3 text-sm text-muted">
              Your application is with the Government. You will be notified when it is reviewed.
            </p>
          </div>
        ))}
        {rejected.map((c) => (
          <div key={c.id} className="card p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium">{c.name}</p>
                <p className="text-sm text-muted">@{c.username}</p>
              </div>
              <CompanyStatusBadge status={c.status} />
            </div>
            {c.rejectionReason && (
              <p className="mt-3 text-sm text-muted">Reason: {c.rejectionReason}</p>
            )}
          </div>
        ))}
        {owned.every((c) => c.status !== "PENDING") && <CreateCompanyForm />}
      </div>
    );
  }

  await runLoanMaintenance().catch(() => undefined);

  const [stats, recentTx, offers, loans, taxRateBp, orderCounts, ratingSummary, origin] =
    await Promise.all([
      getCompanyDashboardStats(company.id),
      getTransactionsForWallet(company.id, "COMPANY", 8),
      getPendingOffersForOwner(ctx.user.id),
      getLoansForCompany(company.id),
      resolveCompanyTaxRateBp(company),
      getCompanyOrderCounts(company.id),
      getCompanyRatingSummary(company.id),
      getRequestOrigin(),
    ]);

  const status = effectiveCompanyStatus(company);
  const activeLoan = loans.find((l) =>
    ["PENDING", "APPROVED", "ACTIVE", "DEFAULTED", "RESTRUCTURED"].includes(l.status),
  );
  const companyOffers = offers.filter((o) => o.company.id === company.id);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{company.name}</h1>
          <p className="mt-1 font-mono text-sm text-muted">@{company.username}</p>
        </div>
        <CompanyStatusBadge status={status} />
      </div>

      {status === "SUSPENDED" && (
        <div className="card border-[#e3b3ae] p-4">
          <p className="text-sm font-medium text-danger">This company is suspended</p>
          <p className="mt-1 text-sm text-muted">
            {company.suspensionReason ?? "Contact the Government for details."}
            {company.suspendedUntil
              ? ` Ends in ${formatSuspensionRemaining(company.suspendedUntil)}.`
              : ""}
          </p>
        </div>
      )}

      <WalletSwitcher
        companies={ctx.availableCompanies}
        activeCompanyId={ctx.company?.id ?? null}
        personalLabel={ctx.user.displayName}
      />

      <section className="card p-6">
        <p className="text-sm text-muted">Company balance</p>
        <p className="mt-1 text-4xl font-semibold tracking-tight">
          {company.balance.toLocaleString()}{" "}
          <span className="text-xl font-medium text-muted">{CURRENCY_NAME}</span>
        </p>
        <p className="mt-2 text-xs text-muted">
          Separate from your personal wallet. Tax rate: {(taxRateBp / 100).toFixed(2)}%
        </p>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Lifetime sales" value={stats.salesTotal} />
        <Stat label="Tax paid" value={stats.taxPaid} />
        <Stat label="Payments in" value={stats.incomingCount} plain />
        <Stat label="Payments out" value={stats.outgoingCount} plain />
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <NavCard href="/pay" label="Send payment" />
        <NavCard href="/my-company/invoices" label={`Invoices (${stats.pendingInvoices})`} />
        <NavCard href="/my-company/offers" label="Listings" />
        <NavCard
          href="/my-company/orders"
          label={
            orderCounts.pending + orderCounts.waitingForInvoice > 0
              ? `Orders (${orderCounts.pending + orderCounts.waitingForInvoice})`
              : "Orders"
          }
        />
        <NavCard href="/my-company/promotions" label="Promotions" />
        <NavCard href="/my-company/loans" label="Loans" />
        <NavCard href="/my-company/sale" label="Sell company" />
      </section>

      {orderCounts.pending > 0 && (
        <section className="card border-[#111111] p-5">
          <h2 className="font-medium">
            {orderCounts.pending} order{orderCounts.pending === 1 ? "" : "s"} waiting to be
            accepted
          </h2>
          <p className="mt-1 text-sm text-muted">
            Accept an order and send its invoice; payment settles to this company&rsquo;s wallet.
          </p>
          <Link href="/my-company/orders" className="btn btn-primary mt-3 inline-block text-sm">
            Review orders
          </Link>
        </section>
      )}

      {companyOffers.length > 0 && (
        <section className="card border-[#111111] p-5">
          <h2 className="font-medium">
            {companyOffers.length} pending offer{companyOffers.length === 1 ? "" : "s"} to buy
            this company
          </h2>
          <Link href="/my-company/sale" className="btn btn-primary mt-3 inline-block text-sm">
            Review offers
          </Link>
        </section>
      )}

      {activeLoan && (
        <section className="card p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-medium">Loan {activeLoan.loanNumber}</h2>
              <p className="mt-1 text-sm text-muted">
                {activeLoan.totalPayable
                  ? `${(activeLoan.principalPaid + activeLoan.interestPaid).toLocaleString()} of ${activeLoan.totalPayable.toLocaleString()} ${CURRENCY_NAME} repaid`
                  : `${activeLoan.requestedAmount.toLocaleString()} ${CURRENCY_NAME} requested`}
              </p>
              {activeLoan.nextDueAt && (
                <p className="mt-1 text-xs text-muted">
                  Next due {formatDate(activeLoan.nextDueAt)}
                </p>
              )}
            </div>
            <LoanStatusBadge status={activeLoan.status} />
          </div>
          <Link href="/my-company/loans" className="btn btn-secondary mt-3 inline-block text-sm">
            Manage loan
          </Link>
        </section>
      )}

      <section className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">Recent company activity</h2>
          <Link
            href="/transactions"
            className="text-sm font-medium text-muted hover:text-foreground"
          >
            View all
          </Link>
        </div>
        {recentTx.length === 0 ? (
          <p className="text-sm text-muted">No company transactions yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {recentTx.map((tx) => (
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">Ratings</h2>
          <RatingSummaryLine average={ratingSummary.average} count={ratingSummary.count} />
        </div>
        <p className="mt-1 text-sm text-muted">
          Buyers can rate an order once it completes. Comments are removed after 30 days; the
          stars stay.
        </p>
        <Link href={`/c/${company.username}`} className="btn btn-secondary mt-3 inline-block text-sm">
          See them on your public profile
        </Link>
      </section>

      {status === "APPROVED" && (
        <section className="card p-5">
          <h2 className="mb-3 font-medium">Your QR code</h2>
          <CompanyQr origin={origin} username={company.username} />
          <p className="mt-3 text-xs text-muted">
            Print it or show it on screen. It opens your public profile — never your balance or
            your transactions.
          </p>
        </section>
      )}

      <section className="card p-5">
        <h2 className="font-medium">Download your company&apos;s records</h2>
        <p className="mt-1 text-sm text-muted">
          Generated when you ask for them and never stored. These links always export{" "}
          {company.name} — the company is taken from the wallet you are using, not from the link.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <ExportLink
            href="/api/export/transactions?scope=company&format=csv"
            label="Transactions (CSV)"
            testId="company-export-transactions"
          />
          <ExportLink
            href="/api/export/invoices?scope=company&format=csv"
            label="Invoices (CSV)"
          />
          <ExportLink href="/api/export/orders?scope=company&format=csv" label="Orders (CSV)" />
          <ExportLink
            href="/api/export/company-sales?scope=company&format=csv"
            label="Sale records (CSV)"
          />
          <ExportLink
            href="/api/export/transactions?scope=company&format=json"
            label="Transactions (JSON)"
          />
        </div>
      </section>

      <section className="card p-5">
        <h2 className="font-medium">Other tools</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href="/my-company/complaints" className="btn btn-secondary text-sm">
            IP complaints
          </Link>
          <Link href={`/c/${company.username}`} className="btn btn-secondary text-sm">
            View public profile
          </Link>
        </div>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  plain = false,
}: {
  label: string;
  value: number;
  plain?: boolean;
}) {
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

function NavCard({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="card flex items-center justify-center p-4 text-center text-sm font-medium hover:bg-surface"
    >
      {label}
    </Link>
  );
}
