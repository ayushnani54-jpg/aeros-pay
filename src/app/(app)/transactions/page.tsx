import { getActingContext } from "@/lib/auth";
import { getTransactionsForWallet } from "@/lib/queries";
import { TransactionRow } from "@/components/transaction-row";
import { ExportLink } from "@/components/forms/export-forms";

export default async function TransactionsPage() {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const { user, company } = ctx;
  const transactions = await getTransactionsForWallet(
    company ? company.id : user.id,
    company ? "COMPANY" : "USER",
    200,
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
          <p className="mt-1 text-sm text-muted">
            Every payment for {company ? company.name : "your personal wallet"} ({ctx.handle}).
            Records here are permanent and can never be edited.
          </p>
        </div>
        {/* Scope comes from the session, never from this link: the same URL
            downloads the company's history when a company wallet is active and
            the person's own when it is not. */}
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

      {transactions.length === 0 ? (
        <div className="card p-6">
          <p className="text-sm text-muted">No transactions yet.</p>
        </div>
      ) : (
        <div className="card divide-y divide-border px-5">
          {transactions.map((tx) => (
            <TransactionRow
              key={tx.id}
              tx={tx}
              viewerId={company ? company.id : user.id}
              viewerUsername={company ? company.username : user.username}
            />
          ))}
        </div>
      )}
    </div>
  );
}
