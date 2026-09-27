"use server";

import { requireUser, requireGovernment } from "@/lib/auth";
import {
  getOrCreateThread,
  markThreadReadByGovernment,
  markThreadReadByUser,
  postGovernmentReply,
  postUserMessage,
  setThreadStatus,
  SupportError,
} from "@/lib/support";
import {
  supportMessageSchema,
  supportReplySchema,
  supportStatusSchema,
} from "@/lib/validators";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "./auth";

/** A user writes to the Government. Each user has exactly one private thread. */
export async function sendSupportMessageAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = supportMessageSchema.safeParse({ body: formData.get("body") });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    await postUserMessage({
      userId: user.id,
      username: user.username,
      body: parsed.data.body,
    });
  } catch (e) {
    if (e instanceof SupportError) return { ok: false, error: e.message };
    return { ok: false, error: "Your message could not be sent." };
  }

  revalidatePath("/contact-government");
  revalidatePath("/gov/support");
  return { ok: true, data: undefined };
}

export async function markSupportReadAction(): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  await getOrCreateThread(user.id);
  await markThreadReadByUser(user.id);
  revalidatePath("/contact-government");
  return { ok: true, data: undefined };
}

/** Government replies in a user's thread. */
export async function replyToSupportAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let gov;
  try {
    gov = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = supportReplySchema.safeParse({
    threadId: formData.get("threadId"),
    body: formData.get("body"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    await postGovernmentReply({
      threadId: parsed.data.threadId,
      governmentLabel: gov.username,
      body: parsed.data.body,
    });
  } catch (e) {
    if (e instanceof SupportError) return { ok: false, error: e.message };
    return { ok: false, error: "The reply could not be sent." };
  }

  revalidatePath("/gov/support");
  revalidatePath(`/gov/support/${parsed.data.threadId}`);
  revalidatePath("/contact-government");
  return { ok: true, data: undefined };
}

export async function setSupportStatusAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = supportStatusSchema.safeParse({
    threadId: formData.get("threadId"),
    status: formData.get("status"),
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  await setThreadStatus(parsed.data.threadId, parsed.data.status);
  revalidatePath("/gov/support");
  revalidatePath(`/gov/support/${parsed.data.threadId}`);
  return { ok: true, data: undefined };
}

export async function markSupportReadByGovernmentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const threadId = String(formData.get("threadId") ?? "");
  if (!threadId) return { ok: false, error: "Invalid request." };

  await markThreadReadByGovernment(threadId);
  revalidatePath("/gov/support");
  return { ok: true, data: undefined };
}
