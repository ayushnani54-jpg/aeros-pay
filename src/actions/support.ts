"use server";

import { requireUser, requireGovernment, getCurrentUser } from "@/lib/auth";
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
  supportRequestSchema,
} from "@/lib/validators";
import { submitSupportRequest } from "@/lib/support-web3forms";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "./auth";
import { headers } from "next/headers";

function firstZodError(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    "issues" in err &&
    Array.isArray((err as { issues: unknown[] }).issues)
  ) {
    const issues = (err as { issues: { message: string }[] }).issues;
    return issues[0]?.message ?? "Invalid input.";
  }
  return "Invalid input.";
}

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

// ---------------------------------------------------------------------------
// V6 In-App Support Desk & Web3Forms Priority Submission
// ---------------------------------------------------------------------------

export async function submitSupportAction(
  _prev: ActionResult<{ ticketNumber: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ ticketNumber: string }>> {
  const user = await getCurrentUser();
  const headerList = await headers();
  const userAgent = headerList.get("user-agent") || null;
  const ipAddress = headerList.get("x-forwarded-for") || headerList.get("x-real-ip") || null;

  // If logged in, preferred email is authEmail or publicContactEmail if supplied
  const emailInput = formData.get("email") || user?.authEmail || user?.publicContactEmail || "";

  const parsed = supportRequestSchema.safeParse({
    email: emailInput,
    category: formData.get("category"),
    severity: formData.get("severity") || "NORMAL",
    subject: formData.get("subject"),
    description: formData.get("description"),
    relevantModule: formData.get("relevantModule") || undefined,
    stepsToReproduce: formData.get("stepsToReproduce") || undefined,
    expectedBehaviour: formData.get("expectedBehaviour") || undefined,
    actualBehaviour: formData.get("actualBehaviour") || undefined,
    botcheck: formData.get("botcheck") || undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: firstZodError(parsed.error) };
  }

  try {
    const result = await submitSupportRequest({
      userId: user?.id ?? null,
      username: user?.username ?? null,
      email: parsed.data.email,
      category: parsed.data.category,
      severity: parsed.data.severity,
      subject: parsed.data.subject,
      description: parsed.data.description,
      relevantModule: parsed.data.relevantModule ?? null,
      stepsToReproduce: parsed.data.stepsToReproduce ?? null,
      expectedBehaviour: parsed.data.expectedBehaviour ?? null,
      actualBehaviour: parsed.data.actualBehaviour ?? null,
      userAgent,
      ipAddress,
      botcheck: parsed.data.botcheck ?? null,
    });

    return {
      ok: true,
      data: { ticketNumber: result.ticketNumber },
      message: result.message,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to submit support request.",
    };
  }
}
