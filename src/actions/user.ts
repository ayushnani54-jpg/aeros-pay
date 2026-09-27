"use server";

import { requireUser } from "@/lib/auth";
import { sendAeros, PaymentError } from "@/lib/payments";
import { sendAerosSchema, updateDisplayNameSchema } from "@/lib/validators";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "./auth";

type SendAerosData = {
  txRef: string;
  grossAmount: number;
  taxAmount: number;
  netAmount: number;
  receiverUsername: string;
};

export async function sendAerosAction(
  _prev: ActionResult<SendAerosData> | null,
  formData: FormData,
): Promise<ActionResult<SendAerosData>> {
  let sender;
  try {
    sender = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = sendAerosSchema.safeParse({
    recipientUsername: formData.get("recipientUsername"),
    amount: formData.get("amount"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    const result = await sendAeros({
      senderId: sender.id,
      recipientUsername: parsed.data.recipientUsername,
      amount: parsed.data.amount,
    });
    revalidatePath("/dashboard");
    revalidatePath("/transactions");
    return {
      ok: true,
      data: {
        txRef: result.txRef,
        grossAmount: result.grossAmount,
        taxAmount: result.taxAmount,
        netAmount: result.netAmount,
        receiverUsername: result.receiverUsername,
      },
    };
  } catch (e) {
    if (e instanceof PaymentError) {
      return { ok: false, error: e.message };
    }
    return { ok: false, error: "Payment could not be completed." };
  }
}

export async function updateDisplayNameAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = updateDisplayNameSchema.safeParse({
    displayName: formData.get("displayName"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  await db
    .update(users)
    .set({ displayName: parsed.data.displayName })
    .where(eq(users.id, user.id));

  revalidatePath("/profile");
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}
