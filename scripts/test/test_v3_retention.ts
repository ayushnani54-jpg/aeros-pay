/**
 * V3 PHASE I — RETENTION, CLEANUP AND THE SCHEDULED JOB
 *
 * Runs against a real Postgres database. Areas:
 *
 *   1. THE ALLOWLIST. Cleanup can only act on the tables named in
 *      CLEANUP_TARGETS. Every financial table is attempted explicitly and
 *      proved unreachable, both by name and by a forged target object that
 *      claims an allowlisted key.
 *   2. EACH POLICY. Every configured period deletes/clears exactly the rows it
 *      is supposed to — and a row one day younger than the cutoff survives.
 *   3. THE STAR SURVIVES. A rating loses its comment and keeps its star and
 *      its contribution to the average.
 *   4. FINANCIAL ORDERS SURVIVE. A PAID order and an order that produced an
 *      invoice are left alone even though their status/age would otherwise
 *      match.
 *   5. BATCHING, RESUMPTION AND IDEMPOTENCE. More rows than one batch;
 *      repeated runs converge; an interrupted run resumes; a second run is a
 *      no-op.
 *   6. NO PER-RECORD BOOKKEEPING. Every table in the database is counted
 *      before and after a cleanup and only the intended deltas are allowed —
 *      including audit_logs, which must not grow at all on an automatic run.
 *   7. THE SUPPLY INVARIANT, before and after everything.
 *   8. THE CRON ROUTE'S AUTHORIZATION: a missing, malformed, wrong and
 *      correct secret, and the unconfigured case.
 */
import "dotenv/config";
import { db, pool } from "../../src/db/client";
import {
  companies,
  government,
  idempotencyKeys,
  marketplaceContractApplications,
  marketplaceContracts,
  marketplaceOffers,
  marketplaceOrderRatings,
  marketplaceOrders,
  marketplaceWantedRequests,
  marketplaceWantedResponses,
  notifications,
  promotionCampaigns,
  registrationCodes,
  retentionSettings,
  supportMessages,
  supportThreads,
  transactions,
  updates,
  users,
} from "../../src/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";

import { transfer } from "../../src/lib/payments";
import { companyWallet, governmentWallet, userWallet } from "../../src/lib/wallets";
import {
  CLEANUP_TARGETS,
  CLEANABLE_TABLE_NAMES,
  PROTECTED_TABLE_NAMES,
  RetentionError,
  assertCleanableTable,
  assertCleanableTarget,
  getRetentionSettings,
  previewFullCleanup,
  runCleanupTarget,
  runFullCleanup,
  type CleanupTarget,
  type CleanupTargetKey,
} from "../../src/lib/retention";
import { authorizeCronRequest } from "../../src/lib/cron";
import { getCompanyRatingSummary } from "../../src/lib/ratings";
import { addIstDays } from "../../src/lib/datetime";

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

function expectThrows(label: string, fn: () => unknown, substring?: string) {
  try {
    fn();
    failed++;
    console.log(`FAIL  ${label} — expected a throw, got none`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (substring && !msg.includes(substring)) {
      failed++;
      console.log(`FAIL  ${label} — wrong error: "${msg}"`);
      return;
    }
    passed++;
    console.log(`PASS  ${label}`);
  }
}

async function expectRejects(label: string, fn: () => Promise<unknown>, substring: string) {
  try {
    await fn();
    failed++;
    console.log(`FAIL  ${label} — expected a rejection, got none`);
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

const RUN = Date.now().toString(36).slice(-5);
const FIXTURE_PREFIX = "v3r_";

async function totals() {
  const [gov] = await db.select().from(government).limit(1);
  const [u] = await db.select({ s: sql<number>`coalesce(sum(balance),0)::int` }).from(users);
  const [c] = await db.select({ s: sql<number>`coalesce(sum(balance),0)::int` }).from(companies);
  return { treasury: gov.balance, supply: gov.totalSupply, accounted: gov.balance + u.s + c.s };
}

let baselineSupply = 0;

/** Every table in the database, with its row count. */
async function countEverything(): Promise<Record<string, number>> {
  const { rows } = await db.execute(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const out: Record<string, number> = {};
  for (const r of rows as Array<{ tablename: string }>) {
    const res = await db.execute(
      sql`SELECT count(*)::int AS c FROM ${sql.identifier(r.tablename)}`,
    );
    out[r.tablename] = Number((res.rows[0] as { c: number }).c);
  }
  return out;
}

function diffCounts(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const delta = (after[key] ?? 0) - (before[key] ?? 0);
    if (delta !== 0) out[key] = delta;
  }
  return out;
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
      reason: "V3 retention test fixture",
    });
  }
  const [funded] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  return funded;
}

async function makeCompany(ownerUserId: string, name: string, username: string) {
  const [company] = await db
    .insert(companies)
    .values({
      ownerUserId,
      name,
      username,
      category: "Testing",
      reason: "V3 retention tests",
      description: "Fixture company for the V3 Phase I suite.",
      status: "APPROVED",
      balance: 0,
    })
    .returning();
  return company;
}

async function sweepFixtures(): Promise<void> {
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
        reason: "V3 retention fixture sweep",
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
        reason: "V3 retention fixture sweep",
        skipSenderCheck: true,
        skipReceiverCheck: true,
      });
    }
  }
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/** Runs ONLY the named targets, so a fixture-shaped assertion is never
 * disturbed by unrelated rows another suite happened to leave behind. */
async function cleanup(only: CleanupTargetKey[], opts: Record<string, unknown> = {}) {
  return runFullCleanup({ source: "CRON" }, { only, ...opts });
}

async function main() {
  const start = await totals();
  baselineSupply = start.supply;
  check(
    "INVARIANT at start: supply = treasury + users + companies",
    start.accounted === start.supply,
    start,
  );

  // ==========================================================================
  console.log("\n=== 1. THE ALLOWLIST IS THE ONLY WAY IN ===\n");
  // ==========================================================================

  const FINANCIAL_TABLES = [
    "transactions",
    "users",
    "companies",
    "government",
    "invoices",
    "issuance_requests",
    "issuance_votes",
    "issuance_eligible_voters",
    "loans",
    "loan_instalments",
    "loan_payments",
    "loan_actions",
    "company_sale_listings",
    "company_sale_offers",
    "company_sale_records",
    "audit_logs",
    "tax_matrix",
    "reconciliation_status",
    "marketplace_contracts",
    "registration_codes",
  ];

  for (const table of FINANCIAL_TABLES) {
    check(
      `ALLOWLIST: "${table}" is NOT cleanable`,
      !CLEANABLE_TABLE_NAMES.has(table) && PROTECTED_TABLE_NAMES.has(table),
    );
  }

  expectThrows(
    "ALLOWLIST: assertCleanableTable('transactions') throws",
    () => assertCleanableTable("transactions"),
    "not an allowlisted cleanable table",
  );
  expectThrows(
    "ALLOWLIST: assertCleanableTable('invoices') throws",
    () => assertCleanableTable("invoices"),
    "not an allowlisted cleanable table",
  );
  expectThrows(
    "ALLOWLIST: assertCleanableTable('audit_logs') throws",
    () => assertCleanableTable("audit_logs"),
    "not an allowlisted cleanable table",
  );

  // A forged target: it claims an allowlisted KEY, but names the ledger and
  // carries a DELETE that would wipe it. The registry identity check is what
  // stops it — the name check alone would not, because it claims NOTIFICATIONS.
  const forgedLedgerTarget = {
    ...CLEANUP_TARGETS.find((t) => t.key === "NOTIFICATIONS")!,
    tableName: "transactions",
    eligibleIds: () => sql`SELECT "id" FROM "transactions" LIMIT 1`,
    applyToIds: (ids: string[]) =>
      sql`DELETE FROM "transactions" WHERE "id" = ANY(${ids}::uuid[])`,
  } as unknown as CleanupTarget;

  const txCountBeforeForge = (
    await db.select({ c: sql<number>`count(*)::int` }).from(transactions)
  )[0].c;

  expectThrows(
    "ALLOWLIST: a forged target naming `transactions` is refused",
    () => assertCleanableTarget(forgedLedgerTarget),
    "not an allowlisted cleanable table",
  );
  await expectRejects(
    "ALLOWLIST: runCleanupTarget refuses to execute the forged ledger target",
    () => runCleanupTarget(forgedLedgerTarget, new Date()),
    "not an allowlisted cleanable table",
  );

  // A forged target that keeps an allowlisted NAME but is not the registered
  // object — the case the name check cannot catch.
  const impostor = {
    ...CLEANUP_TARGETS.find((t) => t.key === "NOTIFICATIONS")!,
    applyToIds: () => sql`DELETE FROM "notifications"`,
  } as unknown as CleanupTarget;
  await expectRejects(
    "ALLOWLIST: an impostor target for an allowlisted table is refused too",
    () => runCleanupTarget(impostor, new Date()),
    "not the registered cleanup target",
  );

  const txCountAfterForge = (
    await db.select({ c: sql<number>`count(*)::int` }).from(transactions)
  )[0].c;
  check(
    "ALLOWLIST: no ledger row was removed by any of that",
    txCountBeforeForge === txCountAfterForge,
    { txCountBeforeForge, txCountAfterForge },
  );

  check(
    "ALLOWLIST: the registry holds exactly the 11 documented targets",
    CLEANUP_TARGETS.length === 11,
    CLEANUP_TARGETS.map((t) => t.key),
  );
  check(
    "ALLOWLIST: every target's op is one of the three declared kinds",
    CLEANUP_TARGETS.every((t) =>
      ["DELETE_ROWS", "CLEAR_COLUMNS", "RETIRE_ROWS"].includes(t.op),
    ),
  );
  check(
    "ALLOWLIST: the rating target may never touch `stars`",
    !CLEANUP_TARGETS.find((t) => t.key === "RATING_COMMENTS")!.columnsTouched.includes("stars"),
  );
  check(
    "ALLOWLIST: protected tables outnumber cleanable ones (protection is the default)",
    PROTECTED_TABLE_NAMES.size > CLEANABLE_TABLE_NAMES.size,
    { protected: PROTECTED_TABLE_NAMES.size, cleanable: CLEANABLE_TABLE_NAMES.size },
  );

  // ==========================================================================
  console.log("\n=== 2. FIXTURES ===\n");
  // ==========================================================================

  const owner = await makeUser(`${FIXTURE_PREFIX}owner_${RUN}`, 0);
  const buyer = await makeUser(`${FIXTURE_PREFIX}buyer_${RUN}`, 0);
  const seller = await makeCompany(owner.id, `Retention Co ${RUN}`, `${FIXTURE_PREFIX}co_${RUN}`);
  check("FIXTURES: user and company created", !!owner.id && !!seller.id);

  // Pin every period to a known value so the assertions below are about the
  // engine, not about whatever the Government last configured.
  await db.update(retentionSettings).set({
    updatesRetentionDays: 30,
    notificationsRetentionDays: 30,
    supportRetentionDays: 7,
    pausedOfferRetentionDays: 14,
    ratingCommentRetentionDays: 30,
    expiredWantedRetentionDays: 30,
    expiredOrderRetentionDays: 30,
    expiredContractRetentionDays: 30,
    promotionCampaignRetentionDays: 90,
    idempotencyKeyRetentionDays: 1,
  });

  const settings = await getRetentionSettings();
  check(
    "SETTINGS: the spec's defaults are the configured values",
    settings.notificationsRetentionDays === 30 &&
      settings.supportRetentionDays === 7 &&
      settings.pausedOfferRetentionDays === 14 &&
      settings.ratingCommentRetentionDays === 30 &&
      settings.idempotencyKeyRetentionDays === 1,
    settings,
  );

  // ==========================================================================
  console.log("\n=== 3. NOTIFICATIONS: 30 DAYS ===\n");
  // ==========================================================================

  const oldNotif = await db
    .insert(notifications)
    .values({
      userId: owner.id,
      type: "TEST",
      message: `old ${RUN}`,
      createdAt: daysAgo(31),
    })
    .returning();
  const youngNotif = await db
    .insert(notifications)
    .values({
      userId: owner.id,
      type: "TEST",
      message: `young ${RUN}`,
      createdAt: daysAgo(29),
    })
    .returning();

  await cleanup(["NOTIFICATIONS"]);

  const notifLeft = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(inArray(notifications.id, [oldNotif[0].id, youngNotif[0].id]));
  check(
    "NOTIFICATIONS: the 31-day-old one is gone and the 29-day-old one survives",
    notifLeft.length === 1 && notifLeft[0].id === youngNotif[0].id,
    notifLeft,
  );

  // ==========================================================================
  console.log("\n=== 4. SUPPORT MESSAGES: 7 DAYS ===\n");
  // ==========================================================================

  const [thread] = await db
    .insert(supportThreads)
    .values({ userId: buyer.id, status: "OPEN" })
    .returning();
  const [oldMsg] = await db
    .insert(supportMessages)
    .values({
      threadId: thread.id,
      senderType: "USER",
      senderLabel: buyer.username,
      body: `old support ${RUN}`,
      createdAt: daysAgo(8),
    })
    .returning();
  const [youngMsg] = await db
    .insert(supportMessages)
    .values({
      threadId: thread.id,
      senderType: "USER",
      senderLabel: buyer.username,
      body: `young support ${RUN}`,
      createdAt: daysAgo(6),
    })
    .returning();

  await cleanup(["SUPPORT_MESSAGES"]);

  const msgsLeft = await db
    .select({ id: supportMessages.id })
    .from(supportMessages)
    .where(inArray(supportMessages.id, [oldMsg.id, youngMsg.id]));
  const threadStillThere = await db
    .select({ id: supportThreads.id })
    .from(supportThreads)
    .where(eq(supportThreads.id, thread.id));
  check(
    "SUPPORT: the 8-day-old message is gone, the 6-day-old one stays",
    msgsLeft.length === 1 && msgsLeft[0].id === youngMsg.id,
    msgsLeft,
  );
  check("SUPPORT: the THREAD itself is never deleted", threadStillThere.length === 1);

  // ==========================================================================
  console.log("\n=== 5. PAUSED LISTINGS: 14 DAYS (CLOSED, NOT DELETED) ===\n");
  // ==========================================================================

  const [stalePaused] = await db
    .insert(marketplaceOffers)
    .values({
      companyId: seller.id,
      title: `Stale paused ${RUN}`,
      description: "paused a long time ago",
      category: "Testing",
      unitPrice: 10,
      quantityAvailable: 5,
      status: "PAUSED",
      pausedAt: daysAgo(15),
    })
    .returning();
  const [freshPaused] = await db
    .insert(marketplaceOffers)
    .values({
      companyId: seller.id,
      title: `Fresh paused ${RUN}`,
      description: "paused recently",
      category: "Testing",
      unitPrice: 10,
      quantityAvailable: 5,
      status: "PAUSED",
      pausedAt: daysAgo(13),
    })
    .returning();
  const [activeOffer] = await db
    .insert(marketplaceOffers)
    .values({
      companyId: seller.id,
      title: `Active ${RUN}`,
      description: "never paused",
      category: "Testing",
      unitPrice: 10,
      quantityAvailable: 5,
      status: "ACTIVE",
    })
    .returning();

  await cleanup(["PAUSED_OFFERS"]);

  const offerRows = await db
    .select({ id: marketplaceOffers.id, status: marketplaceOffers.status, closedAt: marketplaceOffers.closedAt })
    .from(marketplaceOffers)
    .where(inArray(marketplaceOffers.id, [stalePaused.id, freshPaused.id, activeOffer.id]));
  const byId = new Map(offerRows.map((r) => [r.id, r]));
  check(
    "PAUSED OFFERS: the 15-day-old paused listing is CLOSED",
    byId.get(stalePaused.id)?.status === "CLOSED" && byId.get(stalePaused.id)?.closedAt !== null,
    byId.get(stalePaused.id),
  );
  check(
    "PAUSED OFFERS: the listing ROW still exists (orders point at it)",
    offerRows.length === 3,
  );
  check(
    "PAUSED OFFERS: the 13-day-old one is still PAUSED",
    byId.get(freshPaused.id)?.status === "PAUSED",
  );
  check(
    "PAUSED OFFERS: an ACTIVE listing is untouched",
    byId.get(activeOffer.id)?.status === "ACTIVE",
  );

  // ==========================================================================
  console.log("\n=== 6. RATING COMMENTS: THE STAR SURVIVES ===\n");
  // ==========================================================================

  // Two completed orders on this seller so the average has something to say.
  const madeOrders: string[] = [];
  for (let i = 0; i < 2; i++) {
    const [o] = await db
      .insert(marketplaceOrders)
      .values({
        orderNumber: `RTN-${RUN}-R${i}`,
        offerId: activeOffer.id,
        sellerCompanyId: seller.id,
        buyerType: "USER",
        buyerUserId: buyer.id,
        quantity: 1,
        unitPrice: 10,
        subtotal: 10,
        status: "COMPLETED",
        completedAt: new Date(),
        paidAt: new Date(),
        expiresAt: daysAgo(-7),
      })
      .returning();
    madeOrders.push(o.id);
  }

  const [expiringRating] = await db
    .insert(marketplaceOrderRatings)
    .values({
      orderId: madeOrders[0],
      raterType: "USER",
      raterUserId: buyer.id,
      ratedCompanyId: seller.id,
      stars: 5,
      comment: "Loved it, will buy again",
      commentExpiresAt: daysAgo(1),
    })
    .returning();
  const [freshRating] = await db
    .insert(marketplaceOrderRatings)
    .values({
      orderId: madeOrders[1],
      raterType: "USER",
      raterUserId: buyer.id,
      ratedCompanyId: seller.id,
      stars: 3,
      comment: "Fine",
      commentExpiresAt: addIstDays(new Date(), 30),
    })
    .returning();

  const summaryBefore = await getCompanyRatingSummary(seller.id);

  await cleanup(["RATING_COMMENTS"]);

  const [clearedRating] = await db
    .select()
    .from(marketplaceOrderRatings)
    .where(eq(marketplaceOrderRatings.id, expiringRating.id));
  const [keptRating] = await db
    .select()
    .from(marketplaceOrderRatings)
    .where(eq(marketplaceOrderRatings.id, freshRating.id));
  const summaryAfter = await getCompanyRatingSummary(seller.id);

  check("RATINGS: the expired comment is NULL", clearedRating.comment === null);
  check("RATINGS: the star survived", clearedRating.stars === 5, clearedRating.stars);
  check(
    "RATINGS: the row records that a comment was cleared",
    clearedRating.commentClearedAt !== null,
  );
  check("RATINGS: the row itself was not deleted", !!clearedRating.id);
  check("RATINGS: an unexpired comment is untouched", keptRating.comment === "Fine");
  check(
    "RATINGS: the average is unchanged by clearing a comment",
    summaryBefore.count === summaryAfter.count && summaryBefore.average === summaryAfter.average,
    { summaryBefore, summaryAfter },
  );

  // ==========================================================================
  console.log("\n=== 7. LAPSED WANTED REQUESTS AND THEIR REPLIES ===\n");
  // ==========================================================================

  const [staleWanted] = await db
    .insert(marketplaceWantedRequests)
    .values({
      requesterType: "USER",
      requesterUserId: buyer.id,
      heading: `Stale wanted ${RUN}`,
      description: "expired long ago",
      category: "Testing",
      quantity: 1,
      budget: 10,
      status: "EXPIRED",
      closedAt: daysAgo(31),
      expiresAt: daysAgo(31),
    })
    .returning();
  const [fulfilledWanted] = await db
    .insert(marketplaceWantedRequests)
    .values({
      requesterType: "USER",
      requesterUserId: buyer.id,
      heading: `Fulfilled wanted ${RUN}`,
      description: "fulfilled long ago — must be kept",
      category: "Testing",
      quantity: 1,
      budget: 10,
      status: "FULFILLED",
      closedAt: daysAgo(90),
      expiresAt: daysAgo(90),
    })
    .returning();
  const [staleReply] = await db
    .insert(marketplaceWantedResponses)
    .values({
      requestId: staleWanted.id,
      responderType: "USER",
      responderUserId: owner.id,
      message: "I can do that",
    })
    .returning();

  await cleanup(["WANTED_RESPONSES", "WANTED_REQUESTS"]);

  const wantedLeft = await db
    .select({ id: marketplaceWantedRequests.id })
    .from(marketplaceWantedRequests)
    .where(inArray(marketplaceWantedRequests.id, [staleWanted.id, fulfilledWanted.id]));
  const replyLeft = await db
    .select({ id: marketplaceWantedResponses.id })
    .from(marketplaceWantedResponses)
    .where(eq(marketplaceWantedResponses.id, staleReply.id));
  check(
    "WANTED: the lapsed request is gone, the FULFILLED one is kept",
    wantedLeft.length === 1 && wantedLeft[0].id === fulfilledWanted.id,
    wantedLeft,
  );
  check("WANTED: its reply went with it (and first)", replyLeft.length === 0);

  // ==========================================================================
  console.log("\n=== 8. LAPSED ORDERS — AND THE ONES THAT MUST SURVIVE ===\n");
  // ==========================================================================

  const [disposableOrder] = await db
    .insert(marketplaceOrders)
    .values({
      orderNumber: `RTN-${RUN}-D`,
      offerId: activeOffer.id,
      sellerCompanyId: seller.id,
      buyerType: "USER",
      buyerUserId: buyer.id,
      quantity: 1,
      unitPrice: 10,
      subtotal: 10,
      status: "EXPIRED",
      expiresAt: daysAgo(31),
    })
    .returning();
  const [recentlyExpiredOrder] = await db
    .insert(marketplaceOrders)
    .values({
      orderNumber: `RTN-${RUN}-N`,
      offerId: activeOffer.id,
      sellerCompanyId: seller.id,
      buyerType: "USER",
      buyerUserId: buyer.id,
      quantity: 1,
      unitPrice: 10,
      subtotal: 10,
      status: "EXPIRED",
      expiresAt: daysAgo(29),
    })
    .returning();
  // Financially relevant despite the CANCELLED status and the age: it was paid.
  const [paidButCancelled] = await db
    .insert(marketplaceOrders)
    .values({
      orderNumber: `RTN-${RUN}-P`,
      offerId: activeOffer.id,
      sellerCompanyId: seller.id,
      buyerType: "USER",
      buyerUserId: buyer.id,
      quantity: 1,
      unitPrice: 10,
      subtotal: 10,
      status: "CANCELLED",
      paidAt: daysAgo(60),
      cancelledAt: daysAgo(60),
      expiresAt: daysAgo(60),
    })
    .returning();
  const [completedOld] = await db
    .insert(marketplaceOrders)
    .values({
      orderNumber: `RTN-${RUN}-C`,
      offerId: activeOffer.id,
      sellerCompanyId: seller.id,
      buyerType: "USER",
      buyerUserId: buyer.id,
      quantity: 1,
      unitPrice: 10,
      subtotal: 10,
      status: "COMPLETED",
      completedAt: daysAgo(200),
      paidAt: daysAgo(200),
      expiresAt: daysAgo(200),
    })
    .returning();
  // A rated order that also carries a terminal status and plenty of age.
  const [ratedButCancelled] = await db
    .insert(marketplaceOrders)
    .values({
      orderNumber: `RTN-${RUN}-G`,
      offerId: activeOffer.id,
      sellerCompanyId: seller.id,
      buyerType: "USER",
      buyerUserId: buyer.id,
      quantity: 1,
      unitPrice: 10,
      subtotal: 10,
      status: "CANCELLED",
      cancelledAt: daysAgo(80),
      expiresAt: daysAgo(80),
    })
    .returning();
  await db.insert(marketplaceOrderRatings).values({
    orderId: ratedButCancelled.id,
    raterType: "USER",
    raterUserId: buyer.id,
    ratedCompanyId: seller.id,
    stars: 4,
  });

  await cleanup(["EXPIRED_ORDERS"]);

  const orderIds = [
    disposableOrder.id,
    recentlyExpiredOrder.id,
    paidButCancelled.id,
    completedOld.id,
    ratedButCancelled.id,
  ];
  const ordersLeft = new Set(
    (
      await db
        .select({ id: marketplaceOrders.id })
        .from(marketplaceOrders)
        .where(inArray(marketplaceOrders.id, orderIds))
    ).map((r) => r.id),
  );
  check("ORDERS: the 31-day-old unpaid EXPIRED order is deleted", !ordersLeft.has(disposableOrder.id));
  check("ORDERS: the 29-day-old one survives (inside the window)", ordersLeft.has(recentlyExpiredOrder.id));
  check(
    "ORDERS: a CANCELLED order that was PAID is never deleted",
    ordersLeft.has(paidButCancelled.id),
  );
  check("ORDERS: a COMPLETED order is never deleted", ordersLeft.has(completedOld.id));
  check(
    "ORDERS: a CANCELLED order carrying a rating is never deleted",
    ordersLeft.has(ratedButCancelled.id),
  );

  // ==========================================================================
  console.log("\n=== 9. CLOSED-CONTRACT APPLICATIONS AND UNCHARGED PROMOTIONS ===\n");
  // ==========================================================================

  const [deadContract] = await db
    .insert(marketplaceContracts)
    .values({
      contractNumber: `RTC-${RUN}-1`,
      issuerType: "COMPANY",
      issuerCompanyId: seller.id,
      title: `Dead contract ${RUN}`,
      requirement: "something",
      description: "expired unfilled",
      budget: 100,
      status: "EXPIRED",
      closedAt: daysAgo(40),
      expiresAt: daysAgo(40),
    })
    .returning();
  const [deadApplication] = await db
    .insert(marketplaceContractApplications)
    .values({
      contractId: deadContract.id,
      applicantType: "USER",
      applicantUserId: buyer.id,
      proposal: "I would like to do this",
    })
    .returning();

  const [chargedPromo] = await db
    .insert(promotionCampaigns)
    .values({
      companyId: seller.id,
      heading: `Charged promo ${RUN}`,
      shortDescription: "was charged, must survive",
      ctaLabel: "Go",
      destination: "/market",
      requestedDurationDays: 3,
      dailyRate: 50,
      status: "CANCELLED",
      cancelledAt: daysAgo(200),
      totalCharged: 50,
      createdAt: daysAgo(200),
    })
    .returning();
  const [unchargedPromo] = await db
    .insert(promotionCampaigns)
    .values({
      companyId: seller.id,
      heading: `Rejected promo ${RUN}`,
      shortDescription: "never charged",
      ctaLabel: "Go",
      destination: "/market",
      requestedDurationDays: 3,
      dailyRate: 50,
      status: "REJECTED",
      reviewedAt: daysAgo(100),
      totalCharged: 0,
      createdAt: daysAgo(100),
    })
    .returning();

  await cleanup(["CONTRACT_APPLICATIONS", "PROMOTION_CAMPAIGNS"]);

  const appLeft = await db
    .select({ id: marketplaceContractApplications.id })
    .from(marketplaceContractApplications)
    .where(eq(marketplaceContractApplications.id, deadApplication.id));
  const contractLeft = await db
    .select({ id: marketplaceContracts.id })
    .from(marketplaceContracts)
    .where(eq(marketplaceContracts.id, deadContract.id));
  const promosLeft = new Set(
    (
      await db
        .select({ id: promotionCampaigns.id })
        .from(promotionCampaigns)
        .where(inArray(promotionCampaigns.id, [chargedPromo.id, unchargedPromo.id]))
    ).map((r) => r.id),
  );

  check("CONTRACTS: the application to a lapsed contract is deleted", appLeft.length === 0);
  check("CONTRACTS: the CONTRACT itself is never deleted", contractLeft.length === 1);
  check("PROMOTIONS: an uncharged rejected campaign is deleted", !promosLeft.has(unchargedPromo.id));
  check(
    "PROMOTIONS: a campaign that was ever charged is never deleted",
    promosLeft.has(chargedPromo.id),
  );

  // ==========================================================================
  console.log("\n=== 10. IDEMPOTENCY KEYS ===\n");
  // ==========================================================================

  const [expiredKey] = await db
    .insert(idempotencyKeys)
    .values({
      key: `rtn-${RUN}-expired`,
      scope: "TEST",
      actorType: "USER",
      actorId: buyer.id,
      requestHash: "0".repeat(64),
      status: "SUCCEEDED",
      expiresAt: daysAgo(1),
    })
    .returning();
  const [liveKey] = await db
    .insert(idempotencyKeys)
    .values({
      key: `rtn-${RUN}-live`,
      scope: "TEST",
      actorType: "USER",
      actorId: buyer.id,
      requestHash: "0".repeat(64),
      status: "SUCCEEDED",
      expiresAt: daysAgo(-1),
    })
    .returning();

  await cleanup(["IDEMPOTENCY_KEYS"]);

  const keysLeft = new Set(
    (
      await db
        .select({ id: idempotencyKeys.id })
        .from(idempotencyKeys)
        .where(inArray(idempotencyKeys.id, [expiredKey.id, liveKey.id]))
    ).map((r) => r.id),
  );
  check("IDEMPOTENCY: an expired key is removed", !keysLeft.has(expiredKey.id));
  check("IDEMPOTENCY: a live key is kept", keysLeft.has(liveKey.id));

  // ==========================================================================
  console.log("\n=== 11. BATCHING, RESUMPTION AND IDEMPOTENCE ===\n");
  // ==========================================================================

  const BATCH = 10;
  const SEEDED = 35; // deliberately more than three whole batches
  await db.insert(notifications).values(
    Array.from({ length: SEEDED }, (_, i) => ({
      userId: owner.id,
      type: "TEST_BATCH",
      message: `batch ${RUN} #${i}`,
      createdAt: daysAgo(40),
    })),
  );

  const notifTarget = CLEANUP_TARGETS.find((t) => t.key === "NOTIFICATIONS")!;
  const cutoff = daysAgo(30);

  // ONE batch only: this is the "interrupted run" — the process stops with
  // rows still due.
  const firstPass = await runCleanupTarget(notifTarget, cutoff, {
    batchSize: BATCH,
    maxBatches: 1,
  });
  check(
    "BATCHING: a single-batch run removes exactly one batch",
    firstPass.affected === BATCH && firstPass.batches === 1,
    firstPass,
  );
  check("BATCHING: it reports that it did NOT finish", firstPass.completed === false);

  // RESUME: run again from nothing but the predicate. No cursor is stored
  // anywhere — the second run simply re-probes.
  const secondPass = await runCleanupTarget(notifTarget, cutoff, {
    batchSize: BATCH,
    maxBatches: 1,
  });
  check(
    "RESUMPTION: the next run picks up exactly where the last one stopped",
    secondPass.affected === BATCH,
    secondPass,
  );

  // Now let it converge.
  const thirdPass = await runCleanupTarget(notifTarget, cutoff, { batchSize: BATCH });
  check(
    "BATCHING: a full run converges on the remainder in several bounded batches",
    thirdPass.affected === SEEDED - 2 * BATCH && thirdPass.batches >= 2 && thirdPass.completed,
    thirdPass,
  );

  const leftover = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(notifications)
    .where(sql`${notifications.type} = 'TEST_BATCH'`);
  check("BATCHING: nothing eligible is left behind", leftover[0].c === 0, leftover[0]);

  const fourthPass = await runCleanupTarget(notifTarget, cutoff, { batchSize: BATCH });
  check(
    "IDEMPOTENT: an immediate re-run is a complete no-op",
    fourthPass.affected === 0 && fourthPass.batches === 0 && fourthPass.completed,
    fourthPass,
  );

  // A budget of zero must stop before doing anything at all.
  await db.insert(notifications).values({
    userId: owner.id,
    type: "TEST_BUDGET",
    message: `budget ${RUN}`,
    createdAt: daysAgo(40),
  });
  const budgetless = await runCleanupTarget(notifTarget, cutoff, {
    batchSize: BATCH,
    deadline: Date.now() - 1,
  });
  check(
    "BUDGET: an exhausted budget stops the sweep immediately and says so",
    budgetless.affected === 0 && budgetless.completed === false,
    budgetless,
  );
  await db.execute(sql`DELETE FROM "notifications" WHERE "type" = 'TEST_BUDGET'`);

  // ==========================================================================
  console.log("\n=== 12. A RUN WRITES NO ROW PER RECORD ===\n");
  // ==========================================================================

  // Seed a known, mixed workload.
  await db.insert(notifications).values(
    Array.from({ length: 12 }, (_, i) => ({
      userId: owner.id,
      type: "TEST_NOLOG",
      message: `nolog ${RUN} #${i}`,
      createdAt: daysAgo(40),
    })),
  );
  await db.insert(updates).values(
    Array.from({ length: 3 }, (_, i) => ({
      title: `nolog update ${RUN} #${i}`,
      content: "old announcement",
      createdAt: daysAgo(40),
    })),
  );

  const before = await countEverything();
  const autoSummary = await runFullCleanup({ source: "CRON" });
  const after = await countEverything();
  const delta = diffCounts(before, after);

  check(
    "NO PER-RECORD ROWS: notifications fell by exactly the 12 seeded",
    delta.notifications === -12,
    delta,
  );
  check("NO PER-RECORD ROWS: updates fell by exactly the 3 seeded", delta.updates === -3, delta);
  check(
    "NO PER-RECORD ROWS: the audit log did not grow at all on an automatic run",
    (delta.audit_logs ?? 0) === 0,
    delta,
  );
  check(
    "NO PER-RECORD ROWS: NO table grew during the cleanup",
    Object.values(delta).every((d) => d <= 0),
    delta,
  );
  check(
    "NO PER-RECORD ROWS: only allowlisted tables changed at all",
    Object.keys(delta).every((t) => CLEANABLE_TABLE_NAMES.has(t)),
    Object.keys(delta),
  );
  check(
    "SUMMARY: the run reports what it did",
    autoSummary.totalAffected >= 15 && autoSummary.ok,
    { totalAffected: autoSummary.totalAffected, ok: autoSummary.ok },
  );

  const afterSettings = await getRetentionSettings();
  check(
    "SUMMARY: it is stored on the settings row, with a last-success timestamp",
    afterSettings.lastCleanupAt !== null && afterSettings.lastCleanupSuccessAt !== null,
  );
  const storedSummary = afterSettings.lastCleanupSummary as { targets?: unknown[] } | null;
  check(
    "SUMMARY: the stored summary is one compact object, not a list of records",
    !!storedSummary &&
      Array.isArray(storedSummary.targets) &&
      storedSummary.targets.length === CLEANUP_TARGETS.length,
  );

  // Second full run over the same data.
  const beforeSecond = await countEverything();
  const secondSummary = await runFullCleanup({ source: "CRON" });
  const afterSecond = await countEverything();
  check(
    "IDEMPOTENT: a second full run changes no row count anywhere",
    Object.keys(diffCounts(beforeSecond, afterSecond)).length === 0,
    diffCounts(beforeSecond, afterSecond),
  );
  check(
    "IDEMPOTENT: and reports zero affected",
    secondSummary.totalAffected === 0,
    secondSummary.totalAffected,
  );

  // ==========================================================================
  console.log("\n=== 13. 'NO POLICY' MEANS NEVER ===\n");
  // ==========================================================================

  await db.update(retentionSettings).set({ updatesRetentionDays: null });
  const [survivor] = await db
    .insert(updates)
    .values({ title: `never delete ${RUN}`, content: "old", createdAt: daysAgo(3650) })
    .returning();
  const nullSummary = await runFullCleanup({ source: "CRON" }, { only: ["UPDATES"] });
  const survivorLeft = await db
    .select({ id: updates.id })
    .from(updates)
    .where(eq(updates.id, survivor.id));
  check(
    "NO POLICY: a NULL period deletes nothing, however old the row",
    survivorLeft.length === 1 && nullSummary.totalAffected === 0,
  );
  await db.update(retentionSettings).set({ updatesRetentionDays: 30 });
  await db.execute(sql`DELETE FROM "updates" WHERE "id" = ${survivor.id}::uuid`);

  // ==========================================================================
  console.log("\n=== 14. THE PREVIEW AGREES WITH THE ENGINE ===\n");
  // ==========================================================================

  await db.insert(notifications).values(
    Array.from({ length: 7 }, (_, i) => ({
      userId: owner.id,
      type: "TEST_PREVIEW",
      message: `preview ${RUN} #${i}`,
      createdAt: daysAgo(40),
    })),
  );
  const previewed = await previewFullCleanup();
  const notifPreview = previewed.targets.find((t) => t.key === "NOTIFICATIONS")!;
  const actual = await runFullCleanup({ source: "CRON" }, { only: ["NOTIFICATIONS"] });
  check(
    "PREVIEW: the eligible count is what the run then removes",
    notifPreview.eligible === actual.totalAffected && actual.totalAffected === 7,
    { previewed: notifPreview.eligible, removed: actual.totalAffected },
  );
  check(
    "PREVIEW: every target is described for the Government panel",
    previewed.targets.length === CLEANUP_TARGETS.length &&
      previewed.targets.every((t) => t.label.length > 0 && t.note.length > 0),
  );

  // ==========================================================================
  console.log("\n=== 15. THE CRON ROUTE'S AUTHORIZATION ===\n");
  // ==========================================================================

  const SECRET = "a-long-random-cron-secret-value-0123456789";

  check(
    "CRON: no header at all is refused",
    authorizeCronRequest(new Headers(), SECRET).ok === false,
  );
  check(
    "CRON: an empty Authorization header is refused",
    authorizeCronRequest(new Headers({ authorization: "" }), SECRET).ok === false,
  );
  check(
    "CRON: a Bearer token that is not the secret is refused",
    authorizeCronRequest(new Headers({ authorization: "Bearer wrong-secret" }), SECRET).ok === false,
  );
  check(
    "CRON: a PREFIX of the secret is refused (constant-time compare, not startsWith)",
    authorizeCronRequest(new Headers({ authorization: `Bearer ${SECRET.slice(0, -1)}` }), SECRET)
      .ok === false,
  );
  check(
    "CRON: the secret without the Bearer scheme is refused",
    authorizeCronRequest(new Headers({ authorization: SECRET }), SECRET).ok === false,
  );
  check(
    "CRON: a correct Bearer token is accepted (Vercel's documented mechanism)",
    authorizeCronRequest(new Headers({ authorization: `Bearer ${SECRET}` }), SECRET).ok === true,
  );
  check(
    "CRON: the Bearer scheme is case-insensitive, as HTTP requires",
    authorizeCronRequest(new Headers({ authorization: `bearer ${SECRET}` }), SECRET).ok === true,
  );
  check(
    "CRON: x-cron-secret is accepted as an equivalent carrier",
    authorizeCronRequest(new Headers({ "x-cron-secret": SECRET }), SECRET).ok === true,
  );
  check(
    "CRON: a wrong x-cron-secret is refused",
    authorizeCronRequest(new Headers({ "x-cron-secret": "nope" }), SECRET).ok === false,
  );
  // "" and "   " stand for an unconfigured CRON_SECRET. They are passed
  // EXPLICITLY rather than as `undefined`, which would fall through to the
  // parameter's default and read the developer's own environment — making the
  // result of this assertion depend on whose machine it runs on.
  check(
    "CRON: FAIL CLOSED — with no secret configured, even a correct-looking token is refused",
    authorizeCronRequest(new Headers({ authorization: `Bearer ${SECRET}` }), "").ok === false,
  );
  check(
    "CRON: a whitespace-only configured secret is treated as unconfigured, not as a match",
    authorizeCronRequest(new Headers({ authorization: "Bearer    " }), "   ").ok === false,
  );
  const unconfigured = authorizeCronRequest(new Headers(), "");
  check(
    "CRON: the unconfigured case is distinguishable to the operator",
    unconfigured.ok === false && unconfigured.reason === "NOT_CONFIGURED",
  );
  const configuredButAbsent = authorizeCronRequest(new Headers(), SECRET);
  check(
    "CRON: a configured secret with no header presented is MISSING, not NOT_CONFIGURED",
    configuredButAbsent.ok === false && configuredButAbsent.reason === "MISSING",
    configuredButAbsent,
  );

  // ==========================================================================
  console.log("\n=== 16. THE SUPPLY INVARIANT ===\n");
  // ==========================================================================

  const endBeforeSweep = await totals();
  check(
    "INVARIANT: cleanup never moved a single Aero",
    endBeforeSweep.supply === baselineSupply && endBeforeSweep.accounted === endBeforeSweep.supply,
    endBeforeSweep,
  );

  // ==========================================================================
  console.log("\n=== CLEANUP ===\n");
  // ==========================================================================

  await sweepFixtures();
  const end = await totals();
  check(
    "CLEANUP: sweeping fixtures back to the treasury preserves the invariant",
    end.accounted === end.supply && end.supply === baselineSupply,
    end,
  );

  // Fixture rows this suite created that retention would never remove. Deleted
  // directly (not through any retention path) so repeated runs stay clean.
  await db.execute(
    sql`DELETE FROM "marketplace_order_ratings" WHERE "rated_company_id" = ${seller.id}::uuid`,
  );
  await db.execute(
    sql`DELETE FROM "marketplace_orders" WHERE "seller_company_id" = ${seller.id}::uuid`,
  );
  await db.execute(sql`DELETE FROM "marketplace_offers" WHERE "company_id" = ${seller.id}::uuid`);
  await db.execute(
    sql`DELETE FROM "marketplace_contract_applications" WHERE "contract_id" = ${deadContract.id}::uuid`,
  );
  await db.execute(sql`DELETE FROM "marketplace_contracts" WHERE "id" = ${deadContract.id}::uuid`);
  await db.execute(sql`DELETE FROM "promotion_campaigns" WHERE "company_id" = ${seller.id}::uuid`);
  await db.execute(
    sql`DELETE FROM "marketplace_wanted_responses" WHERE "responder_user_id" = ${owner.id}::uuid`,
  );
  await db.execute(
    sql`DELETE FROM "marketplace_wanted_requests" WHERE "requester_user_id" = ${buyer.id}::uuid`,
  );
  await db.execute(sql`DELETE FROM "idempotency_keys" WHERE "scope" = 'TEST'`);
  await db.execute(sql`DELETE FROM "notifications" WHERE "user_id" = ${owner.id}::uuid`);
  await db.execute(sql`DELETE FROM "support_messages" WHERE "thread_id" = ${thread.id}::uuid`);
  await db.execute(sql`DELETE FROM "support_threads" WHERE "id" = ${thread.id}::uuid`);
  await db
    .update(companies)
    .set({ status: "REVOKED", revokedAt: new Date(), revokeReason: "V3 retention test cleanup" })
    .where(eq(companies.id, seller.id));

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
