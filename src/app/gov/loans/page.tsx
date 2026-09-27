import Link from "next/link";
import { getAllLoans, getLoanCounts, getLoanPolicy, runLoanMaintenance } from "@/lib/loans";
import { LoanPolicyForm } from "@/components/forms/gov-forms";
import { LoanStatusBadge } from "@/components/status-badge";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDate } from "@/lib/datetime";

const TABS = [
  "ALL",
  "PENDING",
  "APPROVED",
  "ACTIVE",
  "RESTRUCTURED",
  "DEFAULTED",
  "PAID",
  "REJECTED",
  "CANCELLED",
];

export default async function GovLoansPage({ searchParams }: PageProps<"/gov/loans">) {
  await runLoanMaintenance().catch(() => undefined);

  const params = await searchParams;
  const filter = typeof params.status === "string" ? params.status : "ALL";

  const [rows, counts, policy] = await Promise.all([
    getAllLoans(300),
    getLoanCounts(),
    getLoanPolicy(),
  ]);

  const filtered = filter === "ALL" ? rows : rows.filter((r) => r.loan.status === filter);
  const renderedAt = new Date();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Company loans</h1>
        <p className="mt-1 text-sm text-muted">
          Loans are funded from the treasury and repaid into it. They never create new Aeros.
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Pending" value={counts.pending} plain />
        <Stat label="Active" value={counts.active} plain />
        <Stat label="Overdue instalments" value={counts.overdueInstalments} plain />
        <Stat label="Outstanding" value={counts.outstandingTotal} />
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Lending policy</h2>
        <LoanPolicyForm policy={policy} />
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {TABS.map((tab) => (
            <Link
              key={tab}
              href={`/gov/loans?status=${tab}`}
              className={filter === tab ? "btn btn-primary text-xs" : "btn btn-secondary text-xs"}
            >
              {tab}
            </Link>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="card p-6">
            <p className="text-sm text-muted">No loans here.</p>
          </div>
        ) : (
          <div className="card divide-y divide-border">
            {filtered.map(({ loan, companyName, companyUsername, ownerUsername }) => {
              const paid = loan.principalPaid + loan.interestPaid;
              const remaining = Math.max(0, (loan.totalPayable ?? 0) - paid);
              const overdue =
                loan.nextDueAt !== null &&
                new Date(loan.nextDueAt).getTime() < renderedAt.getTime();

              return (
                <Link
                  key={loan.id}
                  href={`/gov/loans/${loan.id}`}
                  className="flex flex-wrap items-start justify-between gap-3 p-4 hover:bg-surface"
                >
                  <div className="min-w-0">
                    <p className="font-medium">
                      {loan.loanNumber} · {companyName}
                    </p>
                    <p className="text-sm text-muted">
                      @{companyUsername} · owner @{ownerUsername}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {(loan.principal ?? loan.requestedAmount).toLocaleString()} {CURRENCY_NAME}
                      {loan.totalPayable
                        ? ` · ${paid.toLocaleString()} of ${loan.totalPayable.toLocaleString()} repaid`
                        : " requested"}
                    </p>
                    {loan.nextDueAt && remaining > 0 && (
                      <p className={`mt-1 text-xs ${overdue ? "text-danger" : "text-muted"}`}>
                        {overdue ? "Overdue since " : "Next due "}
                        {formatDate(loan.nextDueAt)}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <LoanStatusBadge status={loan.status} />
                    {remaining > 0 && (
                      <p className="font-mono text-sm">
                        {remaining.toLocaleString()} {CURRENCY_NAME} left
                      </p>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, plain = false }: { label: string; value: number; plain?: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold">
        {value.toLocaleString()}
        {!plain && <span className="ml-1 text-xs font-medium text-muted">{CURRENCY_NAME}</span>}
      </p>
    </div>
  );
}
