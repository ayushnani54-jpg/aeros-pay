import { db } from "@/db/client";
import { transactions } from "@/db/schema";
import { and, desc, ilike } from "drizzle-orm";
import { TransactionRow } from "@/components/transaction-row";

export default async function GovTransactionsPage({
  searchParams,
}: PageProps<"/gov/transactions">) {
  const sp = await searchParams;
  const sender = typeof sp.sender === "string" ? sp.sender.trim().toLowerCase() : "";
  const receiver = typeof sp.receiver === "string" ? sp.receiver.trim().toLowerCase() : "";
  const txRef = typeof sp.txRef === "string" ? sp.txRef.trim() : "";

  const conditions = [];
  if (sender) conditions.push(ilike(transactions.senderUsername, `%${sender}%`));
  if (receiver) conditions.push(ilike(transactions.receiverUsername, `%${receiver}%`));
  if (txRef) conditions.push(ilike(transactions.txRef, `%${txRef}%`));

  const rows = await db
    .select()
    .from(transactions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(transactions.createdAt))
    .limit(300);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Transactions</h1>

      <form className="card grid gap-3 p-4 sm:grid-cols-4" method="get">
        <input
          className="input"
          name="sender"
          placeholder="Sender username"
          defaultValue={sender}
        />
        <input
          className="input"
          name="receiver"
          placeholder="Receiver username"
          defaultValue={receiver}
        />
        <input className="input" name="txRef" placeholder="Transaction ref" defaultValue={txRef} />
        <button className="btn btn-primary" type="submit">
          Filter
        </button>
      </form>

      <div className="card p-5">
        {rows.length === 0 ? (
          <p className="text-sm text-muted">No matching transactions.</p>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((tx) => (
              <TransactionRow key={tx.id} tx={tx} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
