import { getCurrentUser } from "@/lib/auth";
import { getRecentTransactionsForUser } from "@/lib/queries";
import { TransactionRow } from "@/components/transaction-row";

export default async function TransactionsPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const txs = await getRecentTransactionsForUser(user.id, 200);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Transactions</h1>
      <div className="card p-5">
        {txs.length === 0 ? (
          <p className="text-sm text-muted">No transactions yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {txs.map((tx) => (
              <TransactionRow key={tx.id} tx={tx} viewerUsername={user.username} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
