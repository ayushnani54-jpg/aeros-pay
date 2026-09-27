import "dotenv/config";
import {
  createIssuanceRequest,
  castIssuanceVote,
  executeIssuance,
  getApprovalProgress,
  IssuanceError,
} from "../../src/lib/issuance";
import { db, pool } from "../../src/db/client";
import { users, government, issuanceRequests } from "../../src/db/schema";
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

async function main() {
  const [gov] = await db.select().from(government).limit(1);
  const allUsers = await db.select().from(users);
  console.log(
    "Active users:",
    allUsers.filter((u) => u.status === "ACTIVE").map((u) => u.username),
  );

  // 1. Amount cap
  await expectError(
    "amount exceeds cap",
    () =>
      createIssuanceRequest({
        governmentId: gov.id,
        governmentUsername: gov.username,
        amount: 5001,
        reason: "too much",
      }),
    "cannot exceed 5000",
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
  if (progress.fullyApproved) {
    console.log("PASS [100% approval reached]");
  } else {
    console.log("FAIL [100% approval reached]:", progress);
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

  // 9. 7-day cooldown: creating and fully approving a second request, then trying to execute
  const request2 = await createIssuanceRequest({
    governmentId: gov.id,
    governmentUsername: gov.username,
    amount: 500,
    reason: "second request within cooldown",
  });
  for (const u of eligibleActiveUsers) {
    await castIssuanceVote({ requestId: request2.id, userId: u.id, vote: "APPROVE" });
  }
  await expectError(
    "7-day cooldown enforcement",
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
  if (!progress3.fullyApproved && progress3.rejectCount === 1) {
    console.log("PASS [single rejection blocks 100% approval]:", progress3);
  } else {
    console.log("FAIL [single rejection blocks 100% approval]:", progress3);
  }

  await pool.end();
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
