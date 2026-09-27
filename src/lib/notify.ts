import "server-only";
import { db } from "@/db/client";
import { notifications, updates, users } from "@/db/schema";
import { eq } from "drizzle-orm";

type Executor = Pick<typeof db, "insert" | "select">;

export async function notifyUser(
  executor: Executor,
  userId: string,
  type: string,
  message: string,
) {
  await executor.insert(notifications).values({ userId, type, message });
}

/** Notifies every user except those explicitly excluded (e.g. none). Used for
 * broadcast-style events such as a new issuance request opening for a vote. */
export async function notifyAllActiveUsers(
  executor: Executor,
  type: string,
  message: string,
) {
  const activeUsers = await executor
    .select({ id: users.id })
    .from(users)
    .where(eq(users.status, "ACTIVE"));

  if (activeUsers.length === 0) return;

  await executor.insert(notifications).values(
    activeUsers.map((u: { id: string }) => ({ userId: u.id, type, message })),
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
