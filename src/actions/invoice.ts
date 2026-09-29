"use server";

import { requireActingContext } from "@/lib/auth";
import { payInvoice, InvoiceError, isPaymentInProgress } from "@/lib/invoices";
import { PaymentError } from "@/lib/payments";
import { SettlementRoutingError } from "@/lib/settlement";
import { invoiceIdSchema } from "@/lib/validators";
import { canUserSend } from "@/lib/status";
import {
  consumeRateLimit,
  financialKey,
  rateLimitMessage,
  FINANCIAL_RULE,
} from "@/lib/ratelimit";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "./auth";

export type InvoicePaymentData = {
  /** The real ledger reference — the receipt shows this and nothing else. */
  txRef: string;
  invoiceNumber: string;
  total: number;
  subtotal: number;
  taxAmount: number;
  /** Where the money went. Always the issuing company's wallet. */
  paidToUsername: string;
  /** True when this was a retry of a payment that had already gone through. */
  replayed: boolean;
};

/**
 * Pays an invoice from the wallet the user is currently acting as.
 *
 * WHAT THE CLIENT SUPPLIES: an invoice id. Nothing else. The paying wallet
 * comes from the server-verified acting context, the amount comes from the
 * invoice's frozen snapshot, and the destination is derived from the invoice's
 * issuer by src/lib/settlement.ts — so there is no field here that could
 * redirect a company invoice's settlement or change its tax.
 *
 * IDEMPOTENCY: `payInvoice` derives its own key from (invoice, payer), so a
 * duplicate click, a double submit or a network retry replays the first result
 * instead of paying twice (spec §42). This action never reports success before
 * the server has committed — the UI has no optimistic path at all (§47).
 */
export async function payInvoiceAction(
  _prev: ActionResult<InvoicePaymentData> | null,
  formData: FormData,
): Promise<ActionResult<InvoicePaymentData>> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "Your session has expired. Please sign in again." };
  }

  if (!canUserSend(ctx.user)) {
    return {
      ok: false,
      error:
        ctx.effectiveStatus === "BANNED"
          ? "Your account is banned and cannot pay invoices."
          : "Your account is suspended and cannot pay invoices right now.",
    };
  }

  const rl = consumeRateLimit(financialKey("pay-invoice", ctx.wallet), FINANCIAL_RULE);
  if (!rl.allowed) return { ok: false, error: rateLimitMessage(rl) };

  const parsed = invoiceIdSchema.safeParse({ invoiceId: formData.get("invoiceId") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    const result = await payInvoice({
      invoiceId: parsed.data.invoiceId,
      payer: ctx.wallet,
    });

    revalidatePath("/invoices");
    revalidatePath(`/invoices/${parsed.data.invoiceId}`);
    revalidatePath("/my-company/invoices");
    revalidatePath("/dashboard");
    revalidatePath("/transactions");

    return {
      ok: true,
      data: {
        txRef: result.txRef,
        invoiceNumber: result.invoice.invoiceNumber,
        total: result.invoice.total,
        subtotal: result.invoice.subtotal,
        taxAmount: result.invoice.taxAmount,
        paidToUsername: result.settledTo.companyUsername,
        replayed: result.replayed,
      },
    };
  } catch (e) {
    if (isPaymentInProgress(e)) {
      return {
        ok: false,
        error: "This payment is already being processed. Give it a moment, then refresh.",
      };
    }
    if (
      e instanceof InvoiceError ||
      e instanceof PaymentError ||
      e instanceof SettlementRoutingError
    ) {
      return { ok: false, error: e.message };
    }
    return { ok: false, error: "The payment could not be completed." };
  }
}
