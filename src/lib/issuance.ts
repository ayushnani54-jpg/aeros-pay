import "server-only";
import { db } from "@/db/client";
import {
  government,
  issuanceEligibleVoters,
  issuanceRequests,
  issuanceVotes,
  transactions,
  users,
} from "@/db/schema";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { MIN_ISSUANCE_AMOUNT } from "./constants";
import { recordAudit } from "./audit";
import { notifyEligibleVoters, notifyUser, publishUpdate } from "./notify";
import { nextTxRef } from "./txref";
import { isUniqueViolation } from "./db-errors";
import { effectiveUserStatus, healExpiredSuspensions } from "./status";
import { istCalendarDaysBetween } from "./datetime";

export class IssuanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssuanceError";
  }
}

/**
 * True when an issuance may NOT be executed right now because the last
 * executed issuance fell too recently in IST CALENDAR-DAY terms.
 *
 * V2.1 semantics (replaces the old rolling N×24h cooldown): Government may
 * execute an issuance only once per IST calendar day. `cooldownDays` is "how
 * many IST calendar days must have rolled over since the last execution" —
 * the default of 1 means simply "not today, IST" (execution is allowed again
 * as soon as the IST date changes, even if under 24 real hours have passed
 * near midnight). `cooldownDays <= 0` disables the check entirely.
 */
async function hasRecentExecution(
  executor: Pick<typeof db, "select">,
  cooldownDays: number,
  now: Date,
): Promise<boolean> {
  if (cooldownDays <= 0) return false;

  const [last] = await executor
    .select({ executedAt: issuanceRequests.executedAt })
    .from(issuanceRequests)
    .where(eq(issuanceRequests.status, "EXECUTED"))
    .orderBy(desc(issuanceRequests.executedAt))
    .limit(1);

  if (!last?.executedAt) return false;

  return istCalendarDaysBetween(last.executedAt, now) < cooldownDays;
}

export async function createIssuanceRequest(params: {
  governmentId: string;
  governmentUsername: string;
  amount: number;
  reason: string;
  note?: string | null;
}) {
  const { governmentId, governmentUsername, amount, reason } = params;

  if (!Number.isInteger(amount) || amount < MIN_ISSUANCE_AMOUNT) {
    throw new IssuanceError("Issuance amount must be a positive whole number.");
  }

  // The real, Government-configurable cap lives on the government row, not a
  // hardcoded constant (V2.1). This is a defense-in-depth check at creation
  // time — `executeIssuance` re-checks it against the live value again,
  // atomically, at execution time.
  const [govForLimit] = await db
    .select({ maxIssuanceAmount: government.maxIssuanceAmount })
    .from(government)
    .where(eq(government.id, governmentId))
    .limit(1);
  if (!govForLimit) throw new IssuanceError("Government account not found.");
  if (amount > govForLimit.maxIssuanceAmount) {
    throw new IssuanceError(
      `Issuance amount cannot exceed ${govForLimit.maxIssuanceAmount.toLocaleString()} Aeros.`,
    );
  }

  // Make sure elapsed timed suspensions are reflected before we snapshot the
  // electorate, so a user whose suspension just expired is not wrongly
  // excluded from the vote.
  await healExpiredSuspensions();

  return db.transaction(async (tx) => {
    // Snapshot every currently-eligible user as a voter. This snapshot is
    // immutable from here on — the Government cannot add or remove voters
    // from an open request (spec §36).
    //
    // Eligible = registered, not banned, not (still) suspended. The
    // Government is not a voter.
    const candidates = await tx
      .select({
        id: users.id,
        status: users.status,
        suspendedUntil: users.suspendedUntil,
      })
      .from(users)
      .where(ne(users.status, "BANNED"));

    const eligible = candidates.filter((u) => effectiveUserStatus(u) === "ACTIVE");

    if (eligible.length === 0) {
      throw new IssuanceError(
        "There are no eligible active users to vote on an issuance request.",
      );
    }

    const [request] = await tx
      .insert(issuanceRequests)
      .values({ amount, reason, note: params.note ?? null })
      .returning();

    await tx.insert(issuanceEligibleVoters).values(
      eligible.map((u) => ({ requestId: request.id, userId: u.id })),
    );

    await recordAudit(tx, {
      action: "ISSUANCE_REQUEST_CREATED",
      actorType: "GOVERNMENT",
      actorId: governmentId,
      actorLabel: governmentUsername,
      targetType: "ISSUANCE_REQUEST",
      targetId: request.id,
      newValue: String(amount),
      reason,
      metadata: { amount, reason, eligibleVoterCount: eligible.length },
    });

    await notifyEligibleVoters(
      tx,
      "ISSUANCE_VOTE_REQUESTED",
      `Government requested ${amount.toLocaleString()} Aeros issuance: "${reason}". Please cast your vote.`,
      "/updates",
    );

    return request;
  });
}

export async function castIssuanceVote(params: {
  requestId: string;
  userId: string;
  vote: "APPROVE" | "REJECT";
}) {
  const { requestId, userId, vote } = params;

  return db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(issuanceRequests)
      .where(eq(issuanceRequests.id, requestId))
      .for("update");

    if (!request) throw new IssuanceError("Issuance request not found.");
    if (request.status !== "OPEN") {
      throw new IssuanceError("This issuance request is no longer open for voting.");
    }

    const [eligible] = await tx
      .select()
      .from(issuanceEligibleVoters)
      .where(
        and(
          eq(issuanceEligibleVoters.requestId, requestId),
          eq(issuanceEligibleVoters.userId, userId),
        ),
      );
    if (!eligible) {
      throw new IssuanceError("You are not eligible to vote on this request.");
    }

    // A vote is immutable once cast (spec §36) — the unique index is what
    // actually enforces that, so a double-submit cannot overwrite a vote.
    try {
      await tx.insert(issuanceVotes).values({ requestId, userId, vote });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new IssuanceError("You have already voted on this request.");
      }
      throw e;
    }
  });
}

export type ApprovalProgress = {
  eligibleCount: number;
  approveCount: number;
  rejectCount: number;
  pendingCount: number;
  /** Votes needed for a simple majority of the eligible electorate. */
  requiredToPass: number;
  /** True once approvals exceed half the eligible voters. */
  thresholdReached: boolean;
  /** True once enough rejections exist that a majority is impossible. */
  outcomeDecidedAgainst: boolean;
};

/**
 * V2 THRESHOLD CHANGE (spec §37)
 * ------------------------------
 * V1 required unanimous approval from every eligible voter. V2 uses a simple
 * majority: `approvals > eligible / 2`.
 *
 * Non-voters are NOT counted as approvals — abstaining is neutral, so a
 * request with 5 eligible voters needs 3 approvals whether the other two
 * reject or simply never vote.
 *
 * This is an intentional, spec-mandated behaviour change from V1, applied to
 * open requests as well as new ones.
 */
export function requiredMajority(eligibleCount: number): number {
  return Math.floor(eligibleCount / 2) + 1;
}

export async function getApprovalProgress(
  requestId: string,
): Promise<ApprovalProgress> {
  const [eligibleRows, voteRows] = await Promise.all([
    db
      .select({ userId: issuanceEligibleVoters.userId })
      .from(issuanceEligibleVoters)
      .where(eq(issuanceEligibleVoters.requestId, requestId)),
    db
      .select({ vote: issuanceVotes.vote })
      .from(issuanceVotes)
      .where(eq(issuanceVotes.requestId, requestId)),
  ]);

  const eligibleCount = eligibleRows.length;
  const approveCount = voteRows.filter((v) => v.vote === "APPROVE").length;
  const rejectCount = voteRows.filter((v) => v.vote === "REJECT").length;
  const pendingCount = eligibleCount - approveCount - rejectCount;
  const requiredToPass = requiredMajority(eligibleCount);

  return {
    eligibleCount,
    approveCount,
    rejectCount,
    pendingCount,
    requiredToPass,
    thresholdReached: eligibleCount > 0 && approveCount >= requiredToPass,
    // Once this many voters have rejected, the remaining voters cannot reach
    // a majority even if all of them approve.
    outcomeDecidedAgainst:
      eligibleCount > 0 && approveCount + pendingCount < requiredToPass,
  };
}

export async function executeIssuance(params: {
  requestId: string;
  governmentId: string;
  governmentUsername: string;
}) {
  const { requestId, governmentId, governmentUsername } = params;

  return db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(issuanceRequests)
      .where(eq(issuanceRequests.id, requestId))
      .for("update");

    if (!request) throw new IssuanceError("Issuance request not found.");
    if (request.status === "EXECUTED") {
      throw new IssuanceError("This issuance request has already been executed.");
    }

    // Lock the government singleton row BEFORE checking the daily cooldown.
    // This is what makes the check atomic: two near-simultaneous execution
    // attempts (of the same request or of two different ones) serialize on
    // this lock, so the second one only proceeds once the first has either
    // committed its execution (and is therefore visible to the cooldown
    // query below) or rolled back. Same lock pattern as payments/wallets use
    // for the government singleton row.
    const [gov] = await tx
      .select()
      .from(government)
      .where(eq(government.id, governmentId))
      .for("update");
    if (!gov) throw new IssuanceError("Government account not found.");

    if (request.amount > gov.maxIssuanceAmount) {
      throw new IssuanceError(
        `Issuance amount cannot exceed ${gov.maxIssuanceAmount.toLocaleString()} Aeros.`,
      );
    }

    const now = new Date();
    const recentlyExecuted = await hasRecentExecution(tx, gov.issuanceCooldownDays, now);
    if (recentlyExecuted) {
      throw new IssuanceError(
        `Only one Aeros issuance is allowed per calendar day (India Standard Time). ` +
          `An issuance was already executed within the last ${gov.issuanceCooldownDays} IST calendar day(s) — try again after the next IST calendar day begins.`,
      );
    }

    const eligibleRows = await tx
      .select({ userId: issuanceEligibleVoters.userId })
      .from(issuanceEligibleVoters)
      .where(eq(issuanceEligibleVoters.requestId, requestId));

    const voteRows = await tx
      .select({ userId: issuanceVotes.userId, vote: issuanceVotes.vote })
      .from(issuanceVotes)
      .where(eq(issuanceVotes.requestId, requestId));

    const eligibleCount = eligibleRows.length;
    const approveCount = voteRows.filter((v) => v.vote === "APPROVE").length;
    const required = requiredMajority(eligibleCount);

    if (eligibleCount === 0 || approveCount < required) {
      throw new IssuanceError(
        `Approval requirement has not been met. ${approveCount} of ${eligibleCount} eligible users approved; ${required} approvals are required.`,
      );
    }

    // This is the ONLY place in the system where total supply increases.
    await tx
      .update(government)
      .set({
        balance: sql`${government.balance} + ${request.amount}`,
        totalSupply: sql`${government.totalSupply} + ${request.amount}`,
      })
      .where(eq(government.id, gov.id));

    const txRef = await nextTxRef(tx);

    await tx.insert(transactions).values({
      txRef,
      type: "ISSUANCE_CREDIT",
      senderType: "GOVERNMENT",
      senderId: null,
      senderUsername: "SYSTEM",
      receiverType: "GOVERNMENT",
      receiverId: null,
      receiverUsername: gov.username,
      grossAmount: request.amount,
      taxAmount: 0,
      netAmount: request.amount,
      taxRateBpApplied: 0,
      reason: request.reason,
    });

    await tx
      .update(issuanceRequests)
      .set({ status: "EXECUTED", executedAt: now, executedTxRef: txRef })
      .where(eq(issuanceRequests.id, requestId));

    await recordAudit(tx, {
      action: "ISSUANCE_EXECUTED",
      actorType: "GOVERNMENT",
      actorId: governmentId,
      actorLabel: governmentUsername,
      targetType: "ISSUANCE_REQUEST",
      targetId: requestId,
      previousValue: `supply ${gov.totalSupply}`,
      newValue: `supply ${gov.totalSupply + request.amount}`,
      reason: request.reason,
      metadata: {
        amount: request.amount,
        txRef,
        approveCount,
        eligibleCount,
        requiredToPass: required,
      },
    });

    await notifyEligibleVoters(
      tx,
      "ISSUANCE_EXECUTED",
      `The issuance request for ${request.amount.toLocaleString()} Aeros was approved and executed.`,
      "/updates",
    );

    await publishUpdate(tx, {
      title: `Aeros issuance executed: ${request.amount.toLocaleString()} Aeros`,
      content: `A community-approved issuance of ${request.amount.toLocaleString()} Aeros has been executed. Reason: ${request.reason}`,
      authorLabel: "Government",
    });

    return { txRef, amount: request.amount, approveCount, eligibleCount };
  });
}

export { notifyUser };
