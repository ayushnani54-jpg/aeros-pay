import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import {
  checkLoanEligibility,
  getLoanPolicy,
  getLoansForCompany,
  getLoanSummary,
  reminderStageFor,
  runLoanMaintenance,
} from "@/lib/loans";
import {
  AcceptLoanButton,
  ApplyForLoanForm,
  CancelLoanButton,
  PayInstalmentButton,
} from "@/components/forms/company-forms";
import { InstalmentStatusBadge, LoanStatusBadge } from "@/components/status-badge";
import { CURRENCY_NAME } from "@/lib/constants";
import type { LoanInstalment } from "@/db/schema";
import { formatDate, formatDateTime } from "@/lib/datetime";

const STAGE_TEXT: Record<string, string> = {
  UPCOMING_3D: "Due in 3 days",
  DUE_TOMORROW: "Due tomorrow",
  DUE_TODAY: "Due today",
  OVERDUE_1D: "Overdue",
  OVERDUE_3D: "Overdue 3+ days",
  FINAL_NOTICE: "Final notice — default possible",
};

export default async function CompanyLoansPage() {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const company = ctx.company ?? ctx.availableCompanies[0] ?? null;
  if (!company) {
    return (
      <div className="card p-6">
        <p className="text-sm text-muted">
          You need an approved company to borrow.{" "}
          <Link href="/my-company" className="underline">
            Apply for one
          </Link>
          .
        </p>
      </div>
    );
  }

  await runLoanMaintenance().catch(() => undefined);

  const [policy, loans] = await Promise.all([
    getLoanPolicy(),
    getLoansForCompany(company.id),
  ]);

  const eligibility = await checkLoanEligibility(company, policy);

  const summaries = await Promise.all(
    loans.map(async (loan) => ({ loan, summary: await getLoanSummary(loan.id) })),
  );

  const openLoan = summaries.find(({ loan }) =>
    ["PENDING", "APPROVED", "ACTIVE", "DEFAULTED", "RESTRUCTURED"].includes(loan.status),
  );
  const closedLoans = summaries.filter(({ loan }) =>
    ["PAID", "REJECTED", "CANCELLED"].includes(loan.status),
  );

  return (
    <div className="space-y-6">
      <div>
        <Link href="/my-company" className="text-sm text-muted hover:text-foreground">
          ← {company.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Government loans</h1>
        <p className="mt-1 text-sm text-muted">
          Borrow from the Government treasury and repay in instalments from your company wallet.
        </p>
      </div>

      {openLoan ? (
        <LoanCard
          loan={openLoan.loan}
          summary={openLoan.summary}
          companyBalance={company.balance}
          graceDays={policy.defaultGraceDays}
        />
      ) : (
        <ApplyForLoanForm
          companyId={company.id}
          minAmount={policy.minAmount}
          maxAmount={policy.maxAmount}
          interestPercent={policy.interestRateBp / 100}
          instalmentCount={policy.instalmentCount}
          intervalDays={policy.instalmentIntervalDays}
          eligible={eligibility.eligible}
          reasons={eligibility.reasons}
        />
      )}

      {closedLoans.length > 0 && (
        <section className="card p-5">
          <h2 className="mb-3 font-medium">Past loans</h2>
          <div className="divide-y divide-border">
            {closedLoans.map(({ loan }) => (
              <div key={loan.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div>
                  <p className="font-medium">{loan.loanNumber}</p>
                  <p className="text-xs text-muted">
                    {(loan.principal ?? loan.requestedAmount).toLocaleString()} {CURRENCY_NAME} ·{" "}
                    {formatDate(loan.createdAt)}
                  </p>
                  {loan.rejectionReason && (
                    <p className="mt-1 text-xs text-muted">Reason: {loan.rejectionReason}</p>
                  )}
                </div>
                <LoanStatusBadge status={loan.status} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function LoanCard({
  loan,
  summary,
  companyBalance,
  graceDays,
}: {
  loan: Awaited<ReturnType<typeof getLoansForCompany>>[number];
  summary: Awaited<ReturnType<typeof getLoanSummary>>;
  companyBalance: number;
  graceDays: number;
}) {
  const totalPayable = loan.totalPayable ?? 0;
  const paid = loan.principalPaid + loan.interestPaid;
  const remaining = Math.max(0, totalPayable - paid);
  const progressPercent = totalPayable > 0 ? Math.round((paid / totalPayable) * 100) : 0;

  return (
    <div className="space-y-4">
      <section className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Loan {loan.loanNumber}</h2>
            <p className="mt-1 text-sm text-muted">{loan.purpose}</p>
          </div>
          <LoanStatusBadge status={loan.status} />
        </div>

        {loan.status === "PENDING" && (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-muted">
              Awaiting Government review. You requested{" "}
              {loan.requestedAmount.toLocaleString()} {CURRENCY_NAME}.
            </p>
            <CancelLoanButton loanId={loan.id} />
          </div>
        )}

        {loan.status === "APPROVED" && (
          <div className="mt-4 space-y-3 rounded-md border border-[#111111] p-4">
            <p className="text-sm font-medium">Approved — accept to receive the funds</p>
            <dl className="space-y-1 text-sm">
              <Row
                label="Principal"
                value={`${(loan.principal ?? 0).toLocaleString()} ${CURRENCY_NAME}`}
              />
              <Row
                label="Interest rate"
                value={`${((loan.interestRateBp ?? 0) / 100).toFixed(2)}%`}
              />
              <Row
                label="Total interest"
                value={`${(loan.totalInterest ?? 0).toLocaleString()} ${CURRENCY_NAME}`}
              />
              <Row
                label="Total payable"
                value={`${totalPayable.toLocaleString()} ${CURRENCY_NAME}`}
              />
              <Row
                label="Instalments"
                value={`${loan.instalmentCount} every ${loan.instalmentIntervalDays} days`}
              />
            </dl>
            <p className="text-xs text-muted">
              The repayment clock starts when you accept. These terms are fixed for the life of
              this loan.
            </p>
            <div className="flex flex-wrap gap-2">
              <AcceptLoanButton loanId={loan.id} amount={loan.principal ?? 0} />
              <CancelLoanButton loanId={loan.id} />
            </div>
          </div>
        )}

        {["ACTIVE", "DEFAULTED", "RESTRUCTURED"].includes(loan.status) && (
          <>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Principal" value={loan.principal ?? 0} />
              <Stat label="Interest" value={loan.totalInterest ?? 0} />
              <Stat label="Repaid" value={paid} />
              <Stat label="Remaining" value={remaining} />
            </div>

            <div className="mt-4">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface">
                <div className="h-full bg-black" style={{ width: `${progressPercent}%` }} />
              </div>
              <p className="mt-1 text-xs text-muted">{progressPercent}% repaid</p>
            </div>

            {loan.nextDueAt && (
              <p className="mt-3 text-sm">
                <span className="text-muted">Next payment due: </span>
                {formatDate(loan.nextDueAt)}
              </p>
            )}

            {loan.status === "DEFAULTED" && (
              <p className="mt-3 text-sm text-danger">
                This loan is in default. {loan.defaultReason}
              </p>
            )}
            {loan.status === "RESTRUCTURED" && (
              <p className="mt-3 text-sm text-muted">
                Restructured by the Government. {loan.restructureNote}
              </p>
            )}
          </>
        )}
      </section>

      {summary && summary.instalments.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted">Payment schedule</h2>
          {summary.instalments.map((instalment) => (
            <InstalmentNotice
              key={instalment.id}
              instalment={instalment}
              loanNumber={loan.loanNumber}
              instalmentCount={loan.instalmentCount ?? summary.instalments.length}
              companyBalance={companyBalance}
              graceDays={graceDays}
            />
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * Payment notice for one instalment (spec: "Generate a proper payment
 * invoice/payment notice for each instalment").
 */
function InstalmentNotice({
  instalment,
  loanNumber,
  instalmentCount,
  companyBalance,
  graceDays,
}: {
  instalment: LoanInstalment;
  loanNumber: string;
  instalmentCount: number;
  companyBalance: number;
  graceDays: number;
}) {
  const unpaid = instalment.status !== "PAID" && instalment.status !== "WAIVED";
  const stage = unpaid ? reminderStageFor(instalment.dueAt, graceDays) : null;
  const urgent = stage === "OVERDUE_1D" || stage === "OVERDUE_3D" || stage === "FINAL_NOTICE";

  return (
    <div className={`card p-5 ${urgent ? "border-[#e3b3ae]" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">
            Instalment {instalment.sequence} of {instalmentCount}
          </p>
          <p className="text-xs text-muted">
            {loanNumber} · due {formatDate(instalment.dueAt)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <InstalmentStatusBadge status={instalment.status} />
          {stage && (
            <span className={`text-xs ${urgent ? "text-danger" : "text-muted"}`}>
              {STAGE_TEXT[stage]}
            </span>
          )}
        </div>
      </div>

      <dl className="mt-3 space-y-1 text-sm">
        <Row
          label="Principal"
          value={`${instalment.principalPortion.toLocaleString()} ${CURRENCY_NAME}`}
        />
        <Row
          label="Interest"
          value={`${instalment.interestPortion.toLocaleString()} ${CURRENCY_NAME}`}
        />
        <div className="flex justify-between border-t border-border pt-1 font-medium">
          <dt>Total due</dt>
          <dd>
            {instalment.totalDue.toLocaleString()} {CURRENCY_NAME}
          </dd>
        </div>
      </dl>

      {instalment.status === "PAID" ? (
        <p className="mt-3 text-xs text-muted">
          Paid {instalment.paidAt ? formatDateTime(instalment.paidAt) : ""} · Ref{" "}
          {instalment.paidTxRef}
        </p>
      ) : (
        <div className="mt-4">
          <PayInstalmentButton
            instalmentId={instalment.id}
            amount={instalment.totalDue}
            canAfford={companyBalance >= instalment.totalDue}
          />
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-surface p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 font-semibold">{value.toLocaleString()}</p>
    </div>
  );
}
