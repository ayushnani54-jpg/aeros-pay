/**
 * V2 end-to-end lifecycle tests: companies, invoices, sales, loans, issuance.
 * Each flow runs against a real database and re-checks the supply invariant.
 */
import "dotenv/config";
import { db, pool } from "../../src/db/client";
import {
  companies,
  companySaleListings,
  companySaleOffers,
  companySaleRecords,
  government,
  invoices,
  issuanceRequests,
  loanInstalments,
  loans,
  registrationCodes,
  transactions,
  users,
} from "../../src/db/schema";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";

import { transfer } from "../../src/lib/payments";
import { governmentWallet, userWallet } from "../../src/lib/wallets";
import { applyForCompany, approveCompany, rejectCompany } from "../../src/lib/companies";
import { createInvoice, payInvoice, cancelInvoice } from "../../src/lib/invoices";
import {
  createListing,
  purchaseListing,
  dismissListing,
  getOpenListingsForViewer,
  getAllOpenListings,
  makeOffer,
  respondToOffer,
  cancelListing,
} from "../../src/lib/sales";
import {
  applyForLoan,
  approveLoan,
  acceptLoan,
  payInstalment,
  runLoanMaintenance,
  recordLoanAction,
  getLoanSummary,
} from "../../src/lib/loans";
import {
  createIssuanceRequest,
  castIssuanceVote,
  executeIssuance,
  getApprovalProgress,
  requiredMajority,
} from "../../src/lib/issuance";

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
      console.log(`FAIL  ${label} — wrong error: "${msg}"`);
    }
  }
}

async function totals() {
  const [gov] = await db.select().from(government).limit(1);
  const [u] = await db.select({ s: sql<number>`coalesce(sum(balance),0)::int` }).from(users);
  const [c] = await db.select({ s: sql<number>`coalesce(sum(balance),0)::int` }).from(companies);
  return { treasury: gov.balance, supply: gov.totalSupply, accounted: gov.balance + u.s + c.s };
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
      displayName: name,
      balance: 0,
      registrationCodeId: code.id,
    })
    .returning();

  // Fund from the treasury with a real transfer rather than writing a balance
  // directly — otherwise the harness would mint Aeros that total supply does
  // not know about and break the very invariant these tests check.
  if (balance > 0) {
    const [g] = await db.select({ id: government.id }).from(government).limit(1);
    await transfer({
      from: governmentWallet(g.id),
      to: userWallet(user.id),
      amount: balance,
      forcedTaxRateBp: 0,
      type: "GOVERNMENT_FUNDING",
      reason: "Test fixture funding",
    });
  }

  const [funded] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  return funded;
}

async function resetFixtures() {
  // Sweep company balances back to the treasury before deleting, so the
  // harness never destroys Aeros (see test_v2_core.ts for the same guard).
  const [held] = await db
    .select({ s: sql<number>`coalesce(sum(balance),0)::int` })
    .from(companies);
  if ((held?.s ?? 0) > 0) {
    await db.update(government).set({ balance: sql`${government.balance} + ${held.s}` });
    await db.update(companies).set({ balance: 0 });
  }

  await db.execute(sql`DELETE FROM loan_payments`);
  await db.execute(sql`DELETE FROM loan_actions`);
  await db.execute(sql`DELETE FROM loan_instalments`);
  await db.execute(sql`DELETE FROM loans`);
  await db.execute(sql`DELETE FROM company_sale_records`);
  await db.execute(sql`DELETE FROM company_sale_dismissals`);
  await db.execute(sql`DELETE FROM company_sale_offers`);
  await db.execute(sql`DELETE FROM company_sale_listings`);
  // V3 marketplace children, deleted before the invoices and companies they
  // reference. Same blast radius as the lines below it: this teardown already
  // wipes every invoice and every company in the database, so it has to wipe
  // the V3 rows that point at them too or the FKs refuse the delete. None of
  // these tables holds Aeros, so removing them cannot disturb the supply
  // invariant. (The application itself never deletes any of this.)
  // `invoices` and `marketplace_orders` reference each other, so one side of
  // the cycle has to be released before either table can be emptied.
  await db.execute(sql`UPDATE invoices SET source_order_id = NULL`);
  await db.execute(sql`UPDATE marketplace_contracts SET invoice_id = NULL`);
  await db.execute(sql`DELETE FROM marketplace_order_ratings`);
  await db.execute(sql`DELETE FROM marketplace_orders`);
  await db.execute(sql`DELETE FROM promotion_campaigns`);
  await db.execute(sql`DELETE FROM marketplace_offers`);
  await db.execute(sql`DELETE FROM marketplace_contract_applications`);
  await db.execute(sql`DELETE FROM marketplace_contracts`);
  await db.execute(sql`DELETE FROM marketplace_wanted_responses`);
  await db.execute(sql`DELETE FROM marketplace_wanted_requests`);
  await db.execute(sql`DELETE FROM invoices`);
  await db.execute(sql`DELETE FROM issuance_votes`);
  await db.execute(sql`DELETE FROM issuance_eligible_voters`);
  await db.execute(sql`DELETE FROM issuance_requests`);
  await db.execute(sql`UPDATE transactions SET receiver_id = NULL WHERE receiver_type = 'COMPANY'`);
  await db.execute(sql`UPDATE transactions SET sender_id = NULL WHERE sender_type = 'COMPANY'`);
  await db.execute(sql`DELETE FROM companies`);
  await db.execute(sql`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'flow%')`);
  await db.execute(sql`DELETE FROM users WHERE username LIKE 'flow%'`);

  // Deterministic starting balances, supply made to agree by construction.
  await db.update(users).set({ balance: 0, status: "ACTIVE", suspendedUntil: null });
  await db.execute(sql`UPDATE users SET balance = 5000 WHERE username IN ('ayush','piyush')`);
  // Restore every configurable policy too, so a run that deliberately changes
  // one (e.g. the "frozen terms survive a rate change" test) cannot leak into
  // the next run.
  await db.update(government).set({
    balance: 50000,
    companyTaxRateBp: 500,
    taxRateBp: 500,
    saleMultiplierBp: 15000,
    saleMinCompanyAgeDays: 7,
    loansEnabled: true,
    loanInterestRateBp: 1000,
    loanMinAmount: 100,
    loanMaxAmount: 10000,
    loanInstalmentCount: 2,
    loanInstalmentIntervalDays: 7,
    loanMinCompanyAgeDays: 7,
    loanMinCompanySales: 0,
    loanDefaultGraceDays: 7,
    // V2.1: these three used to be hardcoded constants; reset them too so a
    // run that changes one (economy-policy form test) cannot leak into the
    // next run, same as every other configurable policy field above.
    companyApprovalFundingAmount: 3000,
    maxIssuanceAmount: 10000,
    issuanceCooldownDays: 1,
  });
  await db.execute(
    sql`UPDATE government SET total_supply = 50000 + (SELECT coalesce(sum(balance),0) FROM users)`,
  );
}

async function main() {
  await resetFixtures();

  const [gov] = await db.select().from(government).limit(1);
  const start = await totals();
  check("setup: supply invariant holds at start", start.supply === start.accounted, start);

  const seller = await makeUser("flowseller", 1000);
  const buyer = await makeUser("flowbuyer", 20000);
  const customer = await makeUser("flowcustomer", 10000);

  console.log("\n=== COMPANY LIFECYCLE ===\n");

  // --- application ---------------------------------------------------------
  const longDescription = Array.from({ length: 520 }, (_, i) => `word${i}`).join(" ");
  await expectError(
    "company: a description over 500 words is rejected server-side",
    () =>
      applyForCompany({
        ownerUserId: seller.id,
        name: "Too Wordy",
        username: "toowordy",
        category: "Retail",
        reason: "Testing",
        description: longDescription,
      }),
    "500 words or fewer",
  );

  const company = await applyForCompany({
    ownerUserId: seller.id,
    name: "Flow Fitness",
    username: "flowfitness",
    category: "Fitness",
    reason: "To sell training plans",
    description: "A small fitness business.",
  });
  check("company: application created as PENDING", company.status === "PENDING", company.status);

  await expectError(
    "company: a duplicate company username is rejected",
    () =>
      applyForCompany({
        ownerUserId: buyer.id,
        name: "Copycat",
        username: "flowfitness",
        category: "Fitness",
        reason: "x",
        description: "y",
      }),
    "already taken",
  );

  await expectError(
    "company: a company username clashing with a USER username is rejected",
    () =>
      applyForCompany({
        ownerUserId: buyer.id,
        name: "Clash",
        username: "flowseller",
        category: "Retail",
        reason: "x",
        description: "y",
      }),
    "already taken",
  );

  // --- approval + funding --------------------------------------------------
  const beforeApproval = await totals();
  const approval = await approveCompany({
    companyId: company.id,
    governmentId: gov.id,
    governmentUsername: gov.username,
  });
  const afterApproval = await totals();

  // V2.1: the funding amount is the live, Government-configurable
  // government.company_approval_funding_amount (default 3,000, reset by
  // resetFixtures above) — no longer a hardcoded 5,000.
  check(
    "company: approval funds exactly the configured amount (3,000 Aeros)",
    approval.amount === 3000,
    approval.amount,
  );
  check(
    "company: treasury paid the funding (supply unchanged)",
    afterApproval.treasury === beforeApproval.treasury - 3000 &&
      afterApproval.supply === beforeApproval.supply,
    { beforeApproval, afterApproval },
  );
  check(
    "company: supply invariant holds after approval funding",
    afterApproval.accounted === afterApproval.supply,
  );

  const [fundedCo] = await db.select().from(companies).where(eq(companies.id, company.id)).limit(1);
  check("company: wallet holds the 3,000", fundedCo.balance === 3000, fundedCo.balance);
  check("company: status is APPROVED", fundedCo.status === "APPROVED", fundedCo.status);

  await expectError(
    "company: approving twice is rejected",
    () =>
      approveCompany({
        companyId: company.id,
        governmentId: gov.id,
        governmentUsername: gov.username,
      }),
    "already approved",
  );

  // --- insufficient treasury ------------------------------------------------
  const poorCo = await applyForCompany({
    ownerUserId: buyer.id,
    name: "Poor Timing",
    username: "poortiming",
    category: "Retail",
    reason: "x",
    description: "y",
  });
  const treasuryBefore = (await totals()).treasury;
  await db.update(government).set({ balance: 100 }).where(eq(government.id, gov.id));
  await expectError(
    "company: approval is refused when the treasury cannot cover the funding",
    () =>
      approveCompany({
        companyId: poorCo.id,
        governmentId: gov.id,
        governmentUsername: gov.username,
      }),
    "insufficient Aeros",
  );
  const [stillPending] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, poorCo.id))
    .limit(1);
  check(
    "company: a refused approval leaves the company PENDING and unfunded",
    stillPending.status === "PENDING" && stillPending.balance === 0,
    { status: stillPending.status, balance: stillPending.balance },
  );
  await db.update(government).set({ balance: treasuryBefore }).where(eq(government.id, gov.id));
  await rejectCompany({
    companyId: poorCo.id,
    governmentId: gov.id,
    governmentUsername: gov.username,
    reason: "Test cleanup",
  });

  console.log("\n=== INVOICES ===\n");

  const [liveCo] = await db.select().from(companies).where(eq(companies.id, company.id)).limit(1);

  const invoice = await createInvoice({
    company: liveCo,
    buyerUsername: "flowcustomer",
    itemName: "Cotton Shirt",
    quantity: 2,
    unitPrice: 400,
  });
  check(
    "invoice: subtotal 800, 5% tax on top = 40, total payable 840",
    invoice.subtotal === 800 && invoice.taxAmount === 40 && invoice.total === 840,
    invoice,
  );

  const beforePay = await totals();
  const [coBeforePay] = await db.select().from(companies).where(eq(companies.id, company.id)).limit(1);
  const [custBeforePay] = await db.select().from(users).where(eq(users.id, customer.id)).limit(1);

  const paid = await payInvoice({ invoiceId: invoice.id, payerUserId: customer.id });

  const [coAfterPay] = await db.select().from(companies).where(eq(companies.id, company.id)).limit(1);
  const [custAfterPay] = await db.select().from(users).where(eq(users.id, customer.id)).limit(1);
  const afterPay = await totals();

  check(
    "invoice: buyer paid the full total (840)",
    custAfterPay.balance === custBeforePay.balance - 840,
    { before: custBeforePay.balance, after: custAfterPay.balance },
  );
  check(
    "invoice: company received the full quoted subtotal (800)",
    coAfterPay.balance === coBeforePay.balance + 800,
    { before: coBeforePay.balance, after: coAfterPay.balance },
  );
  check(
    "invoice: Government received the tax (40)",
    afterPay.treasury === beforePay.treasury + 40,
  );
  check("invoice: supply unchanged", afterPay.supply === beforePay.supply);
  check("invoice: supply invariant holds", afterPay.accounted === afterPay.supply);
  check("invoice: marked PAID with a tx reference", paid.invoice.status === "PAID" && !!paid.txRef);

  // V3 (spec §42) SUPERSEDES the V2 expectation here. Paying the same invoice
  // again used to be an error; it is now IDEMPOTENT — the first receipt is
  // replayed and nothing is charged a second time. The guarantee that actually
  // matters (an invoice can never be paid twice) is what is asserted, and it is
  // asserted more strongly than before: the balance is unchanged AND the ledger
  // still holds exactly one payment for the invoice.
  const retry = await payInvoice({ invoiceId: invoice.id, payerUserId: customer.id });
  const [custAfterRetry] = await db.select().from(users).where(eq(users.id, customer.id)).limit(1);
  const [ledger] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(transactions)
    .where(eq(transactions.invoiceId, invoice.id));
  check(
    "invoice: paying the same invoice twice replays the first receipt and charges nothing again",
    retry.replayed === true &&
      retry.txRef === paid.txRef &&
      custAfterRetry.balance === custAfterPay.balance &&
      ledger.count === 1,
    { retry: retry.txRef, first: paid.txRef, ledgerRows: ledger.count },
  );

  const otherInvoice = await createInvoice({
    company: liveCo,
    buyerUsername: "flowcustomer",
    itemName: "Gym Pass",
    quantity: 1,
    unitPrice: 100,
  });
  await expectError(
    "invoice: another user cannot pay someone else's invoice",
    () => payInvoice({ invoiceId: otherInvoice.id, payerUserId: buyer.id }),
    "not issued to you",
  );

  await cancelInvoice({
    invoiceId: otherInvoice.id,
    companyId: company.id,
    actorLabel: "Flow Fitness",
  });
  await expectError(
    "invoice: a cancelled invoice cannot be paid",
    () => payInvoice({ invoiceId: otherInvoice.id, payerUserId: customer.id }),
    "cancelled",
  );

  console.log("\n=== COMPANY SALE ===\n");

  // Too young to list (approved seconds ago).
  const [youngCo] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, company.id))
    .limit(1);
  await expectError(
    "sale: a brand-new company cannot be listed",
    () =>
      createListing({
        company: youngCo,
        sellerUserId: seller.id,
        reason: "Too soon",
      }),
    "7 full days after approval",
  );

  // Backdate the approval so it becomes eligible.
  await db
    .update(companies)
    .set({ reviewedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
    .where(eq(companies.id, company.id));

  const [eligibleCo] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, company.id))
    .limit(1);

  const listing = await createListing({
    company: eligibleCo,
    sellerUserId: seller.id,
    reason: "Moving on to a new project",
  });
  check(
    "sale: valuation = lifetime sales x 1.5 (800 sales -> 1,200)",
    listing.salesFigure === 800 && listing.multiplierBp === 15000 && listing.valuation === 1200,
    listing,
  );

  await expectError(
    "sale: the same company cannot be listed twice",
    () =>
      createListing({
        company: eligibleCo,
        sellerUserId: seller.id,
        reason: "again",
      }),
    "already listed",
  );

  // --- per-user dismissal ---------------------------------------------------
  const beforeDismiss = await getOpenListingsForViewer(buyer.id);
  check("sale: the listing is visible to a buyer", beforeDismiss.length === 1, beforeDismiss.length);

  await dismissListing(listing.id, customer.id);

  const customerView = await getOpenListingsForViewer(customer.id);
  const buyerView = await getOpenListingsForViewer(buyer.id);
  const everyone = await getAllOpenListings();

  check("sale: dismissing hides it for THAT user", customerView.length === 0, customerView.length);
  check(
    "sale: the same listing is STILL visible to everyone else",
    buyerView.length === 1,
    buyerView.length,
  );
  check("sale: the listing itself is still OPEN globally", everyone.length === 1, everyone.length);

  await dismissListing(listing.id, customer.id); // idempotent
  check(
    "sale: dismissing twice is harmless",
    (await getOpenListingsForViewer(customer.id)).length === 0,
  );

  // --- purchase --------------------------------------------------------------
  const [sellerBefore] = await db.select().from(users).where(eq(users.id, seller.id)).limit(1);
  const [buyerBefore] = await db.select().from(users).where(eq(users.id, buyer.id)).limit(1);
  const [coBeforeSale] = await db.select().from(companies).where(eq(companies.id, company.id)).limit(1);
  const beforeSaleTotals = await totals();

  const purchase = await purchaseListing({ listingId: listing.id, buyerUserId: buyer.id });

  const [sellerAfter] = await db.select().from(users).where(eq(users.id, seller.id)).limit(1);
  const [buyerAfter] = await db.select().from(users).where(eq(users.id, buyer.id)).limit(1);
  const [coAfterSale] = await db.select().from(companies).where(eq(companies.id, company.id)).limit(1);
  const afterSaleTotals = await totals();

  check(
    "sale: buyer's personal wallet paid the full valuation, untaxed",
    buyerAfter.balance === buyerBefore.balance - 1200,
    { before: buyerBefore.balance, after: buyerAfter.balance },
  );
  check(
    "sale: seller's personal wallet received the full valuation",
    sellerAfter.balance === sellerBefore.balance + 1200,
    { before: sellerBefore.balance, after: sellerAfter.balance },
  );
  check(
    "sale: the COMPANY wallet is untouched by the sale",
    coAfterSale.balance === coBeforeSale.balance,
    { before: coBeforeSale.balance, after: coAfterSale.balance },
  );
  check("sale: ownership transferred to the buyer", coAfterSale.ownerUserId === buyer.id);
  check("sale: supply unchanged", afterSaleTotals.supply === beforeSaleTotals.supply);
  check("sale: supply invariant holds", afterSaleTotals.accounted === afterSaleTotals.supply);

  const [record] = await db
    .select()
    .from(companySaleRecords)
    .where(eq(companySaleRecords.companyId, company.id))
    .limit(1);
  check(
    "sale: a permanent sale record was written with price, sales figure and multiplier",
    !!record &&
      record.price === 1200 &&
      record.salesFigure === 800 &&
      record.multiplierBp === 15000 &&
      record.txRef === purchase.txRef,
    record,
  );

  const [soldListing] = await db
    .select()
    .from(companySaleListings)
    .where(eq(companySaleListings.id, listing.id))
    .limit(1);
  check("sale: listing marked SOLD", soldListing.status === "SOLD", soldListing.status);

  await expectError(
    "sale: a sold listing cannot be bought again",
    () => purchaseListing({ listingId: listing.id, buyerUserId: customer.id }),
    "already been sold",
  );

  // --- Government offer requires acceptance -----------------------------------
  const offer = await makeOffer({
    companyId: company.id,
    offerorUserId: null, // Government
    amount: 2000,
    message: "The Government would like to acquire this company.",
  });
  check("offer: Government offer recorded as PENDING", offer.status === "PENDING");

  const [duringOffer] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, company.id))
    .limit(1);
  check(
    "offer: ownership does NOT move while the offer is merely pending",
    duringOffer.ownerUserId === buyer.id && !duringOffer.governmentOwned,
  );

  await expectError(
    "offer: someone who is not the owner cannot accept it",
    () => respondToOffer({ offerId: offer.id, ownerUserId: customer.id, accept: true }),
    "current owner",
  );

  const declinedOffer = await makeOffer({
    companyId: company.id,
    offerorUserId: customer.id,
    amount: 50,
  });
  await respondToOffer({ offerId: declinedOffer.id, ownerUserId: buyer.id, accept: false });
  const [declined] = await db
    .select()
    .from(companySaleOffers)
    .where(eq(companySaleOffers.id, declinedOffer.id))
    .limit(1);
  check("offer: declining leaves ownership untouched", declined.status === "DECLINED");

  const ownerBeforeAccept = (
    await db.select().from(users).where(eq(users.id, buyer.id)).limit(1)
  )[0];
  const treasuryBeforeAccept = (await totals()).treasury;

  const accepted = await respondToOffer({
    offerId: offer.id,
    ownerUserId: buyer.id,
    accept: true,
  });

  const [afterAcquire] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, company.id))
    .limit(1);
  const ownerAfterAccept = (
    await db.select().from(users).where(eq(users.id, buyer.id)).limit(1)
  )[0];
  const afterAcceptTotals = await totals();

  check("offer: accepted status recorded", accepted.offer.status === "ACCEPTED");
  check(
    "offer: the owner was paid the offer amount from the treasury",
    ownerAfterAccept.balance === ownerBeforeAccept.balance + 2000 &&
      afterAcceptTotals.treasury === treasuryBeforeAccept - 2000,
    { before: ownerBeforeAccept.balance, after: ownerAfterAccept.balance },
  );
  check(
    "offer: the company is now under Government stewardship",
    afterAcquire.governmentOwned === true && afterAcquire.governmentAcquiredAt !== null,
  );
  check(
    "offer: supply unchanged by the acquisition",
    afterAcceptTotals.supply === start.supply,
  );
  check(
    "offer: supply invariant holds",
    afterAcceptTotals.accounted === afterAcceptTotals.supply,
  );

  console.log("\n=== GOVERNMENT LOANS ===\n");

  // Give the company back to a real owner so it can borrow.
  await db
    .update(companies)
    .set({ governmentOwned: false, governmentAcquiredAt: null, ownerUserId: buyer.id })
    .where(eq(companies.id, company.id));

  const [borrower] = await db.select().from(companies).where(eq(companies.id, company.id)).limit(1);

  const loan = await applyForLoan({
    company: borrower,
    appliedByUserId: buyer.id,
    amount: 10000,
    purpose: "Expand the gym",
  });
  check("loan: application created as PENDING", loan.status === "PENDING");

  await expectError(
    "loan: a company cannot have two open applications",
    () =>
      applyForLoan({
        company: borrower,
        appliedByUserId: buyer.id,
        amount: 500,
        purpose: "again",
      }),
    "already has a loan",
  );

  const approvedLoan = await approveLoan({
    loanId: loan.id,
    governmentId: gov.id,
    governmentUsername: gov.username,
  });
  check(
    "loan: approved with frozen terms — 10,000 @10%, 2 instalments",
    approvedLoan.loan.principal === 10000 &&
      approvedLoan.loan.interestRateBp === 1000 &&
      approvedLoan.loan.totalPayable === 11000 &&
      approvedLoan.loan.instalmentCount === 2,
    approvedLoan.loan,
  );

  const [notYetDisbursed] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, company.id))
    .limit(1);
  check(
    "loan: no Aeros moves on approval alone (company must accept first)",
    notYetDisbursed.balance === coAfterSale.balance,
    notYetDisbursed.balance,
  );

  // A later policy change must not affect this already-approved loan.
  await db.update(government).set({ loanInterestRateBp: 2500 }).where(eq(government.id, gov.id));

  const beforeDisburse = await totals();
  const accepted2 = await acceptLoan({ loanId: loan.id, acceptingUserId: buyer.id });
  const afterDisburse = await totals();

  const [coAfterLoan] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, company.id))
    .limit(1);

  check(
    "loan: the frozen 10% rate survived a policy change to 25%",
    accepted2.loan.interestRateBp === 1000 && accepted2.loan.totalPayable === 11000,
    { rate: accepted2.loan.interestRateBp, total: accepted2.loan.totalPayable },
  );
  check("loan: status is ACTIVE after acceptance", accepted2.loan.status === "ACTIVE");
  check(
    "loan: treasury funded the principal and the company received it",
    afterDisburse.treasury === beforeDisburse.treasury - 10000 &&
      coAfterLoan.balance === notYetDisbursed.balance + 10000,
    { beforeDisburse, afterDisburse, companyBalance: coAfterLoan.balance },
  );
  check(
    "loan: disbursement creates NO new Aeros (supply unchanged)",
    afterDisburse.supply === beforeDisburse.supply,
  );
  check("loan: supply invariant holds", afterDisburse.accounted === afterDisburse.supply);

  check(
    "loan: two instalments generated, 5,500 each (5,000 principal + 500 interest)",
    accepted2.instalments.length === 2 &&
      accepted2.instalments.every(
        (i) => i.totalDue === 5500 && i.principalPortion === 5000 && i.interestPortion === 500,
      ),
    accepted2.instalments.map((i) => ({
      seq: i.sequence,
      p: i.principalPortion,
      int: i.interestPortion,
      total: i.totalDue,
    })),
  );

  const dueDays = accepted2.instalments.map((i) =>
    Math.round((i.dueAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
  );
  check("loan: instalments due in 7 and 14 days", dueDays[0] === 7 && dueDays[1] === 14, dueDays);

  // --- repayment -------------------------------------------------------------
  const inst1 = accepted2.instalments[0];
  const beforeRepay = await totals();
  const repay1 = await payInstalment({ instalmentId: inst1.id, payingUserId: buyer.id });
  const afterRepay = await totals();

  check(
    "loan: repayment moved 5,500 from the company wallet to the treasury",
    afterRepay.treasury === beforeRepay.treasury + 5500,
    { before: beforeRepay.treasury, after: afterRepay.treasury },
  );
  check("loan: repayment does not change supply", afterRepay.supply === beforeRepay.supply);
  check("loan: supply invariant holds after repayment", afterRepay.accounted === afterRepay.supply);
  check(
    "loan: principal/interest split recorded (5,000 / 500)",
    repay1.loan.principalPaid === 5000 && repay1.loan.interestPaid === 500,
    { p: repay1.loan.principalPaid, i: repay1.loan.interestPaid },
  );

  await expectError(
    "loan: paying the same instalment twice is rejected",
    () => payInstalment({ instalmentId: inst1.id, payingUserId: buyer.id }),
    "already been paid",
  );

  const summaryMid = await getLoanSummary(loan.id);
  check(
    "loan: dashboard shows 5,500 paid and 5,500 remaining",
    summaryMid!.paid === 5500 && summaryMid!.remaining === 5500,
    { paid: summaryMid!.paid, remaining: summaryMid!.remaining },
  );

  // --- overdue + reminders ----------------------------------------------------
  const inst2 = accepted2.instalments[1];
  await db
    .update(loanInstalments)
    .set({ dueAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000) })
    .where(eq(loanInstalments.id, inst2.id));

  const maintenance = await runLoanMaintenance();
  const [overdueInst] = await db
    .select()
    .from(loanInstalments)
    .where(eq(loanInstalments.id, inst2.id))
    .limit(1);

  check(
    "loan: an elapsed instalment is marked OVERDUE",
    overdueInst.status === "OVERDUE",
    overdueInst.status,
  );
  check(
    "loan: an escalating reminder was issued for it",
    maintenance.remindersSent >= 1 && overdueInst.lastReminderStage === "OVERDUE_3D",
    { sent: maintenance.remindersSent, stage: overdueInst.lastReminderStage },
  );

  const secondRun = await runLoanMaintenance();
  check(
    "loan: re-running maintenance does not re-send the same reminder",
    secondRun.remindersSent === 0,
    secondRun,
  );

  // --- Government default action ----------------------------------------------
  const defaulted = await recordLoanAction({
    loanId: loan.id,
    governmentId: gov.id,
    governmentUsername: gov.username,
    action: "DEFAULT",
    reason: "Instalment 2 unpaid past the grace period.",
  });
  check("loan: Government can declare a default", defaulted.status === "DEFAULTED");

  const [coDuringDefault] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, company.id))
    .limit(1);
  check(
    "loan: declaring default does NOT seize the company wallet or its ownership",
    coDuringDefault.balance === coAfterLoan.balance - 5500 &&
      coDuringDefault.ownerUserId === buyer.id,
    { balance: coDuringDefault.balance, owner: coDuringDefault.ownerUserId === buyer.id },
  );

  // --- restructure ---------------------------------------------------------------
  const restructured = await recordLoanAction({
    loanId: loan.id,
    governmentId: gov.id,
    governmentUsername: gov.username,
    action: "RESTRUCTURE",
    reason: "Agreed a new schedule with the owner.",
    restructureIntervalDays: 10,
  });
  check("loan: restructuring is recorded", restructured.status === "RESTRUCTURED");

  const [rescheduled] = await db
    .select()
    .from(loanInstalments)
    .where(eq(loanInstalments.id, inst2.id))
    .limit(1);
  const newDueDays = Math.round(
    (rescheduled.dueAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
  );
  check(
    "loan: the outstanding instalment was rescheduled 10 days out and reset to PENDING",
    newDueDays === 10 && rescheduled.status === "PENDING",
    { newDueDays, status: rescheduled.status },
  );
  check(
    "loan: restructuring preserved the agreed principal and interest split",
    rescheduled.principalPortion === 5000 && rescheduled.interestPortion === 500,
    rescheduled,
  );

  // --- completion -----------------------------------------------------------------
  const repay2 = await payInstalment({ instalmentId: inst2.id, payingUserId: buyer.id });
  check("loan: fully repaid loan becomes PAID", repay2.loan.status === "PAID", repay2.loan.status);
  check(
    "loan: totals add up — 10,000 principal + 1,000 interest repaid",
    repay2.loan.principalPaid === 10000 && repay2.loan.interestPaid === 1000,
    { p: repay2.loan.principalPaid, i: repay2.loan.interestPaid },
  );

  const finalSummary = await getLoanSummary(loan.id);
  check("loan: nothing remaining", finalSummary!.remaining === 0, finalSummary!.remaining);

  console.log("\n=== ISSUANCE (SIMPLE MAJORITY) ===\n");

  check("issuance: 5 eligible -> 3 approvals needed", requiredMajority(5) === 3);
  check("issuance: 4 eligible -> 3 approvals needed", requiredMajority(4) === 3);
  check("issuance: 2 eligible -> 2 approvals needed", requiredMajority(2) === 2);
  check("issuance: 1 eligible -> 1 approval needed", requiredMajority(1) === 1);

  const voters = await db.select().from(users).where(eq(users.status, "ACTIVE"));
  const majorityNeeded = requiredMajority(voters.length);

  // Below-majority first, while no cooldown is in force, so the approval
  // check is the thing actually being exercised.
  const weakRequest = await createIssuanceRequest({
    governmentId: gov.id,
    governmentUsername: gov.username,
    amount: 500,
    reason: "Should fail on votes",
  });
  await castIssuanceVote({ requestId: weakRequest.id, userId: voters[0].id, vote: "APPROVE" });
  await expectError(
    "issuance: a request below the majority threshold cannot execute",
    () =>
      executeIssuance({
        requestId: weakRequest.id,
        governmentId: gov.id,
        governmentUsername: gov.username,
      }),
    "Approval requirement has not been met",
  );

  const request = await createIssuanceRequest({
    governmentId: gov.id,
    governmentUsername: gov.username,
    amount: 3000,
    reason: "Majority-vote test",
  });

  // Approve with exactly the majority, reject with one, leave the rest silent.
  for (let i = 0; i < majorityNeeded; i++) {
    await castIssuanceVote({ requestId: request.id, userId: voters[i].id, vote: "APPROVE" });
  }
  if (voters.length > majorityNeeded) {
    await castIssuanceVote({
      requestId: request.id,
      userId: voters[majorityNeeded].id,
      vote: "REJECT",
    });
  }

  const progress = await getApprovalProgress(request.id);
  check(
    "issuance: a simple majority is enough (unanimity is no longer required)",
    progress.thresholdReached && progress.approveCount === majorityNeeded,
    progress,
  );
  check(
    "issuance: non-voters are not counted as approvals",
    progress.pendingCount ===
      voters.length - majorityNeeded - (voters.length > majorityNeeded ? 1 : 0),
    progress,
  );

  await expectError(
    "issuance: a voter cannot vote twice",
    () => castIssuanceVote({ requestId: request.id, userId: voters[0].id, vote: "REJECT" }),
    "already voted",
  );

  const beforeIssuance = await totals();
  await executeIssuance({
    requestId: request.id,
    governmentId: gov.id,
    governmentUsername: gov.username,
  });
  const afterIssuance = await totals();

  check(
    "issuance: execution increases BOTH treasury and total supply by exactly 3,000",
    afterIssuance.treasury === beforeIssuance.treasury + 3000 &&
      afterIssuance.supply === beforeIssuance.supply + 3000,
    { beforeIssuance, afterIssuance },
  );
  check(
    "issuance: supply invariant still holds after new supply is created",
    afterIssuance.accounted === afterIssuance.supply,
    afterIssuance,
  );

  await expectError(
    "issuance: the same request cannot be executed twice",
    () =>
      executeIssuance({
        requestId: request.id,
        governmentId: gov.id,
        governmentUsername: gov.username,
      }),
    "already been executed",
  );

  // V2.1: daily IST calendar-day limit (replaces the old rolling 7-day
  // cooldown) — at most one issuance execution per India Standard Time
  // calendar day. `request` above was just executed a moment ago, so this
  // one — created, voted and attempted in the same IST calendar day — must
  // be blocked. (The "next IST calendar day is allowed again" half of this
  // rule is covered separately in scripts/test/test_issuance.ts, which
  // backdates a prior execution's `executedAt` to exercise it without
  // waiting for a real day to roll over.)
  const request3 = await createIssuanceRequest({
    governmentId: gov.id,
    governmentUsername: gov.username,
    amount: 100,
    reason: "Daily IST limit test",
  });
  for (let i = 0; i < majorityNeeded; i++) {
    await castIssuanceVote({ requestId: request3.id, userId: voters[i].id, vote: "APPROVE" });
  }
  await expectError(
    "issuance: the daily IST calendar-day limit blocks a second execution the same day",
    () =>
      executeIssuance({
        requestId: request3.id,
        governmentId: gov.id,
        governmentUsername: gov.username,
      }),
    "one Aeros issuance is allowed per",
  );

  console.log("\n=== FINAL INVARIANT ===\n");
  const final = await totals();
  check(
    "INVARIANT: supply = treasury + users + companies at the very end",
    final.supply === final.accounted,
    final,
  );
  check(
    "INVARIANT: supply only grew by the 3,000 that was actually issued",
    final.supply === start.supply + 3000,
    { start: start.supply, end: final.supply },
  );

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  await pool.end();
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
