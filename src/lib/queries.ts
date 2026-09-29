import "server-only";
import { db } from "@/db/client";
import {
  auditLogs,
  companies,
  companySaleListings,
  companySaleOffers,
  government,
  invoices,
  issuanceEligibleVoters,
  issuanceRequests,
  issuanceVotes,
  loanInstalments,
  loans,
  notifications,
  registrationCodes,
  supportThreads,
  transactions,
  updates,
  users,
} from "@/db/schema";
import { and, desc, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { badgesOf } from "./badges";
import { effectiveUserStatus } from "./status";

// ---------------------------------------------------------------------------
// Wallet-scoped transaction history
// ---------------------------------------------------------------------------

/**
 * Transactions for one wallet. `walletId` is a user id or a company id; the
 * matching `partyType` keeps a user and a company with the same uuid from
 * ever colliding.
 */
export async function getTransactionsForWallet(
  walletId: string,
  partyType: "USER" | "COMPANY",
  limit = 50,
) {
  return db
    .select()
    .from(transactions)
    .where(
      or(
        and(eq(transactions.senderId, walletId), eq(transactions.senderType, partyType)),
        and(eq(transactions.receiverId, walletId), eq(transactions.receiverType, partyType)),
      ),
    )
    .orderBy(desc(transactions.createdAt))
    .limit(limit);
}

/** Kept for V1 call sites. */
export async function getRecentTransactionsForUser(userId: string, limit = 20) {
  return getTransactionsForWallet(userId, "USER", limit);
}

export async function getUnreadNotificationCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
  return row?.count ?? 0;
}

export async function getNotificationsForUser(userId: string, limit = 100) {
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
  return db
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
}

// ---------------------------------------------------------------------------
// Directories & public profiles
// ---------------------------------------------------------------------------

/**
 * People directory. Balances are never exposed here.
 *
 * V3 Phase G: the two Government label columns are selected so the directory
 * can render the badges. They are read here ONLY to be displayed — this
 * function returns them as an inert `badges` value and nothing downstream
 * branches on them (see src/lib/badges.ts).
 */
export async function searchUsers(query: string, excludeUserId?: string, limit = 50) {
  const conditions = [];
  if (query) {
    conditions.push(
      or(ilike(users.username, `%${query}%`), ilike(users.displayName, `%${query}%`)),
    );
  }
  if (excludeUserId) conditions.push(ne(users.id, excludeUserId));
  conditions.push(ne(users.status, "BANNED"));

  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      status: users.status,
      suspendedUntil: users.suspendedUntil,
      createdAt: users.createdAt,
      isOfficialGovernmentUser: users.isOfficialGovernmentUser,
      isGovernmentMember: users.isGovernmentMember,
    })
    .from(users)
    .where(and(...conditions))
    .orderBy(users.username)
    .limit(limit);

  // One extra query for the whole page rather than one per person — and
  // narrowed to the owners actually on this page, so the directory does not
  // read every approved company in the economy to decorate fifty rows.
  const ownerIds = rows.map((u) => u.id);
  const companyRows =
    ownerIds.length === 0
      ? []
      : await db
          .select({
            ownerUserId: companies.ownerUserId,
            name: companies.name,
            username: companies.username,
          })
          .from(companies)
          .where(
            and(eq(companies.status, "APPROVED"), inArray(companies.ownerUserId, ownerIds)),
          );

  const byOwner = new Map<string, { name: string; username: string }[]>();
  for (const c of companyRows) {
    const list = byOwner.get(c.ownerUserId) ?? [];
    list.push({ name: c.name, username: c.username });
    byOwner.set(c.ownerUserId, list);
  }

  return rows.map((u) => ({
    ...u,
    effectiveStatus: effectiveUserStatus(u),
    badges: badgesOf(u),
    companies: byOwner.get(u.id) ?? [],
  }));
}

export async function getUserByUsername(username: string) {
  const [row] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return row ?? null;
}

/** Companies directory. Balances are never exposed. */
export async function searchCompanies(query: string, limit = 50) {
  const conditions = [eq(companies.status, "APPROVED")];
  if (query) {
    conditions.push(
      or(
        ilike(companies.name, `%${query}%`),
        ilike(companies.username, `%${query}%`),
        ilike(companies.category, `%${query}%`),
      )!,
    );
  }

  return db
    .select({
      id: companies.id,
      name: companies.name,
      username: companies.username,
      category: companies.category,
      description: companies.description,
      governmentOwned: companies.governmentOwned,
      createdAt: companies.createdAt,
      ownerUsername: users.username,
      ownerDisplayName: users.displayName,
    })
    .from(companies)
    .innerJoin(users, eq(users.id, companies.ownerUserId))
    .where(and(...conditions))
    .orderBy(companies.name)
    .limit(limit);
}

export async function getCompanyProfileByUsername(username: string) {
  const [row] = await db
    .select({
      company: companies,
      ownerUsername: users.username,
      ownerDisplayName: users.displayName,
    })
    .from(companies)
    .innerJoin(users, eq(users.id, companies.ownerUserId))
    .where(eq(companies.username, username))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Government dashboard
// ---------------------------------------------------------------------------

export async function getGovernmentSingleton() {
  const [gov] = await db.select().from(government).limit(1);
  return gov ?? null;
}

export async function getUserCounts() {
  const rows = await db
    .select({
      status: users.status,
      suspendedUntil: users.suspendedUntil,
      count: sql<number>`count(*)::int`,
    })
    .from(users)
    .groupBy(users.status, users.suspendedUntil);

  let total = 0;
  let active = 0;
  let suspended = 0;
  let banned = 0;

  for (const r of rows) {
    total += r.count;
    const effective = effectiveUserStatus({
      status: r.status,
      suspendedUntil: r.suspendedUntil,
    });
    if (effective === "ACTIVE") active += r.count;
    else if (effective === "SUSPENDED") suspended += r.count;
    else banned += r.count;
  }

  return { total, active, suspended, banned };
}

export async function getCompanyCounts() {
  const rows = await db
    .select({ status: companies.status, count: sql<number>`count(*)::int` })
    .from(companies)
    .groupBy(companies.status);

  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.count]));
  return {
    total: rows.reduce((s, r) => s + r.count, 0),
    pending: byStatus.PENDING ?? 0,
    approved: byStatus.APPROVED ?? 0,
    rejected: byStatus.REJECTED ?? 0,
    suspended: byStatus.SUSPENDED ?? 0,
    revoked: byStatus.REVOKED ?? 0,
  };
}

export async function getTransactionCount(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(transactions);
  return row?.count ?? 0;
}

/**
 * The full economic picture. `circulating` is everything held outside the
 * treasury; `accounted` should always equal `totalSupply`.
 */
export async function getEconomicOverview() {
  const [gov] = await db.select().from(government).limit(1);
  if (!gov) return null;

  const [userHeld] = await db
    .select({ total: sql<number>`coalesce(sum(${users.balance}),0)::int` })
    .from(users);
  const [companyHeld] = await db
    .select({ total: sql<number>`coalesce(sum(${companies.balance}),0)::int` })
    .from(companies);

  const [taxCollected] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.taxAmount}),0)::int` })
    .from(transactions);

  const [issued] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.grossAmount}),0)::int` })
    .from(transactions)
    .where(eq(transactions.type, "ISSUANCE_CREDIT"));

  const [govSpending] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.grossAmount}),0)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.senderType, "GOVERNMENT"),
        ne(transactions.type, "ISSUANCE_CREDIT"),
      ),
    );

  const [companySales] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.netAmount}),0)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.receiverType, "COMPANY"),
        inArray(transactions.type, ["COMPANY_SALE", "INVOICE_PAYMENT"]),
      ),
    );

  const [userVolume] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.grossAmount}),0)::int` })
    .from(transactions)
    .where(eq(transactions.type, "TRANSFER"));

  const [txCount] = await db.select({ c: sql<number>`count(*)::int` }).from(transactions);

  const userHeldTotal = userHeld?.total ?? 0;
  const companyHeldTotal = companyHeld?.total ?? 0;

  return {
    treasury: gov.balance,
    totalSupply: gov.totalSupply,
    userHeld: userHeldTotal,
    companyHeld: companyHeldTotal,
    circulating: userHeldTotal + companyHeldTotal,
    accounted: gov.balance + userHeldTotal + companyHeldTotal,
    balanced: gov.balance + userHeldTotal + companyHeldTotal === gov.totalSupply,
    taxCollected: taxCollected?.total ?? 0,
    totalIssued: issued?.total ?? 0,
    governmentSpending: govSpending?.total ?? 0,
    companySalesVolume: companySales?.total ?? 0,
    userPaymentVolume: userVolume?.total ?? 0,
    transactionCount: txCount?.c ?? 0,
    taxRateBp: gov.taxRateBp,
    companyTaxRateBp: gov.companyTaxRateBp,
  };
}

/**
 * The Government's user list.
 *
 * V3 Phase K (spec §45) narrowed this in two ways. It used to be a bare
 * `select()`, which meant every row carried every column — including
 * `password_hash` — into a render that shows six fields. Selecting the six
 * keeps the bcrypt hashes out of the render entirely, which is the right
 * default whether or not any current caller would have leaked one, and it
 * roughly halves the bytes the page pulls out of the database.
 *
 * It is also bounded now. The list has no pagination UI (it is an
 * administrative table the Government scans), so the limit is set far above
 * any realistic roll for this deployment and exists purely so the page can
 * never try to render an unbounded result set.
 */
export async function getAllUsers(limit = 2000) {
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      balance: users.balance,
      status: users.status,
      suspendedUntil: users.suspendedUntil,
      isOfficialGovernmentUser: users.isOfficialGovernmentUser,
      isGovernmentMember: users.isGovernmentMember,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(limit);
  return rows.map((u) => ({ ...u, effectiveStatus: effectiveUserStatus(u) }));
}

export async function getUserById(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return user ?? null;
}

/** Everything the Government needs on one user (spec §12). No password data. */
export async function getUserAdminProfile(userId: string) {
  const user = await getUserById(userId);
  if (!user) return null;

  const [ownedCompanies, recentTx, userNotifications, govActions, thread] = await Promise.all([
    db.select().from(companies).where(eq(companies.ownerUserId, userId)),
    getTransactionsForWallet(userId, "USER", 50),
    db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(25),
    db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.targetType, "USER"), eq(auditLogs.targetId, userId)))
      .orderBy(desc(auditLogs.createdAt))
      .limit(50),
    db.select().from(supportThreads).where(eq(supportThreads.userId, userId)).limit(1),
  ]);

  const [funding] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.grossAmount}),0)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.receiverType, "USER"),
        eq(transactions.receiverId, userId),
        inArray(transactions.type, [
          "GOVERNMENT_FUNDING",
          "GOVERNMENT_PAYMENT",
          "ADMIN_ADJUSTMENT_CREDIT",
        ]),
      ),
    );

  return {
    user: { ...user, effectiveStatus: effectiveUserStatus(user) },
    companies: ownedCompanies,
    transactions: recentTx,
    notifications: userNotifications,
    governmentActions: govActions,
    supportThread: thread[0] ?? null,
    totalReceivedFromGovernment: funding?.total ?? 0,
  };
}

export async function getAllRegistrationCodes() {
  return db.select().from(registrationCodes).orderBy(desc(registrationCodes.createdAt));
}

export async function getAllTransactions(limit = 200) {
  return db.select().from(transactions).orderBy(desc(transactions.createdAt)).limit(limit);
}

/** Government transaction search (spec §41). */
export async function searchTransactions(filters: {
  party?: string;
  txRef?: string;
  type?: string;
  minAmount?: number;
  limit?: number;
}) {
  const conditions = [];

  if (filters.party) {
    const handle = filters.party.trim().toLowerCase().replace(/^@/, "");
    conditions.push(
      or(
        ilike(transactions.senderUsername, `%${handle}%`),
        ilike(transactions.receiverUsername, `%${handle}%`),
      )!,
    );
  }
  if (filters.txRef) {
    conditions.push(ilike(transactions.txRef, `%${filters.txRef.trim()}%`));
  }
  if (filters.type) {
    conditions.push(
      eq(transactions.type, filters.type as (typeof transactions.$inferSelect)["type"]),
    );
  }
  if (filters.minAmount !== undefined && Number.isFinite(filters.minAmount)) {
    conditions.push(sql`${transactions.grossAmount} >= ${filters.minAmount}`);
  }

  return db
    .select()
    .from(transactions)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(transactions.createdAt))
    .limit(filters.limit ?? 200);
}

export async function getTransactionByRef(txRef: string) {
  const [row] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.txRef, txRef))
    .limit(1);
  return row ?? null;
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

/** Active audit view — archived rows are hidden but never deleted. */
export async function getRecentAuditLogs(limit = 150, includeArchived = false) {
  return db
    .select()
    .from(auditLogs)
    .where(includeArchived ? undefined : isNull(auditLogs.archivedAt))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Government: companies
// ---------------------------------------------------------------------------

export async function getAllCompaniesForGovernment() {
  return db
    .select({
      company: companies,
      ownerUsername: users.username,
      ownerDisplayName: users.displayName,
    })
    .from(companies)
    .innerJoin(users, eq(users.id, companies.ownerUserId))
    .orderBy(desc(companies.createdAt));
}

export async function getCompanyAdminProfile(companyId: string) {
  const [row] = await db
    .select({
      company: companies,
      ownerUsername: users.username,
      ownerDisplayName: users.displayName,
      ownerId: users.id,
    })
    .from(companies)
    .innerJoin(users, eq(users.id, companies.ownerUserId))
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!row) return null;

  const [txs, companyInvoices, companyLoans, offers, listings, govActions] = await Promise.all([
    getTransactionsForWallet(companyId, "COMPANY", 50),
    db
      .select()
      .from(invoices)
      .where(eq(invoices.companyId, companyId))
      .orderBy(desc(invoices.createdAt))
      .limit(50),
    db
      .select()
      .from(loans)
      .where(eq(loans.companyId, companyId))
      .orderBy(desc(loans.createdAt)),
    db
      .select()
      .from(companySaleOffers)
      .where(eq(companySaleOffers.companyId, companyId))
      .orderBy(desc(companySaleOffers.createdAt)),
    db
      .select()
      .from(companySaleListings)
      .where(eq(companySaleListings.companyId, companyId))
      .orderBy(desc(companySaleListings.createdAt)),
    db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.targetType, "COMPANY"), eq(auditLogs.targetId, companyId)))
      .orderBy(desc(auditLogs.createdAt))
      .limit(50),
  ]);

  const [sales] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.netAmount}),0)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.receiverType, "COMPANY"),
        eq(transactions.receiverId, companyId),
        inArray(transactions.type, ["COMPANY_SALE", "INVOICE_PAYMENT"]),
      ),
    );

  const [taxPaid] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.taxAmount}),0)::int` })
    .from(transactions)
    .where(
      or(
        and(eq(transactions.receiverType, "COMPANY"), eq(transactions.receiverId, companyId)),
        and(eq(transactions.senderType, "COMPANY"), eq(transactions.senderId, companyId)),
      ),
    );

  return {
    ...row,
    transactions: txs,
    invoices: companyInvoices,
    loans: companyLoans,
    offers,
    listings,
    governmentActions: govActions,
    salesTotal: sales?.total ?? 0,
    taxPaid: taxPaid?.total ?? 0,
  };
}

export async function getPendingCompanyCount(): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(companies)
    .where(eq(companies.status, "PENDING"));
  return row?.c ?? 0;
}

// ---------------------------------------------------------------------------
// Company dashboard figures
// ---------------------------------------------------------------------------

export async function getCompanyDashboardStats(companyId: string) {
  const [sales] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.netAmount}),0)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.receiverType, "COMPANY"),
        eq(transactions.receiverId, companyId),
        inArray(transactions.type, ["COMPANY_SALE", "INVOICE_PAYMENT"]),
      ),
    );

  const [incoming] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(transactions)
    .where(
      and(eq(transactions.receiverType, "COMPANY"), eq(transactions.receiverId, companyId)),
    );

  const [outgoing] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(transactions)
    .where(and(eq(transactions.senderType, "COMPANY"), eq(transactions.senderId, companyId)));

  const [taxPaid] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.taxAmount}),0)::int` })
    .from(transactions)
    .where(
      or(
        and(eq(transactions.receiverType, "COMPANY"), eq(transactions.receiverId, companyId)),
        and(eq(transactions.senderType, "COMPANY"), eq(transactions.senderId, companyId)),
      ),
    );

  const [pendingInvoices] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(invoices)
    .where(and(eq(invoices.companyId, companyId), eq(invoices.status, "PENDING")));

  const salesTotal = sales?.total ?? 0;
  const tax = taxPaid?.total ?? 0;

  return {
    salesTotal,
    taxPaid: tax,
    netRevenue: salesTotal - 0, // tax on sales is already excluded from netAmount
    incomingCount: incoming?.c ?? 0,
    outgoingCount: outgoing?.c ?? 0,
    pendingInvoices: pendingInvoices?.c ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Global admin search (spec §11)
// ---------------------------------------------------------------------------

export type AdminSearchResults = {
  users: { id: string; username: string; displayName: string; status: string }[];
  companies: { id: string; username: string; name: string; status: string }[];
  transactions: { id: string; txRef: string; grossAmount: number }[];
  invoices: { id: string; invoiceNumber: string; total: number; status: string }[];
  loans: { id: string; loanNumber: string; status: string }[];
  complaints: { id: string; complaintNumber: string; status: string }[];
};

export async function adminSearch(query: string): Promise<AdminSearchResults> {
  const q = query.trim().replace(/^@/, "");
  if (!q) {
    return { users: [], companies: [], transactions: [], invoices: [], loans: [], complaints: [] };
  }
  const like = `%${q}%`;

  const [userRows, companyRows, txRows, invoiceRows, loanRows, complaintRows] =
    await Promise.all([
      db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          status: users.status,
        })
        .from(users)
        .where(or(ilike(users.username, like), ilike(users.displayName, like)))
        .limit(20),
      db
        .select({
          id: companies.id,
          username: companies.username,
          name: companies.name,
          status: companies.status,
        })
        .from(companies)
        .where(or(ilike(companies.username, like), ilike(companies.name, like)))
        .limit(20),
      db
        .select({
          id: transactions.id,
          txRef: transactions.txRef,
          grossAmount: transactions.grossAmount,
        })
        .from(transactions)
        .where(ilike(transactions.txRef, like))
        .limit(20),
      db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          total: invoices.total,
          status: invoices.status,
        })
        .from(invoices)
        .where(ilike(invoices.invoiceNumber, like))
        .limit(20),
      db
        .select({ id: loans.id, loanNumber: loans.loanNumber, status: loans.status })
        .from(loans)
        .where(ilike(loans.loanNumber, like))
        .limit(20),
      db.execute<{ id: string; complaint_number: string; status: string }>(
        sql`SELECT id, complaint_number, status FROM ip_complaints WHERE complaint_number ILIKE ${like} LIMIT 20`,
      ),
    ]);

  return {
    users: userRows,
    companies: companyRows,
    transactions: txRows,
    invoices: invoiceRows,
    loans: loanRows,
    complaints: (complaintRows.rows ?? []).map((r) => ({
      id: r.id,
      complaintNumber: r.complaint_number,
      status: r.status,
    })),
  };
}

// ---------------------------------------------------------------------------
// Invoice + loan helpers for the user area
// ---------------------------------------------------------------------------

export async function getOutstandingInstalmentsForOwner(ownerUserId: string) {
  return db
    .select({
      instalment: loanInstalments,
      loan: loans,
      company: companies,
    })
    .from(loanInstalments)
    .innerJoin(loans, eq(loans.id, loanInstalments.loanId))
    .innerJoin(companies, eq(companies.id, loans.companyId))
    .where(
      and(
        eq(companies.ownerUserId, ownerUserId),
        inArray(loanInstalments.status, ["PENDING", "OVERDUE"]),
      ),
    )
    .orderBy(loanInstalments.dueAt);
}
