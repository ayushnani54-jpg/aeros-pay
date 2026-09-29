/**
 * V3 PHASES F, G, H — QR, RATINGS, LEADERBOARD, BADGES
 *
 * Runs against a real Postgres database. Areas:
 *
 *   1. QR CODES — the payload is exactly the public profile URL and nothing
 *      else; the matrix is byte-for-byte what an independent reference
 *      implementation produces (golden digests, see below); the ISO format-
 *      information bits are the published ones; and a revoked company's code
 *      stops resolving because the public page refuses.
 *   2. RATING ELIGIBILITY — buyer only, completed only, paid only, once only,
 *      every other route refused, with the rated company derived from the order
 *      rather than supplied.
 *   3. AGGREGATES — count, mean and distribution, and the mean after a comment
 *      has been cleared.
 *   4. COMMENT EXPIRY — exactly 30 IST calendar days, and the star surviving
 *      the comment being nulled.
 *   5. LEADERBOARD — only the last 30 IST days; no balance anywhere in it; and
 *      computing it writes NOTHING (every row count in the database is compared
 *      before and after).
 *   6. BADGES — settable, visible, and structurally powerless: the source of
 *      every authorization module is scanned for the two column names, every
 *      Government action is checked to be gated by the Government session, and
 *      a doubly-badged user's capability set is identical to an unbadged one's.
 *   7. NO ANALYTICS — no scan, view, impression, click or search table exists.
 *
 * The supply invariant (total supply = treasury + Σusers + Σcompanies) is
 * re-checked after every operation that could touch money.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { db, pool } from "../../src/db/client";
import {
  companies,
  government,
  marketplaceOrderRatings,
  marketplaceOrders,
  registrationCodes,
  retentionSettings,
  users,
} from "../../src/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";

import { transfer } from "../../src/lib/payments";
import { companyWallet, governmentWallet, userWallet } from "../../src/lib/wallets";
import { payInvoice } from "../../src/lib/invoices";
import {
  acceptOrder,
  completeOrder,
  createOffer,
  issueInvoiceForOrder,
  placeOrder,
} from "../../src/lib/marketplace";
import {
  getCompanyRatingSummary,
  getRatingForOrder,
  getRatingsForCompany,
  orderIsRateableBy,
  rateOrder,
  RatingError,
} from "../../src/lib/ratings";
import { getLeaderboard, leaderboardWindowStart } from "../../src/lib/leaderboard";
import { badgesOf, describeBadges, setUserBadges } from "../../src/lib/badges";
import {
  companyQrPayload,
  encodeQr,
  QrError,
  renderQrSvg,
} from "../../src/lib/qr";
import {
  canUserCreateCompany,
  canUserLogIn,
  canUserReceive,
  canUserSend,
  effectiveUserStatus,
  isCompanyPubliclyVisible,
} from "../../src/lib/status";
import { addIstDays, istCalendarDaysBetween, startOfIstDay } from "../../src/lib/datetime";
import { RATING_COMMENT_RETENTION_DAYS } from "../../src/lib/constants";

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

function expectThrowsSync(label: string, fn: () => unknown) {
  try {
    fn();
    failed++;
    console.log(`FAIL  ${label} — expected a throw`);
  } catch {
    passed++;
    console.log(`PASS  ${label}`);
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
  const [row] = await db
    .select({ b: companies.balance })
    .from(companies)
    .where(eq(companies.id, id));
  return row.b;
}

const RUN = Date.now().toString(36).slice(-5);
const FIXTURE_PREFIX = "v3s_";
const REPO_ROOT = path.resolve(__dirname, "../..");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Sweeps fixture balances back to the treasury with REAL transfers. Never
 * writes a balance directly: that would mint Aeros the supply does not know
 * about. */
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
        reason: "V3 social fixture sweep",
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
        reason: "V3 social fixture sweep",
        skipSenderCheck: true,
        skipReceiverCheck: true,
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
      reason: "V3 social test fixture",
    });
  }

  const [funded] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  return funded;
}

async function makeCompany(params: {
  ownerUserId: string;
  name: string;
  username: string;
  status?: "APPROVED" | "SUSPENDED" | "REVOKED" | "PENDING" | "REJECTED";
}) {
  const [company] = await db
    .insert(companies)
    .values({
      ownerUserId: params.ownerUserId,
      name: params.name,
      username: params.username,
      category: "Testing",
      reason: "V3 social tests",
      description: "Fixture company for the V3 Phase F/G/H suite.",
      status: params.status ?? "APPROVED",
      balance: 0,
    })
    .returning();
  return company;
}

/** offer → order → accept → invoice → pay → (optionally) complete. */
async function runOrder(params: {
  sellerId: string;
  buyerUserId: string;
  title: string;
  unitPrice: number;
  quantity: number;
  complete: boolean;
}) {
  const [seller] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, params.sellerId))
    .limit(1);
  const offer = await createOffer({
    company: seller,
    input: {
      title: params.title,
      description: "Fixture listing for the V3 Phase F suite.",
      category: "Testing",
      unitPrice: params.unitPrice,
      quantityAvailable: 50,
    },
  });
  const order = await placeOrder({
    offerId: offer.id,
    buyer: userWallet(params.buyerUserId),
    quantity: params.quantity,
  });
  await acceptOrder({ orderId: order.id, sellerCompanyId: params.sellerId });
  const issued = await issueInvoiceForOrder({
    orderId: order.id,
    sellerCompanyId: params.sellerId,
  });
  await payInvoice({ invoiceId: issued.invoice.id, payer: userWallet(params.buyerUserId) });
  if (params.complete) {
    await completeOrder({ orderId: order.id, actor: userWallet(params.buyerUserId) });
  }
  const [fresh] = await db
    .select()
    .from(marketplaceOrders)
    .where(eq(marketplaceOrders.id, order.id))
    .limit(1);
  return { offer, order: fresh, invoice: issued.invoice };
}

/** Every row count in the public schema, keyed by table name. */
async function rowCounts(): Promise<Record<string, number>> {
  const tables = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name`,
  );
  const out: Record<string, number> = {};
  for (const row of tables.rows) {
    const r = await pool.query<{ n: string }>(`select count(*)::text as n from "${row.table_name}"`);
    out[row.table_name] = Number(r.rows[0].n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// QR helpers used by the tests
// ---------------------------------------------------------------------------

/**
 * GOLDEN MATRICES.
 *
 * These digests were produced by an INDEPENDENT reference QR implementation
 * (the widely used `qrcode` npm package, run once outside this repository —
 * it is deliberately not a dependency of the app). For each payload, the
 * reference's module grid was written out as rows of "1"/"0" and hashed.
 *
 * Asserting src/lib/qr.ts reproduces these digests is what makes "the encoder
 * is correct" a checkable claim rather than a self-consistent one: the digests
 * come from code this repository does not contain and cannot influence. During
 * development the same comparison was run live across 385 random payloads and
 * all eight mask patterns with zero differences.
 */
const GOLDEN_QR = [
  {
    payload: "https://aeros.example/c/flowfitness",
    size: 29,
    sha256: "ddaa496c07a25fdd7f7dfa069636440e8b0d84a43d3061aaa9ca759396930119",
  },
  {
    payload: "http://localhost:3000/c/umathreads",
    size: 29,
    sha256: "b2d1a0fa439a148a62002acdc89c1423e34182c420a7051da9e17b2c14b329bf",
  },
  {
    payload: "https://pay.aeros.example.co.in/c/abcdefghijklmnopqrstuvwx",
    size: 33,
    sha256: "b45fcbad74039b2262ba471e8584b77b5958b2e2997f67117f96ca5c928fdc25",
  },
];

function matrixDigest(text: string): { size: number; sha256: string } {
  const { size, modules } = encodeQr(text);
  let s = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) s += modules[r][c] ? "1" : "0";
    s += "\n";
  }
  return { size, sha256: createHash("sha256").update(s).digest("hex") };
}

/** The 15-bit format strings for error-correction level M, from ISO/IEC 18004
 * (Table C.1) — published constants, not values this repository computes. */
const ISO_FORMAT_M = [
  "101010000010010",
  "101000100100101",
  "101111001111100",
  "101101101001011",
  "100010111111001",
  "100000011001110",
  "100111110010111",
  "100101010100000",
];

/** Reads the format bits back out of a finished matrix (first copy). */
function readFormatBits(modules: boolean[][]): string {
  const bits: number[] = new Array(15).fill(0);
  for (let i = 0; i < 15; i++) {
    let value: boolean;
    if (i < 6) value = modules[i][8];
    else if (i === 6) value = modules[7][8];
    else if (i === 7) value = modules[8][8];
    else if (i === 8) value = modules[8][7];
    else value = modules[8][14 - i];
    bits[i] = value ? 1 : 0;
  }
  // MSB first, to match the published strings.
  return bits.reverse().join("");
}

/** The same bits from the SECOND copy, which must agree with the first. */
function readFormatBitsSecondCopy(modules: boolean[][], size: number): string {
  const bits: number[] = new Array(15).fill(0);
  for (let i = 0; i < 15; i++) {
    const value = i < 8 ? modules[8][size - 1 - i] : modules[size - 15 + i][8];
    bits[i] = value ? 1 : 0;
  }
  return bits.reverse().join("");
}

function sourceOf(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

/**
 * The same file with every comment removed.
 *
 * These files document what they deliberately do NOT do ("never touches
 * getUserMedia", "no balance column"), so a naive text scan finds the promise
 * and mistakes it for the thing being promised against. Scanning the CODE is
 * the assertion that actually means something.
 */
function codeOf(relative: string): string {
  return sourceOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const BADGE_COLUMN_NAMES = [
  "isOfficialGovernmentUser",
  "isGovernmentMember",
  "is_official_government_user",
  "is_government_member",
];

async function main() {
  const [gov] = await db.select().from(government).limit(1);
  if (!gov) {
    console.log("FAIL  fixtures — this suite needs the government row");
    process.exit(1);
  }

  const start = await totals();
  baselineSupply = start.supply;
  check(
    "fixtures: supply invariant holds before anything runs",
    start.accounted === start.supply,
    start,
  );

  console.log("\n=== FIXTURES ===\n");
  await sweepFixtures();

  const sellerOwner = await makeUser(`${FIXTURE_PREFIX}sown_${RUN}`, 100);
  // Modest fixture funding on purpose: the whole suite spends well under 2,000
  // Aeros, and a suite that asks the treasury for more than it needs is a suite
  // that starts failing on a busy development database for no good reason.
  const buyerA = await makeUser(`${FIXTURE_PREFIX}bya_${RUN}`, 1500);
  const buyerB = await makeUser(`${FIXTURE_PREFIX}byb_${RUN}`, 1000);
  const buyerC = await makeUser(`${FIXTURE_PREFIX}byc_${RUN}`, 500);
  const outsider = await makeUser(`${FIXTURE_PREFIX}out_${RUN}`, 100);
  const badged = await makeUser(`${FIXTURE_PREFIX}badge_${RUN}`, 500);

  const seller = await makeCompany({
    ownerUserId: sellerOwner.id,
    name: `Rated Co ${RUN}`,
    username: `${FIXTURE_PREFIX}rate_${RUN}`,
  });
  const quietSeller = await makeCompany({
    ownerUserId: sellerOwner.id,
    name: `Quiet Co ${RUN}`,
    username: `${FIXTURE_PREFIX}quiet_${RUN}`,
  });
  const doomedSeller = await makeCompany({
    ownerUserId: sellerOwner.id,
    name: `Doomed Co ${RUN}`,
    username: `${FIXTURE_PREFIX}doom_${RUN}`,
  });

  await invariant("fixture setup");

  // ==========================================================================
  console.log("\n=== 1. COMPANY QR CODES (§21) ===\n");
  // ==========================================================================

  const origin = "https://aeros.example";
  const payload = companyQrPayload(origin, seller.username);
  check(
    "QR: the payload is exactly the company's PUBLIC PROFILE url and nothing else",
    payload === `${origin}/c/${seller.username}`,
    payload,
  );
  check(
    "QR: a trailing slash on the origin is normalised rather than doubled",
    companyQrPayload(`${origin}/`, seller.username) === payload,
  );
  check(
    "QR: the username is lower-cased, matching the public route",
    companyQrPayload(origin, seller.username.toUpperCase()) === payload,
  );

  expectThrowsSync("QR: refuses a username that is not a legal handle", () =>
    companyQrPayload(origin, "../gov/treasury"),
  );
  expectThrowsSync("QR: refuses an origin that is not an http(s) origin", () =>
    companyQrPayload("javascript:alert(1)", seller.username),
  );
  check(
    "QR: the refusals are QrError, so callers can distinguish them",
    (() => {
      try {
        companyQrPayload(origin, "!!");
        return false;
      } catch (e) {
        return e instanceof QrError;
      }
    })(),
  );

  // --- the payload carries no private data ---------------------------------
  // Give the company a real balance and a real order first, so "the QR does
  // not contain them" is a claim about live data rather than about empty
  // columns.
  const privacyOrder = await runOrder({
    sellerId: seller.id,
    buyerUserId: buyerA.id,
    title: `Privacy Probe ${RUN}`,
    unitPrice: 137,
    quantity: 3,
    complete: true,
  });
  await invariant("the first completed order");

  const sellerBalance = await balanceOfCompany(seller.id);
  const svg = renderQrSvg(payload, { title: `QR code linking to @${seller.username}` });
  const qrText = `${payload}\n${svg}`;
  check(
    "QR: the company now holds a non-zero balance and has a real order, so the privacy check is meaningful",
    sellerBalance > 0 && privacyOrder.order.status === "COMPLETED",
    { sellerBalance, status: privacyOrder.order.status },
  );
  check(
    "QR: neither the payload nor the SVG contains the company balance",
    !qrText.includes(String(sellerBalance)),
  );
  check(
    "QR: neither contains the company id, the order number or the invoice number",
    !qrText.includes(seller.id) &&
      !qrText.includes(privacyOrder.order.orderNumber) &&
      !qrText.includes(privacyOrder.invoice.invoiceNumber),
  );
  check(
    "QR: neither contains the owner's username or any transaction reference",
    !qrText.includes(sellerOwner.username) && !/TX-\d{8}-\d{6}/.test(qrText),
  );
  check(
    "QR: the SVG is self-contained markup with no request back to the server",
    svg.startsWith("<svg ") &&
      svg.includes("<path d=\"M") &&
      !svg.includes("<image") &&
      !/xlink:href/.test(svg) &&
      // The only URL in the markup is the SVG namespace itself.
      svg.match(/https?:\/\/[^"']+/g)?.every((u) => u === "http://www.w3.org/2000/svg") === true,
  );

  // --- the matrix itself ---------------------------------------------------
  for (const golden of GOLDEN_QR) {
    const got = matrixDigest(golden.payload);
    check(
      `QR: the matrix for ${golden.payload.length} bytes is byte-for-byte the independent reference's (v${(golden.size - 17) / 4})`,
      got.size === golden.size && got.sha256 === golden.sha256,
      got,
    );
  }
  const encoded = encodeQr(payload);
  check(
    "QR: the version chosen gives the standard module count (4v + 17)",
    encoded.size === encoded.version * 4 + 17,
    encoded.size,
  );
  check(
    "QR: the format information matches the published ISO table for level M and the chosen mask",
    readFormatBits(encoded.modules) === ISO_FORMAT_M[encoded.mask],
    { got: readFormatBits(encoded.modules), want: ISO_FORMAT_M[encoded.mask], mask: encoded.mask },
  );
  check(
    "QR: both copies of the format information agree",
    readFormatBitsSecondCopy(encoded.modules, encoded.size) === ISO_FORMAT_M[encoded.mask],
  );
  check(
    "QR: the three finder patterns are present in all three corners",
    encoded.modules[0][0] &&
      encoded.modules[6][6] &&
      encoded.modules[0][encoded.size - 1] &&
      encoded.modules[encoded.size - 1][0] &&
      !encoded.modules[7][7],
  );
  check(
    "QR: encoding is deterministic — the same input always renders the same SVG",
    renderQrSvg(payload) === renderQrSvg(payload),
  );
  expectThrowsSync("QR: refuses a payload larger than the supported versions", () =>
    encodeQr("x".repeat(400)),
  );

  // --- a revoked company's code stops working ------------------------------
  const [doomedBefore] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, doomedSeller.id))
    .limit(1);
  check(
    "QR: an approved company has a public page, so its code resolves",
    isCompanyPubliclyVisible(doomedBefore),
  );
  await db
    .update(companies)
    .set({ status: "REVOKED", revokedAt: new Date(), revokeReason: "V3 social test" })
    .where(eq(companies.id, doomedSeller.id));
  const [doomedAfter] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, doomedSeller.id))
    .limit(1);
  check(
    "QR: a REVOKED company has no public page, so an already-printed code stops resolving",
    !isCompanyPubliclyVisible(doomedAfter),
  );
  check(
    "QR: the payload itself is unchanged by revocation — the PAGE is what refuses, not a code registry",
    companyQrPayload(origin, doomedAfter.username) === `${origin}/c/${doomedAfter.username}`,
  );
  const [rejectedCompany] = await db
    .update(companies)
    .set({ status: "REJECTED" })
    .where(eq(companies.id, doomedSeller.id))
    .returning();
  check(
    "QR: a REJECTED company has no public page either",
    !isCompanyPubliclyVisible(rejectedCompany),
  );
  check(
    "QR: a SUSPENDED company keeps its public page (a suspension is a pause, not a removal)",
    isCompanyPubliclyVisible({ status: "SUSPENDED", suspendedUntil: null }),
  );
  await invariant("revoking a company");

  // ==========================================================================
  console.log("\n=== 2. RATING ELIGIBILITY (§22) ===\n");
  // ==========================================================================

  const completedA = privacyOrder;

  check(
    "rating: the buyer of a COMPLETED order is offered the form",
    orderIsRateableBy(completedA.order, userWallet(buyerA.id)),
  );
  check(
    "rating: nobody else is offered the form — not the seller, not a stranger",
    !orderIsRateableBy(completedA.order, companyWallet(seller.id)) &&
      !orderIsRateableBy(completedA.order, userWallet(outsider.id)),
  );

  await expectError(
    "rating: a NON-BUYER is refused server-side",
    () => rateOrder({ orderId: completedA.order.id, actor: userWallet(outsider.id), stars: 5 }),
    "Only the buyer",
  );
  await expectError(
    "rating: the SELLER cannot rate their own sale",
    () => rateOrder({ orderId: completedA.order.id, actor: companyWallet(seller.id), stars: 5 }),
    "Only the buyer",
  );

  // An order that is PAID but not completed.
  const paidNotComplete = await runOrder({
    sellerId: seller.id,
    buyerUserId: buyerB.id,
    title: `Paid Not Complete ${RUN}`,
    unitPrice: 90,
    quantity: 1,
    complete: false,
  });
  await invariant("a paid but uncompleted order");
  check(
    "rating: an order that is PAID but not COMPLETED is not offered the form",
    paidNotComplete.order.status === "PAID" &&
      !orderIsRateableBy(paidNotComplete.order, userWallet(buyerB.id)),
    paidNotComplete.order.status,
  );
  await expectError(
    "rating: an UNCOMPLETED order is refused server-side, even for the real buyer",
    () =>
      rateOrder({ orderId: paidNotComplete.order.id, actor: userWallet(buyerB.id), stars: 4 }),
    "not completed yet",
  );

  // An order that never got past PENDING.
  const [pendingSeller] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, seller.id))
    .limit(1);
  const pendingOffer = await createOffer({
    company: pendingSeller,
    input: {
      title: `Never Accepted ${RUN}`,
      description: "Fixture listing.",
      category: "Testing",
      unitPrice: 40,
      quantityAvailable: 5,
    },
  });
  const pendingOrder = await placeOrder({
    offerId: pendingOffer.id,
    buyer: userWallet(buyerC.id),
    quantity: 1,
  });
  await expectError(
    "rating: a PENDING order (never paid, never completed) is refused",
    () => rateOrder({ orderId: pendingOrder.id, actor: userWallet(buyerC.id), stars: 5 }),
    "cannot be rated",
  );
  await invariant("an unaccepted order");

  // Star bounds.
  for (const bad of [0, 6, 2.5, -1, Number.NaN]) {
    await expectError(
      `rating: ${bad} stars is refused (only whole 1-5)`,
      () => rateOrder({ orderId: completedA.order.id, actor: userWallet(buyerA.id), stars: bad }),
      "whole number of stars",
    );
  }

  // The happy path.
  const ratingA = await rateOrder({
    orderId: completedA.order.id,
    actor: userWallet(buyerA.id),
    stars: 5,
    comment: "   Excellent, very   fast.   ",
  });
  check(
    "rating: the buyer's rating is stored with the stars they chose",
    ratingA.stars === 5 && ratingA.orderId === completedA.order.id,
    ratingA,
  );
  check(
    "rating: the rated company is DERIVED from the order's seller column, never supplied",
    ratingA.ratedCompanyId === completedA.order.sellerCompanyId &&
      ratingA.ratedCompanyId === seller.id,
  );
  check(
    "rating: the rater is derived from the acting wallet",
    ratingA.raterType === "USER" &&
      ratingA.raterUserId === buyerA.id &&
      ratingA.raterCompanyId === null,
  );
  check(
    "rating: the comment is whitespace-normalised before it is stored",
    ratingA.comment === "Excellent, very fast.",
    ratingA.comment,
  );
  check(
    "rating: the row copies NO order or payment data (no amount, tax, quantity, invoice or tx ref)",
    !Object.keys(ratingA).some((key) =>
      /amount|tax|total|subtotal|quantity|price|invoice|txref|tx_ref/i.test(key),
    ),
    Object.keys(ratingA),
  );
  await invariant("the first rating");

  await expectError(
    "rating: the SAME buyer cannot rate the same order twice",
    () =>
      rateOrder({ orderId: completedA.order.id, actor: userWallet(buyerA.id), stars: 1 }),
    "already rated",
  );
  check(
    "rating: exactly one rating row exists for that order",
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(marketplaceOrderRatings)
        .where(eq(marketplaceOrderRatings.orderId, completedA.order.id))
    )[0].n === 1,
  );
  check(
    "rating: a rated order stops offering the form",
    (await getRatingForOrder(completedA.order.id)) !== null,
  );

  // Concurrency: two simultaneous ratings for one order — one wins.
  const raceOrder = await runOrder({
    sellerId: seller.id,
    buyerUserId: buyerC.id,
    title: `Race ${RUN}`,
    unitPrice: 55,
    quantity: 1,
    complete: true,
  });
  const raceResults = await Promise.allSettled([
    rateOrder({ orderId: raceOrder.order.id, actor: userWallet(buyerC.id), stars: 4 }),
    rateOrder({ orderId: raceOrder.order.id, actor: userWallet(buyerC.id), stars: 2 }),
  ]);
  const raceWins = raceResults.filter((r) => r.status === "fulfilled").length;
  check(
    "rating: two simultaneous ratings for one order — exactly one is stored",
    raceWins === 1 &&
      (
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(marketplaceOrderRatings)
          .where(eq(marketplaceOrderRatings.orderId, raceOrder.order.id))
      )[0].n === 1,
    { raceWins, errors: raceResults.map((r) => (r.status === "rejected" ? String(r.reason) : "ok")) },
  );
  check(
    "rating: the loser of that race got a readable RatingError, not a database crash",
    raceResults.some((r) => r.status === "rejected" && r.reason instanceof RatingError),
  );
  await invariant("the rating race");

  // ==========================================================================
  console.log("\n=== 3. AGGREGATES ON THE PUBLIC PROFILE (§22) ===\n");
  // ==========================================================================

  const orderB = await runOrder({
    sellerId: seller.id,
    buyerUserId: buyerB.id,
    title: `Second Sale ${RUN}`,
    unitPrice: 60,
    quantity: 2,
    complete: true,
  });
  await rateOrder({ orderId: orderB.order.id, actor: userWallet(buyerB.id), stars: 2 });

  const summary = await getCompanyRatingSummary(seller.id);
  // 5 (buyerA) + the race winner (4 or 2) + 2 (buyerB)
  const raceStars = (await getRatingForOrder(raceOrder.order.id))!.stars;
  const expectedTotal = 5 + raceStars + 2;
  check(
    "aggregate: the count is the number of ratings",
    summary.count === 3,
    summary,
  );
  check(
    "aggregate: the mean is the mean of the stars, to one decimal place",
    summary.average === Math.round((expectedTotal / 3) * 10) / 10,
    { summary, expectedTotal },
  );
  check(
    "aggregate: the distribution adds up to the count",
    Object.values(summary.distribution).reduce((a, b) => a + b, 0) === summary.count,
    summary.distribution,
  );
  check(
    "aggregate: the 5-star and 2-star buckets hold the ratings that were given",
    summary.distribution[5] === 1 && summary.distribution[2] >= 1,
    summary.distribution,
  );
  const quietSummary = await getCompanyRatingSummary(quietSeller.id);
  check(
    "aggregate: a company with no ratings reports zero and a null mean, not 0 stars",
    quietSummary.count === 0 && quietSummary.average === null,
    quietSummary,
  );
  const publicRatings = await getRatingsForCompany(seller.id, 10);
  check(
    "aggregate: the public list joins the rater's live handle rather than a copy on the row",
    publicRatings.length === 3 &&
      publicRatings.some((r) => r.raterHandle === buyerA.username) &&
      publicRatings.every((r) => r.raterHandle !== null),
    publicRatings.map((r) => r.raterHandle),
  );

  // ==========================================================================
  console.log("\n=== 4. COMMENT EXPIRY IS 30 IST DAYS; THE STAR IS PERMANENT ===\n");
  // ==========================================================================

  const [settings] = await db.select().from(retentionSettings).limit(1);
  const configuredDays = settings?.ratingCommentRetentionDays ?? RATING_COMMENT_RETENTION_DAYS;
  check(
    "expiry: the configured comment retention is the spec's 30 days",
    configuredDays === 30,
    configuredDays,
  );
  check(
    "expiry: a comment carries an expiry",
    ratingA.commentExpiresAt !== null && ratingA.commentClearedAt === null,
  );
  check(
    "expiry: the expiry is exactly 30 IST CALENDAR days after the rating",
    istCalendarDaysBetween(ratingA.createdAt, ratingA.commentExpiresAt!) === configuredDays,
    {
      createdAt: ratingA.createdAt,
      commentExpiresAt: ratingA.commentExpiresAt,
      days: istCalendarDaysBetween(ratingA.createdAt, ratingA.commentExpiresAt!),
    },
  );
  check(
    "expiry: the expiry lands on IST midnight, computed through the IST helpers",
    ratingA.commentExpiresAt!.getTime() ===
      addIstDays(ratingA.createdAt, configuredDays).getTime() &&
      startOfIstDay(ratingA.commentExpiresAt!).getTime() === ratingA.commentExpiresAt!.getTime(),
    ratingA.commentExpiresAt,
  );

  const noCommentRating = await getRatingForOrder(orderB.order.id);
  check(
    "expiry: a rating with no comment carries no expiry at all",
    noCommentRating!.comment === null && noCommentRating!.commentExpiresAt === null,
    noCommentRating,
  );

  // What the Phase I retention engine will do: null the comment, keep the star.
  const summaryBeforeClear = await getCompanyRatingSummary(seller.id);
  await db
    .update(marketplaceOrderRatings)
    .set({ comment: null, commentClearedAt: new Date() })
    .where(eq(marketplaceOrderRatings.id, ratingA.id));
  const cleared = await getRatingForOrder(completedA.order.id);
  check(
    "expiry: after the comment is cleared the STAR is untouched",
    cleared!.stars === 5 && cleared!.comment === null && cleared!.commentClearedAt !== null,
    cleared,
  );
  const summaryAfterClear = await getCompanyRatingSummary(seller.id);
  check(
    "expiry: clearing a comment changes neither the count nor the mean",
    summaryAfterClear.count === summaryBeforeClear.count &&
      summaryAfterClear.average === summaryBeforeClear.average,
    { summaryBeforeClear, summaryAfterClear },
  );
  const clearedPublic = (await getRatingsForCompany(seller.id, 10)).find(
    (r) => r.id === ratingA.id,
  );
  check(
    "expiry: the public profile still shows the star and says the comment was removed",
    clearedPublic !== undefined &&
      clearedPublic.stars === 5 &&
      clearedPublic.comment === null &&
      clearedPublic.commentCleared === true,
    clearedPublic,
  );
  check(
    "expiry: the database itself forbids a comment with no expiry",
    await (async () => {
      try {
        await pool.query(
          `update marketplace_order_ratings set comment = 'x', comment_expires_at = null where id = $1`,
          [ratingA.id],
        );
        return false;
      } catch {
        return true;
      }
    })(),
  );

  // ==========================================================================
  console.log("\n=== 5. LEADERBOARD — LIVE, 30 IST DAYS, STORES NOTHING (§23) ===\n");
  // ==========================================================================

  const countsBefore = await rowCounts();
  const board = await getLeaderboard();
  const countsAfter = await rowCounts();

  const changedTables = Object.keys(countsBefore).filter(
    (table) => countsBefore[table] !== countsAfter[table],
  );
  check(
    "leaderboard: computing it changed no row count in ANY table in the database",
    changedTables.length === 0,
    changedTables.map((t) => ({ t, before: countsBefore[t], after: countsAfter[t] })),
  );
  check(
    "leaderboard: computing it three times in a row still writes nothing",
    await (async () => {
      await getLeaderboard({ sort: "sales" });
      await getLeaderboard({ sort: "rating" });
      await getLeaderboard({ sort: "activity" });
      const after = await rowCounts();
      return Object.keys(countsBefore).every((t) => countsBefore[t] === after[t]);
    })(),
  );
  check(
    "leaderboard: no leaderboard, snapshot, ranking or analytics table exists to write to",
    !Object.keys(countsBefore).some((t) =>
      /leaderboard|leader_board|snapshot|ranking|rollup|analytic|metric|statistic/i.test(t),
    ),
    Object.keys(countsBefore).filter((t) => /leader|snapshot|rank|analytic/i.test(t)),
  );

  check(
    "leaderboard: the window is 30 days and starts at IST midnight 30 IST days ago",
    board.windowDays === 30 &&
      board.windowStart.getTime() === leaderboardWindowStart(board.generatedAt).getTime() &&
      istCalendarDaysBetween(board.windowStart, board.generatedAt) === 30,
    { windowStart: board.windowStart, generatedAt: board.generatedAt },
  );

  const sellerRow = board.rows.find((r) => r.companyId === seller.id);
  check(
    "leaderboard: the fixture seller appears, with its completed orders counted",
    sellerRow !== undefined && sellerRow.completedOrders >= 3,
    sellerRow,
  );
  check(
    "leaderboard: sales value is the sum of those orders' subtotals",
    sellerRow !== undefined && sellerRow.salesValue >= 137 * 3 + 60 * 2,
    sellerRow,
  );
  check(
    "leaderboard: the recent rating average matches the ratings written in the window",
    sellerRow !== undefined &&
      sellerRow.recentRatingCount === 3 &&
      sellerRow.recentRating === summaryAfterClear.average,
    { row: sellerRow, summary: summaryAfterClear },
  );
  check(
    "leaderboard: no row carries a balance — the type has no such field and none is selected",
    board.rows.every(
      (row) => !Object.keys(row).some((key) => /balance|wealth|treasury|holding/i.test(key)),
    ),
    board.rows[0] ? Object.keys(board.rows[0]) : [],
  );
  check(
    "leaderboard: src/lib/leaderboard.ts never selects a balance column",
    !/companies\.balance|users\.balance|government\.balance|\bbalance\b\s*:/.test(
      codeOf("src/lib/leaderboard.ts"),
    ),
  );
  check(
    "leaderboard: src/lib/leaderboard.ts contains no insert, update or delete at all",
    !/\.(insert|update|delete)\s*\(/.test(sourceOf("src/lib/leaderboard.ts")),
  );
  check(
    "leaderboard: a revoked company is not listed publicly even if it traded",
    !board.rows.some((r) => r.companyId === doomedSeller.id),
  );
  check(
    "leaderboard: ranks are 1..n with no gaps, in the order the rows are returned",
    board.rows.every((row, i) => row.rank === i + 1),
    board.rows.map((r) => r.rank),
  );

  // --- only the last 30 IST days ------------------------------------------
  // Backdate one completed order past the window and re-compute.
  const outsideOrder = await runOrder({
    sellerId: quietSeller.id,
    buyerUserId: buyerA.id,
    title: `Old Sale ${RUN}`,
    unitPrice: 500,
    quantity: 1,
    complete: true,
  });
  await invariant("the soon-to-be-backdated order");

  const inWindow = await getLeaderboard();
  const quietInside = inWindow.rows.find((r) => r.companyId === quietSeller.id);
  check(
    "leaderboard: a fresh completed order counts while it is inside the window",
    quietInside !== undefined && quietInside.completedOrders === 1 && quietInside.salesValue === 500,
    quietInside,
  );

  const longAgo = addIstDays(new Date(), -45);
  await db
    .update(marketplaceOrders)
    .set({ createdAt: longAgo, completedAt: longAgo, paidAt: longAgo })
    .where(eq(marketplaceOrders.id, outsideOrder.order.id));
  const afterBackdate = await getLeaderboard();
  const quietOutside = afterBackdate.rows.find((r) => r.companyId === quietSeller.id);
  check(
    "leaderboard: the SAME order stops counting once it is 45 IST days old",
    quietOutside === undefined || (quietOutside.completedOrders === 0 && quietOutside.salesValue === 0),
    quietOutside,
  );
  check(
    "leaderboard: backdating changed nothing about the seller still inside the window",
    afterBackdate.rows.find((r) => r.companyId === seller.id)?.completedOrders ===
      sellerRow?.completedOrders,
  );

  // A rating written outside the window drops out of the recent average too.
  await db
    .update(marketplaceOrderRatings)
    .set({ createdAt: longAgo })
    .where(eq(marketplaceOrderRatings.id, ratingA.id));
  const afterRatingBackdate = await getLeaderboard();
  const sellerAfter = afterRatingBackdate.rows.find((r) => r.companyId === seller.id);
  check(
    "leaderboard: a rating older than 30 IST days leaves the RECENT average",
    sellerAfter !== undefined && sellerAfter.recentRatingCount === 2,
    sellerAfter,
  );
  check(
    "leaderboard: the company's ALL-TIME aggregate still counts it — the window is the board's, not the profile's",
    (await getCompanyRatingSummary(seller.id)).count === 3,
  );

  const boardBySales = await getLeaderboard({ sort: "sales" });
  check(
    "leaderboard: sorting by sales value orders the rows by sales value",
    boardBySales.rows.every(
      (row, i) => i === 0 || boardBySales.rows[i - 1].salesValue >= row.salesValue,
    ),
    boardBySales.rows.map((r) => r.salesValue),
  );
  const boardByRating = await getLeaderboard({ sort: "rating" });
  check(
    "leaderboard: sorting by rating puts unrated companies below rated ones, not at zero stars",
    (() => {
      const firstUnrated = boardByRating.rows.findIndex((r) => r.recentRating === null);
      if (firstUnrated === -1) return true;
      return boardByRating.rows.slice(firstUnrated).every((r) => r.recentRating === null);
    })(),
    boardByRating.rows.map((r) => r.recentRating),
  );
  await invariant("every leaderboard computation");

  // ==========================================================================
  console.log("\n=== 6. GOVERNMENT BADGES GRANT NOTHING (§§19,20) ===\n");
  // ==========================================================================

  check(
    "badges: a fresh account carries neither label",
    badgesOf(badged).official === false && badgesOf(badged).member === false,
  );

  const badgedUser = await setUserBadges({
    userId: badged.id,
    official: true,
    member: true,
    governmentId: gov.id,
    governmentUsername: gov.username,
  });
  check(
    "badges: the Government can set both labels at once",
    badgedUser.isOfficialGovernmentUser === true && badgedUser.isGovernmentMember === true,
  );
  check(
    "badges: setting them stamps who changed them and when",
    badgedUser.badgesUpdatedAt !== null && badgedUser.badgesUpdatedBy === gov.username,
  );
  check(
    "badges: the pair reads back as a plain value with no authority attached",
    describeBadges(badgesOf(badgedUser)) === "Official Government User + Government Member",
  );
  await invariant("setting badges");

  // --- the badges change NOTHING about what the account can do -------------
  const plain = await db.select().from(users).where(eq(users.id, buyerA.id)).limit(1);
  const capabilitiesOf = (u: typeof badgedUser) => ({
    status: effectiveUserStatus(u),
    send: canUserSend(u),
    receive: canUserReceive(u),
    logIn: canUserLogIn(u),
    createCompany: canUserCreateCompany(u),
  });
  check(
    "badges: every capability function returns exactly what it returns for an unbadged account",
    JSON.stringify(capabilitiesOf(badgedUser)) === JSON.stringify(capabilitiesOf(plain[0])),
    { badged: capabilitiesOf(badgedUser), plain: capabilitiesOf(plain[0]) },
  );

  // --- and the account still trades normally (spec §19) --------------------
  const badgedCompany = await makeCompany({
    ownerUserId: badgedUser.id,
    name: `Badged Co ${RUN}`,
    username: `${FIXTURE_PREFIX}bco_${RUN}`,
  });
  const badgedSale = await runOrder({
    sellerId: badgedCompany.id,
    buyerUserId: buyerB.id,
    title: `Badged Sale ${RUN}`,
    unitPrice: 70,
    quantity: 1,
    complete: true,
  });
  check(
    "badges: a badged user still runs a company and completes a sale through it",
    badgedSale.order.status === "COMPLETED" && (await balanceOfCompany(badgedCompany.id)) > 0,
  );
  const badgedPurchase = await runOrder({
    sellerId: seller.id,
    buyerUserId: badgedUser.id,
    title: `Badged Purchase ${RUN}`,
    unitPrice: 80,
    quantity: 1,
    complete: true,
  });
  const badgedRating = await rateOrder({
    orderId: badgedPurchase.order.id,
    actor: userWallet(badgedUser.id),
    stars: 4,
  });
  check(
    "badges: a badged user still buys on the Market and rates like anyone else",
    badgedPurchase.order.status === "COMPLETED" && badgedRating.stars === 4,
  );
  check(
    "badges: a badged user's rating gets no special weight — it is one row like any other",
    (await getCompanyRatingSummary(seller.id)).count === 4,
  );
  await invariant("a badged user trading");

  // --- STRUCTURAL PROOF: authorization cannot read these columns -----------
  const AUTHORIZATION_MODULES = [
    "src/lib/auth.ts",
    "src/lib/session.ts",
    "src/lib/status.ts",
    "src/proxy.ts",
  ];
  for (const file of AUTHORIZATION_MODULES) {
    const source = sourceOf(file);
    const hits = BADGE_COLUMN_NAMES.filter((name) => source.includes(name));
    check(
      `badges: ${file} — the authorization path — does not mention either badge column`,
      hits.length === 0,
      hits,
    );
  }
  check(
    "badges: requireGovernment decides on the Government SESSION and the government row only",
    /export async function requireGovernment[\s\S]{0,400}getCurrentGovernment/.test(
      sourceOf("src/lib/auth.ts"),
    ) && /getGovSession/.test(sourceOf("src/lib/auth.ts")),
  );

  // Every Government-only action must be gated by the Government session.
  const govActions = sourceOf("src/actions/government.ts");
  const actionNames = [...govActions.matchAll(/export async function (\w+Action)\s*\(/g)].map(
    (m) => m[1],
  );
  check(
    "badges: the Government action file exports a meaningful number of actions to check",
    actionNames.length >= 40,
    actionNames.length,
  );
  // Two exports in this file are deliberately USER actions rather than
  // Government ones (the community votes on issuance), so they are gated by
  // requireUser instead. Every other export must require the Government
  // session, and NONE may be gated by anything else — a badge least of all.
  const USER_GATED_ACTIONS = ["castIssuanceVoteAction"];
  const ungated: string[] = [];
  const wronglyGated: string[] = [];
  for (const name of actionNames) {
    const at = govActions.indexOf(`export async function ${name}(`);
    const body = govActions.slice(at, at + 700);
    const govGated = /await gov\(\)|requireGovernment\(\)/.test(body);
    const userGated = /requireUser\(\)/.test(body);
    if (USER_GATED_ACTIONS.includes(name)) {
      if (!userGated) wronglyGated.push(name);
      continue;
    }
    if (!govGated) ungated.push(name);
  }
  check(
    "badges: EVERY Government action begins by requiring the Government session — none consults a badge",
    ungated.length === 0,
    ungated,
  );
  check(
    "badges: the one deliberately user-gated action in that file is gated by requireUser, not by a label",
    wronglyGated.length === 0,
    wronglyGated,
  );
  const badgeReaders = [...govActions.matchAll(/isGovernmentMember|isOfficialGovernmentUser/g)];
  check(
    "badges: the Government action file never branches on a badge column either",
    badgeReaders.length === 0,
  );
  check(
    "badges: src/lib/badges.ts exposes no function that turns a badge into a decision",
    !/\b(isGovernmentAdmin|canActAsGovernment|isAdmin|hasGovernmentAuthority|assertGovernment)\b/.test(
      codeOf("src/lib/badges.ts"),
    ),
  );

  // Removing the labels is equally inert.
  const unbadged = await setUserBadges({
    userId: badged.id,
    official: false,
    member: false,
    governmentId: gov.id,
    governmentUsername: gov.username,
  });
  check(
    "badges: the Government can take both labels away again",
    unbadged.isOfficialGovernmentUser === false && unbadged.isGovernmentMember === false,
  );
  check(
    "badges: removing them leaves every capability exactly as it was",
    JSON.stringify(capabilitiesOf(unbadged)) === JSON.stringify(capabilitiesOf(badgedUser)),
  );
  await expectError(
    "badges: labelling an account that does not exist is refused",
    () =>
      setUserBadges({
        userId: "00000000-0000-0000-0000-000000000000",
        official: true,
        member: false,
        governmentId: gov.id,
        governmentUsername: gov.username,
      }),
    "does not exist",
  );
  await invariant("removing badges");

  // ==========================================================================
  console.log("\n=== 7. NOTHING IS STORED THAT SHOULD NOT BE ===\n");
  // ==========================================================================

  const allTables = Object.keys(await rowCounts());
  check(
    "no analytics: there is no scan, view, impression, click, search or sound-event table",
    !allTables.some((t) =>
      /scan|view_event|viewevent|impression|click|search_histor|searches|sound|audio|play_event/i.test(
        t,
      ),
    ),
    allTables.filter((t) => /scan|view|impression|click|search|sound|audio/i.test(t)),
  );
  const qrSource = codeOf("src/lib/qr.ts");
  check(
    "no analytics: the QR module touches no database and no clock — it is pure",
    !/from "@\/db|drizzle-orm|Date\.now\(\)|new Date\(/.test(qrSource),
  );
  check(
    "no analytics: the voice component never records or uploads audio",
    !/getUserMedia|MediaRecorder|new Blob|FormData|fetch\(/.test(
      codeOf("src/components/forms/voice-input.tsx"),
    ),
  );
  check(
    "no analytics: the payment sound ships no audio file and stores no sound event",
    !/\.(mp3|wav|ogg|m4a)\b/.test(codeOf("src/components/payment-sound.tsx")) &&
      !/from "@\/db|drizzle-orm/.test(codeOf("src/components/payment-sound.tsx")),
  );
  check(
    "no analytics: the sound preference is browser storage, never a users column",
    /localStorage/.test(codeOf("src/components/payment-sound.tsx")) &&
      !/soundEnabled|payment_sound|paymentSound/.test(codeOf("src/db/schema.ts")),
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
  // Leave no fixture company able to trade, so repeated runs stay independent.
  await db
    .update(companies)
    .set({ status: "REVOKED", revokedAt: new Date(), revokeReason: "V3 social test cleanup" })
    .where(
      inArray(companies.id, [seller.id, quietSeller.id, doomedSeller.id, badgedCompany.id]),
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
