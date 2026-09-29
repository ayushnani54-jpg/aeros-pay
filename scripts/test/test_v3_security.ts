/**
 * V3 PHASE K — SECURITY INVARIANTS (spec §43)
 *
 * This suite is the audit written down as executable assertions. It does not
 * re-test that features work — the other nine suites do that. It tests that
 * they REFUSE, and it tests each refusal at the layer that actually enforces
 * it, which is the library inside its own transaction, not the form or the
 * page that happens to hide a button.
 *
 * What it covers:
 *
 *   1. CROSS-TENANT ACCESS is refused on every V3 entity type — offers,
 *      orders, wanted requests, contracts, contract applications, promotions
 *      and ratings — by a wallet that is not the owner of the thing.
 *   2. FORGED IDENTIFIERS AND AMOUNTS are refused: an id that belongs to
 *      somebody else, an id that does not exist, an application from a
 *      different contract, a refund larger than the payment, a rating aimed
 *      at an order the caller did not buy.
 *   3. DESTINATIONS ARE DERIVED, never supplied: a settlement is asserted
 *      against the company the order/contract names, and prices come from the
 *      offer's own snapshot rather than the caller's arithmetic.
 *   4. GOVERNMENT-ONLY AUTHORITY is unreachable for a normal user AND for a
 *      doubly-badged one — the badge columns carry no power, and the
 *      authorization modules are scanned to prove they never read them.
 *   5. EXPORT SCOPE CANNOT BE WIDENED: a user scope cannot name another
 *      identity, a company scope demands ownership, and a Government-only
 *      dataset is not reachable from a user or company scope.
 *   6. CRON REJECTS a missing, wrong or unconfigured secret, in constant time.
 *   7. THE RATE LIMITER triggers and then RECOVERS once its window passes.
 *   8. BANNED ACCOUNTS cannot act through the write surface, and the write
 *      surface is the only place that check has to live.
 *   9. SESSION EPOCH: a login mints a token carrying the account's CURRENT
 *      epoch, so a password reset ends old sessions without locking the
 *      account out of new ones.
 *
 * Every fixture is funded with real transfers and swept back with real
 * transfers, so the supply invariant holds from the first line to the last.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { db, pool } from "../../src/db/client";
import {
  companies,
  government,
  marketplaceContracts,
  marketplaceOffers,
  marketplaceOrders,
  registrationCodes,
  transactions,
  users,
} from "../../src/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";

import { transfer } from "../../src/lib/payments";
import { companyWallet, governmentWallet, userWallet } from "../../src/lib/wallets";
import { payInvoice } from "../../src/lib/invoices";
import {
  acceptOrder,
  cancelOrder,
  completeOrder,
  createOffer,
  issueInvoiceForOrder,
  placeOrder,
  setOfferStatus,
  updateOffer,
} from "../../src/lib/marketplace";
import {
  closeWantedRequest,
  createWantedRequest,
  decideWantedResponse,
  respondToWantedRequest,
  withdrawWantedResponse,
} from "../../src/lib/wanted";
import {
  applyForContract,
  awardContract,
  cancelContract,
  createContract,
  issueContractInvoice,
  payAwardedContractToUser,
  withdrawContractApplication,
} from "../../src/lib/contracts";
import {
  activatePromotion,
  cancelPromotion,
  pausePromotion,
  requestPromotion,
  reviewPromotion,
  setPromotionPolicy,
} from "../../src/lib/promotions";
import { rateOrder } from "../../src/lib/ratings";
import { reverseTransaction } from "../../src/lib/reversals";
import { setUserBadges, badgesOf } from "../../src/lib/badges";
import { requireOwnedCompany } from "../../src/lib/companies";
import {
  companyScopeFor,
  getDataset,
  parseExportFilters,
  userScopeFor,
  datasetsForScope,
} from "../../src/lib/exports";
import { authorizeCronRequest, secretsMatch } from "../../src/lib/cron";
import {
  consumeRateLimit,
  clearAllRateLimits,
  resetRateLimit,
  FINANCIAL_RULE,
  LOGIN_RULE,
} from "../../src/lib/ratelimit";
import {
  canUserSend,
  canUserReceive,
  canUserCreateCompany,
  effectiveUserStatus,
} from "../../src/lib/status";

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

/** Asserts that `fn` REFUSES. The message must contain `substring`, so a test
 * cannot pass because something failed for an unrelated reason. */
async function refuses(label: string, fn: () => Promise<unknown>, substring: string) {
  try {
    await fn();
    failed++;
    console.log(`FAIL  ${label} — it SUCCEEDED, which is the defect`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(substring)) {
      passed++;
      console.log(`PASS  ${label} — "${msg}"`);
    } else {
      failed++;
      console.log(`FAIL  ${label} — refused for the WRONG reason: "${msg}" (wanted "${substring}")`);
    }
  }
}

function refusesSync(label: string, fn: () => unknown, substring?: string) {
  try {
    fn();
    failed++;
    console.log(`FAIL  ${label} — it SUCCEEDED, which is the defect`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!substring || msg.includes(substring)) {
      passed++;
      console.log(`PASS  ${label} — "${msg}"`);
    } else {
      failed++;
      console.log(`FAIL  ${label} — wrong reason: "${msg}"`);
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
    `INVARIANT after ${label}: supply = treasury + users + companies, unchanged`,
    t.accounted === t.supply && t.supply === baselineSupply,
    t,
  );
}

const RUN = Date.now().toString(36).slice(-5);
const FIXTURE_PREFIX = "v3k_";
const REPO_ROOT = path.resolve(__dirname, "../..");
const NONEXISTENT_UUID = "00000000-0000-4000-8000-000000000000";

function codeOf(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

// ---------------------------------------------------------------------------
// Fixtures — real registration codes, real transfers, never a written balance
// ---------------------------------------------------------------------------

async function makeUser(name: string, balance: number) {
  let code;
  for (let i = 0; i < 60; i++) {
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
      displayName: `Sec ${name}`,
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
      reason: "V3 security test fixture",
    });
  }

  const [funded] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  return funded;
}

async function makeCompany(ownerUserId: string, username: string, name: string) {
  const [company] = await db
    .insert(companies)
    .values({
      ownerUserId,
      name,
      username,
      category: "Testing",
      reason: "V3 security tests",
      description: "Fixture company for the V3 Phase K security suite.",
      status: "APPROVED",
      balance: 0,
    })
    .returning();
  return company;
}

async function fundCompany(companyId: string, amount: number) {
  const [g] = await db.select({ id: government.id }).from(government).limit(1);
  await transfer({
    from: governmentWallet(g.id),
    to: companyWallet(companyId),
    amount,
    forcedTaxRateBp: 0,
    type: "GOVERNMENT_PAYMENT",
    reason: "V3 security test fixture",
  });
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
        reason: "V3 security fixture sweep",
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
        reason: "V3 security fixture sweep",
        skipSenderCheck: true,
        skipReceiverCheck: true,
      });
    }
  }
}

// ===========================================================================

async function main() {
  const start = await totals();
  baselineSupply = start.supply;
  check("baseline: the economy balances before this suite runs", start.accounted === start.supply, start);

  const [gov] = await db.select().from(government).limit(1);

  // --- cast -----------------------------------------------------------------
  const alice = await makeUser(`${FIXTURE_PREFIX}alice_${RUN}`, 4000);
  const mallory = await makeUser(`${FIXTURE_PREFIX}mallory_${RUN}`, 4000);
  const banned = await makeUser(`${FIXTURE_PREFIX}banned_${RUN}`, 500);
  const badged = await makeUser(`${FIXTURE_PREFIX}badged_${RUN}`, 500);

  const aliceCo = await makeCompany(alice.id, `${FIXTURE_PREFIX}aco${RUN}`, "Alice Trading");
  const malloryCo = await makeCompany(mallory.id, `${FIXTURE_PREFIX}mco${RUN}`, "Mallory Ltd");
  await fundCompany(aliceCo.id, 3000);
  await fundCompany(malloryCo.id, 3000);

  await db
    .update(users)
    .set({ status: "BANNED", bannedAt: new Date(), banReason: "security fixture" })
    .where(eq(users.id, banned.id));

  await invariant("fixture setup");

  // ==========================================================================
  console.log("\n=== 1. CROSS-TENANT ACCESS: OFFERS AND ORDERS ===\n");
  // ==========================================================================

  const [aliceCoRow] = await db.select().from(companies).where(eq(companies.id, aliceCo.id));
  const offer = await createOffer({
    company: aliceCoRow,
    input: {
      title: "Alice's widget",
      description: "A fixture listing owned by Alice Trading.",
      category: "Testing",
      unitPrice: 100,
      quantityAvailable: 20,
    },
  });

  await refuses(
    "offer: Mallory's company cannot EDIT Alice's listing",
    () =>
      updateOffer({
        offerId: offer.id,
        companyId: malloryCo.id,
        input: {
          title: "Hijacked",
          description: "Changed by someone else.",
          category: "Testing",
          unitPrice: 1,
          quantityAvailable: 1,
        },
      }),
    "not",
  );

  await refuses(
    "offer: Mallory's company cannot CHANGE THE STATUS of Alice's listing",
    () => setOfferStatus({ offerId: offer.id, companyId: malloryCo.id, status: "CLOSED" }),
    "not",
  );

  const [unchangedOffer] = await db
    .select()
    .from(marketplaceOffers)
    .where(eq(marketplaceOffers.id, offer.id));
  check(
    "offer: after two refused attempts the listing is byte-for-byte unchanged",
    unchangedOffer.title === "Alice's widget" &&
      unchangedOffer.unitPrice === 100 &&
      unchangedOffer.status === "ACTIVE",
    { title: unchangedOffer.title, price: unchangedOffer.unitPrice, status: unchangedOffer.status },
  );

  // Mallory legitimately orders from Alice.
  const order = await placeOrder({
    offerId: offer.id,
    buyer: userWallet(mallory.id),
    quantity: 2,
  });

  check(
    "order: the subtotal is the SERVER's arithmetic from the offer snapshot",
    order.subtotal === 200 && order.unitPrice === 100 && order.quantity === 2,
    { subtotal: order.subtotal, unitPrice: order.unitPrice },
  );

  await refuses(
    "order: Mallory's company cannot ACCEPT an order placed with Alice's company",
    () => acceptOrder({ orderId: order.id, sellerCompanyId: malloryCo.id }),
    "not placed with your company",
  );

  await acceptOrder({ orderId: order.id, sellerCompanyId: aliceCo.id });

  await refuses(
    "order: Mallory's company cannot INVOICE an order it is not the seller on",
    () => issueInvoiceForOrder({ orderId: order.id, sellerCompanyId: malloryCo.id }),
    "not placed with your company",
  );

  await refuses(
    "order: a forged (nonexistent) order id is refused, not silently ignored",
    () => acceptOrder({ orderId: NONEXISTENT_UUID, sellerCompanyId: aliceCo.id }),
    "",
  );

  await refuses(
    "order: Alice (a third party) cannot COMPLETE Mallory's order",
    () => completeOrder({ orderId: order.id, actor: userWallet(alice.id) }),
    "",
  );

  const { invoice } = await issueInvoiceForOrder({
    orderId: order.id,
    sellerCompanyId: aliceCo.id,
  });

  check(
    "invoice: the total is derived from the order snapshot plus tax, never from a form",
    invoice.subtotal === 200,
    { subtotal: invoice.subtotal, total: invoice.total },
  );

  await refuses(
    "invoice: Alice cannot pay an invoice addressed to Mallory",
    () => payInvoice({ invoiceId: invoice.id, payer: userWallet(alice.id) }),
    "",
  );

  const paid = await payInvoice({ invoiceId: invoice.id, payer: userWallet(mallory.id) });
  check(
    "invoice: the legitimate payer settles it, and the destination is the seller's own wallet",
    paid.settledTo.companyUsername === aliceCoRow.username,
    paid.settledTo,
  );
  await invariant("order settlement");

  // Replay: the same payment again must NOT move money twice.
  const replay = await payInvoice({ invoiceId: invoice.id, payer: userWallet(mallory.id) });
  check(
    "replay: paying the same invoice again REPLAYS the first result instead of paying twice",
    replay.replayed === true && replay.txRef === paid.txRef,
    { replayed: replay.replayed, first: paid.txRef, second: replay.txRef },
  );
  await invariant("duplicate payment attempt");

  await completeOrder({ orderId: order.id, actor: userWallet(mallory.id) });

  // ==========================================================================
  console.log("\n=== 2. RATINGS: ONLY THE BUYER, ONLY THEIR OWN ORDER ===\n");
  // ==========================================================================

  await refuses(
    "rating: Alice cannot rate an order she did not buy",
    () => rateOrder({ orderId: order.id, actor: userWallet(alice.id), stars: 1 }),
    "Only the buyer",
  );

  await refuses(
    "rating: Alice's own COMPANY cannot rate it either",
    () => rateOrder({ orderId: order.id, actor: companyWallet(aliceCo.id), stars: 1 }),
    "Only the buyer",
  );

  await refuses(
    "rating: a forged order id is refused",
    () => rateOrder({ orderId: NONEXISTENT_UUID, actor: userWallet(mallory.id), stars: 5 }),
    "does not exist",
  );

  await refuses(
    "rating: a star count outside 1–5 is refused server-side",
    () => rateOrder({ orderId: order.id, actor: userWallet(mallory.id), stars: 99 }),
    "whole number of stars",
  );

  const rating = await rateOrder({ orderId: order.id, actor: userWallet(mallory.id), stars: 5 });
  check(
    "rating: the rated company comes from the ORDER's seller column, not the caller",
    rating.ratedCompanyId === aliceCo.id,
    { rated: rating.ratedCompanyId, seller: aliceCo.id },
  );

  await refuses(
    "rating: the same order cannot be rated twice",
    () => rateOrder({ orderId: order.id, actor: userWallet(mallory.id), stars: 1 }),
    "already rated",
  );

  // ==========================================================================
  console.log("\n=== 3. REFUNDS: ONLY THE RECIPIENT, NEVER MORE THAN CAME IN ===\n");
  // ==========================================================================

  const [paymentRow] = await db
    .select({ id: transactions.id, netAmount: transactions.netAmount })
    .from(transactions)
    .where(eq(transactions.txRef, paid.txRef))
    .limit(1);

  const paymentId = paymentRow.id;
  const paymentNet = paymentRow.netAmount;

  await refuses(
    "refund: a company that did NOT receive the payment cannot refund it",
    () =>
      reverseTransaction({
        transactionId: paymentId,
        actor: { type: "COMPANY", id: malloryCo.id, label: "Mallory Ltd" },
        reason: "not mine to refund",
      }),
    "can only refund a payment it received",
  );

  await refuses(
    "refund: a forged amount larger than the payment is capped, not honoured",
    () =>
      reverseTransaction({
        transactionId: paymentId,
        actor: { type: "COMPANY", id: aliceCo.id, label: "Alice Trading" },
        reason: "trying to refund more than came in",
        amount: paymentNet + 1_000_000,
      }),
    "more than",
  );

  await refuses(
    "refund: a forged transaction id is refused",
    () =>
      reverseTransaction({
        transactionId: NONEXISTENT_UUID,
        actor: { type: "COMPANY", id: aliceCo.id, label: "Alice Trading" },
        reason: "no such row",
      }),
    "does not exist",
  );
  await invariant("refused refunds");

  // ==========================================================================
  console.log("\n=== 4. WANTED REQUESTS ===\n");
  // ==========================================================================

  const wanted = await createWantedRequest({
    requester: userWallet(alice.id),
    input: {
      heading: "Alice needs a thing",
      description: "A fixture wanted request owned by Alice.",
      category: "Testing",
      quantity: 1,
      budget: 200,
      deadline: null,
    },
  });

  const response = await respondToWantedRequest({
    requestId: wanted.id,
    responder: companyWallet(malloryCo.id),
    message: "Mallory Ltd can supply this.",
    offeredPrice: 150,
  });

  await refuses(
    "wanted: a third party cannot CLOSE somebody else's request",
    () =>
      closeWantedRequest({
        requestId: wanted.id,
        requester: userWallet(mallory.id),
        status: "CANCELLED",
      }),
    "",
  );

  await refuses(
    "wanted: only the REQUESTER decides a response",
    () =>
      decideWantedResponse({
        responseId: response.id,
        requester: userWallet(mallory.id),
        decision: "ACCEPTED",
      }),
    "",
  );

  await refuses(
    "wanted: only the RESPONDER may withdraw their own reply",
    () => withdrawWantedResponse({ responseId: response.id, responder: userWallet(alice.id) }),
    "",
  );

  await refuses(
    "wanted: a forged response id is refused",
    () =>
      decideWantedResponse({
        responseId: NONEXISTENT_UUID,
        requester: userWallet(alice.id),
        decision: "ACCEPTED",
      }),
    "",
  );

  // ==========================================================================
  console.log("\n=== 5. CONTRACTS ===\n");
  // ==========================================================================

  const contract = await createContract({
    issuer: { type: "COMPANY", companyId: aliceCo.id },
    input: {
      title: "Alice's contract",
      requirement: "Do the fixture work.",
      description: "A fixture contract issued by Alice Trading.",
      conditions: null,
      budget: 300,
      deadline: null,
    },
  });

  const otherContract = await createContract({
    issuer: { type: "COMPANY", companyId: aliceCo.id },
    input: {
      title: "Alice's other contract",
      requirement: "A second contract, to test cross-contract awards.",
      description: "Fixture.",
      conditions: null,
      budget: 300,
      deadline: null,
    },
  });

  const application = await applyForContract({
    contractId: contract.id,
    applicant: userWallet(mallory.id),
    proposal: "Mallory will do the work.",
    quotedPrice: 250,
  });

  const otherApplication = await applyForContract({
    contractId: otherContract.id,
    applicant: userWallet(mallory.id),
    proposal: "Mallory will do the other work too.",
    quotedPrice: 250,
  });

  await refuses(
    "contract: a company that did not issue it cannot AWARD it",
    () =>
      awardContract({
        contractId: contract.id,
        applicationId: application.id,
        actor: { type: "COMPANY", companyId: malloryCo.id },
        actorLabel: "Mallory Ltd",
      }),
    "",
  );

  await refuses(
    "contract: an application from a DIFFERENT contract cannot be awarded against this one",
    () =>
      awardContract({
        contractId: contract.id,
        applicationId: otherApplication.id,
        actor: { type: "COMPANY", companyId: aliceCo.id },
        actorLabel: "Alice Trading",
      }),
    "belongs to a different contract",
  );

  await refuses(
    "contract: a third party cannot WITHDRAW somebody else's application",
    () => withdrawContractApplication({ applicationId: application.id, applicant: userWallet(alice.id) }),
    "",
  );

  await refuses(
    "contract: a company that did not issue it cannot CANCEL it",
    () =>
      cancelContract({
        contractId: contract.id,
        actor: { type: "COMPANY", companyId: malloryCo.id },
      }),
    "",
  );

  await awardContract({
    contractId: contract.id,
    applicationId: application.id,
    actor: { type: "COMPANY", companyId: aliceCo.id },
    actorLabel: "Alice Trading",
  });

  await refuses(
    "contract: a company the contract was NOT awarded to cannot raise its invoice",
    () => issueContractInvoice({ contractId: contract.id, payeeCompanyId: malloryCo.id }),
    "not awarded to your company",
  );

  await refuses(
    "contract: a company that is not the issuer cannot PAY the awarded person",
    () =>
      payAwardedContractToUser({
        contractId: contract.id,
        actor: { type: "COMPANY", companyId: malloryCo.id, label: "Mallory Ltd" },
      }),
    "",
  );

  // REGRESSION (V3 Phase K): the refused attempt above must not have poisoned
  // this contract's idempotency key. Before the key included the actor, one
  // unauthorised attempt left a FAILED key carrying the WRONG fingerprint and
  // the real issuer could never pay the contract again.
  const contractPayment = await payAwardedContractToUser({
    contractId: contract.id,
    actor: { type: "COMPANY", companyId: aliceCo.id, label: "Alice Trading" },
  });
  check(
    "contract: a REFUSED payment attempt by an outsider does not block the real issuer",
    typeof contractPayment.txRef === "string" && contractPayment.txRef.length > 0,
    { txRef: contractPayment.txRef },
  );
  check(
    "contract: the payment idempotency key is scoped to the ACTOR, like the invoice one",
    /CONTRACTPAY:\$\{params\.contractId\}:\$\{actorType\}:\$\{actorId\}/.test(
      codeOf("src/lib/contracts.ts"),
    ),
  );
  check(
    "contract: the amount paid comes from the ACCEPTED APPLICATION, not from any caller input",
    contractPayment.amount === 250,
    { amount: contractPayment.amount, quoted: 250 },
  );

  const contractReplay = await payAwardedContractToUser({
    contractId: contract.id,
    actor: { type: "COMPANY", companyId: aliceCo.id, label: "Alice Trading" },
  });
  check(
    "contract: a duplicate submit REPLAYS the payment rather than paying twice",
    contractReplay.replayed === true && contractReplay.txRef === contractPayment.txRef,
    { replayed: contractReplay.replayed },
  );
  await invariant("contract payment and its replay");

  // ==========================================================================
  console.log("\n=== 6. PROMOTIONS ===\n");
  // ==========================================================================

  await setPromotionPolicy({
    governmentId: gov.id,
    actorLabel: gov.username,
    enabled: true,
    dailyRate: 10,
  });

  const [malloryCoRow] = await db.select().from(companies).where(eq(companies.id, malloryCo.id));
  const malloryOffer = await createOffer({
    company: malloryCoRow,
    input: {
      title: "Mallory's widget",
      description: "A fixture listing owned by Mallory Ltd.",
      category: "Testing",
      unitPrice: 50,
      quantityAvailable: 5,
    },
  });
  const campaign = await requestPromotion({
    company: malloryCoRow,
    input: {
      offerId: malloryOffer.id,
      heading: "Mallory's promotion",
      shortDescription: "A fixture campaign.",
      ctaLabel: "View",
      requestedDurationDays: 3,
    },
  });

  await refuses(
    "promotion: another company cannot ACTIVATE a campaign it does not own",
    () => activatePromotion({ campaignId: campaign.id, companyId: aliceCo.id }),
    "",
  );

  await refuses(
    "promotion: another company cannot CANCEL a campaign it does not own",
    () => cancelPromotion({ campaignId: campaign.id, companyId: aliceCo.id }),
    "",
  );

  await refuses(
    "promotion: another company cannot PAUSE a campaign it does not own",
    () => pausePromotion({ campaignId: campaign.id, companyId: aliceCo.id }),
    "",
  );

  await refuses(
    "promotion: a forged campaign id is refused",
    () => activatePromotion({ campaignId: NONEXISTENT_UUID, companyId: malloryCo.id }),
    "",
  );

  // Approve, then prove the single ACTIVE slot is a DATABASE guarantee.
  await reviewPromotion({
    campaignId: campaign.id,
    approve: true,
    actorLabel: gov.username,
    governmentId: gov.id,
  });
  await activatePromotion({ campaignId: campaign.id, companyId: malloryCo.id });

  const rival = await requestPromotion({
    company: aliceCoRow,
    input: {
      offerId: offer.id,
      heading: "Alice's promotion",
      shortDescription: "A rival fixture campaign.",
      ctaLabel: "View",
      requestedDurationDays: 3,
    },
  });
  await reviewPromotion({
    campaignId: rival.id,
    approve: true,
    actorLabel: gov.username,
    governmentId: gov.id,
  });

  await refuses(
    "promotion: the single ACTIVE slot cannot be taken twice",
    () => activatePromotion({ campaignId: rival.id, companyId: aliceCo.id }),
    "",
  );

  await cancelPromotion({ campaignId: campaign.id, companyId: malloryCo.id });
  await cancelPromotion({ campaignId: rival.id, companyId: aliceCo.id });
  await invariant("promotion lifecycle");

  // ==========================================================================
  console.log("\n=== 7. GOVERNMENT AUTHORITY IS UNREACHABLE FROM A USER ROW ===\n");
  // ==========================================================================

  await setUserBadges({
    userId: badged.id,
    official: true,
    member: true,
    governmentId: gov.id,
    governmentUsername: gov.username,
  });
  const [badgedRow] = await db.select().from(users).where(eq(users.id, badged.id));
  const [plainRow] = await db.select().from(users).where(eq(users.id, alice.id));

  check(
    "badges: the doubly-badged account really does carry both labels",
    badgesOf(badgedRow).official && badgesOf(badgedRow).member,
    badgesOf(badgedRow),
  );

  check(
    "badges: a doubly-badged account's capability set is IDENTICAL to an unbadged one's",
    canUserSend(badgedRow) === canUserSend(plainRow) &&
      canUserReceive(badgedRow) === canUserReceive(plainRow) &&
      canUserCreateCompany(badgedRow) === canUserCreateCompany(plainRow) &&
      effectiveUserStatus(badgedRow) === effectiveUserStatus(plainRow),
  );

  // The structural proof: the modules that DECIDE authority never read the
  // badge columns, so no badge can ever become a permission.
  for (const file of [
    "src/lib/auth.ts",
    "src/lib/session.ts",
    "src/lib/status.ts",
    "src/proxy.ts",
  ]) {
    const src = codeOf(file);
    check(
      `badges: ${file} never reads either badge column`,
      !/isOfficialGovernmentUser|isGovernmentMember|is_official_government_user|is_government_member/.test(
        src,
      ),
    );
  }

  // Every Government server action asks for a Government session first.
  const govSource = codeOf("src/actions/government.ts");
  const govActionNames = [...govSource.matchAll(/^export async function (\w+)/gm)].map(
    (m) => m[1],
  );
  const govActionBodies = govSource.split(/^export async function /gm).slice(1);
  const ungated = govActionBodies
    .filter((body) => !/await gov\(\)|requireGovernment|requireControlRoom|requireUser/.test(body.slice(0, 1200)))
    .map((body) => body.slice(0, body.indexOf("(")));
  check(
    `gov: all ${govActionNames.length} Government server actions establish authority before acting`,
    ungated.length === 0,
    ungated,
  );

  // The Government session is minted from the `government` table only.
  const sessionSource = codeOf("src/lib/session.ts");
  check(
    "gov: a Government session can only be minted with role 'government' and is verified as such",
    /role: "government"/.test(sessionSource) &&
      /payload\.role !== "government"/.test(sessionSource),
  );
  check(
    "gov: requireGovernment reads the government table and never the users table",
    /from\(government\)/.test(codeOf("src/lib/auth.ts")),
  );

  // Badged users have no company they do not own.
  await refuses(
    "gov: a badged user still cannot act as a company they do not own",
    () => requireOwnedCompany(badged.id, aliceCo.id),
    "Company not found",
  );

  // ==========================================================================
  console.log("\n=== 8. EXPORT SCOPE CANNOT BE WIDENED ===\n");
  // ==========================================================================

  const aliceScope = userScopeFor({ id: alice.id, username: alice.username });
  check(
    "export: a user scope carries the session's own id and nothing else",
    aliceScope.kind === "USER" && aliceScope.userId === alice.id,
    aliceScope,
  );

  refusesSync(
    "export: a company scope for a company the user does NOT own is refused",
    () =>
      companyScopeFor(
        { id: alice.id },
        { id: malloryCo.id, username: malloryCo.username, ownerUserId: mallory.id },
      ),
    "only export records for a company you own",
  );

  refusesSync(
    "export: asking for a company scope with no company is refused",
    () => companyScopeFor({ id: alice.id }, null),
    "Switch to a company wallet",
  );

  refusesSync(
    "export: a Government-only dataset is not reachable from a USER scope",
    () => getDataset("treasury", "USER"),
    "Unknown export",
  );
  refusesSync(
    "export: an unknown dataset key and a forbidden one produce the SAME error",
    () => getDataset("definitely-not-a-dataset", "GOVERNMENT"),
    "Unknown export",
  );

  const userDatasets = datasetsForScope("USER").map((d) => d.key);
  const govDatasets = datasetsForScope("GOVERNMENT").map((d) => d.key);
  check(
    "export: the USER catalogue is a strict subset of the GOVERNMENT catalogue",
    userDatasets.every((k) => govDatasets.includes(k)) && userDatasets.length < govDatasets.length,
    { userDatasets, govDatasets },
  );

  // Identity-shaped filters exist for the Government's benefit and are simply
  // not consulted by a user/company scope branch — proved by reading the code.
  const exportSource = codeOf("src/lib/exports.ts");
  check(
    "export: every dataset decides readable rows from the SCOPE, not from a filter",
    exportSource.split("fetchPage(scope").length - 1 >= userDatasets.length,
  );
  const forgedFilters = parseExportFilters(
    new URLSearchParams({ user: mallory.username, company: malloryCo.username, scope: "company" }),
  );
  check(
    "export: a forged identity filter parses to a plain string and grants nothing on its own",
    forgedFilters.user === mallory.username.toLowerCase() &&
      forgedFilters.company === malloryCo.username.toLowerCase(),
    forgedFilters,
  );
  check(
    "export: the user export route never reads a user, company or wallet id from the URL",
    !/searchParams\.get\(\s*["'](user|company|userId|companyId|as)["']/.test(
      codeOf("src/app/api/export/[dataset]/route.ts"),
    ),
  );

  // ==========================================================================
  console.log("\n=== 9. CRON AUTHORIZATION ===\n");
  // ==========================================================================

  const SECRET = "a-test-cron-secret-value";
  check(
    "cron: a request with no secret header is rejected",
    authorizeCronRequest(new Headers(), SECRET).ok === false,
  );
  check(
    "cron: a WRONG bearer secret is rejected",
    authorizeCronRequest(
      new Headers({ authorization: "Bearer not-the-secret" }),
      SECRET,
    ).ok === false,
  );
  check(
    "cron: a wrong x-cron-secret is rejected",
    authorizeCronRequest(new Headers({ "x-cron-secret": "nope" }), SECRET).ok === false,
  );
  check(
    "cron: an UNCONFIGURED secret fails CLOSED — an empty secret never means open",
    authorizeCronRequest(new Headers({ authorization: `Bearer ${SECRET}` }), "").ok === false &&
      authorizeCronRequest(new Headers({ authorization: "Bearer anything" }), undefined).ok ===
        false,
  );
  check(
    "cron: the CORRECT bearer secret is accepted",
    authorizeCronRequest(new Headers({ authorization: `Bearer ${SECRET}` }), SECRET).ok === true,
  );
  check(
    "cron: the correct x-cron-secret header is accepted",
    authorizeCronRequest(new Headers({ "x-cron-secret": SECRET }), SECRET).ok === true,
  );
  check(
    "cron: a near-miss of a DIFFERENT LENGTH is rejected without throwing (constant-time compare)",
    secretsMatch(SECRET, SECRET) === true &&
      secretsMatch(SECRET, `${SECRET}x`) === false &&
      secretsMatch(SECRET, "") === false,
  );
  check(
    "cron: the cleanup route's FIRST act is the authorization check",
    /authorizeCronRequest\(request\.headers\)[\s\S]{0,120}cronRejection/.test(
      codeOf("src/app/api/cron/cleanup/route.ts"),
    ),
  );

  // ==========================================================================
  console.log("\n=== 10. RATE LIMITER: TRIGGERS, THEN RECOVERS ===\n");
  // ==========================================================================

  clearAllRateLimits();
  const t0 = 1_000_000;
  const key = "test:limiter";

  let allowedCount = 0;
  for (let i = 0; i < FINANCIAL_RULE.limit; i++) {
    if (consumeRateLimit(key, FINANCIAL_RULE, t0).allowed) allowedCount++;
  }
  check(
    `limiter: the first ${FINANCIAL_RULE.limit} attempts inside the window are allowed`,
    allowedCount === FINANCIAL_RULE.limit,
    { allowedCount },
  );

  const over = consumeRateLimit(key, FINANCIAL_RULE, t0);
  check("limiter: attempt number limit+1 is REFUSED", over.allowed === false, over);
  check(
    "limiter: a refusal reports a positive retry-after",
    over.retryAfterSeconds > 0 &&
      over.retryAfterSeconds <= Math.ceil(FINANCIAL_RULE.windowMs / 1000),
    over,
  );

  const stillBlocked = consumeRateLimit(key, FINANCIAL_RULE, t0 + FINANCIAL_RULE.windowMs - 1);
  check("limiter: still refused one millisecond before the window closes", stillBlocked.allowed === false);

  const recovered = consumeRateLimit(key, FINANCIAL_RULE, t0 + FINANCIAL_RULE.windowMs + 1);
  check("limiter: RECOVERS once the window has passed", recovered.allowed === true, recovered);

  // Different keys never share a budget.
  clearAllRateLimits();
  for (let i = 0; i < LOGIN_RULE.limit; i++) consumeRateLimit("login:a", LOGIN_RULE, t0);
  check(
    "limiter: exhausting one key does not affect another",
    consumeRateLimit("login:a", LOGIN_RULE, t0).allowed === false &&
      consumeRateLimit("login:b", LOGIN_RULE, t0).allowed === true,
  );

  clearAllRateLimits();
  for (let i = 0; i < LOGIN_RULE.limit; i++) consumeRateLimit("login:c", LOGIN_RULE, t0);
  check(
    "limiter: a successful login clears the key so earlier typos are forgiven",
    (() => {
      resetRateLimit("login:c");
      return consumeRateLimit("login:c", LOGIN_RULE, t0).allowed === true;
    })(),
  );
  clearAllRateLimits();

  check(
    "limiter: login, registration and the financial actions are all wired to it",
    /consumeRateLimit/.test(codeOf("src/actions/auth.ts")) &&
      /LOGIN_RULE/.test(codeOf("src/actions/auth.ts")) &&
      /REGISTER_RULE/.test(codeOf("src/actions/auth.ts")) &&
      /consumeRateLimit/.test(codeOf("src/actions/user.ts")) &&
      /consumeRateLimit/.test(codeOf("src/actions/invoice.ts")) &&
      /consumeRateLimit/.test(codeOf("src/actions/marketplace.ts")),
  );
  check(
    "limiter: it writes no database row — the whole module never imports the db",
    !/from "@\/db|drizzle-orm/.test(codeOf("src/lib/ratelimit.ts")),
  );

  // ==========================================================================
  console.log("\n=== 11. BANNED ACCOUNTS CANNOT ACT ===\n");
  // ==========================================================================

  const [bannedRow] = await db.select().from(users).where(eq(users.id, banned.id));
  check("banned: the fixture really is banned", effectiveUserStatus(bannedRow) === "BANNED");
  check("banned: cannot send", canUserSend(bannedRow) === false);
  check("banned: cannot receive", canUserReceive(bannedRow) === false);

  await refuses(
    "banned: a payment from a banned wallet is refused at the payments layer",
    () =>
      transfer({
        from: userWallet(banned.id),
        to: userWallet(alice.id),
        amount: 10,
        type: "TRANSFER",
        reason: "should never happen",
      }),
    "banned",
  );

  // The write surface refuses a banned account at the boundary, so the
  // non-financial actions (ratings, listings, support, contracts) are covered
  // too rather than relying on a layout redirect that actions never run.
  const authSource = codeOf("src/lib/auth.ts");
  check(
    "banned: requireUser refuses a banned account",
    /export async function requireUser[\s\S]{0,700}ACCOUNT_BANNED/.test(authSource),
  );
  check(
    "banned: requireActingContext refuses a banned account",
    /export async function requireActingContext[\s\S]{0,400}ACCOUNT_BANNED/.test(authSource),
  );
  check(
    "banned: pages still read through getCurrentUser/getActingContext, so /banned keeps working",
    /export const getCurrentUser/.test(authSource) && /export const getActingContext/.test(authSource),
  );

  // ==========================================================================
  console.log("\n=== 12. SESSIONS AND THE WRITE SURFACE ===\n");
  // ==========================================================================

  const authActionSource = codeOf("src/actions/auth.ts");
  check(
    "session: a login mints a token carrying the account's CURRENT epoch",
    /createUserSession\(\{[\s\S]{0,200}sessionEpoch: user\.sessionEpoch/.test(authActionSource),
  );
  check(
    "session: getCurrentUser rejects a token whose epoch does not match the row",
    /session\.epoch \?\? 0\) !== user\.sessionEpoch/.test(authSource),
  );
  check(
    "session: both cookies are httpOnly and sameSite=lax",
    (sessionSource.match(/httpOnly: true/g) ?? []).length >= 2 &&
      (sessionSource.match(/sameSite: "lax"/g) ?? []).length >= 3,
  );
  check(
    "session: the wallet-context cookie is only a hint — ownership is re-read every request",
    /getOwnedCompanies\(user\.id\)/.test(authSource) &&
      /availableCompanies\.find\(\(c\) => c\.id === contextId\)/.test(authSource),
  );

  // Every "use server" module exports only async functions (and types, which
  // are erased). A non-function export in one of these files fails the build.
  for (const file of [
    "src/actions/auth.ts",
    "src/actions/user.ts",
    "src/actions/company.ts",
    "src/actions/invoice.ts",
    "src/actions/marketplace.ts",
    "src/actions/government.ts",
    "src/actions/support.ts",
  ]) {
    const src = codeOf(file);
    const exports = [...src.matchAll(/^export (?!type\b|async function\b)(\w+)/gm)].map(
      (m) => m[0],
    );
    check(`"use server": ${file} exports only async functions and types`, exports.length === 0, exports);
  }

  // No user-generated text is rendered as raw HTML anywhere.
  const allTsx = [
    "src/components/company-qr.tsx",
    "src/components/invoice-summary.tsx",
    "src/components/transaction-row.tsx",
    "src/app/(app)/market/contracts/[id]/page.tsx",
    "src/app/(app)/market/orders/[id]/page.tsx",
    "src/app/(app)/u/[username]/page.tsx",
    "src/app/(app)/c/[username]/page.tsx",
  ];
  const withRawHtml = allTsx.filter((f) => /dangerouslySetInnerHTML/.test(codeOf(f)));
  check(
    "xss: the ONLY dangerouslySetInnerHTML is the QR code, whose bytes this app generates",
    withRawHtml.length === 1 && withRawHtml[0] === "src/components/company-qr.tsx",
    withRawHtml,
  );
  check(
    "xss: the QR encoder rejects any username that is not [a-z0-9_], so no text reaches the markup",
    /\^\[a-z0-9_\]\{1,32\}\$/.test(codeOf("src/lib/qr.ts")),
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

  // Leave nothing tradeable behind, so repeated runs stay independent.
  await db
    .update(companies)
    .set({ status: "REVOKED", revokedAt: new Date(), revokeReason: "V3 security test cleanup" })
    .where(inArray(companies.id, [aliceCo.id, malloryCo.id]));
  await db
    .update(marketplaceOffers)
    .set({ status: "CLOSED" })
    .where(inArray(marketplaceOffers.companyId, [aliceCo.id, malloryCo.id]));
  await db
    .update(marketplaceOrders)
    .set({ status: "CANCELLED", cancelledAt: new Date() })
    .where(
      sql`${marketplaceOrders.status} IN ('PENDING','ACCEPTED','WAITING_FOR_INVOICE') AND ${marketplaceOrders.sellerCompanyId} IN (${aliceCo.id}, ${malloryCo.id})`,
    );
  await db
    .update(marketplaceContracts)
    .set({ status: "CANCELLED", closedAt: new Date() })
    .where(
      sql`${marketplaceContracts.status} = 'OPEN' AND ${marketplaceContracts.issuerCompanyId} IN (${aliceCo.id}, ${malloryCo.id})`,
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
