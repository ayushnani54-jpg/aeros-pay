/** Creates a clean pair of browser-test identities (seller company + buyer). */
import "dotenv/config";
import { db, pool } from "../../src/db/client";
import {
  companies,
  government,
  registrationCodes,
  users,
} from "../../src/db/schema";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { transfer } from "../../src/lib/payments";
import {
  companyWallet,
  governmentWallet,
  userWallet,
} from "../../src/lib/wallets";

const RUN = process.env.UX_RUN ?? "ux1";

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
      /* retry */
    }
  }
  if (!code) throw new Error("no code");
  const [user] = await db
    .insert(users)
    .values({
      username: name,
      passwordHash: await bcrypt.hash("TestPassword123", 8),
      displayName: name === `uxseller_${RUN}` ? "Uma Seller" : "Bea Buyer",
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
      reason: "UX test fixture",
    });
  }
  return user;
}

async function main() {
  // Sweep any previous ux fixtures back so the treasury can fund this one.
  const [g] = await db.select({ id: government.id }).from(government).limit(1);
  const prevUsers = await db
    .select({ id: users.id, balance: users.balance })
    .from(users)
    .where(sql`${users.username} LIKE 'ux%'`);
  for (const u of prevUsers) {
    if (u.balance > 0) {
      await transfer({
        from: userWallet(u.id),
        to: governmentWallet(g.id),
        amount: u.balance,
        forcedTaxRateBp: 0,
        type: "GOVERNMENT_RECEIPT",
        reason: "UX fixture sweep",
        skipSenderCheck: true,
      });
    }
  }
  const prevCos = await db
    .select({ id: companies.id, balance: companies.balance })
    .from(companies)
    .where(sql`${companies.username} LIKE 'ux%'`);
  for (const c of prevCos) {
    if (c.balance > 0) {
      await transfer({
        from: companyWallet(c.id),
        to: governmentWallet(g.id),
        amount: c.balance,
        forcedTaxRateBp: 0,
        type: "GOVERNMENT_RECEIPT",
        reason: "UX fixture sweep",
        skipSenderCheck: true,
      });
    }
  }

  const seller = await makeUser(`uxseller_${RUN}`, 100);
  const buyer = await makeUser(`uxbuyer_${RUN}`, 3000);

  const [company] = await db
    .insert(companies)
    .values({
      ownerUserId: seller.id,
      name: `Uma Threads ${RUN}`,
      username: `uxco_${RUN}`,
      category: "Retail",
      reason: "Browser test",
      description: "A fixture company used to drive the invoice UI in a browser.",
      status: "APPROVED",
      balance: 0,
    })
    .returning();

  await transfer({
    from: governmentWallet(g.id),
    to: companyWallet(company.id),
    amount: 500,
    forcedTaxRateBp: 0,
    type: "COMPANY_FUNDING",
    reason: "UX test fixture",
    skipReceiverCheck: true,
  });

  const [check] = await db.select().from(companies).where(eq(companies.id, company.id));
  console.log(
    JSON.stringify(
      {
        seller: seller.username,
        buyer: buyer.username,
        company: check.username,
        companyName: check.name,
        password: "TestPassword123",
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
