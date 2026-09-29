/**
 * V3 PHASE J — EXPORTS AND DOWNLOADS
 *
 * Runs against a real Postgres database. Areas:
 *
 *   1. EVERY GOVERNMENT DATASET exports as CSV and as JSON, with a header row
 *      that matches its declared columns and a body that parses cleanly.
 *   2. FILTERS narrow correctly — date range, type, status, amount range,
 *      wallet type, named user/company and free-text entity — and a filter
 *      that matches nothing returns nothing rather than everything.
 *   3. SCOPE. A user export contains only that user's rows and a company
 *      export only that company's. Cross-tenant access is attempted from every
 *      angle available to a caller and refused each time.
 *   4. CSV INJECTION. `=cmd`, `+1`, `-1`, `@SUM`, a leading tab and a leading
 *      CR are all neutralised, and the JSON export keeps the raw value.
 *   5. ROUND TRIPS. Embedded quotes, commas and newlines come back byte-exact.
 *   6. NO SECRETS. No password hash appears in any export, asserted by scanning
 *      the bytes of every Government dataset for the live hashes.
 *   7. SCALE. Tens of thousands of rows stream out with bounded memory, which
 *      is measured and printed rather than assumed.
 */
import "dotenv/config";
import { db, pool } from "../../src/db/client";
import {
  companies,
  government,
  marketplaceOffers,
  registrationCodes,
  transactions,
  users,
} from "../../src/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";

import { transfer } from "../../src/lib/payments";
import { companyWallet, governmentWallet, userWallet } from "../../src/lib/wallets";
import {
  EMPTY_FILTERS,
  ExportError,
  companyScopeFor,
  datasetsForScope,
  exportFilename,
  exportHeaders,
  getDataset,
  parseExportFilters,
  parseFormat,
  streamExport,
  userScopeFor,
  type ExportFilters,
  type ExportScope,
} from "../../src/lib/exports";
import {
  CSV_TEXT_GUARD,
  csvCell,
  csvRow,
  looksLikeFormula,
  neutralizeFormula,
  parseCsv,
} from "../../src/lib/csv";

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

function expectThrows(label: string, fn: () => unknown, substring?: string) {
  try {
    fn();
    failed++;
    console.log(`FAIL  ${label} — expected a throw, got none`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (substring && !msg.includes(substring)) {
      failed++;
      console.log(`FAIL  ${label} — wrong error: "${msg}"`);
      return;
    }
    passed++;
    console.log(`PASS  ${label}`);
  }
}

const RUN = Date.now().toString(36).slice(-5);
const FIXTURE_PREFIX = "v3x_";
const GOV_SCOPE: ExportScope = { kind: "GOVERNMENT" };

/** Prints a section banner and how long the previous section took, so the cost
 * of the scale test is visible rather than folded into one opaque total. */
let sectionStart = Date.now();
function section(title: string) {
  const elapsed = Date.now() - sectionStart;
  sectionStart = Date.now();
  console.log(`\n=== ${title} ===   (previous section: ${elapsed}ms)\n`);
}

function filters(overrides: Partial<ExportFilters> = {}): ExportFilters {
  return { ...EMPTY_FILTERS, ...overrides };
}

/** Reads a whole export into a string. Only ever used on SMALL exports — the
 * large one is measured by `measureStream`, which never accumulates. */
async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/**
 * Drains a stream WITHOUT keeping it, sampling memory as it goes.
 *
 * This is the whole point of the scale test: if the implementation buffered
 * the export, the peak here would track the dataset size. Because it pages,
 * the peak tracks the page size instead.
 *
 * BOTH heap and RSS are sampled. Heap is the sharper signal — it is where a
 * buffered array of rows would land — but RSS is what a serverless platform
 * actually meters and kills a function for, so the bound that matters to the
 * owner is stated in the same units the platform uses.
 */
async function measureStream(stream: ReadableStream<Uint8Array>): Promise<{
  bytes: number;
  lines: number;
  peakHeapMb: number;
  baselineHeapMb: number;
  deltaMb: number;
  peakRssMb: number;
  baselineRssMb: number;
  deltaRssMb: number;
  ms: number;
}> {
  const start = process.memoryUsage();
  const baseline = start.heapUsed;
  const baselineRss = start.rss;
  let peak = baseline;
  let peakRss = baselineRss;
  let bytes = 0;
  let lines = 0;
  const started = Date.now();

  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    // Count records without keeping any of them: CRLF-terminated CSV rows.
    for (let i = 0; i < value.length; i++) if (value[i] === 0x0a) lines++;
    const usage = process.memoryUsage();
    if (usage.heapUsed > peak) peak = usage.heapUsed;
    if (usage.rss > peakRss) peakRss = usage.rss;
  }

  const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;
  return {
    bytes,
    lines,
    peakHeapMb: mb(peak),
    baselineHeapMb: mb(baseline),
    deltaMb: mb(peak - baseline),
    peakRssMb: mb(peakRss),
    baselineRssMb: mb(baselineRss),
    deltaRssMb: mb(peakRss - baselineRss),
    ms: Date.now() - started,
  };
}

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
      username: name,
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
      reason: "V3 export test fixture",
    });
  }
  const [funded] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  return funded;
}

async function makeCompany(ownerUserId: string, name: string, username: string) {
  const [company] = await db
    .insert(companies)
    .values({
      ownerUserId,
      name,
      username,
      category: "Testing",
      reason: "V3 export tests",
      description: "Fixture company for the V3 Phase J suite.",
      status: "APPROVED",
      balance: 0,
    })
    .returning();
  return company;
}

async function totals() {
  const [gov] = await db.select().from(government).limit(1);
  const [u] = await db.select({ s: sql<number>`coalesce(sum(balance),0)::int` }).from(users);
  const [c] = await db.select({ s: sql<number>`coalesce(sum(balance),0)::int` }).from(companies);
  return { treasury: gov.balance, supply: gov.totalSupply, accounted: gov.balance + u.s + c.s };
}

let baselineSupply = 0;

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
        reason: "V3 export fixture sweep",
        skipSenderCheck: true,
      });
    }
  }
  const fixtureCompanies = await db
    .select({ id: companies.id, balance: companies.balance })
    .from(companies)
    .where(sql`${companies.username} LIKE ${`${FIXTURE_PREFIX}%`}`);
  for (const row of fixtureCompanies) {
    if (row.balance > 0) {
      await transfer({
        from: companyWallet(row.id),
        to: treasury,
        amount: row.balance,
        forcedTaxRateBp: 0,
        type: "GOVERNMENT_RECEIPT",
        reason: "V3 export fixture sweep",
        skipSenderCheck: true,
        skipReceiverCheck: true,
      });
    }
  }
}

async function main() {
  const start = await totals();
  baselineSupply = start.supply;
  check(
    "INVARIANT at start: supply = treasury + users + companies",
    start.accounted === start.supply,
    start,
  );

  // A previous run of this suite that was interrupted mid-scale-test would
  // leave tens of thousands of listings behind and make every later assertion
  // slow and noisy. Clear any such leftovers before starting.
  const leftovers = await db.execute(
    sql`DELETE FROM "marketplace_offers" WHERE "company_id" IN
        (SELECT "id" FROM "companies" WHERE "username" LIKE ${`${FIXTURE_PREFIX}%`})`,
  );
  if ((leftovers.rowCount ?? 0) > 0) {
    console.log(`  cleared ${leftovers.rowCount} listings left by an interrupted run`);
  }

  // ==========================================================================
  section("1. THE CSV SERIALISER");
  // ==========================================================================

  // The six lead-ins the spec names, each of which a spreadsheet would treat
  // as the start of a formula.
  const ATTACKS = [
    "=cmd|'/c calc'!A1",
    "+1+1",
    "-1-1",
    "@SUM(1+1)*cmd",
    "\t=1+1",
    "\r=1+1",
  ];

  for (const attack of ATTACKS) {
    const rendered = csvCell(attack);
    // Strip the RFC-4180 quoting to see the cell a spreadsheet would read.
    const unquoted =
      rendered.startsWith('"') && rendered.endsWith('"')
        ? rendered.slice(1, -1).replaceAll('""', '"')
        : rendered;
    check(
      `CSV INJECTION: ${JSON.stringify(attack)} is neutralised`,
      looksLikeFormula(attack) &&
        unquoted.startsWith(CSV_TEXT_GUARD) &&
        unquoted.slice(1) === attack,
      { rendered, unquoted },
    );
  }

  check(
    "CSV INJECTION: ordinary text is NOT prefixed",
    neutralizeFormula("Alpaca scarf") === "Alpaca scarf" &&
      csvCell("Alpaca scarf") === "Alpaca scarf",
  );
  check(
    "CSV INJECTION: a NUMBER is never guarded — -500 Aeros stays -500",
    csvCell(-500) === "-500" && csvCell(0) === "0" && csvCell(12345) === "12345",
    { minus: csvCell(-500) },
  );
  check(
    "CSV INJECTION: a value already starting with ' is left alone",
    neutralizeFormula("'quoted") === "'quoted",
  );

  // Round trips.
  const TRICKY = [
    'He said "hello", then left',
    "line one\nline two",
    "line one\r\nline two",
    "comma, separated, values",
    'mixed "quotes", commas\nand a newline',
    "trailing space ",
    "",
  ];
  const roundTripRow = csvRow(TRICKY);
  const [parsedBack] = parseCsv(roundTripRow);
  check(
    "CSV ROUND TRIP: quotes, commas and newlines survive exactly",
    parsedBack.length === TRICKY.length && TRICKY.every((v, i) => parsedBack[i] === v),
    { TRICKY, parsedBack },
  );
  check(
    "CSV ROUND TRIP: a field with a comma is quoted, so columns do not shift",
    csvCell("a,b") === '"a,b"',
  );
  check(
    "CSV ROUND TRIP: an embedded double quote is doubled",
    csvCell('say "hi"') === '"say ""hi"""',
  );
  check("CSV: null and undefined become an empty field, not the text null", csvCell(null) === "" && csvCell(undefined) === "");
  check("CSV: a Date is an unambiguous ISO instant", csvCell(new Date(0)) === "1970-01-01T00:00:00.000Z");

  // ==========================================================================
  section("2. FILTER PARSING");
  // ==========================================================================

  const parsed = parseExportFilters(
    new URLSearchParams({
      from: "2026-01-01",
      to: "2026-01-31",
      type: "transfer",
      status: "paid",
      walletType: "company",
      minAmount: "10",
      maxAmount: "100",
      user: "AYUSH",
      company: "AcmeCo",
      entity: "scarf",
    }),
  );
  check(
    "FILTERS: types, statuses and names are normalised",
    parsed.type === "TRANSFER" &&
      parsed.status === "PAID" &&
      parsed.walletType === "COMPANY" &&
      parsed.user === "ayush" &&
      parsed.company === "acmeco",
    parsed,
  );
  check(
    "FILTERS: a bare date is an IST day boundary, not a UTC one",
    parsed.from?.toISOString() === "2025-12-31T18:30:00.000Z",
    parsed.from?.toISOString(),
  );
  check(
    "FILTERS: the `to` date covers the whole IST day",
    parsed.to?.toISOString() === "2026-01-31T18:29:59.999Z",
    parsed.to?.toISOString(),
  );
  const junk = parseExportFilters(
    new URLSearchParams({ minAmount: "abc", walletType: "ADMIN", from: "not-a-date" }),
  );
  check(
    "FILTERS: unparseable values become null (they can only ever narrow)",
    junk.minAmount === null && junk.walletType === null && junk.from === null,
    junk,
  );
  check("FILTERS: the default format is CSV", parseFormat(null) === "csv" && parseFormat("JSON") === "json");
  check(
    "FILTERS: the filename is stamped and carries the right extension",
    exportFilename("transactions", "csv").endsWith(".csv") &&
      exportFilename("transactions", "json").startsWith("aeros-transactions-"),
  );
  const headers = exportHeaders("transactions", "csv") as Record<string, string>;
  check(
    "HEADERS: an export is an attachment and is never cached",
    headers["content-type"].startsWith("text/csv") &&
      headers["content-disposition"].includes("attachment") &&
      headers["cache-control"].includes("no-store"),
    headers,
  );

  // ==========================================================================
  section("3. FIXTURES");
  // ==========================================================================

  const alice = await makeUser(`${FIXTURE_PREFIX}alice_${RUN}`, 500);
  const bob = await makeUser(`${FIXTURE_PREFIX}bob_${RUN}`, 500);
  const aliceCo = await makeCompany(alice.id, `Alice Co ${RUN}`, `${FIXTURE_PREFIX}aco_${RUN}`);
  const bobCo = await makeCompany(bob.id, `Bob Co ${RUN}`, `${FIXTURE_PREFIX}bco_${RUN}`);

  // A payment each way, plus one between the two companies, so "only my rows"
  // is a claim with something to be wrong about.
  const HOSTILE_REASON = '=cmd|\'/c calc\'!A1, and "quoted"\nsecond line';
  await transfer({
    from: userWallet(alice.id),
    to: userWallet(bob.id),
    amount: 100,
    forcedTaxRateBp: 0,
    type: "TRANSFER",
    reason: HOSTILE_REASON,
  });
  await transfer({
    from: userWallet(bob.id),
    to: userWallet(alice.id),
    amount: 40,
    forcedTaxRateBp: 0,
    type: "TRANSFER",
    reason: `plain reason ${RUN}`,
  });
  // A transfer neither Alice nor her company is party to.
  const carol = await makeUser(`${FIXTURE_PREFIX}carol_${RUN}`, 200);
  await transfer({
    from: userWallet(carol.id),
    to: userWallet(bob.id),
    amount: 25,
    forcedTaxRateBp: 0,
    type: "TRANSFER",
    reason: `carol to bob ${RUN}`,
  });

  check("FIXTURES: three users and two companies", !!alice.id && !!bobCo.id && !!carol.id);

  // ==========================================================================
  section("4. EVERY GOVERNMENT DATASET, BOTH FORMATS");
  // ==========================================================================

  const govDatasets = datasetsForScope("GOVERNMENT");
  check("GOV DATASETS: all sixteen documented sets are present", govDatasets.length === 16, govDatasets.length);

  // The live secrets, so "no export contains them" is checked against the real
  // values rather than against a pattern that might not match them.
  const [aliceRow] = await db.select().from(users).where(eq(users.id, alice.id));
  const [govRow] = await db.select().from(government).limit(1);
  const leaked: string[] = [];
  let scannedDatasets = 0;

  /** Scans an export's bytes for anything that must never be in one. */
  const scanForSecrets = (label: string, text: string) => {
    scannedDatasets++;
    if (text.includes(aliceRow.passwordHash)) leaked.push(`${label}: user hash`);
    if (text.includes(govRow.passwordHash)) leaked.push(`${label}: gov hash`);
    if (text.includes(govRow.securityCodeHash)) leaked.push(`${label}: gov security code`);
    // bcrypt's own marker, in case a hash ever arrives via some other column.
    if (/\$2[aby]\$\d\d\$/.test(text)) leaked.push(`${label}: a bcrypt hash`);
  };

  for (const dataset of govDatasets) {
    const csv = await collect(
      streamExport(dataset, GOV_SCOPE, filters(), "csv", { pageSize: 200 }),
    );
    scanForSecrets(`${dataset.key}/csv`, csv);
    const rows = parseCsv(csv);
    const headerOk =
      rows.length > 0 &&
      rows[0].length === dataset.columns.length &&
      dataset.columns.every((c, i) => rows[0][i] === c);
    const widthOk = rows.slice(1).every((r) => r.length === dataset.columns.length);
    check(
      `CSV: "${dataset.key}" has the declared header and a consistent width`,
      headerOk && widthOk,
      { header: rows[0], columns: dataset.columns },
    );

    const jsonText = await collect(
      streamExport(dataset, GOV_SCOPE, filters(), "json", { pageSize: 200 }),
    );
    scanForSecrets(`${dataset.key}/json`, jsonText);
    let json: { dataset: string; rows: unknown[]; rowCount: number; columns: string[] } | null = null;
    try {
      json = JSON.parse(jsonText);
    } catch {
      json = null;
    }
    check(
      `JSON: "${dataset.key}" is valid JSON with a row count that matches`,
      !!json &&
        json.dataset === dataset.key &&
        Array.isArray(json.rows) &&
        json.rows.length === json.rowCount &&
        json.rows.length === rows.length - 1,
      { csvRows: rows.length - 1, jsonRows: json?.rows.length },
    );
  }

  // ==========================================================================
  section("5. FILTERS ACTUALLY FILTER");
  // ==========================================================================

  const txDataset = getDataset("transactions", "GOVERNMENT");

  async function govRows(f: Partial<ExportFilters>): Promise<string[][]> {
    const text = await collect(streamExport(txDataset, GOV_SCOPE, filters(f), "csv", { pageSize: 100 }));
    return parseCsv(text).slice(1);
  }

  const aliceNamed = await govRows({ user: alice.username });
  const senderCol = txDataset.columns.indexOf("senderUsername");
  const receiverCol = txDataset.columns.indexOf("receiverUsername");
  check(
    "FILTER user=: every row involves that user",
    aliceNamed.length > 0 &&
      aliceNamed.every(
        (r) => r[senderCol] === alice.username || r[receiverCol] === alice.username,
      ),
    aliceNamed.length,
  );

  const nobody = await govRows({ user: `${FIXTURE_PREFIX}nobody_${RUN}` });
  check(
    "FILTER user=: a name that matches nothing returns NOTHING, not everything",
    nobody.length === 0,
    nobody.length,
  );

  const futureOnly = await govRows({ from: new Date(Date.now() + 86_400_000) });
  check("FILTER from=: a future date range is empty", futureOnly.length === 0);

  const amountCol = txDataset.columns.indexOf("grossAmount");
  const banded = await govRows({ user: alice.username, minAmount: 50, maxAmount: 150 });
  check(
    "FILTER amount range: every row is inside the band",
    banded.length > 0 && banded.every((r) => Number(r[amountCol]) >= 50 && Number(r[amountCol]) <= 150),
    banded.map((r) => r[amountCol]),
  );

  const typeCol = txDataset.columns.indexOf("type");
  const funding = await govRows({ type: "GOVERNMENT_FUNDING", user: alice.username });
  check(
    "FILTER type=: only that transaction type comes back",
    funding.length > 0 && funding.every((r) => r[typeCol] === "GOVERNMENT_FUNDING"),
    funding.length,
  );
  const bogusType = await govRows({ type: "NOT_A_REAL_TYPE" });
  check("FILTER type=: an unknown type is empty, not an error", bogusType.length === 0);

  const walletFiltered = await govRows({ walletType: "GOVERNMENT", user: alice.username });
  const senderTypeCol = txDataset.columns.indexOf("senderType");
  const receiverTypeCol = txDataset.columns.indexOf("receiverType");
  check(
    "FILTER walletType=: every row has that wallet type on one side",
    walletFiltered.length > 0 &&
      walletFiltered.every(
        (r) => r[senderTypeCol] === "GOVERNMENT" || r[receiverTypeCol] === "GOVERNMENT",
      ),
  );

  const usersDataset = getDataset("users", "GOVERNMENT");
  const usersCsv = await collect(
    streamExport(usersDataset, GOV_SCOPE, filters({ user: alice.username }), "csv", { pageSize: 50 }),
  );
  const usersRows = parseCsv(usersCsv).slice(1);
  check(
    "FILTER user= on the users dataset returns exactly that user",
    usersRows.length === 1 && usersRows[usersDataset.columns.indexOf("username") === 1 ? 0 : 0][1] === alice.username,
    usersRows,
  );

  const offersDataset = getDataset("marketplace", "GOVERNMENT");
  const statusFiltered = await collect(
    streamExport(offersDataset, GOV_SCOPE, filters({ status: "ACTIVE" }), "csv", { pageSize: 200 }),
  );
  const statusCol = offersDataset.columns.indexOf("status");
  const statusRows = parseCsv(statusFiltered).slice(1);
  check(
    "FILTER status=: only ACTIVE listings come back",
    statusRows.every((r) => r[statusCol] === "ACTIVE"),
  );

  // ==========================================================================
  section("6. SCOPE: ONLY YOUR OWN DATA");
  // ==========================================================================

  const aliceScope = userScopeFor(alice);
  const bobScope = userScopeFor(bob);

  const aliceTxDataset = getDataset("transactions", "USER");
  const aliceCsv = await collect(
    streamExport(aliceTxDataset, aliceScope, filters(), "csv", { pageSize: 100 }),
  );
  const aliceRows = parseCsv(aliceCsv).slice(1);
  check(
    "USER SCOPE: every exported row involves Alice",
    aliceRows.length > 0 &&
      aliceRows.every((r) => r[senderCol] === alice.username || r[receiverCol] === alice.username),
    aliceRows.length,
  );
  check(
    "USER SCOPE: Carol's payment to Bob is absent from Alice's export",
    !aliceCsv.includes(`carol to bob ${RUN}`),
  );
  check("USER SCOPE: Carol's username never appears at all", !aliceCsv.includes(carol.username));

  // The one attack a caller can actually mount through this interface: send a
  // filter naming somebody else. The USER branch never consults it.
  const aliceTryingBob = await collect(
    streamExport(aliceTxDataset, aliceScope, filters({ user: bob.username }), "csv", {
      pageSize: 100,
    }),
  );
  const aliceTryingBobRows = parseCsv(aliceTryingBob).slice(1);
  check(
    "CROSS-TENANT: a `user=` filter cannot widen a personal export",
    aliceTryingBobRows.every(
      (r) => r[senderCol] === alice.username || r[receiverCol] === alice.username,
    ) && !aliceTryingBob.includes(`carol to bob ${RUN}`),
  );
  check(
    "CROSS-TENANT: Bob's export and Alice's export are different",
    (await collect(streamExport(aliceTxDataset, bobScope, filters(), "csv", { pageSize: 100 }))) !==
      aliceCsv,
  );

  // Company scope, and the ownership gate.
  const aliceCompanyScope = companyScopeFor(alice, aliceCo);
  check(
    "COMPANY SCOPE: an owner gets a scope for their own company",
    aliceCompanyScope.kind === "COMPANY" && aliceCompanyScope.username === aliceCo.username,
  );
  expectThrows(
    "CROSS-TENANT: Alice cannot build a scope for Bob's company",
    () => companyScopeFor(alice, bobCo),
    "company you own",
  );
  expectThrows(
    "CROSS-TENANT: Bob cannot build a scope for Alice's company",
    () => companyScopeFor(bob, aliceCo),
    "company you own",
  );
  expectThrows(
    "COMPANY SCOPE: no active company wallet means no company export",
    () => companyScopeFor(alice, null),
    "Switch to a company wallet",
  );

  // Dataset visibility is part of the LOOKUP, not an afterthought.
  expectThrows(
    "SCOPE: a user cannot open the Government `users` dataset",
    () => getDataset("users", "USER"),
    "Unknown export",
  );
  expectThrows(
    "SCOPE: a user cannot open the audit log",
    () => getDataset("audit", "USER"),
    "Unknown export",
  );
  expectThrows(
    "SCOPE: a company cannot open the audit log",
    () => getDataset("audit", "COMPANY"),
    "Unknown export",
  );
  expectThrows(
    "SCOPE: a user cannot open treasury movements",
    () => getDataset("treasury", "USER"),
    "Unknown export",
  );
  expectThrows(
    "SCOPE: an unknown dataset name is refused",
    () => getDataset("everything", "GOVERNMENT"),
    "Unknown export",
  );
  check(
    "SCOPE: a user sees only the three personal datasets",
    datasetsForScope("USER")
      .map((d) => d.key)
      .sort()
      .join(",") === "invoices,orders,transactions",
    datasetsForScope("USER").map((d) => d.key),
  );

  // Company transactions: only the company's own wallet.
  await transfer({
    from: userWallet(alice.id),
    to: companyWallet(aliceCo.id),
    amount: 60,
    forcedTaxRateBp: 0,
    type: "COMPANY_SALE",
    reason: `alice pays her company ${RUN}`,
  });
  await transfer({
    from: userWallet(bob.id),
    to: companyWallet(bobCo.id),
    amount: 60,
    forcedTaxRateBp: 0,
    type: "COMPANY_SALE",
    reason: `bob pays his company ${RUN}`,
  });

  const companyTxDataset = getDataset("transactions", "COMPANY");
  const aliceCoCsv = await collect(
    streamExport(companyTxDataset, aliceCompanyScope, filters(), "csv", { pageSize: 100 }),
  );
  check(
    "COMPANY SCOPE: the company's own payment is present",
    aliceCoCsv.includes(`alice pays her company ${RUN}`),
  );
  check(
    "COMPANY SCOPE: the other company's payment is absent",
    !aliceCoCsv.includes(`bob pays his company ${RUN}`) && !aliceCoCsv.includes(bobCo.username),
  );

  // ==========================================================================
  section("7. NO SECRETS IN ANY EXPORT");
  // ==========================================================================

  // The scan itself happened in section 4, over the bytes of every Government
  // dataset in both formats — there is no point re-generating them here.
  check(
    `NO SECRETS: scanned ${scannedDatasets} exports and found no password or security-code hash`,
    leaked.length === 0 && scannedDatasets === govDatasets.length * 2,
    { leaked, scannedDatasets },
  );
  check(
    "NO SECRETS: the users dataset does not even declare a password column",
    !usersDataset.columns.some((c) => /password|hash|secret|token/i.test(c)),
    usersDataset.columns,
  );
  check(
    "NO SECRETS: the `government` table is not an exportable dataset at all",
    !govDatasets.some((d) => d.key === "government"),
  );

  // ==========================================================================
  section("8. HOSTILE TEXT SURVIVES THE ROUND TRIP, DEFANGED");
  // ==========================================================================

  const hostileCsv = await collect(
    streamExport(txDataset, GOV_SCOPE, filters({ user: alice.username }), "csv", { pageSize: 100 }),
  );
  const reasonCol = txDataset.columns.indexOf("reason");
  const hostileRows = parseCsv(hostileCsv).slice(1);
  const hostileCell = hostileRows.map((r) => r[reasonCol]).find((v) => v.includes("cmd|"));
  check(
    "END TO END: the hostile reason is in the export, prefixed so it cannot execute",
    hostileCell === `${CSV_TEXT_GUARD}${HOSTILE_REASON}`,
    hostileCell,
  );
  check(
    "END TO END: its embedded quotes and newline round-tripped exactly",
    hostileCell?.slice(1) === HOSTILE_REASON,
  );
  check(
    "END TO END: the CSV did not gain a column from the embedded comma",
    hostileRows.every((r) => r.length === txDataset.columns.length),
  );

  const hostileJson = await collect(
    streamExport(txDataset, GOV_SCOPE, filters({ user: alice.username }), "json", { pageSize: 100 }),
  );
  const jsonParsed = JSON.parse(hostileJson) as { rows: Array<{ reason: string | null }> };
  const rawReason = jsonParsed.rows.map((r) => r.reason).find((v) => v?.includes("cmd|"));
  check(
    "END TO END: the JSON export keeps the RAW value (it is not a spreadsheet)",
    rawReason === HOSTILE_REASON,
    rawReason,
  );

  // ==========================================================================
  section("9. SCALE: TENS OF THOUSANDS OF ROWS, BOUNDED MEMORY");
  // ==========================================================================

  const BIG = 30_000;
  const bigOwner = await makeUser(`${FIXTURE_PREFIX}big_${RUN}`, 0);
  const bigCo = await makeCompany(bigOwner.id, `Big Co ${RUN}`, `${FIXTURE_PREFIX}big_${RUN}`);

  console.log(`  seeding ${BIG.toLocaleString()} rows…`);
  const seedStart = Date.now();
  for (let batch = 0; batch < BIG / 1000; batch++) {
    await db.insert(marketplaceOffers).values(
      Array.from({ length: 1000 }, (_, i) => {
        const n = batch * 1000 + i;
        return {
          companyId: bigCo.id,
          // Deliberately hostile and comma-laden, so the scale test is also a
          // scale test of the escaping.
          title: `=SCALE ${RUN} #${n}, "big"`,
          description: `row ${n} of the scale fixture`,
          category: "Testing",
          unitPrice: (n % 900) + 1,
          quantityAvailable: 5,
          status: "ACTIVE" as const,
        };
      }),
    );
  }
  console.log(`  seeded in ${Date.now() - seedStart}ms`);

  const bigMeasure = await measureStream(
    streamExport(offersDataset, GOV_SCOPE, filters({ company: bigCo.username }), "csv"),
  );
  console.log(
    `  streamed ${(bigMeasure.bytes / 1024 / 1024).toFixed(1)}MB in ${bigMeasure.ms}ms; ` +
      `heap baseline ${bigMeasure.baselineHeapMb}MB, peak ${bigMeasure.peakHeapMb}MB ` +
      `(delta ${bigMeasure.deltaMb}MB); ` +
      `RSS baseline ${bigMeasure.baselineRssMb}MB, peak ${bigMeasure.peakRssMb}MB ` +
      `(delta ${bigMeasure.deltaRssMb}MB)`,
  );

  check(
    `SCALE: all ${BIG.toLocaleString()} rows streamed out`,
    // No seeded field contains a newline, so one CSV record is one line and the
    // stream carries exactly the header plus BIG records.
    bigMeasure.bytes > 1_000_000 && bigMeasure.lines === BIG + 1,
    { bytes: bigMeasure.bytes, lines: bigMeasure.lines },
  );
  check(
    "SCALE: peak heap growth stayed bounded (one page, not one table)",
    bigMeasure.deltaMb < 128,
    { deltaMb: bigMeasure.deltaMb },
  );
  check(
    // RSS is what the platform meters. A buffering implementation would grow
    // this by roughly the size of the response; a paging one does not.
    "SCALE: peak RSS growth stayed bounded (the units the platform kills on)",
    bigMeasure.deltaRssMb < 128,
    { deltaRssMb: bigMeasure.deltaRssMb, peakRssMb: bigMeasure.peakRssMb },
  );
  check(
    "SCALE: it finished well inside a serverless function timeout",
    bigMeasure.ms < 60_000,
    { ms: bigMeasure.ms },
  );

  // Correctness at scale: keyset paging must not skip or repeat a row.
  const bigJson = await collect(
    streamExport(offersDataset, GOV_SCOPE, filters({ company: bigCo.username }), "json", {
      pageSize: 1000,
    }),
  );
  const bigParsed = JSON.parse(bigJson) as { rows: Array<{ id: string; title: string }>; rowCount: number };
  const uniqueIds = new Set(bigParsed.rows.map((r) => r.id));
  check(
    "SCALE: keyset pagination returned every row exactly once",
    bigParsed.rowCount === BIG && uniqueIds.size === BIG,
    { rowCount: bigParsed.rowCount, unique: uniqueIds.size },
  );
  check(
    "SCALE: a filtered large export contains nothing from another company",
    bigParsed.rows.every((r) => r.title.includes(RUN)),
  );

  // And the escaping held up across all 30,000 rows — checked by validating
  // each record as it arrives, never by holding the file. A carry buffer joins
  // whatever a chunk boundary split in half.
  const titleCol = offersDataset.columns.indexOf("title");
  let validated = 0;
  let badWidth = 0;
  let unguarded = 0;
  {
    const reader = streamExport(
      offersDataset,
      GOV_SCOPE,
      filters({ company: bigCo.username }),
      "csv",
      { pageSize: 500 },
    ).getReader();
    const decoder = new TextDecoder();
    let carry = "";
    let sawHeader = false;
    const handleLine = (line: string) => {
      if (line === "") return;
      if (!sawHeader) {
        sawHeader = true;
        return;
      }
      const [record] = parseCsv(line);
      if (!record || record.length !== offersDataset.columns.length) badWidth++;
      else if (!record[titleCol].startsWith(CSV_TEXT_GUARD)) unguarded++;
      validated++;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = carry.indexOf("\r\n")) !== -1) {
        handleLine(carry.slice(0, nl));
        carry = carry.slice(nl + 2);
      }
    }
    handleLine(carry + decoder.decode());
  }
  check(
    `SCALE: every one of the ${BIG.toLocaleString()} CSV records has the right column count`,
    validated === BIG && badWidth === 0,
    { validated, badWidth },
  );
  check(
    "SCALE: every hostile title is still neutralised at row 30,000",
    unguarded === 0,
    { unguarded },
  );

  // ==========================================================================
  section("10. EMPTY EXPORTS ARE STILL WELL-FORMED");
  // ==========================================================================

  const emptyCsv = await collect(
    streamExport(txDataset, GOV_SCOPE, filters({ user: `${FIXTURE_PREFIX}ghost_${RUN}` }), "csv"),
  );
  const emptyRows = parseCsv(emptyCsv);
  check(
    "EMPTY: a CSV with no rows is still a header row",
    emptyRows.length === 1 && emptyRows[0].length === txDataset.columns.length,
    emptyRows,
  );
  const emptyJson = JSON.parse(
    await collect(
      streamExport(txDataset, GOV_SCOPE, filters({ user: `${FIXTURE_PREFIX}ghost_${RUN}` }), "json"),
    ),
  ) as { rows: unknown[]; rowCount: number };
  check(
    "EMPTY: a JSON export with no rows is still valid JSON",
    Array.isArray(emptyJson.rows) && emptyJson.rows.length === 0 && emptyJson.rowCount === 0,
  );

  // ==========================================================================
  section("11. EXPORTING STORES NOTHING");
  // ==========================================================================

  const { rows: tableRows } = await db.execute(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const countAll = async () => {
    const out: Record<string, number> = {};
    for (const r of tableRows as Array<{ tablename: string }>) {
      const res = await db.execute(sql`SELECT count(*)::int AS c FROM ${sql.identifier(r.tablename)}`);
      out[r.tablename] = Number((res.rows[0] as { c: number }).c);
    }
    return out;
  };
  const beforeExport = await countAll();
  for (const dataset of datasetsForScope("GOVERNMENT").slice(0, 6)) {
    await collect(streamExport(dataset, GOV_SCOPE, filters(), "csv", { pageSize: 100 }));
  }
  const afterExport = await countAll();
  const changed = Object.keys(beforeExport).filter((t) => beforeExport[t] !== afterExport[t]);
  check(
    "NO STORAGE: generating exports wrote no row to any table",
    changed.length === 0,
    changed,
  );
  check(
    "NO STORAGE: there is no exports table in the schema",
    !Object.keys(beforeExport).some((t) => /export/i.test(t)),
  );

  // ==========================================================================
  section("CLEANUP");
  // ==========================================================================

  await db.execute(sql`DELETE FROM "marketplace_offers" WHERE "company_id" = ${bigCo.id}::uuid`);

  await sweepFixtures();
  const end = await totals();
  check(
    "CLEANUP: sweeping fixtures back to the treasury preserves the invariant",
    end.accounted === end.supply && end.supply === baselineSupply,
    end,
  );

  await db
    .update(companies)
    .set({ status: "REVOKED", revokedAt: new Date(), revokeReason: "V3 export test cleanup" })
    .where(inArray(companies.id, [aliceCo.id, bobCo.id, bigCo.id]));

  const txLeft = await db.select({ c: sql<number>`count(*)::int` }).from(transactions);
  console.log(`  ledger rows in the database: ${txLeft[0].c}`);

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
