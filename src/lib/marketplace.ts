import "server-only";
import { db } from "@/db/client";
import {
  companies,
  invoices,
  marketplaceOffers,
  marketplaceOrders,
  users,
} from "@/db/schema";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import {
  companyWallet,
  sameWallet,
  userWallet,
  type WalletRef,
} from "./wallets";
import { canCompanyReceive, canCompanyTrade, canUserSend, effectiveCompanyStatus } from "./status";
import { deriveCompanySettlement, assertSettlementDestination } from "./settlement";
import {
  createInvoiceInTx,
  InvoiceError,
  recipientTypeAndHandleFor,
} from "./invoices";
import { notifyUser } from "./notify";

import { isUniqueViolation } from "./db-errors";
import {
  MARKETPLACE_BROWSE_PAGE_SIZE,
  MARKETPLACE_CATEGORY_MAX_LENGTH,
  MARKETPLACE_DESCRIPTION_MAX_LENGTH,
  MARKETPLACE_MAX_QUANTITY,
  MARKETPLACE_MAX_UNIT_PRICE,
  MARKETPLACE_ORDER_EXPIRY_DAYS,
  MARKETPLACE_TITLE_MAX_LENGTH,
  MARKETPLACE_OPEN_ORDER_STATUSES,
} from "./constants";
import type { Company, Invoice, MarketplaceOffer, MarketplaceOrder } from "@/db/schema";

/**
 * MARKETPLACE — OFFERS AND ORDERS (V3 Phase C, spec §§11,12,13,14,15,18)
 * ===========================================================================
 *
 * A company lists what it sells; anyone browses; a buyer orders; the company
 * accepts and invoices; the buyer pays; the order completes. Five properties
 * carry the whole thing and are worth stating plainly, because each is
 * STRUCTURAL rather than a check somebody has to remember:
 *
 * 1. EVERY ORDER FOR AN OFFER SERIALISES ON THAT OFFER'S ROW.
 *    `placeOrder` takes `SELECT ... FOR UPDATE` on the offer before it looks at
 *    availability, so two concurrent orders for the last unit are not racing —
 *    the second one reads the stock the first one already decremented. The
 *    decrement itself is then a CONDITIONAL update
 *    (`WHERE quantity_available >= n`), which is an independent second
 *    guarantee that stock can never go negative even if a lock were missed.
 *    Same discipline as `debitWallet` in src/lib/wallets.ts, for the same
 *    reason.
 *
 * 2. NO DUPLICATE ORDER, AND NO DUPLICATE INVOICE, AT THE DATABASE LEVEL.
 *    `marketplace_order_open_{user,company}_unique` allow a buyer at most one
 *    UNSETTLED order per offer; `invoices_source_order_unique` and
 *    `marketplace_orders_invoice_unique` allow an order at most one invoice.
 *    Postgres refuses the second one whatever the application code does.
 *
 * 3. THE INVOICE IS THE PHASE B ENGINE, NOT A COPY OF IT.
 *    `issueInvoiceForOrder` calls `createInvoiceInTx` inside the order's own
 *    transaction, so an order's invoice is numbered, taxed and frozen by
 *    exactly the same code as any other invoice. Payment is `payInvoice`,
 *    which is idempotent and which moves the order's status in the same
 *    transaction it marks the invoice PAID.
 *
 * 4. THE ORDER PATH CANNOT NAME A DESTINATION.
 *    Not one function in this file takes a wallet to pay into. The invoice is
 *    issued BY the seller company (`companyId` read from the order row), and
 *    `payInvoice` derives the destination with `deriveCompanySettlement`. This
 *    file additionally derives that settlement itself at issue time and
 *    asserts it is the seller's wallet, so the anti-tax-routing guarantee is
 *    visible at the order layer too rather than merely inherited silently.
 *
 * 5. PRICE IS SNAPSHOT AT ORDER TIME.
 *    `unitPrice` and `subtotal` are copied onto the order row when it is
 *    placed. The company may re-price the offer a second later; this order
 *    still costs what the buyer saw.
 *
 * NOTHING ABOUT A SEARCH IS STORED. `browseOffers` reads. There is no search
 * history table, no popular-terms counter and no per-viewer log anywhere in
 * this file or in the schema (spec §13).
 */

export class MarketplaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<typeof db, "select">;

export type OfferStatus = "ACTIVE" | "PAUSED" | "CLOSED";
export type OrderStatus = MarketplaceOrder["status"];

/** The statuses an order can still move out of on its own. */
export const OPEN_ORDER_STATUSES = MARKETPLACE_OPEN_ORDER_STATUSES;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * "This company may trade right now", expressed in SQL so browse can filter on
 * it, mirroring `effectiveCompanyStatus` exactly: APPROVED, or SUSPENDED with a
 * suspension whose end has already passed.
 */
function companyTradeableSql(): SQL<unknown> {
  return sql`(${companies.status} = 'APPROVED' OR (${companies.status} = 'SUSPENDED' AND ${companies.suspendedUntil} IS NOT NULL AND ${companies.suspendedUntil} <= now()))`;
}

/** Human-readable order number: ORD-YYYYMMDD-NNNN, unique per day. */
async function nextOrderNumber(tx: Tx): Promise<string> {
  const now = new Date();
  const datePart = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  ].join("");

  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(marketplaceOrders)
    .where(sql`${marketplaceOrders.orderNumber} LIKE ${`ORD-${datePart}-%`}`);

  return `ORD-${datePart}-${String((row?.count ?? 0) + 1).padStart(4, "0")}`;
}

function cleanText(value: string | null | undefined, max: number): string {
  return (value ?? "").trim().slice(0, max);
}

/** The user who should hear about activity on a wallet, or null. */
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

/** The buyer's wallet for an order row. Derived from the row, never supplied. */
export function orderBuyerWallet(
  order: Pick<MarketplaceOrder, "buyerType" | "buyerUserId" | "buyerCompanyId">,
): WalletRef {
  if (order.buyerType === "USER") {
    if (!order.buyerUserId) throw new MarketplaceError("This order has no buyer.");
    return userWallet(order.buyerUserId);
  }
  if (order.buyerType === "COMPANY") {
    if (!order.buyerCompanyId) throw new MarketplaceError("This order has no buyer.");
    return companyWallet(order.buyerCompanyId);
  }
  throw new MarketplaceError("Government cannot place marketplace orders.");
}

// ===========================================================================
// OFFERS (spec §§11,12)
// ===========================================================================

export type OfferInput = {
  title: string;
  description: string;
  category: string;
  unitPrice: number;
  /** null = unlimited availability. 0 = temporarily out of stock. */
  quantityAvailable: number | null;
};

function validateOfferInput(input: OfferInput): OfferInput {
  const title = cleanText(input.title, MARKETPLACE_TITLE_MAX_LENGTH);
  const description = cleanText(input.description, MARKETPLACE_DESCRIPTION_MAX_LENGTH);
  const category = cleanText(input.category, MARKETPLACE_CATEGORY_MAX_LENGTH);

  if (title.length === 0) throw new MarketplaceError("A title is required.");
  if (description.length === 0) throw new MarketplaceError("A description is required.");
  if (category.length === 0) throw new MarketplaceError("A category is required.");

  if (!Number.isInteger(input.unitPrice) || input.unitPrice < 1) {
    throw new MarketplaceError("The price must be a whole number of at least 1 Aeros.");
  }
  if (input.unitPrice > MARKETPLACE_MAX_UNIT_PRICE) {
    throw new MarketplaceError("That price is too large.");
  }
  if (input.quantityAvailable !== null) {
    if (!Number.isInteger(input.quantityAvailable) || input.quantityAvailable < 0) {
      throw new MarketplaceError("Availability must be a whole number, or blank for unlimited.");
    }
    if (input.quantityAvailable > MARKETPLACE_MAX_QUANTITY) {
      throw new MarketplaceError("That quantity is too large.");
    }
  }

  return { title, description, category, unitPrice: input.unitPrice, quantityAvailable: input.quantityAvailable };
}

/**
 * Creates an offer for a company.
 *
 * `company` must be the company the caller is ACTING AS — the action layer
 * re-verifies ownership with `requireOwnedCompany` and passes the row it read,
 * and this function re-reads and re-checks it under a lock anyway.
 */
export async function createOffer(params: {
  company: Company;
  input: OfferInput;
}): Promise<MarketplaceOffer> {
  const input = validateOfferInput(params.input);

  return db.transaction(async (tx) => {
    const [issuer] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, params.company.id))
      .for("update");
    if (!issuer) throw new MarketplaceError("That company no longer exists.");
    if (effectiveCompanyStatus(issuer) !== "APPROVED") {
      throw new MarketplaceError("Only an active company can list offers.");
    }

    const [offer] = await tx
      .insert(marketplaceOffers)
      .values({
        companyId: issuer.id,
        title: input.title,
        description: input.description,
        category: input.category,
        unitPrice: input.unitPrice,
        quantityAvailable: input.quantityAvailable,
        status: "ACTIVE",
      })
      .returning();

    return offer;
  });
}

/** Edits an offer's own fields. Never touches status, stock reservations aside. */
export async function updateOffer(params: {
  offerId: string;
  companyId: string;
  input: OfferInput;
}): Promise<MarketplaceOffer> {
  const input = validateOfferInput(params.input);

  return db.transaction(async (tx) => {
    const [offer] = await tx
      .select()
      .from(marketplaceOffers)
      .where(eq(marketplaceOffers.id, params.offerId))
      .for("update");
    if (!offer) throw new MarketplaceError("Offer not found.");
    if (offer.companyId !== params.companyId) {
      throw new MarketplaceError("That offer does not belong to your company.");
    }
    if (offer.status === "CLOSED") {
      throw new MarketplaceError("A closed offer cannot be edited.");
    }

    const [updated] = await tx
      .update(marketplaceOffers)
      .set({
        title: input.title,
        description: input.description,
        category: input.category,
        unitPrice: input.unitPrice,
        quantityAvailable: input.quantityAvailable,
        updatedAt: new Date(),
      })
      .where(eq(marketplaceOffers.id, params.offerId))
      .returning();

    return updated;
  });
}

/**
 * Moves an offer between ACTIVE / PAUSED / CLOSED.
 *
 * `pausedAt` is written when the offer becomes PAUSED and CLEARED when it goes
 * back to ACTIVE. That timestamp is the only basis the Phase I retention engine
 * will have for the 14-day auto-removal rule, so getting it right here — and in
 * particular clearing it on resume so a resumed offer does not inherit an old
 * clock — is the whole point. Nothing in this phase removes anything.
 */
export async function setOfferStatus(params: {
  offerId: string;
  companyId: string;
  status: OfferStatus;
}): Promise<MarketplaceOffer> {
  const { offerId, companyId, status } = params;

  return db.transaction(async (tx) => {
    const [offer] = await tx
      .select()
      .from(marketplaceOffers)
      .where(eq(marketplaceOffers.id, offerId))
      .for("update");
    if (!offer) throw new MarketplaceError("Offer not found.");
    if (offer.companyId !== companyId) {
      throw new MarketplaceError("That offer does not belong to your company.");
    }
    if (offer.status === "CLOSED" && status !== "CLOSED") {
      throw new MarketplaceError("A closed offer cannot be reopened. Create a new one instead.");
    }
    if (offer.status === status) return offer;

    const now = new Date();
    const [updated] = await tx
      .update(marketplaceOffers)
      .set({
        status,
        // PAUSED carries the clock the retention rule is measured from;
        // ACTIVE clears it; CLOSED keeps whatever it had as the record of why.
        pausedAt: status === "PAUSED" ? now : status === "ACTIVE" ? null : offer.pausedAt,
        closedAt: status === "CLOSED" ? now : null,
        updatedAt: now,
      })
      .where(eq(marketplaceOffers.id, offerId))
      .returning();

    return updated;
  });
}

export type OfferWithCompany = {
  offer: MarketplaceOffer;
  companyName: string;
  companyUsername: string;
  companyOwnerUserId: string;
};

export async function getOfferById(offerId: string): Promise<OfferWithCompany | null> {
  const [row] = await db
    .select({
      offer: marketplaceOffers,
      companyName: companies.name,
      companyUsername: companies.username,
      companyOwnerUserId: companies.ownerUserId,
    })
    .from(marketplaceOffers)
    .innerJoin(companies, eq(companies.id, marketplaceOffers.companyId))
    .where(eq(marketplaceOffers.id, offerId))
    .limit(1);
  return row ?? null;
}

export async function getOffersForCompany(
  companyId: string,
  limit = 200,
): Promise<MarketplaceOffer[]> {
  return db
    .select()
    .from(marketplaceOffers)
    .where(eq(marketplaceOffers.companyId, companyId))
    .orderBy(desc(marketplaceOffers.createdAt))
    .limit(limit);
}

// ===========================================================================
// BROWSE / SEARCH (spec §13)
// ===========================================================================

export type BrowseFilters = {
  /** Free text: matched against offer title, description and company name. */
  q?: string | null;
  category?: string | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  /** Restrict to one company handle. */
  companyUsername?: string | null;
  sort?: "NEWEST" | "PRICE_ASC" | "PRICE_DESC";
  page?: number;
  pageSize?: number;
};

export type BrowseResult = {
  rows: OfferWithCompany[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

/**
 * Paginated, server-side browse over ACTIVE offers from tradeable companies.
 *
 * PAUSED offers are invisible here and CLOSED ones are gone entirely, which is
 * the whole visibility rule (§12). Sorting defaults to newest first so the
 * `(status, created_at)` index Phase A created does the ordering.
 *
 * Nothing about the query is recorded anywhere.
 */
export async function browseOffers(filters: BrowseFilters = {}): Promise<BrowseResult> {
  const pageSize = Math.min(
    Math.max(Math.trunc(filters.pageSize ?? MARKETPLACE_BROWSE_PAGE_SIZE), 1),
    50,
  );
  const page = Math.max(Math.trunc(filters.page ?? 1), 1);

  const conditions: SQL<unknown>[] = [
    eq(marketplaceOffers.status, "ACTIVE") as SQL<unknown>,
    companyTradeableSql(),
  ];

  const q = cleanText(filters.q, 120);
  if (q.length > 0) {
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    conditions.push(
      or(
        sql`${marketplaceOffers.title} ILIKE ${like}`,
        sql`${marketplaceOffers.description} ILIKE ${like}`,
        sql`${marketplaceOffers.category} ILIKE ${like}`,
        sql`${companies.name} ILIKE ${like}`,
        sql`${companies.username} ILIKE ${like}`,
      ) as SQL<unknown>,
    );
  }

  const category = cleanText(filters.category, MARKETPLACE_CATEGORY_MAX_LENGTH);
  if (category.length > 0) {
    conditions.push(sql`lower(${marketplaceOffers.category}) = ${category.toLowerCase()}`);
  }

  const companyUsername = cleanText(filters.companyUsername, 24).toLowerCase().replace(/^@/, "");
  if (companyUsername.length > 0) {
    conditions.push(eq(companies.username, companyUsername) as SQL<unknown>);
  }

  if (typeof filters.minPrice === "number" && Number.isFinite(filters.minPrice)) {
    conditions.push(gte(marketplaceOffers.unitPrice, Math.trunc(filters.minPrice)) as SQL<unknown>);
  }
  if (typeof filters.maxPrice === "number" && Number.isFinite(filters.maxPrice)) {
    conditions.push(lte(marketplaceOffers.unitPrice, Math.trunc(filters.maxPrice)) as SQL<unknown>);
  }

  const where = and(...conditions) as SQL<unknown>;

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(marketplaceOffers)
    .innerJoin(companies, eq(companies.id, marketplaceOffers.companyId))
    .where(where);
  const total = countRow?.count ?? 0;

  const orderBy =
    filters.sort === "PRICE_ASC"
      ? [asc(marketplaceOffers.unitPrice), desc(marketplaceOffers.createdAt)]
      : filters.sort === "PRICE_DESC"
        ? [desc(marketplaceOffers.unitPrice), desc(marketplaceOffers.createdAt)]
        : [desc(marketplaceOffers.createdAt)];

  const rows = await db
    .select({
      offer: marketplaceOffers,
      companyName: companies.name,
      companyUsername: companies.username,
      companyOwnerUserId: companies.ownerUserId,
    })
    .from(marketplaceOffers)
    .innerJoin(companies, eq(companies.id, marketplaceOffers.companyId))
    .where(where)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    rows,
    total,
    page,
    pageSize,
    pageCount: Math.max(Math.ceil(total / pageSize), 1),
  };
}

/** The categories that currently have at least one visible offer. */
export async function listOfferCategories(limit = 40): Promise<string[]> {
  const rows = await db
    .selectDistinct({ category: marketplaceOffers.category })
    .from(marketplaceOffers)
    .innerJoin(companies, eq(companies.id, marketplaceOffers.companyId))
    .where(and(eq(marketplaceOffers.status, "ACTIVE"), companyTradeableSql()))
    .orderBy(asc(marketplaceOffers.category))
    .limit(limit);
  return rows.map((r) => r.category);
}

// ===========================================================================
// ORDERS (spec §14)
// ===========================================================================

/**
 * Places an order against an offer.
 *
 * The buyer is a WalletRef the server established from the session's acting
 * context. Quantity is the only number the caller supplies, and it is checked
 * against the offer's own stock under the offer's row lock.
 */
export async function placeOrder(params: {
  offerId: string;
  buyer: WalletRef;
  quantity: number;
}): Promise<MarketplaceOrder> {
  const { offerId, buyer } = params;
  const quantity = Math.trunc(params.quantity);

  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new MarketplaceError("Order at least 1.");
  }
  if (quantity > MARKETPLACE_MAX_QUANTITY) {
    throw new MarketplaceError("That quantity is too large.");
  }
  if (buyer.kind === "GOVERNMENT") {
    throw new MarketplaceError("The Government does not place marketplace orders.");
  }

  try {
    return await db.transaction(async (tx) => {
      // THE SERIALISATION POINT. Every order against this offer — and every
      // cancellation and expiry that returns stock to it — takes this lock
      // first, so availability is read and written by one transaction at a
      // time. This is what makes "exactly one of two concurrent orders for the
      // last unit succeeds" a property of the design rather than a hope.
      const [offer] = await tx
        .select()
        .from(marketplaceOffers)
        .where(eq(marketplaceOffers.id, offerId))
        .for("update");
      if (!offer) throw new MarketplaceError("That listing no longer exists.");

      if (offer.status === "PAUSED") {
        throw new MarketplaceError("This listing is paused and cannot be ordered right now.");
      }
      if (offer.status === "CLOSED") {
        throw new MarketplaceError("This listing has been closed.");
      }

      const [seller] = await tx
        .select()
        .from(companies)
        .where(eq(companies.id, offer.companyId))
        .limit(1);
      if (!seller) throw new MarketplaceError("The seller no longer exists.");
      if (!canCompanyTrade(seller)) {
        throw new MarketplaceError("This seller cannot take orders right now.");
      }

      const sellerWallet = companyWallet(seller.id);
      if (sameWallet(sellerWallet, buyer)) {
        throw new MarketplaceError("A company cannot order its own listing.");
      }

      // The buyer must be able to spend: the wallet's own status, and for a
      // company wallet its owner's status too (same rule as payments.ts).
      if (buyer.kind === "USER") {
        const [row] = await tx.select().from(users).where(eq(users.id, buyer.id)).limit(1);
        if (!row) throw new MarketplaceError("Your account could not be read.");
        if (!canUserSend(row)) {
          throw new MarketplaceError("Your account cannot place orders right now.");
        }
      } else {
        const [row] = await tx.select().from(companies).where(eq(companies.id, buyer.id)).limit(1);
        if (!row) throw new MarketplaceError("Your company could not be read.");
        if (!canCompanyTrade(row)) {
          throw new MarketplaceError("This company cannot place orders right now.");
        }
        const [owner] = await tx.select().from(users).where(eq(users.id, row.ownerUserId)).limit(1);
        if (!owner || !canUserSend(owner)) {
          throw new MarketplaceError("The company owner's account cannot transact right now.");
        }
      }

      // NO DUPLICATE ORDER. Read under the offer lock, so it cannot race; the
      // partial unique indexes are the database's independent guarantee and
      // would reject the insert even without this check.
      const [existing] = await tx
        .select({ id: marketplaceOrders.id, orderNumber: marketplaceOrders.orderNumber })
        .from(marketplaceOrders)
        .where(
          and(
            eq(marketplaceOrders.offerId, offerId),
            buyer.kind === "USER"
              ? eq(marketplaceOrders.buyerUserId, buyer.id)
              : eq(marketplaceOrders.buyerCompanyId, buyer.id),
            inArray(marketplaceOrders.status, [...OPEN_ORDER_STATUSES]),
          ),
        )
        .limit(1);
      if (existing) {
        throw new MarketplaceError(
          `You already have an open order for this listing (${existing.orderNumber}). Settle or cancel it first.`,
        );
      }

      // RESERVE THE STOCK. Conditional update: it can only succeed if the
      // stock is genuinely there, so it can never leave a negative quantity.
      if (offer.quantityAvailable !== null) {
        if (offer.quantityAvailable < quantity) {
          throw new MarketplaceError(
            offer.quantityAvailable === 0
              ? "This listing is out of stock."
              : `Only ${offer.quantityAvailable} left.`,
          );
        }
        const reserved = await tx
          .update(marketplaceOffers)
          .set({
            quantityAvailable: sql`${marketplaceOffers.quantityAvailable} - ${quantity}`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(marketplaceOffers.id, offerId),
              gte(marketplaceOffers.quantityAvailable, quantity),
            ),
          )
          .returning({ left: marketplaceOffers.quantityAvailable });
        if (reserved.length === 0) {
          throw new MarketplaceError("That quantity is no longer available.");
        }
      }

      const orderNumber = await nextOrderNumber(tx);
      const expiresAt = new Date(
        Date.now() + MARKETPLACE_ORDER_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
      );

      const [order] = await tx
        .insert(marketplaceOrders)
        .values({
          orderNumber,
          offerId: offer.id,
          sellerCompanyId: seller.id,
          buyerType: buyer.kind,
          buyerUserId: buyer.kind === "USER" ? buyer.id : null,
          buyerCompanyId: buyer.kind === "COMPANY" ? buyer.id : null,
          quantity,
          // PRICE SNAPSHOT: what the buyer saw is what they owe.
          unitPrice: offer.unitPrice,
          subtotal: offer.unitPrice * quantity,
          status: "PENDING",
          expiresAt,
        })
        .returning();

      await notifyUser(
        tx,
        seller.ownerUserId,
        "ORDER_RECEIVED",
        `${seller.name} received order ${orderNumber} — ${quantity} × ${offer.title} (${(offer.unitPrice * quantity).toLocaleString()} Aeros).`,
        `/my-company/orders`,
      );

      return order;
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new MarketplaceError(
        "You already have an open order for this listing. Settle or cancel it first.",
      );
    }
    throw e;
  }
}

/** Returns reserved stock to an offer. Only ever called from a status change. */
async function returnStock(tx: Tx, order: MarketplaceOrder): Promise<void> {
  const [offer] = await tx
    .select({ id: marketplaceOffers.id, quantityAvailable: marketplaceOffers.quantityAvailable })
    .from(marketplaceOffers)
    .where(eq(marketplaceOffers.id, order.offerId))
    .for("update");
  // An unlimited offer never reserved anything, so there is nothing to give back.
  if (!offer || offer.quantityAvailable === null) return;

  await tx
    .update(marketplaceOffers)
    .set({
      quantityAvailable: sql`${marketplaceOffers.quantityAvailable} + ${order.quantity}`,
      updatedAt: new Date(),
    })
    .where(eq(marketplaceOffers.id, order.offerId));
}

/** Seller accepts a PENDING order. */
export async function acceptOrder(params: {
  orderId: string;
  sellerCompanyId: string;
}): Promise<MarketplaceOrder> {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, params.orderId);
    if (order.sellerCompanyId !== params.sellerCompanyId) {
      throw new MarketplaceError("That order was not placed with your company.");
    }
    if (order.status !== "PENDING") {
      throw new MarketplaceError(`This order is ${order.status} and cannot be accepted.`);
    }

    const [updated] = await tx
      .update(marketplaceOrders)
      .set({ status: "ACCEPTED", acceptedAt: new Date() })
      .where(and(eq(marketplaceOrders.id, order.id), eq(marketplaceOrders.status, "PENDING")))
      .returning();
    if (!updated) throw new MarketplaceError("This order changed while you were accepting it.");

    const buyerInbox = await inboxUserId(tx, orderBuyerWallet(order));
    if (buyerInbox) {
      await notifyUser(
        tx,
        buyerInbox,
        "ORDER_ACCEPTED",
        `Order ${order.orderNumber} was accepted. The seller will send an invoice.`,
        `/market/orders/${order.id}`,
      );
    }

    return updated;
  });
}

/**
 * The buyer asks for the invoice. ACCEPTED → WAITING_FOR_INVOICE.
 *
 * Both states sit in the company's "Waiting for Invoice" bucket; the split
 * exists so the seller can see which buyers are actively waiting.
 */
export async function requestOrderInvoice(params: {
  orderId: string;
  buyer: WalletRef;
}): Promise<MarketplaceOrder> {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, params.orderId);
    if (!sameWallet(orderBuyerWallet(order), params.buyer)) {
      throw new MarketplaceError("This is not your order.");
    }
    if (order.status === "WAITING_FOR_INVOICE") return order;
    if (order.status !== "ACCEPTED") {
      throw new MarketplaceError(`This order is ${order.status}; no invoice can be requested.`);
    }

    const [updated] = await tx
      .update(marketplaceOrders)
      .set({ status: "WAITING_FOR_INVOICE" })
      .where(and(eq(marketplaceOrders.id, order.id), eq(marketplaceOrders.status, "ACCEPTED")))
      .returning();
    if (!updated) throw new MarketplaceError("This order changed while you were requesting.");

    const [seller] = await tx
      .select({ ownerUserId: companies.ownerUserId, name: companies.name })
      .from(companies)
      .where(eq(companies.id, order.sellerCompanyId))
      .limit(1);
    if (seller) {
      await notifyUser(
        tx,
        seller.ownerUserId,
        "ORDER_INVOICE_REQUESTED",
        `The buyer on order ${order.orderNumber} is waiting for your invoice.`,
        `/my-company/orders`,
      );
    }

    return updated;
  });
}

async function lockOrder(tx: Tx, orderId: string): Promise<MarketplaceOrder> {
  const [order] = await tx
    .select()
    .from(marketplaceOrders)
    .where(eq(marketplaceOrders.id, orderId))
    .for("update");
  if (!order) throw new MarketplaceError("Order not found.");
  return order;
}

/**
 * Raises THE invoice for an accepted order and moves it to PAYMENT_DUE.
 *
 * The invoice comes from the Phase B engine (`createInvoiceInTx`) inside this
 * transaction. Nothing about the amount is taken from a caller: quantity and
 * unit price are the order's own snapshots, so re-pricing the offer after the
 * order was placed cannot change what this invoice asks for.
 *
 * `deriveCompanySettlement` is called here as well, purely to ASSERT at this
 * layer that the destination the eventual payment will use is the seller
 * company's wallet and not its owner's. The payment re-derives and re-asserts
 * it again (src/lib/settlement.ts, src/lib/payments.ts); there is no parameter
 * anywhere on this path through which a destination could be supplied.
 */
export async function issueInvoiceForOrder(params: {
  orderId: string;
  sellerCompanyId: string;
  dueAt?: Date | null;
  note?: string | null;
}): Promise<{ order: MarketplaceOrder; invoice: Invoice }> {
  try {
    return await db.transaction(async (tx) => {
      const order = await lockOrder(tx, params.orderId);
      if (order.sellerCompanyId !== params.sellerCompanyId) {
        throw new MarketplaceError("That order was not placed with your company.");
      }
      if (order.invoiceId) {
        throw new MarketplaceError("An invoice has already been raised for this order.");
      }
      if (order.status !== "ACCEPTED" && order.status !== "WAITING_FOR_INVOICE") {
        throw new MarketplaceError(
          order.status === "PENDING"
            ? "Accept this order before invoicing it."
            : `This order is ${order.status} and cannot be invoiced.`,
        );
      }
      if (order.expiresAt.getTime() <= Date.now()) {
        throw new MarketplaceError("This order has expired.");
      }

      const [seller] = await tx
        .select()
        .from(companies)
        .where(eq(companies.id, order.sellerCompanyId))
        .limit(1);
      if (!seller) throw new MarketplaceError("The seller no longer exists.");

      // The destination the payment will use, derived from the ORDER's own
      // seller column by the settlement module, and asserted to be that
      // company's wallet. If anything ever made these disagree, no invoice is
      // raised and no order moves.
      const destination = await deriveCompanySettlement(tx, order.sellerCompanyId);
      assertSettlementDestination(destination, companyWallet(seller.id));

      const [offer] = await tx
        .select({ title: marketplaceOffers.title, description: marketplaceOffers.description })
        .from(marketplaceOffers)
        .where(eq(marketplaceOffers.id, order.offerId))
        .limit(1);

      const buyerWallet = orderBuyerWallet(order);
      const { recipientType, username } = await recipientTypeAndHandleFor(tx, buyerWallet);

      const invoice = await createInvoiceInTx(tx, {
        company: seller,
        recipientType,
        recipientUsername: username,
        itemName: offer?.title ?? `Order ${order.orderNumber}`,
        description: offer?.description ?? null,
        quantity: order.quantity,
        unitPrice: order.unitPrice,
        note: cleanText(params.note, 500) || `Marketplace order ${order.orderNumber}`,
        dueAt: params.dueAt ?? null,
        sourceOrderId: order.id,
        taxContext: "MARKETPLACE_ORDER",
      });

      const [updated] = await tx
        .update(marketplaceOrders)
        .set({ status: "PAYMENT_DUE", invoiceId: invoice.id })
        .where(
          and(
            eq(marketplaceOrders.id, order.id),
            inArray(marketplaceOrders.status, ["ACCEPTED", "WAITING_FOR_INVOICE"]),
            isNull(marketplaceOrders.invoiceId),
          ),
        )
        .returning();
      if (!updated) {
        throw new MarketplaceError("This order changed while the invoice was being raised.");
      }

      const buyerInbox = await inboxUserId(tx, buyerWallet);
      if (buyerInbox) {
        await notifyUser(
          tx,
          buyerInbox,
          "ORDER_PAYMENT_DUE",
          `Invoice ${invoice.invoiceNumber} for order ${order.orderNumber} is ready — ${invoice.total.toLocaleString()} Aeros.`,
          `/invoices/${invoice.id}`,
        );
      }

      return { order: updated, invoice };
    });
  } catch (e) {
    // The DB's own one-invoice-per-order guarantee, turned into a message.
    if (isUniqueViolation(e)) {
      throw new MarketplaceError("An invoice has already been raised for this order.");
    }
    throw e;
  }
}

/**
 * Marks a PAID order COMPLETED.
 *
 * Either side may confirm: the seller because they delivered, the buyer because
 * they received. The transition is guarded on PAID, so an unpaid, cancelled or
 * expired order can never be completed, and completing twice is a no-op rather
 * than an error.
 */
export async function completeOrder(params: {
  orderId: string;
  actor: WalletRef;
}): Promise<MarketplaceOrder> {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, params.orderId);

    const isBuyer = sameWallet(orderBuyerWallet(order), params.actor);
    const isSeller =
      params.actor.kind === "COMPANY" && params.actor.id === order.sellerCompanyId;
    if (!isBuyer && !isSeller) {
      throw new MarketplaceError("Only the buyer or the seller can complete this order.");
    }

    if (order.status === "COMPLETED") return order;
    if (order.status !== "PAID") {
      throw new MarketplaceError(
        order.status === "PAYMENT_DUE"
          ? "This order has not been paid yet."
          : `This order is ${order.status} and cannot be completed.`,
      );
    }

    const [updated] = await tx
      .update(marketplaceOrders)
      .set({ status: "COMPLETED", completedAt: new Date() })
      .where(and(eq(marketplaceOrders.id, order.id), eq(marketplaceOrders.status, "PAID")))
      .returning();
    if (!updated) throw new MarketplaceError("This order changed while you were completing it.");

    const otherInbox = await inboxUserId(
      tx,
      isBuyer ? companyWallet(order.sellerCompanyId) : orderBuyerWallet(order),
    );
    if (otherInbox) {
      await notifyUser(
        tx,
        otherInbox,
        "ORDER_COMPLETED",
        `Order ${order.orderNumber} is complete.`,
        isBuyer ? `/my-company/orders` : `/market/orders/${order.id}`,
      );
    }

    return updated;
  });
}

/**
 * Cancels an unsettled order, returning the reserved stock and cancelling any
 * invoice that was already raised for it — all in one transaction.
 *
 * A PAID order is NOT cancellable: money has moved and the ledger is
 * append-only, so putting that right is a refund (`reverseTransaction` in
 * src/lib/reversals.ts), never a status edit.
 */
export async function cancelOrder(params: {
  orderId: string;
  actor: WalletRef;
  reason?: string | null;
}): Promise<MarketplaceOrder> {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, params.orderId);

    const isBuyer = sameWallet(orderBuyerWallet(order), params.actor);
    const isSeller =
      params.actor.kind === "COMPANY" && params.actor.id === order.sellerCompanyId;
    if (!isBuyer && !isSeller) {
      throw new MarketplaceError("Only the buyer or the seller can cancel this order.");
    }

    if (order.status === "CANCELLED") return order;
    if (order.status === "PAID" || order.status === "COMPLETED") {
      throw new MarketplaceError(
        "This order has already been paid. A refund has to be issued instead of a cancellation.",
      );
    }
    if (order.status === "EXPIRED") {
      throw new MarketplaceError("This order has already expired.");
    }

    const [updated] = await tx
      .update(marketplaceOrders)
      .set({
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelReason: cleanText(params.reason, 500) || null,
      })
      .where(
        and(
          eq(marketplaceOrders.id, order.id),
          inArray(marketplaceOrders.status, [...OPEN_ORDER_STATUSES]),
        ),
      )
      .returning();
    // Losing this guarded update means something else already moved the order,
    // so we must NOT return its stock a second time.
    if (!updated) throw new MarketplaceError("This order changed while you were cancelling it.");

    await returnStock(tx, order);

    // An unpaid invoice for a cancelled order must not stay payable. Guarded on
    // PENDING, so a race that paid it first loses this update and the whole
    // cancellation rolls back rather than leaving a paid invoice on a cancelled
    // order.
    if (order.invoiceId) {
      const [inv] = await tx
        .select({ status: invoices.status, invoiceNumber: invoices.invoiceNumber })
        .from(invoices)
        .where(eq(invoices.id, order.invoiceId))
        .for("update");
      if (inv && inv.status === "PAID") {
        throw new MarketplaceError(
          "The invoice for this order has just been paid; it can no longer be cancelled.",
        );
      }
      if (inv && inv.status === "PENDING") {
        await tx
          .update(invoices)
          .set({ status: "CANCELLED", cancelledAt: new Date() })
          .where(and(eq(invoices.id, order.invoiceId), eq(invoices.status, "PENDING")));
      }
    }

    const otherInbox = await inboxUserId(
      tx,
      isBuyer ? companyWallet(order.sellerCompanyId) : orderBuyerWallet(order),
    );
    if (otherInbox) {
      await notifyUser(
        tx,
        otherInbox,
        "ORDER_CANCELLED",
        `Order ${order.orderNumber} was cancelled${params.reason ? `: ${cleanText(params.reason, 200)}` : "."}`,
        isBuyer ? `/my-company/orders` : `/market/orders/${order.id}`,
      );
    }

    return updated;
  });
}

/**
 * Lapses unsettled orders whose expiry has passed, returning their stock.
 *
 * Lazy: called from the pages that show orders, because this app has no
 * scheduler yet. Cheap — the WHERE clause is served by
 * `marketplace_orders_open_expiry_idx` and matches nothing in the common case.
 */
export async function expireOverdueOrders(limit = 100): Promise<number> {
  const due = await db
    .select({ id: marketplaceOrders.id })
    .from(marketplaceOrders)
    .where(
      and(
        inArray(marketplaceOrders.status, [...OPEN_ORDER_STATUSES]),
        lte(marketplaceOrders.expiresAt, new Date()),
      ),
    )
    .limit(limit);

  let expired = 0;
  for (const row of due) {
    const done = await db.transaction(async (tx) => {
      const order = await lockOrder(tx, row.id);
      if (!OPEN_ORDER_STATUSES.includes(order.status as (typeof OPEN_ORDER_STATUSES)[number])) {
        return false;
      }
      if (order.expiresAt.getTime() > Date.now()) return false;

      const [updated] = await tx
        .update(marketplaceOrders)
        .set({ status: "EXPIRED" })
        .where(
          and(
            eq(marketplaceOrders.id, order.id),
            inArray(marketplaceOrders.status, [...OPEN_ORDER_STATUSES]),
          ),
        )
        .returning({ id: marketplaceOrders.id });
      if (!updated) return false;

      await returnStock(tx, order);

      if (order.invoiceId) {
        await tx
          .update(invoices)
          .set({ status: "EXPIRED" })
          .where(and(eq(invoices.id, order.invoiceId), eq(invoices.status, "PENDING")));
      }
      return true;
    });
    if (done) expired++;
  }
  return expired;
}

/** Expires ONE order if it is overdue. Used before a payment attempt. */
export async function expireOrderIfOverdue(orderId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!OPEN_ORDER_STATUSES.includes(order.status as (typeof OPEN_ORDER_STATUSES)[number])) {
      return false;
    }
    if (order.expiresAt.getTime() > Date.now()) return false;

    const [updated] = await tx
      .update(marketplaceOrders)
      .set({ status: "EXPIRED" })
      .where(
        and(
          eq(marketplaceOrders.id, orderId),
          inArray(marketplaceOrders.status, [...OPEN_ORDER_STATUSES]),
        ),
      )
      .returning({ id: marketplaceOrders.id });
    if (!updated) return false;

    await returnStock(tx, order);
    if (order.invoiceId) {
      await tx
        .update(invoices)
        .set({ status: "EXPIRED" })
        .where(and(eq(invoices.id, order.invoiceId), eq(invoices.status, "PENDING")));
    }
    return true;
  });
}

// ===========================================================================
// READ PATHS (spec §15 — the company's order areas)
// ===========================================================================

export type OrderRow = {
  order: MarketplaceOrder;
  offerTitle: string;
  sellerName: string;
  sellerUsername: string;
  buyerLabel: string;
  buyerHandle: string;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  invoiceTotal: number | null;
  paidTxRef: string | null;
};

const orderSelection = {
  order: marketplaceOrders,
  offerTitle: marketplaceOffers.title,
  sellerName: companies.name,
  sellerUsername: companies.username,
  invoiceNumber: invoices.invoiceNumber,
  invoiceStatus: invoices.status,
  invoiceTotal: invoices.total,
  paidTxRef: invoices.paidTxRef,
} as const;

async function labelBuyers(
  rows: {
    order: MarketplaceOrder;
    offerTitle: string;
    sellerName: string;
    sellerUsername: string;
    invoiceNumber: string | null;
    invoiceStatus: string | null;
    invoiceTotal: number | null;
    paidTxRef: string | null;
  }[],
): Promise<OrderRow[]> {
  const userIds = [...new Set(rows.map((r) => r.order.buyerUserId).filter((v): v is string => !!v))];
  const companyIds = [
    ...new Set(rows.map((r) => r.order.buyerCompanyId).filter((v): v is string => !!v)),
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

  return rows.map((r) => {
    const u = r.order.buyerUserId ? userMap.get(r.order.buyerUserId) : null;
    const c = r.order.buyerCompanyId ? companyMap.get(r.order.buyerCompanyId) : null;
    return {
      ...r,
      buyerLabel: u?.displayName ?? c?.name ?? "Unknown buyer",
      buyerHandle: u?.username ?? c?.username ?? "unknown",
    };
  });
}

/** Every order placed with a company, newest first. */
export async function getOrdersForCompany(companyId: string, limit = 200): Promise<OrderRow[]> {
  const rows = await db
    .select(orderSelection)
    .from(marketplaceOrders)
    .innerJoin(marketplaceOffers, eq(marketplaceOffers.id, marketplaceOrders.offerId))
    .innerJoin(companies, eq(companies.id, marketplaceOrders.sellerCompanyId))
    .leftJoin(invoices, eq(invoices.id, marketplaceOrders.invoiceId))
    .where(eq(marketplaceOrders.sellerCompanyId, companyId))
    .orderBy(desc(marketplaceOrders.createdAt))
    .limit(limit);
  return labelBuyers(rows);
}

/** Every order placed BY the wallet the viewer is acting as. */
export async function getOrdersForBuyer(buyer: WalletRef, limit = 200): Promise<OrderRow[]> {
  if (buyer.kind === "GOVERNMENT") return [];
  const rows = await db
    .select(orderSelection)
    .from(marketplaceOrders)
    .innerJoin(marketplaceOffers, eq(marketplaceOffers.id, marketplaceOrders.offerId))
    .innerJoin(companies, eq(companies.id, marketplaceOrders.sellerCompanyId))
    .leftJoin(invoices, eq(invoices.id, marketplaceOrders.invoiceId))
    .where(
      buyer.kind === "USER"
        ? eq(marketplaceOrders.buyerUserId, buyer.id)
        : eq(marketplaceOrders.buyerCompanyId, buyer.id),
    )
    .orderBy(desc(marketplaceOrders.createdAt))
    .limit(limit);
  return labelBuyers(rows);
}

export async function getOrderById(orderId: string): Promise<OrderRow | null> {
  const rows = await db
    .select(orderSelection)
    .from(marketplaceOrders)
    .innerJoin(marketplaceOffers, eq(marketplaceOffers.id, marketplaceOrders.offerId))
    .innerJoin(companies, eq(companies.id, marketplaceOrders.sellerCompanyId))
    .leftJoin(invoices, eq(invoices.id, marketplaceOrders.invoiceId))
    .where(eq(marketplaceOrders.id, orderId))
    .limit(1);
  if (rows.length === 0) return null;
  const [labelled] = await labelBuyers(rows);
  return labelled;
}

/** Counts for the company dashboard's order areas (§15). */
export type CompanyOrderCounts = {
  total: number;
  pending: number;
  waitingForInvoice: number;
  paymentDue: number;
  paid: number;
  completed: number;
};

export async function getCompanyOrderCounts(companyId: string): Promise<CompanyOrderCounts> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      pending: sql<number>`count(*) FILTER (WHERE ${marketplaceOrders.status} = 'PENDING')::int`,
      waitingForInvoice: sql<number>`count(*) FILTER (WHERE ${marketplaceOrders.status} IN ('ACCEPTED','WAITING_FOR_INVOICE'))::int`,
      paymentDue: sql<number>`count(*) FILTER (WHERE ${marketplaceOrders.status} = 'PAYMENT_DUE')::int`,
      paid: sql<number>`count(*) FILTER (WHERE ${marketplaceOrders.status} = 'PAID')::int`,
      completed: sql<number>`count(*) FILTER (WHERE ${marketplaceOrders.status} = 'COMPLETED')::int`,
    })
    .from(marketplaceOrders)
    .where(eq(marketplaceOrders.sellerCompanyId, companyId));

  return (
    row ?? {
      total: 0,
      pending: 0,
      waitingForInvoice: 0,
      paymentDue: 0,
      paid: 0,
      completed: 0,
    }
  );
}

/** Who may look at an order: its buyer, or the seller company's owner. */
export function orderViewerRole(
  order: MarketplaceOrder,
  viewer: { userId: string; wallet: WalletRef; ownedCompanyIds: string[] },
): { canView: boolean; isBuyer: boolean; isSeller: boolean; isSellerOwner: boolean } {
  const isBuyer =
    (order.buyerType === "USER" &&
      viewer.wallet.kind === "USER" &&
      viewer.wallet.id === order.buyerUserId) ||
    (order.buyerType === "COMPANY" &&
      viewer.wallet.kind === "COMPANY" &&
      viewer.wallet.id === order.buyerCompanyId);

  const isSeller =
    viewer.wallet.kind === "COMPANY" && viewer.wallet.id === order.sellerCompanyId;
  const isSellerOwner = viewer.ownedCompanyIds.includes(order.sellerCompanyId);
  const buyerCompanyOwned =
    order.buyerType === "COMPANY" &&
    !!order.buyerCompanyId &&
    viewer.ownedCompanyIds.includes(order.buyerCompanyId);
  const buyerIsViewer = order.buyerType === "USER" && order.buyerUserId === viewer.userId;

  return {
    canView: isBuyer || isSeller || isSellerOwner || buyerCompanyOwned || buyerIsViewer,
    isBuyer,
    isSeller,
    isSellerOwner,
  };
}

/** True when the seller company can still be paid (used by the pay screen). */
export async function sellerCanReceive(executor: Executor, companyId: string): Promise<boolean> {
  const [row] = await executor
    .select({ status: companies.status, suspendedUntil: companies.suspendedUntil })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return !!row && canCompanyReceive(row);
}

export { InvoiceError };
