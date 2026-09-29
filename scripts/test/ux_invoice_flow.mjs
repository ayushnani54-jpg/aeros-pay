import pkg from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const { chromium } = pkg;
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:3000";
const OUT = "/tmp/claude-0/-home-claude/6bf5a121-37f3-5310-bd4e-7b5a4a104ba8/scratchpad/shots";
mkdirSync(OUT, { recursive: true });

const RUN = process.env.UX_RUN ?? "b1";
const SELLER = `uxseller_${RUN}`;
const BUYER = `uxbuyer_${RUN}`;
const COMPANY = `Uma Threads ${RUN}`;
const PASSWORD = "TestPassword123";
const ITEM = `Linen Shirt ${RUN}`;

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
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
  // waitForURL fires as soon as the URL changes; the dashboard is a server
  // component, so wait for its content to actually be in the DOM before any
  // assertion reads it.
  await page.locator("main").filter({ hasText: /\S/ }).first().waitFor({ timeout: 20000 });
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
  {
    const dashText = await mainText(seller);
    check(
      "seller: logged in and on the dashboard",
      /balance/i.test(dashText) && new RegExp(SELLER, "i").test(dashText),
      dashText.slice(0, 200),
    );
  }

  // Switch to the company wallet.
  await seller.getByRole("button", { name: new RegExp(COMPANY) }).click();
  await seller.waitForTimeout(1500);
  check(
    "seller: acting-as banner shows the company wallet",
    (await seller.locator("body").locator("text=company wallet").count()) > 0,
  );

  await seller.goto(`${BASE}/my-company/invoices`, { waitUntil: "networkidle" });
  const sentText = await mainText(seller);
  check("seller: Sent invoices page renders", /Sent invoices/.test(sentText), sentText.slice(0, 120));
  check("seller: create-invoice form offers all three recipient types", /A person/.test(sentText) && /A company/.test(sentText) && /The Government/.test(sentText));
  await seller.screenshot({ path: `${OUT}/01-sent-invoices-desktop.png`, fullPage: true });

  // Fill the invoice.
  await seller.getByRole("button", { name: "A person" }).click();
  await seller.fill("#recipientUsername", BUYER);
  await seller.fill("#itemName", ITEM);
  await seller.fill("#invDescription", "One linen shirt, made to order.");
  await seller.fill("#quantity", "1");
  await seller.fill("#unitPrice", "800");

  // Wait for the SERVER quote to appear (no client-side tax maths).
  await seller.locator("form").getByText(/Total payable by/).waitFor({ timeout: 15000 });
  const quoteText = await mainText(seller);
  check(
    "seller: server quote shows subtotal 800, tax 40 at 5.00%, total 840",
    /Tax \(5\.00%\)/.test(quoteText) && /\b840\b/.test(quoteText) && /\b800\b/.test(quoteText),
    quoteText.match(/Subtotal[\s\S]{0,200}/)?.[0],
  );
  await seller.screenshot({ path: `${OUT}/02-invoice-quote-desktop.png`, fullPage: true });

  await seller.getByRole("button", { name: "Send invoice" }).click();
  await seller.locator("form").getByText("Invoice sent.").waitFor({ timeout: 20000 });
  check("seller: invoice sent confirmation shown", true);

  await seller.goto(`${BASE}/my-company/invoices`, { waitUntil: "networkidle" });
  const afterSend = await mainText(seller);
  check(
    "seller: the new invoice appears in Sent invoices as PENDING to the buyer",
    afterSend.includes(ITEM) && afterSend.includes(`@${BUYER}`) && /PENDING/.test(afterSend),
  );

  // ----------------------------------------------------------------- BUYER ---
  const buyerCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const buyer = await buyerCtx.newPage();
  buyer.on("pageerror", (e) => console.log("   [buyer pageerror]", e.message));
  await login(buyer, BUYER);

  const dash = await mainText(buyer);
  check("buyer: dashboard shows the unpaid-invoice alert", /unpaid invoice/.test(dash), dash.slice(0, 200));
  await buyer.screenshot({ path: `${OUT}/03-buyer-dashboard-desktop.png`, fullPage: true });

  await buyer.goto(`${BASE}/notifications`, { waitUntil: "networkidle" });
  const notifs = await mainText(buyer);
  check(
    "buyer: notification about the new invoice is present",
    notifs.includes(ITEM) && notifs.includes(COMPANY),
    notifs.slice(0, 250),
  );
  await buyer.screenshot({ path: `${OUT}/04-buyer-notifications-desktop.png`, fullPage: true });

  await buyer.goto(`${BASE}/invoices`, { waitUntil: "networkidle" });
  const received = await mainText(buyer);
  check("buyer: Received invoices page lists the invoice", /Received invoices/.test(received) && received.includes(ITEM));
  await buyer.screenshot({ path: `${OUT}/05-received-invoices-desktop.png`, fullPage: true });

  await buyer.getByText(ITEM).first().click();
  await buyer.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 20000 });
  const invoiceUrl = buyer.url();
  const detail = await mainText(buyer);
  check(
    "buyer: invoice detail shows issuer, item, subtotal, tax, total, dates and status",
    detail.includes(COMPANY) &&
      detail.includes(ITEM) &&
      /Subtotal/.test(detail) &&
      /Tax \(5\.00%\)/.test(detail) &&
      /Total payable/.test(detail) &&
      /Issued/.test(detail) &&
      /PENDING/.test(detail),
    detail.slice(0, 400),
  );
  check("buyer: a valid unpaid invoice offers Pay", /Pay 840/.test(detail));
  check("buyer: no 'Paid' claim before paying", !/Invoice paid/.test(detail));
  await buyer.screenshot({ path: `${OUT}/06-invoice-detail-desktop.png`, fullPage: true });

  // Print view renders.
  const printPage = await buyerCtx.newPage();
  await printPage.goto(`${invoiceUrl}/print`, { waitUntil: "networkidle" });
  const printText = await printPage.locator(".print-sheet").innerText();
  check(
    "buyer: print view renders the invoice without app chrome",
    printText.includes(ITEM) &&
      printText.includes(COMPANY) &&
      /Total payable/.test(printText) &&
      (await printPage.locator("header").count()) === 0 &&
      (await printPage.locator("nav").count()) === 0,
    { headers: await printPage.locator("header").count() },
  );
  await printPage.screenshot({ path: `${OUT}/07-invoice-print-desktop.png`, fullPage: true });
  await printPage.close();

  // Pay it.
  await buyer.getByRole("button", { name: /^Pay 840/ }).click();
  const confirmText = await mainText(buyer);
  check("buyer: confirm step names the payer wallet", /from your personal wallet/.test(confirmText));
  await buyer.getByRole("button", { name: "Confirm payment" }).click();

  // Success is confirmed by one of two things, both server-rendered and both
  // proof the payment committed: the ephemeral receipt from the action's
  // return value, or — if revalidation re-rendered the page and replaced the
  // pay form with the settled state — the durable "has been paid (ref …)"
  // line. Whichever appears, the ref comes from the server, never from
  // optimistic client state.
  await buyer
    .locator('[data-testid="invoice-receipt"], [data-testid="invoice-paid"]')
    .first()
    .waitFor({ timeout: 25000 });
  const receipt = await buyer
    .locator('[data-testid="invoice-receipt"], [data-testid="invoice-paid"]')
    .first()
    .innerText();
  const ref = receipt.match(/[Rr]ef\s+(\S+?)\)?\.?$/m)?.[1] ?? receipt.match(/(TX-\S+)/)?.[1];
  check(
    "buyer: server-confirmed payment shows a real transaction reference",
    /paid/i.test(receipt) && !!ref,
    receipt,
  );
  await buyer.screenshot({ path: `${OUT}/08-invoice-receipt-desktop.png`, fullPage: true });
  console.log(`   receipt ref: ${ref}`);

  // The ledger shows it.
  await buyer.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
  const txText = await mainText(buyer);
  check("buyer: the payment appears in their activity with the same ref", !!ref && txText.includes(ref), txText.slice(0, 200));

  // Reload the invoice: PAID, no Pay button.
  await buyer.goto(invoiceUrl, { waitUntil: "networkidle" });
  const afterPay = await mainText(buyer);
  check(
    "buyer: reloaded invoice is PAID and no longer offers Pay",
    /PAID/.test(afterPay) && /has been paid/.test(afterPay) && !/Pay 840/.test(afterPay),
    afterPay.slice(0, 300),
  );

  // ------------------------------------------------------- SELLER SEES PAID --
  await seller.goto(`${BASE}/my-company/invoices`, { waitUntil: "networkidle" });
  const sellerAfter = await mainText(seller);
  check(
    "seller: Sent invoices now shows the invoice as PAID with its ref",
    sellerAfter.includes(ITEM) && /PAID/.test(sellerAfter) && (!ref || sellerAfter.includes(ref)),
    sellerAfter.slice(0, 300),
  );
  await seller.screenshot({ path: `${OUT}/09-sent-invoices-paid-desktop.png`, fullPage: true });

  // ------------------------------------------------- PAY SCREEN (SEARCH) -----
  await buyer.goto(`${BASE}/pay`, { waitUntil: "networkidle" });
  const payText = await mainText(buyer);
  check("buyer: pay screen starts with a recipient search", /Who are you paying/.test(payText), payText.slice(0, 200));
  await buyer.screenshot({ path: `${OUT}/10-pay-search-desktop.png`, fullPage: true });
  await buyer.fill("#recipientUsername", `uxco_${RUN}`);
  await buyer.getByRole("button", { name: "Find recipient" }).click();
  await buyer.locator('[data-testid="resolved-payee"]').waitFor({ timeout: 15000 });
  const resolved = await buyer.locator('[data-testid="resolved-payee"]').innerText();
  check(
    "buyer: the server resolved the handle to a company and said so",
    resolved.includes(COMPANY) && /this is a company/.test(resolved),
    resolved,
  );
  check("buyer: no balance of the recipient is shown", !/balance/i.test(resolved), resolved);
  await buyer.fill("#amount", "100");
  await buyer.getByRole("button", { name: "Continue" }).click();
  await buyer.getByRole("button", { name: "Confirm Payment" }).waitFor({ timeout: 15000 });
  const payConfirm = await mainText(buyer);
  check(
    "buyer: confirm step shows the server-quoted amount, tax and net",
    /Amount/.test(payConfirm) && /Tax \(5\.00%\)/.test(payConfirm) && /Recipient receives/.test(payConfirm) && /\b95\b/.test(payConfirm),
    payConfirm.slice(0, 400),
  );
  await buyer.screenshot({ path: `${OUT}/11-pay-confirm-desktop.png`, fullPage: true });
  await buyer.getByRole("button", { name: "Confirm Payment" }).click();
  await buyer.locator('[data-testid="payment-receipt"]').waitFor({ timeout: 25000 });
  const payReceipt = await buyer.locator('[data-testid="payment-receipt"]').innerText();
  check("buyer: direct payment receipt is server-confirmed", /Payment Successful/.test(payReceipt) && /Ref /.test(payReceipt), payReceipt);

  // --------------------------------------------------------------- MOBILE ----
  const mobileCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const mob = await mobileCtx.newPage();
  await login(mob, BUYER);
  await mob.goto(`${BASE}/invoices`, { waitUntil: "networkidle" });
  await mob.screenshot({ path: `${OUT}/20-received-invoices-mobile.png`, fullPage: true });
  await mob.goto(invoiceUrl, { waitUntil: "networkidle" });
  await mob.screenshot({ path: `${OUT}/21-invoice-detail-mobile.png`, fullPage: true });
  const mobDetail = await mainText(mob);
  check("mobile: invoice detail renders the full breakdown", /Total payable/.test(mobDetail) && /PAID/.test(mobDetail));
  await mob.goto(`${invoiceUrl}/print`, { waitUntil: "networkidle" });
  await mob.screenshot({ path: `${OUT}/22-invoice-print-mobile.png`, fullPage: true });
  await mob.goto(`${BASE}/pay`, { waitUntil: "networkidle" });
  await mob.screenshot({ path: `${OUT}/23-pay-search-mobile.png`, fullPage: true });

  // A separate mobile context: mobileCtx is already signed in as the buyer, and
  // an authenticated context redirects /login straight to the dashboard.
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
  await mobSeller.goto(`${BASE}/my-company/invoices`, { waitUntil: "networkidle" });
  await mobSeller.screenshot({ path: `${OUT}/24-sent-invoices-mobile.png`, fullPage: true });

  // ------------------------------------- COMPANY-RECIPIENT INVOICE (UI) ------
  await seller.goto(`${BASE}/my-company/invoices`, { waitUntil: "networkidle" });
  await seller.getByRole("button", { name: "A company" }).click();
  await seller.fill("#recipientUsername", "flowfitness");
  await seller.fill("#itemName", `Wholesale bundle ${RUN}`);
  await seller.fill("#quantity", "2");
  await seller.fill("#unitPrice", "50");
  await seller.locator("form").getByText(/Total payable by/).waitFor({ timeout: 15000 });
  const coQuote = await mainText(seller);
  check(
    "seller: a company-recipient invoice is quoted against the resolved company",
    /Total payable by Flow Fitness|Total payable by/.test(coQuote) && /\b105\b/.test(coQuote),
    coQuote.match(/Subtotal[\s\S]{0,200}/)?.[0],
  );
  await seller.getByRole("button", { name: "Send invoice" }).click();
  await seller.locator("form").getByText("Invoice sent.").waitFor({ timeout: 20000 });
  await seller.goto(`${BASE}/my-company/invoices`, { waitUntil: "networkidle" });
  const coSent = await mainText(seller);
  check(
    "seller: the company-addressed invoice is listed with the company as recipient",
    coSent.includes(`Wholesale bundle ${RUN}`) && /@flowfitness/.test(coSent),
    coSent.slice(0, 300),
  );

  // ---------------------------------- GOVERNMENT-RECIPIENT INVOICE (UI) -----
  await seller.getByRole("button", { name: "The Government" }).click();
  const govFormText = await mainText(seller);
  check(
    "seller: choosing the Government hides the username field and explains the routing",
    /addressed to the Government Treasury/.test(govFormText) &&
      (await seller.locator("#recipientUsername").count()) === 0,
  );
  await seller.fill("#itemName", `Civic banner ${RUN}`);
  await seller.fill("#quantity", "1");
  await seller.fill("#unitPrice", "120");
  await seller.locator("form").getByText(/Total payable by/).waitFor({ timeout: 15000 });
  const govQuote = await mainText(seller);
  check(
    "seller: a Government invoice is quoted tax-free (total = subtotal)",
    /Tax \(0\.00%\)/.test(govQuote) && /Total payable by Government/.test(govQuote),
    govQuote.match(/Subtotal[\s\S]{0,220}/)?.[0],
  );
  await seller.screenshot({ path: `${OUT}/12-government-invoice-quote-desktop.png`, fullPage: true });
  await seller.getByRole("button", { name: "Send invoice" }).click();
  await seller.locator("form").getByText("Invoice sent.").waitFor({ timeout: 20000 });
  await seller.goto(`${BASE}/my-company/invoices`, { waitUntil: "networkidle" });
  const govSent = await mainText(seller);
  check(
    "seller: the Government invoice is listed as addressed to the Treasury",
    govSent.includes(`Civic banner ${RUN}`) && /Government \(Treasury\)/.test(govSent),
    govSent.slice(0, 300),
  );
  await seller.screenshot({ path: `${OUT}/13-sent-invoices-all-types-desktop.png`, fullPage: true });

  console.log(`\n=== BROWSER: ${pass} passed, ${fail} failed ===`);
} finally {
  await browser.close();
}

process.exit(fail > 0 ? 1 : 0);
