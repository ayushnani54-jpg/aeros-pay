import Link from "next/link";
import {
  getAllIssuanceRequests,
  getAllTransactions,
  getGovernmentSingleton,
  getTransactionCount,
  getUserCounts,
} from "@/lib/queries";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatTaxRateBp } from "@/lib/tax";
import { TransactionRow } from "@/components/transaction-row";

export default async function GovDashboardPage() {
  const [gov, userCounts, txCount, issuances, recentTx] = await Promise.all([
    getGovernmentSingleton(),
    getUserCounts(),
    getTransactionCount(),
    getAllIssuanceRequests(),
    getAllTransactions(8),
  ]);

  const pendingIssuances = issuances.filter((i) => i.status === "OPEN");

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Government balance" value={`${gov?.balance.toLocaleString() ?? 0} ${CURRENCY_NAME}`} />
        <Stat label="Total Aeros supply" value={`${gov?.totalSupply.toLocaleString() ?? 0} ${CURRENCY_NAME}`} />
        <Stat label="Users" value={`${userCounts.total}`} sub={`${userCounts.active} active`} />
        <Stat label="Transactions" value={`${txCount}`} />
        <Stat label="Current tax" value={gov ? formatTaxRateBp(gov.taxRateBp) : "—"} />
        <Stat label="Pending issuance" value={`${pendingIssuances.length}`} />
      </div>

      {pendingIssuances.length > 0 && (
        <section className="card p-5">
          <h2 className="font-medium">Pending issuance requests</h2>
          <ul className="mt-3 space-y-2">
            {pendingIssuances.map((r) => (
              <li key={r.id} className="flex items-center justify-between text-sm">
                <span>
                  {r.amount.toLocaleString()} {CURRENCY_NAME} — {r.reason}
                </span>
                <Link href={`/gov/issuance/${r.id}`} className="font-medium underline">
                  Review
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">Recent activity</h2>
          <Link href="/gov/transactions" className="text-sm font-medium text-muted hover:text-foreground">
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

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  );
}
