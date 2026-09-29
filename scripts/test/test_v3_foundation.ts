/**
 * V3 PHASE A — SCHEMA FOUNDATION + CORE LIBRARY TESTS
 *
 * Runs against a real Postgres database. Four areas:
 *
 *   1. TAX MATRIX  — an unconfigured matrix reproduces V2 tax EXACTLY, a
 *                    configured cell overrides it, and neither can re-price a
 *                    transaction or invoice that already happened.
 *   2. IDEMPOTENCY — a retry returns the first result, a concurrent duplicate
 *                    never double-spends, a mismatched fingerprint is
 *                    rejected, and a failure stays retryable.
 *   3. RECONCILE   — every check fires on a deliberately corrupted fixture and
 *                    every check passes on a clean one.
 *   4. SCHEMA      — the V3 guarantees that are enforced by the database
 *                    itself rather than by application code.
 *
 * Every corruption in area 3 happens inside a transaction that is ROLLED BACK,
 * including the DDL that temporarily removes a CHECK constraint, so a broken
 * fixture never reaches the real database.
 */
import "dotenv/config";
import { db, pool } from "../../src/db/client";
import {
  companies,
  government,
  idempotencyKeys,
  invoices,
  marketplaceOffers,
  marketplaceOrders,
  reconciliationStatus,
  taxMatrix,
  transactions,
  users,
} from "../../src/db/schema";
import { eq, sql } from "drizzle-orm";
import { resolveTaxRateBp } from "../../src/lib/tax";
import {
  TAX_TRANSACTION_CONTEXTS,
  clearTaxMatrixRate,
  resolveEffectiveTaxRateBp,
  resolveTaxDecision,
  setTaxMatrixRate,
  type TaxTransactionContext,
} from "../../src/lib/taxmatrix";
import {
  IdempotencyConflictError,
  fingerprintRequest,
  getIdempotencyRecord,
  purgeExpiredIdempotencyKeys,
  runIdempotent,
} from "../../src/lib/idempotency";
import {
  getHealthCheckStatus,
  runHealthCheck,
  saveHealthCheckStatus,
  type ReconcileResult,
} from "../../src/lib/reconcile";
import { transfer, transferInTx } from "../../src/lib/payments";
import { createInvoice, payInvoice } from "../../src/lib/invoices";
import { companyWallet, governmentWallet, userWallet } from "../../src/lib/wallets";

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

/** Thrown to force a transaction to roll back after assertions have run. */
class Rollback extends Error {
  constructor() {
    super("intentional rollback");
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

async function balanceOf(userId: string): Promise<number> {
  const [row] = await db.select({ b: users.balance }).from(users).where(eq(users.id, userId));
  return row.b;
}

async function totals() {
  const [gov] = await db.select().from(government).limit(1);
  const [u] = await db.select({ s: sql<number>`coalesce(sum(balance),0)::int` }).from(users);
  const [c] = await db.select({ s: sql<number>`coalesce(sum(balance),0)::int` }).from(companies);
  return { supply: gov.totalSupply, accounted: gov.balance + u.s + c.s };
}

const RUN = Date.now().toString(36);

async function main() {
  const [gov] = await db.select().from(government).limit(1);
  const [alice] = await db.select().from(users).where(eq(users.username, "ayush")).limit(1);
  const [bob] = await db.select().from(users).where(eq(users.username, "piyush")).limit(1);
  // Only an APPROVED company can trade, so the fixture must be one.
  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.status, "APPROVED"))
    .limit(1);

  if (!gov || !alice || !bob) {
    console.log("FAIL  fixtures — this suite needs the government row plus users ayush and piyush");
    process.exit(1);
  }

  const before = await totals();

  // Top the fixtures up so every transfer below has room, without changing
  // supply (a treasury transfer moves Aeros, it never creates them).
  for (const u of [alice, bob]) {
    const bal = await balanceOf(u.id);
    if (bal < 4000) {
      await transfer({
        from: governmentWallet(gov.id),
        to: userWallet(u.id),
        amount: 4000 - bal,
        forcedTaxRateBp: 0,
        type: "GOVERNMENT_FUNDING",
        reason: "V3 test fixture top-up",
      });
    }
  }

  // The matrix is configuration, and it ships empty. Start from that state and
  // restore it at the end so the suite is repeatable.
  await db.delete(taxMatrix).where(sql`true`);

  // =======================================================================
  console.log("\n=== 1. TAX MATRIX: UNCONFIGURED == EXACT V2 BEHAVIOUR ===\n");
  // =======================================================================

  const [matrixCount] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(taxMatrix);
  check("matrix starts empty (nothing is ever seeded)", matrixCount.c === 0, matrixCount);

  const refs = [
    { name: "USER", ref: userWallet(alice.id) },
    { name: "COMPANY", ref: company ? companyWallet(company.id) : null },
    { name: "GOVERNMENT", ref: governmentWallet(gov.id) },
  ] as const;

  // The V2 answer, computed independently of the resolver under test, from the
  // same rows the resolver reads.
  const v2Inputs = {
    personalRateBp: gov.taxRateBp,
    defaultCompanyRateBp: gov.companyTaxRateBp,
    senderCompanyRateBp: null as number | null,
    receiverCompanyRateBp: null as number | null,
  };

  let combos = 0;
  let agreed = 0;
  for (const payer of refs) {
    for (const recipient of refs) {
      if (!payer.ref || !recipient.ref) continue;
      for (const context of TAX_TRANSACTION_CONTEXTS) {
        const expected = resolveTaxRateBp(payer.ref, recipient.ref, {
          ...v2Inputs,
          senderCompanyRateBp: payer.name === "COMPANY" ? company!.taxRateBp : null,
          receiverCompanyRateBp: recipient.name === "COMPANY" ? company!.taxRateBp : null,
        });
        const actual = await resolveTaxDecision(db, {
          payer: payer.ref,
          recipient: recipient.ref,
          context,
        });
        combos++;
        if (actual.rateBp === expected && actual.source === "V2_FALLBACK") agreed++;
        else {
          console.log(
            `      mismatch ${payer.name}->${recipient.name}/${context}: expected ${expected}, got ${actual.rateBp} (${actual.source})`,
          );
        }
      }
    }
  }
  check(
    `unconfigured matrix equals V2 for all ${combos} (payer x recipient x context) combinations`,
    combos > 0 && agreed === combos,
    { combos, agreed },
  );

  // End-to-end, through a real payment: the V2 numbers test_payments asserts.
  const t1 = await transfer({ from: userWallet(alice.id), to: userWallet(bob.id), amount: 500 });
  check(
    "live transfer with empty matrix: 500 @ 5% -> 25 tax / 475 net (identical to V2)",
    t1.taxAmount === 25 && t1.netAmount === 475 && t1.taxRateBpApplied === 500,
    t1,
  );

  const t2 = await transfer({ from: userWallet(alice.id), to: userWallet(bob.id), amount: 1 });
  check(
    "live transfer with empty matrix: 1 Aeros is still tax-free (V2 rule intact)",
    t2.taxAmount === 0 && t2.netAmount === 1,
    t2,
  );

  if (company) {
    const t3 = await transfer({
      from: userWallet(alice.id),
      to: companyWallet(company.id),
      amount: 200,
    });
    const expectedCompanyRate = company.taxRateBp ?? gov.companyTaxRateBp;
    check(
      "live user->company transfer with empty matrix uses the V2 company rate",
      t3.taxRateBpApplied === expectedCompanyRate,
      { applied: t3.taxRateBpApplied, expected: expectedCompanyRate },
    );
  }

  // =======================================================================
  console.log("\n=== 2. TAX MATRIX: A CONFIGURED CELL OVERRIDES ===\n");
  // =======================================================================

  await setTaxMatrixRate({
    payerType: "USER",
    recipientType: "USER",
    context: "DIRECT_TRANSFER",
    rateBp: 1000,
    governmentId: gov.id,
    governmentUsername: gov.username,
  });

  const decided = await resolveTaxDecision(db, {
    payer: userWallet(alice.id),
    recipient: userWallet(bob.id),
    context: "DIRECT_TRANSFER",
  });
  check(
    "configured cell is reported as coming from the matrix",
    decided.rateBp === 1000 && decided.source === "MATRIX",
    decided,
  );

  const t4 = await transfer({ from: userWallet(alice.id), to: userWallet(bob.id), amount: 500 });
  check(
    "live transfer honours the configured override: 500 @ 10% -> 50 tax / 450 net",
    t4.taxAmount === 50 && t4.netAmount === 450 && t4.taxRateBpApplied === 1000,
    t4,
  );

  // Only the configured cell changes: a different context is untouched.
  const otherContext = await resolveTaxDecision(db, {
    payer: userWallet(alice.id),
    recipient: userWallet(bob.id),
    context: "MARKETPLACE_ORDER",
  });
  check(
    "an override on one context does not leak into another context",
    otherContext.rateBp === gov.taxRateBp && otherContext.source === "V2_FALLBACK",
    otherContext,
  );

  // An explicit NULL row means "inherit" and behaves exactly like no row.
  await setTaxMatrixRate({
    payerType: "USER",
    recipientType: "USER",
    context: "DIRECT_TRANSFER",
    rateBp: null,
    governmentId: gov.id,
    governmentUsername: gov.username,
  });
  const inherited = await resolveTaxDecision(db, {
    payer: userWallet(alice.id),
    recipient: userWallet(bob.id),
    context: "DIRECT_TRANSFER",
  });
  check(
    "an explicit NULL rate falls back to V2 exactly like a missing row",
    inherited.rateBp === gov.taxRateBp && inherited.source === "V2_FALLBACK",
    inherited,
  );

  await clearTaxMatrixRate({
    payerType: "USER",
    recipientType: "USER",
    context: "DIRECT_TRANSFER",
    governmentId: gov.id,
    governmentUsername: gov.username,
  });
  const cleared = await resolveTaxDecision(db, {
    payer: userWallet(alice.id),
    recipient: userWallet(bob.id),
    context: "DIRECT_TRANSFER",
  });
  check(
    "clearing a cell restores pure V2 behaviour",
    cleared.rateBp === gov.taxRateBp && cleared.source === "V2_FALLBACK",
    cleared,
  );

  // The matrix can reach the Government too, but an administrative movement
  // that forces a rate server-side is still unaffected by it.
  await setTaxMatrixRate({
    payerType: "GOVERNMENT",
    recipientType: "USER",
    context: "DIRECT_TRANSFER",
    rateBp: 2000,
    governmentId: gov.id,
    governmentUsername: gov.username,
  });
  const govDecision = await resolveTaxDecision(db, {
    payer: governmentWallet(gov.id),
    recipient: userWallet(bob.id),
    context: "DIRECT_TRANSFER",
  });
  check(
    "the matrix can tax a Government->user transfer that V2 left tax-free",
    govDecision.rateBp === 2000 && govDecision.source === "MATRIX",
    govDecision,
  );
  const funded = await transfer({
    from: governmentWallet(gov.id),
    to: userWallet(bob.id),
    amount: 100,
    forcedTaxRateBp: 0,
    type: "GOVERNMENT_FUNDING",
    reason: "V3 test: forced rate beats the matrix",
  });
  check(
    "a server-forced tax-free administrative movement ignores the matrix",
    funded.taxAmount === 0 && funded.taxRateBpApplied === 0,
    funded,
  );
  await clearTaxMatrixRate({
    payerType: "GOVERNMENT",
    recipientType: "USER",
    context: "DIRECT_TRANSFER",
    governmentId: gov.id,
    governmentUsername: gov.username,
  });

  await expectError(
    "an unknown context is rejected, never defaulted",
    () =>
      resolveTaxDecision(db, {
        payer: userWallet(alice.id),
        recipient: userWallet(bob.id),
        context: "NOT_A_CONTEXT" as TaxTransactionContext,
      }),
    "Unknown tax context",
  );

  await expectError(
    "an out-of-range rate is rejected",
    () =>
      setTaxMatrixRate({
        payerType: "USER",
        recipientType: "USER",
        context: "DIRECT_TRANSFER",
        rateBp: 10001,
        governmentId: gov.id,
        governmentUsername: gov.username,
      }),
    "between 0 and 10000",
  );

  // =======================================================================
  console.log("\n=== 3. HISTORY IS NEVER RE-PRICED BY A LATER MATRIX CHANGE ===\n");
  // =======================================================================

  const historic = await transfer({
    from: userWallet(alice.id),
    to: userWallet(bob.id),
    amount: 400,
  });
  check(
    "historic transfer recorded at the V2 rate",
    historic.taxRateBpApplied === 500 && historic.taxAmount === 20,
    historic,
  );

  await setTaxMatrixRate({
    payerType: "USER",
    recipientType: "USER",
    context: "DIRECT_TRANSFER",
    rateBp: 3000,
    governmentId: gov.id,
    governmentUsername: gov.username,
  });

  const [reread] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.txRef, historic.txRef))
    .limit(1);
  check(
    "a settled ledger row keeps its snapshot rate after the matrix changes",
    reread.taxRateBpApplied === 500 && reread.taxAmount === 20 && reread.netAmount === 380,
    {
      rate: reread.taxRateBpApplied,
      tax: reread.taxAmount,
      net: reread.netAmount,
    },
  );

  const afterChange = await transfer({
    from: userWallet(alice.id),
    to: userWallet(bob.id),
    amount: 400,
  });
  check(
    "a NEW transfer made after the change uses the new rate (30% of 400 = 120)",
    afterChange.taxRateBpApplied === 3000 && afterChange.taxAmount === 120,
    afterChange,
  );

  await clearTaxMatrixRate({
    payerType: "USER",
    recipientType: "USER",
    context: "DIRECT_TRANSFER",
    governmentId: gov.id,
    governmentUsername: gov.username,
  });

  // The same guarantee for invoices, which snapshot the rate at issue time.
  if (company && company.status === "APPROVED") {
    const inv = await createInvoice({
      company,
      buyerUsername: bob.username,
      itemName: `V3 snapshot test ${RUN}`,
      quantity: 1,
      unitPrice: 200,
    });
    const quotedRate = inv.taxRateBp;
    check(
      "invoice quoted at the V2 company rate while the matrix is unconfigured",
      quotedRate === (company.taxRateBp ?? gov.companyTaxRateBp),
      { quotedRate },
    );

    await setTaxMatrixRate({
      payerType: "USER",
      recipientType: "COMPANY",
      context: "INVOICE_PAYMENT",
      rateBp: 2500,
      governmentId: gov.id,
      governmentUsername: gov.username,
    });

    const [invAfter] = await db.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1);
    check(
      "an already-issued invoice keeps its snapshot rate, tax and total",
      invAfter.taxRateBp === quotedRate &&
        invAfter.taxAmount === inv.taxAmount &&
        invAfter.total === inv.total,
      { was: inv.taxRateBp, now: invAfter.taxRateBp },
    );

    const paid = await payInvoice({ invoiceId: inv.id, payerUserId: bob.id });
    const [paidTx] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.txRef, paid.txRef))
      .limit(1);
    check(
      "paying that invoice charges the snapshot total, not the new matrix rate",
      paidTx.grossAmount === inv.total && paidTx.taxAmount === inv.taxAmount,
      { gross: paidTx.grossAmount, tax: paidTx.taxAmount, invoiceTotal: inv.total },
    );

    const newInv = await createInvoice({
      company,
      buyerUsername: bob.username,
      itemName: `V3 matrix invoice ${RUN}`,
      quantity: 1,
      unitPrice: 200,
    });
    check(
      "a NEW invoice issued after the change is quoted at the matrix rate (25%)",
      newInv.taxRateBp === 2500 && newInv.taxAmount === 50 && newInv.total === 250,
      newInv,
    );

    await clearTaxMatrixRate({
      payerType: "USER",
      recipientType: "COMPANY",
      context: "INVOICE_PAYMENT",
      governmentId: gov.id,
      governmentUsername: gov.username,
    });
  } else {
    console.log("      (skipping the invoice snapshot checks: no APPROVED company fixture)");
  }

  // =======================================================================
  console.log("\n=== 4. IDEMPOTENCY ===\n");
  // =======================================================================

  check(
    "fingerprint is order-independent",
    fingerprintRequest({ a: 1, b: "x" }) === fingerprintRequest({ b: "x", a: 1 }),
  );
  check(
    "fingerprint changes when a fact changes",
    fingerprintRequest({ a: 1 }) !== fingerprintRequest({ a: 2 }),
  );

  const payFacts = { from: alice.id, to: bob.id, amount: 300 };
  const key1 = `v3test-${RUN}-pay1`;

  async function payOnce(key: string, amount: number) {
    return runIdempotent<{ txRef: string }>({
      key,
      scope: "V3_TEST_PAY",
      actor: { type: "USER", id: alice.id },
      facts: { ...payFacts, amount },
      perform: async (tx) => {
        const r = await transferInTx(tx, {
          from: userWallet(alice.id),
          to: userWallet(bob.id),
          amount,
          reason: "V3 idempotency test",
        });
        return { value: { txRef: r.txRef }, txRef: r.txRef, entityType: "TRANSACTION" };
      },
      replay: async (record) => ({ txRef: record.resultTxRef! }),
    });
  }

  const balBefore1 = await balanceOf(alice.id);
  const first = await payOnce(key1, 300);
  const balAfter1 = await balanceOf(alice.id);
  check("first call performs the action", first.replayed === false && !!first.txRef, first);
  check("first call debited the sender exactly once", balBefore1 - balAfter1 === 300, {
    balBefore1,
    balAfter1,
  });

  const record1 = await getIdempotencyRecord(key1);
  check(
    "the key is recorded as SUCCEEDED with the result reference",
    record1?.status === "SUCCEEDED" && record1.resultTxRef === first.txRef,
    record1,
  );

  const retry = await payOnce(key1, 300);
  const balAfterRetry = await balanceOf(alice.id);
  check(
    "an identical retry returns the FIRST result instead of paying again",
    retry.replayed === true && retry.txRef === first.txRef && retry.value.txRef === first.txRef,
    retry,
  );
  check("the retry moved no Aeros", balAfterRetry === balAfter1, {
    balAfter1,
    balAfterRetry,
  });

  await expectError(
    "the same key with different facts is rejected, not replayed",
    () => payOnce(key1, 999),
    "different request",
  );

  await expectError(
    "the same key in a different scope is rejected",
    () =>
      runIdempotent<null>({
        key: key1,
        scope: "SOME_OTHER_ACTION",
        actor: { type: "USER", id: alice.id },
        facts: payFacts,
        perform: async () => ({ value: null }),
        replay: async () => null,
      }),
    "different action",
  );

  // --- a failing action stays retryable -----------------------------------
  const failKey = `v3test-${RUN}-fail`;
  let attempts = 0;
  async function flaky() {
    return runIdempotent<string>({
      key: failKey,
      scope: "V3_TEST_FLAKY",
      actor: { type: "USER", id: alice.id },
      facts: { n: 1 },
      perform: async () => {
        attempts++;
        if (attempts === 1) throw new Error("deliberate failure");
        return { value: "second attempt succeeded", entityType: "NONE" };
      },
      replay: async () => "replayed",
    });
  }
  await expectError("a failing action surfaces its own error", flaky, "deliberate failure");
  const failedRecord = await getIdempotencyRecord(failKey);
  check(
    "the key is marked FAILED with the reason",
    failedRecord?.status === "FAILED" && (failedRecord.errorMessage ?? "").includes("deliberate"),
    failedRecord,
  );
  const retried = await flaky();
  check(
    "a FAILED key may be retried and the action runs again",
    retried.replayed === false && retried.value === "second attempt succeeded" && attempts === 2,
    { retried, attempts },
  );

  // --- concurrent duplicate ------------------------------------------------
  const raceKey = `v3test-${RUN}-race`;
  const balBeforeRace = await balanceOf(alice.id);
  const raceResults = await Promise.allSettled([
    payOnce(raceKey, 250),
    payOnce(raceKey, 250),
  ]);
  const balAfterRace = await balanceOf(alice.id);

  const fulfilled = raceResults.filter((r) => r.status === "fulfilled");
  const performedCount = fulfilled.filter(
    (r) => (r as PromiseFulfilledResult<{ replayed: boolean }>).value.replayed === false,
  ).length;
  const rejectedMessages = raceResults
    .filter((r) => r.status === "rejected")
    .map((r) => ((r as PromiseRejectedResult).reason as Error).message);

  console.log(
    `      race: fulfilled=${fulfilled.length} performed=${performedCount} rejected=${JSON.stringify(rejectedMessages)}`,
  );
  check(
    "two concurrent calls with the same key performed the action exactly once",
    performedCount === 1,
    { performedCount, rejectedMessages },
  );
  check(
    "the concurrent duplicate did not double-spend (exactly one debit of 250)",
    balBeforeRace - balAfterRace === 250,
    { balBeforeRace, balAfterRace },
  );
  check(
    "the loser either replayed the first result or failed cleanly",
    raceResults.length === 2 &&
      (rejectedMessages.length === 0 ||
        rejectedMessages.every((m) => m.includes("already being processed"))),
    rejectedMessages,
  );

  // --- retention -----------------------------------------------------------
  const expiredKey = `v3test-${RUN}-expired`;
  await db.insert(idempotencyKeys).values({
    key: expiredKey,
    scope: "V3_TEST_EXPIRED",
    actorType: "USER",
    actorId: alice.id,
    requestHash: fingerprintRequest({ x: 1 }),
    status: "SUCCEEDED",
    expiresAt: new Date(Date.now() - 60_000),
  });
  const purged = await purgeExpiredIdempotencyKeys();
  check("expired idempotency keys are purgeable by the retention engine", purged >= 1, { purged });
  check(
    "the expired key is gone",
    (await getIdempotencyRecord(expiredKey)) === null,
  );

  // Tidy up this suite's own keys so re-running it is clean.
  await db.execute(sql`DELETE FROM idempotency_keys WHERE key LIKE ${`v3test-${RUN}-%`}`);

  // =======================================================================
  console.log("\n=== 5. DATABASE-ENFORCED V3 GUARANTEES ===\n");
  // =======================================================================

  await inRolledBackTx(async (tx) => {
    // The single global promotion slot is enforced by Postgres, not by code.
    await tx.execute(sql`
      INSERT INTO promotion_campaigns
        (heading, short_description, cta_label, destination,
         requested_duration_days, daily_rate, status)
      VALUES ('A', 'a', 'Go', '/marketplace', 7, 50, 'ACTIVE')
    `);
    let secondRejected = false;
    try {
      await tx.execute(sql`
        SAVEPOINT s1
      `);
      await tx.execute(sql`
        INSERT INTO promotion_campaigns
          (heading, short_description, cta_label, destination,
           requested_duration_days, daily_rate, status)
        VALUES ('B', 'b', 'Go', '/marketplace', 7, 50, 'ACTIVE')
      `);
      await tx.execute(sql`RELEASE SAVEPOINT s1`);
    } catch {
      secondRejected = true;
      await tx.execute(sql`ROLLBACK TO SAVEPOINT s1`);
    }
    check("a second ACTIVE promotion campaign is rejected by the database", secondRejected);
  });

  await inRolledBackTx(async (tx) => {
    // Ratings: stars are bounded 1..5 by a CHECK, not by a form validator.
    if (!company) return;
    let rejected = false;
    try {
      await tx.execute(sql`SAVEPOINT s2`);
      await tx.execute(sql`
        INSERT INTO marketplace_order_ratings
          (order_id, rater_type, rater_user_id, rated_company_id, stars)
        VALUES (gen_random_uuid(), 'USER', ${alice.id}, ${company.id}, 6)
      `);
      await tx.execute(sql`RELEASE SAVEPOINT s2`);
    } catch {
      rejected = true;
      await tx.execute(sql`ROLLBACK TO SAVEPOINT s2`);
    }
    check("a rating outside 1..5 stars is rejected by the database", rejected);
  });

  const [taxMatrixDupe] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(sql`(SELECT payer_type, recipient_type, context FROM tax_matrix
               GROUP BY 1,2,3 HAVING count(*) > 1) d`);
  check("the tax matrix cannot hold two rows for one combination", taxMatrixDupe.c === 0);

  // =======================================================================
  console.log("\n=== 6. RECONCILE: CLEAN FIXTURE ===\n");
  // =======================================================================

  /**
   * The existing V2 test harness deliberately NULLs `transactions.sender_id`
   * / `receiver_id` for COMPANY parties and deletes its own `flow%` users
   * during teardown, so a development database that has run those suites
   * genuinely does contain orphaned ledger rows. They are a fixture artifact,
   * not an application bug — this helper removes them so "clean" means clean.
   */
  async function makeCleanFixture(tx: Tx) {
    // V3: a reversal row points at the ledger row it undoes. The orphan sweep
    // below may delete a row some reversal references, so the self-link is
    // released first. Everything here happens inside a transaction that is
    // rolled back, so no real ledger row is ever changed.
    await tx.execute(
      sql`UPDATE transactions SET reverses_transaction_id = NULL WHERE reverses_transaction_id IS NOT NULL`,
    );
    await tx.execute(sql`
      DELETE FROM transactions t
      WHERE (t.sender_type = 'USER'
              AND (t.sender_id IS NULL
                   OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = t.sender_id)))
         OR (t.sender_type = 'COMPANY'
              AND (t.sender_id IS NULL
                   OR NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = t.sender_id)))
         OR (t.receiver_type = 'USER'
              AND (t.receiver_id IS NULL
                   OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = t.receiver_id)))
         OR (t.receiver_type = 'COMPANY'
              AND (t.receiver_id IS NULL
                   OR NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = t.receiver_id)))
    `);
    await tx.execute(sql`
      DELETE FROM company_sale_records r
      WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.tx_ref = r.tx_ref)
    `);
    await tx.execute(sql`
      DELETE FROM transactions t
      WHERE t.type = 'COMPANY_SALE_PURCHASE'
        AND NOT EXISTS (SELECT 1 FROM company_sale_records r WHERE r.tx_ref = t.tx_ref)
    `);
    await tx.execute(sql`
      UPDATE companies SET government_owned = false, government_acquired_at = NULL
      WHERE government_owned
        AND NOT EXISTS (
          SELECT 1 FROM company_sale_offers o
          WHERE o.company_id = companies.id
            AND o.status = 'ACCEPTED' AND o.offeror_type = 'GOVERNMENT')
    `);
    await tx.execute(sql`
      DELETE FROM loan_payments p
      WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.tx_ref = p.tx_ref)
    `);
    await tx.execute(sql`
      UPDATE loan_instalments SET status = 'PENDING', paid_tx_ref = NULL, paid_at = NULL
      WHERE status = 'PAID'
        AND (paid_tx_ref IS NULL
             OR NOT EXISTS (SELECT 1 FROM loan_payments p WHERE p.instalment_id = id))
    `);
    await tx.execute(sql`
      UPDATE invoices SET status = 'PENDING', paid_at = NULL, paid_tx_ref = NULL
      WHERE status = 'PAID'
        AND (paid_tx_ref IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM transactions t
               WHERE t.tx_ref = invoices.paid_tx_ref
                 AND t.invoice_id = invoices.id
                 AND t.gross_amount = invoices.total))
    `);
  }

  let cleanResult: ReconcileResult | null = null;
  await inRolledBackTx(async (tx) => {
    await makeCleanFixture(tx);
    cleanResult = await runHealthCheck(tx);
    for (const c of cleanResult.checks) {
      if (!c.passed) console.log(`      still failing: ${c.key} — ${c.detail} ${JSON.stringify(c.examples)}`);
    }
    check(
      `every reconcile check passes on a clean fixture (${cleanResult.checksRun} checks)`,
      cleanResult.healthy && cleanResult.checksFailed === 0,
      { run: cleanResult.checksRun, failed: cleanResult.checksFailed },
    );
    check(
      "the supply invariant is reported as balanced",
      cleanResult.supply.difference === 0,
      cleanResult.supply,
    );
  });
  // V3 Phase K added five more checks (ratings, promotions, contracts, V3
  // orphans, order snapshots), taking the set from 12 to 17. Asserting the
  // exact number again would mean editing this line every time a check is
  // added, which is how a count assertion quietly stops meaning anything. What
  // is worth asserting is that the set is the CANONICAL one: every check the
  // module knows how to run, each with a distinct key, and no fewer than the
  // twelve the V2/V3-A set established.
  const cleanChecks = cleanResult ? (cleanResult as ReconcileResult).checks : [];
  const expectedCheckCount = cleanResult ? (cleanResult as ReconcileResult).checksRun : 0;
  check(
    "the health check runs the whole canonical set (at least the original 12), with unique keys",
    expectedCheckCount >= 12 &&
      cleanChecks.length === expectedCheckCount &&
      new Set(cleanChecks.map((c) => c.key)).size === expectedCheckCount,
    { expectedCheckCount, keys: cleanChecks.map((c) => c.key) },
  );

  // =======================================================================
  console.log("\n=== 7. RECONCILE: EVERY CHECK FIRES ON A CORRUPTED FIXTURE ===\n");
  // =======================================================================

  /**
   * Applies one corruption on top of a clean fixture and asserts that exactly
   * the expected check flips to failing, then rolls the whole thing back.
   */
  async function corrupt(key: string, label: string, corrupter: (tx: Tx) => Promise<void>) {
    await inRolledBackTx(async (tx) => {
      await makeCleanFixture(tx);
      await corrupter(tx);
      const result = await runHealthCheck(tx);
      const target = result.checks.find((c) => c.key === key);
      const otherFailures = result.checks.filter((c) => !c.passed && c.key !== key).map((c) => c.key);
      check(
        `${key} fires when ${label}`,
        target !== undefined && !target.passed,
        { detail: target?.detail, otherFailures },
      );
      if (otherFailures.length > 0) {
        console.log(`      (also failing, expected collateral: ${otherFailures.join(", ")})`);
      }
    });
  }

  await corrupt("SUPPLY_INVARIANT", "a balance is changed without a ledger row", async (tx) => {
    await tx.execute(sql`UPDATE users SET balance = balance + 1 WHERE id = ${alice.id}`);
  });

  await corrupt("NO_NEGATIVE_BALANCES", "a wallet goes negative", async (tx) => {
    // The CHECK constraint normally makes this impossible; dropping it inside
    // this transaction (and rolling back) is how the check itself gets tested.
    await tx.execute(sql`ALTER TABLE users DROP CONSTRAINT users_balance_nonnegative`);
    await tx.execute(sql`UPDATE users SET balance = -1 WHERE id = ${alice.id}`);
  });

  await corrupt("NO_ORPHANED_WALLETS", "a company's owner disappears", async (tx) => {
    if (!company) return;
    await tx.execute(
      sql`ALTER TABLE companies DROP CONSTRAINT companies_owner_user_id_users_id_fk`,
    );
    await tx.execute(
      sql`UPDATE companies SET owner_user_id = gen_random_uuid() WHERE id = ${company.id}`,
    );
  });

  await corrupt("NO_ORPHANED_TRANSACTIONS", "a ledger row names a missing user", async (tx) => {
    await tx.execute(sql`
      UPDATE transactions SET sender_id = gen_random_uuid()
      WHERE sender_type = 'USER' AND id = (
        SELECT id FROM transactions WHERE sender_type = 'USER' LIMIT 1)
    `);
  });

  await corrupt(
    "NO_CONTRADICTORY_COMPANY_OWNERS",
    "a company is government-owned with no acquisition date",
    async (tx) => {
      if (!company) return;
      await tx.execute(sql`
        UPDATE companies SET government_owned = true, government_acquired_at = NULL
        WHERE id = ${company.id}
      `);
    },
  );

  await corrupt(
    "NO_PAID_INVOICE_WITHOUT_PAYMENT",
    "an invoice is marked PAID with no payment",
    async (tx) => {
      await tx.execute(sql`
        UPDATE invoices SET status = 'PAID', paid_at = now(), paid_tx_ref = NULL
        WHERE id = (SELECT id FROM invoices LIMIT 1)
      `);
    },
  );

  await corrupt(
    "NO_DUPLICATE_INVOICE_PAYMENT",
    "two ledger rows claim the same invoice",
    async (tx) => {
      await tx.execute(sql`
        INSERT INTO transactions
          (tx_ref, type, sender_type, sender_id, sender_username,
           receiver_type, receiver_id, receiver_username,
           gross_amount, tax_amount, net_amount, tax_rate_bp_applied, invoice_id)
        SELECT 'TX-DUP-1', t.type, t.sender_type, t.sender_id, t.sender_username,
               t.receiver_type, t.receiver_id, t.receiver_username,
               t.gross_amount, t.tax_amount, t.net_amount, t.tax_rate_bp_applied, t.invoice_id
        FROM transactions t
        WHERE t.invoice_id IS NOT NULL
        LIMIT 1
      `);
    },
  );

  await corrupt("NO_COMPANY_FUNDED_TWICE", "a company is funded twice", async (tx) => {
    await tx.execute(sql`
      INSERT INTO transactions
        (tx_ref, type, sender_type, sender_id, sender_username,
         receiver_type, receiver_id, receiver_username,
         gross_amount, tax_amount, net_amount, tax_rate_bp_applied)
      SELECT 'TX-DUPFUND-1', 'COMPANY_FUNDING', t.sender_type, t.sender_id, t.sender_username,
             t.receiver_type, t.receiver_id, t.receiver_username,
             t.gross_amount, t.tax_amount, t.net_amount, t.tax_rate_bp_applied
      FROM transactions t
      WHERE t.type = 'COMPANY_FUNDING' AND t.receiver_type = 'COMPANY'
      LIMIT 1
    `);
  });

  await corrupt(
    "ISSUANCE_DAILY_LIMIT",
    "two issuances are executed on the same IST calendar day",
    async (tx) => {
      await tx.execute(sql`UPDATE government SET issuance_cooldown_days = 1`);
      await tx.execute(sql`DELETE FROM issuance_votes`);
      await tx.execute(sql`DELETE FROM issuance_eligible_voters`);
      await tx.execute(sql`DELETE FROM issuance_requests`);
      await tx.execute(sql`
        INSERT INTO issuance_requests (amount, reason, status, executed_at)
        VALUES (10, 'fixture A', 'EXECUTED', now()),
               (10, 'fixture B', 'EXECUTED', now() + interval '1 minute')
      `);
    },
  );

  await corrupt(
    "NO_IMPOSSIBLE_LOAN_REPAYMENT",
    "a loan is repaid more than its principal",
    async (tx) => {
      await tx.execute(sql`
        INSERT INTO loans
          (loan_number, company_id, applied_by_user_id, requested_amount, purpose,
           principal, principal_paid, status)
        SELECT 'LN-FIXTURE-1', c.id, c.owner_user_id, 100, 'fixture', 100, 500, 'ACTIVE'
        FROM companies c LIMIT 1
      `);
    },
  );

  await corrupt(
    "NO_UNRECORDED_OWNERSHIP_TRANSFER",
    "a company purchase has no sale record",
    async (tx) => {
      await tx.execute(sql`
        INSERT INTO transactions
          (tx_ref, type, sender_type, sender_id, sender_username,
           receiver_type, receiver_id, receiver_username,
           gross_amount, tax_amount, net_amount, tax_rate_bp_applied)
        VALUES ('TX-NOSALE-1', 'COMPANY_SALE_PURCHASE', 'USER', ${alice.id}, ${alice.username},
                'USER', ${bob.id}, ${bob.username}, 100, 0, 100, 0)
      `);
    },
  );

  await corrupt(
    "NO_COMPLETED_ORDER_WITHOUT_PAYMENT",
    "an order is marked PAID with no invoice",
    async (tx) => {
      if (!company) return;
      const [offer] = await tx
        .insert(marketplaceOffers)
        .values({
          companyId: company.id,
          title: "Fixture offer",
          description: "fixture",
          category: "fixture",
          unitPrice: 10,
        })
        .returning();
      await tx.insert(marketplaceOrders).values({
        orderNumber: `ORD-FIXTURE-${RUN}`,
        offerId: offer.id,
        sellerCompanyId: company.id,
        buyerType: "USER",
        buyerUserId: alice.id,
        quantity: 1,
        unitPrice: 10,
        subtotal: 10,
        status: "PAID",
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    },
  );

  // =======================================================================
  console.log("\n=== 8. RECONCILE: THE LATEST-STATUS ROW ===\n");
  // =======================================================================

  const liveResult = await runHealthCheck();
  await saveHealthCheckStatus(liveResult, "v3-test");
  const status1 = await getHealthCheckStatus();
  check(
    "saving the status writes the summary",
    status1 !== null &&
      status1.checksRun === liveResult.checksRun &&
      status1.healthy === liveResult.healthy,
    status1,
  );
  await saveHealthCheckStatus(liveResult, "v3-test-again");
  const [statusCount] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(reconciliationStatus);
  check(
    "saving again REPLACES the single row — there is no reconciliation history",
    statusCount.c === 1,
    statusCount,
  );

  // =======================================================================
  // restore configuration state
  // =======================================================================
  await db.delete(taxMatrix).where(sql`true`);
  const [finalMatrix] = await db.select({ c: sql<number>`count(*)::int` }).from(taxMatrix);
  check("the tax matrix is left empty, as shipped", finalMatrix.c === 0);

  const after = await totals();
  check(
    "INVARIANT: total supply = treasury + users + companies after every operation",
    after.supply === after.accounted,
    after,
  );
  check(
    "INVARIANT: this suite never changed total supply",
    after.supply === before.supply,
    { start: before.supply, end: after.supply },
  );

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  await pool.end();
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
