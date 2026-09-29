import "server-only";
import { db } from "@/db/client";
import {
  companies,
  marketplaceWantedRequests,
  marketplaceWantedResponses,
  users,
} from "@/db/schema";
import { and, asc, desc, eq, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { companyWallet, sameWallet, userWallet, type WalletRef } from "./wallets";
import { canCompanyTrade, canUserSend } from "./status";
import { notifyUser } from "./notify";
import { isUniqueViolation } from "./db-errors";
import {
  MARKETPLACE_BROWSE_PAGE_SIZE,
  MARKETPLACE_CATEGORY_MAX_LENGTH,
  MARKETPLACE_MAX_QUANTITY,
  WANTED_DESCRIPTION_MAX_LENGTH,
  WANTED_EXPIRY_DAYS,
  WANTED_HEADING_MAX_LENGTH,
  WANTED_MAX_BUDGET,
  WANTED_RESPONSE_MAX_LENGTH,
} from "./constants";
import type { MarketplaceWantedRequest, MarketplaceWantedResponse } from "@/db/schema";

/**
 * WANTED REQUESTS (V3 Phase D, spec §16)
 * ===========================================================================
 *
 * "I am looking for X." A user or a company posts a compact request; anyone
 * else may answer it ONCE. There is deliberately no chat: a response is a
 * single message plus an optional quoted price, and the conversation that
 * follows happens through the existing payment, invoice and marketplace
 * primitives rather than through a messaging system this app does not have.
 *
 * ONE RESPONSE PER PARTY IS A DATABASE GUARANTEE.
 * `wanted_response_user_unique` and `wanted_response_company_unique` (partial
 * unique indexes from Phase A) mean a second response from the same party is
 * rejected by Postgres, under a race or otherwise. This module turns that
 * rejection into a readable message; it does not rely on having checked first.
 *
 * EXPIRY IS A STORED TIMESTAMP, NOT A SWEEP.
 * Every request carries `expiresAt` from the moment it is created, so the Phase
 * I retention engine has a deterministic basis for removing lapsed ones.
 * `expireOverdueWantedRequests` only flips the status; nothing is deleted here.
 */

export class WantedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WantedError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<typeof db, "select">;

function cleanText(value: string | null | undefined, max: number): string {
  return (value ?? "").trim().slice(0, max);
}

async function inboxUserId(executor: Executor, wallet: WalletRef): Promise<string | null> {
  if (wallet.kind === "USER") return wallet.id;
  if (wallet.kind === "COMPANY") {
    const [row] = await executor
      .select({ ownerUserId: companies.ownerUserId })
      .from(companies)
      .where(eq(companies.id, wallet.id))
      .limit(1);
    return row?.ownerUserId ?? null;
  }
  return null;
}

/** The requester's wallet for a request row. Derived from the row. */
export function requesterWallet(
  row: Pick<MarketplaceWantedRequest, "requesterType" | "requesterUserId" | "requesterCompanyId">,
): WalletRef {
  if (row.requesterType === "USER") {
    if (!row.requesterUserId) throw new WantedError("This request has no requester.");
    return userWallet(row.requesterUserId);
  }
  if (row.requesterType === "COMPANY") {
    if (!row.requesterCompanyId) throw new WantedError("This request has no requester.");
    return companyWallet(row.requesterCompanyId);
  }
  throw new WantedError("The Government does not post wanted requests.");
}

export function responderWallet(
  row: Pick<MarketplaceWantedResponse, "responderType" | "responderUserId" | "responderCompanyId">,
): WalletRef {
  if (row.responderType === "USER") {
    if (!row.responderUserId) throw new WantedError("This response has no responder.");
    return userWallet(row.responderUserId);
  }
  if (row.responderType === "COMPANY") {
    if (!row.responderCompanyId) throw new WantedError("This response has no responder.");
    return companyWallet(row.responderCompanyId);
  }
  throw new WantedError("The Government does not respond to wanted requests.");
}

async function assertCanAct(tx: Tx, wallet: WalletRef): Promise<void> {
  if (wallet.kind === "USER") {
    const [row] = await tx.select().from(users).where(eq(users.id, wallet.id)).limit(1);
    if (!row) throw new WantedError("Your account could not be read.");
    if (!canUserSend(row)) throw new WantedError("Your account cannot post right now.");
    return;
  }
  if (wallet.kind === "COMPANY") {
    const [row] = await tx.select().from(companies).where(eq(companies.id, wallet.id)).limit(1);
    if (!row) throw new WantedError("Your company could not be read.");
    if (!canCompanyTrade(row)) throw new WantedError("This company cannot post right now.");
    const [owner] = await tx.select().from(users).where(eq(users.id, row.ownerUserId)).limit(1);
    if (!owner || !canUserSend(owner)) {
      throw new WantedError("The company owner's account cannot act right now.");
    }
    return;
  }
  throw new WantedError("The Government does not take part in wanted requests.");
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export type WantedInput = {
  heading: string;
  description: string;
  category: string;
  quantity: number;
  budget: number;
  deadline?: Date | null;
};

export async function createWantedRequest(params: {
  requester: WalletRef;
  input: WantedInput;
}): Promise<MarketplaceWantedRequest> {
  const heading = cleanText(params.input.heading, WANTED_HEADING_MAX_LENGTH);
  const description = cleanText(params.input.description, WANTED_DESCRIPTION_MAX_LENGTH);
  const category = cleanText(params.input.category, MARKETPLACE_CATEGORY_MAX_LENGTH);
  const quantity = Math.trunc(params.input.quantity);
  const budget = Math.trunc(params.input.budget);

  if (heading.length === 0) throw new WantedError("A heading is required.");
  if (description.length === 0) throw new WantedError("A description is required.");
  if (category.length === 0) throw new WantedError("A category is required.");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MARKETPLACE_MAX_QUANTITY) {
    throw new WantedError("Quantity must be a whole number of at least 1.");
  }
  if (!Number.isInteger(budget) || budget < 1 || budget > WANTED_MAX_BUDGET) {
    throw new WantedError("The budget must be a whole number of at least 1 Aeros.");
  }
  if (params.input.deadline && Number.isNaN(params.input.deadline.getTime())) {
    throw new WantedError("That deadline is not a real date.");
  }

  return db.transaction(async (tx) => {
    await assertCanAct(tx, params.requester);

    const [row] = await tx
      .insert(marketplaceWantedRequests)
      .values({
        requesterType: params.requester.kind,
        requesterUserId: params.requester.kind === "USER" ? params.requester.id : null,
        requesterCompanyId: params.requester.kind === "COMPANY" ? params.requester.id : null,
        heading,
        description,
        category,
        quantity,
        budget,
        deadline: params.input.deadline ?? null,
        status: "OPEN",
        expiresAt: new Date(Date.now() + WANTED_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
      })
      .returning();
    return row;
  });
}

/** OPEN → FULFILLED or CANCELLED, by the requester. */
export async function closeWantedRequest(params: {
  requestId: string;
  requester: WalletRef;
  status: "FULFILLED" | "CANCELLED";
}): Promise<MarketplaceWantedRequest> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(marketplaceWantedRequests)
      .where(eq(marketplaceWantedRequests.id, params.requestId))
      .for("update");
    if (!row) throw new WantedError("Request not found.");
    if (!sameWallet(requesterWallet(row), params.requester)) {
      throw new WantedError("This is not your request.");
    }
    if (row.status !== "OPEN") {
      throw new WantedError(`This request is already ${row.status}.`);
    }

    const [updated] = await tx
      .update(marketplaceWantedRequests)
      .set({ status: params.status, closedAt: new Date() })
      .where(
        and(
          eq(marketplaceWantedRequests.id, row.id),
          eq(marketplaceWantedRequests.status, "OPEN"),
        ),
      )
      .returning();
    if (!updated) throw new WantedError("This request changed while you were closing it.");
    return updated;
  });
}

/**
 * Lapses OPEN requests past their expiry. Lazy (no scheduler yet) and cheap:
 * `wanted_requests_expiry_idx` serves the WHERE clause.
 */
export async function expireOverdueWantedRequests(): Promise<number> {
  const rows = await db
    .update(marketplaceWantedRequests)
    .set({ status: "EXPIRED", closedAt: new Date() })
    .where(
      and(
        eq(marketplaceWantedRequests.status, "OPEN"),
        lte(marketplaceWantedRequests.expiresAt, new Date()),
      ),
    )
    .returning({ id: marketplaceWantedRequests.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export async function respondToWantedRequest(params: {
  requestId: string;
  responder: WalletRef;
  message: string;
  offeredPrice?: number | null;
}): Promise<MarketplaceWantedResponse> {
  const message = cleanText(params.message, WANTED_RESPONSE_MAX_LENGTH);
  if (message.length === 0) throw new WantedError("Please say what you can offer.");

  let offeredPrice: number | null = null;
  if (params.offeredPrice !== null && params.offeredPrice !== undefined) {
    offeredPrice = Math.trunc(params.offeredPrice);
    if (!Number.isInteger(offeredPrice) || offeredPrice < 1 || offeredPrice > WANTED_MAX_BUDGET) {
      throw new WantedError("A quoted price must be a whole number of at least 1 Aeros.");
    }
  }

  try {
    return await db.transaction(async (tx) => {
      await assertCanAct(tx, params.responder);

      const [request] = await tx
        .select()
        .from(marketplaceWantedRequests)
        .where(eq(marketplaceWantedRequests.id, params.requestId))
        .for("update");
      if (!request) throw new WantedError("Request not found.");
      if (request.status !== "OPEN") {
        throw new WantedError(`This request is ${request.status} and is no longer taking replies.`);
      }
      if (sameWallet(requesterWallet(request), params.responder)) {
        throw new WantedError("You cannot respond to your own request.");
      }

      const [response] = await tx
        .insert(marketplaceWantedResponses)
        .values({
          requestId: request.id,
          responderType: params.responder.kind,
          responderUserId: params.responder.kind === "USER" ? params.responder.id : null,
          responderCompanyId: params.responder.kind === "COMPANY" ? params.responder.id : null,
          message,
          offeredPrice,
          status: "PENDING",
        })
        .returning();

      const inbox = await inboxUserId(tx, requesterWallet(request));
      if (inbox) {
        await notifyUser(
          tx,
          inbox,
          "WANTED_RESPONSE",
          `Someone replied to your request "${request.heading}".`,
          `/market/wanted/${request.id}`,
        );
      }

      return response;
    });
  } catch (e) {
    // The partial unique indexes are the real guarantee; this is the message.
    if (isUniqueViolation(e)) {
      throw new WantedError("You have already responded to this request.");
    }
    throw e;
  }
}

/** The requester accepts or declines one response. */
export async function decideWantedResponse(params: {
  responseId: string;
  requester: WalletRef;
  decision: "ACCEPTED" | "DECLINED";
}): Promise<MarketplaceWantedResponse> {
  return db.transaction(async (tx) => {
    const [response] = await tx
      .select()
      .from(marketplaceWantedResponses)
      .where(eq(marketplaceWantedResponses.id, params.responseId))
      .for("update");
    if (!response) throw new WantedError("Response not found.");

    const [request] = await tx
      .select()
      .from(marketplaceWantedRequests)
      .where(eq(marketplaceWantedRequests.id, response.requestId))
      .for("update");
    if (!request) throw new WantedError("Request not found.");
    if (!sameWallet(requesterWallet(request), params.requester)) {
      throw new WantedError("This is not your request.");
    }
    if (response.status !== "PENDING") {
      throw new WantedError(`This response is already ${response.status}.`);
    }

    const [updated] = await tx
      .update(marketplaceWantedResponses)
      .set({ status: params.decision, respondedAt: new Date() })
      .where(
        and(
          eq(marketplaceWantedResponses.id, response.id),
          eq(marketplaceWantedResponses.status, "PENDING"),
        ),
      )
      .returning();
    if (!updated) throw new WantedError("This response changed while you were deciding.");

    const inbox = await inboxUserId(tx, responderWallet(response));
    if (inbox) {
      await notifyUser(
        tx,
        inbox,
        params.decision === "ACCEPTED" ? "WANTED_ACCEPTED" : "WANTED_DECLINED",
        `Your reply to "${request.heading}" was ${params.decision.toLowerCase()}.`,
        `/market/wanted/${request.id}`,
      );
    }

    return updated;
  });
}

export async function withdrawWantedResponse(params: {
  responseId: string;
  responder: WalletRef;
}): Promise<MarketplaceWantedResponse> {
  return db.transaction(async (tx) => {
    const [response] = await tx
      .select()
      .from(marketplaceWantedResponses)
      .where(eq(marketplaceWantedResponses.id, params.responseId))
      .for("update");
    if (!response) throw new WantedError("Response not found.");
    if (!sameWallet(responderWallet(response), params.responder)) {
      throw new WantedError("This is not your response.");
    }
    if (response.status !== "PENDING") {
      throw new WantedError(`This response is already ${response.status}.`);
    }

    const [updated] = await tx
      .update(marketplaceWantedResponses)
      .set({ status: "WITHDRAWN", respondedAt: new Date() })
      .where(
        and(
          eq(marketplaceWantedResponses.id, response.id),
          eq(marketplaceWantedResponses.status, "PENDING"),
        ),
      )
      .returning();
    if (!updated) throw new WantedError("This response changed while you were withdrawing it.");
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export type WantedRow = {
  request: MarketplaceWantedRequest;
  requesterLabel: string;
  requesterHandle: string;
  responseCount: number;
};

async function labelRequests(rows: MarketplaceWantedRequest[]): Promise<WantedRow[]> {
  if (rows.length === 0) return [];

  const userIds = [...new Set(rows.map((r) => r.requesterUserId).filter((v): v is string => !!v))];
  const companyIds = [
    ...new Set(rows.map((r) => r.requesterCompanyId).filter((v): v is string => !!v)),
  ];

  const userRows = userIds.length
    ? await db
        .select({ id: users.id, username: users.username, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const companyRows = companyIds.length
    ? await db
        .select({ id: companies.id, username: companies.username, name: companies.name })
        .from(companies)
        .where(inArray(companies.id, companyIds))
    : [];
  const counts = await db
    .select({
      requestId: marketplaceWantedResponses.requestId,
      count: sql<number>`count(*)::int`,
    })
    .from(marketplaceWantedResponses)
    .where(inArray(marketplaceWantedResponses.requestId, rows.map((r) => r.id)))
    .groupBy(marketplaceWantedResponses.requestId);

  const userMap = new Map(userRows.map((r) => [r.id, r]));
  const companyMap = new Map(companyRows.map((r) => [r.id, r]));
  const countMap = new Map(counts.map((r) => [r.requestId, r.count]));

  return rows.map((request) => {
    const u = request.requesterUserId ? userMap.get(request.requesterUserId) : null;
    const c = request.requesterCompanyId ? companyMap.get(request.requesterCompanyId) : null;
    return {
      request,
      requesterLabel: u?.displayName ?? c?.name ?? "Unknown",
      requesterHandle: u?.username ?? c?.username ?? "unknown",
      responseCount: countMap.get(request.id) ?? 0,
    };
  });
}

export type WantedBrowseResult = {
  rows: WantedRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

/** Paginated, server-side browse over OPEN requests. Nothing is stored. */
export async function browseWantedRequests(filters: {
  q?: string | null;
  category?: string | null;
  page?: number;
  pageSize?: number;
} = {}): Promise<WantedBrowseResult> {
  const pageSize = Math.min(
    Math.max(Math.trunc(filters.pageSize ?? MARKETPLACE_BROWSE_PAGE_SIZE), 1),
    50,
  );
  const page = Math.max(Math.trunc(filters.page ?? 1), 1);

  const conditions: SQL<unknown>[] = [
    eq(marketplaceWantedRequests.status, "OPEN") as SQL<unknown>,
  ];

  const q = cleanText(filters.q, 120);
  if (q.length > 0) {
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    conditions.push(
      or(
        sql`${marketplaceWantedRequests.heading} ILIKE ${like}`,
        sql`${marketplaceWantedRequests.description} ILIKE ${like}`,
        sql`${marketplaceWantedRequests.category} ILIKE ${like}`,
      ) as SQL<unknown>,
    );
  }
  const category = cleanText(filters.category, MARKETPLACE_CATEGORY_MAX_LENGTH);
  if (category.length > 0) {
    conditions.push(sql`lower(${marketplaceWantedRequests.category}) = ${category.toLowerCase()}`);
  }

  const where = and(...conditions) as SQL<unknown>;

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(marketplaceWantedRequests)
    .where(where);
  const total = countRow?.count ?? 0;

  const rows = await db
    .select()
    .from(marketplaceWantedRequests)
    .where(where)
    .orderBy(desc(marketplaceWantedRequests.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    rows: await labelRequests(rows),
    total,
    page,
    pageSize,
    pageCount: Math.max(Math.ceil(total / pageSize), 1),
  };
}

export async function getWantedRequestById(requestId: string): Promise<WantedRow | null> {
  const [row] = await db
    .select()
    .from(marketplaceWantedRequests)
    .where(eq(marketplaceWantedRequests.id, requestId))
    .limit(1);
  if (!row) return null;
  const [labelled] = await labelRequests([row]);
  return labelled;
}

export type WantedResponseRow = {
  response: MarketplaceWantedResponse;
  responderLabel: string;
  responderHandle: string;
};

export async function getResponsesForRequest(requestId: string): Promise<WantedResponseRow[]> {
  const rows = await db
    .select()
    .from(marketplaceWantedResponses)
    .where(eq(marketplaceWantedResponses.requestId, requestId))
    .orderBy(asc(marketplaceWantedResponses.createdAt));
  if (rows.length === 0) return [];

  const userIds = [...new Set(rows.map((r) => r.responderUserId).filter((v): v is string => !!v))];
  const companyIds = [
    ...new Set(rows.map((r) => r.responderCompanyId).filter((v): v is string => !!v)),
  ];
  const userRows = userIds.length
    ? await db
        .select({ id: users.id, username: users.username, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const companyRows = companyIds.length
    ? await db
        .select({ id: companies.id, username: companies.username, name: companies.name })
        .from(companies)
        .where(inArray(companies.id, companyIds))
    : [];
  const userMap = new Map(userRows.map((r) => [r.id, r]));
  const companyMap = new Map(companyRows.map((r) => [r.id, r]));

  return rows.map((response) => {
    const u = response.responderUserId ? userMap.get(response.responderUserId) : null;
    const c = response.responderCompanyId ? companyMap.get(response.responderCompanyId) : null;
    return {
      response,
      responderLabel: u?.displayName ?? c?.name ?? "Unknown",
      responderHandle: u?.username ?? c?.username ?? "unknown",
    };
  });
}

/** Requests posted by the wallet the viewer is acting as. */
export async function getWantedRequestsForRequester(
  requester: WalletRef,
  limit = 100,
): Promise<WantedRow[]> {
  if (requester.kind === "GOVERNMENT") return [];
  const rows = await db
    .select()
    .from(marketplaceWantedRequests)
    .where(
      requester.kind === "USER"
        ? eq(marketplaceWantedRequests.requesterUserId, requester.id)
        : eq(marketplaceWantedRequests.requesterCompanyId, requester.id),
    )
    .orderBy(desc(marketplaceWantedRequests.createdAt))
    .limit(limit);
  return labelRequests(rows);
}

/** The response this wallet already sent to a request, if any. */
export async function getMyResponse(
  requestId: string,
  responder: WalletRef,
): Promise<MarketplaceWantedResponse | null> {
  if (responder.kind === "GOVERNMENT") return null;
  const [row] = await db
    .select()
    .from(marketplaceWantedResponses)
    .where(
      and(
        eq(marketplaceWantedResponses.requestId, requestId),
        responder.kind === "USER"
          ? eq(marketplaceWantedResponses.responderUserId, responder.id)
          : eq(marketplaceWantedResponses.responderCompanyId, responder.id),
      ),
    )
    .limit(1);
  return row ?? null;
}
