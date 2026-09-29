"use server";

import { revalidatePath } from "next/cache";
import { requireActingContext } from "@/lib/auth";
import { requireOwnedCompany, CompanyError } from "@/lib/companies";
import {
  acceptOrder,
  cancelOrder,
  completeOrder,
  createOffer,
  issueInvoiceForOrder,
  MarketplaceError,
  placeOrder,
  requestOrderInvoice,
  setOfferStatus,
  updateOffer,
} from "@/lib/marketplace";
import {
  closeWantedRequest,
  createWantedRequest,
  decideWantedResponse,
  respondToWantedRequest,
  withdrawWantedResponse,
  WantedError,
} from "@/lib/wanted";
import {
  applyForContract,
  awardContract,
  cancelContract,
  ContractError,
  createContract,
  issueContractInvoice,
  isContractPaymentInProgress,
  payAwardedContractToUser,
  withdrawContractApplication,
} from "@/lib/contracts";
import {
  activatePromotion,
  cancelPromotion,
  pausePromotion,
  PromotionError,
  requestPromotion,
} from "@/lib/promotions";
import { reverseTransaction, ReversalError } from "@/lib/reversals";
import { rateOrder, RatingError } from "@/lib/ratings";
import { InvoiceError, isPaymentInProgress } from "@/lib/invoices";
import { PaymentError } from "@/lib/payments";
import { SettlementRoutingError } from "@/lib/settlement";
import { canUserSend } from "@/lib/status";
import {
  consumeRateLimit,
  financialKey,
  rateLimitMessage,
  FINANCIAL_RULE,
} from "@/lib/ratelimit";
import {
  closeWantedSchema,
  contractApplicationSchema,
  contractAwardSchema,
  contractIdSchema,
  contractInvoiceSchema,
  contractSchema,
  editOfferSchema,
  issueOrderInvoiceSchema,
  offerSchema,
  offerStatusSchema,
  orderActionSchema,
  orderIdSchema,
  placeOrderSchema,
  promotionIdSchema,
  promotionRequestSchema,
  rateOrderSchema,
  reverseTransactionSchema,
  wantedDecisionSchema,
  wantedResponseSchema,
  wantedSchema,
} from "@/lib/validators";
import type { ActionResult } from "./auth";

/**
 * MARKETPLACE SERVER ACTIONS (V3 Phases C, D, E)
 * ===========================================================================
 *
 * Every action here follows the same three rules as the rest of the app:
 *
 *  1. The ACTING WALLET comes from `requireActingContext`, which re-reads the
 *     session and re-verifies company ownership on every call. The
 *     wallet-context cookie is only ever a hint.
 *  2. NOTHING FINANCIAL IS TAKEN FROM THE CLIENT. No amount, no rate, no
 *     destination and no wallet id is read from a form. Prices come from the
 *     offer row, totals from the invoice snapshot, the destination from
 *     src/lib/settlement.ts.
 *  3. The action VALIDATES and DELEGATES. Every rule that matters lives in the
 *     library, inside a transaction, so it holds however the function is
 *     reached.
 *
 * This file is a `"use server"` module, so every export is an async function —
 * a non-function export here crashes the build.
 */

function errMsg(e: unknown, fallback: string): string {
  if (
    e instanceof MarketplaceError ||
    e instanceof WantedError ||
    e instanceof ContractError ||
    e instanceof PromotionError ||
    e instanceof ReversalError ||
    e instanceof RatingError ||
    e instanceof InvoiceError ||
    e instanceof PaymentError ||
    e instanceof SettlementRoutingError ||
    e instanceof CompanyError
  ) {
    return e.message;
  }
  return fallback;
}

/** Parses a `<input type="date">` value into an end-of-day Date, or null. */
function parseDueDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value}T23:59:59`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function refreshMarket() {
  revalidatePath("/market");
  revalidatePath("/market/orders");
  revalidatePath("/my-company/offers");
  revalidatePath("/my-company/orders");
}

// ===========================================================================
// Offers
// ===========================================================================

export async function createOfferAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!ctx.company) {
    return { ok: false, error: "Switch to your company wallet to create a listing." };
  }

  const parsed = offerSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description"),
    category: formData.get("category"),
    unitPrice: formData.get("unitPrice"),
    quantityAvailable: formData.get("quantityAvailable") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    const company = await requireOwnedCompany(ctx.user.id, ctx.company.id);
    await createOffer({ company, input: parsed.data });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not create that listing.") };
  }

  refreshMarket();
  return { ok: true, data: undefined };
}

export async function updateOfferAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!ctx.company) return { ok: false, error: "Switch to your company wallet first." };

  const parsed = editOfferSchema.safeParse({
    offerId: formData.get("offerId"),
    title: formData.get("title"),
    description: formData.get("description"),
    category: formData.get("category"),
    unitPrice: formData.get("unitPrice"),
    quantityAvailable: formData.get("quantityAvailable") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    const company = await requireOwnedCompany(ctx.user.id, ctx.company.id);
    const { offerId, ...input } = parsed.data;
    await updateOffer({ offerId, companyId: company.id, input });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not update that listing.") };
  }

  refreshMarket();
  return { ok: true, data: undefined };
}

export async function setOfferStatusAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!ctx.company) return { ok: false, error: "Switch to your company wallet first." };

  const parsed = offerStatusSchema.safeParse({
    offerId: formData.get("offerId"),
    status: formData.get("status"),
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    const company = await requireOwnedCompany(ctx.user.id, ctx.company.id);
    await setOfferStatus({
      offerId: parsed.data.offerId,
      companyId: company.id,
      status: parsed.data.status,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not change that listing.") };
  }

  refreshMarket();
  return { ok: true, data: undefined };
}

// ===========================================================================
// Orders
// ===========================================================================

export type PlacedOrderData = { orderId: string; orderNumber: string; subtotal: number };

/**
 * Places an order.
 *
 * The client supplies an offer id and a quantity. The PRICE is read from the
 * offer row inside the transaction and snapshot onto the order, so the
 * subtotal shown afterwards is the server's arithmetic and nobody else's.
 */
export async function placeOrderAction(
  _prev: ActionResult<PlacedOrderData> | null,
  formData: FormData,
): Promise<ActionResult<PlacedOrderData>> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!canUserSend(ctx.user)) {
    return {
      ok: false,
      error:
        ctx.effectiveStatus === "BANNED"
          ? "Your account is banned and cannot place orders."
          : "Your account is suspended and cannot place orders right now.",
    };
  }

  const rl = consumeRateLimit(financialKey("place-order", ctx.wallet), FINANCIAL_RULE);
  if (!rl.allowed) return { ok: false, error: rateLimitMessage(rl) };

  const parsed = placeOrderSchema.safeParse({
    offerId: formData.get("offerId"),
    quantity: formData.get("quantity"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    const order = await placeOrder({
      offerId: parsed.data.offerId,
      buyer: ctx.wallet,
      quantity: parsed.data.quantity,
    });
    refreshMarket();
    revalidatePath(`/market/offers/${parsed.data.offerId}`);
    return {
      ok: true,
      data: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        subtotal: order.subtotal,
      },
    };
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not place that order.") };
  }
}

export async function acceptOrderAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!ctx.company) {
    return { ok: false, error: "Switch to your company wallet to manage orders." };
  }

  const parsed = orderIdSchema.safeParse({ orderId: formData.get("orderId") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    const company = await requireOwnedCompany(ctx.user.id, ctx.company.id);
    await acceptOrder({ orderId: parsed.data.orderId, sellerCompanyId: company.id });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not accept that order.") };
  }

  refreshMarket();
  revalidatePath(`/market/orders/${parsed.data.orderId}`);
  return { ok: true, data: undefined };
}

export async function requestOrderInvoiceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = orderIdSchema.safeParse({ orderId: formData.get("orderId") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    await requestOrderInvoice({ orderId: parsed.data.orderId, buyer: ctx.wallet });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not ask for the invoice.") };
  }

  refreshMarket();
  revalidatePath(`/market/orders/${parsed.data.orderId}`);
  return { ok: true, data: undefined };
}

export type OrderInvoiceData = { invoiceId: string; invoiceNumber: string; total: number };

/**
 * The seller raises the order's invoice.
 *
 * Amounts are not in the form: quantity and unit price come from the order's
 * own snapshot and tax is added by the Phase B engine. The only optional input
 * is a due date.
 */
export async function issueOrderInvoiceAction(
  _prev: ActionResult<OrderInvoiceData> | null,
  formData: FormData,
): Promise<ActionResult<OrderInvoiceData>> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!ctx.company) {
    return { ok: false, error: "Switch to your company wallet to issue the invoice." };
  }

  const parsed = issueOrderInvoiceSchema.safeParse({
    orderId: formData.get("orderId"),
    dueDate: formData.get("dueDate") ?? "",
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    const company = await requireOwnedCompany(ctx.user.id, ctx.company.id);
    const { invoice } = await issueInvoiceForOrder({
      orderId: parsed.data.orderId,
      sellerCompanyId: company.id,
      dueAt: parseDueDate(parsed.data.dueDate),
    });

    refreshMarket();
    revalidatePath("/my-company/invoices");
    revalidatePath("/invoices");
    revalidatePath(`/market/orders/${parsed.data.orderId}`);

    return {
      ok: true,
      data: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        total: invoice.total,
      },
    };
  } catch (e) {
    if (isPaymentInProgress(e)) {
      return { ok: false, error: "That order is being settled right now. Refresh in a moment." };
    }
    return { ok: false, error: errMsg(e, "Could not raise the invoice.") };
  }
}

export async function completeOrderAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = orderIdSchema.safeParse({ orderId: formData.get("orderId") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    await completeOrder({ orderId: parsed.data.orderId, actor: ctx.wallet });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not complete that order.") };
  }

  refreshMarket();
  revalidatePath(`/market/orders/${parsed.data.orderId}`);
  return { ok: true, data: undefined };
}

export async function cancelOrderAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = orderActionSchema.safeParse({
    orderId: formData.get("orderId"),
    reason: formData.get("reason") ?? "",
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    await cancelOrder({
      orderId: parsed.data.orderId,
      actor: ctx.wallet,
      reason: parsed.data.reason || null,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not cancel that order.") };
  }

  refreshMarket();
  revalidatePath(`/market/orders/${parsed.data.orderId}`);
  revalidatePath("/invoices");
  return { ok: true, data: undefined };
}

// ===========================================================================
// Refunds (company side — the Government's version lives in actions/government)
// ===========================================================================

export type RefundData = {
  reversalTxRef: string;
  originalTxRef: string;
  refundedToPayer: number;
};

/**
 * A company refunds a payment it received.
 *
 * The original ledger row is never edited: the library writes a new reversal
 * row linked to it. The amount is either the whole payment or a capped partial
 * correction, and the library derives both from the original row.
 */
export async function refundPaymentAction(
  _prev: ActionResult<RefundData> | null,
  formData: FormData,
): Promise<ActionResult<RefundData>> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!ctx.company) {
    return { ok: false, error: "Switch to your company wallet to issue a refund." };
  }

  const rl = consumeRateLimit(financialKey("refund", ctx.wallet), FINANCIAL_RULE);
  if (!rl.allowed) return { ok: false, error: rateLimitMessage(rl) };

  const parsed = reverseTransactionSchema.safeParse({
    transactionId: formData.get("transactionId"),
    reason: formData.get("reason"),
    amount: formData.get("amount") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    const company = await requireOwnedCompany(ctx.user.id, ctx.company.id);
    const result = await reverseTransaction({
      transactionId: parsed.data.transactionId,
      actor: { type: "COMPANY", id: company.id, label: company.name },
      reason: parsed.data.reason,
      amount: parsed.data.amount,
    });

    refreshMarket();
    revalidatePath("/transactions");
    revalidatePath("/my-company");
    revalidatePath("/invoices");

    return {
      ok: true,
      data: {
        reversalTxRef: result.reversalTxRef,
        originalTxRef: result.originalTxRef,
        refundedToPayer: result.refundedToPayer,
      },
    };
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not issue that refund.") };
  }
}

// ===========================================================================
// Wanted requests
// ===========================================================================

export async function createWantedAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = wantedSchema.safeParse({
    heading: formData.get("heading"),
    description: formData.get("description"),
    category: formData.get("category"),
    quantity: formData.get("quantity"),
    budget: formData.get("budget"),
    deadline: formData.get("deadline") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    await createWantedRequest({
      requester: ctx.wallet,
      input: {
        heading: parsed.data.heading,
        description: parsed.data.description,
        category: parsed.data.category,
        quantity: parsed.data.quantity,
        budget: parsed.data.budget,
        deadline: parseDueDate(parsed.data.deadline),
      },
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not post that request.") };
  }

  revalidatePath("/market/wanted");
  return { ok: true, data: undefined };
}

export async function respondToWantedAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = wantedResponseSchema.safeParse({
    requestId: formData.get("requestId"),
    message: formData.get("message"),
    offeredPrice: formData.get("offeredPrice") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    await respondToWantedRequest({
      requestId: parsed.data.requestId,
      responder: ctx.wallet,
      message: parsed.data.message,
      offeredPrice: parsed.data.offeredPrice,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not send that reply.") };
  }

  revalidatePath("/market/wanted");
  revalidatePath(`/market/wanted/${parsed.data.requestId}`);
  return { ok: true, data: undefined };
}

export async function decideWantedResponseAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = wantedDecisionSchema.safeParse({
    responseId: formData.get("responseId"),
    decision: formData.get("decision"),
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    await decideWantedResponse({
      responseId: parsed.data.responseId,
      requester: ctx.wallet,
      decision: parsed.data.decision,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not record that decision.") };
  }

  revalidatePath("/market/wanted");
  return { ok: true, data: undefined };
}

export async function withdrawWantedResponseAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const responseId = formData.get("responseId");
  if (typeof responseId !== "string") return { ok: false, error: "Invalid request." };

  try {
    await withdrawWantedResponse({ responseId, responder: ctx.wallet });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not withdraw that reply.") };
  }

  revalidatePath("/market/wanted");
  return { ok: true, data: undefined };
}

export async function closeWantedAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = closeWantedSchema.safeParse({
    requestId: formData.get("requestId"),
    status: formData.get("status"),
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    await closeWantedRequest({
      requestId: parsed.data.requestId,
      requester: ctx.wallet,
      status: parsed.data.status,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not close that request.") };
  }

  revalidatePath("/market/wanted");
  revalidatePath(`/market/wanted/${parsed.data.requestId}`);
  return { ok: true, data: undefined };
}

// ===========================================================================
// Contracts (company side)
// ===========================================================================

export async function createContractAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!ctx.company) {
    return { ok: false, error: "Switch to your company wallet to issue a contract." };
  }

  const parsed = contractSchema.safeParse({
    title: formData.get("title"),
    requirement: formData.get("requirement"),
    description: formData.get("description"),
    conditions: formData.get("conditions") ?? "",
    budget: formData.get("budget"),
    deadline: formData.get("deadline") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    const company = await requireOwnedCompany(ctx.user.id, ctx.company.id);
    await createContract({
      issuer: { type: "COMPANY", companyId: company.id },
      input: {
        title: parsed.data.title,
        requirement: parsed.data.requirement,
        description: parsed.data.description,
        conditions: parsed.data.conditions || null,
        budget: parsed.data.budget,
        deadline: parseDueDate(parsed.data.deadline),
      },
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not create that contract.") };
  }

  revalidatePath("/market/contracts");
  return { ok: true, data: undefined };
}

export async function applyForContractAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = contractApplicationSchema.safeParse({
    contractId: formData.get("contractId"),
    proposal: formData.get("proposal"),
    quotedPrice: formData.get("quotedPrice") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    await applyForContract({
      contractId: parsed.data.contractId,
      applicant: ctx.wallet,
      proposal: parsed.data.proposal,
      quotedPrice: parsed.data.quotedPrice,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not send that application.") };
  }

  revalidatePath("/market/contracts");
  revalidatePath(`/market/contracts/${parsed.data.contractId}`);
  return { ok: true, data: undefined };
}

export async function withdrawContractApplicationAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const applicationId = formData.get("applicationId");
  if (typeof applicationId !== "string") return { ok: false, error: "Invalid request." };

  try {
    await withdrawContractApplication({ applicationId, applicant: ctx.wallet });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not withdraw that application.") };
  }

  revalidatePath("/market/contracts");
  return { ok: true, data: undefined };
}

export async function awardContractAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!ctx.company) {
    return { ok: false, error: "Switch to your company wallet to award this contract." };
  }

  const parsed = contractAwardSchema.safeParse({
    contractId: formData.get("contractId"),
    applicationId: formData.get("applicationId"),
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    const company = await requireOwnedCompany(ctx.user.id, ctx.company.id);
    await awardContract({
      contractId: parsed.data.contractId,
      applicationId: parsed.data.applicationId,
      actor: { type: "COMPANY", companyId: company.id },
      actorLabel: company.name,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not award that contract.") };
  }

  revalidatePath("/market/contracts");
  revalidatePath(`/market/contracts/${parsed.data.contractId}`);
  return { ok: true, data: undefined };
}

export async function cancelContractAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!ctx.company) return { ok: false, error: "Switch to your company wallet first." };

  const parsed = contractIdSchema.safeParse({ contractId: formData.get("contractId") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    const company = await requireOwnedCompany(ctx.user.id, ctx.company.id);
    await cancelContract({
      contractId: parsed.data.contractId,
      actor: { type: "COMPANY", companyId: company.id },
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not cancel that contract.") };
  }

  revalidatePath("/market/contracts");
  return { ok: true, data: undefined };
}

/** The awarded company raises the contract's invoice on its issuer. */
export async function issueContractInvoiceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!ctx.company) {
    return { ok: false, error: "Switch to the awarded company to raise its invoice." };
  }

  const parsed = contractInvoiceSchema.safeParse({
    contractId: formData.get("contractId"),
    dueDate: formData.get("dueDate") ?? "",
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    const company = await requireOwnedCompany(ctx.user.id, ctx.company.id);
    await issueContractInvoice({
      contractId: parsed.data.contractId,
      payeeCompanyId: company.id,
      dueAt: parseDueDate(parsed.data.dueDate),
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not raise that invoice.") };
  }

  revalidatePath("/market/contracts");
  revalidatePath(`/market/contracts/${parsed.data.contractId}`);
  revalidatePath("/my-company/invoices");
  revalidatePath("/invoices");
  return { ok: true, data: undefined };
}

export type ContractPaymentData = { txRef: string; amount: number; replayed: boolean };

/** The issuing COMPANY pays a contract awarded to a person. */
export async function payContractToUserAction(
  _prev: ActionResult<ContractPaymentData> | null,
  formData: FormData,
): Promise<ActionResult<ContractPaymentData>> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!ctx.company) {
    return { ok: false, error: "Switch to your company wallet to pay this contract." };
  }
  if (!canUserSend(ctx.user)) {
    return { ok: false, error: "Your account cannot make payments right now." };
  }

  const rl = consumeRateLimit(financialKey("pay-contract", ctx.wallet), FINANCIAL_RULE);
  if (!rl.allowed) return { ok: false, error: rateLimitMessage(rl) };

  const parsed = contractIdSchema.safeParse({ contractId: formData.get("contractId") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    const company = await requireOwnedCompany(ctx.user.id, ctx.company.id);
    const result = await payAwardedContractToUser({
      contractId: parsed.data.contractId,
      actor: { type: "COMPANY", companyId: company.id, label: company.name },
    });

    revalidatePath("/market/contracts");
    revalidatePath(`/market/contracts/${parsed.data.contractId}`);
    revalidatePath("/transactions");
    revalidatePath("/my-company");

    return {
      ok: true,
      data: { txRef: result.txRef, amount: result.amount, replayed: result.replayed },
    };
  } catch (e) {
    if (isContractPaymentInProgress(e)) {
      return { ok: false, error: "This payment is already being processed. Refresh in a moment." };
    }
    return { ok: false, error: errMsg(e, "Could not pay that contract.") };
  }
}

// ===========================================================================
// Promotions (company side)
// ===========================================================================

export async function requestPromotionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!ctx.company) {
    return { ok: false, error: "Switch to your company wallet to request a promotion." };
  }

  const parsed = promotionRequestSchema.safeParse({
    offerId: formData.get("offerId"),
    heading: formData.get("heading"),
    shortDescription: formData.get("shortDescription"),
    ctaLabel: formData.get("ctaLabel") ?? "",
    requestedDurationDays: formData.get("requestedDurationDays"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    const company = await requireOwnedCompany(ctx.user.id, ctx.company.id);
    await requestPromotion({
      company,
      input: {
        offerId: parsed.data.offerId,
        heading: parsed.data.heading,
        shortDescription: parsed.data.shortDescription,
        ctaLabel: parsed.data.ctaLabel || "View offer",
        requestedDurationDays: parsed.data.requestedDurationDays,
      },
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not request that promotion.") };
  }

  revalidatePath("/my-company/promotions");
  revalidatePath("/gov/promotions");
  return { ok: true, data: undefined };
}

export async function activatePromotionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!ctx.company) return { ok: false, error: "Switch to your company wallet first." };

  const parsed = promotionIdSchema.safeParse({ campaignId: formData.get("campaignId") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    const company = await requireOwnedCompany(ctx.user.id, ctx.company.id);
    await activatePromotion({ campaignId: parsed.data.campaignId, companyId: company.id });
  } catch (e) {
    // A taken slot is an ordinary outcome, and the library reports it as one.
    return { ok: false, error: errMsg(e, "Could not start that promotion.") };
  }

  revalidatePath("/my-company/promotions");
  revalidatePath("/dashboard");
  revalidatePath("/market");
  return { ok: true, data: undefined };
}

export async function pausePromotionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!ctx.company) return { ok: false, error: "Switch to your company wallet first." };

  const parsed = promotionIdSchema.safeParse({ campaignId: formData.get("campaignId") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    const company = await requireOwnedCompany(ctx.user.id, ctx.company.id);
    await pausePromotion({ campaignId: parsed.data.campaignId, companyId: company.id });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not pause that promotion.") };
  }

  revalidatePath("/my-company/promotions");
  revalidatePath("/dashboard");
  revalidatePath("/market");
  return { ok: true, data: undefined };
}

export async function cancelPromotionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!ctx.company) return { ok: false, error: "Switch to your company wallet first." };

  const parsed = promotionIdSchema.safeParse({ campaignId: formData.get("campaignId") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    const company = await requireOwnedCompany(ctx.user.id, ctx.company.id);
    await cancelPromotion({ campaignId: parsed.data.campaignId, companyId: company.id });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not cancel that promotion.") };
  }

  revalidatePath("/my-company/promotions");
  revalidatePath("/dashboard");
  revalidatePath("/market");
  return { ok: true, data: undefined };
}

// ===========================================================================
// Ratings (V3 Phase F, spec §22)
// ===========================================================================

/**
 * Rates a completed order.
 *
 * Notice what this action does NOT take from the form: no company, no seller,
 * no rater, no order total. Just the order id, the stars and the comment. Who
 * is rating comes from `requireActingContext()` (the session, re-read and
 * re-verified on every call) and WHO IS RATED comes from the order row's own
 * seller column inside `rateOrder`'s transaction. Eligibility — buyer only,
 * completed only, paid only, once only — is re-derived there under a row lock,
 * so this action being reachable proves nothing about the rating being allowed.
 */
export async function rateOrderAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = rateOrderSchema.safeParse({
    orderId: formData.get("orderId"),
    stars: formData.get("stars"),
    comment: formData.get("comment") ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request." };
  }

  try {
    await rateOrder({
      orderId: parsed.data.orderId,
      actor: ctx.wallet,
      stars: parsed.data.stars,
      comment: parsed.data.comment || null,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not save that rating.") };
  }

  revalidatePath(`/market/orders/${parsed.data.orderId}`);
  refreshMarket();
  // The aggregate on the seller's public profile and the leaderboard both read
  // live, so they only need the cached page dropped.
  revalidatePath("/market/leaderboard");
  revalidatePath("/companies");
  return { ok: true, data: undefined };
}
