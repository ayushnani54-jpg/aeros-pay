import "server-only";
import { db } from "@/db/client";
import {
  auditLogs,
  government,
  issuanceEligibleVoters,
  issuanceRequests,
  issuanceVotes,
  notifications,
  registrationCodes,
  transactions,
  updates,
  users,
} from "@/db/schema";
import { and, desc, eq, or, sql } from "drizzle-orm";

export async function getRecentTransactionsForUser(userId: string, limit = 20) {
  return db
    .select()
    .from(transactions)
    .where(or(eq(transactions.senderId, userId), eq(transactions.receiverId, userId)))
    .orderBy(desc(transactions.createdAt))
    .limit(limit);
}

export async function getUnreadNotificationCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
  return row?.count ?? 0;
}

export async function getNotificationsForUser(userId: string, limit = 50) {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export async function getAllUpdates(limit = 100) {
  return db.select().from(updates).orderBy(desc(updates.createdAt)).limit(limit);
}

export async function getOpenIssuanceRequestsForUser(userId: string) {
  const rows = await db
    .select({
      request: issuanceRequests,
      myVote: issuanceVotes.vote,
    })
    .from(issuanceEligibleVoters)
    .innerJoin(issuanceRequests, eq(issuanceRequests.id, issuanceEligibleVoters.requestId))
    .leftJoin(
      issuanceVotes,
      and(eq(issuanceVotes.requestId, issuanceRequests.id), eq(issuanceVotes.userId, userId)),
    )
    .where(and(eq(issuanceEligibleVoters.userId, userId), eq(issuanceRequests.status, "OPEN")))
    .orderBy(desc(issuanceRequests.createdAt));
  return rows;
}

// ---------------------------------------------------------------------------
// Government dashboard queries
// ---------------------------------------------------------------------------

export async function getGovernmentSingleton() {
  const [gov] = await db.select().from(government).limit(1);
  return gov ?? null;
}

export async function getUserCounts() {
  const rows = await db
    .select({ status: users.status, count: sql<number>`count(*)::int` })
    .from(users)
    .groupBy(users.status);
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const active = rows.find((r) => r.status === "ACTIVE")?.count ?? 0;
  const suspended = rows.find((r) => r.status === "SUSPENDED")?.count ?? 0;
  const banned = rows.find((r) => r.status === "BANNED")?.count ?? 0;
  return { total, active, suspended, banned };
}

export async function getTransactionCount(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(transactions);
  return row?.count ?? 0;
}

export async function getAllUsers() {
  return db.select().from(users).orderBy(desc(users.createdAt));
}

export async function getUserById(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return user ?? null;
}

export async function getAllRegistrationCodes() {
  return db.select().from(registrationCodes).orderBy(desc(registrationCodes.createdAt));
}

export async function getAllTransactions(limit = 200) {
  return db.select().from(transactions).orderBy(desc(transactions.createdAt)).limit(limit);
}

export async function getAllIssuanceRequests() {
  return db.select().from(issuanceRequests).orderBy(desc(issuanceRequests.createdAt));
}

export async function getIssuanceRequestById(id: string) {
  const [request] = await db
    .select()
    .from(issuanceRequests)
    .where(eq(issuanceRequests.id, id))
    .limit(1);
  return request ?? null;
}

export async function getIssuanceVotesDetailed(requestId: string) {
  return db
    .select({
      userId: users.id,
      username: users.username,
      displayName: users.displayName,
      vote: issuanceVotes.vote,
      votedAt: issuanceVotes.createdAt,
    })
    .from(issuanceEligibleVoters)
    .innerJoin(users, eq(users.id, issuanceEligibleVoters.userId))
    .leftJoin(
      issuanceVotes,
      and(eq(issuanceVotes.requestId, requestId), eq(issuanceVotes.userId, users.id)),
    )
    .where(eq(issuanceEligibleVoters.requestId, requestId));
}

export async function getRecentAuditLogs(limit = 100) {
  return db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(limit);
}
