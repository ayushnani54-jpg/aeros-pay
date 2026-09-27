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
import { and, eq, gte, sql } from "drizzle-orm";
import {
  ISSUANCE_COOLDOWN_DAYS,
  MAX_ISSUANCE_AMOUNT,
  MIN_ISSUANCE_AMOUNT,
} from "./constants";
import { recordAudit } from "./audit";
import { notifyAllActiveUsers, notifyUser } from "./notify";
import { nextTxRef } from "./txref";
import { isUniqueViolation } from "./db-errors";

export class IssuanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssuanceError";
  }
}


/** True if any issuance was executed within the last N days. */
async function hasRecentExecution(
  executor: Pick<typeof db, "select">,
  days: number,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await executor
    .select({ id: issuanceRequests.id })
    .from(issuanceRequests)
    .where(
      and(
        eq(issuanceRequests.status, "EXECUTED"),
        gte(issuanceRequests.executedAt, cutoff),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function createIssuanceRequest(params: {
  governmentId: string;
  governmentUsername: string;
  amount: number;
  reason: string;
}) {
  const { governmentId, governmentUsername, amount, reason } = params;

  if (!Number.isInteger(amount) || amount < MIN_ISSUANCE_AMOUNT) {
    throw new IssuanceError("Issuance amount must be a positive whole number.");
  }
  if (amount > MAX_ISSUANCE_AMOUNT) {
    throw new IssuanceError(`Issuance amount cannot exceed ${MAX_ISSUANCE_AMOUNT} Aeros.`);
  }

  return db.transaction(async (tx) => {
    // Snapshot every currently-active user as an eligible voter. This
    // snapshot is immutable from here on — the Government cannot add or
    // remove voters from an open request.
    const eligible = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.status, "ACTIVE"));

    if (eligible.length === 0) {
      throw new IssuanceError(
        "There are no eligible active users to vote on an issuance request.",
      );
    }

    const [request] = await tx
      .insert(issuanceRequests)
      .values({ amount, reason })
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
      metadata: { amount, reason, eligibleVoterCount: eligible.length },
    });

    await notifyAllActiveUsers(
      tx,
      "ISSUANCE_VOTE_REQUESTED",
      `Government requested ${amount} Aeros issuance: "${reason}". Please cast your vote.`,
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
  fullyApproved: boolean;
};

export async function getApprovalProgress(
  requestId: string,
): Promise<ApprovalProgress> {
  const eligibleRows = await db
    .select({ userId: issuanceEligibleVoters.userId })
    .from(issuanceEligibleVoters)
    .where(eq(issuanceEligibleVoters.requestId, requestId));

  const voteRows = await db
    .select({ vote: issuanceVotes.vote })
    .from(issuanceVotes)
    .where(eq(issuanceVotes.requestId, requestId));

  const eligibleCount = eligibleRows.length;
  const approveCount = voteRows.filter((v) => v.vote === "APPROVE").length;
  const rejectCount = voteRows.filter((v) => v.vote === "REJECT").length;
  const pendingCount = eligibleCount - approveCount - rejectCount;

  return {
    eligibleCount,
    approveCount,
    rejectCount,
    pendingCount,
    fullyApproved: eligibleCount > 0 && approveCount === eligibleCount,
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
    if (request.amount > MAX_ISSUANCE_AMOUNT) {
      throw new IssuanceError(`Issuance amount cannot exceed ${MAX_ISSUANCE_AMOUNT} Aeros.`);
    }

    const recentlyExecuted = await hasRecentExecution(tx, ISSUANCE_COOLDOWN_DAYS);
    if (recentlyExecuted) {
      throw new IssuanceError(
        `Only one Aeros issuance is allowed per ${ISSUANCE_COOLDOWN_DAYS}-day period, and one has already occurred recently.`,
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

    const voteByUser = new Map(voteRows.map((v) => [v.userId, v.vote]));
    const eligibleCount = eligibleRows.length;
    const fullyApproved =
      eligibleCount > 0 &&
      eligibleRows.every((row) => voteByUser.get(row.userId) === "APPROVE");

    if (!fullyApproved) {
      throw new IssuanceError(
        "Approval requirement has not been met. Every eligible user must approve.",
      );
    }

    const [gov] = await tx
      .select()
      .from(government)
      .where(eq(government.id, governmentId))
      .for("update");
    if (!gov) throw new IssuanceError("Government account not found.");

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
      .set({ status: "EXECUTED", executedAt: new Date(), executedTxRef: txRef })
      .where(eq(issuanceRequests.id, requestId));

    await recordAudit(tx, {
      action: "ISSUANCE_EXECUTED",
      actorType: "GOVERNMENT",
      actorId: governmentId,
      actorLabel: governmentUsername,
      targetType: "ISSUANCE_REQUEST",
      targetId: requestId,
      metadata: { amount: request.amount, txRef },
    });

    await notifyAllActiveUsers(
      tx,
      "ISSUANCE_EXECUTED",
      `The issuance request for ${request.amount} Aeros was approved and executed.`,
    );

    return { txRef, amount: request.amount };
  });
}

export { notifyUser };
