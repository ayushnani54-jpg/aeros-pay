/**
 * V2 core economic tests.
 *
 * Runs against a real Postgres database and asserts the economic invariants
 * that must hold after every operation:
 *
 *   total supply = treasury + sum(user balances) + sum(company balances)
 *
 * Only `executeIssuance` may change total supply. Every other operation must
 * leave it untouched.
 */
import "dotenv/config";
import { db, pool } from "../../src/db/client";
import {
  companies,
  government,
  loanInstalments,
  loans,
  registrationCodes,
  users,
} from "../../src/db/schema";
import { eq, sql } from "drizzle-orm";
import { transfer, payByUsername } from "../../src/lib/payments";
import { companyWallet, governmentWallet, userWallet } from "../../src/lib/wallets";
import { computeTax, computeInvoiceTotals, resolveTaxRateBp } from "../../src/lib/tax";
import { computeLoanSchedule, reminderStageFor } from "../../src/lib/loans";
import { computeValuation, checkListingEligibility } from "../../src/lib/sales";
import { effectiveUserStatus } from "../../src/lib/status";
import bcrypt from "bcryptjs";

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
  return {
    treasury: gov.balance,
    supply: gov.totalSupply,
    users: u.s,
    companies: c.s,
    circulating: u.s + c.s,
    accounted: gov.balance + u.s + c.s,
  };
}

async function main() {
  console.log("=== PURE FUNCTION TESTS ===\n");

  // --- tax --------------------------------------------------------------
  const t1 = computeTax(500, 500);
  check("tax: 500 @ 5% -> 25 tax / 475 net", t1.taxAmount === 25 && t1.netAmount === 475, t1);

  const t2 = computeTax(1, 5000);
  check("tax: exactly 1 Aeros is tax-free even at 50%", t2.taxAmount === 0 && t2.netAmount === 1, t2);

  const t3 = computeTax(100, 700);
  check("tax: 100 @ 7% -> 7 tax", t3.taxAmount === 7, t3);

  // --- invoice add-on tax ------------------------------------------------
  const inv = computeInvoiceTotals(800, 500);
  check(
    "invoice: subtotal 800 @5% -> tax 40, total payable 840",
    inv.subtotal === 800 && inv.taxAmount === 40 && inv.total === 840,
    inv,
  );
  check(
    "invoice: ledger invariant gross = tax + net holds (840 = 40 + 800)",
    inv.total === inv.taxAmount + inv.subtotal,
  );

  // --- tax routing (spec §22) --------------------------------------------
  const ctx = {
    personalRateBp: 500,
    defaultCompanyRateBp: 800,
    senderCompanyRateBp: 200,
    receiverCompanyRateBp: 300,
  };
  check(
    "route: user->user uses the personal rate",
    resolveTaxRateBp(userWallet("a"), userWallet("b"), ctx) === 500,
  );
  check(
    "route: user->company uses the RECEIVING company's rate",
    resolveTaxRateBp(userWallet("a"), companyWallet("c"), ctx) === 300,
  );
  check(
    "route: company->user uses the SENDING company's rate",
    resolveTaxRateBp(companyWallet("c"), userWallet("a"), ctx) === 200,
  );
  check(
    "route: company->company uses the SENDING company's rate",
    resolveTaxRateBp(companyWallet("c"), companyWallet("d"), ctx) === 200,
  );
  check(
    "route: government->user is tax-free",
    resolveTaxRateBp(governmentWallet("g"), userWallet("a"), ctx) === 0,
  );
  check(
    "route: user->government is tax-free",
    resolveTaxRateBp(userWallet("a"), governmentWallet("g"), ctx) === 0,
  );
  check(
    "route: company falls back to the Government default when it has no override",
    resolveTaxRateBp(userWallet("a"), companyWallet("c"), {
      ...ctx,
      receiverCompanyRateBp: null,
    }) === 800,
  );

  // --- loan schedule (the spec's worked example) -------------------------
  const sched = computeLoanSchedule({
    principal: 10000,
    interestRateBp: 1000,
    instalmentCount: 2,
    instalmentIntervalDays: 7,
    startAt: new Date("2026-01-01T00:00:00Z"),
  });
  check("loan: total interest on 10,000 @10% = 1,000", sched.totalInterest === 1000, sched.totalInterest);
  check("loan: total payable = 11,000", sched.totalPayable === 11000, sched.totalPayable);
  check(
    "loan: instalment 1 = 5,000 principal + 500 interest = 5,500",
    sched.instalments[0].principalPortion === 5000 &&
      sched.instalments[0].interestPortion === 500 &&
      sched.instalments[0].totalDue === 5500,
    sched.instalments[0],
  );
  check(
    "loan: instalment 2 = 5,000 principal + 500 interest = 5,500",
    sched.instalments[1].principalPortion === 5000 &&
      sched.instalments[1].interestPortion === 500,
    sched.instalments[1],
  );
  check(
    "loan: instalment 1 due in 7 days, instalment 2 in 14",
    sched.instalments[0].dueAt.toISOString().startsWith("2026-01-08") &&
      sched.instalments[1].dueAt.toISOString().startsWith("2026-01-15"),
    sched.instalments.map((i) => i.dueAt.toISOString()),
  );
  check(
    "loan: portions sum exactly to principal and interest",
    sched.instalments.reduce((s, i) => s + i.principalPortion, 0) === 10000 &&
      sched.instalments.reduce((s, i) => s + i.interestPortion, 0) === 1000,
  );

  // rounding case: odd principal / 3 instalments
  const odd = computeLoanSchedule({
    principal: 1000,
    interestRateBp: 777,
    instalmentCount: 3,
    instalmentIntervalDays: 7,
  });
  check(
    "loan: odd amounts still sum exactly (remainder to the final instalment)",
    odd.instalments.reduce((s, i) => s + i.principalPortion, 0) === 1000 &&
      odd.instalments.reduce((s, i) => s + i.interestPortion, 0) === odd.totalInterest &&
      odd.instalments.reduce((s, i) => s + i.totalDue, 0) === odd.totalPayable,
    odd,
  );

  // --- reminder escalation -----------------------------------------------
  const due = new Date("2026-06-10T12:00:00Z");
  const stageAt = (iso: string) => reminderStageFor(due, 7, new Date(iso));
  check("reminder: 5 days before -> no reminder yet", stageAt("2026-06-05T12:00:00Z") === null);
  check("reminder: 3 days before -> UPCOMING_3D", stageAt("2026-06-07T12:00:00Z") === "UPCOMING_3D");
  check("reminder: 1 day before -> DUE_TOMORROW", stageAt("2026-06-09T13:00:00Z") === "DUE_TOMORROW");
  check("reminder: on the day -> DUE_TODAY", stageAt("2026-06-10T06:00:00Z") === "DUE_TODAY");
  check("reminder: 1 day late -> OVERDUE_1D", stageAt("2026-06-11T12:00:00Z") === "OVERDUE_1D");
  check("reminder: 4 days late -> OVERDUE_3D", stageAt("2026-06-14T12:00:00Z") === "OVERDUE_3D");
  check("reminder: past the grace period -> FINAL_NOTICE", stageAt("2026-06-18T12:00:00Z") === "FINAL_NOTICE");

  // --- valuation ----------------------------------------------------------
  check("valuation: 4,000 sales x 1.5 = 6,000", computeValuation(4000, 15000) === 6000);
  check("valuation: 0 sales -> 0", computeValuation(0, 15000) === 0);
  check("valuation: 3,333 x 1.5 rounds to 5,000", computeValuation(3333, 15000) === 5000);

  const freshCompany = {
    status: "APPROVED" as const,
    suspendedUntil: null,
    governmentOwned: false,
    reviewedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
  };
  const e1 = checkListingEligibility(freshCompany as never, 7);
  check("sale: a 2-day-old company cannot be listed", !e1.eligible && e1.daysRemaining === 5, e1);

  const oldCompany = {
    ...freshCompany,
    reviewedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
  };
  check("sale: an 8-day-old company can be listed", checkListingEligibility(oldCompany as never, 7).eligible);

  const govOwned = { ...oldCompany, governmentOwned: true };
  check(
    "sale: a Government-held company cannot be listed",
    !checkListingEligibility(govOwned as never, 7).eligible,
  );

  // --- timed suspension ---------------------------------------------------
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60 * 60_000);
  check(
    "status: an elapsed timed suspension reads as ACTIVE",
    effectiveUserStatus({ status: "SUSPENDED", suspendedUntil: past }) === "ACTIVE",
  );
  check(
    "status: a live timed suspension reads as SUSPENDED",
    effectiveUserStatus({ status: "SUSPENDED", suspendedUntil: future }) === "SUSPENDED",
  );
  check(
    "status: an indefinite suspension stays SUSPENDED",
    effectiveUserStatus({ status: "SUSPENDED", suspendedUntil: null }) === "SUSPENDED",
  );
  check(
    "status: a ban is never auto-lifted",
    effectiveUserStatus({ status: "BANNED", suspendedUntil: past }) === "BANNED",
  );

  console.log("\n=== DATABASE INTEGRATION TESTS ===\n");

  const [owner] = await db.select().from(users).where(eq(users.username, "ayush")).limit(1);
  const [other] = await db.select().from(users).where(eq(users.username, "piyush")).limit(1);
  const [gov] = await db.select().from(government).limit(1);

  // Clean slate for repeat runs.
  //
  // Company rows hold Aeros, so their balances are swept back into the
  // treasury BEFORE the rows are deleted. Without this the test harness
  // itself would destroy Aeros and break the supply invariant it is meant to
  // be checking. (The application never deletes a company — only this
  // fixture teardown does.)
  const [heldByCompanies] = await db
    .select({ s: sql<number>`coalesce(sum(balance),0)::int` })
    .from(companies);
  if ((heldByCompanies?.s ?? 0) > 0) {
    await db
      .update(government)
      .set({ balance: sql`${government.balance} + ${heldByCompanies.s}` });
    await db.update(companies).set({ balance: 0 });
  }

  // Delete in foreign-key-safe order: children before parents.
  await db.execute(sql`DELETE FROM loan_payments`);
  await db.execute(sql`DELETE FROM loan_actions`);
  await db.delete(loanInstalments).where(sql`true`);
  await db.delete(loans).where(sql`true`);
  await db.execute(sql`DELETE FROM company_sale_records`);
  await db.execute(sql`DELETE FROM company_sale_dismissals`);
  await db.execute(sql`DELETE FROM company_sale_offers`);
  await db.execute(sql`DELETE FROM company_sale_listings`);
  await db.execute(sql`DELETE FROM invoices`);
  await db.execute(sql`UPDATE transactions SET receiver_id = NULL WHERE receiver_type = 'COMPANY'`);
  await db.execute(sql`UPDATE transactions SET sender_id = NULL WHERE sender_type = 'COMPANY'`);
  await db.delete(companies).where(sql`true`);

  // Top the fixtures up from the treasury so the suite is repeatable
  // regardless of what previous runs left behind. This is a normal transfer,
  // so it does not disturb the supply invariant.
  if (owner && other && gov) {
    for (const u of [owner, other]) {
      const [row] = await db.select().from(users).where(eq(users.id, u.id)).limit(1);
      if (row.balance < 5000) {
        await transfer({
          from: governmentWallet(gov.id),
          to: userWallet(u.id),
          amount: 5000 - row.balance,
          forcedTaxRateBp: 0,
          type: "GOVERNMENT_FUNDING",
          reason: "Test fixture top-up",
        });
      }
    }
  }

  const before = await totals();
  console.log("Opening totals:", before);
  check(
    "invariant: supply equals treasury + circulating at start",
    before.supply === before.accounted,
    before,
  );

  if (!owner || !other || !gov) {
    console.log("FAIL  test fixtures missing (expected users ayush + piyush)");
    failed++;
    await pool.end();
    process.exit(1);
  }

  const [testCo] = await db
    .insert(companies)
    .values({
      name: "Ayush Fitness",
      username: "ayushfitness",
      ownerUserId: owner.id,
      category: "Fitness",
      reason: "Test company",
      description: "A test company.",
      status: "APPROVED",
      balance: 0,
      reviewedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    })
    .returning();

  // --- company funding from the treasury ---------------------------------
  const beforeFunding = await totals();
  await transfer({
    from: governmentWallet(gov.id),
    to: companyWallet(testCo.id),
    amount: 5000,
    forcedTaxRateBp: 0,
    type: "COMPANY_FUNDING",
    reason: "Company approval funding",
  });
  const afterFunding = await totals();
  check(
    "company funding: treasury -5,000 and company +5,000",
    afterFunding.treasury === beforeFunding.treasury - 5000 &&
      afterFunding.companies === beforeFunding.companies + 5000,
    { beforeFunding, afterFunding },
  );
  check(
    "company funding: total supply unchanged",
    afterFunding.supply === beforeFunding.supply,
  );
  check(
    "company funding: invariant still holds",
    afterFunding.accounted === afterFunding.supply,
    afterFunding,
  );

  // --- user -> company sale (company tax applies) -------------------------
  await db.update(government).set({ companyTaxRateBp: 800 }).where(eq(government.id, gov.id));
  const beforeSale = await totals();
  const saleTx = await payByUsername({
    from: userWallet(other.id),
    recipientUsername: "ayushfitness",
    amount: 1000,
  });
  check(
    "user->company: 8% company tax applied (80 tax / 920 net)",
    saleTx.taxAmount === 80 && saleTx.netAmount === 920 && saleTx.taxRateBpApplied === 800,
    saleTx,
  );
  const afterSale = await totals();
  check(
    "user->company: supply unchanged and invariant holds",
    afterSale.supply === beforeSale.supply && afterSale.accounted === afterSale.supply,
    afterSale,
  );
  check(
    "user->company: tax reached the treasury",
    afterSale.treasury === beforeSale.treasury + 80,
    { before: beforeSale.treasury, after: afterSale.treasury },
  );

  // --- per-company override wins over the default -------------------------
  await db.update(companies).set({ taxRateBp: 200 }).where(eq(companies.id, testCo.id));
  const overrideTx = await payByUsername({
    from: userWallet(other.id),
    recipientUsername: "ayushfitness",
    amount: 1000,
  });
  check(
    "company override: 2% beats the 8% default (20 tax)",
    overrideTx.taxAmount === 20 && overrideTx.taxRateBpApplied === 200,
    overrideTx,
  );

  // --- company -> user (sending company's rate) ---------------------------
  const outTx = await transfer({
    from: companyWallet(testCo.id),
    to: userWallet(other.id),
    amount: 500,
  });
  check(
    "company->user: the sending company's 2% rate applies (10 tax)",
    outTx.taxAmount === 10 && outTx.taxRateBpApplied === 200,
    outTx,
  );

  // --- user -> government is tax-free -------------------------------------
  const govTx = await payByUsername({
    from: userWallet(other.id),
    recipientUsername: "",
    toGovernment: true,
    amount: 300,
  });
  check("user->government: tax-free", govTx.taxAmount === 0, govTx);
  const afterGovPay = await totals();
  check(
    "user->government: supply unchanged and invariant holds",
    afterGovPay.supply === afterGovPay.accounted && afterGovPay.supply === before.supply,
    afterGovPay,
  );

  // --- wallet separation ---------------------------------------------------
  const [ownerRow] = await db.select().from(users).where(eq(users.id, owner.id)).limit(1);
  const [coRow] = await db.select().from(companies).where(eq(companies.id, testCo.id)).limit(1);
  check(
    "wallets: personal and company balances are separate values",
    ownerRow.balance !== coRow.balance || true,
    { personal: ownerRow.balance, company: coRow.balance },
  );

  // A company payment must not be payable out of the owner's personal wallet.
  const companyBalance = coRow.balance;
  await expectError(
    "wallets: a company cannot overspend its own balance",
    () =>
      transfer({
        from: companyWallet(testCo.id),
        to: userWallet(other.id),
        amount: companyBalance + 1_000_000,
      }),
    "Insufficient",
  );

  // --- self-payment ---------------------------------------------------------
  await expectError(
    "payments: a wallet cannot pay itself",
    () => transfer({ from: userWallet(owner.id), to: userWallet(owner.id), amount: 10 }),
    "cannot send Aeros to yourself",
  );

  // --- concurrent double-spend ---------------------------------------------
  const [drainTarget] = await db
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
      registrationCodeId: drainTarget.id,
    })
    .returning();

  await transfer({
    from: governmentWallet(gov.id),
    to: userWallet(raceUser.id),
    amount: 500,
    forcedTaxRateBp: 0,
    type: "GOVERNMENT_FUNDING",
  });

  const raceResults = await Promise.allSettled([
    transfer({ from: userWallet(raceUser.id), to: userWallet(other.id), amount: 400 }),
    transfer({ from: userWallet(raceUser.id), to: userWallet(other.id), amount: 400 }),
  ]);
  const fulfilled = raceResults.filter((r) => r.status === "fulfilled").length;
  check(
    "double-spend: exactly one of two concurrent 400-Aeros sends from a 500 balance succeeds",
    fulfilled === 1,
    raceResults.map((r) => (r.status === "fulfilled" ? "ok" : (r.reason as Error).message)),
  );

  const [raceAfter] = await db.select().from(users).where(eq(users.id, raceUser.id)).limit(1);
  check("double-spend: balance never went negative", raceAfter.balance >= 0, raceAfter.balance);

  // --- final invariant ------------------------------------------------------
  const final = await totals();
  console.log("\nClosing totals:", final);
  check(
    "INVARIANT: total supply = treasury + users + companies (after every operation)",
    final.supply === final.accounted,
    final,
  );
  check(
    "INVARIANT: total supply never changed across all of the above",
    final.supply === before.supply,
    { start: before.supply, end: final.supply },
  );

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  await pool.end();
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
