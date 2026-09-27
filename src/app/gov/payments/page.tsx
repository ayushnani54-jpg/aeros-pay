import { getEconomicOverview, searchTransactions } from "@/lib/queries";
import { GovernmentPaymentForm } from "@/components/forms/gov-forms";
import { TransactionRow } from "@/components/transaction-row";
import { CURRENCY_NAME } from "@/lib/constants";

/**
 * Government payments in and out of the treasury (spec §5).
 */
export default async function GovPaymentsPage() {
  const [overview, outgoing, incoming] = await Promise.all([
    getEconomicOverview(),
    searchTransactions({ limit: 50 }).then((rows) =>
      rows.filter((t) => t.senderType === "GOVERNMENT" && t.type !== "ISSUANCE_CREDIT"),
    ),
    searchTransactions({ limit: 50 }).then((rows) =>
      rows.filter((t) => t.receiverType === "GOVERNMENT" && t.type !== "ISSUANCE_CREDIT"),
    ),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Government payments</h1>
        <p className="mt-1 text-sm text-muted">
          Money leaving and entering the treasury. Government transfers move existing Aeros —
          only an approved issuance creates new supply.
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Treasury" value={overview?.treasury ?? 0} />
        <Stat label="Total spending" value={overview?.governmentSpending ?? 0} />
        <Stat label="Tax collected" value={overview?.taxCollected ?? 0} />
        <Stat label="Total issued" value={overview?.totalIssued ?? 0} />
      </section>

      <GovernmentPaymentForm />

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Recent payments out</h2>
        {outgoing.length === 0 ? (
          <p className="text-sm text-muted">No outgoing payments yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {outgoing.slice(0, 25).map((tx) => (
              <TransactionRow key={tx.id} tx={tx} />
            ))}
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Recent payments in</h2>
        {incoming.length === 0 ? (
          <p className="text-sm text-muted">No incoming payments yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {incoming.slice(0, 25).map((tx) => (
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
      <p className="mt-1 text-xl font-semibold">
        {value.toLocaleString()}
        <span className="ml-1 text-xs font-medium text-muted">{CURRENCY_NAME}</span>
      </p>
    </div>
  );
}
