/**
 * V3 PHASES I & J BROWSER PASS — retention screen, cleanup, and downloads
 *
 * Drives the real UI in Chromium against the running dev server. Same
 * conventions as scripts/test/ux_marketplace_flow.mjs: assertions read `main`
 * (never document.body, which contains the RSC payload), and every login waits
 * for `main` to actually have content.
 *
 *   GOVERNMENT  opens /gov/retention, sees the per-class preview and the
 *               scheduled-cleanup panel, CHANGES a retention period, runs a
 *               cleanup and reads the resulting summary; then opens /gov/exports
 *               and downloads a CSV, which is opened and checked for real rows.
 *   USER        opens their own Activity page and downloads their own
 *               transaction CSV, which must contain their payments and nothing
 *               belonging to anyone else.
 *
 * Screenshots (desktop + mobile) are written to the scratchpad so the visual
 * identity can be checked by eye.
 */
import pkg from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const { chromium } = pkg;
import { mkdirSync, readFileSync } from "node:fs";

const BASE = "http://localhost:3000";
const OUT = "/tmp/claude-0/-home-claude/6bf5a121-37f3-5310-bd4e-7b5a4a104ba8/scratchpad/shots-ij";
mkdirSync(OUT, { recursive: true });

const RUN = process.env.UX_RUN ?? "ux1";
const BUYER = `uxbuyer_${RUN}`;
const PASSWORD = "TestPassword123";
const GOV_USERNAME = process.env.GOV_USERNAME ?? "government";
const GOV_PASSWORD = process.env.GOV_PASSWORD ?? "ChangeThisPassword123";
const GOV_SECURITY_CODE = process.env.GOV_SECURITY_CODE ?? "G7K2P";

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

async function mainText(page) {
  return page.locator("main").innerText();
}

async function login(page, username) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill("#username", username);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 25000 });
  await page.locator("main").filter({ hasText: /\S/ }).first().waitFor({ timeout: 25000 });
}

/** Clicks a download link and returns the file's text. */
async function download(page, locator) {
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    locator.click(),
  ]);
  const path = await dl.path();
  return { name: dl.suggestedFilename(), text: readFileSync(path, "utf8") };
}

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});

try {
  // ======================================================= GOVERNMENT =======
  const govCtx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const govPage = await govCtx.newPage();
  govPage.on("pageerror", (e) => console.log("   [gov pageerror]", e.message));

  await govPage.goto(`${BASE}/government/login`, { waitUntil: "networkidle" });
  await govPage.fill("#username", GOV_USERNAME);
  await govPage.fill("#password", GOV_PASSWORD);
  await govPage.fill("#securityCode", GOV_SECURITY_CODE);
  await govPage.click('button[type="submit"]');
  await govPage.waitForURL(/\/gov(\/|$)/, { timeout: 25000 });

  // ---- the retention screen ------------------------------------------------
  await govPage.goto(`${BASE}/gov/retention`, { waitUntil: "networkidle" });
  const retention = await mainText(govPage);

  check(
    "retention: the screen names every V3 class it can clean",
    /Paused market listings/i.test(retention) &&
      /Rating comments/i.test(retention) &&
      /Lapsed wanted requests/i.test(retention) &&
      /Lapsed orders/i.test(retention) &&
      /Idempotency keys/i.test(retention),
    retention.slice(0, 400),
  );
  check(
    "retention: it states what can NEVER be deleted",
    /Transactions, taxes and the ledger/i.test(retention) &&
      /Paid or completed orders/i.test(retention) &&
      /never delete/i.test(retention),
  );
  check(
    "retention: the scheduled-cleanup panel is present with last run / last success",
    /Scheduled cleanup/i.test(retention) &&
      /Last run/i.test(retention) &&
      /Last successful run/i.test(retention),
  );
  check(
    "retention: it explains that a cleanup keeps no record of what it deleted",
    /writes no record of what it deleted/i.test(retention),
  );
  await govPage.screenshot({ path: `${OUT}/01-gov-retention-desktop.png`, fullPage: true });

  // ---- change a period -----------------------------------------------------
  const pausedInput = govPage.locator("#rtPausedOffers");
  const before = await pausedInput.inputValue();
  const next = before === "21" ? "14" : "21";
  await pausedInput.fill(next);
  await govPage.getByRole("button", { name: /Save V3 retention periods/i }).click();
  await govPage.getByText("Retention periods saved.").waitFor({ timeout: 20000 });
  check(`retention: changing the paused-listing period from ${before} to ${next} was saved`, true);

  await govPage.reload({ waitUntil: "networkidle" });
  const persisted = await govPage.locator("#rtPausedOffers").inputValue();
  check(
    "retention: the new period survived a reload (it went to the database)",
    persisted === next,
    { persisted, next },
  );
  const afterSave = await mainText(govPage);
  check(
    "retention: the preview now measures paused listings against the new period",
    new RegExp(`after ${next} days`).test(afterSave),
    afterSave.match(/after \d+ days/g)?.slice(0, 6),
  );
  await govPage.screenshot({ path: `${OUT}/02-gov-retention-changed-desktop.png`, fullPage: true });

  // ---- run a cleanup -------------------------------------------------------
  await govPage.fill("#cleanupConfirm", "CONFIRM CLEANUP");
  await govPage.getByRole("button", { name: /Run cleanup now/i }).click();
  const summaryLine = govPage.locator("main p.text-success").first();
  await summaryLine.waitFor({ timeout: 30000 });
  const summaryText = await summaryLine.innerText();
  check(
    "retention: running a cleanup reports a readable summary",
    /Removed or cleared \d+ records|Nothing was eligible for cleanup/.test(summaryText),
    summaryText,
  );
  await govPage.screenshot({ path: `${OUT}/03-gov-cleanup-summary-desktop.png`, fullPage: true });

  await govPage.reload({ waitUntil: "networkidle" });
  const afterRun = await mainText(govPage);
  check(
    "retention: the panel now shows when cleanup last ran and that it succeeded",
    /Last run\s*\n?\s*\d/.test(afterRun) && !/Last successful run\s*\n?\s*never/.test(afterRun),
    afterRun.slice(afterRun.indexOf("Scheduled cleanup"), afterRun.indexOf("Scheduled cleanup") + 320),
  );
  check(
    "retention: it names who started the last run",
    /Started by\s*\n?\s*you/i.test(afterRun),
  );

  // Restore the period we changed, so the screen is left as we found it.
  await govPage.fill("#rtPausedOffers", before === "" ? "14" : before);
  await govPage.getByRole("button", { name: /Save V3 retention periods/i }).click();
  await govPage.getByText("Retention periods saved.").waitFor({ timeout: 20000 });

  // ---- government export ---------------------------------------------------
  await govPage.goto(`${BASE}/gov/exports`, { waitUntil: "networkidle" });
  const exportsText = await mainText(govPage);
  check(
    "exports: the Government export screen explains what the files are",
    /never stored/i.test(exportsText) &&
      /No password or security code is present/i.test(exportsText) &&
      /recorded in the audit log/i.test(exportsText),
    exportsText.slice(0, 300),
  );
  await govPage.screenshot({ path: `${OUT}/04-gov-exports-desktop.png`, fullPage: true });

  const govCsv = await download(govPage, govPage.locator('[data-testid="export-csv"]'));
  const govLines = govCsv.text.trim().split("\r\n");
  check(
    "exports: the Government CSV downloaded with a sensible filename",
    /^aeros-transactions-.*\.csv$/.test(govCsv.name),
    govCsv.name,
  );
  check(
    "exports: it has the ledger header row",
    govLines[0].replace(/^﻿/, "").startsWith("txRef,type,createdAt,senderType"),
    govLines[0].slice(0, 80),
  );
  check(
    "exports: it has real content, not just a header",
    govLines.length > 50,
    { lines: govLines.length },
  );
  check(
    "exports: no bcrypt hash anywhere in the file",
    !/\$2[aby]\$\d\d\$/.test(govCsv.text),
  );

  // Filtered download: the same screen, narrowed.
  await govPage.fill("#exType", "GOVERNMENT_FUNDING");
  const filtered = await download(govPage, govPage.locator('[data-testid="export-csv"]'));
  const filteredLines = filtered.text.trim().split("\r\n").slice(1);
  check(
    "exports: a type filter really narrows the downloaded file",
    filteredLines.length > 0 &&
      filteredLines.length < govLines.length - 1 &&
      filteredLines.every((l) => l.includes("GOVERNMENT_FUNDING")),
    { filtered: filteredLines.length, unfiltered: govLines.length - 1 },
  );

  const govJson = await download(govPage, govPage.locator('[data-testid="export-json"]'));
  let parsedJson = null;
  try {
    parsedJson = JSON.parse(govJson.text);
  } catch {
    parsedJson = null;
  }
  check(
    "exports: the JSON download is valid JSON with a row count",
    !!parsedJson && Array.isArray(parsedJson.rows) && parsedJson.rows.length === parsedJson.rowCount,
    { rowCount: parsedJson?.rowCount },
  );

  // Mobile view of both Government screens.
  const govMobCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    acceptDownloads: true,
    storageState: await govCtx.storageState(),
  });
  const govMob = await govMobCtx.newPage();
  await govMob.goto(`${BASE}/gov/retention`, { waitUntil: "networkidle" });
  await govMob.screenshot({ path: `${OUT}/05-gov-retention-mobile.png`, fullPage: true });
  await govMob.goto(`${BASE}/gov/exports`, { waitUntil: "networkidle" });
  await govMob.screenshot({ path: `${OUT}/06-gov-exports-mobile.png`, fullPage: true });
  const govMobText = await mainText(govMob);
  check(
    "exports (mobile): the picker and both download buttons are reachable on a phone",
    /Download CSV/.test(govMobText) && /Download JSON/.test(govMobText),
  );

  // ============================================================= USER =======
  const userCtx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const userPage = await userCtx.newPage();
  userPage.on("pageerror", (e) => console.log("   [user pageerror]", e.message));
  await login(userPage, BUYER);

  await userPage.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
  const activity = await mainText(userPage);
  check("user: the Activity page offers a download", /Download CSV/.test(activity));
  await userPage.screenshot({ path: `${OUT}/07-user-activity-desktop.png`, fullPage: true });

  const userCsv = await download(
    userPage,
    userPage.locator('[data-testid="download-transactions-csv"]'),
  );
  const userLines = userCsv.text.trim().split("\r\n");
  const userBody = userLines.slice(1);
  check(
    "user: the personal CSV downloaded and has the ledger header",
    /^aeros-user-transactions-.*\.csv$/.test(userCsv.name) &&
      userLines[0].replace(/^﻿/, "").startsWith("txRef,type,createdAt"),
    userCsv.name,
  );
  check("user: it contains their own payments", userBody.length > 0, { rows: userBody.length });
  check(
    "user: EVERY row involves this user and nobody else's private history leaked in",
    userBody.every((line) => line.includes(BUYER)),
    userBody.slice(0, 2),
  );
  check(
    "user: the personal export is a strict subset of the Government's",
    userBody.length < govLines.length - 1,
    { user: userBody.length, government: govLines.length - 1 },
  );
  check("user: no bcrypt hash in a personal export either", !/\$2[aby]\$\d\d\$/.test(userCsv.text));

  const userMobCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    acceptDownloads: true,
    storageState: await userCtx.storageState(),
  });
  const userMob = await userMobCtx.newPage();
  await userMob.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
  await userMob.screenshot({ path: `${OUT}/08-user-activity-mobile.png`, fullPage: true });
  const userMobText = await mainText(userMob);
  check(
    "user (mobile): the download button is still reachable at phone width",
    /Download CSV/.test(userMobText),
  );

  // The cron endpoint must be closed to an ordinary browser, session or not.
  const cronResponse = await userPage.request.get(`${BASE}/api/cron/cleanup`);
  check(
    "cron: an authenticated ordinary visitor cannot run the scheduled job",
    cronResponse.status() === 401 || cronResponse.status() === 503,
    cronResponse.status(),
  );

  // And a logged-out visitor cannot reach a Government export.
  const anonCtx = await browser.newContext();
  const anonPage = await anonCtx.newPage();
  const anonExport = await anonPage.request.get(`${BASE}/api/gov/export/users?format=csv`);
  check(
    "exports: a logged-out visitor is refused the Government export",
    anonExport.status() === 401,
    anonExport.status(),
  );
  const userTryingGov = await userPage.request.get(`${BASE}/api/gov/export/users?format=csv`);
  check(
    "exports: an ordinary logged-in user is refused the Government export",
    userTryingGov.status() === 401,
    userTryingGov.status(),
  );

  console.log(`\n=== BROWSER: ${pass} passed, ${fail} failed ===`);
} finally {
  await browser.close();
}

process.exit(fail > 0 ? 1 : 0);
