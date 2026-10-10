import "server-only";
import { db } from "@/db/client";
import {
  exchangePurchases,
  government,
  refundRequests,
  transactions,
  users,
  type RefundRequest,
} from "@/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import { notifyUser } from "./notify";
import { transferInTx } from "./payments";
import { governmentWallet, userWallet } from "./wallets";
import { CURRENCY_NAME } from "./constants";

/**
 * REFUND CENTER (V4, Spec §§4.D, 12)
 * ============================================================================
 *
 * State machine:
 *   PENDING -> UNDER_REVIEW | DELAYED | APPROVED | REJECTED
 *   UNDER_REVIEW -> DELAYED | APPROVED | PROCESSING | COMPLETED | REJECTED
 *   DELAYED -> UNDER_REVIEW | APPROVED | PROCESSING | COMPLETED | REJECTED
 *   APPROVED -> PROCESSING | COMPLETED
 *   PROCESSING -> COMPLETED | DELAYED
 *   COMPLETED (terminal)
 *   REJECTED (terminal)
 *
 * Distinction between virtual Aeros adjustments and Exchange package refunds:
 * - `VIRTUAL_AEROS_REFUND`: Requests a virtual Aeros refund credit from the
 *   Government Treasury (`REFUND_CREDIT`: `governmentWallet` -> `userWallet`).
 * - `EXCHANGE_PACKAGE_REFUND`: Linked to a credited `exchange_purchases` row.
 *   When completed with `executeAerosTransfer = true`, reclaims the credited
 *   virtual Aeros from the user wallet back to the Government Treasury
 *   (`REFUND_DEBIT`: `userWallet` -> `governmentWallet`) and marks the
 *   `exchange_purchases` row `REFUNDED`, while recording the manual external
 *   INR settlement note (never falsely claiming automated bank/gateway payout).
 */

export class RefundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function nextRefundNumber(tx: Pick<typeof db, "execute">): Promise<string> {
  const res = await tx.execute<{ nextval: string }>(
    sql`SELECT nextval('refund_request_number_seq') AS nextval`,
  );
  const seq = String(res.rows[0]?.nextval ?? "1").padStart(6, "0");
  return `RFD-${seq}`;
}

const TERMINAL_REFUND_STATUSES = new Set(["COMPLETED", "REJECTED"]);

export async function createRefundRequest(params: {
  userId: string;
  refundType: "VIRTUAL_AEROS_REFUND" | "EXCHANGE_PACKAGE_REFUND";
  sourceTxRef?: string | null;
  exchangePurchaseId?: string | null;
  requestedAerosAmount: number;
  reason: string;
  userNotes?: string | null;
  idempotencyKey?: string | null;
}): Promise<RefundRequest> {
  return db.transaction(async (tx) => {
    const [gov] = await tx.select().from(government).limit(1);
    if (!gov || !gov.refundCenterEnabled) {
      throw new RefundError(
        "The Refund Center is currently disabled by the Government.",
      );
    }

    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, params.userId))
      .limit(1);
    if (!user) throw new RefundError("User account not found.");
    if (user.status === "BANNED") {
      throw new RefundError("Banned accounts cannot submit refund requests.");
    }

    if (params.idempotencyKey) {
      const [existingByKey] = await tx
        .select()
        .from(refundRequests)
        .where(eq(refundRequests.idempotencyKey, params.idempotencyKey))
        .limit(1);
      if (existingByKey) {
        if (existingByKey.userId !== user.id) {
          throw new RefundError("Idempotency key conflict.");
        }
        return existingByKey;
      }
    }

    const cleanTxRef = params.sourceTxRef?.trim().toUpperCase() || null;
    const cleanPurchaseId = params.exchangePurchaseId?.trim() || null;
    let inrReferenceAmount: number | null = null;
    let effectiveAmount = params.requestedAerosAmount;

    if (params.refundType === "EXCHANGE_PACKAGE_REFUND") {
      if (!cleanPurchaseId) {
        throw new RefundError(
          "Please select the Exchange package acquisition you are requesting a refund for.",
        );
      }
      const [purchase] = await tx
        .select()
        .from(exchangePurchases)
        .where(eq(exchangePurchases.id, cleanPurchaseId))
        .for("update");
      if (!purchase || purchase.userId !== user.id) {
        throw new RefundError("Exchange package purchase not found.");
      }
      if (purchase.status !== "CREDITED") {
        throw new RefundError(
          `Only credited Exchange acquisitions can be submitted for package refund (current status: ${purchase.status}).`,
        );
      }

      const [existingActive] = await tx
        .select()
        .from(refundRequests)
        .where(
          and(
            eq(refundRequests.exchangePurchaseId, purchase.id),
            inArray(refundRequests.status, [
              "PENDING",
              "UNDER_REVIEW",
              "DELAYED",
              "APPROVED",
              "PROCESSING",
              "COMPLETED",
            ]),
          ),
        )
        .limit(1);
      if (existingActive) {
        throw new RefundError(
          `A refund request (${existingActive.refundNumber}) already exists for this Exchange acquisition.`,
        );
      }

      effectiveAmount = purchase.totalAerosSnapshot;
      inrReferenceAmount = purchase.inrPriceSnapshot;
    } else if (cleanTxRef) {
      const [txRow] = await tx
        .select()
        .from(transactions)
        .where(eq(transactions.txRef, cleanTxRef))
        .limit(1);
      if (!txRow) {
        throw new RefundError(
          `Transaction reference ${cleanTxRef} was not found in the active ledger.`,
        );
      }
      if (txRow.senderId !== user.id && txRow.receiverId !== user.id) {
        throw new RefundError(
          "You can only reference a transaction that involved your account.",
        );
      }

      const [existingForTx] = await tx
        .select()
        .from(refundRequests)
        .where(
          and(
            eq(refundRequests.userId, user.id),
            eq(refundRequests.sourceTxRef, cleanTxRef),
            inArray(refundRequests.status, [
              "PENDING",
              "UNDER_REVIEW",
              "DELAYED",
              "APPROVED",
              "PROCESSING",
              "COMPLETED",
            ]),
          ),
        )
        .limit(1);
      if (existingForTx) {
        throw new RefundError(
          `An active or completed refund request (${existingForTx.refundNumber}) already references ${cleanTxRef}.`,
        );
      }
    }

    const refundNumber = await nextRefundNumber(tx);

    const [created] = await tx
      .insert(refundRequests)
      .values({
        refundNumber,
        userId: user.id,
        refundType: params.refundType,
        sourceTxRef: cleanTxRef,
        exchangePurchaseId: cleanPurchaseId,
        requestedAerosAmount: effectiveAmount,
        inrReferenceAmount,
        reason: params.reason.trim(),
        userNotes: params.userNotes?.trim() || null,
        status: "PENDING",
        idempotencyKey: params.idempotencyKey || null,
      })
      .returning();

    await recordAudit(tx, {
      action: "REFUND_REQUEST_SUBMITTED",
      actorType: "USER",
      actorId: user.id,
      actorLabel: user.username,
      targetType: "REFUND_REQUEST",
      targetId: created.id,
      newValue: `${created.refundNumber} (${created.refundType}): ${created.requestedAerosAmount} ${CURRENCY_NAME}`,
      reason: created.reason,
      metadata: {
        refundNumber: created.refundNumber,
        refundType: created.refundType,
        requestedAerosAmount: created.requestedAerosAmount,
        sourceTxRef: created.sourceTxRef,
        exchangePurchaseId: created.exchangePurchaseId,
      },
    });

    return created;
  });
}

/**
 * Government state transition and optional virtual Aeros settlement for a
 * refund request.
 */
export async function decideRefundRequest(params: {
  govId: string;
  govUsername: string;
  refundId: string;
  nextStatus:
    | "UNDER_REVIEW"
    | "DELAYED"
    | "APPROVED"
    | "PROCESSING"
    | "COMPLETED"
    | "REJECTED";
  approvedAerosAmount?: number | null;
  governmentDecisionNote: string;
  delayReason?: string | null;
  expectedResolutionAt?: Date | null;
  executeAerosTransfer: boolean;
}): Promise<RefundRequest> {
  return db.transaction(async (tx: Tx) => {
    const [request] = await tx
      .select()
      .from(refundRequests)
      .where(eq(refundRequests.id, params.refundId))
      .for("update");

    if (!request) {
      throw new RefundError("Refund request not found.");
    }
    if (TERMINAL_REFUND_STATUSES.has(request.status)) {
      throw new RefundError(
        `Refund request ${request.refundNumber} is already in terminal status ${request.status}.`,
      );
    }

    const approvedAmount =
      params.approvedAerosAmount !== undefined && params.approvedAerosAmount !== null
        ? params.approvedAerosAmount
        : (request.approvedAerosAmount ?? request.requestedAerosAmount);

    if (!Number.isInteger(approvedAmount) || approvedAmount < 0) {
      throw new RefundError("Approved Aeros amount must be a non-negative whole number.");
    }

    let settlementTxRef = request.settlementTxRef;

    // Execute virtual Aeros transfer only when completing (or approving with
    // immediate execution) and when no settlement transfer has run yet.
    if (
      params.executeAerosTransfer &&
      (params.nextStatus === "COMPLETED" || params.nextStatus === "APPROVED") &&
      !settlementTxRef &&
      approvedAmount > 0
    ) {
      if (request.refundType === "VIRTUAL_AEROS_REFUND") {
        // Credit virtual Aeros from Government Treasury to user wallet
        const transfer = await transferInTx(tx, {
          from: governmentWallet(params.govId),
          to: userWallet(request.userId),
          amount: approvedAmount,
          type: "REFUND_CREDIT",
          reason: `Refund ${request.refundNumber} credit: ${params.governmentDecisionNote.trim()}`,
          forcedTaxRateBp: 0,
        });
        settlementTxRef = transfer.txRef;
      } else {
        // EXCHANGE_PACKAGE_REFUND: reclaim virtual Aeros from user wallet to Treasury
        const transfer = await transferInTx(tx, {
          from: userWallet(request.userId),
          to: governmentWallet(params.govId),
          amount: approvedAmount,
          type: "REFUND_DEBIT",
          reason: `Exchange refund ${request.refundNumber} clawback: ${params.governmentDecisionNote.trim()}`,
          forcedTaxRateBp: 0,
          skipSenderCheck: true,
        });
        settlementTxRef = transfer.txRef;

        if (request.exchangePurchaseId) {
          await tx
            .update(exchangePurchases)
            .set({
              status: "REFUNDED",
              refundedAt: new Date(),
              reviewNote: `Refunded via ${request.refundNumber} (${settlementTxRef})`,
            })
            .where(eq(exchangePurchases.id, request.exchangePurchaseId));
        }
      }
    }

    const now = new Date();
    const [updated] = await tx
      .update(refundRequests)
      .set({
        status: params.nextStatus,
        approvedAerosAmount: approvedAmount,
        governmentDecisionNote: params.governmentDecisionNote.trim(),
        delayReason:
          params.nextStatus === "DELAYED"
            ? params.delayReason?.trim() || params.governmentDecisionNote.trim()
            : request.delayReason,
        expectedResolutionAt:
          params.expectedResolutionAt !== undefined
            ? params.expectedResolutionAt
            : request.expectedResolutionAt,
        settlementTxRef,
        reviewedByGovId: params.govId,
        updatedAt: now,
        completedAt: params.nextStatus === "COMPLETED" ? now : request.completedAt,
        rejectedAt: params.nextStatus === "REJECTED" ? now : request.rejectedAt,
      })
      .where(eq(refundRequests.id, request.id))
      .returning();

    await notifyUser(
      tx,
      request.userId,
      `REFUND_${params.nextStatus}`,
      `Refund request ${request.refundNumber} is now ${params.nextStatus.replace("_", " ")}. Government note: ${params.governmentDecisionNote.trim()}${settlementTxRef ? ` (Ledger ref: ${settlementTxRef})` : ""}`,
      "/refunds",
    );

    await recordAudit(tx, {
      action: `REFUND_STATUS_${params.nextStatus}`,
      actorType: "GOVERNMENT",
      actorId: params.govId,
      actorLabel: params.govUsername,
      targetType: "REFUND_REQUEST",
      targetId: request.id,
      previousValue: request.status,
      newValue: `${params.nextStatus}${settlementTxRef ? ` (${settlementTxRef})` : ""}`,
      reason: params.governmentDecisionNote.trim(),
      metadata: {
        refundNumber: request.refundNumber,
        refundType: request.refundType,
        approvedAerosAmount: approvedAmount,
        settlementTxRef,
      },
    });

    return updated;
  });
}

export async function getUserRefundRequests(
  userId: string,
  limit = 50,
): Promise<RefundRequest[]> {
  return db
    .select()
    .from(refundRequests)
    .where(eq(refundRequests.userId, userId))
    .orderBy(desc(refundRequests.createdAt))
    .limit(limit);
}

export async function getGovRefundRequests(limit = 100): Promise<
  Array<{
    refund: RefundRequest;
    username: string;
    displayName: string;
  }>
> {
  return db
    .select({
      refund: refundRequests,
      username: users.username,
      displayName: users.displayName,
    })
    .from(refundRequests)
    .innerJoin(users, eq(users.id, refundRequests.userId))
    .orderBy(desc(refundRequests.createdAt))
    .limit(limit);
}
