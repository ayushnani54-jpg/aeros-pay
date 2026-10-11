import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import { getGovernmentSingleton } from "@/lib/queries";
import { getWalletTransactionsWithArchiveFallback } from "@/lib/archive";
import { TransactionRow } from "@/components/transaction-row";
import { ExportLink } from "@/components/forms/export-forms";
import { OfflineQueuePanel } from "@/components/offline/offline-queue-panel";

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams?: Promise<{
    page?: string;
    q?: string;
    type?: string;
    archived?: string;
  }>;
}) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const params = (await searchParams) ?? {};
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = 30;
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const txType = typeof params.type === "string" ? params.type.trim() : "ALL";
  const includeArchived = params.archived !== "0";

  const { user, company } = ctx;
  const walletId = company ? company.id : user.id;
  const walletType = company ? ("COMPANY" as const) : ("USER" as const);

  const [ledgerPage, gov] = await Promise.all([
    getWalletTransactionsWithArchiveFallback({
      walletId,
      walletType,
      limit: pageSize,
      offset: (page - 1) * pageSize,
      searchQuery: query || null,
      txTypeFilter: txType || null,
      includeArchived,
    }),
    company ? Promise.resolve(null) : getGovernmentSingleton(),
  ]);

  const buildPageHref = (targetPage: number) => {
    const sp = new URLSearchParams();
    if (targetPage > 1) sp.set("page", String(targetPage));
    if (query) sp.set("q", query);
    if (txType && txType !== "ALL") sp.set("type", txType);
    if (!includeArchived) sp.set("archived", "0");
    const qs = sp.toString();
    return qs ? `/transactions?${qs}` : "/transactions";
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Activity &amp; Historical Ledger</h1>
          <p className="mt-1 text-sm text-muted">
            Every payment for {company ? company.name : "your personal wallet"} ({ctx.handle}).
            Seamlessly merges hot operational records in Neon with verified historical records in{" "}
            <span className="font-mono">aeros-archive-ledger</span>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="badge badge-active text-xs">
            Neon Live: {ledgerPage.liveCount} · GitHub Archive:{" "}
            {ledgerPage.archivedCountIncluded}
          </span>
          <ExportLink
            href={
              company
                ? "/api/export/transactions?scope=company&format=csv"
                : "/api/export/transactions?format=csv"
            }
            label="Download CSV"
            testId="download-transactions-csv"
          />
        </div>
      </div>

      {/* Filter & Search Bar */}
      <form method="GET" action="/transactions" className="card p-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <label className="label text-xs">Search Reference, Handle, or Note</label>
            <input
              type="text"
              name="q"
              defaultValue={query}
              placeholder="e.g. TX-..., @username, salary, market"
              className="input text-xs"
            />
          </div>
          <div>
            <label className="label text-xs">Transaction Category</label>
            <select name="type" defaultValue={txType} className="input text-xs">
              <option value="ALL">All Types</option>
              <option value="TRANSFER">User Transfer</option>
              <option value="COMPANY_PAYMENT">Company Payment</option>
              <option value="COMPANY_SALE">Company Sale</option>
              <option value="MARKET_TRADE_BUY">Synthetic Market Buy / Short</option>
              <option value="MARKET_TRADE_SELL">Synthetic Market Sell / Cover</option>
              <option value="EXCHANGE_PACKAGE_CREDIT">Exchange Package Credit</option>
              <option value="REFUND_PAYOUT">Refund Payout</option>
              <option value="INVOICE_PAYMENT">Invoice Payment</option>
              <option value="CONTRACT_PAYMENT">Contract Payment</option>
              <option value="LOAN_DISBURSEMENT">Loan Disbursement</option>
              <option value="LOAN_REPAYMENT">Loan Repayment</option>
            </select>
          </div>
          <div>
            <label className="label text-xs">Archive Layer</label>
            <select
              name="archived"
              defaultValue={includeArchived ? "1" : "0"}
              className="input text-xs"
            >
              <option value="1">Neon + GitHub Archive</option>
              <option value="0">Neon Hot Records Only</option>
            </select>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted">
            Showing page {page} ({ledgerPage.records.length} records on this page)
          </p>
          <div className="flex items-center gap-2">
            {(query || txType !== "ALL" || !includeArchived) && (
              <Link href="/transactions" className="btn btn-secondary text-xs">
                Reset Filters
              </Link>
            )}
            <button type="submit" className="btn btn-primary text-xs">
              Apply Filter
            </button>
          </div>
        </div>
      </form>

      {gov && (
        <OfflineQueuePanel
          offlinePolicyEnabled={gov.offlineTransactionsEnabled}
          showQueueForm={false}
        />
      )}

      {ledgerPage.records.length === 0 ? (
        <div className="card p-6">
          <p className="text-sm text-muted">No matching transactions found.</p>
        </div>
      ) : (
        <div className="card divide-y divide-border px-5">
          {ledgerPage.records.map((tx) => (
            <TransactionRow
              key={tx.id}
              tx={tx}
              viewerId={walletId}
              viewerUsername={company ? company.username : user.username}
            />
          ))}
        </div>
      )}

      {(page > 1 || ledgerPage.hasMore) && (
        <div className="flex items-center justify-between text-xs">
          <Link
            href={buildPageHref(Math.max(1, page - 1))}
            className={`btn btn-secondary text-xs ${
              page <= 1 ? "pointer-events-none opacity-40" : ""
            }`}
          >
            &larr; Previous Page
          </Link>
          <span className="font-mono text-muted">Page {page}</span>
          <Link
            href={buildPageHref(page + 1)}
            className={`btn btn-secondary text-xs ${
              !ledgerPage.hasMore ? "pointer-events-none opacity-40" : ""
            }`}
          >
            Next Page &rarr;
          </Link>
        </div>
      )}
    </div>
  );
}
