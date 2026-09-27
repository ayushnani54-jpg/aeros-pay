import { db } from "@/db/client";
import { transactions } from "@/db/schema";
import { desc, sql } from "drizzle-orm";
import { getGovernmentSingleton } from "@/lib/queries";
import { CURRENCY_NAME, INITIAL_GOVERNMENT_TREASURY } from "@/lib/constants";
import { TransactionRow } from "@/components/transaction-row";

export default async function GovTreasuryPage() {
  const gov = await getGovernmentSingleton();

  const [taxCollectedRow] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.taxAmount}), 0)::int` })
    .from(transactions);

  const [issuedRow] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.grossAmount}), 0)::int` })
    .from(transactions)
    .where(sql`${transactions.type} = 'ISSUANCE_CREDIT'`);

  const [transferredRow] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.grossAmount}), 0)::int` })
    .from(transactions)
    .where(sql`${transactions.type} = 'TRANSFER'`);

  const recentTreasuryActivity = await db
    .select()
    .from(transactions)
    .where(
      sql`${transactions.senderUsername} = ${gov?.username ?? ""} OR ${transactions.receiverUsername} = ${gov?.username ?? ""}`,
    )
    .orderBy(desc(transactions.createdAt))
    .limit(20);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Aeros Treasury</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Government balance" value={`${gov?.balance.toLocaleString() ?? 0} ${CURRENCY_NAME}`} />
        <Stat label="Total Aeros supply" value={`${gov?.totalSupply.toLocaleString() ?? 0} ${CURRENCY_NAME}`} />
        <Stat label="Initial treasury (launch)" value={`${INITIAL_GOVERNMENT_TREASURY.toLocaleString()} ${CURRENCY_NAME}`} />
        <Stat label="Aeros issued via community vote" value={`${issuedRow?.total.toLocaleString() ?? 0} ${CURRENCY_NAME}`} />
        <Stat label="Aeros transferred (user↔user)" value={`${transferredRow?.total.toLocaleString() ?? 0} ${CURRENCY_NAME}`} />
        <Stat label="Total tax collected" value={`${taxCollectedRow?.total.toLocaleString() ?? 0} ${CURRENCY_NAME}`} />
      </div>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Recent treasury activity</h2>
        {recentTreasuryActivity.length === 0 ? (
          <p className="text-sm text-muted">No treasury activity yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {recentTreasuryActivity.map((tx) => (
              <TransactionRow key={tx.id} tx={tx} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}
