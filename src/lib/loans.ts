import "server-only";
import { db } from "@/db/client";
import {
  companies,
  government,
  loanActions,
  loanInstalments,
  loanPayments,
  loans,
  users,
} from "@/db/schema";
import { and, asc, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import { notifyUser } from "./notify";
import { transferInTx } from "./payments";
import { companyWallet, governmentWallet } from "./wallets";
import { effectiveCompanyStatus } from "./status";
import { getCompanySalesFigure } from "./sales";
import { formatDate, istCalendarDaysBetween } from "./datetime";
import type { Company, Loan, LoanInstalment } from "@/db/schema";

/**
 * GOVERNMENT (AEROS BANK) COMPANY LOANS
 * =====================================
 *
 * Supply safety
 * -------------
 * A loan never creates Aeros. The principal is paid out of the Government
 * treasury and every repayment flows back into it, so total supply is
 * completely unchanged across the whole loan lifecycle. `executeIssuance`
 * remains the only function in the system that changes supply.
 *
 * Frozen terms
 * ------------
 * Interest rate, instalment count and interval are copied onto the loan when
 * the Government approves it. A later change to the global loan policy has no
 * effect on loans that already exist.
 *
 * Interest model
 * --------------
 * Flat interest on the principal, split evenly across instalments, with any
 * rounding remainder added to the final instalment so the parts always sum
 * exactly to the total.
 *
 *   10,000 Aeros at 10% over 2 instalments, 7 days apart:
 *     total interest        1,000
 *     instalment 1          5,000 principal + 500 interest = 5,500  (day 7)
 *     instalment 2          5,000 principal + 500 interest = 5,500  (day 14)
 *     total payable        11,000
 *
 * Reminders
 * ---------
 * There is no cron in this deployment, so reminders are generated lazily by
 * `runLoanMaintenance()`, which the loan pages and loan actions call. Each
 * instalment records the last reminder stage it reached, so escalating
 * notices are sent once each rather than repeatedly.
 */

export class LoanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoanError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type LoanPolicy = {
  loansEnabled: boolean;
  interestRateBp: number;
  minAmount: number;
  maxAmount: number;
  instalmentCount: number;
  instalmentIntervalDays: number;
  minCompanyAgeDays: number;
  minCompanySales: number;
  defaultGraceDays: number;
};

export async function getLoanPolicy(
  executor: Pick<typeof db, "select"> = db,
): Promise<LoanPolicy> {
  const [gov] = await executor
    .select({
      loansEnabled: government.loansEnabled,
      interestRateBp: government.loanInterestRateBp,
      minAmount: government.loanMinAmount,
      maxAmount: government.loanMaxAmount,
      instalmentCount: government.loanInstalmentCount,
      instalmentIntervalDays: government.loanInstalmentIntervalDays,
      minCompanyAgeDays: government.loanMinCompanyAgeDays,
      minCompanySales: government.loanMinCompanySales,
      defaultGraceDays: government.loanDefaultGraceDays,
    })
    .from(government)
    .limit(1);
  if (!gov) throw new LoanError("Government account is not initialized.");
  return gov;
}

// ---------------------------------------------------------------------------
// Schedule maths
// ---------------------------------------------------------------------------

export type ScheduledInstalment = {
  sequence: number;
  principalPortion: number;
  interestPortion: number;
  totalDue: number;
  dueAt: Date;
};

export type LoanSchedule = {
  principal: number;
  interestRateBp: number;
  totalInterest: number;
  totalPayable: number;
  instalments: ScheduledInstalment[];
};

export function computeLoanSchedule(params: {
  principal: number;
  interestRateBp: number;
  instalmentCount: number;
  instalmentIntervalDays: number;
  startAt?: Date;
}): LoanSchedule {
  const { principal, interestRateBp, instalmentCount, instalmentIntervalDays } = params;

  if (!Number.isInteger(principal) || principal < 1) {
    throw new LoanError("Loan principal must be a positive whole number.");
  }
  if (!Number.isInteger(instalmentCount) || instalmentCount < 1) {
    throw new LoanError("Instalment count must be at least 1.");
  }

  const startAt = params.startAt ?? new Date();
  const totalInterest = Math.floor((principal * interestRateBp) / 10000);

  const basePrincipal = Math.floor(principal / instalmentCount);
  const baseInterest = Math.floor(totalInterest / instalmentCount);

  const instalments: ScheduledInstalment[] = [];
  let principalAssigned = 0;
  let interestAssigned = 0;

  for (let i = 1; i <= instalmentCount; i++) {
    const isLast = i === instalmentCount;

    // The final instalment absorbs any rounding remainder so the parts always
    // add up to exactly the principal and the total interest.
    const principalPortion = isLast ? principal - principalAssigned : basePrincipal;
    const interestPortion = isLast ? totalInterest - interestAssigned : baseInterest;

    principalAssigned += principalPortion;
    interestAssigned += interestPortion;

    const dueAt = new Date(
      startAt.getTime() + i * instalmentIntervalDays * 24 * 60 * 60 * 1000,
    );

    instalments.push({
      sequence: i,
      principalPortion,
      interestPortion,
      totalDue: principalPortion + interestPortion,
      dueAt,
    });
  }

  return {
    principal,
    interestRateBp,
    totalInterest,
    totalPayable: principal + totalInterest,
    instalments,
  };
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export type LoanEligibility = {
  eligible: boolean;
  reasons: string[];
  salesFigure: number;
  companyAgeDays: number;
};

export async function checkLoanEligibility(
  company: Company,
  policy?: LoanPolicy,
): Promise<LoanEligibility> {
  const p = policy ?? (await getLoanPolicy());
  const reasons: string[] = [];

  if (!p.loansEnabled) reasons.push("Government lending is currently closed.");
  if (effectiveCompanyStatus(company) !== "APPROVED") {
    reasons.push("Only an active, approved company can borrow.");
  }
  if (company.governmentOwned) {
    reasons.push("A company under Government stewardship cannot borrow.");
  }

  const approvedAt = company.reviewedAt ?? company.createdAt;
  // IST calendar days, consistent with every other day-boundary rule in the
  // app — see src/lib/datetime.ts.
  const companyAgeDays = istCalendarDaysBetween(approvedAt, new Date());
  if (companyAgeDays < p.minCompanyAgeDays) {
    reasons.push(
      `The company must have been approved for at least ${p.minCompanyAgeDays} days (currently ${companyAgeDays}).`,
    );
  }

  const salesFigure = await getCompanySalesFigure(company.id);
  if (salesFigure < p.minCompanySales) {
    reasons.push(
      `The company needs at least ${p.minCompanySales.toLocaleString()} Aeros in lifetime sales (currently ${salesFigure.toLocaleString()}).`,
    );
  }

  const [openLoan] = await db
    .select({ id: loans.id })
    .from(loans)
    .where(
      and(
        eq(loans.companyId, company.id),
        inArray(loans.status, ["PENDING", "APPROVED", "ACTIVE", "RESTRUCTURED", "DEFAULTED"]),
      ),
    )
    .limit(1);
  if (openLoan) {
    reasons.push("This company already has a loan application or an outstanding loan.");
  }

  return { eligible: reasons.length === 0, reasons, salesFigure, companyAgeDays };
}

// ---------------------------------------------------------------------------
// Application → review → acceptance → disbursement
// ---------------------------------------------------------------------------

async function nextLoanNumber(tx: Tx): Promise<string> {
  const [row] = await tx.select({ c: sql<number>`count(*)::int` }).from(loans);
  return `LN-${String((row?.c ?? 0) + 1).padStart(5, "0")}`;
}

export async function applyForLoan(params: {
  company: Company;
  appliedByUserId: string;
  amount: number;
  purpose: string;
}): Promise<Loan> {
  const { company, appliedByUserId, amount, purpose } = params;

  const policy = await getLoanPolicy();
  const eligibility = await checkLoanEligibility(company, policy);
  if (!eligibility.eligible) {
    throw new LoanError(eligibility.reasons[0]);
  }
  if (amount < policy.minAmount || amount > policy.maxAmount) {
    throw new LoanError(
      `Loan amount must be between ${policy.minAmount.toLocaleString()} and ${policy.maxAmount.toLocaleString()} Aeros.`,
    );
  }

  return db.transaction(async (tx) => {
    const loanNumber = await nextLoanNumber(tx);

    const [loan] = await tx
      .insert(loans)
      .values({
        loanNumber,
        companyId: company.id,
        appliedByUserId,
        requestedAmount: amount,
        purpose,
      })
      .returning();

    await recordAudit(tx, {
      action: "LOAN_APPLICATION_SUBMITTED",
      actorType: "COMPANY",
      actorId: company.id,
      actorLabel: company.username,
      targetType: "LOAN",
      targetId: loan.id,
      newValue: String(amount),
      reason: purpose,
      metadata: { loanNumber, amount },
    });

    await notifyUser(
      tx,
      appliedByUserId,
      "LOAN_APPLIED",
      `Loan application ${loanNumber} for ${amount.toLocaleString()} Aeros was submitted for Government review.`,
      "/my-company/loans",
    );

    return loan;
  });
}

/**
 * Government approval. Terms are frozen onto the loan and the full instalment
 * schedule is generated, but no Aeros moves yet — the company must accept
 * first.
 */
export async function approveLoan(params: {
  loanId: string;
  governmentId: string;
  governmentUsername: string;
  /** Government may approve a different amount than requested. */
  approvedAmount?: number;
  interestRateBp?: number;
  instalmentCount?: number;
  instalmentIntervalDays?: number;
}): Promise<{ loan: Loan; schedule: LoanSchedule }> {
  const { loanId, governmentId, governmentUsername } = params;
  const policy = await getLoanPolicy();

  return db.transaction(async (tx) => {
    const [loan] = await tx.select().from(loans).where(eq(loans.id, loanId)).for("update");
    if (!loan) throw new LoanError("Loan not found.");
    if (loan.status !== "PENDING") {
      throw new LoanError("Only a pending application can be approved.");
    }

    const principal = params.approvedAmount ?? loan.requestedAmount;
    const interestRateBp = params.interestRateBp ?? policy.interestRateBp;
    const instalmentCount = params.instalmentCount ?? policy.instalmentCount;
    const instalmentIntervalDays =
      params.instalmentIntervalDays ?? policy.instalmentIntervalDays;

    if (principal < policy.minAmount || principal > policy.maxAmount) {
      throw new LoanError(
        `Approved amount must be between ${policy.minAmount.toLocaleString()} and ${policy.maxAmount.toLocaleString()} Aeros.`,
      );
    }

    const [govRow] = await tx
      .select({ balance: government.balance })
      .from(government)
      .where(eq(government.id, governmentId))
      .limit(1);
    if (!govRow) throw new LoanError("Government account not found.");
    if (govRow.balance < principal) {
      throw new LoanError(
        `Government treasury has insufficient Aeros to fund this loan (${principal.toLocaleString()} required, ${govRow.balance.toLocaleString()} available).`,
      );
    }

    // The schedule is generated from the approval date; it is regenerated
    // from the disbursement date when the company accepts, so the company's
    // 7-day clock starts when they actually receive the money.
    const schedule = computeLoanSchedule({
      principal,
      interestRateBp,
      instalmentCount,
      instalmentIntervalDays,
    });

    const [updated] = await tx
      .update(loans)
      .set({
        status: "APPROVED",
        principal,
        interestRateBp,
        totalInterest: schedule.totalInterest,
        totalPayable: schedule.totalPayable,
        instalmentCount,
        instalmentIntervalDays,
        reviewedAt: new Date(),
        reviewedBy: governmentUsername,
        rejectionReason: null,
      })
      .where(eq(loans.id, loanId))
      .returning();

    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, loan.companyId))
      .limit(1);

    await recordAudit(tx, {
      action: "LOAN_APPROVED",
      actorType: "GOVERNMENT",
      actorId: governmentId,
      actorLabel: governmentUsername,
      targetType: "LOAN",
      targetId: loanId,
      previousValue: "PENDING",
      newValue: "APPROVED",
      metadata: {
        loanNumber: loan.loanNumber,
        principal,
        interestRateBp,
        instalmentCount,
        instalmentIntervalDays,
        totalPayable: schedule.totalPayable,
      },
    });

    if (company) {
      await notifyUser(
        tx,
        company.ownerUserId,
        "LOAN_APPROVED",
        `Loan ${loan.loanNumber} was approved: ${principal.toLocaleString()} Aeros at ${(interestRateBp / 100).toFixed(2)}% over ${instalmentCount} instalments. Accept it to receive the funds.`,
        "/my-company/loans",
      );
    }

    return { loan: updated, schedule };
  });
}

export async function rejectLoan(params: {
  loanId: string;
  governmentId: string;
  governmentUsername: string;
  reason: string;
}): Promise<Loan> {
  const { loanId, governmentId, governmentUsername, reason } = params;

  return db.transaction(async (tx) => {
    const [loan] = await tx.select().from(loans).where(eq(loans.id, loanId)).for("update");
    if (!loan) throw new LoanError("Loan not found.");
    if (loan.status !== "PENDING" && loan.status !== "APPROVED") {
      throw new LoanError("This application can no longer be rejected.");
    }

    const [updated] = await tx
      .update(loans)
      .set({
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewedBy: governmentUsername,
        rejectionReason: reason,
      })
      .where(eq(loans.id, loanId))
      .returning();

    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, loan.companyId))
      .limit(1);

    await recordAudit(tx, {
      action: "LOAN_REJECTED",
      actorType: "GOVERNMENT",
      actorId: governmentId,
      actorLabel: governmentUsername,
      targetType: "LOAN",
      targetId: loanId,
      previousValue: loan.status,
      newValue: "REJECTED",
      reason,
      metadata: { loanNumber: loan.loanNumber },
    });

    if (company) {
      await notifyUser(
        tx,
        company.ownerUserId,
        "LOAN_REJECTED",
        `Loan application ${loan.loanNumber} was not approved. Reason: ${reason}`,
        "/my-company/loans",
      );
    }

    return updated;
  });
}

/**
 * Company accepts an approved loan. This is the step that moves money:
 * treasury → company wallet, and the repayment clock starts now.
 */
export async function acceptLoan(params: {
  loanId: string;
  acceptingUserId: string;
}): Promise<{ loan: Loan; txRef: string; instalments: LoanInstalment[] }> {
  const { loanId, acceptingUserId } = params;

  return db.transaction(async (tx) => {
    const [loan] = await tx.select().from(loans).where(eq(loans.id, loanId)).for("update");
    if (!loan) throw new LoanError("Loan not found.");
    if (loan.status !== "APPROVED") {
      throw new LoanError("Only an approved loan can be accepted.");
    }
    if (
      loan.principal === null ||
      loan.interestRateBp === null ||
      loan.instalmentCount === null ||
      loan.instalmentIntervalDays === null
    ) {
      throw new LoanError("This loan is missing its approved terms.");
    }

    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, loan.companyId))
      .for("update");
    if (!company) throw new LoanError("Company not found.");
    if (company.ownerUserId !== acceptingUserId) {
      throw new LoanError("Only the company owner can accept this loan.");
    }
    if (effectiveCompanyStatus(company) !== "APPROVED") {
      throw new LoanError("This company is not currently active.");
    }

    const [gov] = await tx.select({ id: government.id }).from(government).limit(1);
    if (!gov) throw new LoanError("Government account is not initialized.");

    const disbursedAt = new Date();

    // Disbursement: treasury → company wallet. Tax-free — a loan is not a sale.
    const result = await transferInTx(tx, {
      from: governmentWallet(gov.id),
      to: companyWallet(company.id),
      amount: loan.principal,
      forcedTaxRateBp: 0,
      type: "LOAN_DISBURSEMENT",
      reason: `Loan ${loan.loanNumber} disbursement`,
      notify: {
        receiverType: "LOAN_DISBURSED",
        receiverMessage: (r) =>
          `Loan ${loan.loanNumber} disbursed: ${r.netAmount.toLocaleString()} Aeros credited to ${company.name}. Ref ${r.txRef}.`,
        href: "/my-company/loans",
      },
    });

    // The repayment schedule runs from the disbursement date.
    const schedule = computeLoanSchedule({
      principal: loan.principal,
      interestRateBp: loan.interestRateBp,
      instalmentCount: loan.instalmentCount,
      instalmentIntervalDays: loan.instalmentIntervalDays,
      startAt: disbursedAt,
    });

    const instalments = await tx
      .insert(loanInstalments)
      .values(
        schedule.instalments.map((i) => ({
          loanId: loan.id,
          sequence: i.sequence,
          principalPortion: i.principalPortion,
          interestPortion: i.interestPortion,
          totalDue: i.totalDue,
          dueAt: i.dueAt,
        })),
      )
      .returning();

    const [updated] = await tx
      .update(loans)
      .set({
        status: "ACTIVE",
        acceptedAt: disbursedAt,
        disbursedAt,
        disbursementTxRef: result.txRef,
        totalInterest: schedule.totalInterest,
        totalPayable: schedule.totalPayable,
        nextDueAt: schedule.instalments[0]?.dueAt ?? null,
      })
      .where(eq(loans.id, loanId))
      .returning();

    await recordAudit(tx, {
      action: "LOAN_ACCEPTED_AND_DISBURSED",
      actorType: "COMPANY",
      actorId: company.id,
      actorLabel: company.username,
      targetType: "LOAN",
      targetId: loanId,
      previousValue: "APPROVED",
      newValue: "ACTIVE",
      metadata: {
        loanNumber: loan.loanNumber,
        principal: loan.principal,
        totalPayable: schedule.totalPayable,
        txRef: result.txRef,
        firstDueAt: schedule.instalments[0]?.dueAt.toISOString(),
      },
    });

    return { loan: updated, txRef: result.txRef, instalments };
  });
}

export async function cancelLoanApplication(params: {
  loanId: string;
  actorUserId: string;
}): Promise<Loan> {
  return db.transaction(async (tx) => {
    const [loan] = await tx
      .select()
      .from(loans)
      .where(eq(loans.id, params.loanId))
      .for("update");
    if (!loan) throw new LoanError("Loan not found.");
    if (loan.status !== "PENDING" && loan.status !== "APPROVED") {
      throw new LoanError("Only an undisbursed loan can be cancelled.");
    }

    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, loan.companyId))
      .limit(1);
    if (!company || company.ownerUserId !== params.actorUserId) {
      throw new LoanError("Only the company owner can cancel this application.");
    }

    const [updated] = await tx
      .update(loans)
      .set({ status: "CANCELLED", cancelledAt: new Date() })
      .where(eq(loans.id, params.loanId))
      .returning();

    await recordAudit(tx, {
      action: "LOAN_CANCELLED",
      actorType: "COMPANY",
      actorId: company.id,
      actorLabel: company.username,
      targetType: "LOAN",
      targetId: loan.id,
      previousValue: loan.status,
      newValue: "CANCELLED",
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Repayment
// ---------------------------------------------------------------------------

/**
 * Pays one instalment in full from the company wallet to the treasury.
 *
 * Double-payment protection: the instalment row is locked FOR UPDATE and the
 * transition to PAID is a conditional UPDATE guarded on it still being unpaid,
 * so a double submit cannot pay the same instalment twice.
 */
export async function payInstalment(params: {
  instalmentId: string;
  payingUserId: string;
}): Promise<{ txRef: string; instalment: LoanInstalment; loan: Loan }> {
  const { instalmentId, payingUserId } = params;

  return db.transaction(async (tx) => {
    const [instalment] = await tx
      .select()
      .from(loanInstalments)
      .where(eq(loanInstalments.id, instalmentId))
      .for("update");
    if (!instalment) throw new LoanError("Instalment not found.");
    if (instalment.status === "PAID") {
      throw new LoanError("This instalment has already been paid.");
    }
    if (instalment.status === "WAIVED") {
      throw new LoanError("This instalment has been waived by the Government.");
    }

    const [loan] = await tx
      .select()
      .from(loans)
      .where(eq(loans.id, instalment.loanId))
      .for("update");
    if (!loan) throw new LoanError("Loan not found.");
    if (loan.status === "PAID") throw new LoanError("This loan is already fully repaid.");

    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, loan.companyId))
      .for("update");
    if (!company) throw new LoanError("Company not found.");
    if (company.ownerUserId !== payingUserId) {
      throw new LoanError("Only the company owner can make this repayment.");
    }

    const [gov] = await tx.select({ id: government.id }).from(government).limit(1);
    if (!gov) throw new LoanError("Government account is not initialized.");

    // Repayment: company wallet → treasury. Tax-free.
    const result = await transferInTx(tx, {
      from: companyWallet(company.id),
      to: governmentWallet(gov.id),
      amount: instalment.totalDue,
      forcedTaxRateBp: 0,
      type: "LOAN_REPAYMENT",
      reason: `Loan ${loan.loanNumber} — instalment ${instalment.sequence} of ${loan.instalmentCount}`,
      // A suspended company must still be able to service its debt.
      skipSenderCheck: true,
      notify: {
        senderType: "LOAN_REPAYMENT",
        senderMessage: (r) =>
          `Instalment ${instalment.sequence} of loan ${loan.loanNumber} paid: ${r.grossAmount.toLocaleString()} Aeros. Ref ${r.txRef}.`,
        href: "/my-company/loans",
      },
    });

    const marked = await tx
      .update(loanInstalments)
      .set({
        status: "PAID",
        paidAt: new Date(),
        paidTxRef: result.txRef,
        paidAmount: instalment.totalDue,
      })
      .where(
        and(
          eq(loanInstalments.id, instalmentId),
          ne(loanInstalments.status, "PAID"),
        ),
      )
      .returning();

    if (marked.length === 0) {
      throw new LoanError("This instalment has already been paid.");
    }

    const principalPaid = loan.principalPaid + instalment.principalPortion;
    const interestPaid = loan.interestPaid + instalment.interestPortion;
    const totalPayable = loan.totalPayable ?? 0;
    const remainingBalance = Math.max(0, totalPayable - (principalPaid + interestPaid));

    await tx.insert(loanPayments).values({
      loanId: loan.id,
      instalmentId,
      amount: instalment.totalDue,
      principalPaid: instalment.principalPortion,
      interestPaid: instalment.interestPortion,
      remainingBalance,
      txRef: result.txRef,
      paidByUserId: payingUserId,
    });

    // Next unpaid instalment, for the loan's due-date summary.
    const remainingInstalments = await tx
      .select()
      .from(loanInstalments)
      .where(
        and(
          eq(loanInstalments.loanId, loan.id),
          notPaidOrWaived(),
        ),
      )
      .orderBy(asc(loanInstalments.dueAt));

    const fullyRepaid = remainingInstalments.length === 0;

    const [updatedLoan] = await tx
      .update(loans)
      .set({
        principalPaid,
        interestPaid,
        nextDueAt: remainingInstalments[0]?.dueAt ?? null,
        status: fullyRepaid ? "PAID" : loan.status === "DEFAULTED" ? "DEFAULTED" : "ACTIVE",
        completedAt: fullyRepaid ? new Date() : null,
      })
      .where(eq(loans.id, loan.id))
      .returning();

    await recordAudit(tx, {
      action: "LOAN_INSTALMENT_PAID",
      actorType: "COMPANY",
      actorId: company.id,
      actorLabel: company.username,
      targetType: "LOAN",
      targetId: loan.id,
      previousValue: String(remainingBalance + instalment.totalDue),
      newValue: String(remainingBalance),
      metadata: {
        loanNumber: loan.loanNumber,
        instalmentId,
        sequence: instalment.sequence,
        principalPaid: instalment.principalPortion,
        interestPaid: instalment.interestPortion,
        remainingBalance,
        txRef: result.txRef,
      },
    });

    if (fullyRepaid) {
      await notifyUser(
        tx,
        company.ownerUserId,
        "LOAN_COMPLETED",
        `Loan ${loan.loanNumber} is fully repaid. Thank you.`,
        "/my-company/loans",
      );
    }

    return { txRef: result.txRef, instalment: marked[0], loan: updatedLoan };
  });
}

function notPaidOrWaived() {
  return sql`${loanInstalments.status} NOT IN ('PAID', 'WAIVED')`;
}

// ---------------------------------------------------------------------------
// Reminders, overdue marking, maintenance
// ---------------------------------------------------------------------------

export type ReminderStage =
  | "UPCOMING_3D"
  | "DUE_TOMORROW"
  | "DUE_TODAY"
  | "OVERDUE_1D"
  | "OVERDUE_3D"
  | "FINAL_NOTICE";

const STAGE_ORDER: ReminderStage[] = [
  "UPCOMING_3D",
  "DUE_TOMORROW",
  "DUE_TODAY",
  "OVERDUE_1D",
  "OVERDUE_3D",
  "FINAL_NOTICE",
];

/**
 * Which escalating stage an instalment is currently in, if any.
 *
 * Deliberately measured in IST CALENDAR days, not elapsed hours: an
 * instalment due tomorrow at noon should say "due tomorrow" when read this
 * evening, not "due today" just because fewer than 24 hours remain — and
 * "tomorrow" means the next India Standard Time calendar day specifically,
 * so every viewer (and every other day-boundary rule in the app) agrees on
 * where a day starts, regardless of the server's or the viewer's own
 * timezone.
 */
export function reminderStageFor(
  dueAt: Date,
  graceDays: number,
  now = new Date(),
): ReminderStage | null {
  const dayDiff = istCalendarDaysBetween(now, dueAt);

  if (dayDiff <= -graceDays) return "FINAL_NOTICE";
  if (dayDiff <= -3) return "OVERDUE_3D";
  if (dayDiff < 0) return "OVERDUE_1D";
  if (dayDiff === 0) return "DUE_TODAY";
  if (dayDiff === 1) return "DUE_TOMORROW";
  if (dayDiff <= 3) return "UPCOMING_3D";
  return null;
}

function stageMessage(
  stage: ReminderStage,
  loanNumber: string,
  sequence: number,
  amount: number,
  dueAt: Date,
): string {
  const due = formatDate(dueAt);
  const amt = amount.toLocaleString();
  switch (stage) {
    case "UPCOMING_3D":
      return `Reminder: instalment ${sequence} of loan ${loanNumber} — ${amt} Aeros — is due on ${due} (in 3 days).`;
    case "DUE_TOMORROW":
      return `Instalment ${sequence} of loan ${loanNumber} — ${amt} Aeros — is due TOMORROW (${due}).`;
    case "DUE_TODAY":
      return `Instalment ${sequence} of loan ${loanNumber} — ${amt} Aeros — is due TODAY. Please pay to avoid it becoming overdue.`;
    case "OVERDUE_1D":
      return `OVERDUE: instalment ${sequence} of loan ${loanNumber} — ${amt} Aeros — was due on ${due} and is now overdue. Please pay immediately.`;
    case "OVERDUE_3D":
      return `URGENT — OVERDUE 3+ DAYS: instalment ${sequence} of loan ${loanNumber} — ${amt} Aeros — remains unpaid. Continued non-payment may lead to Government action.`;
    case "FINAL_NOTICE":
      return `FINAL NOTICE: instalment ${sequence} of loan ${loanNumber} — ${amt} Aeros — is seriously overdue. The Government may now declare this loan in default.`;
  }
}

/**
 * Marks elapsed instalments OVERDUE and issues any escalating reminders that
 * have not been sent yet. Safe and cheap to call repeatedly — each stage is
 * only ever notified once per instalment.
 */
export async function runLoanMaintenance(): Promise<{
  markedOverdue: number;
  remindersSent: number;
}> {
  const policy = await getLoanPolicy();
  const now = new Date();

  // 1. Mark elapsed unpaid instalments as OVERDUE.
  const overdueRows = await db
    .update(loanInstalments)
    .set({ status: "OVERDUE" })
    .where(
      and(
        eq(loanInstalments.status, "PENDING"),
        lte(loanInstalments.dueAt, now),
      ),
    )
    .returning({ id: loanInstalments.id });

  // 2. Escalating reminders for every still-outstanding instalment on an
  //    active loan.
  const outstanding = await db
    .select({
      instalment: loanInstalments,
      loan: loans,
      company: companies,
    })
    .from(loanInstalments)
    .innerJoin(loans, eq(loans.id, loanInstalments.loanId))
    .innerJoin(companies, eq(companies.id, loans.companyId))
    .where(
      and(
        inArray(loanInstalments.status, ["PENDING", "OVERDUE"]),
        inArray(loans.status, ["ACTIVE", "DEFAULTED", "RESTRUCTURED"]),
      ),
    );

  let remindersSent = 0;

  for (const row of outstanding) {
    const stage = reminderStageFor(row.instalment.dueAt, policy.defaultGraceDays, now);
    if (!stage) continue;

    const lastStage = row.instalment.lastReminderStage as ReminderStage | null;
    const alreadyAt = lastStage ? STAGE_ORDER.indexOf(lastStage) : -1;
    const nowAt = STAGE_ORDER.indexOf(stage);

    // Only notify when the instalment has escalated to a NEW stage.
    if (nowAt <= alreadyAt) continue;

    await notifyUser(
      db,
      row.company.ownerUserId,
      "LOAN_REMINDER",
      stageMessage(
        stage,
        row.loan.loanNumber,
        row.instalment.sequence,
        row.instalment.totalDue,
        row.instalment.dueAt,
      ),
      "/my-company/loans",
    );

    await db
      .update(loanInstalments)
      .set({
        lastReminderStage: stage,
        lastReminderAt: now,
        remindersSent: row.instalment.remindersSent + 1,
      })
      .where(eq(loanInstalments.id, row.instalment.id));

    remindersSent++;
  }

  // 3. Keep each loan's next-due summary accurate.
  const activeLoans = await db
    .select({ id: loans.id })
    .from(loans)
    .where(inArray(loans.status, ["ACTIVE", "DEFAULTED", "RESTRUCTURED"]));

  for (const loan of activeLoans) {
    const [next] = await db
      .select({ dueAt: loanInstalments.dueAt })
      .from(loanInstalments)
      .where(and(eq(loanInstalments.loanId, loan.id), notPaidOrWaived()))
      .orderBy(asc(loanInstalments.dueAt))
      .limit(1);

    await db
      .update(loans)
      .set({ nextDueAt: next?.dueAt ?? null })
      .where(eq(loans.id, loan.id));
  }

  return { markedOverdue: overdueRows.length, remindersSent };
}

// ---------------------------------------------------------------------------
// Government actions on troubled loans
// ---------------------------------------------------------------------------

export type LoanActionType =
  | "WARNING"
  | "RESTRICTION"
  | "DEMAND"
  | "RESTRUCTURE"
  | "DEFAULT"
  | "SUSPENSION"
  | "CLEARED";

/**
 * Records an explicit, audited Government action on a loan.
 *
 * Deliberately limited: nothing here seizes Aeros from a company wallet or
 * transfers company ownership. Serious cases escalate through warnings,
 * restrictions, restructuring and formal default — all reversible, all
 * recorded — and any actual money movement still has to happen through a
 * normal, audited transfer (spec: "never silently seize funds or ownership").
 */
export async function recordLoanAction(params: {
  loanId: string;
  governmentId: string;
  governmentUsername: string;
  action: LoanActionType;
  reason: string;
  /** For RESTRUCTURE: the new instalment interval to reschedule onto. */
  restructureIntervalDays?: number;
  restructureFromDate?: Date;
}): Promise<Loan> {
  const { loanId, governmentId, governmentUsername, action, reason } = params;

  if (!reason.trim()) {
    throw new LoanError("Every loan action must include a written reason.");
  }

  return db.transaction(async (tx) => {
    const [loan] = await tx.select().from(loans).where(eq(loans.id, loanId)).for("update");
    if (!loan) throw new LoanError("Loan not found.");

    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, loan.companyId))
      .limit(1);
    if (!company) throw new LoanError("Company not found.");

    const changes: Partial<typeof loans.$inferInsert> = {};

    if (action === "DEFAULT") {
      if (loan.status === "PAID") throw new LoanError("A fully repaid loan cannot be defaulted.");
      changes.status = "DEFAULTED";
      changes.defaultedAt = new Date();
      changes.defaultReason = reason;
    } else if (action === "RESTRUCTURE") {
      if (loan.status !== "ACTIVE" && loan.status !== "DEFAULTED") {
        throw new LoanError("Only an active or defaulted loan can be restructured.");
      }
      changes.status = "RESTRUCTURED";
      changes.restructuredAt = new Date();
      changes.restructureNote = reason;

      // Reschedule remaining instalments from the chosen date, keeping the
      // agreed principal and interest split exactly as it was.
      const remaining = await tx
        .select()
        .from(loanInstalments)
        .where(and(eq(loanInstalments.loanId, loanId), notPaidOrWaived()))
        .orderBy(asc(loanInstalments.sequence));

      const interval = params.restructureIntervalDays ?? loan.instalmentIntervalDays ?? 7;
      const from = params.restructureFromDate ?? new Date();

      for (let i = 0; i < remaining.length; i++) {
        const newDue = new Date(from.getTime() + (i + 1) * interval * 24 * 60 * 60 * 1000);
        await tx
          .update(loanInstalments)
          .set({
            dueAt: newDue,
            status: "PENDING",
            lastReminderStage: null,
            lastReminderAt: null,
          })
          .where(eq(loanInstalments.id, remaining[i].id));
      }

      changes.nextDueAt = remaining.length
        ? new Date(from.getTime() + interval * 24 * 60 * 60 * 1000)
        : null;
    } else if (action === "CLEARED") {
      if (loan.status === "DEFAULTED" || loan.status === "RESTRUCTURED") {
        changes.status = "ACTIVE";
        changes.defaultedAt = null;
        changes.defaultReason = null;
      }
    }

    let updated = loan;
    if (Object.keys(changes).length > 0) {
      const [row] = await tx
        .update(loans)
        .set(changes)
        .where(eq(loans.id, loanId))
        .returning();
      updated = row;
    }

    await tx.insert(loanActions).values({
      loanId,
      action,
      reason,
      actorLabel: governmentUsername,
      metadata: { previousStatus: loan.status, newStatus: updated.status },
    });

    await recordAudit(tx, {
      action: `LOAN_${action}`,
      actorType: "GOVERNMENT",
      actorId: governmentId,
      actorLabel: governmentUsername,
      targetType: "LOAN",
      targetId: loanId,
      previousValue: loan.status,
      newValue: updated.status,
      reason,
      metadata: { loanNumber: loan.loanNumber },
    });

    const messages: Record<LoanActionType, string> = {
      WARNING: `Government issued a warning regarding loan ${loan.loanNumber}. Reason: ${reason}`,
      RESTRICTION: `Government placed a restriction related to loan ${loan.loanNumber}. Reason: ${reason}`,
      DEMAND: `Government issued a formal demand for repayment of loan ${loan.loanNumber}. Reason: ${reason}`,
      RESTRUCTURE: `Loan ${loan.loanNumber} has been restructured with new instalment dates. Reason: ${reason}`,
      DEFAULT: `Loan ${loan.loanNumber} has been declared in default. Reason: ${reason}`,
      SUSPENSION: `Government suspended activity related to loan ${loan.loanNumber}. Reason: ${reason}`,
      CLEARED: `The action against loan ${loan.loanNumber} has been cleared. Reason: ${reason}`,
    };

    await notifyUser(
      tx,
      company.ownerUserId,
      "LOAN_ACTION",
      messages[action],
      "/my-company/loans",
    );

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export type LoanSummary = {
  loan: Loan;
  instalments: LoanInstalment[];
  paid: number;
  remaining: number;
  nextInstalment: LoanInstalment | null;
  overdueCount: number;
};

export async function getLoanSummary(loanId: string): Promise<LoanSummary | null> {
  const [loan] = await db.select().from(loans).where(eq(loans.id, loanId)).limit(1);
  if (!loan) return null;

  const instalments = await db
    .select()
    .from(loanInstalments)
    .where(eq(loanInstalments.loanId, loanId))
    .orderBy(asc(loanInstalments.sequence));

  const paid = loan.principalPaid + loan.interestPaid;
  const remaining = Math.max(0, (loan.totalPayable ?? 0) - paid);
  const outstanding = instalments.filter((i) => i.status !== "PAID" && i.status !== "WAIVED");

  return {
    loan,
    instalments,
    paid,
    remaining,
    nextInstalment: outstanding[0] ?? null,
    overdueCount: instalments.filter((i) => i.status === "OVERDUE").length,
  };
}

export async function getLoansForCompany(companyId: string) {
  return db
    .select()
    .from(loans)
    .where(eq(loans.companyId, companyId))
    .orderBy(desc(loans.createdAt));
}

export async function getAllLoans(limit = 200) {
  return db
    .select({
      loan: loans,
      companyName: companies.name,
      companyUsername: companies.username,
      companyBalance: companies.balance,
      ownerUsername: users.username,
    })
    .from(loans)
    .innerJoin(companies, eq(companies.id, loans.companyId))
    .innerJoin(users, eq(users.id, companies.ownerUserId))
    .orderBy(desc(loans.createdAt))
    .limit(limit);
}

export async function getInstalmentById(instalmentId: string) {
  const [row] = await db
    .select({
      instalment: loanInstalments,
      loan: loans,
      company: companies,
    })
    .from(loanInstalments)
    .innerJoin(loans, eq(loans.id, loanInstalments.loanId))
    .innerJoin(companies, eq(companies.id, loans.companyId))
    .where(eq(loanInstalments.id, instalmentId))
    .limit(1);
  return row ?? null;
}

export async function getLoanPaymentsForLoan(loanId: string) {
  return db
    .select()
    .from(loanPayments)
    .where(eq(loanPayments.loanId, loanId))
    .orderBy(desc(loanPayments.createdAt));
}

export async function getLoanActionsForLoan(loanId: string) {
  return db
    .select()
    .from(loanActions)
    .where(eq(loanActions.loanId, loanId))
    .orderBy(desc(loanActions.createdAt));
}

export async function getLoanCounts() {
  const rows = await db
    .select({ status: loans.status, count: sql<number>`count(*)::int` })
    .from(loans)
    .groupBy(loans.status);

  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.count]));

  const [outstandingRow] = await db
    .select({
      total: sql<number>`coalesce(sum(coalesce(${loans.totalPayable},0) - ${loans.principalPaid} - ${loans.interestPaid}), 0)::int`,
    })
    .from(loans)
    .where(inArray(loans.status, ["ACTIVE", "DEFAULTED", "RESTRUCTURED"]));

  const [overdueRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(loanInstalments)
    .where(eq(loanInstalments.status, "OVERDUE"));

  return {
    pending: byStatus.PENDING ?? 0,
    approved: byStatus.APPROVED ?? 0,
    active: byStatus.ACTIVE ?? 0,
    paid: byStatus.PAID ?? 0,
    defaulted: byStatus.DEFAULTED ?? 0,
    restructured: byStatus.RESTRUCTURED ?? 0,
    rejected: byStatus.REJECTED ?? 0,
    outstandingTotal: outstandingRow?.total ?? 0,
    overdueInstalments: overdueRow?.c ?? 0,
  };
}
