import "dotenv/config";
import {
  createIssuanceRequest,
  castIssuanceVote,
  executeIssuance,
  getApprovalProgress,
  IssuanceError,
} from "../../src/lib/issuance";
import { db, pool } from "../../src/db/client";
import {
  users,
  government,
  issuanceRequests,
  issuanceEligibleVoters,
  issuanceVotes,
} from "../../src/db/schema";
import { eq } from "drizzle-orm";

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

/**
 * This script's assertions (the daily IST issuance limit, in particular)
 * depend on there being no leftover EXECUTED issuance request from an
 * earlier run still sitting in the table — otherwise re-running the script
 * on the same IST day would spuriously trip the "already executed today"
 * check at step 7 rather than exercising it deliberately at steps 9/11.
 * Issuance-request rows carry no balance of their own (the balance/supply
 * change they caused when executed is not reversed here, same as every
 * other fixture reset in this test suite), so clearing them is safe and
 * makes the script idempotent across repeated runs.
 */
async function resetIssuanceFixtures() {
  await db.delete(issuanceVotes);
  await db.delete(issuanceEligibleVoters);
  await db.delete(issuanceRequests);
}

async function main() {
  await resetIssuanceFixtures();

  const [gov] = await db.select().from(government).limit(1);
  const allUsers = await db.select().from(users);
  console.log(
    "Active users:",
    allUsers.filter((u) => u.status === "ACTIVE").map((u) => u.username),
  );

  // 1. Amount cap (V2.1: the live, Government-configurable
  // government.max_issuance_amount, default 10,000 — not a hardcoded 5,000).
  await expectError(
    "amount exceeds cap",
    () =>
      createIssuanceRequest({
        governmentId: gov.id,
        governmentUsername: gov.username,
        amount: 10_001,
        reason: "too much",
      }),
    `cannot exceed ${gov.maxIssuanceAmount.toLocaleString()}`,
  );

  // 2. Create a valid request
  const request = await createIssuanceRequest({
    governmentId: gov.id,
    governmentUsername: gov.username,
    amount: 3000,
    reason: "Economic expansion test",
  });
  console.log("PASS [create request]:", request.id, request.amount);

  const eligibleActiveUsers = allUsers.filter((u) => u.status === "ACTIVE");

  // 3. Non-eligible / duplicate vote protection: first vote succeeds
  const voter1 = eligibleActiveUsers[0];
  await castIssuanceVote({ requestId: request.id, userId: voter1.id, vote: "APPROVE" });
  console.log("PASS [first vote recorded] by", voter1.username);

  // 4. Duplicate vote by same user should fail
  await expectError(
    "duplicate vote",
    () => castIssuanceVote({ requestId: request.id, userId: voter1.id, vote: "APPROVE" }),
    "already voted",
  );

  // 5. Attempt to execute before 100% approval
  await expectError(
    "execute before full approval",
    () => executeIssuance({ requestId: request.id, governmentId: gov.id, governmentUsername: gov.username }),
    "Approval requirement has not been met",
  );

  // 6. Remaining eligible users approve
  for (const u of eligibleActiveUsers.slice(1)) {
    await castIssuanceVote({ requestId: request.id, userId: u.id, vote: "APPROVE" });
  }
  const progress = await getApprovalProgress(request.id);
  console.log("Approval progress:", progress);
  // V2: a simple majority passes, not unanimity.
  if (progress.thresholdReached) {
    console.log("PASS [majority threshold reached]");
  } else {
    console.log("FAIL [majority threshold reached]:", progress);
  }

  // 7. Execute — should succeed now
  const govBefore = (await db.select().from(government).where(eq(government.id, gov.id)))[0];
  const execResult = await executeIssuance({
    requestId: request.id,
    governmentId: gov.id,
    governmentUsername: gov.username,
  });
  console.log("PASS [execute issuance]:", execResult);

  const govAfter = (await db.select().from(government).where(eq(government.id, gov.id)))[0];
  if (
    govAfter.balance === govBefore.balance + 3000 &&
    govAfter.totalSupply === govBefore.totalSupply + 3000
  ) {
    console.log("PASS [treasury + supply increased by exactly 3000]");
  } else {
    console.log(
      `FAIL [treasury + supply]: before(${govBefore.balance},${govBefore.totalSupply}) after(${govAfter.balance},${govAfter.totalSupply})`,
    );
  }

  // 8. Double execution prevention
  await expectError(
    "double execution",
    () => executeIssuance({ requestId: request.id, governmentId: gov.id, governmentUsername: gov.username }),
    "already been executed",
  );

  // 9. IST calendar-day limit (V2.1: replaces the old rolling 7-day cooldown
  // — Government may execute at most one issuance per IST calendar day).
  // Creating and fully approving a second request the same IST day, then
  // trying to execute it, must be blocked since request 1 was just executed
  // today (IST).
  const request2 = await createIssuanceRequest({
    governmentId: gov.id,
    governmentUsername: gov.username,
    amount: 500,
    reason: "second request same IST day",
  });
  for (const u of eligibleActiveUsers) {
    await castIssuanceVote({ requestId: request2.id, userId: u.id, vote: "APPROVE" });
  }
  await expectError(
    "same-IST-day execution blocked",
    () =>
      executeIssuance({
        requestId: request2.id,
        governmentId: gov.id,
        governmentUsername: gov.username,
      }),
    "one Aeros issuance is allowed per",
  );

  // 10. A single REJECT vote should prevent ever reaching 100% approval
  const request3 = await createIssuanceRequest({
    governmentId: gov.id,
    governmentUsername: gov.username,
    amount: 200,
    reason: "third request, will be rejected by one voter",
  });
  await castIssuanceVote({ requestId: request3.id, userId: eligibleActiveUsers[0].id, vote: "REJECT" });
  for (const u of eligibleActiveUsers.slice(1)) {
    await castIssuanceVote({ requestId: request3.id, userId: u.id, vote: "APPROVE" });
  }
  const progress3 = await getApprovalProgress(request3.id);
  // V2: one rejection no longer blocks on its own — a majority still decides.
  if (progress3.rejectCount === 1) {
    console.log("PASS [rejection recorded, majority still decides]:", progress3);
  } else {
    console.log("FAIL [rejection recorded]:", progress3);
  }

  // 11. Next-IST-day: once the last execution's `executedAt` falls on a
  // previous IST calendar day, a new (already fully-approved) request may be
  // executed. We can't wait a real day in a test run, so we backdate the
  // already-executed request's timestamp directly — this exercises exactly
  // the same `hasRecentExecution` / istCalendarDaysBetween comparison that
  // production code uses at the next real IST midnight.
  const twoIstDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await db
    .update(issuanceRequests)
    .set({ executedAt: twoIstDaysAgo })
    .where(eq(issuanceRequests.id, request.id));

  const govBeforeNextDay = (await db.select().from(government).where(eq(government.id, gov.id)))[0];
  const execResult2 = await executeIssuance({
    requestId: request2.id,
    governmentId: gov.id,
    governmentUsername: gov.username,
  });
  const govAfterNextDay = (await db.select().from(government).where(eq(government.id, gov.id)))[0];
  if (
    execResult2.amount === 500 &&
    govAfterNextDay.balance === govBeforeNextDay.balance + 500 &&
    govAfterNextDay.totalSupply === govBeforeNextDay.totalSupply + 500
  ) {
    console.log("PASS [next-IST-day execution allowed after backdating last execution]:", execResult2);
  } else {
    console.log(
      `FAIL [next-IST-day execution]: result(${JSON.stringify(execResult2)}) before(${govBeforeNextDay.balance},${govBeforeNextDay.totalSupply}) after(${govAfterNextDay.balance},${govAfterNextDay.totalSupply})`,
    );
  }

  await pool.end();
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
