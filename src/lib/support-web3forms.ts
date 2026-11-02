import "server-only";
import { db, ensureV5SchemaMigrated } from "@/db/client";
import { supportRequests } from "@/db/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";

const WEB3FORMS_ACCESS_KEY = "7e4e8509-dade-44e5-b3b3-62fbc0ad4796";
const WEB3FORMS_ENDPOINT = "https://api.web3forms.com/submit";

export interface CreateSupportRequestInput {
  userId?: string | null;
  username?: string | null;
  email: string;
  category: "GENERAL" | "BUG_REPORT" | "TECHNICAL" | "ACCOUNT_ACCESS" | "FEATURE_REQUEST" | "FEEDBACK" | "OTHER";
  severity?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  subject: string;
  description: string;
  relevantModule?: string | null;
  stepsToReproduce?: string | null;
  expectedBehaviour?: string | null;
  actualBehaviour?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
  botcheck?: string | null; // Honeypot field
}

export function generateSupportTicketNumber(): string {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randomHex = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `SUP-${dateStr}-${randomHex}`;
}

export async function submitSupportRequest(input: CreateSupportRequestInput): Promise<{
  ticketNumber: string;
  delivered: boolean;
  message: string;
}> {
  // 1. Anti-spam honeypot detection
  if (input.botcheck && input.botcheck.trim().length > 0) {
    console.warn("[support] Honeypot triggered, silently accepting without dispatch.");
    return {
      ticketNumber: generateSupportTicketNumber(),
      delivered: true,
      message: "Your support request has been received.",
    };
  }

  await ensureV5SchemaMigrated();
  const ticketNumber = generateSupportTicketNumber();
  const severity = input.severity ?? "NORMAL";

  // 2. Insert into Neon outbox first (guarantees zero message loss)
  await db
    .insert(supportRequests)
    .values({
      ticketNumber,
      userId: input.userId ?? null,
      username: input.username ?? null,
      email: input.email.trim().toLowerCase(),
      category: input.category,
      severity,
      subject: input.subject.trim(),
      description: input.description.trim(),
      relevantModule: input.relevantModule ?? null,
      stepsToReproduce: input.stepsToReproduce ?? null,
      expectedBehaviour: input.expectedBehaviour ?? null,
      actualBehaviour: input.actualBehaviour ?? null,
      deliveryStatus: "PENDING",
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
      createdAt: new Date(),
    })
    .returning();

  // 3. Dispatch to Web3Forms API
  let delivered = false;
  let web3formsMessageId: string | null = null;
  let deliveryError: string | null = null;

  try {
    const payload = {
      access_key: WEB3FORMS_ACCESS_KEY,
      subject: `[Aeros Pay Support] [${input.category}] [${severity}] ${input.subject}`,
      from_name: input.username ? `${input.username} (Aeros Citizen)` : "Aeros Pay Citizen",
      email: input.email.trim().toLowerCase(),
      reply_to: input.email.trim().toLowerCase(),
      message: `
TICKET NUMBER: ${ticketNumber}
USER: ${input.username ?? "Unauthenticated"} (ID: ${input.userId ?? "N/A"})
VERIFIED EMAIL: ${input.email}
CATEGORY: ${input.category}
SEVERITY: ${severity}
MODULE: ${input.relevantModule ?? "None specified"}

SUBJECT:
${input.subject}

DESCRIPTION:
${input.description}

${input.stepsToReproduce ? `STEPS TO REPRODUCE:\n${input.stepsToReproduce}\n` : ""}
${input.expectedBehaviour ? `EXPECTED BEHAVIOUR:\n${input.expectedBehaviour}\n` : ""}
${input.actualBehaviour ? `ACTUAL BEHAVIOUR:\n${input.actualBehaviour}\n` : ""}
--------------------------------------------------
System Timestamp: ${new Date().toISOString()}
User Agent: ${input.userAgent ?? "Not supplied"}
      `.trim(),
    };

    const res = await fetch(WEB3FORMS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const resJson = await res.json().catch(() => null);

    if (res.ok && resJson && resJson.success) {
      delivered = true;
      web3formsMessageId = resJson.message ?? "OK";
    } else {
      deliveryError = resJson?.message || `HTTP ${res.status}: ${res.statusText}`;
    }
  } catch (err: unknown) {
    deliveryError = err instanceof Error ? err.message : "Network fetch failed";
    console.error("[support-web3forms] Error dispatching to Web3Forms:", err);
  }

  // 4. Update status in Neon
  await db
    .update(supportRequests)
    .set({
      deliveryStatus: delivered ? "DELIVERED" : "STORED_LOCALLY",
      web3formsMessageId,
      deliveryError,
      retryCount: delivered ? 0 : 1,
    })
    .where(eq(supportRequests.ticketNumber, ticketNumber))
    .catch((dbErr) => {
      console.warn("[support] Error updating delivery status in db:", dbErr);
    });

  return {
    ticketNumber,
    delivered,
    message: delivered
      ? `Support ticket ${ticketNumber} submitted successfully. Our team will review and reply via ${input.email}.`
      : `Support ticket ${ticketNumber} has been logged in our internal system. We will contact you via ${input.email}.`,
  };
}
