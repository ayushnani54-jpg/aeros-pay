"use server";

import { db } from "@/db/client";
import { government } from "@/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireGovernment, requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import {
  cancelMyExchangePurchase,
  ExchangeError,
  requestExchangePurchase,
  reviewExchangePurchase,
  upsertExchangePackagePolicy,
} from "@/lib/exchange";
import {
  MarketError,
  placeMarketOrder,
  syncMarketClock,
  updateMarketConfig,
} from "@/lib/synthetic-market";
import {
  createRefundRequest,
  decideRefundRequest,
  RefundError,
} from "@/lib/refunds";
import {
  ArchiveError,
  clearArchiveBatch,
  createArchiveBatch,
  verifyArchiveBatch,
} from "@/lib/archive";
import {
  RetentionError,
  updateV4RetentionSettings,
} from "@/lib/retention";
import { PaymentError } from "@/lib/payments";
import { WalletError } from "@/lib/wallets";
import {
  clearArchiveBatchSchema,
  createArchiveBatchSchema,
  createRefundRequestSchema,
  exchangePackagePolicySchema,
  govRefundDecisionSchema,
  marketConfigSchema,
  placeMarketOrderSchema,
  requestExchangePurchaseSchema,
  reviewExchangePurchaseSchema,
  v4FeatureTogglesSchema,
  v4RetentionSettingsSchema,
  verifyArchiveBatchSchema,
} from "@/lib/validators";
import { MIN_RETENTION_DAYS, MAX_RETENTION_DAYS } from "@/lib/constants";
import type { ActionResult } from "./auth";

function v4ErrMsg(e: unknown, fallback: string): string {
  if (
    e instanceof ExchangeError ||
    e instanceof MarketError ||
    e instanceof RefundError ||
    e instanceof ArchiveError ||
    e instanceof RetentionError ||
    e instanceof PaymentError ||
    e instanceof WalletError
  ) {
    return e.message;
  }
  if (e instanceof Error && e.message) {
    if (e.message === "NOT_AUTHENTICATED") return "You must be signed in.";
    if (e.message === "ACCOUNT_BANNED") return "Banned accounts cannot perform this action.";
    if (e.message === "NOT_AUTHENTICATED_GOVERNMENT") {
      return "Government authorization required.";
    }
    return e.message;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Government V4 Feature Toggles (Spec §§4.E, 16)
// ---------------------------------------------------------------------------

export async function updateV4FeatureTogglesAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = v4FeatureTogglesSchema.safeParse({
    exchangeEnabled: formData.get("exchangeEnabled"),
    exchangeLivePaymentsEnabled: formData.get("exchangeLivePaymentsEnabled"),
    marketEnabled: formData.get("marketEnabled"),
    tradingEnabled: formData.get("tradingEnabled"),
    refundCenterEnabled: formData.get("refundCenterEnabled"),
    retentionEnabled: formData.get("retentionEnabled"),
    archiveCenterEnabled: formData.get("archiveCenterEnabled"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid toggle values." };
  }

  // Never allow live INR payment collection to be toggled on without a verified gateway
  if (parsed.data.exchangeLivePaymentsEnabled) {
    return {
      ok: false,
      error:
        "Live INR payment gateway integration is not configured. Keep live INR payments disabled and use the safe manual Government confirmation workflow.",
    };
  }

  try {
    const prevSnapshot = {
      exchangeEnabled: g.exchangeEnabled,
      marketEnabled: g.marketEnabled,
      tradingEnabled: g.tradingEnabled,
      refundCenterEnabled: g.refundCenterEnabled,
      retentionEnabled: g.retentionEnabled,
      archiveCenterEnabled: g.archiveCenterEnabled,
    };

    const nextSnapshot = {
      exchangeEnabled: parsed.data.exchangeEnabled,
      exchangeLivePaymentsEnabled: false,
      marketEnabled: parsed.data.marketEnabled,
      tradingEnabled: parsed.data.marketEnabled && parsed.data.tradingEnabled,
      refundCenterEnabled: parsed.data.refundCenterEnabled,
      retentionEnabled: parsed.data.retentionEnabled,
      archiveCenterEnabled: parsed.data.archiveCenterEnabled,
    };

    await db
      .update(government)
      .set({
        ...nextSnapshot,
        v4FeaturesUpdatedAt: new Date(),
      })
      .where(eq(government.id, g.id));

    await recordAudit(db, {
      action: "V4_FEATURE_TOGGLES_UPDATED",
      actorType: "GOVERNMENT",
      actorId: g.id,
      actorLabel: g.username,
      targetType: "GOVERNMENT",
      targetId: g.id,
      previousValue: JSON.stringify(prevSnapshot),
      newValue: JSON.stringify(nextSnapshot),
      metadata: nextSnapshot,
    });

    revalidatePath("/gov/control-room");
    revalidatePath("/gov/exchange");
    revalidatePath("/gov/market");
    revalidatePath("/gov/refunds");
    revalidatePath("/gov/archive");
    revalidatePath("/gov/retention");
    revalidatePath("/exchange");
    revalidatePath("/aeros-market");
    revalidatePath("/refunds");
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: v4ErrMsg(e, "Could not update V4 feature toggles.") };
  }
}

// ---------------------------------------------------------------------------
// Aeros Exchange — Package Policies & Purchases (Spec §§4.A, 5)
// ---------------------------------------------------------------------------

export async function upsertExchangePolicyAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = exchangePackagePolicySchema.safeParse({
    policyCode: String(formData.get("policyCode") ?? "").toUpperCase(),
    title: formData.get("title"),
    description: formData.get("description") ?? "",
    inrPrice: formData.get("inrPrice"),
    aerosAmount: formData.get("aerosAmount"),
    bonusAeros: formData.get("bonusAeros") ?? "0",
    active: formData.get("active"),
    disclosureText: formData.get("disclosureText"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid package policy." };
  }

  try {
    await upsertExchangePackagePolicy({
      govId: g.id,
      govUsername: g.username,
      policyCode: parsed.data.policyCode,
      title: parsed.data.title,
      description: parsed.data.description || null,
      inrPrice: parsed.data.inrPrice,
      aerosAmount: parsed.data.aerosAmount,
      bonusAeros: parsed.data.bonusAeros,
      active: parsed.data.active,
      disclosureText: parsed.data.disclosureText,
    });

    revalidatePath("/gov/exchange");
    revalidatePath("/exchange");
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: v4ErrMsg(e, "Could not save Exchange package policy.") };
  }
}

export async function requestExchangePurchaseAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<{ purchaseNumber: string }>> {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return { ok: false, error: v4ErrMsg(e, "You must be signed in.") };
  }

  const parsed = requestExchangePurchaseSchema.safeParse({
    policyId: formData.get("policyId"),
    paymentReference: formData.get("paymentReference") ?? "",
    acknowledgedDisclosure: formData.get("acknowledgedDisclosure"),
    idempotencyKey: (formData.get("idempotencyKey") as string) || undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request." };
  }

  try {
    const purchase = await requestExchangePurchase({
      userId: user.id,
      policyId: parsed.data.policyId,
      paymentReference: parsed.data.paymentReference || null,
      idempotencyKey: parsed.data.idempotencyKey ?? null,
    });

    revalidatePath("/exchange");
    revalidatePath("/gov/exchange");
    return { ok: true, data: { purchaseNumber: purchase.purchaseNumber } };
  } catch (e) {
    return { ok: false, error: v4ErrMsg(e, "Could not submit Exchange request.") };
  }
}

export async function cancelMyExchangePurchaseAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return { ok: false, error: v4ErrMsg(e, "You must be signed in.") };
  }

  const purchaseId = String(formData.get("purchaseId") ?? "").trim();
  if (!purchaseId) return { ok: false, error: "Missing purchase ID." };

  try {
    await cancelMyExchangePurchase({ userId: user.id, purchaseId });
    revalidatePath("/exchange");
    revalidatePath("/gov/exchange");
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: v4ErrMsg(e, "Could not cancel Exchange request.") };
  }
}

export async function reviewExchangePurchaseAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = reviewExchangePurchaseSchema.safeParse({
    purchaseId: formData.get("purchaseId"),
    decision: formData.get("decision"),
    reviewNote: formData.get("reviewNote") ?? "",
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid decision." };
  }

  try {
    await reviewExchangePurchase({
      govId: g.id,
      govUsername: g.username,
      purchaseId: parsed.data.purchaseId,
      decision: parsed.data.decision,
      reviewNote: parsed.data.reviewNote || null,
    });

    revalidatePath("/gov/exchange");
    revalidatePath("/gov/treasury");
    revalidatePath("/gov/transactions");
    revalidatePath("/exchange");
    revalidatePath("/dashboard");
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: v4ErrMsg(e, "Could not process Exchange purchase.") };
  }
}

// ---------------------------------------------------------------------------
// Aeros Market & Trading Actions (Spec §§4.B, 4.C, 6, 7)
// ---------------------------------------------------------------------------

export async function placeMarketOrderAction(
  _prev: unknown,
  formData: FormData,
): Promise<
  ActionResult<{
    orderNumber: string;
    executionPrice: number;
    totalAeros: number;
    txRef: string | null;
  }>
> {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return { ok: false, error: v4ErrMsg(e, "You must be signed in.") };
  }

  const parsed = placeMarketOrderSchema.safeParse({
    side: formData.get("side"),
    quantity: formData.get("quantity"),
    expectedPrice: formData.get("expectedPrice"),
    maxSlippageBp: formData.get("maxSlippageBp") ?? "200",
    idempotencyKey: (formData.get("idempotencyKey") as string) || undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid order input." };
  }

  try {
    const order = await placeMarketOrder({
      userId: user.id,
      side: parsed.data.side,
      quantity: parsed.data.quantity,
      expectedPrice: parsed.data.expectedPrice,
      maxSlippageBp: parsed.data.maxSlippageBp,
      idempotencyKey: parsed.data.idempotencyKey ?? null,
    });

    revalidatePath("/aeros-market");
    revalidatePath("/dashboard");
    revalidatePath("/transactions");
    revalidatePath("/gov/market");
    return {
      ok: true,
      data: {
        orderNumber: order.orderNumber,
        executionPrice: order.executionPrice,
        totalAeros: order.totalAeros,
        txRef: order.txRef,
      },
    };
  } catch (e) {
    return { ok: false, error: v4ErrMsg(e, "Market order could not be executed.") };
  }
}

export async function updateMarketConfigAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = marketConfigSchema.safeParse({
    minPrice: formData.get("minPrice"),
    maxPrice: formData.get("maxPrice"),
    baseVolatilityBp: formData.get("baseVolatilityBp"),
    demandSensitivityBp: formData.get("demandSensitivityBp"),
    maxStepChangeBp: formData.get("maxStepChangeBp"),
    maxOrderUnits: formData.get("maxOrderUnits"),
    userCooldownSeconds: formData.get("userCooldownSeconds"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid market configuration." };
  }

  try {
    await updateMarketConfig({
      govId: g.id,
      govUsername: g.username,
      ...parsed.data,
    });

    revalidatePath("/gov/market");
    revalidatePath("/aeros-market");
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: v4ErrMsg(e, "Could not update market configuration.") };
  }
}

export async function syncMarketClockAction(): Promise<ActionResult> {
  try {
    await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  try {
    await syncMarketClock();
    revalidatePath("/gov/market");
    revalidatePath("/aeros-market");
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: v4ErrMsg(e, "Could not synchronize market clock.") };
  }
}

// ---------------------------------------------------------------------------
// Refund Center Actions (Spec §§4.D, 12)
// ---------------------------------------------------------------------------

export async function createRefundRequestAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<{ refundNumber: string }>> {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return { ok: false, error: v4ErrMsg(e, "You must be signed in.") };
  }

  const parsed = createRefundRequestSchema.safeParse({
    refundType: formData.get("refundType"),
    sourceTxRef: formData.get("sourceTxRef") ?? "",
    exchangePurchaseId: formData.get("exchangePurchaseId") ?? "",
    requestedAerosAmount: formData.get("requestedAerosAmount"),
    reason: formData.get("reason"),
    userNotes: formData.get("userNotes") ?? "",
    idempotencyKey: (formData.get("idempotencyKey") as string) || undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid refund request." };
  }

  try {
    const created = await createRefundRequest({
      userId: user.id,
      refundType: parsed.data.refundType,
      sourceTxRef: parsed.data.sourceTxRef || null,
      exchangePurchaseId: parsed.data.exchangePurchaseId || null,
      requestedAerosAmount: parsed.data.requestedAerosAmount,
      reason: parsed.data.reason,
      userNotes: parsed.data.userNotes || null,
      idempotencyKey: parsed.data.idempotencyKey ?? null,
    });

    revalidatePath("/refunds");
    revalidatePath("/gov/refunds");
    return { ok: true, data: { refundNumber: created.refundNumber } };
  } catch (e) {
    return { ok: false, error: v4ErrMsg(e, "Could not submit refund request.") };
  }
}

export async function govDecideRefundAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = govRefundDecisionSchema.safeParse({
    refundId: formData.get("refundId"),
    nextStatus: formData.get("nextStatus"),
    approvedAerosAmount: formData.get("approvedAerosAmount") ?? "",
    governmentDecisionNote: formData.get("governmentDecisionNote"),
    delayReason: formData.get("delayReason") ?? "",
    expectedResolutionDate: formData.get("expectedResolutionDate") ?? "",
    executeAerosTransfer: formData.get("executeAerosTransfer"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid refund decision." };
  }

  let approvedAmount: number | null = null;
  if (parsed.data.approvedAerosAmount && parsed.data.approvedAerosAmount.trim() !== "") {
    const n = Number(parsed.data.approvedAerosAmount.trim());
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: "Approved Aeros amount must be a non-negative whole number." };
    }
    approvedAmount = n;
  }

  let expectedAt: Date | null = null;
  if (parsed.data.expectedResolutionDate && parsed.data.expectedResolutionDate.trim() !== "") {
    const d = new Date(`${parsed.data.expectedResolutionDate.trim()}T18:00:00+05:30`);
    if (!Number.isNaN(d.getTime())) expectedAt = d;
  }

  try {
    await decideRefundRequest({
      govId: g.id,
      govUsername: g.username,
      refundId: parsed.data.refundId,
      nextStatus: parsed.data.nextStatus,
      approvedAerosAmount: approvedAmount,
      governmentDecisionNote: parsed.data.governmentDecisionNote,
      delayReason: parsed.data.delayReason || null,
      expectedResolutionAt: expectedAt,
      executeAerosTransfer: parsed.data.executeAerosTransfer,
    });

    revalidatePath("/gov/refunds");
    revalidatePath("/gov/treasury");
    revalidatePath("/gov/transactions");
    revalidatePath("/refunds");
    revalidatePath("/exchange");
    revalidatePath("/dashboard");
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: v4ErrMsg(e, "Could not update refund request.") };
  }
}

// ---------------------------------------------------------------------------
// Retention & Archive Center Actions (Spec §§4.F, 4.G, 4.H, 8, 9, 10, 11)
// ---------------------------------------------------------------------------

function parseOptionalRetentionDays(raw: string): number | null | "INVALID" {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < MIN_RETENTION_DAYS || n > MAX_RETENTION_DAYS) {
    return "INVALID";
  }
  return n;
}

export async function updateV4RetentionSettingsAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = v4RetentionSettingsSchema.safeParse({
    transactionHistoryRetentionDays: formData.get("transactionHistoryRetentionDays") ?? "",
    settledOrderHistoryRetentionDays: formData.get("settledOrderHistoryRetentionDays") ?? "",
    closedRefundRetentionDays: formData.get("closedRefundRetentionDays") ?? "",
    marketCandleRetentionDays: formData.get("marketCandleRetentionDays") ?? "",
  });

  if (!parsed.success) return { ok: false, error: "Invalid retention input." };

  const txDays = parseOptionalRetentionDays(parsed.data.transactionHistoryRetentionDays);
  const orderDays = parseOptionalRetentionDays(parsed.data.settledOrderHistoryRetentionDays);
  const refundDays = parseOptionalRetentionDays(parsed.data.closedRefundRetentionDays);
  const candleDays = parseOptionalRetentionDays(parsed.data.marketCandleRetentionDays);

  if (
    txDays === "INVALID" ||
    orderDays === "INVALID" ||
    refundDays === "INVALID" ||
    candleDays === "INVALID"
  ) {
    return {
      ok: false,
      error: `Retention periods must be blank (keep forever) or between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days.`,
    };
  }

  try {
    await updateV4RetentionSettings({
      transactionHistoryRetentionDays: txDays,
      settledOrderHistoryRetentionDays: orderDays,
      closedRefundRetentionDays: refundDays,
      marketCandleRetentionDays: candleDays,
      governmentId: g.id,
      governmentUsername: g.username,
    });

    revalidatePath("/gov/retention");
    revalidatePath("/gov/archive");
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: v4ErrMsg(e, "Could not update V4 retention periods.") };
  }
}

export async function createArchiveBatchAction(
  _prev: unknown,
  formData: FormData,
): Promise<
  ActionResult<{
    batchId: string;
    batchNumber: string;
    recordCount: number;
    verificationToken: string;
  }>
> {
  let g;
  try {
    g = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = createArchiveBatchSchema.safeParse({
    datasetKey: formData.get("datasetKey"),
    olderThanDays: formData.get("olderThanDays"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid archive parameters." };
  }

  try {
    const batch = await createArchiveBatch({
      govId: g.id,
      govUsername: g.username,
      datasetKey: parsed.data.datasetKey,
      olderThanDays: parsed.data.olderThanDays,
    });

    revalidatePath("/gov/archive");
    return {
      ok: true,
      data: {
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        recordCount: batch.recordCount,
        verificationToken: batch.verificationToken,
      },
    };
  } catch (e) {
    return { ok: false, error: v4ErrMsg(e, "Could not create archive batch.") };
  }
}

export async function verifyArchiveBatchAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = verifyArchiveBatchSchema.safeParse({
    batchId: formData.get("batchId"),
    verificationToken: formData.get("verificationToken"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid verification input." };
  }

  try {
    await verifyArchiveBatch({
      govId: g.id,
      govUsername: g.username,
      batchId: parsed.data.batchId,
      verificationToken: parsed.data.verificationToken,
    });

    revalidatePath("/gov/archive");
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: v4ErrMsg(e, "Archive verification failed.") };
  }
}

export async function clearArchiveBatchAction(
  _prev: unknown,
  formData: FormData,
): Promise<
  ActionResult<{
    clearedCount: number;
    checkpointNumber: string | null;
  }>
> {
  let g;
  try {
    g = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = clearArchiveBatchSchema.safeParse({
    batchId: formData.get("batchId"),
    verificationToken: formData.get("verificationToken"),
    confirmPhrase: formData.get("confirmPhrase"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid clear confirmation." };
  }

  try {
    const res = await clearArchiveBatch({
      govId: g.id,
      govUsername: g.username,
      batchId: parsed.data.batchId,
      verificationToken: parsed.data.verificationToken,
      confirmPhrase: parsed.data.confirmPhrase,
    });

    revalidatePath("/gov/archive");
    revalidatePath("/gov/retention");
    revalidatePath("/gov/transactions");
    revalidatePath("/gov/health");
    revalidatePath("/gov/control-room");
    return {
      ok: true,
      data: {
        clearedCount: res.clearedCount,
        checkpointNumber: res.checkpoint?.checkpointNumber ?? null,
      },
    };
  } catch (e) {
    return { ok: false, error: v4ErrMsg(e, "Could not clear archived records.") };
  }
}
