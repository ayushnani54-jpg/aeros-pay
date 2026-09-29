/**
 * Fixtures for the V3 PWA-offline-payments browser pass
 * (scripts/test/ux_offline_flow.mjs).
 *
 * Creates two funded personal-wallet users (a sender and a recipient) and
 * sets the Government offline-payment policy to known, enabled values so the
 * browser pass can request an offline authorization, go offline, queue a
 * payment, and sync it — deterministically, without depending on whatever
 * the dev database happened to have left over from another run.
 *
 * Same shape as scripts/test/seed_ux_social.ts: real library calls
 * (`transfer`) for balances, so the supply invariant holds; a sweep of any
 * previous run's same-prefixed fixtures first, so re-running this script is
 * safe.
 */
import "dotenv/config";
import { db } from "../../src/db/client";
import { companies, government, registrationCodes, users } from "../../src/db/schema";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { transfer } from "../../src/lib/payments";
import { companyWallet, governmentWallet, userWallet } from "../../src/lib/wallets";

const RUN = process.env.UX_RUN ?? "o1";
const PASSWORD = "TestPassword123";
const PREFIX = "uxoff";

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
      reason: "UX offline fixture",
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
        reason: "UX offline fixture sweep",
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
        reason: "UX offline fixture sweep",
        skipSenderCheck: true,
      });
    }
  }
  // Matches scripts/test/seed_ux_social.ts's own convention: previous
  // fixture ROWS are never hard-deleted (transactions/notifications may
  // already reference them, and this project never destroys historical
  // records) — only their balances are swept back to the treasury so the
  // supply invariant holds across repeated manual runs. Re-running with the
  // SAME UX_RUN value will fail on the username unique constraint, exactly
  // like the existing ux seed scripts; use a fresh UX_RUN for each run.
}

async function main() {
  await sweepPrevious();

  const sender = await makeUser(`uxoffsend_${RUN}`, `Offline Sender ${RUN}`, 5000);
  const recipient = await makeUser(`uxoffrecv_${RUN}`, `Offline Recipient ${RUN}`, 0);

  // Known, enabled offline policy — the browser pass sets this for real via
  // the Government UI form (proving that path too), but seed it here first
  // so the run is deterministic even if the UI step is skipped.
  await db
    .update(government)
    .set({
      offlineTransactionsEnabled: true,
      offlineTotalAllowance: 2000,
      offlineMaxPerTransaction: 500,
      offlineAuthExpiryMinutes: 60,
      offlinePolicyUpdatedAt: new Date(),
    })
    .where(eq(government.id, (await db.select({ id: government.id }).from(government).limit(1))[0].id));

  console.log(
    JSON.stringify({
      run: RUN,
      sender: sender.username,
      recipient: recipient.username,
      password: PASSWORD,
    }),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
