/**
 * V3 PHASES C, D, E — MARKETPLACE, WANTED, CONTRACTS, PROMOTIONS
 *
 * Runs against a real Postgres database. Areas:
 *
 *   1.  OFFER LIFECYCLE — create, edit, pause (writes pausedAt), resume (clears
 *       it), close; a closed offer cannot be reopened.
 *   2.  BROWSE / SEARCH — keyword, category, price range, company filter,
 *       ordering and pagination, and the visibility rule (PAUSED hidden,
 *       CLOSED gone). Nothing about a search is stored.
 *   3.  ORDER → INVOICE → PAYMENT → COMPLETED, end to end, with the exact
 *       wallet movements and tax-on-top checked and the money landing in the
 *       COMPANY wallet.
 *   4.  CONCURRENCY — two buyers race for the last unit; exactly one wins.
 *   5.  REJECTIONS — duplicate order, duplicate invoice, duplicate payment,
 *       payment after cancellation, payment after expiry, ordering a paused or
 *       closed offer, over-quantity, ordering your own listing.
 *   6.  ANTI-TAX-ROUTING ON THE ORDER PATH — every route to making an order's
 *       settlement land in the owner's personal wallet is attempted and
 *       refused.
 *   7.  REFUNDS / REVERSALS — a new linked ledger row, the original untouched,
 *       no double refund.
 *   8.  WANTED — create, respond, one response per party, own-request refusal.
 *   9.  CONTRACTS — create, apply, one application per party, award, invoice,
 *       pay, complete; and the direct-to-person path.
 *   10. PROMOTIONS — approve, activate, the daily charge, its idempotency
 *       within one IST day, a fresh charge the next IST day, insufficient
 *       funds pausing instead of going negative, and the single global ACTIVE
 *       slot.
 *
 * The supply invariant (total supply = treasury + Σusers + Σcompanies) is
 * re-checked after every operation.
 */
import "dotenv/config";
import { db, pool } from "../../src/db/client";
import {
  companies,
  government,
  invoices,
  marketplaceContractApplications,
  marketplaceContracts,
  marketplaceOffers,
  marketplaceOrders,
  marketplaceWantedRequests,
  marketplaceWantedResponses,
  promotionCampaigns,
  registrationCodes,
  transactions,
  users,
} from "../../src/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";

import { transfer, transferInTx, PaymentError } from "../../src/lib/payments";
import {
  companyWallet,
  governmentWallet,
  userWallet,
  type WalletRef,
} from "../../src/lib/wallets";
import { payInvoice, getInvoiceById, InvoiceError } from "../../src/lib/invoices";
import {
  deriveCompanySettlement,
  deriveInvoiceSettlement,
  assertSettlementDestination,
  SettlementRoutingError,
} from "../../src/lib/settlement";
import {
  acceptOrder,
  browseOffers,
  cancelOrder,
  completeOrder,
  createOffer,
  expireOrderIfOverdue,
  getCompanyOrderCounts,
  getOfferById,
  getOrderById,
  getOrdersForBuyer,
  getOrdersForCompany,
  issueInvoiceForOrder,
  listOfferCategories,
  MarketplaceError,
  placeOrder,
  requestOrderInvoice,
  setOfferStatus,
  updateOffer,
} from "../../src/lib/marketplace";
import { reverseTransaction, ReversalError, isReversed } from "../../src/lib/reversals";
import {
  browseWantedRequests,
  closeWantedRequest,
  createWantedRequest,
  decideWantedResponse,
  getMyResponse,
  getResponsesForRequest,
  respondToWantedRequest,
  WantedError,
} from "../../src/lib/wanted";
import {
  applyForContract,
  awardContract,
  ContractError,
  createContract,
  getContractById,
  issueContractInvoice,
  payAwardedContractToUser,
} from "../../src/lib/contracts";
import {
  activatePromotion,
  cancelPromotion,
  createOfficialPromotion,
  getLiveAd,
  PromotionError,
  PromotionSlotTakenError,
  requestPromotion,
  reviewPromotion,
  runPromotionCharges,
  setPromotionPolicy,
} from "../../src/lib/promotions";
import { istDateKey } from "../../src/lib/datetime";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`PASS  ${label}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

async function expectError(label: string, fn: () => Promise<unknown>, substring: string) {
  try {
    await fn();
    failed++;
    console.log(`FAIL  ${label} — expected an error but it succeeded`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(substring)) {
      passed++;
      console.log(`PASS  ${label} — "${msg}"`);
    } else {
      failed++;
      console.log(`FAIL  ${label} — wrong error: "${msg}" (wanted "${substring}")`);
    }
  }
}

async function totals() {
  const [gov] = await db.select().from(government).limit(1);
  const [u] = await db.select({ s: sql<number>`coalesce(sum(balance),0)::int` }).from(users);
  const [c] = await db.select({ s: sql<number>`coalesce(sum(balance),0)::int` }).from(companies);
  return { treasury: gov.balance, supply: gov.totalSupply, accounted: gov.balance + u.s + c.s };
}

let baselineSupply = 0;

async function invariant(label: string) {
  const t = await totals();
  check(
    `INVARIANT after ${label}: supply = treasury + users + companies, and supply unchanged`,
    t.accounted === t.supply && t.supply === baselineSupply,
    t,
  );
}

async function balanceOfUser(id: string): Promise<number> {
  const [row] = await db.select({ b: users.balance }).from(users).where(eq(users.id, id));
  return row.b;
}
async function balanceOfCompany(id: string): Promise<number> {
  const [row] = await db.select({ b: companies.balance }).from(companies).where(eq(companies.id, id));
  return row.b;
}
async function treasuryBalance(): Promise<number> {
  const [row] = await db.select({ b: government.balance }).from(government).limit(1);
  return row.b;
}
async function offerRow(id: string) {
  const [row] = await db.select().from(marketplaceOffers).where(eq(marketplaceOffers.id, id));
  return row;
}
async function orderRow(id: string) {
  const [row] = await db.select().from(marketplaceOrders).where(eq(marketplaceOrders.id, id));
  return row;
}
async function invoiceRow(id: string) {
  const [row] = await db.select().from(invoices).where(eq(invoices.id, id));
  return row;
}
async function campaignRow(id: string) {
  const [row] = await db.select().from(promotionCampaigns).where(eq(promotionCampaigns.id, id));
  return row;
}
async function txByRef(ref: string) {
  const [row] = await db.select().from(transactions).where(eq(transactions.txRef, ref));
  return row;
}

const RUN = Date.now().toString(36).slice(-5);
const FIXTURE_PREFIX = "v3m_";

/**
 * Sweeps fixture balances back to the treasury with REAL transfers, and frees
 * the single global promotion slot so the suite is repeatable. Never writes a
 * balance directly: that would mint Aeros the supply does not know about.
 */
async function sweepFixtures(): Promise<void> {
  // Free the ad slot: a leftover ACTIVE campaign from an aborted run would make
  // every activation in this suite fail on the single-slot index.
  await db
    .update(promotionCampaigns)
    .set({ status: "CANCELLED", cancelledAt: new Date() })
    .where(
      and(
        inArray(promotionCampaigns.status, ["PENDING", "APPROVED", "ACTIVE", "PAUSED"]),
        // Only this suite's leavings: a fixture company's campaign, or an
        // official one (no company) — never a real company's live campaign.
        sql`(${promotionCampaigns.companyId} IS NULL
             OR ${promotionCampaigns.companyId} IN (
               SELECT id FROM companies WHERE username LIKE ${`${FIXTURE_PREFIX}%`}))`,
      ),
    );

  const [g] = await db.select({ id: government.id }).from(government).limit(1);
  const treasury = governmentWallet(g.id);

  const fixtureUsers = await db
    .select({ id: users.id, balance: users.balance })
    .from(users)
    .where(sql`${users.username} LIKE ${`${FIXTURE_PREFIX}%`}`);
  for (const row of fixtureUsers) {
    if (row.balance > 0) {
      await transfer({
        from: userWallet(row.id),
        to: treasury,
        amount: row.balance,
        forcedTaxRateBp: 0,
        type: "GOVERNMENT_RECEIPT",
        reason: "V3 marketplace fixture sweep",
        skipSenderCheck: true,
      });
    }
  }

  const fixtureCompanies = await db
    .select({ id: companies.id, balance: companies.balance })
    .from(companies)
    .where(sql`${companies.username} LIKE ${`${FIXTURE_PREFIX}%`}`);
  for (const row of fixtureCompanies) {
    if (row.balance > 0) {
      await transfer({
        from: companyWallet(row.id),
        to: treasury,
        amount: row.balance,
        forcedTaxRateBp: 0,
        type: "GOVERNMENT_RECEIPT",
        reason: "V3 marketplace fixture sweep",
        skipSenderCheck: true,
      });
    }
  }
}

async function makeUser(name: string, balance: number) {
  let code;
  for (let i = 0; i < 40; i++) {
    try {
      const [row] = await db
        .insert(registrationCodes)
        .values({ code: String(Math.floor(1000 + Math.random() * 8999)) })
        .returning();
      code = row;
      break;
    } catch {
      /* collision, retry */
    }
  }
  if (!code) throw new Error("could not allocate a registration code");

  const [user] = await db
    .insert(users)
    .values({
      username: name,
      passwordHash: await bcrypt.hash("TestPassword123", 4),
      displayName: `Test ${name}`,
      balance: 0,
      registrationCodeId: code.id,
    })
    .returning();

  if (balance > 0) {
    const [g] = await db.select({ id: government.id }).from(government).limit(1);
    await transfer({
      from: governmentWallet(g.id),
      to: userWallet(user.id),
      amount: balance,
      forcedTaxRateBp: 0,
      type: "GOVERNMENT_FUNDING",
      reason: "V3 marketplace test fixture",
    });
  }

  const [funded] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  return funded;
}

async function makeCompany(params: {
  ownerUserId: string;
  name: string;
  username: string;
  balance: number;
  status?: "APPROVED" | "SUSPENDED" | "REVOKED" | "PENDING";
}) {
  const [company] = await db
    .insert(companies)
    .values({
      ownerUserId: params.ownerUserId,
      name: params.name,
      username: params.username,
      category: "Testing",
      reason: "V3 marketplace tests",
      description: "Fixture company for the V3 Phase C/D/E suite.",
      status: params.status ?? "APPROVED",
      balance: 0,
    })
    .returning();

  if (params.balance > 0) {
    const [g] = await db.select({ id: government.id }).from(government).limit(1);
    await transfer({
      from: governmentWallet(g.id),
      to: companyWallet(company.id),
      amount: params.balance,
      forcedTaxRateBp: 0,
      type: "COMPANY_FUNDING",
      reason: "V3 marketplace test fixture",
      skipReceiverCheck: true,
    });
  }

  const [funded] = await db.select().from(companies).where(eq(companies.id, company.id)).limit(1);
  return funded;
}

/** Drains a company wallet to the treasury with a real transfer. */
async function drainCompany(companyId: string): Promise<void> {
  const balance = await balanceOfCompany(companyId);
  if (balance <= 0) return;
  const [g] = await db.select({ id: government.id }).from(government).limit(1);
  await transfer({
    from: companyWallet(companyId),
    to: governmentWallet(g.id),
    amount: balance,
    forcedTaxRateBp: 0,
    type: "GOVERNMENT_RECEIPT",
    reason: "V3 marketplace test: drain",
    skipSenderCheck: true,
  });
}

async function main() {
  const [gov] = await db.select().from(government).limit(1);
  if (!gov) {
    console.log("FAIL  fixtures — this suite needs the government row");
    process.exit(1);
  }

  const start = await totals();
  baselineSupply = start.supply;
  check("fixtures: supply invariant holds before anything runs", start.accounted === start.supply, start);

  console.log("\n=== FIXTURES ===\n");
  await sweepFixtures();

  const sellerOwner = await makeUser(`${FIXTURE_PREFIX}sown_${RUN}`, 400);
  const buyerA = await makeUser(`${FIXTURE_PREFIX}bya_${RUN}`, 6000);
  const buyerB = await makeUser(`${FIXTURE_PREFIX}byb_${RUN}`, 6000);
  const buyerCoOwner = await makeUser(`${FIXTURE_PREFIX}bcown_${RUN}`, 300);
  const worker = await makeUser(`${FIXTURE_PREFIX}work_${RUN}`, 100);

  const seller = await makeCompany({
    ownerUserId: sellerOwner.id,
    name: `Seller Co ${RUN}`,
    username: `${FIXTURE_PREFIX}sell_${RUN}`,
    balance: 200,
  });
  const seller2 = await makeCompany({
    ownerUserId: sellerOwner.id,
    name: `Second Seller ${RUN}`,
    username: `${FIXTURE_PREFIX}sel2_${RUN}`,
    balance: 2000,
  });
  const buyerCompany = await makeCompany({
    ownerUserId: buyerCoOwner.id,
    name: `Buyer Co ${RUN}`,
    username: `${FIXTURE_PREFIX}buyc_${RUN}`,
    balance: 4000,
  });

  await invariant("fixture setup");

  // ==========================================================================
  console.log("\n=== 1. OFFER LIFECYCLE (§§11,12) ===\n");
  // ==========================================================================

  const mainOffer = await createOffer({
    company: seller,
    input: {
      title: `Handwoven Scarf ${RUN}`,
      description: "A warm handwoven scarf in undyed wool.",
      category: "Clothing",
      unitPrice: 200,
      quantityAvailable: 10,
    },
  });
  check(
    "offer: created ACTIVE with its price, category and stock",
    mainOffer.status === "ACTIVE" &&
      mainOffer.unitPrice === 200 &&
      mainOffer.quantityAvailable === 10 &&
      mainOffer.category === "Clothing" &&
      mainOffer.pausedAt === null,
    mainOffer,
  );

  const unlimitedOffer = await createOffer({
    company: seller,
    input: {
      title: `Lesson booking ${RUN}`,
      description: "One hour of weaving tuition, booked by arrangement.",
      category: "Services",
      unitPrice: 50,
      quantityAvailable: null,
    },
  });
  check(
    "offer: null availability means unlimited",
    unlimitedOffer.quantityAvailable === null,
    unlimitedOffer,
  );

  await expectError(
    "offer: a zero price is refused",
    () =>
      createOffer({
        company: seller,
        input: { title: "Free", description: "x", category: "y", unitPrice: 0, quantityAvailable: 1 },
      }),
    "at least 1 Aeros",
  );
  await expectError(
    "offer: a fractional price is refused",
    () =>
      createOffer({
        company: seller,
        input: { title: "Half", description: "x", category: "y", unitPrice: 1.5, quantityAvailable: 1 },
      }),
    "whole number",
  );
  await expectError(
    "offer: a negative stock is refused",
    () =>
      createOffer({
        company: seller,
        input: { title: "Neg", description: "x", category: "y", unitPrice: 5, quantityAvailable: -1 },
      }),
    "whole number",
  );
  await expectError(
    "offer: another company cannot edit this offer",
    () =>
      updateOffer({
        offerId: mainOffer.id,
        companyId: buyerCompany.id,
        input: {
          title: "Hijacked",
          description: "x",
          category: "y",
          unitPrice: 1,
          quantityAvailable: 1,
        },
      }),
    "does not belong to your company",
  );

  const paused = await setOfferStatus({
    offerId: unlimitedOffer.id,
    companyId: seller.id,
    status: "PAUSED",
  });
  check(
    "offer: pausing writes pausedAt",
    paused.status === "PAUSED" && paused.pausedAt !== null,
    { status: paused.status, pausedAt: paused.pausedAt },
  );

  const resumed = await setOfferStatus({
    offerId: unlimitedOffer.id,
    companyId: seller.id,
    status: "ACTIVE",
  });
  check(
    "offer: resuming clears pausedAt, so the 14-day clock restarts from scratch",
    resumed.status === "ACTIVE" && resumed.pausedAt === null,
    { status: resumed.status, pausedAt: resumed.pausedAt },
  );

  const closableOffer = await createOffer({
    company: seller,
    input: {
      title: `Discontinued Mug ${RUN}`,
      description: "A mug we no longer make.",
      category: "Homeware",
      unitPrice: 80,
      quantityAvailable: 3,
    },
  });
  const closed = await setOfferStatus({
    offerId: closableOffer.id,
    companyId: seller.id,
    status: "CLOSED",
  });
  check(
    "offer: closing writes closedAt",
    closed.status === "CLOSED" && closed.closedAt !== null,
    closed,
  );
  await expectError(
    "offer: a closed offer cannot be reopened",
    () => setOfferStatus({ offerId: closableOffer.id, companyId: seller.id, status: "ACTIVE" }),
    "cannot be reopened",
  );
  await expectError(
    "offer: a closed offer cannot be edited",
    () =>
      updateOffer({
        offerId: closableOffer.id,
        companyId: seller.id,
        input: {
          title: "Back",
          description: "x",
          category: "y",
          unitPrice: 5,
          quantityAvailable: 1,
        },
      }),
    "cannot be edited",
  );

  const edited = await updateOffer({
    offerId: mainOffer.id,
    companyId: seller.id,
    input: {
      title: `Handwoven Scarf ${RUN}`,
      description: "A warm handwoven scarf in undyed wool. Now in three sizes.",
      category: "Clothing",
      unitPrice: 250,
      quantityAvailable: 10,
    },
  });
  check("offer: edit changes price and description", edited.unitPrice === 250, edited);
  // Put it back for the arithmetic below.
  await updateOffer({
    offerId: mainOffer.id,
    companyId: seller.id,
    input: {
      title: `Handwoven Scarf ${RUN}`,
      description: "A warm handwoven scarf in undyed wool.",
      category: "Clothing",
      unitPrice: 200,
      quantityAvailable: 10,
    },
  });

  await invariant("offer lifecycle (no money moved)");

  // ==========================================================================
  console.log("\n=== 2. BROWSE / SEARCH (§13) ===\n");
  // ==========================================================================

  // A second company's offers, so company filtering has something to filter.
  const otherOffer = await createOffer({
    company: seller2,
    input: {
      title: `Cast Iron Pan ${RUN}`,
      description: "A seasoned cast iron frying pan.",
      category: "Homeware",
      unitPrice: 900,
      quantityAvailable: 4,
    },
  });
  const cheapOffer = await createOffer({
    company: seller2,
    input: {
      title: `Wooden Spoon ${RUN}`,
      description: "A single carved wooden spoon.",
      category: "Homeware",
      unitPrice: 15,
      quantityAvailable: 50,
    },
  });

  const byKeyword = await browseOffers({ q: `Handwoven Scarf ${RUN}` });
  check(
    "browse: a keyword search finds the matching offer and nothing else",
    byKeyword.rows.length === 1 && byKeyword.rows[0].offer.id === mainOffer.id,
    byKeyword.rows.map((r) => r.offer.title),
  );
  check(
    "browse: the row carries the selling company's name and handle",
    byKeyword.rows[0]?.companyName === seller.name &&
      byKeyword.rows[0]?.companyUsername === seller.username,
    byKeyword.rows[0],
  );

  const byCompanyName = await browseOffers({ q: `Second Seller ${RUN}` });
  check(
    "browse: searching a company NAME returns that company's offers",
    byCompanyName.rows.length >= 2 &&
      byCompanyName.rows.every((r) => r.offer.companyId === seller2.id),
    byCompanyName.rows.map((r) => r.offer.title),
  );

  const byCompanyHandle = await browseOffers({ companyUsername: seller2.username });
  check(
    "browse: filtering by company handle returns only that company's offers",
    byCompanyHandle.total >= 2 &&
      byCompanyHandle.rows.every((r) => r.offer.companyId === seller2.id),
    byCompanyHandle.total,
  );

  const byCategory = await browseOffers({ category: "Homeware", companyUsername: seller2.username });
  check(
    "browse: category filtering is exact and case-insensitive",
    byCategory.total === 2 && byCategory.rows.every((r) => r.offer.category === "Homeware"),
    byCategory.rows.map((r) => r.offer.category),
  );
  const byCategoryLower = await browseOffers({
    category: "homeware",
    companyUsername: seller2.username,
  });
  check(
    "browse: the same category in lower case gives the same result",
    byCategoryLower.total === byCategory.total,
    { a: byCategory.total, b: byCategoryLower.total },
  );

  const byPrice = await browseOffers({
    companyUsername: seller2.username,
    minPrice: 100,
    maxPrice: 1000,
  });
  check(
    "browse: a price range excludes offers outside it",
    byPrice.rows.length === 1 && byPrice.rows[0].offer.id === otherOffer.id,
    byPrice.rows.map((r) => r.offer.unitPrice),
  );

  const cheapestFirst = await browseOffers({ companyUsername: seller2.username, sort: "PRICE_ASC" });
  check(
    "browse: PRICE_ASC really sorts by price ascending",
    cheapestFirst.rows[0].offer.id === cheapOffer.id,
    cheapestFirst.rows.map((r) => r.offer.unitPrice),
  );
  const dearestFirst = await browseOffers({ companyUsername: seller2.username, sort: "PRICE_DESC" });
  check(
    "browse: PRICE_DESC really sorts by price descending",
    dearestFirst.rows[0].offer.id === otherOffer.id,
    dearestFirst.rows.map((r) => r.offer.unitPrice),
  );

  const page1 = await browseOffers({ companyUsername: seller2.username, pageSize: 1, page: 1 });
  const page2 = await browseOffers({ companyUsername: seller2.username, pageSize: 1, page: 2 });
  check(
    "browse: pagination reports the real total and page count",
    page1.total === 2 && page1.pageCount === 2 && page1.pageSize === 1,
    page1,
  );
  check(
    "browse: page 1 and page 2 return different rows and together cover the set",
    page1.rows.length === 1 &&
      page2.rows.length === 1 &&
      page1.rows[0].offer.id !== page2.rows[0].offer.id,
    { p1: page1.rows[0]?.offer.title, p2: page2.rows[0]?.offer.title },
  );
  const page3 = await browseOffers({ companyUsername: seller2.username, pageSize: 1, page: 3 });
  check("browse: a page past the end is empty, not an error", page3.rows.length === 0, page3.rows.length);

  // Visibility rule.
  await setOfferStatus({ offerId: cheapOffer.id, companyId: seller2.id, status: "PAUSED" });
  const whilePaused = await browseOffers({ companyUsername: seller2.username });
  check(
    "browse: a PAUSED offer is hidden from browse",
    !whilePaused.rows.some((r) => r.offer.id === cheapOffer.id) && whilePaused.total === 1,
    whilePaused.rows.map((r) => r.offer.title),
  );
  await setOfferStatus({ offerId: cheapOffer.id, companyId: seller2.id, status: "ACTIVE" });
  const afterResume = await browseOffers({ companyUsername: seller2.username });
  check(
    "browse: resuming makes it visible again",
    afterResume.rows.some((r) => r.offer.id === cheapOffer.id),
    afterResume.rows.map((r) => r.offer.title),
  );
  const closedGone = await browseOffers({ q: `Discontinued Mug ${RUN}` });
  check("browse: a CLOSED offer is gone from browse entirely", closedGone.total === 0, closedGone.total);

  // A suspended seller's offers are not orderable, so they are not browsable.
  const suspendedSeller = await makeCompany({
    ownerUserId: sellerOwner.id,
    name: `Suspended Seller ${RUN}`,
    username: `${FIXTURE_PREFIX}susp_${RUN}`,
    balance: 0,
  });
  const suspendedOffer = await createOffer({
    company: suspendedSeller,
    input: {
      title: `Suspended Goods ${RUN}`,
      description: "Sold by a company that is about to be suspended.",
      category: "Clothing",
      unitPrice: 10,
      quantityAvailable: 5,
    },
  });
  await db
    .update(companies)
    .set({ status: "SUSPENDED", suspendedUntil: null })
    .where(eq(companies.id, suspendedSeller.id));
  const suspendedBrowse = await browseOffers({ q: `Suspended Goods ${RUN}` });
  check(
    "browse: a suspended company's offers drop out of browse",
    suspendedBrowse.total === 0,
    suspendedBrowse.total,
  );

  const categories = await listOfferCategories();
  check(
    "browse: the category list contains the live categories",
    categories.includes("Clothing") && categories.includes("Homeware"),
    categories.slice(0, 10),
  );

  // Nothing about a search is stored: the only marketplace tables that exist
  // are the ones the schema declares, and none of them is a search log.
  const [searchTables] = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public'
          AND (table_name ILIKE '%search%' OR table_name ILIKE '%impression%'
               OR table_name ILIKE '%dismiss%' OR table_name ILIKE '%analytic%'
               OR table_name ILIKE '%view_event%' OR table_name ILIKE '%click%')
          -- company_sale_dismissals is the V2 "not interested" list for
          -- companies that are FOR SALE. It predates V3, it is a per-viewer
          -- preference rather than analytics, and V3 adds nothing to it: an AD
          -- dismissal is client-only and stores nothing anywhere.
          AND table_name <> 'company_sale_dismissals'`,
  ).then((r) => r.rows);
  check(
    "browse/ads: there is no search, impression, click, dismissal or analytics table in the database",
    searchTables.n === 0,
    searchTables,
  );

  await invariant("browse and search (read-only)");

  // ==========================================================================
  console.log("\n=== 3. ORDER → INVOICE → PAYMENT → COMPLETED (§14) ===\n");
  // ==========================================================================

  const buyerAStart = await balanceOfUser(buyerA.id);
  const sellerStart = await balanceOfCompany(seller.id);
  const treasuryStart = await treasuryBalance();

  const order = await placeOrder({ offerId: mainOffer.id, buyer: userWallet(buyerA.id), quantity: 2 });
  check(
    "order: placed PENDING with the price snapshot and the derived subtotal",
    order.status === "PENDING" &&
      order.unitPrice === 200 &&
      order.quantity === 2 &&
      order.subtotal === 400 &&
      order.sellerCompanyId === seller.id &&
      order.buyerType === "USER" &&
      order.buyerUserId === buyerA.id,
    order,
  );
  check(
    "order: the order number is human-readable and unique",
    /^ORD-\d{8}-\d{4}$/.test(order.orderNumber),
    order.orderNumber,
  );
  check(
    "order: stock was reserved atomically (10 − 2 = 8)",
    (await offerRow(mainOffer.id)).quantityAvailable === 8,
    (await offerRow(mainOffer.id)).quantityAvailable,
  );
  check(
    "order: placing an order moves no money at all",
    (await balanceOfUser(buyerA.id)) === buyerAStart &&
      (await balanceOfCompany(seller.id)) === sellerStart,
  );
  await invariant("placing an order");

  // Re-pricing the offer after the order must not change what the order costs.
  await updateOffer({
    offerId: mainOffer.id,
    companyId: seller.id,
    input: {
      title: `Handwoven Scarf ${RUN}`,
      description: "A warm handwoven scarf in undyed wool.",
      category: "Clothing",
      unitPrice: 999,
      quantityAvailable: 8,
    },
  });
  check(
    "order: the snapshot price survives the seller re-pricing the offer",
    (await orderRow(order.id)).unitPrice === 200 && (await offerRow(mainOffer.id)).unitPrice === 999,
  );
  await updateOffer({
    offerId: mainOffer.id,
    companyId: seller.id,
    input: {
      title: `Handwoven Scarf ${RUN}`,
      description: "A warm handwoven scarf in undyed wool.",
      category: "Clothing",
      unitPrice: 200,
      quantityAvailable: 8,
    },
  });

  await expectError(
    "order: a company that is not the seller cannot accept it",
    () => acceptOrder({ orderId: order.id, sellerCompanyId: buyerCompany.id }),
    "not placed with your company",
  );
  await expectError(
    "order: it cannot be invoiced before it is accepted",
    () => issueInvoiceForOrder({ orderId: order.id, sellerCompanyId: seller.id }),
    "Accept this order before invoicing",
  );

  const accepted = await acceptOrder({ orderId: order.id, sellerCompanyId: seller.id });
  check(
    "order: seller acceptance sets ACCEPTED and acceptedAt",
    accepted.status === "ACCEPTED" && accepted.acceptedAt !== null,
    accepted,
  );

  const waiting = await requestOrderInvoice({ orderId: order.id, buyer: userWallet(buyerA.id) });
  check("order: the buyer can move it to WAITING_FOR_INVOICE", waiting.status === "WAITING_FOR_INVOICE");
  await expectError(
    "order: someone else cannot request the invoice on your order",
    () => requestOrderInvoice({ orderId: order.id, buyer: userWallet(buyerB.id) }),
    "not your order",
  );

  const issued = await issueInvoiceForOrder({ orderId: order.id, sellerCompanyId: seller.id });
  check(
    "order → invoice: the order is PAYMENT_DUE and carries the invoice id",
    issued.order.status === "PAYMENT_DUE" && issued.order.invoiceId === issued.invoice.id,
    issued.order,
  );
  check(
    "order → invoice: the invoice came from the Phase B engine — numbered, frozen, linked back",
    /^INV-\d{8}-\d{4}$/.test(issued.invoice.invoiceNumber) &&
      issued.invoice.sourceOrderId === order.id &&
      issued.invoice.companyId === seller.id &&
      issued.invoice.recipientType === "USER" &&
      issued.invoice.buyerUserId === buyerA.id,
    issued.invoice,
  );
  check(
    "order → invoice: subtotal is the order's snapshot and tax is added ON TOP at 5%",
    issued.invoice.subtotal === 400 &&
      issued.invoice.taxRateBp === 500 &&
      issued.invoice.taxAmount === 20 &&
      issued.invoice.total === 420,
    issued.invoice,
  );
  await invariant("raising an order's invoice");

  await expectError(
    "order: a SECOND invoice for the same order is refused",
    () => issueInvoiceForOrder({ orderId: order.id, sellerCompanyId: seller.id }),
    "already been raised",
  );

  // The destination, before anything is paid.
  const orderSettlement = await deriveInvoiceSettlement(db, issued.invoice.id);
  check(
    "order: the settlement derived from the invoice is the SELLER COMPANY's wallet",
    orderSettlement.wallet.kind === "COMPANY" && orderSettlement.wallet.id === seller.id,
    orderSettlement.wallet,
  );
  check(
    "order: the settlement knows the owner it must NOT pay",
    orderSettlement.ownerUserId === sellerOwner.id && orderSettlement.wallet.id !== sellerOwner.id,
    { owner: orderSettlement.ownerUserId, wallet: orderSettlement.wallet },
  );

  const receipt = await payInvoice({ invoiceId: issued.invoice.id, payer: userWallet(buyerA.id) });
  check(
    "payment: the receipt reports a real ledger reference and the company it settled to",
    /^TX-\d{8}-\d{6}$/.test(receipt.txRef) &&
      receipt.settledTo.companyId === seller.id &&
      receipt.replayed === false,
    receipt,
  );
  check(
    "payment: the buyer paid the full total (400 + 20 tax = 420)",
    (await balanceOfUser(buyerA.id)) === buyerAStart - 420,
    { before: buyerAStart, after: await balanceOfUser(buyerA.id) },
  );
  check(
    "payment: the SELLER COMPANY wallet received the 400 subtotal",
    (await balanceOfCompany(seller.id)) === sellerStart + 400,
    { before: sellerStart, after: await balanceOfCompany(seller.id) },
  );
  check(
    "payment: the treasury received exactly the 20 tax",
    (await treasuryBalance()) === treasuryStart + 20,
    { before: treasuryStart, after: await treasuryBalance() },
  );
  check(
    "payment: the owner's PERSONAL wallet received nothing",
    (await balanceOfUser(sellerOwner.id)) === 400,
    await balanceOfUser(sellerOwner.id),
  );
  check(
    "payment: the order is PAID and the invoice is PAID, in one transaction",
    (await orderRow(order.id)).status === "PAID" &&
      (await invoiceRow(issued.invoice.id)).status === "PAID",
    { order: (await orderRow(order.id)).status, invoice: (await invoiceRow(issued.invoice.id)).status },
  );
  const paidTx = await txByRef(receipt.txRef);
  check(
    "payment: the ledger row is a MARKETPLACE_PAYMENT from the buyer to the company",
    paidTx.type === "MARKETPLACE_PAYMENT" &&
      paidTx.senderType === "USER" &&
      paidTx.senderId === buyerA.id &&
      paidTx.receiverType === "COMPANY" &&
      paidTx.receiverId === seller.id &&
      paidTx.grossAmount === 420 &&
      paidTx.taxAmount === 20 &&
      paidTx.netAmount === 400,
    paidTx,
  );
  await invariant("paying an order's invoice");

  const completed = await completeOrder({ orderId: order.id, actor: userWallet(buyerA.id) });
  check(
    "order: the buyer can complete a PAID order",
    completed.status === "COMPLETED" && completed.completedAt !== null,
    completed,
  );
  check(
    "order: completing again is a no-op, not an error",
    (await completeOrder({ orderId: order.id, actor: companyWallet(seller.id) })).status ===
      "COMPLETED",
  );
  await invariant("completing an order");

  // A company buying from a company, through the same path.
  const coOrder = await placeOrder({
    offerId: mainOffer.id,
    buyer: companyWallet(buyerCompany.id),
    quantity: 1,
  });
  const buyerCoStart = await balanceOfCompany(buyerCompany.id);
  const sellerBefore2 = await balanceOfCompany(seller.id);
  await acceptOrder({ orderId: coOrder.id, sellerCompanyId: seller.id });
  const coIssued = await issueInvoiceForOrder({ orderId: coOrder.id, sellerCompanyId: seller.id });
  check(
    "company buyer: the invoice is addressed to the buying COMPANY, not to its owner",
    coIssued.invoice.recipientType === "COMPANY" &&
      coIssued.invoice.recipientCompanyId === buyerCompany.id &&
      coIssued.invoice.buyerUserId === null,
    coIssued.invoice,
  );
  const coReceipt = await payInvoice({
    invoiceId: coIssued.invoice.id,
    payer: companyWallet(buyerCompany.id),
  });
  check(
    "company buyer: the buying company's wallet paid and the selling company's wallet received",
    (await balanceOfCompany(buyerCompany.id)) === buyerCoStart - coIssued.invoice.total &&
      (await balanceOfCompany(seller.id)) === sellerBefore2 + coIssued.invoice.subtotal,
    {
      buyerBefore: buyerCoStart,
      buyerAfter: await balanceOfCompany(buyerCompany.id),
      total: coIssued.invoice.total,
    },
  );
  check("company buyer: the order is PAID", (await orderRow(coOrder.id)).status === "PAID");
  await completeOrder({ orderId: coOrder.id, actor: companyWallet(seller.id) });
  await invariant("a company-to-company order");
  void coReceipt;

  // Unlimited stock never decrements.
  const lessonOrder = await placeOrder({
    offerId: unlimitedOffer.id,
    buyer: userWallet(buyerB.id),
    quantity: 3,
  });
  check(
    "order: an unlimited offer stays unlimited after an order",
    (await offerRow(unlimitedOffer.id)).quantityAvailable === null && lessonOrder.subtotal === 150,
  );
  await cancelOrder({ orderId: lessonOrder.id, actor: userWallet(buyerB.id), reason: "changed mind" });
  check(
    "order: cancelling an unlimited-offer order leaves availability null (nothing to return)",
    (await offerRow(unlimitedOffer.id)).quantityAvailable === null,
  );
  await invariant("an unlimited-offer order and its cancellation");

  // The company's dashboard buckets (§15).
  const counts = await getCompanyOrderCounts(seller.id);
  check(
    "dashboard: the company's order counts add up",
    counts.total >= 2 && counts.completed >= 2,
    counts,
  );
  const sellerOrders = await getOrdersForCompany(seller.id);
  check(
    "dashboard: the seller's order list links the canonical invoice rather than copying it",
    sellerOrders.some(
      (r) => r.order.id === order.id && r.invoiceNumber === issued.invoice.invoiceNumber,
    ),
    sellerOrders.map((r) => ({ n: r.order.orderNumber, inv: r.invoiceNumber })),
  );
  const buyerOrders = await getOrdersForBuyer(userWallet(buyerA.id));
  check(
    "dashboard: the buyer sees their own order with the seller's name",
    buyerOrders.some((r) => r.order.id === order.id && r.sellerName === seller.name),
  );
  const oneOrder = await getOrderById(order.id);
  check(
    "dashboard: a single order reads back with its buyer label and paid reference",
    oneOrder?.order.id === order.id && oneOrder?.paidTxRef === receipt.txRef,
    oneOrder,
  );

  // ==========================================================================
  console.log("\n=== 4. CONCURRENCY — THE LAST REMAINING UNIT ===\n");
  // ==========================================================================

  const lastUnitOffer = await createOffer({
    company: seller,
    input: {
      title: `Single Print ${RUN}`,
      description: "One signed print, one only.",
      category: "Art",
      unitPrice: 300,
      quantityAvailable: 1,
    },
  });

  const race = await Promise.allSettled([
    placeOrder({ offerId: lastUnitOffer.id, buyer: userWallet(buyerA.id), quantity: 1 }),
    placeOrder({ offerId: lastUnitOffer.id, buyer: userWallet(buyerB.id), quantity: 1 }),
  ]);
  const won = race.filter((r) => r.status === "fulfilled");
  const lost = race.filter((r) => r.status === "rejected");
  check(
    "concurrency: exactly ONE of two simultaneous orders for the last unit succeeded",
    won.length === 1 && lost.length === 1,
    race.map((r) => (r.status === "fulfilled" ? "ok" : (r.reason as Error).message)),
  );
  check(
    "concurrency: the loser was told the stock is gone, not given a crash",
    lost.length === 1 && /out of stock|no longer available|Only 0 left/.test((lost[0] as PromiseRejectedResult).reason.message),
    lost.length === 1 ? (lost[0] as PromiseRejectedResult).reason.message : null,
  );
  check(
    "concurrency: stock is exactly 0 — never negative, never oversold",
    (await offerRow(lastUnitOffer.id)).quantityAvailable === 0,
    (await offerRow(lastUnitOffer.id)).quantityAvailable,
  );
  const raceOrders = await db
    .select({ id: marketplaceOrders.id })
    .from(marketplaceOrders)
    .where(eq(marketplaceOrders.offerId, lastUnitOffer.id));
  check(
    "concurrency: exactly one order row exists for that offer",
    raceOrders.length === 1,
    raceOrders.length,
  );
  await invariant("the concurrent race for the last unit");

  const raceWinner = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof placeOrder>>>).value;
  const raceLoserWallet =
    raceWinner.buyerUserId === buyerA.id ? userWallet(buyerB.id) : userWallet(buyerA.id);

  await expectError(
    "rejection: ordering a now out-of-stock offer is refused",
    () => placeOrder({ offerId: lastUnitOffer.id, buyer: raceLoserWallet, quantity: 1 }),
    "out of stock",
  );

  // ==========================================================================
  console.log("\n=== 5. REJECTIONS (§14) ===\n");
  // ==========================================================================

  const rejectOffer = await createOffer({
    company: seller,
    input: {
      title: `Test Widget ${RUN}`,
      description: "A widget used to prove the refusals.",
      category: "Tools",
      unitPrice: 100,
      quantityAvailable: 2,
    },
  });

  const dupOrder = await placeOrder({
    offerId: rejectOffer.id,
    buyer: userWallet(buyerA.id),
    quantity: 1,
  });
  await expectError(
    "rejection: a DUPLICATE order from the same buyer for the same offer is refused",
    () => placeOrder({ offerId: rejectOffer.id, buyer: userWallet(buyerA.id), quantity: 1 }),
    "already have an open order",
  );
  check(
    "rejection: the refused duplicate did not consume stock (2 − 1 = 1 left)",
    (await offerRow(rejectOffer.id)).quantityAvailable === 1,
    (await offerRow(rejectOffer.id)).quantityAvailable,
  );

  await expectError(
    "rejection: ordering MORE than the available quantity is refused",
    () => placeOrder({ offerId: rejectOffer.id, buyer: userWallet(buyerB.id), quantity: 5 }),
    "Only 1 left",
  );
  await expectError(
    "rejection: a zero-quantity order is refused",
    () => placeOrder({ offerId: rejectOffer.id, buyer: userWallet(buyerB.id), quantity: 0 }),
    "at least 1",
  );
  await expectError(
    "rejection: a company cannot order its own listing",
    () => placeOrder({ offerId: rejectOffer.id, buyer: companyWallet(seller.id), quantity: 1 }),
    "cannot order its own listing",
  );

  await setOfferStatus({ offerId: rejectOffer.id, companyId: seller.id, status: "PAUSED" });
  await expectError(
    "rejection: ordering a PAUSED listing is refused",
    () => placeOrder({ offerId: rejectOffer.id, buyer: userWallet(buyerB.id), quantity: 1 }),
    "paused",
  );
  await setOfferStatus({ offerId: rejectOffer.id, companyId: seller.id, status: "ACTIVE" });

  const closedOrderOffer = await createOffer({
    company: seller,
    input: {
      title: `Soon Closed ${RUN}`,
      description: "About to be closed.",
      category: "Tools",
      unitPrice: 60,
      quantityAvailable: 5,
    },
  });
  await setOfferStatus({ offerId: closedOrderOffer.id, companyId: seller.id, status: "CLOSED" });
  await expectError(
    "rejection: ordering a CLOSED listing is refused",
    () => placeOrder({ offerId: closedOrderOffer.id, buyer: userWallet(buyerB.id), quantity: 1 }),
    "closed",
  );
  await expectError(
    "rejection: a suspended company's listing cannot be ordered",
    () => placeOrder({ offerId: suspendedOffer.id, buyer: userWallet(buyerB.id), quantity: 1 }),
    "cannot take orders",
  );
  await invariant("the order rejections");

  // --- duplicate payment -----------------------------------------------------
  await acceptOrder({ orderId: dupOrder.id, sellerCompanyId: seller.id });
  const dupInvoice = (await issueInvoiceForOrder({
    orderId: dupOrder.id,
    sellerCompanyId: seller.id,
  })).invoice;

  const buyerABeforeDup = await balanceOfUser(buyerA.id);
  const sellerBeforeDup = await balanceOfCompany(seller.id);
  const first = await payInvoice({ invoiceId: dupInvoice.id, payer: userWallet(buyerA.id) });
  const second = await payInvoice({ invoiceId: dupInvoice.id, payer: userWallet(buyerA.id) });
  check(
    "rejection: a DUPLICATE payment replays the first receipt instead of paying twice",
    second.replayed === true && second.txRef === first.txRef,
    { first: first.txRef, second: second.txRef, replayed: second.replayed },
  );
  check(
    "rejection: the duplicate moved no money — one debit, one credit, one tax",
    (await balanceOfUser(buyerA.id)) === buyerABeforeDup - dupInvoice.total &&
      (await balanceOfCompany(seller.id)) === sellerBeforeDup + dupInvoice.subtotal,
  );
  const dupLedger = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.invoiceId, dupInvoice.id));
  check(
    "rejection: exactly ONE ledger row exists for that invoice",
    dupLedger.length === 1,
    dupLedger.length,
  );
  await expectError(
    "rejection: a non-idempotent second attempt is refused outright",
    () => payInvoice({ invoiceId: dupInvoice.id, payer: userWallet(buyerA.id), idempotent: false }),
    "already been paid",
  );
  await invariant("the duplicate payment attempts");

  // Two CONCURRENT payments of one order invoice.
  const raceOrderId = raceWinner.id;
  await acceptOrder({ orderId: raceOrderId, sellerCompanyId: seller.id });
  const raceInvoice = (await issueInvoiceForOrder({
    orderId: raceOrderId,
    sellerCompanyId: seller.id,
  })).invoice;
  const racePayerWallet = userWallet(raceWinner.buyerUserId as string);
  const racePayerBefore = await balanceOfUser(raceWinner.buyerUserId as string);
  const racePay = await Promise.allSettled([
    payInvoice({ invoiceId: raceInvoice.id, payer: racePayerWallet }),
    payInvoice({ invoiceId: raceInvoice.id, payer: racePayerWallet }),
  ]);
  const paidOnce = racePay.filter(
    (r) => r.status === "fulfilled" && r.value.replayed === false,
  ).length;
  check(
    "concurrency: two simultaneous payments of one invoice produce exactly one settlement",
    paidOnce === 1 &&
      (await balanceOfUser(raceWinner.buyerUserId as string)) ===
        racePayerBefore - raceInvoice.total,
    racePay.map((r) => (r.status === "fulfilled" ? `ok replayed=${r.value.replayed}` : (r.reason as Error).message)),
  );
  const raceLedger = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.invoiceId, raceInvoice.id));
  check("concurrency: one ledger row for the raced invoice", raceLedger.length === 1, raceLedger.length);
  await invariant("two concurrent payments of one order invoice");

  // --- payment after cancellation -------------------------------------------
  const cancelOffer = await createOffer({
    company: seller,
    input: {
      title: `Cancellable Kit ${RUN}`,
      description: "Ordered then cancelled.",
      category: "Tools",
      unitPrice: 120,
      quantityAvailable: 4,
    },
  });
  const toCancel = await placeOrder({
    offerId: cancelOffer.id,
    buyer: userWallet(buyerB.id),
    quantity: 2,
  });
  await acceptOrder({ orderId: toCancel.id, sellerCompanyId: seller.id });
  const cancelInvoiceRow = (await issueInvoiceForOrder({
    orderId: toCancel.id,
    sellerCompanyId: seller.id,
  })).invoice;
  check(
    "cancellation: stock was reserved before the cancellation (4 − 2 = 2)",
    (await offerRow(cancelOffer.id)).quantityAvailable === 2,
  );
  const cancelled = await cancelOrder({
    orderId: toCancel.id,
    actor: userWallet(buyerB.id),
    reason: "no longer needed",
  });
  check(
    "cancellation: the order is CANCELLED with its reason and timestamp",
    cancelled.status === "CANCELLED" &&
      cancelled.cancelledAt !== null &&
      cancelled.cancelReason === "no longer needed",
    cancelled,
  );
  check(
    "cancellation: the reserved stock came back (2 + 2 = 4)",
    (await offerRow(cancelOffer.id)).quantityAvailable === 4,
    (await offerRow(cancelOffer.id)).quantityAvailable,
  );
  check(
    "cancellation: the order's unpaid invoice was cancelled with it",
    (await invoiceRow(cancelInvoiceRow.id)).status === "CANCELLED",
    (await invoiceRow(cancelInvoiceRow.id)).status,
  );
  await expectError(
    "rejection: PAYMENT AFTER CANCELLATION is refused",
    () => payInvoice({ invoiceId: cancelInvoiceRow.id, payer: userWallet(buyerB.id) }),
    "cancelled",
  );
  await expectError(
    "rejection: a PAID order cannot be cancelled — that would need a refund",
    () => cancelOrder({ orderId: dupOrder.id, actor: userWallet(buyerA.id) }),
    "refund",
  );
  await invariant("cancelling an order");

  // --- payment after expiry --------------------------------------------------
  const expiryOffer = await createOffer({
    company: seller,
    input: {
      title: `Expiring Crate ${RUN}`,
      description: "Ordered then left to lapse.",
      category: "Tools",
      unitPrice: 90,
      quantityAvailable: 3,
    },
  });
  const toExpire = await placeOrder({
    offerId: expiryOffer.id,
    buyer: userWallet(buyerB.id),
    quantity: 1,
  });
  await acceptOrder({ orderId: toExpire.id, sellerCompanyId: seller.id });
  const expiringInvoice = (await issueInvoiceForOrder({
    orderId: toExpire.id,
    sellerCompanyId: seller.id,
  })).invoice;
  // Backdate the expiry, exactly as the passage of time would.
  await db
    .update(marketplaceOrders)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(marketplaceOrders.id, toExpire.id));
  const didExpire = await expireOrderIfOverdue(toExpire.id);
  check(
    "expiry: an overdue unsettled order lapses to EXPIRED and returns its stock",
    didExpire &&
      (await orderRow(toExpire.id)).status === "EXPIRED" &&
      (await offerRow(expiryOffer.id)).quantityAvailable === 3,
    { didExpire, status: (await orderRow(toExpire.id)).status },
  );
  check(
    "expiry: the order's pending invoice expired with it",
    (await invoiceRow(expiringInvoice.id)).status === "EXPIRED",
  );
  await expectError(
    "rejection: PAYMENT AFTER EXPIRY is refused",
    () => payInvoice({ invoiceId: expiringInvoice.id, payer: userWallet(buyerB.id) }),
    "expired",
  );
  check(
    "expiry: running the sweep again does nothing (idempotent)",
    (await expireOrderIfOverdue(toExpire.id)) === false,
  );
  // An order that lapses BEFORE any invoice was raised cannot then be invoiced.
  const toExpireUninvoiced = await placeOrder({
    offerId: expiryOffer.id,
    buyer: userWallet(buyerA.id),
    quantity: 1,
  });
  await acceptOrder({ orderId: toExpireUninvoiced.id, sellerCompanyId: seller.id });
  await db
    .update(marketplaceOrders)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(marketplaceOrders.id, toExpireUninvoiced.id));
  await expireOrderIfOverdue(toExpireUninvoiced.id);
  await expectError(
    "rejection: an EXPIRED order cannot be invoiced",
    () => issueInvoiceForOrder({ orderId: toExpireUninvoiced.id, sellerCompanyId: seller.id }),
    "EXPIRED",
  );
  await expectError(
    "rejection: an EXPIRED order cannot be accepted",
    () => acceptOrder({ orderId: toExpireUninvoiced.id, sellerCompanyId: seller.id }),
    "EXPIRED",
  );
  await expectError(
    "rejection: an EXPIRED order cannot be cancelled after the fact",
    () => cancelOrder({ orderId: toExpireUninvoiced.id, actor: userWallet(buyerA.id) }),
    "already expired",
  );
  await invariant("expiring an order");

  // ==========================================================================
  console.log("\n=== 6. ANTI-TAX-ROUTING ON THE ORDER PATH (§4) ===\n");
  // ==========================================================================

  const attackOffer = await createOffer({
    company: seller,
    input: {
      title: `Routing Probe ${RUN}`,
      description: "Used to prove an order's money cannot be redirected.",
      category: "Tools",
      unitPrice: 500,
      quantityAvailable: 2,
    },
  });
  const attackOrder = await placeOrder({
    offerId: attackOffer.id,
    buyer: userWallet(buyerA.id),
    quantity: 1,
  });
  await acceptOrder({ orderId: attackOrder.id, sellerCompanyId: seller.id });
  const attackInvoice = (await issueInvoiceForOrder({
    orderId: attackOrder.id,
    sellerCompanyId: seller.id,
  })).invoice;

  const ownerWalletRef: WalletRef = userWallet(sellerOwner.id);
  const ownerBefore = await balanceOfUser(sellerOwner.id);

  await expectError(
    "routing: a transfer claiming the order's invoice cannot pay the owner's personal wallet",
    () =>
      db.transaction((tx) =>
        transferInTx(tx, {
          from: userWallet(buyerA.id),
          to: ownerWalletRef,
          amount: attackInvoice.total,
          invoiceId: attackInvoice.id,
        }),
      ),
    "must settle to the company wallet",
  );
  await expectError(
    "routing: carrying the order's derived settlement but naming the owner is refused",
    () =>
      db.transaction(async (tx) => {
        const destination = await deriveCompanySettlement(tx, seller.id);
        return transferInTx(tx, {
          from: userWallet(buyerA.id),
          to: ownerWalletRef,
          amount: attackInvoice.total,
          settlement: destination,
        });
      }),
    "must settle to the company wallet",
  );
  await expectError(
    "routing: naming a THIRD company as the destination of this order is refused",
    () =>
      db.transaction((tx) =>
        transferInTx(tx, {
          from: userWallet(buyerA.id),
          to: companyWallet(seller2.id),
          amount: attackInvoice.total,
          invoiceId: attackInvoice.id,
        }),
      ),
    "must settle to the company wallet",
  );
  await expectError(
    "routing: the settlement module itself refuses to validate the owner's wallet",
    async () => {
      const destination = await deriveCompanySettlement(db, seller.id);
      assertSettlementDestination(destination, ownerWalletRef);
    },
    "owner's personal wallet",
  );
  check(
    "routing: none of those attempts moved a single Aero into the owner's wallet",
    (await balanceOfUser(sellerOwner.id)) === ownerBefore,
    { before: ownerBefore, after: await balanceOfUser(sellerOwner.id) },
  );
  check(
    "routing: the order path exposes NO destination parameter — the invoice's issuer is the order's seller",
    attackInvoice.companyId === (await orderRow(attackOrder.id)).sellerCompanyId,
  );

  // And the real payment lands where it must.
  const sellerBeforeAttack = await balanceOfCompany(seller.id);
  const attackReceipt = await payInvoice({
    invoiceId: attackInvoice.id,
    payer: userWallet(buyerA.id),
  });
  check(
    "routing: the genuine payment landed in the company wallet, not the owner's",
    attackReceipt.settledTo.companyId === seller.id &&
      (await balanceOfCompany(seller.id)) === sellerBeforeAttack + attackInvoice.subtotal &&
      (await balanceOfUser(sellerOwner.id)) === ownerBefore,
  );
  await invariant("the anti-tax-routing attempts and the genuine payment");

  // ==========================================================================
  console.log("\n=== 7. REFUNDS / REVERSALS (§18) ===\n");
  // ==========================================================================

  const originalTx = await txByRef(attackReceipt.txRef);
  const originalSnapshot = JSON.stringify(originalTx);
  const buyerABeforeRefund = await balanceOfUser(buyerA.id);
  const sellerBeforeRefund = await balanceOfCompany(seller.id);
  const treasuryBeforeRefund = await treasuryBalance();

  await expectError(
    "refund: a company cannot refund a payment it did not receive",
    () =>
      reverseTransaction({
        transactionId: originalTx.id,
        actor: { type: "COMPANY", id: buyerCompany.id, label: buyerCompany.name },
        reason: "not mine to refund",
      }),
    "only refund a payment it received",
  );
  await expectError(
    "refund: a reason is mandatory",
    () =>
      reverseTransaction({
        transactionId: originalTx.id,
        actor: { type: "GOVERNMENT", id: gov.id, label: "government" },
        reason: "   ",
      }),
    "reason is required",
  );
  await expectError(
    "refund: a partial refund larger than what was delivered is refused",
    () =>
      reverseTransaction({
        transactionId: originalTx.id,
        actor: { type: "GOVERNMENT", id: gov.id, label: "government" },
        reason: "too much",
        amount: originalTx.netAmount + 1,
      }),
    "more than the",
  );

  const refund = await reverseTransaction({
    transactionId: originalTx.id,
    actor: { type: "COMPANY", id: seller.id, label: seller.name },
    reason: "Item was out of stock after all",
  });
  check(
    "refund: the payer got back the FULL gross — the company's net plus the Treasury's tax",
    refund.kind === "FULL" &&
      refund.refundedToPayer === originalTx.grossAmount &&
      refund.refundedFromRecipient === originalTx.netAmount &&
      refund.refundedFromTreasury === originalTx.taxAmount,
    refund,
  );
  check(
    "refund: the buyer's balance is restored exactly",
    (await balanceOfUser(buyerA.id)) === buyerABeforeRefund + originalTx.grossAmount,
    { before: buyerABeforeRefund, after: await balanceOfUser(buyerA.id) },
  );
  check(
    "refund: the company gave back only the net it actually received",
    (await balanceOfCompany(seller.id)) === sellerBeforeRefund - originalTx.netAmount,
  );
  check(
    "refund: the Treasury gave back only the tax it actually collected",
    (await treasuryBalance()) === treasuryBeforeRefund - originalTx.taxAmount,
  );

  const reversalTx = await txByRef(refund.reversalTxRef);
  check(
    "refund: the reversal is a NEW ledger row linked to the original",
    reversalTx.reversesTransactionId === originalTx.id &&
      reversalTx.type === "TRANSACTION_REVERSAL" &&
      reversalTx.id !== originalTx.id,
    reversalTx,
  );
  check(
    "refund: the reason and the direction are on the new row",
    reversalTx.reason?.includes("out of stock after all") === true &&
      reversalTx.senderId === seller.id &&
      reversalTx.receiverId === buyerA.id,
    { reason: reversalTx.reason, sender: reversalTx.senderType, receiver: reversalTx.receiverType },
  );
  check(
    "refund: the ORIGINAL transaction row is byte-for-byte unchanged",
    JSON.stringify(await txByRef(attackReceipt.txRef)) === originalSnapshot,
  );
  const linkedRows = await db
    .select({ id: transactions.id, type: transactions.type, amount: transactions.grossAmount })
    .from(transactions)
    .where(eq(transactions.reversesTransactionId, originalTx.id));
  check(
    "refund: both halves of the reversal point at the original",
    linkedRows.length === 2 &&
      linkedRows.reduce((sum, r) => sum + r.amount, 0) === originalTx.grossAmount,
    linkedRows,
  );
  check(
    "refund: the refunded invoice and its order are CANCELLED, not deleted",
    (await invoiceRow(attackInvoice.id)).status === "CANCELLED" &&
      (await orderRow(attackOrder.id)).status === "CANCELLED",
    {
      invoice: (await invoiceRow(attackInvoice.id)).status,
      order: (await orderRow(attackOrder.id)).status,
    },
  );
  check(
    "refund: the invoice keeps its original paid reference as a record of what happened",
    (await invoiceRow(attackInvoice.id)).paidTxRef === attackReceipt.txRef,
  );
  check("refund: the transaction is reported as reversed", await isReversed(originalTx.id));
  await expectError(
    "refund: the same payment cannot be reversed twice",
    () =>
      reverseTransaction({
        transactionId: originalTx.id,
        actor: { type: "GOVERNMENT", id: gov.id, label: "government" },
        reason: "again",
      }),
    "already been reversed",
  );
  await expectError(
    "refund: a reversal cannot itself be reversed",
    () =>
      reverseTransaction({
        transactionId: reversalTx.id,
        actor: { type: "GOVERNMENT", id: gov.id, label: "government" },
        reason: "undo the undo",
      }),
    "cannot itself be reversed",
  );
  await invariant("the full refund");

  // A partial adjustment.
  const partialTarget = await txByRef(first.txRef);
  const partialBuyerBefore = await balanceOfUser(buyerA.id);
  const partialSellerBefore = await balanceOfCompany(seller.id);
  const partialTreasuryBefore = await treasuryBalance();
  const partial = await reverseTransaction({
    transactionId: partialTarget.id,
    actor: { type: "GOVERNMENT", id: gov.id, label: "government" },
    reason: "Partial goodwill adjustment",
    amount: 40,
  });
  check(
    "adjustment: a partial correction moves only the named amount, from the recipient alone",
    partial.kind === "PARTIAL" &&
      partial.refundedToPayer === 40 &&
      partial.refundedFromTreasury === 0 &&
      (await balanceOfUser(buyerA.id)) === partialBuyerBefore + 40 &&
      (await balanceOfCompany(seller.id)) === partialSellerBefore - 40 &&
      (await treasuryBalance()) === partialTreasuryBefore,
    partial,
  );
  const partialRow = await txByRef(partial.reversalTxRef);
  check(
    "adjustment: it is recorded as TRANSACTION_ADJUSTMENT and linked to the original",
    partialRow.type === "TRANSACTION_ADJUSTMENT" &&
      partialRow.reversesTransactionId === partialTarget.id,
    partialRow,
  );
  check(
    "adjustment: a partially adjusted invoice stays PAID (the sale still happened)",
    (await invoiceRow(dupInvoice.id)).status === "PAID",
  );
  await invariant("the partial adjustment");

  // ==========================================================================
  console.log("\n=== 8. WANTED REQUESTS (§16) ===\n");
  // ==========================================================================

  const wanted = await createWantedRequest({
    requester: userWallet(buyerA.id),
    input: {
      heading: `Looking for a wool coat ${RUN}`,
      description: "Size medium, undyed if possible.",
      category: "Clothing",
      quantity: 1,
      budget: 900,
    },
  });
  check(
    "wanted: created OPEN with a stored expiry the retention engine can use",
    wanted.status === "OPEN" &&
      wanted.budget === 900 &&
      wanted.requesterType === "USER" &&
      wanted.expiresAt instanceof Date &&
      wanted.expiresAt.getTime() > Date.now(),
    wanted,
  );
  await expectError(
    "wanted: a zero budget is refused",
    () =>
      createWantedRequest({
        requester: userWallet(buyerA.id),
        input: { heading: "x", description: "y", category: "z", quantity: 1, budget: 0 },
      }),
    "at least 1 Aeros",
  );

  const companyWanted = await createWantedRequest({
    requester: companyWallet(buyerCompany.id),
    input: {
      heading: `Bulk yarn wanted ${RUN}`,
      description: "Ten kilos of undyed wool yarn.",
      category: "Materials",
      quantity: 10,
      budget: 2000,
    },
  });
  check(
    "wanted: a COMPANY can post a request too",
    companyWanted.requesterType === "COMPANY" &&
      companyWanted.requesterCompanyId === buyerCompany.id,
  );

  const response1 = await respondToWantedRequest({
    requestId: wanted.id,
    responder: companyWallet(seller.id),
    message: "We weave coats to order.",
    offeredPrice: 850,
  });
  check(
    "wanted: a company can respond with a quote",
    response1.status === "PENDING" && response1.offeredPrice === 850,
    response1,
  );
  await expectError(
    "wanted: the SAME party cannot respond twice (partial unique index)",
    () =>
      respondToWantedRequest({
        requestId: wanted.id,
        responder: companyWallet(seller.id),
        message: "And again.",
      }),
    "already responded",
  );
  const response2 = await respondToWantedRequest({
    requestId: wanted.id,
    responder: userWallet(buyerB.id),
    message: "I have one I no longer wear.",
    offeredPrice: 400,
  });
  check(
    "wanted: a DIFFERENT party may still respond once",
    response2.id !== response1.id,
  );
  await expectError(
    "wanted: the same user cannot respond twice either",
    () =>
      respondToWantedRequest({
        requestId: wanted.id,
        responder: userWallet(buyerB.id),
        message: "Actually two.",
      }),
    "already responded",
  );
  await expectError(
    "wanted: you cannot respond to your own request",
    () =>
      respondToWantedRequest({
        requestId: wanted.id,
        responder: userWallet(buyerA.id),
        message: "Me!",
      }),
    "your own request",
  );

  const responses = await getResponsesForRequest(wanted.id);
  check(
    "wanted: both responses read back with their responders labelled",
    responses.length === 2 && responses.some((r) => r.responderLabel === seller.name),
    responses.map((r) => r.responderLabel),
  );
  const mine = await getMyResponse(wanted.id, companyWallet(seller.id));
  check("wanted: a party can find its own response", mine?.id === response1.id);

  const decided = await decideWantedResponse({
    responseId: response1.id,
    requester: userWallet(buyerA.id),
    decision: "ACCEPTED",
  });
  check(
    "wanted: the requester can accept a response",
    decided.status === "ACCEPTED" && decided.respondedAt !== null,
  );
  await expectError(
    "wanted: someone else cannot decide on your request's responses",
    () =>
      decideWantedResponse({
        responseId: response2.id,
        requester: userWallet(buyerB.id),
        decision: "ACCEPTED",
      }),
    "not your request",
  );

  const browseWanted = await browseWantedRequests({ q: `wool coat ${RUN}` });
  check(
    "wanted: browse finds an OPEN request by keyword and counts its responses",
    browseWanted.rows.length === 1 &&
      browseWanted.rows[0].request.id === wanted.id &&
      browseWanted.rows[0].responseCount === 2,
    browseWanted.rows[0],
  );

  const closedWanted = await closeWantedRequest({
    requestId: wanted.id,
    requester: userWallet(buyerA.id),
    status: "FULFILLED",
  });
  check(
    "wanted: the requester can close it as FULFILLED",
    closedWanted.status === "FULFILLED" && closedWanted.closedAt !== null,
  );
  const afterClose = await browseWantedRequests({ q: `wool coat ${RUN}` });
  check("wanted: a closed request leaves the OPEN browse", afterClose.total === 0, afterClose.total);
  await expectError(
    "wanted: a closed request takes no more replies",
    () =>
      respondToWantedRequest({
        requestId: wanted.id,
        responder: companyWallet(seller2.id),
        message: "Late.",
      }),
    "no longer taking replies",
  );
  await invariant("the wanted request flow (no money moved)");

  // ==========================================================================
  console.log("\n=== 9. CONTRACTS (§17) ===\n");
  // ==========================================================================

  const govContract = await createContract({
    issuer: { type: "GOVERNMENT" },
    input: {
      title: `Civic banners ${RUN}`,
      requirement: "Twenty printed banners for the town square.",
      description: "Design, print and deliver twenty banners.",
      conditions: "Delivery within two weeks.",
      budget: 1000,
    },
  });
  check(
    "contract: the Government can issue one, with no issuer company",
    govContract.status === "OPEN" &&
      govContract.issuerType === "GOVERNMENT" &&
      govContract.issuerCompanyId === null &&
      /^CT-\d{8}-\d{4}$/.test(govContract.contractNumber),
    govContract,
  );
  await expectError(
    "contract: a zero budget is refused",
    () =>
      createContract({
        issuer: { type: "GOVERNMENT" },
        input: { title: "x", requirement: "y", description: "z", budget: 0 },
      }),
    "at least 1 Aeros",
  );
  await expectError(
    "contract: a suspended company cannot issue one",
    () =>
      createContract({
        issuer: { type: "COMPANY", companyId: suspendedSeller.id },
        input: { title: "x", requirement: "y", description: "z", budget: 10 },
      }),
    "Only an approved company",
  );

  const app1 = await applyForContract({
    contractId: govContract.id,
    applicant: companyWallet(seller.id),
    proposal: "We can print and hang all twenty.",
    quotedPrice: 800,
  });
  check("contract: a company can apply with a quote", app1.status === "PENDING" && app1.quotedPrice === 800);
  await expectError(
    "contract: the SAME party cannot apply twice (partial unique index)",
    () =>
      applyForContract({
        contractId: govContract.id,
        applicant: companyWallet(seller.id),
        proposal: "Again.",
      }),
    "already applied",
  );
  const app2 = await applyForContract({
    contractId: govContract.id,
    applicant: companyWallet(seller2.id),
    proposal: "We would do it for the full budget.",
  });
  check("contract: a different company may also apply", app2.id !== app1.id);

  await expectError(
    "contract: a company cannot award a Government contract",
    () =>
      awardContract({
        contractId: govContract.id,
        applicationId: app1.id,
        actor: { type: "COMPANY", companyId: seller.id },
        actorLabel: seller.name,
      }),
    "not issued by your company",
  );

  const awarded = await awardContract({
    contractId: govContract.id,
    applicationId: app1.id,
    actor: { type: "GOVERNMENT" },
    actorLabel: "government",
  });
  check(
    "contract: awarding sets AWARDED and records who won",
    awarded.contract.status === "AWARDED" &&
      awarded.contract.awardedToType === "COMPANY" &&
      awarded.contract.awardedToCompanyId === seller.id &&
      awarded.contract.awardedAt !== null,
    awarded.contract,
  );
  const [rejectedApp] = await db
    .select({ status: marketplaceContractApplications.status })
    .from(marketplaceContractApplications)
    .where(eq(marketplaceContractApplications.id, app2.id));
  check(
    "contract: the other pending applications were rejected in the same transaction",
    rejectedApp.status === "REJECTED",
    rejectedApp,
  );
  await expectError(
    "contract: it cannot be awarded twice",
    () =>
      awardContract({
        contractId: govContract.id,
        applicationId: app2.id,
        actor: { type: "GOVERNMENT" },
        actorLabel: "government",
      }),
    "AWARDED",
  );
  await expectError(
    "contract: an awarded contract takes no more applications",
    () =>
      applyForContract({
        contractId: govContract.id,
        applicant: companyWallet(buyerCompany.id),
        proposal: "Late.",
      }),
    "not taking applications",
  );

  const contractInvoice = (await issueContractInvoice({
    contractId: govContract.id,
    payeeCompanyId: seller.id,
  })).invoice;
  check(
    "contract → invoice: the awarded company invoices the Government for its QUOTED price",
    contractInvoice.recipientType === "GOVERNMENT" &&
      contractInvoice.companyId === seller.id &&
      contractInvoice.subtotal === 800 &&
      contractInvoice.taxAmount === 0 &&
      contractInvoice.total === 800,
    contractInvoice,
  );
  check(
    "contract → invoice: the contract row links the invoice it raised",
    (await getContractById(govContract.id))?.contract.invoiceId === contractInvoice.id,
  );
  await expectError(
    "contract: a SECOND invoice for one contract is refused",
    () => issueContractInvoice({ contractId: govContract.id, payeeCompanyId: seller.id }),
    "already been raised",
  );
  await expectError(
    "contract: a company that was not awarded cannot invoice it",
    () => issueContractInvoice({ contractId: govContract.id, payeeCompanyId: seller2.id }),
    "already been raised",
  );

  const sellerBeforeContract = await balanceOfCompany(seller.id);
  const treasuryBeforeContract = await treasuryBalance();
  const contractReceipt = await payInvoice({
    invoiceId: contractInvoice.id,
    payer: governmentWallet(gov.id),
  });
  check(
    "contract: the Treasury paid and the AWARDED COMPANY's wallet received the full 800",
    (await balanceOfCompany(seller.id)) === sellerBeforeContract + 800 &&
      (await treasuryBalance()) === treasuryBeforeContract - 800 &&
      contractReceipt.settledTo.companyId === seller.id,
    { before: sellerBeforeContract, after: await balanceOfCompany(seller.id) },
  );
  const settledContract = await getContractById(govContract.id);
  check(
    "contract: paying the contract's invoice COMPLETED the contract, in the same transaction",
    settledContract?.contract.status === "COMPLETED" &&
      settledContract?.contract.closedAt !== null &&
      settledContract?.contract.paidTxRef === contractReceipt.txRef,
    settledContract?.contract,
  );
  check(
    "contract: the owner's personal wallet received nothing from the contract",
    (await balanceOfUser(sellerOwner.id)) === 400,
  );
  await invariant("a Government contract awarded to a company and paid");

  // A company contract awarded to a PERSON, paid directly.
  const coContract = await createContract({
    issuer: { type: "COMPANY", companyId: seller2.id },
    input: {
      title: `Weekend stall help ${RUN}`,
      requirement: "Two days helping on the market stall.",
      description: "Setting up, selling and packing down.",
      budget: 300,
    },
  });
  const workerApp = await applyForContract({
    contractId: coContract.id,
    applicant: userWallet(worker.id),
    proposal: "I can do both days.",
    quotedPrice: 250,
  });
  await expectError(
    "contract: a company cannot apply for its own contract",
    () =>
      applyForContract({
        contractId: coContract.id,
        applicant: companyWallet(seller2.id),
        proposal: "Ourselves.",
      }),
    "own contract",
  );
  await awardContract({
    contractId: coContract.id,
    applicationId: workerApp.id,
    actor: { type: "COMPANY", companyId: seller2.id },
    actorLabel: seller2.name,
  });
  await expectError(
    "contract: a person's contract cannot be invoiced (people do not issue invoices)",
    () => issueContractInvoice({ contractId: coContract.id, payeeCompanyId: seller2.id }),
    "not awarded to your company",
  );

  const workerBefore = await balanceOfUser(worker.id);
  const seller2Before = await balanceOfCompany(seller2.id);
  const treasuryBeforeWorker = await treasuryBalance();
  const workerPay = await payAwardedContractToUser({
    contractId: coContract.id,
    actor: { type: "COMPANY", companyId: seller2.id, label: seller2.name },
  });
  const workerTax = Math.floor((250 * 500) / 10000);
  check(
    "contract: the issuing company paid the person their quoted 250, taxed as company spending",
    workerPay.amount === 250 &&
      (await balanceOfCompany(seller2.id)) === seller2Before - 250 &&
      (await balanceOfUser(worker.id)) === workerBefore + (250 - workerTax) &&
      (await treasuryBalance()) === treasuryBeforeWorker + workerTax,
    {
      workerBefore,
      workerAfter: await balanceOfUser(worker.id),
      tax: workerTax,
    },
  );
  check(
    "contract: the direct payment COMPLETED the contract and recorded its ledger reference",
    (await getContractById(coContract.id))?.contract.status === "COMPLETED" &&
      (await getContractById(coContract.id))?.contract.paidTxRef === workerPay.txRef,
  );
  const workerReplay = await payAwardedContractToUser({
    contractId: coContract.id,
    actor: { type: "COMPANY", companyId: seller2.id, label: seller2.name },
  });
  check(
    "contract: a duplicate direct payment replays the first receipt instead of paying twice",
    workerReplay.replayed === true && workerReplay.txRef === workerPay.txRef,
    workerReplay,
  );
  check(
    "contract: the replay moved no money",
    (await balanceOfUser(worker.id)) === workerBefore + (250 - workerTax),
  );
  await invariant("a company contract paid directly to a person");

  // ==========================================================================
  console.log("\n=== 10. PROMOTIONS (§24) ===\n");
  // ==========================================================================

  const policy = await setPromotionPolicy({
    governmentId: gov.id,
    actorLabel: "government",
    enabled: true,
    dailyRate: 50,
  });
  check(
    "promotion: the Government sets the master switch and the daily rate",
    policy.enabled === true && policy.dailyRate === 50,
    policy,
  );
  await expectError(
    "promotion: a fractional daily rate is refused",
    () =>
      setPromotionPolicy({
        governmentId: gov.id,
        actorLabel: "government",
        enabled: true,
        dailyRate: 12.5,
      }),
    "whole number",
  );

  const adOffer = await createOffer({
    company: seller,
    input: {
      title: `Promoted Scarf ${RUN}`,
      description: "The scarf we are advertising.",
      category: "Clothing",
      unitPrice: 220,
      quantityAvailable: 20,
    },
  });

  await expectError(
    "promotion: a company cannot promote another company's listing",
    () =>
      requestPromotion({
        company: seller2,
        input: {
          offerId: adOffer.id,
          heading: "Not ours",
          shortDescription: "x",
          ctaLabel: "Go",
          requestedDurationDays: 3,
        },
      }),
    "only promote its own listing",
  );

  const pausedAdOffer = await createOffer({
    company: seller,
    input: {
      title: `Paused Promo Target ${RUN}`,
      description: "Paused before promotion.",
      category: "Clothing",
      unitPrice: 10,
      quantityAvailable: 1,
    },
  });
  await setOfferStatus({ offerId: pausedAdOffer.id, companyId: seller.id, status: "PAUSED" });
  await expectError(
    "promotion: only an ACTIVE listing can be promoted",
    () =>
      requestPromotion({
        company: seller,
        input: {
          offerId: pausedAdOffer.id,
          heading: "Paused",
          shortDescription: "x",
          ctaLabel: "Go",
          requestedDurationDays: 3,
        },
      }),
    "ACTIVE listing",
  );

  const campaign = await requestPromotion({
    company: seller,
    input: {
      offerId: adOffer.id,
      heading: `Handwoven, locally made ${RUN}`,
      shortDescription: "Scarves woven by hand, in undyed wool.",
      ctaLabel: "See the scarf",
      requestedDurationDays: 5,
    },
  });
  check(
    "promotion: the request is PENDING and its destination was built server-side from the offer id",
    campaign.status === "PENDING" &&
      campaign.destination === `/market/offers/${adOffer.id}` &&
      campaign.companyId === seller.id,
    campaign,
  );
  await expectError(
    "promotion: one live campaign per company",
    () =>
      requestPromotion({
        company: seller,
        input: {
          offerId: adOffer.id,
          heading: "Second",
          shortDescription: "x",
          ctaLabel: "Go",
          requestedDurationDays: 2,
        },
      }),
    "already has a",
  );
  await expectError(
    "promotion: a PENDING campaign cannot be activated",
    () => activatePromotion({ campaignId: campaign.id, companyId: seller.id }),
    "waiting for Government approval",
  );

  // The rate in force at APPROVAL is the one that is frozen.
  await setPromotionPolicy({
    governmentId: gov.id,
    actorLabel: "government",
    enabled: true,
    dailyRate: 60,
  });
  const approved = await reviewPromotion({
    campaignId: campaign.id,
    approve: true,
    actorLabel: "government",
    governmentId: gov.id,
  });
  check(
    "promotion: approval freezes the daily rate that was in force at approval (60, not the 50 at request)",
    approved.status === "APPROVED" && approved.dailyRate === 60 && approved.reviewedAt !== null,
    approved,
  );
  await setPromotionPolicy({
    governmentId: gov.id,
    actorLabel: "government",
    enabled: true,
    dailyRate: 50,
  });
  check(
    "promotion: changing the rate afterwards does NOT re-price the approved campaign",
    (await campaignRow(campaign.id)).dailyRate === 60,
    (await campaignRow(campaign.id)).dailyRate,
  );

  const activated = await activatePromotion({ campaignId: campaign.id, companyId: seller.id });
  check(
    "promotion: activation takes the slot and sets an end date from the requested run",
    activated.status === "ACTIVE" &&
      activated.activatedAt !== null &&
      activated.expiresAt !== null &&
      activated.pausedAt === null,
    activated,
  );

  const ad = await getLiveAd();
  check(
    "promotion: the live ad is the ACTIVE campaign, with the company named",
    ad?.id === campaign.id && ad?.companyName === seller.name && ad?.official === false,
    ad,
  );

  // --- the daily charge ------------------------------------------------------
  const adCompanyBefore = await balanceOfCompany(seller.id);
  const adTreasuryBefore = await treasuryBalance();
  const charge1 = await runPromotionCharges();
  check(
    "promotion: the first page load of the day charges the frozen rate",
    charge1.result === "CHARGED" && charge1.amount === 60 && charge1.txRef !== null,
    charge1,
  );
  check(
    "promotion: the Aeros went Company Wallet → Government Treasury",
    (await balanceOfCompany(seller.id)) === adCompanyBefore - 60 &&
      (await treasuryBalance()) === adTreasuryBefore + 60,
    { before: adCompanyBefore, after: await balanceOfCompany(seller.id) },
  );
  check(
    "promotion: lastChargedOn is today's IST calendar day and totalCharged tracks it",
    (await campaignRow(campaign.id)).lastChargedOn === istDateKey() &&
      (await campaignRow(campaign.id)).totalCharged === 60,
    await campaignRow(campaign.id),
  );
  const chargeTx = await txByRef(charge1.txRef as string);
  check(
    "promotion: the ledger row is a tax-free PROMOTION_CHARGE to the Treasury",
    chargeTx.type === "PROMOTION_CHARGE" &&
      chargeTx.taxAmount === 0 &&
      chargeTx.grossAmount === 60 &&
      chargeTx.receiverType === "GOVERNMENT",
    chargeTx,
  );
  await invariant("the first daily promotion charge");

  const charge2 = await runPromotionCharges();
  const charge3 = await runPromotionCharges();
  check(
    "promotion: two more page loads on the SAME IST day charge nothing",
    charge2.result === "ALREADY_CHARGED_TODAY" && charge3.result === "ALREADY_CHARGED_TODAY",
    { charge2, charge3 },
  );
  check(
    "promotion: the balances are untouched by the repeat loads",
    (await balanceOfCompany(seller.id)) === adCompanyBefore - 60 &&
      (await balanceOfCompany(seller.id)) >= 0 &&
      (await campaignRow(campaign.id)).totalCharged === 60,
  );

  // Concurrent page loads on the same day must not double-charge either.
  const concurrentLoads = await Promise.allSettled([
    runPromotionCharges(),
    runPromotionCharges(),
    runPromotionCharges(),
  ]);
  check(
    "promotion: three SIMULTANEOUS page loads still charge nothing more",
    concurrentLoads.every(
      (r) => r.status === "fulfilled" && r.value.result === "ALREADY_CHARGED_TODAY",
    ) && (await campaignRow(campaign.id)).totalCharged === 60,
    concurrentLoads.map((r) => (r.status === "fulfilled" ? r.value.result : (r.reason as Error).message)),
  );
  await invariant("the repeated same-day charge attempts");

  // The next IST day charges again. Backdating lastChargedOn is exactly what
  // the passage of a day does to this column.
  await db
    .update(promotionCampaigns)
    .set({ lastChargedOn: istDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000)) })
    .where(eq(promotionCampaigns.id, campaign.id));
  const nextDay = await runPromotionCharges();
  check(
    "promotion: on the NEXT IST calendar day it charges again",
    nextDay.result === "CHARGED" && nextDay.amount === 60,
    nextDay,
  );
  check(
    "promotion: totalCharged is now two days' worth",
    (await campaignRow(campaign.id)).totalCharged === 120,
    (await campaignRow(campaign.id)).totalCharged,
  );
  await invariant("the next-IST-day charge");

  // --- the single global slot ------------------------------------------------
  const rivalOffer = await createOffer({
    company: seller2,
    input: {
      title: `Rival Pan ${RUN}`,
      description: "A rival's promoted pan.",
      category: "Homeware",
      unitPrice: 400,
      quantityAvailable: 5,
    },
  });
  const rivalCampaign = await requestPromotion({
    company: seller2,
    input: {
      offerId: rivalOffer.id,
      heading: `Cast iron, forever ${RUN}`,
      shortDescription: "One pan for a lifetime.",
      ctaLabel: "See the pan",
      requestedDurationDays: 3,
    },
  });
  await reviewPromotion({
    campaignId: rivalCampaign.id,
    approve: true,
    actorLabel: "government",
    governmentId: gov.id,
  });
  let slotError: unknown = null;
  try {
    await activatePromotion({ campaignId: rivalCampaign.id, companyId: seller2.id });
  } catch (e) {
    slotError = e;
  }
  check(
    "promotion: a SECOND activation is refused gracefully — one ACTIVE campaign globally",
    slotError instanceof PromotionSlotTakenError &&
      /ad slot/.test((slotError as Error).message),
    slotError instanceof Error ? slotError.message : slotError,
  );
  const activeCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(promotionCampaigns)
    .where(eq(promotionCampaigns.status, "ACTIVE"));
  check(
    "promotion: the database holds exactly one ACTIVE campaign",
    activeCount[0].n === 1,
    activeCount[0],
  );

  // --- insufficient funds ---------------------------------------------------
  await db
    .update(promotionCampaigns)
    .set({ lastChargedOn: istDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000)) })
    .where(eq(promotionCampaigns.id, campaign.id));
  await drainCompany(seller.id);
  check("promotion: the promoting company now holds nothing", (await balanceOfCompany(seller.id)) === 0);
  const treasuryBeforeFail = await treasuryBalance();
  const failedCharge = await runPromotionCharges();
  check(
    "promotion: a company that cannot pay has its campaign PAUSED instead of being charged",
    failedCharge.result === "PAUSED_INSUFFICIENT_FUNDS" &&
      (await campaignRow(campaign.id)).status === "PAUSED" &&
      (await campaignRow(campaign.id)).pausedAt !== null,
    failedCharge,
  );
  check(
    "promotion: the balance is 0 and never negative, and no Aeros were invented",
    (await balanceOfCompany(seller.id)) === 0 &&
      (await treasuryBalance()) === treasuryBeforeFail &&
      (await campaignRow(campaign.id)).totalCharged === 120,
    { company: await balanceOfCompany(seller.id), treasury: await treasuryBalance() },
  );
  check(
    "promotion: the failed charge did NOT claim the day, so a later top-up can still be billed",
    (await campaignRow(campaign.id)).lastChargedOn !==
      istDateKey(),
    (await campaignRow(campaign.id)).lastChargedOn,
  );
  await invariant("the failed promotion charge");

  // The slot is now free, so the rival can take it.
  const rivalActive = await activatePromotion({
    campaignId: rivalCampaign.id,
    companyId: seller2.id,
  });
  check(
    "promotion: pausing freed the slot, so the next campaign can take it",
    rivalActive.status === "ACTIVE",
    rivalActive,
  );
  const rivalAd = await getLiveAd();
  check("promotion: the live ad is now the rival's", rivalAd?.id === rivalCampaign.id, rivalAd);
  await expectError(
    "promotion: the paused campaign cannot resume while the slot is taken",
    () => activatePromotion({ campaignId: campaign.id, companyId: seller.id }),
    "ad slot",
  );
  await cancelPromotion({ campaignId: rivalCampaign.id, companyId: seller2.id });
  check(
    "promotion: cancelling frees the slot and leaves no live ad",
    (await getLiveAd()) === null,
  );
  await invariant("freeing the promotion slot");

  // --- official / system promotions -----------------------------------------
  const official = await createOfficialPromotion({
    governmentId: gov.id,
    actorLabel: "government",
    kind: "NEW_PLAYER_BONUS",
    heading: `Welcome to Aeros Pay ${RUN}`,
    shortDescription: "New here? The Government funds every new account.",
    ctaLabel: "Learn more",
    destination: "/updates",
    durationDays: 7,
    activate: true,
  });
  check(
    "promotion: a Government promotion has no company and a zero rate",
    official.status === "ACTIVE" && official.companyId === null && official.dailyRate === 0,
    official,
  );
  const officialAd = await getLiveAd();
  check(
    "promotion: the official promotion is the live ad and is marked official",
    officialAd?.id === official.id && officialAd?.official === true,
    officialAd,
  );
  const treasuryBeforeOfficial = await treasuryBalance();
  const officialCharge = await runPromotionCharges();
  check(
    "promotion: an official promotion is never charged — no company, no Aeros move",
    officialCharge.result === "FREE_OFFICIAL" &&
      (await treasuryBalance()) === treasuryBeforeOfficial,
    officialCharge,
  );
  await expectError(
    "promotion: an official promotion's destination must be an in-app path",
    () =>
      createOfficialPromotion({
        governmentId: gov.id,
        actorLabel: "government",
        kind: "GOVERNMENT_DEMAND",
        heading: "Offsite",
        shortDescription: "x",
        ctaLabel: "Go",
        destination: "https://example.com",
        durationDays: 1,
      }),
    "in-app path",
  );
  await invariant("the official promotion");

  // A campaign that has run its course completes itself.
  await db
    .update(promotionCampaigns)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(promotionCampaigns.id, official.id));
  const completedCharge = await runPromotionCharges();
  check(
    "promotion: a campaign past its end date COMPLETES itself on the next page load",
    completedCharge.result === "COMPLETED" &&
      (await campaignRow(official.id)).status === "COMPLETED" &&
      (await getLiveAd()) === null,
    completedCharge,
  );
  const noAdCharge = await runPromotionCharges();
  check(
    "promotion: with no ACTIVE campaign the charge run is a cheap no-op",
    noAdCharge.result === "NO_ACTIVE_CAMPAIGN",
    noAdCharge,
  );

  // Promotions can be switched off entirely.
  await setPromotionPolicy({
    governmentId: gov.id,
    actorLabel: "government",
    enabled: false,
    dailyRate: 50,
  });
  await expectError(
    "promotion: with promotions switched off, no new campaign can be requested",
    () =>
      requestPromotion({
        company: seller2,
        input: {
          offerId: rivalOffer.id,
          heading: "Off",
          shortDescription: "x",
          ctaLabel: "Go",
          requestedDurationDays: 1,
        },
      }),
    "switched promotions off",
  );
  await setPromotionPolicy({
    governmentId: gov.id,
    actorLabel: "government",
    enabled: true,
    dailyRate: 50,
  });
  await invariant("the promotion policy switch");

  // ==========================================================================
  console.log("\n=== CLEANUP ===\n");
  // ==========================================================================

  // Free the slot and sweep every fixture balance back with real transfers, so
  // the suite can run again and the treasury is not drained.
  const liveCampaigns = await db
    .select({ id: promotionCampaigns.id, companyId: promotionCampaigns.companyId })
    .from(promotionCampaigns)
    .where(inArray(promotionCampaigns.status, ["PENDING", "APPROVED", "ACTIVE", "PAUSED"]));
  for (const row of liveCampaigns) {
    await cancelPromotion({
      campaignId: row.id,
      companyId: row.companyId,
      byGovernment: true,
      actorLabel: "test cleanup",
    }).catch(() => undefined);
  }
  check(
    "cleanup: no campaign is left occupying the global ad slot",
    (await getLiveAd()) === null,
  );

  await sweepFixtures();
  const end = await totals();
  check(
    "CLEANUP: sweeping fixtures back to the treasury preserves the invariant",
    end.accounted === end.supply && end.supply === baselineSupply,
    end,
  );

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
