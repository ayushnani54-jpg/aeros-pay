/**
 * Government-set limit on companies per person.
 *
 * Runs against a real Postgres database (like the other scripts in this folder):
 *   npx tsx -r ./scripts/test/hook.cjs scripts/test/test_company_limit.ts
 *
 * Covers: the default of 1 (nothing changes until the Government raises it),
 * raising the limit lets a person with a company create a second, the limit is
 * counted correctly (pending/approved/suspended count; rejected/revoked do
 * not), lowering it never touches existing companies, two applications sent at
 * the same moment cannot both squeeze under the limit, the database refuses a
 * nonsense limit, and the supply invariant still holds.
 */
import "dotenv/config";
import { db, pool } from "../../src/db/client";
import { companies, government, registrationCodes, users } from "../../src/db/schema";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import {
  applyForCompany,
  approveCompany,
  rejectCompany,
  setCompanyStatus,
  getCompanyAllowance,
  CompanyError,
} from "../../src/lib/companies";
import { maxCompaniesPolicySchema } from "../../src/lib/validators";
import { getOwnedCompanies } from "../../src/lib/auth";

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

const RUN = Math.random().toString(36).slice(2, 7);

async function makeUser(name: string) {
  let codeId: string | null = null;
  for (let i = 0; i < 80 && !codeId; i++) {
    try {
      const [row] = await db
        .insert(registrationCodes)
        .values({ code: String(Math.floor(1000 + Math.random() * 8999)), status: "USED" })
        .returning();
      codeId = row.id;
    } catch {
      /* code collision - retry */
    }
  }
  if (!codeId) throw new Error("no registration code available");
  const [u] = await db
    .insert(users)
    .values({
      username: name,
      displayName: name,
      passwordHash: await bcrypt.hash("Passw0rd!123", 4),
      registrationCodeId: codeId,
    })
    .returning();
  return u;
}

async function supply() {
  const [g] = await db.select().from(government).limit(1);
  const [u] = await db.select({ s: sql<number>`coalesce(sum(balance),0)::int` }).from(users);
  const [c] = await db.select({ s: sql<number>`coalesce(sum(balance),0)::int` }).from(companies);
  return { supply: g.totalSupply, accounted: g.balance + u.s + c.s };
}

async function setLimit(n: number) {
  await db.update(government).set({ maxCompaniesPerUser: n });
}

let seq = 0;
const app = (ownerUserId: string, tag: string) =>
  applyForCompany({
    ownerUserId,
    name: `Limit Co ${tag}`,
    username: `lim_${RUN}_${tag}_${++seq}`,
    category: "Testing",
    reason: "limit test",
    description: "A company used only to test the per-person limit.",
  });

async function main() {
  const [gov] = await db.select().from(government).limit(1);
  if (!gov) {
    console.log("FAIL  no government row - seed the database first");
    process.exit(1);
  }
  const approve = (id: string) =>
    approveCompany({ companyId: id, governmentId: gov.id, governmentUsername: gov.username });

  console.log("=== validator ===\n");
  const parse = (v: unknown) => maxCompaniesPolicySchema.safeParse({ maxCompaniesPerUser: v });
  check("validator: 3 is fine", parse("3").success && parse("3").data?.maxCompaniesPerUser === 3);
  check("validator: 1 and 100 are the edges and fine", parse("1").success && parse("100").success);
  check("validator: 0 refused", !parse("0").success);
  check("validator: 101 refused", !parse("101").success);
  check("validator: 2.5 refused", !parse("2.5").success);
  check("validator: text refused", !parse("abc").success);
  check("validator: empty refused", !parse("").success);

  console.log("\n=== default of 1 keeps the old behaviour ===\n");
  await setLimit(1);
  const a = await makeUser(`lim_a_${RUN}`);
  check("default: a new person may create their first company", (await getCompanyAllowance(db, a.id)).canCreate);
  const a1 = await app(a.id, "a1");
  check("first application stored as PENDING", a1.status === "PENDING");
  await expectError(
    "pending rule still applies: a second application while one is pending",
    () => app(a.id, "a2"),
    "awaiting Government review",
  );
  await approve(a1.id);
  const al1 = await getCompanyAllowance(db, a.id);
  check("after approval: owns 1 of 1, cannot create more", al1.owned === 1 && al1.max === 1 && !al1.canCreate, al1);
  await expectError(
    "limit 1: an approved owner cannot create a second company",
    () => app(a.id, "a2"),
    "You already own a company",
  );

  console.log("\n=== raising the limit lets the same person create a second ===\n");
  await setLimit(2);
  const al2 = await getCompanyAllowance(db, a.id);
  check("limit 2: owned 1 of 2, may create", al2.owned === 1 && al2.max === 2 && al2.canCreate, al2);
  const a2 = await app(a.id, "a2");
  check("second company application accepted", a2.status === "PENDING" && a2.ownerUserId === a.id);
  await expectError(
    "limit 2: while the 2nd is pending a 3rd cannot be submitted (pending rule)",
    () => app(a.id, "a3"),
    "awaiting Government review",
  );
  await approve(a2.id);
  await expectError(
    "limit 2: at 2 of 2 a third is refused with the count in the message",
    () => app(a.id, "a3"),
    "2 of the 2 companies",
  );
  const owned = await getOwnedCompanies(a.id);
  check("both companies belong to the person", owned.filter((c) => c.status === "APPROVED").length === 2);

  console.log("\n=== what counts toward the limit ===\n");
  const b = await makeUser(`lim_b_${RUN}`);
  await setLimit(1);
  const b1 = await app(b.id, "b1");
  await rejectCompany({ companyId: b1.id, governmentId: gov.id, governmentUsername: gov.username, reason: "test" });
  check("a REJECTED application does not use up the limit", (await getCompanyAllowance(db, b.id)).canCreate);
  const b2 = await app(b.id, "b2");
  await approve(b2.id);
  check("approved counts (1 of 1)", !(await getCompanyAllowance(db, b.id)).canCreate);
  await setCompanyStatus({ companyId: b2.id, governmentId: gov.id, governmentUsername: gov.username, status: "SUSPENDED", reason: "test" });
  check("a SUSPENDED company still counts (cannot dodge a suspension with a new company)", !(await getCompanyAllowance(db, b.id)).canCreate);
  await setCompanyStatus({ companyId: b2.id, governmentId: gov.id, governmentUsername: gov.username, status: "REVOKED", reason: "test" });
  check("a REVOKED company no longer counts", (await getCompanyAllowance(db, b.id)).canCreate);

  console.log("\n=== lowering the limit never touches existing companies ===\n");
  await setLimit(1);
  const [aCo] = await db.select().from(companies).where(eq(companies.id, a1.id)).limit(1);
  const [aCo2] = await db.select().from(companies).where(eq(companies.id, a2.id)).limit(1);
  check(
    "person with 2 companies under a limit of 1: both still APPROVED and untouched",
    aCo.status === "APPROVED" && aCo2.status === "APPROVED",
  );
  const alLow = await getCompanyAllowance(db, a.id);
  check("...but cannot create another (2 of 1)", alLow.owned === 2 && !alLow.canCreate, alLow);

  console.log("\n=== two applications at the same moment ===\n");
  const c = await makeUser(`lim_c_${RUN}`);
  await setLimit(2);
  const c1 = await app(c.id, "c1");
  await approve(c1.id);
  // 1 of 2 owned -> exactly one slot left. Fire two applications together.
  const results = await Promise.allSettled([app(c.id, "c2x"), app(c.id, "c2y")]);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const owned2 = (await getOwnedCompanies(c.id)).length;
  check("race: exactly one of two simultaneous applications is accepted", ok === 1, results.map((r) => r.status));
  check("race: the person ends with exactly 2 companies, never 3", owned2 === 2, owned2);
  const rejectedMsg = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  check(
    "race: the loser got a friendly CompanyError",
    !!rejectedMsg && rejectedMsg.reason instanceof CompanyError,
    rejectedMsg?.reason?.message,
  );

  console.log("\n=== the database itself refuses a nonsense limit ===\n");
  let refused0 = false;
  let refused101 = false;
  try {
    await db.execute(sql`update government set max_companies_per_user = 0`);
  } catch {
    refused0 = true;
  }
  try {
    await db.execute(sql`update government set max_companies_per_user = 101`);
  } catch {
    refused101 = true;
  }
  check("CHECK constraint: 0 refused by the database", refused0);
  check("CHECK constraint: 101 refused by the database", refused101);

  console.log("\n=== money untouched ===\n");
  const s = await supply();
  check("supply invariant: supply = treasury + users + companies", s.supply === s.accounted, s);

  await setLimit(1); // leave the default behind
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("SCRIPT ERROR:", e);
  await pool.end().catch(() => undefined);
  process.exit(2);
});
