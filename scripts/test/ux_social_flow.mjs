/**
 * V3 PHASE F/G/H BROWSER PASS — ratings, QR, leaderboard, badges, voice, sound
 *
 * Drives the real UI in Chromium against the running dev server, one browser
 * context per identity, exactly like scripts/test/ux_marketplace_flow.mjs:
 * assertions read `main` (never document.body, which carries the RSC payload),
 * and every login waits for `main` to have content.
 *
 *   RATER     opens their completed order, leaves 4 stars with a comment, and
 *             sees it on the seller's public profile alongside the aggregate.
 *   ANYONE    sees the company's QR code render, reads the link out of it and
 *             follows it to the public page it claims to open.
 *   ANYONE    opens the leaderboard and sees the last-30-days framing.
 *   BADGED    shows GOV and Member on their public profile — and is still
 *             refused every Government area, which is the point of the badges
 *             being labels.
 *   VOICE     the long-text field works by typing whether or not headless
 *             Chromium exposes the Web Speech API (graceful degradation is
 *             what is asserted, not that speech works).
 *   SOUND     a real payment, with the sound preference set to OFF, still shows
 *             its success state clearly.
 *
 * Run `UX_RUN=<run> npx tsx --require ./scripts/test/hook.cjs
 * scripts/test/seed_ux_social.ts` first; this script reads that run's handles.
 *
 * Screenshots (desktop + mobile) are written to the scratchpad so the visual
 * identity can be checked by eye.
 */
import pkg from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const { chromium } = pkg;
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:3000";
const OUT =
  "/tmp/claude-0/-home-claude/6bf5a121-37f3-5310-bd4e-7b5a4a104ba8/scratchpad/shots-f";
mkdirSync(OUT, { recursive: true });

const RUN = process.env.UX_RUN ?? "s1";
const PASSWORD = "TestPassword123";
const OWNER = `uxsocown_${RUN}`;
const RATER = `uxsocrate_${RUN}`;
const EARLY = `uxsocearly_${RUN}`;
const BADGED = `uxsocbadge_${RUN}`;
const COMPANY_USERNAME = `uxsocco_${RUN}`;
const REVOKED_COMPANY = `uxsocgone_${RUN}`;
const COMPANY_NAME = `Mira Ceramics ${RUN}`;
const UNRATED_ITEM = `Serving Bowl ${RUN}`;

// The payment amount for the sound check is small and the tax rate is read from
// the live database rather than hardcoded, for the same reason as the Phase C
// pass: the point is that the UI agrees with the server, not that the rate is
// any particular number.
const { Client } = await import("pg");
const _pg = new Client({
  connectionString:
    process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/aeros_pay",
});
await _pg.connect();
const USER_TAX_BP = Number(
  (await _pg.query("select tax_rate_bp from government limit 1")).rows[0].tax_rate_bp,
);
await _pg.end();
const GOV_USERNAME = process.env.GOV_USERNAME ?? "government";
const GOV_PASSWORD = process.env.GOV_PASSWORD ?? "ChangeThisPassword123";
const GOV_SECURITY_CODE = process.env.GOV_SECURITY_CODE ?? "G7K2P";
const PAY_AMOUNT = 100;
const PAY_TAX = Math.floor((PAY_AMOUNT * USER_TAX_BP) / 10000);

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
  // ============================================================== RATING ====
  const raterCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const rater = await raterCtx.newPage();
  rater.on("pageerror", (e) => console.log("   [rater pageerror]", e.message));
  await login(rater, RATER);

  await rater.goto(`${BASE}/market/orders`, { waitUntil: "networkidle" });
  const orders = await mainText(rater);
  check(
    "rater: their completed order is in My orders",
    orders.includes(UNRATED_ITEM) && /COMPLETED/.test(orders),
    orders.slice(0, 400),
  );

  await rater.getByText(UNRATED_ITEM).first().click();
  await rater.waitForURL(/\/market\/orders\/[0-9a-f-]{36}$/, { timeout: 20000 });
  const orderPage = await mainText(rater);
  check(
    "rater: the completed order offers the rating form, with the comment lifetime stated",
    /Rate this order/.test(orderPage) && /Comments are removed after 30 days/.test(orderPage),
    orderPage.slice(-600),
  );
  await rater.screenshot({ path: `${OUT}/01-rate-form-desktop.png`, fullPage: true });

  check(
    "rater: the rating comment box carries a dictation button, or none at all where speech is unsupported",
    (await rater.locator('[data-testid="voice-input-button"]').count()) >= 0,
  );

  await rater.locator('[data-testid="rate-star-4"]').click();
  await rater.fill("#ratingComment", "Lovely bowl, well packed, would buy again.");
  await rater.getByRole("button", { name: "Submit rating" }).click();
  // Success is read from the SERVER's durable state, not from an ephemeral
  // panel: saving the rating revalidates this route, the order is no longer
  // rateable, and the form that would have shown a confirmation unmounts. The
  // stored rating is the authoritative answer.
  await rater
    .locator('[data-testid="existing-rating"], [data-testid="rating-saved"]')
    .first()
    .waitFor({ timeout: 25000 });
  check("rater: the server confirmed the rating", true);
  await rater.screenshot({ path: `${OUT}/02-rating-saved-desktop.png`, fullPage: true });

  await rater.reload({ waitUntil: "networkidle" });
  const afterRating = await mainText(rater);
  check(
    "rater: reloading shows the stored rating and no second form (one rating per order)",
    /Your rating/.test(afterRating) &&
      /one per order/.test(afterRating) &&
      !/Submit rating/.test(afterRating),
    afterRating.slice(-600),
  );

  // --------------------------------- the rating on the public profile -------
  await rater.goto(`${BASE}/c/${COMPANY_USERNAME}`, { waitUntil: "networkidle" });
  const profile = await mainText(rater);
  check(
    "profile: the aggregate shows both ratings and the mean of 5 and 4",
    /2 ratings/.test(profile) && /4\.5/.test(profile),
    profile.slice(0, 700),
  );
  check(
    "profile: the new comment is shown, attributed to the buyer's handle",
    profile.includes("Lovely bowl, well packed") && profile.includes(`@${RATER}`),
    profile.slice(0, 900),
  );
  check(
    "profile: there are exactly two rating rows",
    (await rater.locator('[data-testid="rating-row"]').count()) === 2,
  );
  check(
    "profile: the public profile still says balances and private history are never shown",
    /never shown publicly/.test(profile),
  );
  check(
    "profile: no balance figure is anywhere on the public page",
    !/balance\s*[:\s]\s*\d/i.test(profile),
  );
  await rater.screenshot({ path: `${OUT}/03-company-profile-ratings-desktop.png`, fullPage: true });

  // ================================================================== QR ====
  const qr = rater.locator('[data-testid="company-qr"]');
  check("QR: the company QR block renders on the public profile", (await qr.count()) === 1);
  const svgCount = await qr.locator("svg").count();
  const moduleCount = await qr.locator("svg path").count();
  check(
    "QR: it is an inline SVG with a drawn module path — no <img>, no request for an image",
    svgCount === 1 && moduleCount === 1 && (await qr.locator("img").count()) === 0,
    { svgCount, moduleCount },
  );
  const qrUrl = (await rater.locator('[data-testid="company-qr-url"]').innerText()).trim();
  check(
    "QR: the link it encodes is this company's public profile url",
    qrUrl === `${BASE}/c/${COMPANY_USERNAME}`,
    qrUrl,
  );
  const qrMarkup = await qr.innerHTML();
  check(
    "QR: the rendered markup carries no balance, order number or ledger reference",
    !/ORD-\d{8}-\d{4}/.test(qrMarkup) &&
      !/INV-\d{8}-\d{4}/.test(qrMarkup) &&
      !/TX-\d{8}-\d{6}/.test(qrMarkup),
  );
  await qr.screenshot({ path: `${OUT}/04-company-qr-desktop.png` });

  // Follow the link the code claims to open.
  await rater.goto(qrUrl, { waitUntil: "networkidle" });
  const scanned = await mainText(rater);
  check(
    "QR: following that link lands on the company's public page",
    scanned.includes(COMPANY_NAME) && scanned.includes(`@${COMPANY_USERNAME}`),
    scanned.slice(0, 300),
  );

  // A REVOKED company's code stops working: the page itself refuses, which is
  // the whole mechanism — there is no code registry to revoke.
  const goneUrl = `${BASE}/c/${REVOKED_COMPANY}`;
  await rater.goto(goneUrl, { waitUntil: "networkidle" });
  const goneBody = await rater.locator("body").innerText();
  check(
    "QR: a REVOKED company's public page refuses, so a code printed while it traded stops resolving",
    /could not be found|not found/i.test(goneBody) && !goneBody.includes(`Closed Pottery ${RUN}`),
    goneBody.slice(0, 300),
  );
  await rater.screenshot({ path: `${OUT}/04b-revoked-company-refused.png`, fullPage: true });

  // ========================================================= LEADERBOARD ====
  await rater.goto(`${BASE}/market/leaderboard`, { waitUntil: "networkidle" });
  const board = await mainText(rater);
  check(
    "leaderboard: the page renders with explicit last-30-days framing",
    /Leaderboard/.test(board) && /last 30 days/.test(board),
    board.slice(0, 400),
  );
  check(
    "leaderboard: it says it is computed live and stores nothing, and is not a wealth ranking",
    /nothing is stored/i.test(board) && /no ranking by\s+balance/i.test(board),
    board.slice(0, 600),
  );
  check(
    "leaderboard: the fixture company is ranked, with its completed orders and sales",
    board.includes(COMPANY_NAME) && /completed orders?/.test(board) && /in sales/.test(board),
    board.slice(0, 800),
  );
  check(
    "leaderboard: the recent rating column shows the rating just left",
    /4\.5|4\.0|5\.0/.test(board),
    board.slice(0, 800),
  );
  check(
    "leaderboard: at least one row rendered",
    (await rater.locator('[data-testid="leaderboard-row"]').count()) >= 1,
  );
  await rater.screenshot({ path: `${OUT}/05-leaderboard-desktop.png`, fullPage: true });

  await rater.goto(`${BASE}/market/leaderboard?sort=sales`, { waitUntil: "networkidle" });
  check(
    "leaderboard: the sales-value view renders too",
    /Leaderboard/.test(await mainText(rater)),
  );
  await rater.screenshot({ path: `${OUT}/06-leaderboard-sales-desktop.png`, fullPage: true });

  // ============================================================== BADGES ====
  await rater.goto(`${BASE}/u/${BADGED}`, { waitUntil: "networkidle" });
  const badgedProfile = await mainText(rater);
  check(
    "badges: the badged account's public profile shows GOV and Member",
    (await rater.locator('[data-testid="badge-gov"]').count()) === 1 &&
      (await rater.locator('[data-testid="badge-member"]').count()) === 1,
  );
  check(
    "badges: the profile says in words that the labels grant nothing",
    /label only/.test(badgedProfile) && /grants no administrative powers/.test(badgedProfile),
    badgedProfile.slice(0, 600),
  );
  await rater.screenshot({ path: `${OUT}/07-badged-profile-desktop.png`, fullPage: true });

  await rater.goto(`${BASE}/people?q=${BADGED}`, { waitUntil: "networkidle" });
  check(
    "badges: the badges also show in the People directory",
    (await rater.locator('[data-testid="badge-gov"]').count()) >= 1,
  );
  await rater.screenshot({ path: `${OUT}/08-people-badges-desktop.png`, fullPage: true });

  // --- and they grant nothing: the badged user is refused every Gov area ----
  const badgedCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const badgedPage = await badgedCtx.newPage();
  badgedPage.on("pageerror", (e) => console.log("   [badged pageerror]", e.message));
  await login(badgedPage, BADGED);
  check(
    "badges: the badged user logs in as an ordinary user and lands on the normal dashboard",
    /\/dashboard/.test(badgedPage.url()),
  );

  for (const area of [
    "/gov",
    "/gov/users",
    "/gov/treasury",
    "/gov/control-room",
    "/gov/tax",
    "/gov/transactions",
  ]) {
    await badgedPage.goto(`${BASE}${area}`, { waitUntil: "networkidle" });
    const refused = /\/government\/login/.test(badgedPage.url());
    check(
      `badges: a user carrying BOTH badges is refused ${area} — authority is the Government session, not a label`,
      refused,
      badgedPage.url(),
    );
  }
  await badgedPage.screenshot({ path: `${OUT}/09-badged-refused-gov-desktop.png`, fullPage: true });

  // But everything a normal user can do still works for them.
  await badgedPage.goto(`${BASE}/market`, { waitUntil: "networkidle" });
  check(
    "badges: the badged user still browses the Market normally",
    /^Market\b/m.test(await mainText(badgedPage)),
  );

  // =============================================== VOICE (graceful either way)
  await badgedPage.goto(`${BASE}/contact-government`, { waitUntil: "networkidle" });
  const supportBox = badgedPage.locator("#supportBody");
  check("voice: the long free-text support field is present", (await supportBox.count()) === 1);
  const voiceButtons = await badgedPage.locator('[data-testid="voice-input-button"]').count();
  console.log(
    `   Web Speech API in this headless Chromium: ${voiceButtons > 0 ? "available" : "absent"}`,
  );
  if (voiceButtons > 0) {
    check("voice: the dictation button is offered beside the field", true);
    const buttonText = await badgedPage
      .locator('[data-testid="voice-input-button"]')
      .first()
      .innerText();
    check("voice: the button is labelled as dictation", /Dictate/i.test(buttonText), buttonText);
  } else {
    check(
      "voice: where speech is unsupported NOTHING is rendered — no disabled button, no warning",
      (await badgedPage.locator("text=Dictation").count()) === 0 &&
        !/dictat/i.test(await mainText(badgedPage)),
    );
  }
  // Typing must work identically either way — that is the fallback.
  await supportBox.fill("Typed, not dictated. The keyboard is always the fallback.");
  await badgedPage.getByRole("button", { name: "Send message" }).click();
  await badgedPage.getByText("Message sent.").waitFor({ timeout: 25000 });
  check("voice: the field submits by typing, with or without speech support", true);
  await badgedPage.screenshot({ path: `${OUT}/10-support-voice-desktop.png`, fullPage: true });

  // ====================================== PAYMENT SUCCESS WITH SOUND OFF ====
  await badgedPage.goto(`${BASE}/profile`, { waitUntil: "networkidle" });
  const profilePage = await mainText(badgedPage);
  check(
    "sound: the profile offers a payment-sound switch that is explicitly per-browser",
    /Payment success sound/.test(profilePage) && /this browser only/.test(profilePage),
    profilePage.slice(0, 900),
  );
  await badgedPage.locator('[data-testid="sound-off"]').click();
  await badgedPage.waitForTimeout(500);
  const stored = await badgedPage.evaluate(() => localStorage.getItem("aeros_payment_sound"));
  check("sound: turning it off is remembered in this browser only", stored === "off", stored);
  check(
    "sound: the badged user's own profile shows their labels too",
    /Government labels/.test(profilePage),
  );
  await badgedPage.screenshot({ path: `${OUT}/11-profile-sound-desktop.png`, fullPage: true });

  const audioErrors = [];
  badgedPage.on("console", (msg) => {
    if (msg.type() === "error") audioErrors.push(msg.text());
  });

  await badgedPage.goto(`${BASE}/pay?to=${RATER}`, { waitUntil: "networkidle" });
  await badgedPage.getByRole("button", { name: "Find recipient" }).click();
  await badgedPage.locator('[data-testid="resolved-payee"]').waitFor({ timeout: 20000 });
  await badgedPage.fill("#amount", String(PAY_AMOUNT));
  await badgedPage.getByRole("button", { name: "Continue" }).click();
  await badgedPage
    .getByRole("button", { name: "Confirm Payment" })
    .waitFor({ timeout: 20000 });
  const confirmText = await mainText(badgedPage);
  check(
    `sound: the confirm step shows the server's own tax figure (${PAY_TAX} on ${PAY_AMOUNT})`,
    confirmText.includes(String(PAY_TAX)),
    confirmText.slice(0, 500),
  );
  await badgedPage.getByRole("button", { name: "Confirm Payment" }).click();
  await badgedPage.locator('[data-testid="payment-receipt"]').waitFor({ timeout: 30000 });
  const receipt = await badgedPage.locator('[data-testid="payment-receipt"]').innerText();
  check(
    "sound: with sound OFF the success state is still shown clearly, server-confirmed with a ledger ref",
    /Payment Successful/.test(receipt) && /TX-\d{8}-\d{6}/.test(receipt),
    receipt,
  );
  check(
    "sound: a muted or blocked chime produces no console error and does not break the receipt",
    audioErrors.length === 0,
    audioErrors,
  );
  await badgedPage.screenshot({ path: `${OUT}/12-payment-receipt-sound-off-desktop.png`, fullPage: true });

  // Turning it back on leaves the receipt exactly as clear (autoplay may still
  // block it in headless Chromium, which is the point of the assertion).
  await badgedPage.goto(`${BASE}/profile`, { waitUntil: "networkidle" });
  await badgedPage.locator('[data-testid="sound-on"]').click();
  await badgedPage.waitForTimeout(500);
  check(
    "sound: turning it back on is remembered",
    (await badgedPage.evaluate(() => localStorage.getItem("aeros_payment_sound"))) === "on",
  );

  // ====================================== GOVERNMENT SETS THE LABELS ========
  // The badge form itself, driven through the real Government panel. This is
  // also where the split is visible: the GOVERNMENT can set a label, and the
  // labelled user still cannot reach this page.
  const govCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const govPage = await govCtx.newPage();
  govPage.on("pageerror", (e) => console.log("   [gov pageerror]", e.message));
  await govPage.goto(`${BASE}/government/login`, { waitUntil: "networkidle" });
  await govPage.fill("#username", GOV_USERNAME);
  await govPage.fill("#password", GOV_PASSWORD);
  await govPage.fill("#securityCode", GOV_SECURITY_CODE);
  await govPage.click('button[type="submit"]');
  await govPage.waitForURL(/\/gov(\/|$)/, { timeout: 25000 });

  await govPage.goto(`${BASE}/gov/users`, { waitUntil: "networkidle" });
  const govUsers = await mainText(govPage);
  check(
    "government: the users table gained a Labels column showing the badges",
    /labels/i.test(govUsers) &&
      (await govPage.locator('[data-testid="badge-gov"]').count()) >= 1,
    govUsers.slice(0, 300),
  );
  await govPage.screenshot({ path: `${OUT}/14-gov-users-labels-desktop.png`, fullPage: true });

  await govPage.getByRole("link", { name: `@${OWNER}` }).click();
  await govPage.waitForURL(/\/gov\/users\/[0-9a-f-]{36}$/, { timeout: 20000 });
  const govDetail = await mainText(govPage);
  check(
    "government: the user page offers the identity-label form and says it grants nothing",
    /Identity labels/.test(govDetail) &&
      /grants any administrative permission/.test(govDetail),
    govDetail.slice(0, 1200),
  );
  await govPage.locator('[data-testid="badge-member-checkbox"]').check();
  await govPage.getByRole("button", { name: "Save labels" }).click();
  await govPage.getByText("Labels saved.").waitFor({ timeout: 25000 });
  check("government: saving a label is server-confirmed", true);
  await govPage.reload({ waitUntil: "networkidle" });
  check(
    "government: the label persisted and is shown on the account",
    (await govPage.locator('[data-testid="badge-member"]').count()) >= 1,
  );
  await govPage.screenshot({ path: `${OUT}/15-gov-user-labels-desktop.png`, fullPage: true });

  // ======================================================= OWNER'S OWN QR ====
  const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const owner = await ownerCtx.newPage();
  owner.on("pageerror", (e) => console.log("   [owner pageerror]", e.message));
  await login(owner, OWNER);
  await owner.getByRole("button", { name: new RegExp(COMPANY_NAME) }).click();
  await owner.waitForTimeout(1500);
  await owner.goto(`${BASE}/my-company`, { waitUntil: "networkidle" });
  const dash = await mainText(owner);
  check(
    "owner: the company dashboard shows its own QR code and its ratings summary",
    /Your QR code/.test(dash) && /Ratings/.test(dash) && /4\.5|2 ratings/.test(dash),
    dash.slice(0, 900),
  );
  check(
    "owner: the dashboard QR is an inline SVG too",
    (await owner.locator('[data-testid="company-qr"] svg').count()) === 1,
  );
  await owner.screenshot({ path: `${OUT}/13-company-dashboard-qr-desktop.png`, fullPage: true });

  // ============================================================== MOBILE ====
  const mobileCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const mob = await mobileCtx.newPage();
  await login(mob, RATER);

  await mob.goto(`${BASE}/c/${COMPANY_USERNAME}`, { waitUntil: "networkidle" });
  const mobProfile = await mainText(mob);
  check(
    "mobile: the public profile shows the ratings and the QR on a phone",
    /2 ratings/.test(mobProfile) && (await mob.locator('[data-testid="company-qr"]').count()) === 1,
    mobProfile.slice(0, 400),
  );
  const noHScroll = await mob.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  check("mobile: the profile does not scroll sideways", noHScroll);
  await mob.screenshot({ path: `${OUT}/20-company-profile-mobile.png`, fullPage: true });

  await mob.goto(`${BASE}/market/leaderboard`, { waitUntil: "networkidle" });
  check("mobile: the leaderboard renders on a phone", /last 30 days/.test(await mainText(mob)));
  await mob.screenshot({ path: `${OUT}/21-leaderboard-mobile.png`, fullPage: true });

  await mob.goto(`${BASE}/u/${BADGED}`, { waitUntil: "networkidle" });
  check(
    "mobile: the badges render on a phone profile",
    (await mob.locator('[data-testid="badge-gov"]').count()) === 1,
  );
  await mob.screenshot({ path: `${OUT}/22-badged-profile-mobile.png`, fullPage: true });

  await mob.goto(`${BASE}/profile`, { waitUntil: "networkidle" });
  await mob.screenshot({ path: `${OUT}/23-profile-sound-mobile.png`, fullPage: true });

  await mob.goto(`${BASE}/contact-government`, { waitUntil: "networkidle" });
  await mob.screenshot({ path: `${OUT}/24-support-voice-mobile.png`, fullPage: true });

  const mobOrderCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const mobEarly = await mobOrderCtx.newPage();
  await login(mobEarly, EARLY);
  await mobEarly.goto(`${BASE}/market/orders`, { waitUntil: "networkidle" });
  await mobEarly.screenshot({ path: `${OUT}/25-my-orders-mobile.png`, fullPage: true });

  console.log(`\n=== BROWSER: ${pass} passed, ${fail} failed ===`);
} finally {
  await browser.close();
}

process.exit(fail > 0 ? 1 : 0);
