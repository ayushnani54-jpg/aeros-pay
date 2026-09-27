import "server-only";
import { db } from "@/db/client";
import { notifications, updates, users } from "@/db/schema";
import { eq, ne, and } from "drizzle-orm";
import { effectiveUserStatus } from "./status";

type Executor = Pick<typeof db, "insert" | "select">;

export async function notifyUser(
  executor: Executor,
  userId: string,
  type: string,
  message: string,
  href?: string | null,
) {
  await executor
    .insert(notifications)
    .values({ userId, type, message, href: href ?? null });
}

/**
 * Notifies every user who is not banned. Used for broadcast-style events such
 * as a new issuance request opening for a vote.
 *
 * Suspended users are included deliberately: a suspension pauses a user's
 * ability to spend, it does not cut them out of community announcements, and
 * a timed suspension may well have expired by the time they read it.
 */
export async function notifyAllActiveUsers(
  executor: Executor,
  type: string,
  message: string,
  href?: string | null,
) {
  const rows = await executor
    .select({ id: users.id, status: users.status, suspendedUntil: users.suspendedUntil })
    .from(users)
    .where(ne(users.status, "BANNED"));

  if (rows.length === 0) return;

  await executor.insert(notifications).values(
    rows.map((u) => ({ userId: u.id, type, message, href: href ?? null })),
  );
}

/** Notifies only users who can currently act (used for votes and similar). */
export async function notifyEligibleVoters(
  executor: Executor,
  type: string,
  message: string,
  href?: string | null,
) {
  const rows = await executor
    .select({ id: users.id, status: users.status, suspendedUntil: users.suspendedUntil })
    .from(users)
    .where(ne(users.status, "BANNED"));

  const eligible = rows.filter((u) => effectiveUserStatus(u) === "ACTIVE");
  if (eligible.length === 0) return;

  await executor.insert(notifications).values(
    eligible.map((u) => ({ userId: u.id, type, message, href: href ?? null })),
  );
}

export async function publishUpdate(
  executor: Pick<typeof db, "insert">,
  entry: { title: string; content: string; authorLabel?: string },
) {
  await executor.insert(updates).values({
    title: entry.title,
    content: entry.content,
    authorLabel: entry.authorLabel ?? "Government",
  });
}

export async function markNotificationsRead(userId: string) {
  await db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
}
