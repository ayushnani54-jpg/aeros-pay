import Link from "next/link";
import { getEconomicOverview, searchTransactions } from "@/lib/queries";
import { getLoanCounts } from "@/lib/loans";
import { TransactionRow } from "@/components/transaction-row";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatTaxRateBp } from "@/lib/tax";

export default async function GovTreasuryPage() {
  const [overview, loanCounts, recent] = await Promise.all([
    getEconomicOverview(),
    getLoanCounts(),
    searchTransactions({ limit: 200 }),
  ]);

  if (!overview) {
    return (
      <div className="card p-6">
        <p className="text-sm text-muted">The Government account is not initialized.</p>
      </div>
    );
  }

  const treasuryActivity = recent
    .filter((t) => t.senderType === "GOVERNMENT" || t.receiverType === "GOVERNMENT")
    .slice(0, 30);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Treasury</h1>
        <p className="mt-1 text-sm text-muted">
          Every Aeros in existence sits in exactly one of three places: the treasury, a user
          wallet, or a company wallet.
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Treasury balance" value={overview.treasury} />
        <Stat label="Total supply" value={overview.totalSupply} />
        <Stat label="Circulating" value={overview.circulating} />
        <Stat label="Total issued" value={overview.totalIssued} />
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Where the Aeros are</h2>
        <dl className="space-y-1 text-sm">
          <Row label="Government treasury" value={overview.treasury} />
          <Row label="Held by users" value={overview.userHeld} />
          <Row label="Held by companies" value={overview.companyHeld} />
          <div className="flex justify-between border-t border-border pt-2 font-medium">
            <dt>Total accounted for</dt>
            <dd>
              {overview.accounted.toLocaleString()} {CURRENCY_NAME}
            </dd>
          </div>
          <div className="flex justify-between font-medium">
            <dt>Recorded total supply</dt>
            <dd>
              {overview.totalSupply.toLocaleString()} {CURRENCY_NAME}
            </dd>
          </div>
        </dl>
        <p className={`mt-3 text-sm ${overview.balanced ? "text-success" : "text-danger"}`}>
          {overview.balanced
            ? "Balanced — the ledger reconciles exactly."
            : "MISMATCH — the ledger does not reconcile. Investigate before making changes."}
        </p>
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Economic activity</h2>
        <dl className="space-y-1 text-sm">
          <Row label="Tax collected (all time)" value={overview.taxCollected} />
          <Row label="Government spending" value={overview.governmentSpending} />
          <Row label="Company sales volume" value={overview.companySalesVolume} />
          <Row label="User payment volume" value={overview.userPaymentVolume} />
          <Row label="Loans outstanding" value={loanCounts.outstandingTotal} />
          <div className="flex justify-between">
            <dt className="text-muted">Transactions recorded</dt>
            <dd>{overview.transactionCount.toLocaleString()}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Personal tax rate</dt>
            <dd>{formatTaxRateBp(overview.taxRateBp)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Default company tax rate</dt>
            <dd>{formatTaxRateBp(overview.companyTaxRateBp)}</dd>
          </div>
        </dl>
      </section>

      <section className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">Treasury ledger</h2>
          <Link
            href="/gov/payments"
            className="text-sm font-medium text-muted hover:text-foreground"
          >
            Make a payment
          </Link>
        </div>
        {treasuryActivity.length === 0 ? (
          <p className="text-sm text-muted">No treasury activity yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {treasuryActivity.map((tx) => (
              <TransactionRow key={tx.id} tx={tx} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-tight">
        {value.toLocaleString()}
        <span className="ml-1 text-xs font-medium text-muted">{CURRENCY_NAME}</span>
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{label}</dt>
      <dd>
        {value.toLocaleString()} {CURRENCY_NAME}
      </dd>
    </div>
  );
}
