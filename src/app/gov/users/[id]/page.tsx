import { notFound } from "next/navigation";
import { getUserById } from "@/lib/queries";
import { db } from "@/db/client";
import { transactions } from "@/db/schema";
import { or, eq, desc } from "drizzle-orm";
import { StatusBadge } from "@/components/status-badge";
import { TransactionRow } from "@/components/transaction-row";
import { UserStatusActions } from "@/components/forms/user-status-actions";
import { AdjustBalanceForm } from "@/components/forms/adjust-balance-form";
import { FundUserForm } from "@/components/forms/fund-user-form";
import { CURRENCY_NAME } from "@/lib/constants";

export default async function GovUserDetailPage({ params }: PageProps<"/gov/users/[id]">) {
  const { id } = await params;
  const user = await getUserById(id);
  if (!user) notFound();

  const txs = await db
    .select()
    .from(transactions)
    .where(or(eq(transactions.senderId, user.id), eq(transactions.receiverId, user.id)))
    .orderBy(desc(transactions.createdAt))
    .limit(100);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">@{user.username}</h1>
        <p className="text-sm text-muted">{user.displayName}</p>
      </div>

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="card p-4">
          <p className="text-xs text-muted">Balance</p>
          <p className="mt-1 text-lg font-semibold">
            {user.balance.toLocaleString()} {CURRENCY_NAME}
          </p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">Status</p>
          <div className="mt-1">
            <StatusBadge status={user.status} />
          </div>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">Registered</p>
          <p className="mt-1 text-lg font-semibold">
            {new Date(user.createdAt).toLocaleDateString()}
          </p>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Account actions</h2>
        <UserStatusActions userId={user.id} status={user.status} />
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="card p-5">
          <h2 className="mb-3 font-medium">Fund from treasury</h2>
          <FundUserForm userId={user.id} />
        </section>
        <section className="card p-5">
          <h2 className="mb-3 font-medium">Balance adjustment</h2>
          <AdjustBalanceForm userId={user.id} />
        </section>
      </div>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Transaction history</h2>
        {txs.length === 0 ? (
          <p className="text-sm text-muted">No transactions yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {txs.map((tx) => (
              <TransactionRow key={tx.id} tx={tx} viewerUsername={user.username} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
