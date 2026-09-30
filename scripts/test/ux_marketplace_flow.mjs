/**
 * V3 PHASE C BROWSER PASS — offer → browse/search → order → invoice → payment
 *
 * Drives the real UI in Chromium against the running dev server, one browser
 * context per identity. Same conventions as scripts/test/ux_invoice_flow.mjs:
 * assertions read `main` (never document.body, which contains the RSC payload),
 * and every login waits for `main` to actually have content.
 *
 *   SELLER   switches to the company wallet, adds a listing, sees the order in
 *            Pending, issues the invoice, and finally sees COMPLETED.
 *   BUYER    browses the Market, finds the listing by SEARCH, orders it, pays
 *            the invoice, and sees COMPLETED.
 *
 * Screenshots (desktop + mobile) are written to the scratchpad so the visual
 * identity can be checked by eye.
 */
import pkg from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const { chromium } = pkg;
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:3000";
const OUT = "/tmp/claude-0/-home-claude/6bf5a121-37f3-5310-bd4e-7b5a4a104ba8/scratchpad/shots-c";
mkdirSync(OUT, { recursive: true });

const RUN = process.env.UX_RUN ?? "c1";
const SELLER = `uxseller_${RUN}`;
const BUYER = `uxbuyer_${RUN}`;
const COMPANY = `Uma Threads ${RUN}`;
const PASSWORD = "TestPassword123";
// Unique per invocation, so "searching narrows the list to ONE listing" stays a
// real assertion when the script is run more than once against the same
// database.
const STAMP = Date.now().toString(36).slice(-4);
const ITEM = `Alpaca Scarf ${RUN}${STAMP}`;
const PRICE = 300;
const QUANTITY = 2;
const SUBTOTAL = PRICE * QUANTITY; // 600
// The company tax rate is Government-configurable, so the expected tax is read
// from the database rather than hardcoded — a UX run must not fail merely
// because the Government changed the rate. The point of the assertion is that
// the UI agrees with the server, not that the rate is any particular number.
const { Client } = await import("pg");
const _pg = new Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/aeros_pay" });
await _pg.connect();
const COMPANY_TAX_BP = Number(
  (await _pg.query("select company_tax_rate_bp from government limit 1")).rows[0].company_tax_rate_bp,
);
await _pg.end();
const TAX = Math.floor((SUBTOTAL * COMPANY_TAX_BP) / 10000);
// The buyer pays exactly the price; the tax comes out of the seller company's proceeds.
const TOTAL = SUBTOTAL;

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

async function login(page, username) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill("#username", username);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 25000 });
  await page.locator("main").filter({ hasText: /\S/ }).first().waitFor({ timeout: 25000 });
}

/** Text of the real page content only — never document.body (RSC payload). */
async function mainText(page) {
  return page.locator("main").innerText();
}

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});

try {
  // ---------------------------------------------------------------- SELLER ---
  const sellerCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const seller = await sellerCtx.newPage();
  seller.on("pageerror", (e) => console.log("   [seller pageerror]", e.message));
  await login(seller, SELLER);

  check(
    "seller: nav offers the new Market destination alongside the old Companies one",
    (await seller.locator("header").getByRole("link", { name: "Market", exact: true }).count()) > 0 &&
      (await seller.locator("header").getByRole("link", { name: "Companies", exact: true }).count()) > 0,
  );

  // Switch to the company wallet — creating a listing REQUIRES acting as the company.
  await seller.getByRole("button", { name: new RegExp(COMPANY) }).click();
  await seller.waitForTimeout(1500);
  check(
    "seller: acting-as banner shows the company wallet",
    (await seller.locator("body").locator("text=company wallet").count()) > 0,
  );

  await seller.goto(`${BASE}/my-company/offers`, { waitUntil: "networkidle" });
  const offersText = await mainText(seller);
  check(
    "seller: My listings page renders with the add-a-listing form",
    /My listings/.test(offersText) && /Add a listing/.test(offersText),
    offersText.slice(0, 200),
  );
  await seller.screenshot({ path: `${OUT}/01-my-listings-desktop.png`, fullPage: true });

  await seller.fill("#offerTitle", ITEM);
  await seller.fill("#offerDescription", "Hand-spun alpaca, woven in the studio.");
  await seller.fill("#offerCategory", "Clothing");
  await seller.fill("#offerPrice", String(PRICE));
  await seller.fill("#offerQuantity", "5");
  await seller.getByRole("button", { name: "Add listing" }).click();
  await seller.locator("form").getByText("Listing added.").waitFor({ timeout: 20000 });
  check("seller: listing created", true);

  await seller.goto(`${BASE}/my-company/offers`, { waitUntil: "networkidle" });
  const afterAdd = await mainText(seller);
  check(
    "seller: the new listing is ACTIVE with its price and stock",
    afterAdd.includes(ITEM) && /ACTIVE/.test(afterAdd) && afterAdd.includes("5 available"),
    afterAdd.slice(0, 400),
  );
  await seller.screenshot({ path: `${OUT}/02-listing-created-desktop.png`, fullPage: true });

  // Pause/resume, to see the timestamps behave in the real UI.
  await seller.getByRole("button", { name: "Pause" }).first().click();
  await seller.waitForTimeout(1500);
  const pausedText = await mainText(seller);
  check(
    "seller: pausing shows PAUSED and the moment it was paused",
    /PAUSED/.test(pausedText) && /Paused \d/.test(pausedText),
    pausedText.slice(0, 300),
  );
  await seller.getByRole("button", { name: "Resume" }).first().click();
  await seller.waitForTimeout(1500);
  const resumedText = await mainText(seller);
  check(
    "seller: resuming clears the paused note and the listing is ACTIVE again",
    /ACTIVE/.test(resumedText) && !/Paused \d/.test(resumedText),
    resumedText.slice(0, 300),
  );

  // ----------------------------------------------------------------- BUYER ---
  const buyerCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const buyer = await buyerCtx.newPage();
  buyer.on("pageerror", (e) => console.log("   [buyer pageerror]", e.message));
  await login(buyer, BUYER);

  await buyer.goto(`${BASE}/market`, { waitUntil: "networkidle" });
  const marketText = await mainText(buyer);
  check(
    "buyer: the Market page renders and is clearly not the company-sale marketplace",
    /^Market\b/m.test(marketText) &&
      /Goods and services/.test(marketText) &&
      /Companies for sale/.test(marketText),
    marketText.slice(0, 300),
  );
  check("buyer: the new listing is browsable", marketText.includes(ITEM), marketText.slice(0, 400));
  await buyer.screenshot({ path: `${OUT}/03-market-browse-desktop.png`, fullPage: true });

  // SEARCH for it (debounced; the server re-queries from the URL).
  await buyer.fill("#marketQ", ITEM);
  await buyer.waitForURL(/[?&]q=/, { timeout: 15000 });
  await buyer.waitForTimeout(2500);
  const searchText = await mainText(buyer);
  check(
    "buyer: searching narrows the list to the matching listing",
    searchText.includes(ITEM) && /1 listing/.test(searchText),
    searchText.slice(0, 400),
  );
  await buyer.screenshot({ path: `${OUT}/04-market-search-desktop.png`, fullPage: true });

  // A search that matches nothing.
  await buyer.fill("#marketQ", "zzz-no-such-listing");
  await buyer.waitForTimeout(2500);
  const emptyText = await mainText(buyer);
  check(
    "buyer: a search with no matches says so rather than showing everything",
    /No listings matched/.test(emptyText),
    emptyText.slice(0, 250),
  );
  await buyer.fill("#marketQ", ITEM);
  await buyer.waitForTimeout(2500);

  await buyer.getByText(ITEM).first().click();
  await buyer.waitForURL(/\/market\/offers\/[0-9a-f-]{36}$/, { timeout: 20000 });
  const offerUrl = buyer.url();
  const detail = await mainText(buyer);
  check(
    "buyer: the listing page shows the seller, price, stock and category",
    detail.includes(ITEM) &&
      detail.includes(COMPANY) &&
      detail.includes(String(PRICE)) &&
      /Clothing/.test(detail) &&
      /ACTIVE/.test(detail),
    detail.slice(0, 400),
  );
  await buyer.screenshot({ path: `${OUT}/05-offer-detail-desktop.png`, fullPage: true });

  await buyer.fill("#orderQuantity", String(QUANTITY));
  await buyer.waitForTimeout(500);
  const orderFormText = await mainText(buyer);
  check(
    `buyer: the order form multiplies out the server's snapshot price (${QUANTITY} × ${PRICE} = ${SUBTOTAL})`,
    orderFormText.includes(String(SUBTOTAL)) && /Nothing is charged yet/.test(orderFormText),
    orderFormText.slice(0, 400),
  );
  await buyer.getByRole("button", { name: "Place order" }).click();
  await buyer.locator('[data-testid="order-placed"]').waitFor({ timeout: 25000 });
  const placed = await buyer.locator('[data-testid="order-placed"]').innerText();
  const orderNumber = placed.match(/(ORD-\d{8}-\d{4})/)?.[1];
  check(
    "buyer: the server confirmed the order with a real order number",
    /Order placed/.test(placed) && !!orderNumber,
    placed,
  );
  console.log(`   order: ${orderNumber}`);
  await buyer.screenshot({ path: `${OUT}/06-order-placed-desktop.png`, fullPage: true });

  await buyer.goto(`${BASE}/market/orders`, { waitUntil: "networkidle" });
  const buyerOrders = await mainText(buyer);
  check(
    "buyer: the order appears in My orders as PENDING",
    buyerOrders.includes(orderNumber) && /PENDING/.test(buyerOrders),
    buyerOrders.slice(0, 400),
  );
  await buyer.screenshot({ path: `${OUT}/07-my-orders-desktop.png`, fullPage: true });

  // ------------------------------------------------- SELLER SEES THE ORDER ---
  await seller.goto(`${BASE}/my-company/orders`, { waitUntil: "networkidle" });
  const sellerOrders = await mainText(seller);
  check(
    "seller: the order is in the company's Orders area, PENDING, with the buyer named",
    sellerOrders.includes(orderNumber) &&
      /PENDING/.test(sellerOrders) &&
      sellerOrders.includes(`@${BUYER}`),
    sellerOrders.slice(0, 500),
  );
  check(
    "seller: the six order areas from the spec are present as buckets",
    /All orders/.test(sellerOrders) &&
      /Pending/.test(sellerOrders) &&
      /Waiting for invoice/.test(sellerOrders) &&
      /Payment due/.test(sellerOrders) &&
      /Invoices/.test(sellerOrders) &&
      /Completed/.test(sellerOrders),
  );
  await seller.screenshot({ path: `${OUT}/08-company-orders-pending-desktop.png`, fullPage: true });

  await seller.goto(`${BASE}/my-company/orders?bucket=PENDING`, { waitUntil: "networkidle" });
  const pendingBucket = await mainText(seller);
  check(
    "seller: the Pending Orders bucket contains exactly this order",
    pendingBucket.includes(orderNumber),
    pendingBucket.slice(0, 300),
  );

  await seller.getByRole("button", { name: "Accept order" }).first().click();
  await seller.waitForTimeout(2000);
  await seller.goto(`${BASE}/my-company/orders?bucket=WAITING_FOR_INVOICE`, {
    waitUntil: "networkidle",
  });
  const waitingBucket = await mainText(seller);
  check(
    "seller: once accepted the order moves to Waiting for invoice",
    waitingBucket.includes(orderNumber) && /ACCEPTED/.test(waitingBucket),
    waitingBucket.slice(0, 400),
  );
  await seller.screenshot({ path: `${OUT}/09-waiting-for-invoice-desktop.png`, fullPage: true });

  // Issue the invoice. No amounts are typed — the order carries them.
  //
  // Success is read from the SERVER's durable state rather than from the
  // ephemeral panel: raising the invoice moves the order to PAYMENT_DUE, so the
  // row leaves this bucket and the form that rendered it unmounts. The
  // Payment due bucket is the authoritative answer.
  await seller.getByRole("button", { name: "Send invoice" }).first().click();
  await seller.waitForTimeout(3000);
  await seller.screenshot({ path: `${OUT}/10-invoice-issued-desktop.png`, fullPage: true });

  await seller.goto(`${BASE}/my-company/orders?bucket=PAYMENT_DUE`, { waitUntil: "networkidle" });
  const dueBucket = await mainText(seller);
  const invoiceNumber = dueBucket.match(/(INV-\d{8}-\d{4})/)?.[1];
  check(
    "seller: the order is now in Payment due, linked to the canonical invoice",
    dueBucket.includes(orderNumber) && !!invoiceNumber && /PAYMENT DUE/.test(dueBucket),
    dueBucket.slice(0, 500),
  );
  check(
    `seller: the invoice was raised from the order for ${TOTAL} (price ${SUBTOTAL}; ${TAX} tax comes out of the seller's share)`,
    dueBucket.includes(String(TOTAL)),
    dueBucket.slice(0, 500),
  );
  console.log(`   invoice: ${invoiceNumber}`);

  await seller.goto(`${BASE}/my-company/orders?bucket=WAITING_FOR_INVOICE`, {
    waitUntil: "networkidle",
  });
  const waitingAfter = await mainText(seller);
  check(
    "seller: the order left the Waiting for invoice bucket once it was invoiced",
    !waitingAfter.includes(orderNumber),
    waitingAfter.slice(0, 300),
  );

  // ------------------------------------------------------------ BUYER PAYS ---
  await buyer.goto(`${BASE}/market/orders`, { waitUntil: "networkidle" });
  const buyerDue = await mainText(buyer);
  check(
    "buyer: their order shows PAYMENT DUE with the invoice linked",
    buyerDue.includes(invoiceNumber) && /PAYMENT DUE/.test(buyerDue),
    buyerDue.slice(0, 400),
  );

  await buyer.goto(`${BASE}/invoices`, { waitUntil: "networkidle" });
  const received = await mainText(buyer);
  check(
    "buyer: the order's invoice is in Received invoices, through the normal invoice screen",
    received.includes(ITEM) && received.includes(String(TOTAL)),
    received.slice(0, 400),
  );

  await buyer.getByText(ITEM).first().click();
  await buyer.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 20000 });
  const invoiceUrl = buyer.url();
  const invoiceDetail = await mainText(buyer);
  check(
    "buyer: the invoice shows the frozen breakdown and offers Pay",
    invoiceDetail.includes(COMPANY) &&
      invoiceDetail.includes(String(SUBTOTAL)) &&
      new RegExp(`Tax \\(${(COMPANY_TAX_BP / 100).toFixed(2)}%\\)`).test(invoiceDetail) &&
      invoiceDetail.includes(String(TOTAL)) &&
      new RegExp(`Pay ${TOTAL}`).test(invoiceDetail),
    invoiceDetail.slice(0, 500),
  );
  await buyer.screenshot({ path: `${OUT}/11-order-invoice-desktop.png`, fullPage: true });

  await buyer.getByRole("button", { name: new RegExp(`^Pay ${TOTAL}`) }).click();
  await buyer.getByRole("button", { name: "Confirm payment" }).click();
  await buyer
    .locator('[data-testid="invoice-receipt"], [data-testid="invoice-paid"]')
    .first()
    .waitFor({ timeout: 30000 });
  const receipt = await buyer
    .locator('[data-testid="invoice-receipt"], [data-testid="invoice-paid"]')
    .first()
    .innerText();
  const ref = receipt.match(/(TX-\d{8}-\d{6})/)?.[1];
  check(
    "buyer: the payment is server-confirmed with a real ledger reference",
    /paid/i.test(receipt) && !!ref,
    receipt,
  );
  console.log(`   payment ref: ${ref}`);
  await buyer.screenshot({ path: `${OUT}/12-order-paid-desktop.png`, fullPage: true });

  await buyer.goto(`${BASE}/market/orders`, { waitUntil: "networkidle" });
  const buyerPaid = await mainText(buyer);
  check(
    "buyer: the order is PAID and carries the same ledger reference",
    /\bPAID\b/.test(buyerPaid) && buyerPaid.includes(ref),
    buyerPaid.slice(0, 400),
  );

  // ------------------------------------------------------------- COMPLETE ----
  const orderRowLink = buyer.getByText(ITEM).first();
  await orderRowLink.click();
  await buyer.waitForURL(/\/market\/orders\/[0-9a-f-]{36}$/, { timeout: 20000 });
  await buyer.getByRole("button", { name: "Mark completed" }).click();
  await buyer.waitForTimeout(2500);
  await buyer.reload({ waitUntil: "networkidle" });
  const buyerCompleted = await mainText(buyer);
  check(
    "buyer: the order shows COMPLETED on their side",
    /COMPLETED/.test(buyerCompleted),
    buyerCompleted.slice(0, 400),
  );
  await buyer.screenshot({ path: `${OUT}/13-order-completed-buyer-desktop.png`, fullPage: true });

  await seller.goto(`${BASE}/my-company/orders?bucket=COMPLETED`, { waitUntil: "networkidle" });
  const sellerCompleted = await mainText(seller);
  check(
    "seller: the same order shows COMPLETED in the company's Completed Orders area",
    sellerCompleted.includes(orderNumber) && /COMPLETED/.test(sellerCompleted),
    sellerCompleted.slice(0, 500),
  );
  check(
    "seller: the completed order still links its invoice and its ledger reference",
    sellerCompleted.includes(invoiceNumber) && sellerCompleted.includes(ref),
    sellerCompleted.slice(0, 500),
  );
  await seller.screenshot({ path: `${OUT}/14-order-completed-seller-desktop.png`, fullPage: true });

  // The money landed in the COMPANY wallet, visible on the company dashboard.
  await seller.goto(`${BASE}/my-company`, { waitUntil: "networkidle" });
  const companyDash = await mainText(seller);
  check(
    "seller: the company dashboard links the new Listings, Orders and Promotions areas",
    /Listings/.test(companyDash) && /Orders/.test(companyDash) && /Promotions/.test(companyDash),
    companyDash.slice(0, 500),
  );
  await seller.screenshot({ path: `${OUT}/15-company-dashboard-desktop.png`, fullPage: true });

  await seller.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
  const sellerTx = await mainText(seller);
  check(
    "seller: the settlement appears in the COMPANY's activity with the same reference",
    sellerTx.includes(ref),
    sellerTx.slice(0, 400),
  );

  // -------------------------------------------------------------- WANTED -----
  await buyer.goto(`${BASE}/market/wanted`, { waitUntil: "networkidle" });
  const wantedPage = await mainText(buyer);
  check(
    "buyer: the Wanted page renders with its post form",
    /Wanted/.test(wantedPage) && /Post what you are looking for/.test(wantedPage),
    wantedPage.slice(0, 250),
  );
  await buyer.fill("#wantedHeading", `Wanted: wool yarn ${RUN}`);
  await buyer.fill("#wantedDescription", "Ten balls of undyed wool yarn.");
  await buyer.fill("#wantedCategory", "Materials");
  await buyer.fill("#wantedQuantity", "10");
  await buyer.fill("#wantedBudget", "400");
  await buyer.getByRole("button", { name: "Post request" }).click();
  await buyer.locator("form").getByText("Request posted.").waitFor({ timeout: 20000 });
  await buyer.goto(`${BASE}/market/wanted`, { waitUntil: "networkidle" });
  const wantedAfter = await mainText(buyer);
  check(
    "buyer: the wanted request is listed as OPEN",
    wantedAfter.includes(`Wanted: wool yarn ${RUN}`) && /OPEN/.test(wantedAfter),
    wantedAfter.slice(0, 400),
  );
  await buyer.screenshot({ path: `${OUT}/16-wanted-desktop.png`, fullPage: true });

  // ------------------------------------------------------------ CONTRACTS ----
  await seller.goto(`${BASE}/market/contracts`, { waitUntil: "networkidle" });
  const contractsPage = await mainText(seller);
  check(
    "seller: the Contracts page renders with the tender form for a company",
    /Contracts/.test(contractsPage) && /Put work out to tender/.test(contractsPage),
    contractsPage.slice(0, 250),
  );
  await seller.screenshot({ path: `${OUT}/17-contracts-desktop.png`, fullPage: true });

  // ----------------------------------------------------------- PROMOTIONS ----
  await seller.goto(`${BASE}/my-company/promotions`, { waitUntil: "networkidle" });
  const promoPage = await mainText(seller);
  check(
    "seller: the Promotions page renders and explains the single ad slot and its rate",
    /Promotions/.test(promoPage) && /ad slot/.test(promoPage) && /per day/.test(promoPage),
    promoPage.slice(0, 300),
  );
  check(
    "seller: the page states plainly that nothing about ads is recorded",
    /no impression, click or dismissal counts/.test(promoPage),
    promoPage.slice(-300),
  );
  await seller.screenshot({ path: `${OUT}/18-promotions-desktop.png`, fullPage: true });

  // ------------------------------------------- THE AD SLOT (PHASE E) --------
  //
  // The live promotion is seeded by scripts/test/seed_ux_promotion.ts before
  // this script runs (see the runner below). It is an OFFICIAL Government
  // promotion — no company and a zero daily rate — so exercising the ad UI
  // moves no Aeros.
  //
  // The Government PANEL itself is not driven here: this environment has no
  // working Government password, and resetting a live admin credential to run
  // a test would be the wrong trade. The panel's pages are type-checked and
  // its actions are covered by the library suite instead.
  const AD_HEADING = process.env.UX_AD_HEADING;
  if (AD_HEADING) {
    await buyer.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await buyer.locator('[data-testid="promotion-slot"]').waitFor({ timeout: 20000 });
    const slot = await buyer.locator('[data-testid="promotion-slot"]').innerText();
    check(
      "buyer: the single ad slot renders the live promotion on the dashboard",
      slot.includes(AD_HEADING) && /Government notice/.test(slot),
      slot,
    );
    check(
      "buyer: the slot says plainly that dismissing it records nothing",
      /nothing about ads is recorded/.test(slot),
      slot,
    );
    await buyer.screenshot({ path: `${OUT}/27-ad-slot-desktop.png`, fullPage: true });

    await buyer.getByRole("button", { name: "Dismiss this promotion" }).click();
    await buyer.waitForTimeout(500);
    check(
      "buyer: the X hides the ad immediately",
      (await buyer.locator('[data-testid="promotion-slot"]').count()) === 0,
    );
    await buyer.screenshot({ path: `${OUT}/28-ad-dismissed-desktop.png`, fullPage: true });

    await buyer.reload({ waitUntil: "networkidle" });
    await buyer.locator('[data-testid="promotion-slot"]').waitFor({ timeout: 20000 });
    check(
      "buyer: reloading brings it back, because the dismissal was stored nowhere",
      (await buyer.locator('[data-testid="promotion-slot"]').innerText()).includes(AD_HEADING),
    );

    await buyer.goto(`${BASE}/market`, { waitUntil: "networkidle" });
    check(
      "buyer: the same slot renders on the Market page",
      (await buyer.locator('[data-testid="promotion-slot"]').count()) === 1,
    );
    await buyer.screenshot({ path: `${OUT}/29-ad-slot-market-desktop.png`, fullPage: true });
  }

  // --------------------------------------------------------------- MOBILE ----
  const mobileCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const mob = await mobileCtx.newPage();
  await login(mob, BUYER);
  const mobDash = await mainText(mob);
  check(
    "mobile: the dashboard offers Market as a quick action (the tab bar stays at five items)",
    /Market/.test(mobDash),
    mobDash.slice(0, 300),
  );
  await mob.screenshot({ path: `${OUT}/20-dashboard-mobile.png`, fullPage: true });

  await mob.goto(`${BASE}/market`, { waitUntil: "networkidle" });
  await mob.screenshot({ path: `${OUT}/21-market-mobile.png`, fullPage: true });
  const mobMarket = await mainText(mob);
  check("mobile: the Market browses on a phone", mobMarket.includes(ITEM), mobMarket.slice(0, 250));

  await mob.goto(offerUrl, { waitUntil: "networkidle" });
  await mob.screenshot({ path: `${OUT}/22-offer-detail-mobile.png`, fullPage: true });

  await mob.goto(`${BASE}/market/orders`, { waitUntil: "networkidle" });
  await mob.screenshot({ path: `${OUT}/23-my-orders-mobile.png`, fullPage: true });
  const mobOrders = await mainText(mob);
  check("mobile: My orders renders the completed order", /COMPLETED/.test(mobOrders));

  await mob.goto(invoiceUrl, { waitUntil: "networkidle" });
  await mob.screenshot({ path: `${OUT}/24-order-invoice-mobile.png`, fullPage: true });

  const mobSellerCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const mobSeller = await mobSellerCtx.newPage();
  await login(mobSeller, SELLER);
  await mobSeller.getByRole("button", { name: new RegExp(COMPANY) }).click();
  await mobSeller.waitForTimeout(1500);
  await mobSeller.goto(`${BASE}/my-company/orders`, { waitUntil: "networkidle" });
  await mobSeller.screenshot({ path: `${OUT}/25-company-orders-mobile.png`, fullPage: true });
  await mobSeller.goto(`${BASE}/my-company/offers`, { waitUntil: "networkidle" });
  await mobSeller.screenshot({ path: `${OUT}/26-my-listings-mobile.png`, fullPage: true });

  console.log(`\n=== BROWSER: ${pass} passed, ${fail} failed ===`);
} finally {
  await browser.close();
}

process.exit(fail > 0 ? 1 : 0);
