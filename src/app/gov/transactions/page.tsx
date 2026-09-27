import { searchTransactions } from "@/lib/queries";
import { TransactionRow } from "@/components/transaction-row";
import { CURRENCY_NAME } from "@/lib/constants";

const TX_TYPES = [
  "",
  "TRANSFER",
  "GOVERNMENT_FUNDING",
  "GOVERNMENT_PAYMENT",
  "GOVERNMENT_RECEIPT",
  "COMPANY_FUNDING",
  "COMPANY_SALE",
  "COMPANY_PAYMENT",
  "INVOICE_PAYMENT",
  "COMPANY_SALE_PURCHASE",
  "LOAN_DISBURSEMENT",
  "LOAN_REPAYMENT",
  "ADMIN_ADJUSTMENT_CREDIT",
  "ADMIN_ADJUSTMENT_DEBIT",
  "COMPANY_ADJUSTMENT_CREDIT",
  "COMPANY_ADJUSTMENT_DEBIT",
  "ISSUANCE_CREDIT",
];

export default async function GovTransactionsPage({
  searchParams,
}: PageProps<"/gov/transactions">) {
  const sp = await searchParams;
  const party = typeof sp.party === "string" ? sp.party : "";
  const txRef = typeof sp.txRef === "string" ? sp.txRef : "";
  const type = typeof sp.type === "string" ? sp.type : "";
  const minAmountRaw = typeof sp.minAmount === "string" ? sp.minAmount : "";
  const minAmount = minAmountRaw === "" ? undefined : Number(minAmountRaw);

  const rows = await searchTransactions({
    party,
    txRef,
    type: type || undefined,
    minAmount,
    limit: 300,
  });

  const totalGross = rows.reduce((sum, t) => sum + t.grossAmount, 0);
  const totalTax = rows.reduce((sum, t) => sum + t.taxAmount, 0);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Transactions</h1>
        <p className="mt-1 text-sm text-muted">
          The complete ledger. Records are permanent and can never be edited or deleted.
        </p>
      </div>

      <form className="card grid gap-3 p-4 sm:grid-cols-5" method="get">
        <input
          className="input"
          name="party"
          placeholder="User or company"
          defaultValue={party}
        />
        <input className="input" name="txRef" placeholder="TX reference" defaultValue={txRef} />
        <select className="input" name="type" defaultValue={type}>
          {TX_TYPES.map((t) => (
            <option key={t} value={t}>
              {t === "" ? "Any type" : t.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <input
          className="input"
          name="minAmount"
          type="number"
          min={0}
          placeholder="Min amount"
          defaultValue={minAmountRaw}
        />
        <button type="submit" className="btn btn-primary">
          Filter
        </button>
      </form>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Matching" value={rows.length} plain />
        <Stat label="Gross volume" value={totalGross} />
        <Stat label="Tax in these" value={totalTax} />
      </div>

      {rows.length === 0 ? (
        <div className="card p-6">
          <p className="text-sm text-muted">No transactions matched those filters.</p>
        </div>
      ) : (
        <div className="card divide-y divide-border px-5">
          {rows.map((tx) => (
            <TransactionRow key={tx.id} tx={tx} />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, plain = false }: { label: string; value: number; plain?: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold">
        {value.toLocaleString()}
        {!plain && <span className="ml-1 text-xs font-medium text-muted">{CURRENCY_NAME}</span>}
      </p>
    </div>
  );
}
