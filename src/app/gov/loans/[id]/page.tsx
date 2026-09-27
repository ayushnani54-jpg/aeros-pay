import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getLoanActionsForLoan,
  getLoanPaymentsForLoan,
  getLoanPolicy,
  getLoanSummary,
} from "@/lib/loans";
import { getCompanyAdminProfile } from "@/lib/queries";
import { LoanActionForm, LoanReviewActions } from "@/components/forms/gov-forms";
import { InstalmentStatusBadge, LoanStatusBadge } from "@/components/status-badge";
import { CURRENCY_NAME } from "@/lib/constants";

export default async function GovLoanDetail({ params }: PageProps<"/gov/loans/[id]">) {
  const { id } = await params;
  const summary = await getLoanSummary(id);
  if (!summary) notFound();

  const { loan, instalments } = summary;

  const [company, payments, actions, policy] = await Promise.all([
    getCompanyAdminProfile(loan.companyId),
    getLoanPaymentsForLoan(loan.id),
    getLoanActionsForLoan(loan.id),
    getLoanPolicy(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/gov/loans" className="text-sm text-muted hover:text-foreground">
          ← Loans
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{loan.loanNumber}</h1>
            {company && (
              <p className="mt-1 text-sm text-muted">
                <Link href={`/gov/companies/${company.company.id}`} className="underline">
                  {company.company.name}
                </Link>{" "}
                (@{company.company.username}) · owner @{company.ownerUsername}
              </p>
            )}
          </div>
          <LoanStatusBadge status={loan.status} />
        </div>
      </div>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Application</h2>
        <dl className="space-y-1 text-sm">
          <Row
            label="Requested"
            value={`${loan.requestedAmount.toLocaleString()} ${CURRENCY_NAME}`}
          />
          {loan.principal !== null && (
            <>
              <Row
                label="Approved principal"
                value={`${loan.principal.toLocaleString()} ${CURRENCY_NAME}`}
              />
              <Row
                label="Interest rate (fixed for this loan)"
                value={`${((loan.interestRateBp ?? 0) / 100).toFixed(2)}%`}
              />
              <Row
                label="Total interest"
                value={`${(loan.totalInterest ?? 0).toLocaleString()} ${CURRENCY_NAME}`}
              />
              <Row
                label="Total payable"
                value={`${(loan.totalPayable ?? 0).toLocaleString()} ${CURRENCY_NAME}`}
              />
              <Row
                label="Schedule"
                value={`${loan.instalmentCount} instalments, ${loan.instalmentIntervalDays} days apart`}
              />
            </>
          )}
          <Row label="Applied" value={new Date(loan.createdAt).toLocaleString()} />
          {loan.reviewedAt && (
            <Row
              label="Reviewed"
              value={`${new Date(loan.reviewedAt).toLocaleString()} by ${loan.reviewedBy}`}
            />
          )}
          {loan.disbursedAt && (
            <Row
              label="Disbursed"
              value={`${new Date(loan.disbursedAt).toLocaleString()} · Ref ${loan.disbursementTxRef}`}
            />
          )}
          {loan.rejectionReason && <Row label="Rejection reason" value={loan.rejectionReason} />}
          {loan.defaultReason && <Row label="Default reason" value={loan.defaultReason} />}
          {loan.restructureNote && <Row label="Restructure note" value={loan.restructureNote} />}
        </dl>

        <div className="mt-4">
          <p className="text-sm font-medium">Purpose</p>
          <p className="mt-1 whitespace-pre-line text-sm text-muted">{loan.purpose}</p>
        </div>

        {company && (
          <div className="mt-4 rounded-md bg-surface p-3 text-sm">
            <p className="text-muted">Borrower context</p>
            <p className="mt-1">
              Company wallet: {company.company.balance.toLocaleString()} {CURRENCY_NAME} ·
              lifetime sales: {company.salesTotal.toLocaleString()} {CURRENCY_NAME}
            </p>
          </div>
        )}
      </section>

      {loan.status === "PENDING" && (
        <section className="card border-[#111111] p-5">
          <h2 className="mb-3 font-medium">Review application</h2>
          <LoanReviewActions
            loanId={loan.id}
            requestedAmount={loan.requestedAmount}
            defaultRatePercent={policy.interestRateBp / 100}
            defaultCount={policy.instalmentCount}
            defaultInterval={policy.instalmentIntervalDays}
          />
        </section>
      )}

      {instalments.length > 0 && (
        <section className="card p-5">
          <h2 className="mb-3 font-medium">Instalments</h2>
          <div className="divide-y divide-border">
            {instalments.map((instalment) => (
              <div
                key={instalment.id}
                className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm"
              >
                <div>
                  <p className="font-medium">Instalment {instalment.sequence}</p>
                  <p className="text-xs text-muted">
                    {instalment.principalPortion.toLocaleString()} principal +{" "}
                    {instalment.interestPortion.toLocaleString()} interest · due{" "}
                    {new Date(instalment.dueAt).toLocaleDateString()}
                  </p>
                  {instalment.paidTxRef && (
                    <p className="mt-1 font-mono text-xs text-muted">
                      Ref {instalment.paidTxRef}
                    </p>
                  )}
                  {instalment.remindersSent > 0 && (
                    <p className="mt-1 text-xs text-muted">
                      {instalment.remindersSent} reminder(s) sent
                      {instalment.lastReminderStage
                        ? ` · last: ${instalment.lastReminderStage.replace(/_/g, " ")}`
                        : ""}
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <p className="font-mono font-medium">
                    {instalment.totalDue.toLocaleString()} {CURRENCY_NAME}
                  </p>
                  <InstalmentStatusBadge status={instalment.status} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {payments.length > 0 && (
        <section className="card p-5">
          <h2 className="mb-3 font-medium">Repayment records</h2>
          <div className="divide-y divide-border">
            {payments.map((payment) => (
              <div key={payment.id} className="py-3 text-sm">
                <div className="flex justify-between">
                  <p className="font-medium">
                    {payment.amount.toLocaleString()} {CURRENCY_NAME}
                  </p>
                  <p className="font-mono text-xs text-muted">{payment.txRef}</p>
                </div>
                <p className="text-xs text-muted">
                  {payment.principalPaid.toLocaleString()} principal +{" "}
                  {payment.interestPaid.toLocaleString()} interest · remaining{" "}
                  {payment.remainingBalance.toLocaleString()} ·{" "}
                  {new Date(payment.createdAt).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {["ACTIVE", "DEFAULTED", "RESTRUCTURED"].includes(loan.status) && (
        <section className="card p-5">
          <h2 className="mb-3 font-medium">Government action</h2>
          <LoanActionForm loanId={loan.id} />
        </section>
      )}

      {actions.length > 0 && (
        <section className="card p-5">
          <h2 className="mb-3 font-medium">Action history</h2>
          <div className="divide-y divide-border">
            {actions.map((action) => (
              <div key={action.id} className="py-3 text-sm">
                <p className="font-medium">{action.action}</p>
                <p className="text-xs text-muted">
                  {action.actorLabel} · {new Date(action.createdAt).toLocaleString()}
                </p>
                <p className="mt-1 text-sm text-muted">{action.reason}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
