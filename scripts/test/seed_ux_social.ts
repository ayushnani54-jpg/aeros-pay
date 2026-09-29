/**
 * Fixtures for the V3 Phase F/G/H browser pass (scripts/test/ux_social_flow.mjs).
 *
 * Creates, with REAL library calls rather than hand-written rows:
 *   * a seller company with an active listing,
 *   * one COMPLETED order already rated 5 stars by a second buyer, so the
 *     public profile has an aggregate before the browser adds to it,
 *   * one COMPLETED order left UNRATED for the browser pass to rate,
 *   * a user carrying BOTH Government badges, to prove in the browser that the
 *     labels render and grant nothing,
 *   * a funded payer, so the browser can make a real payment and see the
 *     success state with sound switched off.
 *
 * Every balance is moved with a real transfer, so the supply invariant holds.
 */
import "dotenv/config";
import { db, pool } from "../../src/db/client";
import { companies, government, registrationCodes, users } from "../../src/db/schema";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { transfer } from "../../src/lib/payments";
import { companyWallet, governmentWallet, userWallet } from "../../src/lib/wallets";
import {
  acceptOrder,
  completeOrder,
  createOffer,
  issueInvoiceForOrder,
  placeOrder,
} from "../../src/lib/marketplace";
import { payInvoice } from "../../src/lib/invoices";
import { rateOrder } from "../../src/lib/ratings";
import { setUserBadges } from "../../src/lib/badges";

const RUN = process.env.UX_RUN ?? "s1";
const PASSWORD = "TestPassword123";
const PREFIX = "uxsoc";

async function makeUser(username: string, displayName: string, balance: number) {
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
  if (!code) throw new Error("no registration code");

  const [user] = await db
    .insert(users)
    .values({
      username,
      passwordHash: await bcrypt.hash(PASSWORD, 8),
      displayName,
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
      reason: "UX social fixture",
    });
  }
  return user;
}

async function sweepPrevious() {
  const [g] = await db.select({ id: government.id }).from(government).limit(1);
  const prevUsers = await db
    .select({ id: users.id, balance: users.balance })
    .from(users)
    .where(sql`${users.username} LIKE ${`${PREFIX}%`}`);
  for (const u of prevUsers) {
    if (u.balance > 0) {
      await transfer({
        from: userWallet(u.id),
        to: governmentWallet(g.id),
        amount: u.balance,
        forcedTaxRateBp: 0,
        type: "GOVERNMENT_RECEIPT",
        reason: "UX social fixture sweep",
        skipSenderCheck: true,
      });
    }
  }
  const prevCos = await db
    .select({ id: companies.id, balance: companies.balance })
    .from(companies)
    .where(sql`${companies.username} LIKE ${`${PREFIX}%`}`);
  for (const c of prevCos) {
    if (c.balance > 0) {
      await transfer({
        from: companyWallet(c.id),
        to: governmentWallet(g.id),
        amount: c.balance,
        forcedTaxRateBp: 0,
        type: "GOVERNMENT_RECEIPT",
        reason: "UX social fixture sweep",
        skipSenderCheck: true,
        skipReceiverCheck: true,
      });
    }
  }
  // Retire previous fixture companies so their listings stop appearing.
  await db
    .update(companies)
    .set({ status: "REVOKED", revokedAt: new Date(), revokeReason: "UX social re-seed" })
    .where(sql`${companies.username} LIKE ${`${PREFIX}%`} AND ${companies.status} = 'APPROVED'`);
}

async function completedOrder(params: {
  sellerId: string;
  buyerId: string;
  title: string;
  unitPrice: number;
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
      description: "Hand-finished, made to order in the studio.",
      category: "Crafts",
      unitPrice: params.unitPrice,
      quantityAvailable: 20,
    },
  });
  const order = await placeOrder({
    offerId: offer.id,
    buyer: userWallet(params.buyerId),
    quantity: 1,
  });
  await acceptOrder({ orderId: order.id, sellerCompanyId: params.sellerId });
  const issued = await issueInvoiceForOrder({
    orderId: order.id,
    sellerCompanyId: params.sellerId,
  });
  await payInvoice({ invoiceId: issued.invoice.id, payer: userWallet(params.buyerId) });
  await completeOrder({ orderId: order.id, actor: userWallet(params.buyerId) });
  return { offer, order };
}

async function main() {
  const [g] = await db.select().from(government).limit(1);
  if (!g) throw new Error("seed the government row first");

  await sweepPrevious();

  const ownerName = `${PREFIX}own_${RUN}`;
  const raterName = `${PREFIX}rate_${RUN}`;
  const earlyName = `${PREFIX}early_${RUN}`;
  const badgedName = `${PREFIX}badge_${RUN}`;

  const owner = await makeUser(ownerName, "Olu Owner", 200);
  const rater = await makeUser(raterName, "Rita Rater", 6000);
  const early = await makeUser(earlyName, "Eli Early", 6000);
  const badged = await makeUser(badgedName, "Gita Gov", 4000);

  const companyUsername = `${PREFIX}co_${RUN}`;
  const [company] = await db
    .insert(companies)
    .values({
      ownerUserId: owner.id,
      name: `Mira Ceramics ${RUN}`,
      username: companyUsername,
      category: "Crafts",
      reason: "Browser-pass fixture",
      description: "Small studio making everyday stoneware.",
      status: "APPROVED",
      balance: 0,
    })
    .returning();

  // A company the Government has already REVOKED, so the browser pass can check
  // that a code printed while it was trading no longer resolves.
  const revokedUsername = `${PREFIX}gone_${RUN}`;
  await db.insert(companies).values({
    ownerUserId: owner.id,
    name: `Closed Pottery ${RUN}`,
    username: revokedUsername,
    category: "Crafts",
    reason: "Browser-pass fixture",
    description: "A company that used to trade and has since been revoked.",
    status: "REVOKED",
    balance: 0,
    revokedAt: new Date(),
    revokeReason: "Browser-pass fixture: a revoked company has no public page.",
  });

  // One order already rated, so the public profile has an aggregate.
  const first = await completedOrder({
    sellerId: company.id,
    buyerId: early.id,
    title: `Stoneware Mug ${RUN}`,
    unitPrice: 120,
  });
  await rateOrder({
    orderId: first.order.id,
    actor: userWallet(early.id),
    stars: 5,
    comment: "Beautiful glaze and it arrived quickly.",
  });

  // One completed order left UNRATED for the browser to rate.
  const second = await completedOrder({
    sellerId: company.id,
    buyerId: rater.id,
    title: `Serving Bowl ${RUN}`,
    unitPrice: 240,
  });

  // Both Government labels on one account.
  await setUserBadges({
    userId: badged.id,
    official: true,
    member: true,
    governmentId: g.id,
    governmentUsername: g.username,
  });

  console.log(
    JSON.stringify(
      {
        password: PASSWORD,
        owner: ownerName,
        rater: raterName,
        early: earlyName,
        badged: badgedName,
        company: companyUsername,
        revokedCompany: revokedUsername,
        companyName: company.name,
        ratedOrderId: first.order.id,
        unratedOrderId: second.order.id,
        unratedOrderNumber: second.order.orderNumber,
        unratedItem: `Serving Bowl ${RUN}`,
      },
      null,
      2,
    ),
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
