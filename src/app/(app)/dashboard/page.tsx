import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import {
  getGovernmentSingleton,
  getOpenIssuanceRequestsForUser,
  getTransactionsForWallet,
} from "@/lib/queries";
import { getInvoicesForBuyer } from "@/lib/invoices";
import { getPendingOffersForOwner } from "@/lib/sales";
import { getOutstandingInstalmentsForOwner } from "@/lib/queries";
import { getMarketChartData, getUserMarketPortfolio } from "@/lib/synthetic-market";
import { CURRENCY_NAME } from "@/lib/constants";
import { TransactionRow } from "@/components/transaction-row";
import { StatusBadge } from "@/components/status-badge";
import { WalletSwitcher } from "@/components/wallet-switcher";
import { effectiveUserStatus } from "@/lib/status";
import { runLoanMaintenance } from "@/lib/loans";
import { formatDate } from "@/lib/datetime";
import { PromotionSlot } from "@/components/promotion-slot";
import { getLiveAd, runPromotionCharges } from "@/lib/promotions";
import { DashboardOfflineSync } from "@/components/offline/dashboard-offline-sync";

export default async function DashboardPage() {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const { user, company } = ctx;

  // Keeps overdue flags and reminders current without needing a scheduler.
  if (ctx.availableCompanies.length > 0) {
    await runLoanMaintenance().catch(() => undefined);
  }

  // The promotion slot's lazy daily charge.
  await runPromotionCharges().catch(() => undefined);

  const [
    recentTx,
    openIssuances,
    pendingInvoices,
    pendingOffers,
    dueInstalments,
    ad,
    gov,
    marketChart,
    marketPortfolio,
  ] = await Promise.all([
    getTransactionsForWallet(
      company ? company.id : user.id,
      company ? "COMPANY" : "USER",
      5,
    ),
    getOpenIssuanceRequestsForUser(user.id),
    getInvoicesForBuyer(user.id, 20),
    getPendingOffersForOwner(user.id),
    getOutstandingInstalmentsForOwner(user.id),
    getLiveAd(),
    getGovernmentSingleton(),
    getMarketChartData("15m", 16).catch(() => null),
    getUserMarketPortfolio(user.id).catch(() => null),
  ]);

  const pendingVotes = openIssuances.filter((row) => !row.myVote);
  const unpaidInvoices = pendingInvoices.filter((r) => r.invoice.status === "PENDING");
  const overdue = dueInstalments.filter((r) => r.instalment.status === "OVERDUE");

  const viewerId = company ? company.id : user.id;
  const offlineRecentActivity = recentTx.map((tx) => {
    const outgoing = tx.senderType !== "GOVERNMENT" && tx.senderId === viewerId;
    const counterpartyType = outgoing ? tx.receiverType : tx.senderType;
    const counterpartyUsername = outgoing ? tx.receiverUsername : tx.senderUsername;
    return {
      id: tx.id,
      txRef: tx.txRef,
      counterparty: counterpartyType === "GOVERNMENT" ? "Government" : `@${counterpartyUsername}`,
      direction: outgoing ? ("out" as const) : ("in" as const),
      amount: outgoing ? tx.grossAmount : tx.netAmount,
      createdAt: tx.createdAt.toISOString(),
    };
  });

  const hasMadeTransfer =
    recentTx.length > 0 || user.archivedCredits > 0 || user.archivedDebits > 0;
  const hasMarketActivity =
    (marketPortfolio?.position.totalBoughtUnits ?? 0) > 0 ||
    (marketPortfolio?.position.totalShortedUnits ?? 0) > 0;
  const hasCompanyActivity = ctx.availableCompanies.length > 0;

  return (
    <div className="space-y-6">
      <DashboardOfflineSync
        balance={ctx.balance}
        handle={ctx.handle}
        displayLabel={ctx.displayLabel}
        status={effectiveUserStatus(user)}
        recentActivity={offlineRecentActivity}
      />

      <section className="card p-6">
        <p className="text-sm text-muted">
          {company ? `${company.name} balance` : "Your balance"}
        </p>
        <p className="mt-1 text-4xl font-semibold tracking-tight">
          {ctx.balance.toLocaleString()}{" "}
          <span className="text-xl font-medium text-muted">{CURRENCY_NAME}</span>
        </p>
        <div className="mt-3 flex items-center gap-2">
          <StatusBadge status={effectiveUserStatus(user)} />
          <span className="text-sm text-muted">{ctx.handle}</span>
        </div>
      </section>

      <WalletSwitcher
        companies={ctx.availableCompanies}
        activeCompanyId={company?.id ?? null}
        personalLabel={user.displayName}
      />

      {/* Economy Hub Live Pulse */}
      {marketChart && gov && (
        <section className="card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-medium">Aeros Economy Hub</h2>
              <p className="text-xs text-muted">
                Live synthetic market index &amp; sovereign economy metrics
              </p>
            </div>
            <Link href="/aeros-market" className="btn btn-secondary text-xs">
              Open Trading Terminal &rarr;
            </Link>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-md bg-surface p-2.5">
              <p className="text-[11px] text-muted">AMI Index Price</p>
              <p className="mt-0.5 font-mono text-sm font-semibold">
                {marketChart.state.currentPrice.toLocaleString()} {CURRENCY_NAME}{" "}
                <span className="text-[11px] font-normal text-muted">
                  ({marketChart.stats24h.changePercent})
                </span>
              </p>
            </div>
            <div className="rounded-md bg-surface p-2.5">
              <p className="text-[11px] text-muted">Your Market Position</p>
              <p className="mt-0.5 font-mono text-sm font-semibold">
                Long {marketPortfolio?.position.unitsHeld ?? 0} · Short{" "}
                {marketPortfolio?.position.shortUnitsHeld ?? 0}
              </p>
            </div>
            <div className="rounded-md bg-surface p-2.5">
              <p className="text-[11px] text-muted">Economy Total Supply</p>
              <p className="mt-0.5 font-mono text-sm font-semibold">
                {gov.totalSupply.toLocaleString()} {CURRENCY_NAME}
              </p>
            </div>
            <div className="rounded-md bg-surface p-2.5">
              <p className="text-[11px] text-muted">Default Tax Rate</p>
              <p className="mt-0.5 font-mono text-sm font-semibold">
                {(gov.taxRateBp / 100).toFixed(2)}%
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Onboarding Checklist for Newer Citizens */}
      {(!hasMadeTransfer || !hasMarketActivity || !hasCompanyActivity) && (
        <section className="card p-4">
          <h2 className="text-sm font-medium">Citizen Economy Checklist</h2>
          <p className="mt-0.5 text-xs text-muted">
            Explore the core pillars of the Aeros Pay virtual economy:
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-3 text-xs">
            <Link
              href="/pay"
              className={`rounded-md border p-2.5 ${
                hasMadeTransfer
                  ? "border-border bg-surface text-muted"
                  : "border-[#111111] font-medium"
              }`}
            >
              <span>{hasMadeTransfer ? "✓ " : "1. "}</span>
              Send or receive a wallet payment
            </Link>
            <Link
              href="/aeros-market"
              className={`rounded-md border p-2.5 ${
                hasMarketActivity
                  ? "border-border bg-surface text-muted"
                  : "border-[#111111] font-medium"
              }`}
            >
              <span>{hasMarketActivity ? "✓ " : "2. "}</span>
              Trade Long or Short on the AMI Index
            </Link>
            <Link
              href="/companies"
              className={`rounded-md border p-2.5 ${
                hasCompanyActivity
                  ? "border-border bg-surface text-muted"
                  : "border-[#111111] font-medium"
              }`}
            >
              <span>{hasCompanyActivity ? "✓ " : "3. "}</span>
              Launch or explore a registered Company
            </Link>
          </div>
        </section>
      )}

      {/* Things that need the person's attention, in priority order. */}
      {overdue.length > 0 && (
        <Alert
          tone="danger"
          title={`${overdue.length} overdue loan instalment${overdue.length === 1 ? "" : "s"}`}
          body="A repayment is past its due date. Pay it to avoid further Government action."
          href="/my-company/loans"
          cta="View loans"
        />
      )}

      {pendingOffers.length > 0 && (
        <Alert
          tone="normal"
          title={`${pendingOffers.length} offer${pendingOffers.length === 1 ? "" : "s"} to buy your company`}
          body="Someone wants to buy a company you own. Nothing happens unless you accept."
          href="/my-company/sale"
          cta="Review offers"
        />
      )}

      {unpaidInvoices.length > 0 && (
        <Alert
          tone="normal"
          title={`${unpaidInvoices.length} unpaid invoice${unpaidInvoices.length === 1 ? "" : "s"}`}
          body="A company has sent you an invoice."
          href="/invoices"
          cta="View invoices"
        />
      )}

      {pendingVotes.length > 0 && (
        <Alert
          tone="normal"
          title="Aeros issuance vote requested"
          body="The Government has proposed new Aeros issuance and needs your vote."
          href="/updates"
          cta="Review and vote"
        />
      )}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <QuickAction href="/pay" label="Pay" />
        <QuickAction href="/exchange" label="Aeros Exchange" />
        <QuickAction href="/aeros-market" label="Aeros Market" />
        <QuickAction href="/market" label="Goods Market" />
        <QuickAction href="/market/orders" label="My Orders" />
        <QuickAction href="/refunds" label="Refund Center" />
        <QuickAction href="/companies" label="Companies" />
        <QuickAction href="/transactions" label="Activity" />
      </section>

      <PromotionSlot ad={ad} />

      <section className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">Recent activity</h2>
          <Link
            href="/transactions"
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
              <TransactionRow
                key={tx.id}
                tx={tx}
                viewerId={company ? company.id : user.id}
                viewerUsername={company ? company.username : user.username}
              />
            ))}
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="font-medium">Account</h2>
        <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-muted">Display name</dt>
          <dd>{user.displayName}</dd>
          <dt className="text-muted">Username</dt>
          <dd className="font-mono">@{user.username}</dd>
          <dt className="text-muted">Status</dt>
          <dd>
            <StatusBadge status={effectiveUserStatus(user)} />
          </dd>
          <dt className="text-muted">Registered</dt>
          <dd>{formatDate(user.createdAt)}</dd>
        </dl>
      </section>
    </div>
  );
}

function Alert({
  tone,
  title,
  body,
  href,
  cta,
}: {
  tone: "normal" | "danger";
  title: string;
  body: string;
  href: string;
  cta: string;
}) {
  return (
    <section className={`card p-5 ${tone === "danger" ? "border-[#e3b3ae]" : "border-[#111111]"}`}>
      <h2 className={`font-medium ${tone === "danger" ? "text-danger" : ""}`}>{title}</h2>
      <p className="mt-1 text-sm text-muted">{body}</p>
      <Link href={href} className="btn btn-primary mt-3 inline-block text-sm">
        {cta}
      </Link>
    </section>
  );
}

function QuickAction({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="card flex items-center justify-center p-4 text-center text-sm font-medium hover:bg-surface"
    >
      {label}
    </Link>
  );
}
