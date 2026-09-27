import "dotenv/config";
import { sendAeros, transfer, PaymentError } from "../../src/lib/payments";
import { governmentWallet, userWallet } from "../../src/lib/wallets";
import { db, pool } from "../../src/db/client";
import { users, government, registrationCodes } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

async function getUser(username: string) {
  const [u] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return u;
}

async function expectError(label: string, fn: () => Promise<unknown>, expectedSubstring: string) {
  try {
    await fn();
    console.log(`FAIL [${label}]: expected error but succeeded`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(expectedSubstring)) {
      console.log(`PASS [${label}]: ${msg}`);
    } else {
      console.log(`FAIL [${label}]: wrong error message: ${msg}`);
    }
  }
}

async function main() {
  const ayush = await getUser("ayush");
  const piyush = await getUser("piyush");
  console.log("Starting balances — ayush:", ayush.balance, "piyush:", piyush.balance);

  // 1. Valid payment with tax (500 Aeros, 5% tax => 25 tax, 475 net)
  const r1 = await sendAeros({ senderId: ayush.id, recipientUsername: "piyush", amount: 500 });
  console.log("PASS [valid payment]:", JSON.stringify(r1));
  if (r1.taxAmount !== 25 || r1.netAmount !== 475) {
    console.log("FAIL [tax calculation]: expected tax=25 net=475, got", r1.taxAmount, r1.netAmount);
  } else {
    console.log("PASS [tax calculation]: 5% of 500 = 25 tax, 475 net");
  }

  // 2. Exactly 1 Aeros => zero tax
  const r2 = await sendAeros({ senderId: ayush.id, recipientUsername: "piyush", amount: 1 });
  if (r2.taxAmount === 0 && r2.netAmount === 1) {
    console.log("PASS [1 Aeros tax-free rule]");
  } else {
    console.log("FAIL [1 Aeros tax-free rule]:", JSON.stringify(r2));
  }

  // 3. Insufficient balance
  await expectError(
    "insufficient balance",
    () => sendAeros({ senderId: piyush.id, recipientUsername: "ayush", amount: 999999 }),
    "Insufficient Aeros balance",
  );

  // 4. Nonexistent recipient
  await expectError(
    "nonexistent recipient",
    () => sendAeros({ senderId: ayush.id, recipientUsername: "doesnotexist", amount: 10 }),
    "Username not found",
  );

  // 5. Self-payment
  await expectError(
    "self-payment",
    () => sendAeros({ senderId: ayush.id, recipientUsername: "ayush", amount: 10 }),
    "cannot send Aeros to yourself",
  );

  // 6. Zero / negative amount
  await expectError(
    "zero amount",
    () => sendAeros({ senderId: ayush.id, recipientUsername: "piyush", amount: 0 }),
    "Minimum payment is 1 Aeros",
  );
  await expectError(
    "negative amount",
    () => sendAeros({ senderId: ayush.id, recipientUsername: "piyush", amount: -5 }),
    "Minimum payment is 1 Aeros",
  );

  // 7. Suspended sender
  await db.update(users).set({ status: "SUSPENDED" }).where(eq(users.id, piyush.id));
  await expectError(
    "suspended sender",
    () => sendAeros({ senderId: piyush.id, recipientUsername: "ayush", amount: 10 }),
    "account is suspended",
  );

  // 8. Banned sender
  await db.update(users).set({ status: "BANNED" }).where(eq(users.id, piyush.id));
  await expectError(
    "banned sender",
    () => sendAeros({ senderId: piyush.id, recipientUsername: "ayush", amount: 10 }),
    "account is banned",
  );

  // 9. Banned receiver
  await expectError(
    "banned receiver",
    () => sendAeros({ senderId: ayush.id, recipientUsername: "piyush", amount: 10 }),
    "Recipient account cannot receive Aeros",
  );

  // restore piyush to active for further tests
  await db.update(users).set({ status: "ACTIVE" }).where(eq(users.id, piyush.id));

  // 10. Concurrent double-spend attempt. Deliberately uses a brand-new user
  // funded with a real ledger transfer of exactly 500, rather than racing
  // against ayush's ambient balance — ayush is a shared fixture that other
  // test scripts in this suite also fund/spend from, so its balance at this
  // point depends on which other scripts already ran and is not a reliable
  // amount to race against. A dedicated, freshly-funded user makes this
  // deterministic regardless of run order (same pattern as the equivalent
  // race test in test_v2_core.ts).
  const [gov] = await db.select().from(government).limit(1);
  const [code] = await db
    .insert(registrationCodes)
    .values({ code: String(Math.floor(1000 + Math.random() * 8999)) })
    .returning();
  const [raceUser] = await db
    .insert(users)
    .values({
      username: `race${Date.now().toString().slice(-6)}`,
      passwordHash: await bcrypt.hash("TestPassword123", 4),
      displayName: "Race Tester",
      balance: 0,
      registrationCodeId: code.id,
    })
    .returning();
  await transfer({
    from: governmentWallet(gov.id),
    to: userWallet(raceUser.id),
    amount: 500,
    forcedTaxRateBp: 0,
    type: "GOVERNMENT_FUNDING",
  });

  const beforeRace = await getUser(raceUser.username);
  console.log("Race user balance before concurrency test:", beforeRace.balance);
  const results = await Promise.allSettled([
    sendAeros({ senderId: raceUser.id, recipientUsername: "piyush", amount: 400 }),
    sendAeros({ senderId: raceUser.id, recipientUsername: "piyush", amount: 400 }),
  ]);
  const succeeded = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");
  console.log(
    "Concurrency result: succeeded=",
    succeeded.length,
    "failed=",
    failed.length,
    failed.map((f) => (f as PromiseRejectedResult).reason.message),
  );
  if (succeeded.length === 1 && failed.length === 1) {
    console.log("PASS [double-spend protection]: exactly one of two concurrent sends succeeded");
  } else {
    console.log("FAIL [double-spend protection]: expected exactly 1 success and 1 failure");
  }

  const afterRace = await getUser(raceUser.username);
  const expectedAfter = beforeRace.balance - 400;
  if (afterRace.balance === expectedAfter) {
    console.log(`PASS [balance integrity]: race user balance is ${afterRace.balance} as expected`);
  } else {
    console.log(
      `FAIL [balance integrity]: expected ${expectedAfter}, got ${afterRace.balance}`,
    );
  }

  await pool.end();
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
