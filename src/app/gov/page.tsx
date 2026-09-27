import Link from "next/link";
import {
  getCompanyCounts,
  getEconomicOverview,
  getPendingCompanyCount,
  getAllTransactions,
  getUserCounts,
} from "@/lib/queries";
import { getLoanCounts, runLoanMaintenance } from "@/lib/loans";
import { getUnreadSupportCountForGovernment } from "@/lib/support";
import { getOpenComplaintCount } from "@/lib/ip";
import { getAllOpenListings, getPendingOfferCount } from "@/lib/sales";
import { getAllIssuanceRequests } from "@/lib/queries";
import { healExpiredSuspensions } from "@/lib/status";
import { TransactionRow } from "@/components/transaction-row";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatTaxRateBp } from "@/lib/tax";

export default async function GovDashboard() {
  // Keep derived state current without a scheduler.
  await Promise.all([
    healExpiredSuspensions().catch(() => undefined),
    runLoanMaintenance().catch(() => undefined),
  ]);

  const [
    overview,
    userCounts,
    companyCounts,
    pendingCompanies,
    loanCounts,
    unreadSupport,
    openComplaints,
    listings,
    pendingOffers,
    issuances,
    recentTx,
  ] = await Promise.all([
    getEconomicOverview(),
    getUserCounts(),
    getCompanyCounts(),
    getPendingCompanyCount(),
    getLoanCounts(),
    getUnreadSupportCountForGovernment(),
    getOpenComplaintCount(),
    getAllOpenListings(),
    getPendingOfferCount(),
    getAllIssuanceRequests(),
    getAllTransactions(8),
  ]);

  if (!overview) {
    return (
      <div className="card p-6">
        <p className="text-sm text-muted">The Government account is not initialized.</p>
      </div>
    );
  }

  const openIssuances = issuances.filter((i) => i.status === "OPEN").length;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>

      {!overview.balanced && (
        <div className="card border-[#e3b3ae] p-4">
          <p className="text-sm font-medium text-danger">Ledger imbalance detected</p>
          <p className="mt-1 text-sm text-muted">
            Treasury + user balances + company balances ({overview.accounted.toLocaleString()})
            does not equal total supply ({overview.totalSupply.toLocaleString()}). This should
            never happen — investigate before making further changes.
          </p>
        </div>
      )}

      {/* Economy */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Treasury" value={overview.treasury} />
        <Stat label="Total supply" value={overview.totalSupply} />
        <Stat label="Circulating" value={overview.circulating} />
        <Stat label="Tax collected" value={overview.taxCollected} />
        <Stat label="User-held" value={overview.userHeld} />
        <Stat label="Company-held" value={overview.companyHeld} />
        <Stat label="Transactions" value={overview.transactionCount} plain />
        <Stat label="Current tax" text={formatTaxRateBp(overview.taxRateBp)} />
      </section>

      {/* Things needing attention */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted">Needs attention</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Attention
            href="/gov/companies?status=PENDING"
            label="Company applications"
            count={pendingCompanies}
          />
          <Attention href="/gov/loans?status=PENDING" label="Loan applications" count={loanCounts.pending} />
          <Attention href="/gov/loans" label="Overdue instalments" count={loanCounts.overdueInstalments} />
          <Attention href="/gov/support" label="Unread support messages" count={unreadSupport} />
          <Attention href="/gov/ip" label="Open IP complaints" count={openComplaints} />
          <Attention href="/gov/issuance" label="Open issuance votes" count={openIssuances} />
          <Attention href="/gov/sales" label="Companies for sale" count={listings.length} />
          <Attention href="/gov/sales" label="Pending sale offers" count={pendingOffers} />
        </div>
      </section>

      {/* Counts */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Users" value={userCounts.total} plain sub={`${userCounts.active} active`} />
        <Stat
          label="Companies"
          value={companyCounts.total}
          plain
          sub={`${companyCounts.approved} approved`}
        />
        <Stat
          label="Active loans"
          value={loanCounts.active}
          plain
          sub={`${loanCounts.outstandingTotal.toLocaleString()} ${CURRENCY_NAME} outstanding`}
        />
        <Stat label="Total issued" value={overview.totalIssued} />
      </section>

      {/* Quick actions */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Quick actions</h2>
        <div className="flex flex-wrap gap-2">
          <Action href="/gov/codes" label="Generate registration code" />
          <Action href="/gov/payments" label="Government payment" />
          <Action href="/gov/users" label="Fund a user" />
          <Action href="/gov/companies" label="Review companies" />
          <Action href="/gov/loans" label="Review loans" />
          <Action href="/gov/issuance" label="Create issuance" />
          <Action href="/gov/tax" label="Set tax rates" />
          <Action href="/gov/updates" label="Publish update" />
          <Action href="/gov/support" label="Support inbox" />
          <Action href="/gov/ip" label="Review IP complaints" />
          <Action href="/gov/control-room" label="Control Room" />
        </div>
      </section>

      <section className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">Recent activity</h2>
          <Link
            href="/gov/transactions"
            className="text-sm font-medium text-muted hover:text-foreground"
          >
            View all
          </Link>
        </div>
        {recentTx.length === 0 ? (
          <p className="text-sm text-muted">No transactions yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {recentTx.map((tx) => (
              <TransactionRow key={tx.id} tx={tx} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  text,
  plain = false,
  sub,
}: {
  label: string;
  value?: number;
  text?: string;
  plain?: boolean;
  sub?: string;
}) {
  return (
    <div className="card p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-tight">
        {text ?? value?.toLocaleString()}
        {!plain && !text && (
          <span className="ml-1 text-xs font-medium text-muted">{CURRENCY_NAME}</span>
        )}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </div>
  );
}

function Attention({ href, label, count }: { href: string; label: string; count: number }) {
  return (
    <Link
      href={href}
      className={`card flex items-center justify-between p-4 hover:bg-surface ${
        count > 0 ? "border-[#111111]" : ""
      }`}
    >
      <span className="text-sm">{label}</span>
      <span className={`text-lg font-semibold ${count > 0 ? "" : "text-muted"}`}>{count}</span>
    </Link>
  );
}

function Action({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="btn btn-secondary text-sm">
      {label}
    </Link>
  );
}
