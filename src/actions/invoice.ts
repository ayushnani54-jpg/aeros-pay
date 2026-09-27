"use server";

import { requireUser } from "@/lib/auth";
import { payInvoice, InvoiceError } from "@/lib/invoices";
import { PaymentError } from "@/lib/payments";
import { invoiceIdSchema } from "@/lib/validators";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "./auth";

export type InvoicePaymentData = {
  txRef: string;
  invoiceNumber: string;
  total: number;
};

/**
 * Pays an invoice from the user's personal wallet.
 *
 * Duplicate submissions are rejected by the guarded status transition inside
 * `payInvoice`, so a double-click cannot pay the same invoice twice.
 */
export async function payInvoiceAction(
  _prev: ActionResult<InvoicePaymentData> | null,
  formData: FormData,
): Promise<ActionResult<InvoicePaymentData>> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = invoiceIdSchema.safeParse({ invoiceId: formData.get("invoiceId") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    const result = await payInvoice({
      invoiceId: parsed.data.invoiceId,
      payerUserId: user.id,
    });

    revalidatePath("/invoices");
    revalidatePath(`/invoices/${parsed.data.invoiceId}`);
    revalidatePath("/dashboard");
    revalidatePath("/transactions");

    return {
      ok: true,
      data: {
        txRef: result.txRef,
        invoiceNumber: result.invoice.invoiceNumber,
        total: result.invoice.total,
      },
    };
  } catch (e) {
    if (e instanceof InvoiceError || e instanceof PaymentError) {
      return { ok: false, error: e.message };
    }
    return { ok: false, error: "The payment could not be completed." };
  }
}
