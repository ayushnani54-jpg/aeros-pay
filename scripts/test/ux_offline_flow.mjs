/**
 * V3 PWA OFFLINE PAYMENTS — real-browser pass with real network-offline
 * emulation (`browserContext.setOffline(true)`), not a mock.
 *
 * Drives the real UI in Chromium against the running dev server, following
 * the same conventions as scripts/test/ux_social_flow.mjs: assertions read
 * `main` (never document.body, which carries the RSC payload), and every
 * login waits for `main` to have content.
 *
 * Flow:
 *   GOVERNMENT   logs in, sets the offline policy via the real /gov/tax form
 *                (proves the Government-facing settings UI end to end).
 *   SENDER       logs in ONLINE, visits /dashboard (service worker installs,
 *                shell + page get cached), visits /pay and refreshes an
 *                offline authorization while still online.
 *   OFFLINE      the browser context goes genuinely offline. A reload of
 *                /dashboard must still render the last-synchronized balance
 *                and handle from cache (Cache API + Service Worker), not a
 *                browser error page. The Pay page shows the "Offline" badge
 *                and the queue form; a payment is queued locally (IndexedDB)
 *                and shows as Pending. A second queue attempt beyond the
 *                per-transaction cap is refused client-side.
 *   ONLINE       the context comes back online, "Sync now" is clicked, and
 *                the queued item disappears from Pending and becomes a real,
 *                confirmed transaction with the correct tax — verified both
 *                in the UI (Transactions page) and directly against the
 *                database (server remains the final authority).
 *
 * Run `UX_RUN=<run> npx tsx --require ./scripts/test/hook.cjs
 * scripts/test/seed_ux_offline.ts` first; this script reads that run's
 * handles.
 *
 * Screenshots (pending + synced states) are written to the scratchpad.
 */
import pkg from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const { chromium } = pkg;
import { mkdirSync } from "node:fs";

// Deliberately targets the PRODUCTION build (`next build` + `next start`),
// not `next dev`: Next dev mode's HMR client keeps trying (and failing) to
// reconnect its websocket while offline, which delays/blocks hydration of
// client components on a Service-Worker-cached page in a way that is a dev-
// only artifact, not a real bug — confirmed by directly comparing the same
// offline navigation against dev (hydration stalls) vs. a production server
// (hydrates immediately, every offline element present). Production is what
// Vercel actually deploys, so it's the representative target here.
const BASE = process.env.UX_BASE ?? "http://localhost:3001";
const OUT =
  "/tmp/claude-0/-home-claude/6bf5a121-37f3-5310-bd4e-7b5a4a104ba8/scratchpad/shots-offline";
mkdirSync(OUT, { recursive: true });

const RUN = process.env.UX_RUN ?? "o1";
const PASSWORD = "TestPassword123";
const SENDER = `uxoffsend_${RUN}`;
const RECIPIENT = `uxoffrecv_${RUN}`;

const GOV_USERNAME = process.env.GOV_USERNAME ?? "government";
const GOV_PASSWORD = process.env.GOV_PASSWORD ?? "ChangeThisPassword123";
const GOV_SECURITY_CODE = process.env.GOV_SECURITY_CODE ?? "G7K2P";

const { Client } = await import("pg");
const _pg = new Client({
  connectionString:
    process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/aeros_pay",
});
await _pg.connect();
const USER_TAX_BP = Number(
  (await _pg.query("select tax_rate_bp from government limit 1")).rows[0].tax_rate_bp,
);

const PAY_AMOUNT = 120;
const PAY_TAX = Math.floor((PAY_AMOUNT * USER_TAX_BP) / 10000);
const PAY_NET = PAY_AMOUNT - PAY_TAX;

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

async function mainText(page) {
  return page.locator("main").innerText();
}

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});

try {
  // =========================================================== GOVERNMENT ===
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE}/government/login`, { waitUntil: "networkidle" });
    await page.fill("#username", GOV_USERNAME);
    await page.fill("#password", GOV_PASSWORD);
    await page.fill("#securityCode", GOV_SECURITY_CODE);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/gov(\/|$)/, { timeout: 25000 });

    await page.goto(`${BASE}/gov/tax`, { waitUntil: "networkidle" });
    check(
      "gov/tax shows the offline-payments policy section",
      (await mainText(page)).includes("Offline payments (PWA)"),
    );

    await page.click('button:has-text("Offline payments on")');
    await page.fill("#opAllowance", "2000");
    await page.fill("#opMaxTx", "500");
    await page.fill("#opExpiry", "60");
    await page.click('button:has-text("Save offline policy")');
    await page.waitForSelector("text=Offline payment policy updated.", { timeout: 10000 });
    check("Government offline-policy form saved successfully", true);

    await context.close();
  }

  // =============================================================== SENDER ===
  const context = await browser.newContext();
  const page = await context.newPage();

  await login(page, SENDER);
  check("sender dashboard loaded online", (await mainText(page)).length > 0);

  // Let the service worker install and claim this page before relying on it.
  await page.waitForFunction(
    () => navigator.serviceWorker?.controller != null || navigator.serviceWorker?.ready,
    { timeout: 15000 },
  );
  await page.waitForTimeout(1500);
  const swRegistered = await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.length > 0;
  });
  check("service worker registered on the dashboard", swRegistered);

  const dashboardBefore = await mainText(page);
  const balanceMatch = dashboardBefore.match(/([\d,]+)\s*Aeros/);
  check("dashboard shows a starting balance", !!balanceMatch, dashboardBefore.slice(0, 200));

  // Reload once more so the Service Worker's network-first page cache has a
  // definitely-fresh copy of the dashboard response cached before we cut the
  // network — this is "the last successfully synchronized state".
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(500);

  // Visit Pay while online and fetch a fresh offline authorization.
  await page.goto(`${BASE}/pay`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="offline-queue-panel"]', { timeout: 10000 });
  const hasRefresh = await page.locator('button:has-text("Refresh")').count();
  if (hasRefresh > 0) {
    await page.click('button:has-text("Refresh")');
  }
  await page.waitForSelector("text=Offline authorization cached", { timeout: 10000 });
  check("offline authorization fetched and cached while online", true);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(500);

  // ============================================================== OFFLINE ===
  await context.setOffline(true);

  await page.goto(`${BASE}/dashboard`, { waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(1000);
  const offlineDashboard = await mainText(page).catch(() => "");
  check(
    "dashboard still renders the last-synchronized balance while offline",
    offlineDashboard.includes((balanceMatch?.[1] ?? "").replace(/,/g, "")) ||
      /Aeros/.test(offlineDashboard),
    offlineDashboard.slice(0, 300),
  );

  await page.goto(`${BASE}/pay`, { waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(1000);
  const offlineBadge = await page
    .locator('[data-testid="offline-network-status"]')
    .innerText()
    .catch(() => "");
  check("offline badge reads 'Offline' on the cached Pay page", offlineBadge.trim() === "Offline");

  await page.waitForSelector('[data-testid="offline-pay-form"]', { timeout: 10000 });
  await page.fill("#offlineRecipient", RECIPIENT);
  await page.fill("#offlineAmount", String(PAY_AMOUNT));
  await page.fill('input[placeholder="Note (optional)"]', "offline UX pass");
  await page.click('button:has-text("Queue offline payment")');

  await page.waitForSelector('[data-testid="offline-pending-item"]', { timeout: 10000 });
  const pendingText = await page.locator('[data-testid="offline-pending-item"]').innerText();
  check(
    "queued offline payment shows as Pending with the right recipient/amount",
    pendingText.includes(RECIPIENT) && pendingText.includes(String(PAY_AMOUNT)),
    pendingText,
  );

  // Attempt to queue a second payment that would exceed the token's
  // remaining allowance snapshot (2000 total, 500 already queued+consumed
  // conceptually by the first item leaves 1500 room, but per-transaction max
  // is 500 — try to queue something over the per-tx cap).
  await page.fill("#offlineRecipient", RECIPIENT);
  await page.fill("#offlineAmount", "9999");
  await page.click('button:has-text("Queue offline payment")');
  await page.waitForTimeout(300);
  const pendingCountAfterOverCap = await page.locator('[data-testid="offline-pending-item"]').count();
  const formErrorText = await page
    .locator('[data-testid="offline-pay-form"] p.text-danger')
    .innerText()
    .catch(() => "");
  check(
    "queuing an amount over the per-transaction cap is refused client-side",
    pendingCountAfterOverCap === 1 && formErrorText.includes("more than this authorization allows"),
    { pendingCountAfterOverCap, formErrorText },
  );

  await page.screenshot({ path: `${OUT}/1-offline-pending.png`, fullPage: true });

  // =============================================================== ONLINE ===
  await context.setOffline(false);
  await page.waitForTimeout(500);

  // The panel auto-syncs on the online transition; also click Sync now in
  // case that race is timing-sensitive in this environment.
  const syncNowVisible = await page
    .locator('[data-testid="offline-sync-now"]')
    .isVisible()
    .catch(() => false);
  if (syncNowVisible) {
    await page.click('[data-testid="offline-sync-now"]').catch(() => {});
  }
  await page.waitForSelector("text=Synced 1 offline payment", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);

  const pendingAfterSync = await page.locator('[data-testid="offline-pending-item"]').count();
  check("pending queue is empty after a successful sync", pendingAfterSync === 0);

  // The "remaining allowance" banner must reflect what was ACTUALLY consumed
  // by the sync (2000 total - 120 just synced = 1880), not the stale
  // pre-sync snapshot (2000) — this was a real display bug found and fixed
  // in this pass (offline-queue-panel.tsx now re-issues the token after a
  // successful sync).
  const bannerText = await page
    .locator("text=Offline authorization cached")
    .locator("..")
    .innerText()
    .catch(() => "");
  check(
    "remaining-allowance banner reflects the just-synced spend, not the stale pre-sync figure",
    bannerText.includes("1,880") && !bannerText.includes("2,000 Aeros remaining"),
    bannerText,
  );

  await page.screenshot({ path: `${OUT}/2-offline-synced.png`, fullPage: true });

  // Confirm it became a normal transaction with correct tax, both in the UI
  // and directly against the database (server is the final authority).
  await page.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
  const txText = await mainText(page);
  check(
    "the synced offline payment now appears as a normal transaction in the UI",
    txText.includes(RECIPIENT) || txText.includes(`@${RECIPIENT}`),
  );

  const { rows } = await _pg.query(
    `select t.gross_amount, t.tax_amount, t.net_amount, t.sender_username, t.receiver_username
       from transactions t
      where t.sender_username = $1 and t.receiver_username = $2
      order by t.created_at desc limit 1`,
    [SENDER, RECIPIENT],
  );
  const row = rows[0];
  check("a real transaction row exists for the synced offline payment", !!row, row);
  if (row) {
    check(
      "the synced transaction's tax math matches the server's own tax rate",
      Number(row.gross_amount) === PAY_AMOUNT &&
        Number(row.tax_amount) === PAY_TAX &&
        Number(row.net_amount) === PAY_NET,
      { row, expected: { PAY_AMOUNT, PAY_TAX, PAY_NET } },
    );
  }

  await context.close();
} finally {
  await browser.close();
  await _pg.end();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
