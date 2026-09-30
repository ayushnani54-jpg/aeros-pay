/**
 * V3 PHASE B — UNIVERSAL INVOICES, ANTI-TAX-ROUTING, PAYMENT HARDENING
 *
 * Runs against a real Postgres database. Areas:
 *
 *   1. RECIPIENT RESOLUTION — user / company / Government, resolved server-side
 *      from a username plus an explicit type; a Government invoice resolves to
 *      the Treasury even when a real user's handle is passed alongside it.
 *   2. END-TO-END PAYMENT — each of the three recipient types is invoiced and
 *      paid, with the exact wallet movements checked (the buyer pays the
 *      quoted price; the tax comes out of the company's proceeds). Invoices
 *      issued under the older add-on rule are still paid as quoted.
 *   3. TAX SNAPSHOT IMMUTABILITY — the matrix is changed AFTER issue and the
 *      invoice's amounts, and the resulting payment, are unchanged.
 *   4. ANTI-TAX-ROUTING — every route a caller could take to make a company
 *      invoice settle to the owner's personal wallet is attempted and refused.
 *   5. IDEMPOTENCY + CONCURRENCY — a duplicate returns the first receipt with no
 *      second ledger event; two concurrent payments leave exactly one winner.
 *   6. REJECTIONS — insufficient funds, cancelled, expired, self-invoice,
 *      suspended/banned parties, wrong payer.
 *   7. READ PATHS — all three recipient types are readable and listable.
 *
 * The supply invariant (total supply = treasury + Σusers + Σcompanies) is
 * re-checked after every operation.
 */
import "dotenv/config";
import { db, pool } from "../../src/db/client";
import {
  companies,
  government,
  invoices,
  registrationCodes,
  transactions,
  users,
} from "../../src/db/schema";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { transfer, transferInTx, PaymentError } from "../../src/lib/payments";
import {
  companyWallet,
  governmentWallet,
  userWallet,
  type WalletRef,
} from "../../src/lib/wallets";
import {
  createInvoice,
  payInvoice,
  cancelInvoice,
  getInvoiceById,
  getSentInvoicesForCompany,
  getReceivedInvoicesForWallet,
  getPendingInvoiceCountForWallet,
  invoiceViewerRole,
  invoicePayerWallet,
  resolveInvoiceRecipient,
  InvoiceError,
} from "../../src/lib/invoices";
import {
  deriveCompanySettlement,
  deriveInvoiceSettlement,
  assertSettlementDestination,
  SettlementRoutingError,
} from "../../src/lib/settlement";
import { setTaxMatrixRate, clearTaxMatrixRate } from "../../src/lib/taxmatrix";

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
  return { treasury: gov.balance, supply: gov.totalSupply, accounted: gov.balance + u.s + c.s };
}

let baselineSupply = 0;

/** Re-checks the supply invariant after an operation. */
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
async function balanceOfCompany(id: string): Promise<number> {
  const [row] = await db.select({ b: companies.balance }).from(companies).where(eq(companies.id, id));
  return row.b;
}
async function treasuryBalance(): Promise<number> {
  const [row] = await db.select({ b: government.balance }).from(government).limit(1);
  return row.b;
}
async function ledgerRowsFor(invoiceId: string) {
  return db.select().from(transactions).where(eq(transactions.invoiceId, invoiceId));
}
async function invoiceRow(id: string) {
  const [row] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  return row;
}

const RUN = Date.now().toString(36).slice(-5);
const FIXTURE_PREFIX = "v3i_";

/**
 * Sweeps every fixture balance back into the treasury with real transfers.
 *
 * Run at the start (to reclaim anything a previous aborted run left behind) and
 * at the end, so the suite is repeatable and never quietly drains the treasury.
 * Real transfers, never balance writes: the supply invariant stays true.
 */
async function sweepFixtureBalances(): Promise<void> {
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
        reason: "V3 invoice fixture sweep",
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
        reason: "V3 invoice fixture sweep",
        skipSenderCheck: true,
      });
    }
  }
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

  // Funded with a real treasury transfer, never by writing a balance — writing
  // one would mint Aeros the supply does not know about.
  if (balance > 0) {
    const [g] = await db.select({ id: government.id }).from(government).limit(1);
    await transfer({
      from: governmentWallet(g.id),
      to: userWallet(user.id),
      amount: balance,
      forcedTaxRateBp: 0,
      type: "GOVERNMENT_FUNDING",
      reason: "V3 invoice test fixture",
    });
  }

  const [funded] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  return funded;
}

async function makeCompany(params: {
  ownerUserId: string;
  name: string;
  username: string;
  balance: number;
  status?: "APPROVED" | "SUSPENDED" | "REVOKED" | "PENDING";
}) {
  const [company] = await db
    .insert(companies)
    .values({
      ownerUserId: params.ownerUserId,
      name: params.name,
      username: params.username,
      category: "Testing",
      reason: "V3 invoice tests",
      description: "Fixture company for the V3 Phase B invoice suite.",
      status: params.status ?? "APPROVED",
      balance: 0,
    })
    .returning();

  if (params.balance > 0) {
    const [g] = await db.select({ id: government.id }).from(government).limit(1);
    await transfer({
      from: governmentWallet(g.id),
      to: companyWallet(company.id),
      amount: params.balance,
      forcedTaxRateBp: 0,
      type: "COMPANY_FUNDING",
      reason: "V3 invoice test fixture",
      skipReceiverCheck: true,
    });
  }

  const [funded] = await db.select().from(companies).where(eq(companies.id, company.id)).limit(1);
  return funded;
}

async function main() {
  const [gov] = await db.select().from(government).limit(1);
  if (!gov) {
    console.log("FAIL  fixtures — this suite needs the government row");
    process.exit(1);
  }

  const start = await totals();
  baselineSupply = start.supply;
  check("fixtures: supply invariant holds before anything runs", start.accounted === start.supply, start);

  console.log("\n=== FIXTURES ===\n");

  // Reclaim anything an earlier run of this suite left in fixture wallets, so
  // the treasury can fund this run and the suite stays repeatable.
  await sweepFixtureBalances();

  const issuerOwner = await makeUser(`v3i_own_${RUN}`, 500);
  const payerUser = await makeUser(`v3i_pay_${RUN}`, 4000);
  const otherUser = await makeUser(`v3i_oth_${RUN}`, 300);
  const coOwner = await makeUser(`v3i_cown_${RUN}`, 200);
  const suspUser = await makeUser(`v3i_susp_${RUN}`, 500);
  const bannedUser = await makeUser(`v3i_ban_${RUN}`, 100);

  const issuer = await makeCompany({
    ownerUserId: issuerOwner.id,
    name: `Issuer Co ${RUN}`,
    username: `v3i_iss_${RUN}`,
    balance: 200,
  });
  const payerCompany = await makeCompany({
    ownerUserId: coOwner.id,
    name: `Payer Co ${RUN}`,
    username: `v3i_pco_${RUN}`,
    balance: 3000,
  });
  const suspendedCo = await makeCompany({
    ownerUserId: otherUser.id,
    name: `Suspended Co ${RUN}`,
    username: `v3i_sus_${RUN}`,
    balance: 0,
    status: "SUSPENDED",
  });
  const revokedCo = await makeCompany({
    ownerUserId: otherUser.id,
    name: `Revoked Co ${RUN}`,
    username: `v3i_rev_${RUN}`,
    balance: 0,
    status: "REVOKED",
  });

  await db.update(users).set({ status: "BANNED" }).where(eq(users.id, bannedUser.id));
  await db.update(users).set({ status: "SUSPENDED" }).where(eq(users.id, suspUser.id));

  await invariant("fixture setup");

  // ==========================================================================
  console.log("\n=== 1. RECIPIENT RESOLUTION IS SERVER-SIDE AND TYPED ===\n");
  // ==========================================================================

  const rUser = await resolveInvoiceRecipient(db, {
    recipientType: "USER",
    username: payerUser.username,
  });
  check(
    "resolve USER: returns that user's personal wallet",
    rUser.type === "USER" && rUser.wallet.kind === "USER" && rUser.wallet.id === payerUser.id,
    rUser,
  );

  const rCompany = await resolveInvoiceRecipient(db, {
    recipientType: "COMPANY",
    username: payerCompany.username,
  });
  check(
    "resolve COMPANY: returns the company wallet, not its owner's",
    rCompany.type === "COMPANY" &&
      rCompany.wallet.kind === "COMPANY" &&
      rCompany.wallet.id === payerCompany.id &&
      rCompany.wallet.id !== coOwner.id,
    rCompany,
  );

  // The important one: the GOVERNMENT branch ignores the username entirely, so
  // a Government official's personal handle cannot become the recipient of a
  // Government invoice.
  const rGovWithUserHandle = await resolveInvoiceRecipient(db, {
    recipientType: "GOVERNMENT",
    username: payerUser.username,
  });
  check(
    "resolve GOVERNMENT: resolves the Treasury even when a real user's handle is passed",
    rGovWithUserHandle.type === "GOVERNMENT" &&
      rGovWithUserHandle.wallet.kind === "GOVERNMENT" &&
      rGovWithUserHandle.wallet.id === gov.id &&
      rGovWithUserHandle.userId === null &&
      rGovWithUserHandle.companyId === null,
    rGovWithUserHandle,
  );

  await expectError(
    "resolve: nonexistent user handle is rejected",
    () => resolveInvoiceRecipient(db, { recipientType: "USER", username: `nope_${RUN}` }),
    "No user found",
  );
  await expectError(
    "resolve: a user's handle is not accepted as a COMPANY recipient",
    () => resolveInvoiceRecipient(db, { recipientType: "COMPANY", username: payerUser.username }),
    "No company found",
  );
  await expectError(
    "resolve: a banned user cannot be invoiced",
    () => resolveInvoiceRecipient(db, { recipientType: "USER", username: bannedUser.username }),
    "cannot be invoiced",
  );
  await expectError(
    "resolve: a revoked company cannot be invoiced",
    () => resolveInvoiceRecipient(db, { recipientType: "COMPANY", username: revokedCo.username }),
    "cannot be invoiced",
  );
  await expectError(
    "resolve: an unknown recipient type is rejected rather than defaulted",
    () =>
      resolveInvoiceRecipient(db, {
        recipientType: "TREASURY" as unknown as "USER",
        username: payerUser.username,
      }),
    "Choose who this invoice is for",
  );

  // ==========================================================================
  console.log("\n=== 2. INVOICE TO A USER, PAID END TO END ===\n");
  // ==========================================================================

  const invUser = await createInvoice({
    company: issuer,
    recipientType: "USER",
    recipientUsername: payerUser.username,
    itemName: "Cotton Shirt",
    description: "Two shirts, cotton",
    quantity: 2,
    unitPrice: 400,
    note: "Thanks for your order",
  });
  check(
    "user invoice: price 800, 5% tax = 40 TAKEN FROM THE COMPANY, total payable 800 (no tax on top)",
    invUser.subtotal === 800 &&
      invUser.taxRateBp === 500 &&
      invUser.taxAmount === 40 &&
      invUser.total === 800,
    invUser,
  );
  check(
    "user invoice: recipient columns are consistent with recipientType",
    invUser.recipientType === "USER" &&
      invUser.buyerUserId === payerUser.id &&
      invUser.recipientCompanyId === null,
    invUser,
  );
  await invariant("creating a user invoice");

  const payerBefore = await balanceOfUser(payerUser.id);
  const issuerBefore = await balanceOfCompany(issuer.id);
  const ownerBefore = await balanceOfUser(issuerOwner.id);
  const treasuryBefore = await treasuryBalance();

  const receipt = await payInvoice({ invoiceId: invUser.id, payer: userWallet(payerUser.id) });

  check("user invoice: receipt carries a real transaction reference", !!receipt.txRef, receipt.txRef);
  check("user invoice: marked PAID only after the transfer", receipt.invoice.status === "PAID");
  check(
    "user invoice: payer debited exactly the quoted price (800)",
    (await balanceOfUser(payerUser.id)) === payerBefore - 800,
  );
  check(
    "user invoice: ISSUING COMPANY credited the price minus tax (760)",
    (await balanceOfCompany(issuer.id)) === issuerBefore + 760,
  );
  check(
    "user invoice: the owner's PERSONAL wallet received nothing",
    (await balanceOfUser(issuerOwner.id)) === ownerBefore,
  );
  check(
    "user invoice: treasury received the tax (40)",
    (await treasuryBalance()) === treasuryBefore + 40,
  );
  const userLedger = await ledgerRowsFor(invUser.id);
  check(
    "user invoice: exactly one ledger row, gross=total tax=snapshot net=total-tax",
    userLedger.length === 1 &&
      userLedger[0].grossAmount === 800 &&
      userLedger[0].taxAmount === 40 &&
      userLedger[0].netAmount === 760 &&
      userLedger[0].receiverType === "COMPANY" &&
      userLedger[0].receiverId === issuer.id,
    userLedger,
  );
  check(
    "user invoice: the invoice is linked to its transaction in both directions",
    userLedger[0].txRef === receipt.txRef && receipt.invoice.paidTxRef === receipt.txRef,
  );
  await invariant("paying a user invoice");

  // ==========================================================================
  console.log("\n=== 2b. OLD ADD-ON INVOICES ARE STILL PAYABLE, EXACTLY AS QUOTED ===\n");
  // ==========================================================================
  // Before the "company pays the tax" rule an invoice was total = subtotal + tax.
  // A pending one of those may still exist in the live database.

  // These extra payments must not eat the balance the later sections rely on.
  await transfer({
    from: governmentWallet(gov.id),
    to: userWallet(payerUser.id),
    amount: 2000,
    forcedTaxRateBp: 0,
    type: "GOVERNMENT_FUNDING",
    reason: "test top-up for the legacy/example invoices",
  });

  const [legacy] = await db
    .insert(invoices)
    .values({
      invoiceNumber: `INV-LEGACY-${Date.now()}`,
      companyId: issuer.id,
      recipientType: "USER",
      buyerUserId: payerUser.id,
      itemName: "Old add-on invoice",
      quantity: 1,
      unitPrice: 800,
      subtotal: 800,
      taxRateBp: 500,
      taxAmount: 40,
      total: 840,
    })
    .returning();
  const legPayerBefore = await balanceOfUser(payerUser.id);
  const legIssuerBefore = await balanceOfCompany(issuer.id);
  const legTreasuryBefore = await treasuryBalance();
  const legReceipt = await payInvoice({ invoiceId: legacy.id, payer: userWallet(payerUser.id) });
  check("legacy invoice: still payable", legReceipt.invoice.status === "PAID" && !!legReceipt.txRef);
  check(
    "legacy invoice: payer pays 840 as quoted, company receives the full 800, treasury 40",
    (await balanceOfUser(payerUser.id)) === legPayerBefore - 840 &&
      (await balanceOfCompany(issuer.id)) === legIssuerBefore + 800 &&
      (await treasuryBalance()) === legTreasuryBefore + 40,
  );
  const legLedger = await ledgerRowsFor(legacy.id);
  check(
    "legacy invoice: ledger row gross 840 = tax 40 + net 800",
    legLedger.length === 1 &&
      legLedger[0].grossAmount === 840 &&
      legLedger[0].taxAmount === 40 &&
      legLedger[0].netAmount === 800,
    legLedger,
  );
  await invariant("paying a legacy add-on invoice");

  // An invoice whose numbers fit neither shape is still refused.
  const [broken] = await db
    .insert(invoices)
    .values({
      invoiceNumber: `INV-BROKEN-${Date.now()}`,
      companyId: issuer.id,
      recipientType: "USER",
      buyerUserId: payerUser.id,
      itemName: "Inconsistent invoice",
      quantity: 1,
      unitPrice: 800,
      subtotal: 800,
      taxRateBp: 500,
      taxAmount: 40,
      total: 999,
    })
    .returning();
  await expectError(
    "legacy invoice: an inconsistent invoice (total fits neither rule) cannot be paid",
    () => payInvoice({ invoiceId: broken.id, payer: userWallet(payerUser.id) }),
    "inconsistent",
  );
  await db.update(invoices).set({ status: "CANCELLED", cancelledAt: new Date() }).where(eq(invoices.id, broken.id));

  // The example from the request: a 500 invoice at 5% -> buyer 500, tax 25, company 475.
  const inv500 = await createInvoice({
    company: issuer,
    recipientType: "USER",
    recipientUsername: payerUser.username,
    itemName: "Example 500",
    quantity: 1,
    unitPrice: 500,
  });
  const ex1 = await balanceOfUser(payerUser.id);
  const ex2 = await balanceOfCompany(issuer.id);
  const ex3 = await treasuryBalance();
  await payInvoice({ invoiceId: inv500.id, payer: userWallet(payerUser.id) });
  check(
    "example: 500 @5% -> buyer pays 500, tax 25, company receives 475",
    inv500.total === 500 &&
      (await balanceOfUser(payerUser.id)) === ex1 - 500 &&
      (await balanceOfCompany(issuer.id)) === ex2 + 475 &&
      (await treasuryBalance()) === ex3 + 25,
  );
  await invariant("paying the 500 example invoice");

  // ==========================================================================
  console.log("\n=== 3. INVOICE TO A COMPANY, PAID END TO END ===\n");
  // ==========================================================================

  const invCo = await createInvoice({
    company: issuer,
    recipientType: "COMPANY",
    recipientUsername: payerCompany.username,
    itemName: "Bulk uniforms",
    quantity: 4,
    unitPrice: 250,
  });
  check(
    "company invoice: price 1000, tax 50 taken from the company, total 1000",
    invCo.subtotal === 1000 && invCo.taxAmount === 50 && invCo.total === 1000,
    invCo,
  );
  check(
    "company invoice: addressed to the company, with no buyer user",
    invCo.recipientType === "COMPANY" &&
      invCo.recipientCompanyId === payerCompany.id &&
      invCo.buyerUserId === null,
    invCo,
  );

  const payerCoBefore = await balanceOfCompany(payerCompany.id);
  const coOwnerBefore = await balanceOfUser(coOwner.id);
  const issuerBefore2 = await balanceOfCompany(issuer.id);
  const treasuryBefore2 = await treasuryBalance();

  await expectError(
    "company invoice: the owner's personal wallet is NOT the payer",
    () => payInvoice({ invoiceId: invCo.id, payer: userWallet(coOwner.id) }),
    "not issued to you",
  );

  const coReceipt = await payInvoice({
    invoiceId: invCo.id,
    payer: companyWallet(payerCompany.id),
  });
  check(
    "company invoice: paying company debited the quoted price (1000)",
    (await balanceOfCompany(payerCompany.id)) === payerCoBefore - 1000,
  );
  check(
    "company invoice: the paying company's OWNER was not debited",
    (await balanceOfUser(coOwner.id)) === coOwnerBefore,
  );
  check(
    "company invoice: issuing company credited the price minus tax (950)",
    (await balanceOfCompany(issuer.id)) === issuerBefore2 + 950,
  );
  check(
    "company invoice: treasury received the tax (50)",
    (await treasuryBalance()) === treasuryBefore2 + 50,
  );
  check("company invoice: PAID with a reference", coReceipt.invoice.status === "PAID" && !!coReceipt.txRef);
  await invariant("paying a company invoice");

  // ==========================================================================
  console.log("\n=== 4. INVOICE TO THE GOVERNMENT, PAID END TO END ===\n");
  // ==========================================================================

  const invGov = await createInvoice({
    company: issuer,
    recipientType: "GOVERNMENT",
    // Deliberately passing a real user's handle: the GOVERNMENT branch must
    // ignore it completely and address the Treasury.
    recipientUsername: payerUser.username,
    itemName: "Civic banners",
    quantity: 3,
    unitPrice: 200,
  });
  check(
    "government invoice: addressed to GOVERNMENT with no user or company recipient",
    invGov.recipientType === "GOVERNMENT" &&
      invGov.buyerUserId === null &&
      invGov.recipientCompanyId === null,
    invGov,
  );
  check(
    "government invoice: the Government is never taxed, so total = subtotal (600)",
    invGov.subtotal === 600 && invGov.taxRateBp === 0 && invGov.taxAmount === 0 && invGov.total === 600,
    invGov,
  );
  check(
    "government invoice: the payer wallet derived from the row is the Treasury",
    (await invoicePayerWallet(db, invGov)).kind === "GOVERNMENT",
  );

  const treasuryBefore3 = await treasuryBalance();
  const issuerBefore3 = await balanceOfCompany(issuer.id);
  const namedUserBefore = await balanceOfUser(payerUser.id);

  const govReceipt = await payInvoice({ invoiceId: invGov.id, payer: governmentWallet(gov.id) });
  check(
    "government invoice: the TREASURY was debited (600)",
    (await treasuryBalance()) === treasuryBefore3 - 600,
  );
  check(
    "government invoice: the user whose handle was passed is untouched",
    (await balanceOfUser(payerUser.id)) === namedUserBefore,
  );
  check(
    "government invoice: the issuing company received the full 600",
    (await balanceOfCompany(issuer.id)) === issuerBefore3 + 600,
  );
  check("government invoice: PAID with a reference", govReceipt.invoice.status === "PAID" && !!govReceipt.txRef);
  await invariant("paying a government invoice");

  // ==========================================================================
  console.log("\n=== 5. TAX SNAPSHOT IMMUTABILITY ===\n");
  // ==========================================================================

  const snapInvoice = await createInvoice({
    company: issuer,
    recipientType: "USER",
    recipientUsername: payerUser.username,
    itemName: "Snapshot widget",
    quantity: 1,
    unitPrice: 1000,
  });
  check(
    "snapshot: issued at the live 5% rate — tax 50, total 1000",
    snapInvoice.taxRateBp === 500 && snapInvoice.taxAmount === 50 && snapInvoice.total === 1000,
    snapInvoice,
  );

  // The Government now changes the matrix for exactly this combination.
  await setTaxMatrixRate({
    payerType: "USER",
    recipientType: "COMPANY",
    context: "INVOICE_PAYMENT",
    rateBp: 4000,
    governmentId: gov.id,
    governmentUsername: gov.username,
    note: "V3 Phase B snapshot test",
  });

  const afterMatrixChange = await invoiceRow(snapInvoice.id);
  check(
    "snapshot: a matrix change does NOT re-price the already-issued invoice",
    afterMatrixChange.taxRateBp === 500 &&
      afterMatrixChange.taxAmount === 50 &&
      afterMatrixChange.total === 1000 &&
      afterMatrixChange.subtotal === 1000,
    afterMatrixChange,
  );

  // A NEW invoice does see the new rate — proving the change really took effect
  // and that the old invoice's immunity is the snapshot, not an inert matrix.
  const postChangeInvoice = await createInvoice({
    company: issuer,
    recipientType: "USER",
    recipientUsername: payerUser.username,
    itemName: "Post-change widget",
    quantity: 1,
    unitPrice: 1000,
  });
  check(
    "snapshot: a NEW invoice issued after the change uses the new 40% rate (buyer still pays 1000)",
    postChangeInvoice.taxRateBp === 4000 &&
      postChangeInvoice.taxAmount === 400 &&
      postChangeInvoice.total === 1000,
    postChangeInvoice,
  );

  const snapPayerBefore = await balanceOfUser(payerUser.id);
  const snapIssuerBefore = await balanceOfCompany(issuer.id);
  const snapTreasuryBefore = await treasuryBalance();

  const snapReceipt = await payInvoice({
    invoiceId: snapInvoice.id,
    payer: userWallet(payerUser.id),
  });
  const snapLedger = await ledgerRowsFor(snapInvoice.id);
  check(
    "snapshot: the PAYMENT charges the snapshot, not the new rate (1000 / 50 / 950)",
    snapLedger.length === 1 &&
      snapLedger[0].grossAmount === 1000 &&
      snapLedger[0].taxAmount === 50 &&
      snapLedger[0].netAmount === 950 &&
      snapLedger[0].taxRateBpApplied === 500,
    snapLedger,
  );
  check(
    "snapshot: wallet movements match the snapshot exactly",
    (await balanceOfUser(payerUser.id)) === snapPayerBefore - 1000 &&
      (await balanceOfCompany(issuer.id)) === snapIssuerBefore + 950 &&
      (await treasuryBalance()) === snapTreasuryBefore + 50,
  );
  check("snapshot: receipt reflects the snapshot total", snapReceipt.invoice.total === 1000);
  await invariant("paying a snapshotted invoice after a matrix change");

  // Clean up the matrix cell so the rest of the suite (and the app) is back to
  // inherited V2 behaviour.
  await clearTaxMatrixRate({
    payerType: "USER",
    recipientType: "COMPANY",
    context: "INVOICE_PAYMENT",
    governmentId: gov.id,
    governmentUsername: gov.username,
  });
  const clearedCheck = await createInvoice({
    company: issuer,
    recipientType: "USER",
    recipientUsername: payerUser.username,
    itemName: "Back to inherited",
    quantity: 1,
    unitPrice: 1000,
  });
  check(
    "snapshot: clearing the cell restores the inherited 5% rate for new invoices",
    clearedCheck.taxRateBp === 500 && clearedCheck.taxAmount === 50,
    clearedCheck,
  );
  await cancelInvoice({
    invoiceId: clearedCheck.id,
    companyId: issuer.id,
    actorLabel: issuer.name,
  });

  // ==========================================================================
  console.log("\n=== 6. ANTI-TAX-ROUTING: SETTLEMENT CANNOT REACH A PERSONAL WALLET ===\n");
  // ==========================================================================

  const routeInvoice = await createInvoice({
    company: issuer,
    recipientType: "USER",
    recipientUsername: payerUser.username,
    itemName: "Routing probe",
    quantity: 1,
    unitPrice: 500,
  });

  const derived = await deriveInvoiceSettlement(db, routeInvoice.id);
  check(
    "routing: the derived destination is the ISSUING COMPANY's wallet",
    derived.wallet.kind === "COMPANY" && derived.wallet.id === issuer.id,
    derived.wallet,
  );
  check(
    "routing: the destination knows the owner it must not pay, but never points at them",
    derived.ownerUserId === issuerOwner.id && derived.wallet.id !== issuerOwner.id,
    { ownerUserId: derived.ownerUserId, wallet: derived.wallet },
  );
  check(
    "routing: asserting the company wallet passes",
    (() => {
      try {
        assertSettlementDestination(derived, companyWallet(issuer.id));
        return true;
      } catch {
        return false;
      }
    })(),
  );

  // ATTACK 1 — hand `transferInTx` the invoice plus the owner's personal wallet.
  // This is the lowest layer there is; if it refuses, nothing above it can
  // succeed. The whole attempt runs in a transaction so any partial work rolls
  // back, and the balances are re-checked afterwards regardless.
  const ownerBeforeAttack = await balanceOfUser(issuerOwner.id);
  const companyBeforeAttack = await balanceOfCompany(issuer.id);

  await expectError(
    "routing ATTACK 1: transferInTx(invoiceId, to: owner's personal wallet) is refused",
    () =>
      db.transaction((tx) =>
        transferInTx(tx, {
          from: userWallet(payerUser.id),
          to: userWallet(issuerOwner.id),
          amount: routeInvoice.total,
          invoiceId: routeInvoice.id,
          type: "INVOICE_PAYMENT",
        }),
      ),
    "not to its owner's personal wallet",
  );

  // ATTACK 2 — a different company's wallet.
  await expectError(
    "routing ATTACK 2: settling an invoice to a DIFFERENT company's wallet is refused",
    () =>
      db.transaction((tx) =>
        transferInTx(tx, {
          from: userWallet(payerUser.id),
          to: companyWallet(payerCompany.id),
          amount: routeInvoice.total,
          invoiceId: routeInvoice.id,
        }),
      ),
    "must settle to the company wallet",
  );

  // ATTACK 3 — carry a correctly derived settlement but point `to` elsewhere.
  // This is the shape a future marketplace-order code path would have, so it
  // proves Phase C inherits the guarantee.
  const orderDestination = await deriveCompanySettlement(db, issuer.id);
  await expectError(
    "routing ATTACK 3: a derived settlement with a mismatched destination is refused (Phase C shape)",
    () =>
      db.transaction((tx) =>
        transferInTx(tx, {
          from: userWallet(payerUser.id),
          to: userWallet(issuerOwner.id),
          settlement: orderDestination,
          amount: 100,
          taxContext: "MARKETPLACE_ORDER",
        }),
      ),
    "not to its owner's personal wallet",
  );

  // ATTACK 4 — an INVOICE_PAYMENT that tries to land on a personal wallet with
  // no invoice id at all, i.e. bypassing the invoice-derived check.
  await expectError(
    "routing ATTACK 4: a transfer typed INVOICE_PAYMENT cannot land on a personal wallet",
    () =>
      db.transaction((tx) =>
        transferInTx(tx, {
          from: userWallet(payerUser.id),
          to: userWallet(issuerOwner.id),
          amount: 100,
          type: "INVOICE_PAYMENT",
        }),
      ),
    "must settle to a company wallet",
  );

  // ATTACK 5 — smuggle destination-shaped fields into `payInvoice` itself. The
  // function has no such parameter; this proves extra fields are inert rather
  // than merely un-typed.
  const smuggleOwnerBefore = await balanceOfUser(issuerOwner.id);
  const smuggleCompanyBefore = await balanceOfCompany(issuer.id);
  const smuggled = await (
    payInvoice as unknown as (p: Record<string, unknown>) => Promise<{ txRef: string }>
  )({
    invoiceId: routeInvoice.id,
    payer: userWallet(payerUser.id),
    // every field a request could plausibly carry:
    to: userWallet(issuerOwner.id),
    destination: userWallet(issuerOwner.id),
    destinationWalletId: issuerOwner.id,
    settlement: { wallet: userWallet(issuerOwner.id) },
    walletId: issuerOwner.id,
    taxRateBp: 0,
    forcedTaxRateBp: 0,
  });
  check(
    "routing ATTACK 5: destination-shaped fields passed to payInvoice are inert — money went to the COMPANY",
    (await balanceOfCompany(issuer.id)) === smuggleCompanyBefore + (routeInvoice.total - routeInvoice.taxAmount) &&
      (await balanceOfUser(issuerOwner.id)) === smuggleOwnerBefore,
    {
      company: await balanceOfCompany(issuer.id),
      owner: await balanceOfUser(issuerOwner.id),
      txRef: smuggled.txRef,
    },
  );
  const routeLedger = await ledgerRowsFor(routeInvoice.id);
  check(
    "routing ATTACK 5: the ledger row names the company as receiver",
    routeLedger.length === 1 &&
      routeLedger[0].receiverType === "COMPANY" &&
      routeLedger[0].receiverId === issuer.id,
    routeLedger,
  );
  check(
    "routing: no attack moved anything — owner and company balances only changed by the real payment",
    (await balanceOfUser(issuerOwner.id)) === ownerBeforeAttack &&
      (await balanceOfCompany(issuer.id)) === companyBeforeAttack + (routeInvoice.total - routeInvoice.taxAmount),
  );
  await invariant("the routing attack battery");

  // The action layer: the only thing it reads from the request is the invoice
  // id. Asserted against the source so a future edit that adds a destination
  // field to the form fails this suite.
  const actionSource = readFileSync(
    join(process.cwd(), "src", "actions", "invoice.ts"),
    "utf8",
  );
  const formReads = [...actionSource.matchAll(/formData\.get\(\s*"([^"]+)"/g)].map((m) => m[1]);
  check(
    "routing: the pay-invoice server action reads ONLY invoiceId from the request",
    formReads.length === 1 && formReads[0] === "invoiceId",
    formReads,
  );
  const libSource = readFileSync(join(process.cwd(), "src", "lib", "invoices.ts"), "utf8");
  check(
    "routing: lib/invoices.ts never constructs a userWallet as a settlement destination",
    !/to:\s*userWallet/.test(libSource),
  );

  // A forced breakdown cannot be used to smuggle a different amount or an
  // unbalanced split past the tax rules.
  await expectError(
    "routing: an inconsistent forced breakdown is refused",
    () =>
      db.transaction((tx) =>
        transferInTx(tx, {
          from: userWallet(payerUser.id),
          to: companyWallet(issuer.id),
          amount: 100,
          forcedBreakdown: { grossAmount: 100, taxAmount: 0, netAmount: 90, taxRateBpApplied: 0 },
        }),
      ),
    "does not balance",
  );

  // ==========================================================================
  console.log("\n=== 7. IDEMPOTENCY AND CONCURRENCY ===\n");
  // ==========================================================================

  const dupInvoice = await createInvoice({
    company: issuer,
    recipientType: "USER",
    recipientUsername: payerUser.username,
    itemName: "Duplicate probe",
    quantity: 1,
    unitPrice: 300,
  });

  const dupPayerBefore = await balanceOfUser(payerUser.id);
  const first = await payInvoice({ invoiceId: dupInvoice.id, payer: userWallet(payerUser.id) });
  const dupPayerAfterFirst = await balanceOfUser(payerUser.id);
  const second = await payInvoice({ invoiceId: dupInvoice.id, payer: userWallet(payerUser.id) });

  check(
    "idempotency: the duplicate returns the FIRST result",
    second.replayed === true &&
      second.txRef === first.txRef &&
      second.invoice.id === first.invoice.id,
    { first: first.txRef, second: second.txRef, replayed: second.replayed },
  );
  check(
    "idempotency: the duplicate wrote no second ledger event",
    (await ledgerRowsFor(dupInvoice.id)).length === 1,
  );
  check(
    "idempotency: the duplicate charged nothing further",
    (await balanceOfUser(payerUser.id)) === dupPayerAfterFirst &&
      dupPayerAfterFirst === dupPayerBefore - dupInvoice.total,
  );
  await invariant("a duplicate invoice payment");

  // Concurrency, with idempotency on (the product path).
  const raceInvoice = await createInvoice({
    company: issuer,
    recipientType: "USER",
    recipientUsername: payerUser.username,
    itemName: "Race probe",
    quantity: 1,
    unitPrice: 250,
  });
  const raceBefore = await balanceOfUser(payerUser.id);
  const raceResults = await Promise.allSettled([
    payInvoice({ invoiceId: raceInvoice.id, payer: userWallet(payerUser.id) }),
    payInvoice({ invoiceId: raceInvoice.id, payer: userWallet(payerUser.id) }),
  ]);
  const raceFulfilled = raceResults.filter((r) => r.status === "fulfilled");
  const realWins = raceFulfilled.filter(
    (r) => (r as PromiseFulfilledResult<{ replayed: boolean }>).value.replayed === false,
  );
  console.log(
    "   concurrent (idempotent) outcomes:",
    raceResults.map((r) =>
      r.status === "fulfilled"
        ? `ok replayed=${(r as PromiseFulfilledResult<{ replayed: boolean }>).value.replayed}`
        : `rejected: ${(r as PromiseRejectedResult).reason?.message}`,
    ),
  );
  check(
    "concurrency: exactly ONE of two concurrent payments actually settled",
    realWins.length === 1,
    raceResults.length,
  );
  check(
    "concurrency: exactly one ledger event for the invoice",
    (await ledgerRowsFor(raceInvoice.id)).length === 1,
  );
  check(
    "concurrency: the payer was debited exactly once",
    (await balanceOfUser(payerUser.id)) === raceBefore - raceInvoice.total,
  );
  check("concurrency: the invoice is PAID exactly once", (await invoiceRow(raceInvoice.id)).status === "PAID");
  await invariant("two concurrent payments of one invoice");

  // Concurrency with idempotency deliberately OFF, to prove the database-level
  // discipline (row lock + guarded UPDATE) is a second, independent guarantee.
  const raceInvoice2 = await createInvoice({
    company: issuer,
    recipientType: "USER",
    recipientUsername: payerUser.username,
    itemName: "Race probe (no key)",
    quantity: 1,
    unitPrice: 250,
  });
  const race2Before = await balanceOfUser(payerUser.id);
  const race2 = await Promise.allSettled([
    payInvoice({ invoiceId: raceInvoice2.id, payer: userWallet(payerUser.id), idempotent: false }),
    payInvoice({ invoiceId: raceInvoice2.id, payer: userWallet(payerUser.id), idempotent: false }),
  ]);
  console.log(
    "   concurrent (no key) outcomes:",
    race2.map((r) =>
      r.status === "fulfilled" ? "ok" : `rejected: ${(r as PromiseRejectedResult).reason?.message}`,
    ),
  );
  check(
    "concurrency without a key: the row lock alone leaves exactly one winner",
    race2.filter((r) => r.status === "fulfilled").length === 1 &&
      race2.filter((r) => r.status === "rejected").length === 1,
  );
  check(
    "concurrency without a key: one ledger event, debited once",
    (await ledgerRowsFor(raceInvoice2.id)).length === 1 &&
      (await balanceOfUser(payerUser.id)) === race2Before - raceInvoice2.total,
  );
  await invariant("two concurrent unkeyed payments");

  // ==========================================================================
  console.log("\n=== 8. REJECTIONS ===\n");
  // ==========================================================================

  // Insufficient funds.
  const poorUser = await makeUser(`v3i_poor_${RUN}`, 50);
  const bigInvoice = await createInvoice({
    company: issuer,
    recipientType: "USER",
    recipientUsername: poorUser.username,
    itemName: "Too expensive",
    quantity: 1,
    unitPrice: 5000,
  });
  const poorBefore = await balanceOfUser(poorUser.id);
  const issuerBeforePoor = await balanceOfCompany(issuer.id);
  await expectError(
    "insufficient funds: the payment is refused",
    () => payInvoice({ invoiceId: bigInvoice.id, payer: userWallet(poorUser.id) }),
    "Insufficient Aeros balance",
  );
  check(
    "insufficient funds: nothing moved and the invoice is still PENDING",
    (await balanceOfUser(poorUser.id)) === poorBefore &&
      (await balanceOfCompany(issuer.id)) === issuerBeforePoor &&
      (await invoiceRow(bigInvoice.id)).status === "PENDING" &&
      (await ledgerRowsFor(bigInvoice.id)).length === 0,
  );
  await invariant("a failed (insufficient funds) payment");

  // Cancelled.
  const cancelledInvoice = await createInvoice({
    company: issuer,
    recipientType: "USER",
    recipientUsername: payerUser.username,
    itemName: "To be cancelled",
    quantity: 1,
    unitPrice: 100,
  });
  await cancelInvoice({
    invoiceId: cancelledInvoice.id,
    companyId: issuer.id,
    actorLabel: issuer.name,
  });
  await expectError(
    "cancelled: a cancelled invoice cannot be paid",
    () => payInvoice({ invoiceId: cancelledInvoice.id, payer: userWallet(payerUser.id) }),
    "cancelled",
  );

  // Expired (due date already past).
  const expiredInvoice = await createInvoice({
    company: issuer,
    recipientType: "USER",
    recipientUsername: payerUser.username,
    itemName: "Already overdue",
    quantity: 1,
    unitPrice: 100,
    dueAt: new Date(Date.now() - 60_000),
  });
  await expectError(
    "expired: an overdue invoice cannot be paid",
    () => payInvoice({ invoiceId: expiredInvoice.id, payer: userWallet(payerUser.id) }),
    "expired",
  );
  check(
    "expired: the overdue invoice was marked EXPIRED, not paid",
    (await invoiceRow(expiredInvoice.id)).status === "EXPIRED" &&
      (await ledgerRowsFor(expiredInvoice.id)).length === 0,
  );

  // Wrong payer.
  const wrongPayerInvoice = await createInvoice({
    company: issuer,
    recipientType: "USER",
    recipientUsername: payerUser.username,
    itemName: "Not yours",
    quantity: 1,
    unitPrice: 100,
  });
  await expectError(
    "wrong payer: another user cannot pay someone else's invoice",
    () => payInvoice({ invoiceId: wrongPayerInvoice.id, payer: userWallet(otherUser.id) }),
    "not issued to you",
  );

  // Self-invoice.
  await expectError(
    "self-invoice: a company cannot invoice itself",
    () =>
      createInvoice({
        company: issuer,
        recipientType: "COMPANY",
        recipientUsername: issuer.username,
        itemName: "Self",
        quantity: 1,
        unitPrice: 100,
      }),
    "cannot invoice itself",
  );

  // Suspended / revoked issuer.
  await expectError(
    "suspended issuer: a suspended company cannot issue invoices",
    () =>
      createInvoice({
        company: suspendedCo,
        recipientType: "USER",
        recipientUsername: payerUser.username,
        itemName: "From a suspended company",
        quantity: 1,
        unitPrice: 100,
      }),
    "Only an active company can issue invoices",
  );
  await expectError(
    "revoked issuer: a revoked company cannot issue invoices",
    () =>
      createInvoice({
        company: revokedCo,
        recipientType: "USER",
        recipientUsername: payerUser.username,
        itemName: "From a revoked company",
        quantity: 1,
        unitPrice: 100,
      }),
    "Only an active company can issue invoices",
  );

  // A suspended PAYER may hold an invoice but cannot pay it.
  const suspInvoice = await createInvoice({
    company: issuer,
    recipientType: "USER",
    recipientUsername: suspUser.username,
    itemName: "For a suspended payer",
    quantity: 1,
    unitPrice: 100,
  });
  check("suspended payer: the invoice was still issued to them", suspInvoice.status === "PENDING");
  await expectError(
    "suspended payer: cannot pay while suspended",
    () => payInvoice({ invoiceId: suspInvoice.id, payer: userWallet(suspUser.id) }),
    "suspended",
  );

  // A revoked ISSUER cannot be paid, even for an invoice raised while active.
  const willRevokeOwner = await makeUser(`v3i_rvo_${RUN}`, 100);
  const willRevoke = await makeCompany({
    ownerUserId: willRevokeOwner.id,
    name: `Will Revoke ${RUN}`,
    username: `v3i_wrv_${RUN}`,
    balance: 0,
  });
  const revokedIssuerInvoice = await createInvoice({
    company: willRevoke,
    recipientType: "USER",
    recipientUsername: payerUser.username,
    itemName: "Issued before revocation",
    quantity: 1,
    unitPrice: 100,
  });
  await db.update(companies).set({ status: "REVOKED" }).where(eq(companies.id, willRevoke.id));
  await expectError(
    "revoked issuer: its outstanding invoice can no longer be paid",
    () => payInvoice({ invoiceId: revokedIssuerInvoice.id, payer: userWallet(payerUser.id) }),
    "cannot receive payments",
  );
  await invariant("the rejection battery");

  // ==========================================================================
  console.log("\n=== 9. READ PATHS COVER ALL THREE RECIPIENT TYPES ===\n");
  // ==========================================================================

  const readUser = await getInvoiceById(invUser.id);
  const readCompany = await getInvoiceById(invCo.id);
  const readGov = await getInvoiceById(invGov.id);

  check(
    "read: a USER-recipient invoice is readable with its buyer",
    !!readUser &&
      readUser.recipient.type === "USER" &&
      readUser.recipient.userId === payerUser.id &&
      readUser.buyer?.username === payerUser.username &&
      readUser.company.id === issuer.id,
    readUser?.recipient,
  );
  check(
    "read: a COMPANY-recipient invoice is readable (Phase A's inner join made this impossible)",
    !!readCompany &&
      readCompany.recipient.type === "COMPANY" &&
      readCompany.recipient.companyId === payerCompany.id &&
      readCompany.recipient.username === payerCompany.username &&
      readCompany.buyer === null,
    readCompany?.recipient,
  );
  check(
    "read: a GOVERNMENT-recipient invoice is readable and labelled Government",
    !!readGov &&
      readGov.recipient.type === "GOVERNMENT" &&
      readGov.recipient.label === "Government" &&
      readGov.recipient.userId === null &&
      readGov.recipient.companyId === null,
    readGov?.recipient,
  );

  const sent = await getSentInvoicesForCompany(issuer.id, 200);
  const sentIds = new Set(sent.map((r) => r.invoice.id));
  check(
    "list: Sent Invoices includes all three recipient types",
    sentIds.has(invUser.id) && sentIds.has(invCo.id) && sentIds.has(invGov.id),
    { count: sent.length },
  );
  check(
    "list: every sent row carries a resolved recipient label",
    sent.every((r) => r.recipient.label.length > 0 && r.buyerDisplayName === r.recipient.label),
  );

  const receivedByUser = await getReceivedInvoicesForWallet(userWallet(payerUser.id), 200);
  check(
    "list: Received Invoices for a personal wallet lists its user invoice and not the company one",
    receivedByUser.some((r) => r.invoice.id === invUser.id) &&
      !receivedByUser.some((r) => r.invoice.id === invCo.id),
  );
  const receivedByCompany = await getReceivedInvoicesForWallet(companyWallet(payerCompany.id), 200);
  check(
    "list: Received Invoices for a company wallet lists its company invoice",
    receivedByCompany.some((r) => r.invoice.id === invCo.id) &&
      !receivedByCompany.some((r) => r.invoice.id === invUser.id),
  );
  const receivedByGov = await getReceivedInvoicesForWallet(governmentWallet(gov.id), 200);
  check(
    "list: Received Invoices for the Treasury lists the Government invoice",
    receivedByGov.some((r) => r.invoice.id === invGov.id),
  );
  check(
    "list: every received row names its issuing company",
    receivedByUser.every((r) => r.companyName.length > 0 && r.companyUsername.length > 0),
  );

  const pendingForSusp = await getPendingInvoiceCountForWallet(userWallet(suspUser.id));
  check("list: pending count is wallet-scoped", pendingForSusp >= 1, pendingForSusp);

  // Access rules.
  const roleForPayer = invoiceViewerRole(readCompany!, {
    userId: coOwner.id,
    wallet: companyWallet(payerCompany.id),
    ownedCompanyIds: [payerCompany.id],
  });
  check(
    "access: the recipient company's owner acting AS the company is the payer",
    roleForPayer.canView && roleForPayer.isPayer && !roleForPayer.isRecipientOwnerInWrongContext,
    roleForPayer,
  );
  const roleForOwnerPersonal = invoiceViewerRole(readCompany!, {
    userId: coOwner.id,
    wallet: userWallet(coOwner.id),
    ownedCompanyIds: [payerCompany.id],
  });
  check(
    "access: the same owner on their personal wallet may VIEW but is not the payer",
    roleForOwnerPersonal.canView &&
      !roleForOwnerPersonal.isPayer &&
      roleForOwnerPersonal.isRecipientOwnerInWrongContext,
    roleForOwnerPersonal,
  );
  const roleForStranger = invoiceViewerRole(readCompany!, {
    userId: otherUser.id,
    wallet: userWallet(otherUser.id),
    ownedCompanyIds: [],
  });
  check("access: an unrelated user cannot view the invoice", !roleForStranger.canView, roleForStranger);
  const roleForIssuer = invoiceViewerRole(readGov!, {
    userId: issuerOwner.id,
    wallet: userWallet(issuerOwner.id),
    ownedCompanyIds: [issuer.id],
  });
  check(
    "access: the issuing company's owner can view a Government invoice",
    roleForIssuer.canView && roleForIssuer.isIssuer && !roleForIssuer.isPayer,
    roleForIssuer,
  );

  // ==========================================================================
  console.log("\n=== 10. FINAL INVARIANT ===\n");
  // ==========================================================================

  const end = await totals();
  check(
    "FINAL: total supply = treasury + users + companies",
    end.accounted === end.supply,
    end,
  );
  check("FINAL: this suite never created or destroyed Aeros", end.supply === baselineSupply, {
    before: baselineSupply,
    after: end.supply,
  });

  // Every invoice that exists is reachable through a typed recipient.
  const [orphans] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(invoices)
    .where(
      sql`(recipient_type = 'USER' AND buyer_user_id IS NULL)
       OR (recipient_type = 'COMPANY' AND recipient_company_id IS NULL)
       OR (recipient_type = 'GOVERNMENT' AND (buyer_user_id IS NOT NULL OR recipient_company_id IS NOT NULL))`,
    );
  check("FINAL: no invoice in the database has an unreachable recipient", orphans.count === 0, orphans);

  // Hand every Aero back to the treasury so the next run can fund itself.
  await sweepFixtureBalances();
  const swept = await totals();
  check(
    "CLEANUP: sweeping fixtures back to the treasury preserves the invariant",
    swept.accounted === swept.supply && swept.supply === baselineSupply,
    swept,
  );

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  if (e instanceof PaymentError || e instanceof InvoiceError || e instanceof SettlementRoutingError) {
    console.error("(domain error)");
  }
  await pool.end();
  process.exit(1);
});

// Referenced so an unused-import lint never hides a real dependency.
void (undefined as unknown as WalletRef);
