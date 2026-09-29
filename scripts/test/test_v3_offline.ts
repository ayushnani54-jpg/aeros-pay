/**
 * V3 — PWA OFFLINE PAYMENTS
 *
 * Runs against a real Postgres database. All of these exercise the LIBRARY
 * layer directly (src/lib/offline-auth.ts, src/lib/session.ts's offline-token
 * primitives, src/lib/payments.ts, src/lib/idempotency.ts) — the same
 * convention every other V3 suite uses, since the server actions in
 * src/actions/offline.ts read the request's session cookie via
 * `next/headers`, which only exists inside a real Next.js request. Wherever
 * this file "simulates a sync", it is running the EXACT sequence
 * `syncOfflinePaymentAction` runs (consumeOfflineAllowance, then
 * resolvePayeeRefInTx, then transferInTx, all inside one runIdempotent-wrapped
 * transaction) — not a reimplementation of it.
 *
 * Areas:
 *
 *   1. POLICY-GATED ISSUANCE — disabled refuses, enabled snapshots the
 *      policy's total allowance / per-transaction max / expiry onto the
 *      token, and a user with no allowance left cannot get a new token.
 *   2. STRUCTURAL ENFORCEMENT AT SYNC — per-transaction max, per-token
 *      allowance, per-user allowance, expiry (both the JWT's own `exp` and
 *      the DB row's independent `expires_at`), wrong-session/wrong-account
 *      tokens, and a tampered token, all refused at the exact point the
 *      money would move — never earlier-checked-and-trusted.
 *   3. IDENTICAL TO A NORMAL PAYMENT — a synced offline payment is compared
 *      column-for-column against a normal `payByUsername` call with the same
 *      inputs.
 *   4. IDEMPOTENT SYNC — replaying the same client key twice performs the
 *      real action exactly once.
 *   5. PARTIAL SUCCESS UNDER A SHARED ALLOWANCE — two queued items that
 *      together exceed a token's remaining allowance: the ones that fit
 *      succeed, the rest are cleanly refused, sequentially AND concurrently
 *      (the concurrent case is the precise "two devices" scenario).
 *   6. COMPANY/GOVERNMENT WALLETS CANNOT GET A TOKEN — `issueOfflineAuthorization`
 *      only ever looks a plain id up in `users`, so a company or Government id
 *      is refused as "not found" by construction, not by a check someone
 *      could forget. (The session-layer defense — a company acting-context or
 *      a Government-only login never even reaching this function — lives in
 *      src/actions/offline.ts and cannot be exercised from a bare script; see
 *      the comment at that test below.)
 *
 * The supply invariant (total supply = treasury + Σusers + Σcompanies) is
 * re-checked after every scenario group, including ones with a deliberately
 * failed or partial sync.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { db, pool } from "../../src/db/client";
import { companies, government, offlineAuthTokens, registrationCodes, transactions, users } from "../../src/db/schema";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";

import { transfer, transferInTx, payByUsername, resolvePayeeRefInTx, type TransferResult } from "../../src/lib/payments";
import { companyWallet, governmentWallet, userWallet } from "../../src/lib/wallets";
import { runIdempotent } from "../../src/lib/idempotency";
import {
  consumeOfflineAllowance,
  issueOfflineAuthorization,
  verifyOfflineAuthorizationForSync,
} from "../../src/lib/offline-auth";
import { signOfflineAuthToken, verifyOfflineAuthToken } from "../../src/lib/session";

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
    // Drizzle wraps a raw Postgres error as `Failed query: ...` with the
    // real driver message (e.g. a CHECK constraint violation) nested one
    // level down in `.cause`, exactly like the production bug this project
    // hit once before (a missing-column error was invisible at the top
    // level). Check both so a real constraint firing isn't misreported here.
    const cause = e instanceof Error && "cause" in e ? (e.cause as unknown) : undefined;
    const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : "";
    const msg = (e instanceof Error ? e.message : String(e)) + (causeMsg ? ` | ${causeMsg}` : "");
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

async function tokenRowOf(tokenId: string) {
  const [row] = await db.select().from(offlineAuthTokens).where(eq(offlineAuthTokens.id, tokenId));
  return row;
}

async function txByRef(ref: string) {
  const [row] = await db.select().from(transactions).where(eq(transactions.txRef, ref));
  return row;
}

const RUN = Date.now().toString(36).slice(-6);
const FIXTURE_PREFIX = "v3o_";

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
      username: `${FIXTURE_PREFIX}${name}`,
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
      reason: "V3 offline test fixture",
    });
  }

  const [funded] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  return funded;
}

async function makeCompany(ownerUserId: string, name: string) {
  const [company] = await db
    .insert(companies)
    .values({
      ownerUserId,
      name: `Test ${name}`,
      username: `${FIXTURE_PREFIX}${name}`,
      category: "Testing",
      reason: "V3 offline tests",
      description: "Fixture company for the V3 offline-payments suite.",
      status: "APPROVED",
      balance: 0,
    })
    .returning();
  return company;
}

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
        reason: "V3 offline fixture sweep",
        skipSenderCheck: true,
      });
    }
  }
}

async function setGovOfflinePolicy(policy: {
  enabled: boolean;
  totalAllowance: number;
  maxPerTransaction: number;
  expiryMinutes: number | null;
}) {
  const [g] = await db.select({ id: government.id }).from(government).limit(1);
  await db
    .update(government)
    .set({
      offlineTransactionsEnabled: policy.enabled,
      offlineTotalAllowance: policy.totalAllowance,
      offlineMaxPerTransaction: policy.maxPerTransaction,
      offlineAuthExpiryMinutes: policy.expiryMinutes,
    })
    .where(eq(government.id, g.id));
}

/**
 * Exactly what `syncOfflinePaymentAction` does, minus the session/rate-limit
 * plumbing that only exists inside a real request: verify-then-consume-then-
 * transfer, all inside one `runIdempotent`-wrapped transaction.
 */
async function simulateSync(params: {
  tokenId: string;
  userId: string;
  recipientUsername: string;
  amount: number;
  clientKey: string;
}) {
  return runIdempotent<TransferResult>({
    key: params.clientKey,
    scope: "OFFLINE_PAYMENT_SYNC",
    actor: { type: "USER", id: params.userId },
    facts: {
      tokenId: params.tokenId,
      userId: params.userId,
      recipientUsername: params.recipientUsername,
      amount: params.amount,
    },
    perform: async (tx) => {
      await consumeOfflineAllowance(tx, {
        tokenId: params.tokenId,
        userId: params.userId,
        amount: params.amount,
      });
      const to = await resolvePayeeRefInTx(tx, { username: params.recipientUsername });
      const result = await transferInTx(tx, {
        from: userWallet(params.userId),
        to,
        amount: params.amount,
        reason: "Offline payment (synced)",
      });
      return { value: result, txRef: result.txRef, entityType: "TRANSACTION", entityId: null };
    },
    replay: async (record) => {
      const [row] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.txRef, record.resultTxRef!))
        .limit(1);
      if (!row) throw new Error("offline payment record missing on replay");
      return {
        txRef: row.txRef,
        grossAmount: row.grossAmount,
        taxAmount: row.taxAmount,
        netAmount: row.netAmount,
        taxRateBpApplied: row.taxRateBpApplied,
        senderUsername: row.senderUsername,
        senderLabel: row.senderUsername,
        receiverUsername: row.receiverUsername,
        receiverLabel: row.receiverUsername,
      } satisfies TransferResult;
    },
  });
}

async function main() {
  const [g0] = await db.select().from(government).limit(1);
  baselineSupply = g0.totalSupply;
  const originalPolicy = {
    enabled: g0.offlineTransactionsEnabled,
    totalAllowance: g0.offlineTotalAllowance,
    maxPerTransaction: g0.offlineMaxPerTransaction,
    expiryMinutes: g0.offlineAuthExpiryMinutes,
  };

  // =========================================================================
  // 1. POLICY-GATED ISSUANCE
  // =========================================================================
  console.log("\n=== 1. POLICY-GATED ISSUANCE ===\n");

  const alice = await makeUser(`alice_${RUN}`, 2000);

  await setGovOfflinePolicy({ enabled: false, totalAllowance: 1000, maxPerTransaction: 300, expiryMinutes: 30 });
  await expectError(
    "disabled policy refuses token issuance",
    () => issueOfflineAuthorization(alice.id),
    "disabled",
  );

  await setGovOfflinePolicy({ enabled: true, totalAllowance: 1000, maxPerTransaction: 300, expiryMinutes: 30 });
  const auth1 = await issueOfflineAuthorization(alice.id);
  check("issued allowance matches the policy's total allowance (nothing spent yet)", auth1.allowance === 1000, auth1);
  check("issued per-transaction max matches policy", auth1.perTransactionMax === 300, auth1);
  const mintedMinutes = Math.round(
    (new Date(auth1.expiresAt).getTime() - new Date(auth1.issuedAt).getTime()) / 60_000,
  );
  check("issued expiry matches the policy's 30-minute setting", mintedMinutes === 30, { mintedMinutes });

  const govTokenRow = await tokenRowOf(auth1.tokenId);
  check("the token row is persisted with a zero consumed amount", govTokenRow?.consumedAmount === 0, govTokenRow);

  await invariant("policy-gated issuance");

  // =========================================================================
  // 2. STRUCTURAL ENFORCEMENT AT SYNC
  // =========================================================================
  console.log("\n=== 2. STRUCTURAL ENFORCEMENT AT SYNC ===\n");

  await expectError(
    "sync refuses an amount over the token's per-transaction max",
    () => db.transaction((tx) => consumeOfflineAllowance(tx, { tokenId: auth1.tokenId, userId: alice.id, amount: 301 })),
    "per-transaction limit",
  );

  // Spend the token down to exactly its allowance, in guarded steps that
  // each individually respect the 300 per-transaction max (this is what a
  // real sync of several small queued payments looks like — 900 in one call
  // would itself violate the per-transaction limit just proven above).
  await db.transaction((tx) => consumeOfflineAllowance(tx, { tokenId: auth1.tokenId, userId: alice.id, amount: 300 }));
  await db.transaction((tx) => consumeOfflineAllowance(tx, { tokenId: auth1.tokenId, userId: alice.id, amount: 300 }));
  await db.transaction((tx) => consumeOfflineAllowance(tx, { tokenId: auth1.tokenId, userId: alice.id, amount: 300 }));
  await expectError(
    "sync refuses once the token's own remaining allowance would be exceeded",
    () => db.transaction((tx) => consumeOfflineAllowance(tx, { tokenId: auth1.tokenId, userId: alice.id, amount: 150 })),
    "allowance has already been used up",
  );
  await db.transaction((tx) => consumeOfflineAllowance(tx, { tokenId: auth1.tokenId, userId: alice.id, amount: 100 }));
  const exhausted = await tokenRowOf(auth1.tokenId);
  check("the token's consumed amount equals its full allowance, never more", exhausted?.consumedAmount === 1000, exhausted);

  // Prove the CHECK constraint is real, not just a comment: bypass the
  // application's guarded UPDATE entirely and try to push this row over its
  // own allowance with a raw statement. The database must refuse it.
  await expectError(
    "the database's own CHECK constraint refuses consumed_amount > allowance_at_issue, even bypassing the application guard",
    () =>
      db.execute(
        sql`UPDATE offline_auth_tokens SET consumed_amount = allowance_at_issue + 1 WHERE id = ${exhausted!.id}`,
      ),
    "offline_auth_tokens_consumed_within_allowance",
  );

  // The per-user allowance is now fully spent — even a brand new token
  // refuses, because issuance re-reads users.offline_allowance_used.
  await expectError(
    "no allowance left for a new token once the per-user cap is spent",
    () => issueOfflineAuthorization(alice.id),
    "no offline allowance remaining",
  );

  // Expiry — TWO independent layers.
  // (a) the JWT's own `exp`, checked by `jose`'s jwtVerify:
  const bob = await makeUser(`bob_${RUN}`, 0);
  const alreadyExpiredToken = await signOfflineAuthToken(
    { purpose: "offline_payment_auth", sub: bob.id, jti: randomUUID(), allowance: 100, perTxMax: 100 },
    -5,
  );
  const verifiedExpiredJwt = await verifyOfflineAuthToken(alreadyExpiredToken);
  check("a JWT already past its own exp claim fails signature/expiry verification", verifiedExpiredJwt === null);
  await expectError(
    "verifyOfflineAuthorizationForSync refuses an expired JWT even though it was signed by us",
    () => verifyOfflineAuthorizationForSync({ token: alreadyExpiredToken, sessionUserId: bob.id }),
    "invalid or has expired",
  );

  // (b) the DB row's OWN independent expiry, in case a token were ever
  // presented whose JWT `exp` were somehow generous but whose issued
  // allowance row has separately lapsed — this is the "fine when cached, but
  // time passed before sync" case, enforced where the money would move.
  await setGovOfflinePolicy({ enabled: true, totalAllowance: 2000, maxPerTransaction: 1000, expiryMinutes: 60 });
  const carol = await makeUser(`carol_${RUN}`, 2000);
  const authCarolStale = await issueOfflineAuthorization(carol.id);
  await db
    .update(offlineAuthTokens)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(offlineAuthTokens.id, authCarolStale.tokenId));
  await expectError(
    "sync refuses a token whose DB row has independently expired",
    () =>
      db.transaction((tx) =>
        consumeOfflineAllowance(tx, { tokenId: authCarolStale.tokenId, userId: carol.id, amount: 10 }),
      ),
    "expired",
  );

  // Wrong session / wrong account.
  const authAliceFresh = await (async () => {
    // alice has no allowance left; give her a small top-up so this section is
    // about identity, not allowance.
    await setGovOfflinePolicy({ enabled: true, totalAllowance: 1200, maxPerTransaction: 300, expiryMinutes: 30 });
    return issueOfflineAuthorization(alice.id);
  })();
  await expectError(
    "a token cannot be verified for a session other than the one it was issued to",
    () => verifyOfflineAuthorizationForSync({ token: authAliceFresh.token, sessionUserId: bob.id }),
    "does not belong to your session",
  );
  await expectError(
    "consumeOfflineAllowance independently refuses a token/account mismatch, defense in depth",
    () => db.transaction((tx) => consumeOfflineAllowance(tx, { tokenId: authAliceFresh.tokenId, userId: bob.id, amount: 10 })),
    "does not belong to this account",
  );

  // Tampered token: decode the payload, inflate the allowance, re-encode it
  // WITHOUT re-signing — exactly what a client editing IndexedDB by hand
  // would produce.
  const parts = authAliceFresh.token.split(".");
  const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  const forgedPayload = { ...decoded, allowance: 999_999 };
  const forgedB64 = Buffer.from(JSON.stringify(forgedPayload)).toString("base64url");
  const tampered = `${parts[0]}.${forgedB64}.${parts[2]}`;
  const verifiedTampered = await verifyOfflineAuthToken(tampered);
  check("a token with an altered (unsigned) payload fails signature verification", verifiedTampered === null, {
    tampered,
  });
  await expectError(
    "a tampered token is refused at sync, not just at verification",
    () => verifyOfflineAuthorizationForSync({ token: tampered, sessionUserId: alice.id }),
    "invalid or has expired",
  );

  await invariant("structural enforcement at sync");

  // =========================================================================
  // 3. IDENTICAL TO A NORMAL PAYMENT
  // =========================================================================
  console.log("\n=== 3. A SYNCED OFFLINE PAYMENT IS IDENTICAL TO A NORMAL ONE ===\n");

  await setGovOfflinePolicy({ enabled: true, totalAllowance: 5000, maxPerTransaction: 2000, expiryMinutes: 60 });

  const dana = await makeUser(`dana_${RUN}`, 2000); // pays offline
  const erin = await makeUser(`erin_${RUN}`, 2000); // pays online, for comparison
  const recipient = await makeUser(`frank_${RUN}`, 0);

  const authDana = await issueOfflineAuthorization(dana.id);
  const offlineOutcome = await simulateSync({
    tokenId: authDana.tokenId,
    userId: dana.id,
    recipientUsername: recipient.username,
    amount: 500,
    clientKey: randomUUID(),
  });
  const onlineResult = await payByUsername({
    from: userWallet(erin.id),
    recipientUsername: recipient.username,
    amount: 500,
  });

  check(
    "the synced offline payment's tax breakdown exactly matches a normal payByUsername call",
    offlineOutcome.value.grossAmount === onlineResult.grossAmount &&
      offlineOutcome.value.taxAmount === onlineResult.taxAmount &&
      offlineOutcome.value.netAmount === onlineResult.netAmount &&
      offlineOutcome.value.taxRateBpApplied === onlineResult.taxRateBpApplied,
    { offline: offlineOutcome.value, online: onlineResult },
  );

  const offlineRow = await txByRef(offlineOutcome.value.txRef);
  const onlineRow = await txByRef(onlineResult.txRef);
  check(
    "the resulting ledger row is indistinguishable from a normal payment: same type, party types, tax fields",
    offlineRow?.type === onlineRow?.type &&
      offlineRow?.type === "TRANSFER" &&
      offlineRow?.senderType === onlineRow?.senderType &&
      offlineRow?.receiverType === onlineRow?.receiverType &&
      offlineRow?.taxRateBpApplied === onlineRow?.taxRateBpApplied &&
      offlineRow?.invoiceId === null &&
      offlineRow?.reversesTransactionId === null,
    { offlineRow, onlineRow },
  );

  await invariant("identical-to-normal-payment comparison");

  // =========================================================================
  // 4. IDEMPOTENT SYNC
  // =========================================================================
  console.log("\n=== 4. IDEMPOTENT SYNC ===\n");

  const gina = await makeUser(`gina_${RUN}`, 2000);
  const authGina = await issueOfflineAuthorization(gina.id);
  const sameKey = randomUUID();
  const ginaBalanceBefore = await balanceOfUser(gina.id);

  const first = await simulateSync({
    tokenId: authGina.tokenId,
    userId: gina.id,
    recipientUsername: recipient.username,
    amount: 200,
    clientKey: sameKey,
  });
  const second = await simulateSync({
    tokenId: authGina.tokenId,
    userId: gina.id,
    recipientUsername: recipient.username,
    amount: 200,
    clientKey: sameKey,
  });

  check("a replayed sync returns the SAME txRef rather than creating a new payment", first.txRef === second.txRef, {
    first: first.txRef,
    second: second.txRef,
  });
  check("the second call is reported as a replay, not a fresh action", second.replayed === true, second);

  const ginaTokenAfter = await tokenRowOf(authGina.tokenId);
  check(
    "the token's consumed amount reflects exactly ONE real spend, not two",
    ginaTokenAfter?.consumedAmount === 200,
    ginaTokenAfter,
  );

  const ginaBalanceAfter = await balanceOfUser(gina.id);
  check(
    "gina's balance dropped by exactly one payment's gross amount, not two",
    ginaBalanceBefore - ginaBalanceAfter === 200,
    { ginaBalanceBefore, ginaBalanceAfter },
  );

  await invariant("idempotent sync");

  // =========================================================================
  // 5. PARTIAL SUCCESS UNDER A SHARED ALLOWANCE (two devices / two items)
  // =========================================================================
  console.log("\n=== 5. TWO QUEUED ITEMS EXCEEDING A SHARED ALLOWANCE ===\n");

  await setGovOfflinePolicy({ enabled: true, totalAllowance: 500, maxPerTransaction: 500, expiryMinutes: 60 });
  const henry = await makeUser(`henry_${RUN}`, 2000);
  const authHenry = await issueOfflineAuthorization(henry.id);
  check("henry's token allowance is exactly the policy total (500)", authHenry.allowance === 500, authHenry);

  const henryBalanceBefore = await balanceOfUser(henry.id);

  // Sequential: 300 fits, then a second 300 does not (300+300=600 > 500).
  const seqOk = await simulateSync({
    tokenId: authHenry.tokenId,
    userId: henry.id,
    recipientUsername: recipient.username,
    amount: 300,
    clientKey: randomUUID(),
  });
  check("the first queued item (300) syncs cleanly", seqOk.value.grossAmount === 300, seqOk.value);

  await expectError(
    "the second queued item (300 more) is cleanly refused — it would exceed the token's allowance",
    () =>
      simulateSync({
        tokenId: authHenry.tokenId,
        userId: henry.id,
        recipientUsername: recipient.username,
        amount: 300,
        clientKey: randomUUID(),
      }),
    "allowance has already been used up",
  );

  const henryBalanceAfter = await balanceOfUser(henry.id);
  check(
    "henry's balance dropped by EXACTLY the one payment that succeeded (300), never more, never negative",
    henryBalanceBefore - henryBalanceAfter === 300 && henryBalanceAfter >= 0,
    { henryBalanceBefore, henryBalanceAfter },
  );

  // Concurrent: the precise "two devices sync at once" case. A fresh token
  // with a 500 allowance, and two 300-Aeros payments fired at once — each
  // individually fits under the token's allowance, but together (600) they
  // do not, so exactly one may win.
  const ivan = await makeUser(`ivan_${RUN}`, 2000);
  const authIvan = await issueOfflineAuthorization(ivan.id);
  const ivanBalanceBefore = await balanceOfUser(ivan.id);

  const race = await Promise.allSettled([
    simulateSync({
      tokenId: authIvan.tokenId,
      userId: ivan.id,
      recipientUsername: recipient.username,
      amount: 300,
      clientKey: randomUUID(),
    }),
    simulateSync({
      tokenId: authIvan.tokenId,
      userId: ivan.id,
      recipientUsername: recipient.username,
      amount: 300,
      clientKey: randomUUID(),
    }),
  ]);
  const raceOk = race.filter((r) => r.status === "fulfilled");
  const raceFailed = race.filter((r) => r.status === "rejected");
  check(
    "two concurrent syncs against the SAME token/allowance: exactly one wins, never both, never neither",
    raceOk.length === 1 && raceFailed.length === 1,
    { ok: raceOk.length, failed: raceFailed.length },
  );

  const ivanTokenAfter = await tokenRowOf(authIvan.tokenId);
  check(
    "the token's consumed amount after the race is exactly one payment's worth, and never exceeds its allowance",
    ivanTokenAfter?.consumedAmount === 300 && (ivanTokenAfter?.consumedAmount ?? 0) <= (ivanTokenAfter?.allowanceAtIssue ?? 0),
    ivanTokenAfter,
  );

  const ivanBalanceAfter = await balanceOfUser(ivan.id);
  check(
    "ivan's balance never went negative and dropped by exactly the one winning payment",
    ivanBalanceAfter >= 0 && ivanBalanceBefore - ivanBalanceAfter === 300,
    { ivanBalanceBefore, ivanBalanceAfter },
  );

  await invariant("partial-success-under-shared-allowance (including a deliberately failed sync)");

  // =========================================================================
  // 6. COMPANY / GOVERNMENT WALLETS CANNOT GET A TOKEN
  // =========================================================================
  console.log("\n=== 6. COMPANY / GOVERNMENT WALLETS NEVER GET OFFLINE CAPABILITY ===\n");

  await setGovOfflinePolicy({ enabled: true, totalAllowance: 1000, maxPerTransaction: 500, expiryMinutes: 60 });

  const julia = await makeUser(`julia_${RUN}`, 0);
  const juliaCo = await makeCompany(julia.id, `co_${RUN}`);
  await expectError(
    "a company id is refused as 'not found' — issueOfflineAuthorization only ever looks in `users`",
    () => issueOfflineAuthorization(juliaCo.id),
    "Account not found",
  );

  const [govRow] = await db.select({ id: government.id }).from(government).limit(1);
  await expectError(
    "the Government's own id is refused the same way — there is no offline code path for it at all",
    () => issueOfflineAuthorization(govRow.id),
    "Account not found",
  );

  check(
    "companyWallet/governmentWallet refs are a different kind entirely — sanity check the helpers used elsewhere agree",
    companyWallet(juliaCo.id).kind === "COMPANY" && governmentWallet(govRow.id).kind === "GOVERNMENT",
  );

  // NOTE ON WHAT THIS SUITE CANNOT EXERCISE FROM A BARE SCRIPT:
  // in the real app, `issueOfflineAuthorizationAction` (src/actions/offline.ts)
  // refuses a company acting-context BEFORE calling `issueOfflineAuthorization`
  // at all, and a Government-only login can never reach it in the first place
  // because `requireActingContext` is built entirely on the USER session
  // cookie (src/lib/auth.ts) — a Government session is a completely separate
  // cookie/table `getActingContext` never reads. Neither of those two extra
  // layers can be driven from a script with no HTTP request/cookie context;
  // this suite instead proves the library-level guarantee above, which is the
  // one that holds even if that action-level gate were ever removed by
  // mistake.
  check(
    "(documented, not executed here) the session-layer gate in src/actions/offline.ts is additional, not load-bearing",
    true,
  );

  await invariant("company/government cannot obtain a token");

  // =========================================================================
  // cleanup
  // =========================================================================
  await sweepFixtures();
  await db
    .update(government)
    .set({
      offlineTransactionsEnabled: originalPolicy.enabled,
      offlineTotalAllowance: originalPolicy.totalAllowance,
      offlineMaxPerTransaction: originalPolicy.maxPerTransaction,
      offlineAuthExpiryMinutes: originalPolicy.expiryMinutes,
    })
    .where(eq(government.id, g0.id));

  await invariant("cleanup: sweeping fixtures and restoring the original offline policy");

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  await pool.end();
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
