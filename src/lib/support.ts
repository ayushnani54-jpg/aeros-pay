import "server-only";
import { db } from "@/db/client";
import { supportMessages, supportThreads, users } from "@/db/schema";
import { asc, desc, eq, sql } from "drizzle-orm";
import { notifyUser } from "./notify";
import { isUniqueViolation } from "./db-errors";
import type { SupportMessage, SupportThread } from "@/db/schema";

/**
 * Government support conversations.
 *
 * Exactly one private thread per user. There is deliberately no user-to-user
 * messaging in V2 (spec §32), and a user can only ever read their own thread —
 * enforced by every query here taking the viewer's id, never a thread id
 * supplied by the client.
 */

export class SupportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupportError";
  }
}

/** Fetches the user's thread, creating it on first use. */
export async function getOrCreateThread(userId: string): Promise<SupportThread> {
  const [existing] = await db
    .select()
    .from(supportThreads)
    .where(eq(supportThreads.userId, userId))
    .limit(1);
  if (existing) return existing;

  try {
    const [created] = await db.insert(supportThreads).values({ userId }).returning();
    return created;
  } catch (e) {
    // Lost a race with a concurrent first message — re-read.
    if (isUniqueViolation(e)) {
      const [row] = await db
        .select()
        .from(supportThreads)
        .where(eq(supportThreads.userId, userId))
        .limit(1);
      if (row) return row;
    }
    throw e;
  }
}

export async function postUserMessage(params: {
  userId: string;
  username: string;
  body: string;
}): Promise<SupportMessage> {
  const thread = await getOrCreateThread(params.userId);

  return db.transaction(async (tx) => {
    const [message] = await tx
      .insert(supportMessages)
      .values({
        threadId: thread.id,
        senderType: "USER",
        senderLabel: params.username,
        body: params.body,
      })
      .returning();

    await tx
      .update(supportThreads)
      .set({
        status: "OPEN",
        lastMessageAt: new Date(),
        unreadForGovernment: sql`${supportThreads.unreadForGovernment} + 1`,
      })
      .where(eq(supportThreads.id, thread.id));

    return message;
  });
}

export async function postGovernmentReply(params: {
  threadId: string;
  governmentLabel: string;
  body: string;
}): Promise<SupportMessage> {
  return db.transaction(async (tx) => {
    const [thread] = await tx
      .select()
      .from(supportThreads)
      .where(eq(supportThreads.id, params.threadId))
      .for("update");
    if (!thread) throw new SupportError("Conversation not found.");

    const [message] = await tx
      .insert(supportMessages)
      .values({
        threadId: thread.id,
        senderType: "GOVERNMENT",
        senderLabel: params.governmentLabel,
        body: params.body,
      })
      .returning();

    await tx
      .update(supportThreads)
      .set({
        status: "WAITING",
        lastMessageAt: new Date(),
        unreadForUser: sql`${supportThreads.unreadForUser} + 1`,
        unreadForGovernment: 0,
      })
      .where(eq(supportThreads.id, thread.id));

    await notifyUser(
      tx,
      thread.userId,
      "GOVERNMENT_REPLY",
      "Government replied to your message.",
      "/contact-government",
    );

    return message;
  });
}

export async function setThreadStatus(
  threadId: string,
  status: "OPEN" | "WAITING" | "RESOLVED",
): Promise<void> {
  await db.update(supportThreads).set({ status }).where(eq(supportThreads.id, threadId));
}

export async function markThreadReadByUser(userId: string): Promise<void> {
  await db
    .update(supportThreads)
    .set({ unreadForUser: 0 })
    .where(eq(supportThreads.userId, userId));
}

export async function markThreadReadByGovernment(threadId: string): Promise<void> {
  await db
    .update(supportThreads)
    .set({ unreadForGovernment: 0 })
    .where(eq(supportThreads.id, threadId));
}

export async function getMessagesForThread(threadId: string, limit = 200) {
  return db
    .select()
    .from(supportMessages)
    .where(eq(supportMessages.threadId, threadId))
    .orderBy(asc(supportMessages.createdAt))
    .limit(limit);
}

/** Government support inbox, most recently active first. */
export async function getSupportInbox() {
  return db
    .select({
      thread: supportThreads,
      username: users.username,
      displayName: users.displayName,
      userStatus: users.status,
      lastMessage: sql<string | null>`(
        SELECT body FROM support_messages m
        WHERE m.thread_id = ${supportThreads.id}
        ORDER BY m.created_at DESC LIMIT 1
      )`,
    })
    .from(supportThreads)
    .innerJoin(users, eq(users.id, supportThreads.userId))
    .orderBy(desc(supportThreads.lastMessageAt));
}

export async function getUnreadSupportCountForGovernment(): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${supportThreads.unreadForGovernment}), 0)::int` })
    .from(supportThreads);
  return row?.total ?? 0;
}

export async function getUnreadSupportCountForUser(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: supportThreads.unreadForUser })
    .from(supportThreads)
    .where(eq(supportThreads.userId, userId))
    .limit(1);
  return row?.count ?? 0;
}

export async function getThreadById(threadId: string) {
  const [row] = await db
    .select({
      thread: supportThreads,
      username: users.username,
      displayName: users.displayName,
      userId: users.id,
    })
    .from(supportThreads)
    .innerJoin(users, eq(users.id, supportThreads.userId))
    .where(eq(supportThreads.id, threadId))
    .limit(1);
  return row ?? null;
}
