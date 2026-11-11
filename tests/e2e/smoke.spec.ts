import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

function getScreenshotsDir(): string {
  const rootScreenshots = path.resolve(process.cwd(), "..", "screenshots");
  if (fs.existsSync(rootScreenshots)) {
    return rootScreenshots;
  }
  const localScreenshots = path.resolve(process.cwd(), "screenshots");
  fs.mkdirSync(localScreenshots, { recursive: true });
  return localScreenshots;
}

test.describe("Aerospay Platform Smoke & Visual Suite", () => {
  test("Prototype page renders with Aeros Pay title and civic tabs", async ({ page }, testInfo) => {
    await page.goto("/prototype");
    await expect(page).toHaveTitle(/Aeros Pay/);

    // Verify main interactive prototype elements
    const heading = page.locator("h1");
    await expect(heading).toContainText(/Aeros Pay Prototype/i);

    // Verify Tab buttons exist
    const civicTab = page.locator('button:has-text("Civic")');
    await expect(civicTab).toBeVisible();

    const tradingTab = page.locator('button:has-text("Trading")');
    await expect(tradingTab).toBeVisible();

    // Capture visual inspection screenshot
    const isMobile = testInfo.project.name.toLowerCase().includes("mobile");
    const viewportId = isMobile ? "phone" : "desktop";
    const screenshotDir = getScreenshotsDir();
    await page.screenshot({
      path: path.join(screenshotDir, `aerospay-prototype-${viewportId}-live.png`),
      fullPage: true,
    });
  });

  test("Login page renders correctly with login form", async ({ page }, testInfo) => {
    await page.goto("/login");
    await expect(page).toHaveTitle(/Aeros Pay/);

    // Verify login heading
    const loginHeading = page.locator("text=Log in to Aeros Pay");
    await expect(loginHeading).toBeVisible();

    // Verify form fields
    const userInput = page.locator('input[name="username"], input[name="email"], input[type="text"]');
    await expect(userInput).toBeVisible();

    // Capture visual inspection screenshot of the real login form
    const isMobile = testInfo.project.name.toLowerCase().includes("mobile");
    const viewportId = isMobile ? "phone" : "desktop";
    const screenshotDir = getScreenshotsDir();
    await page.screenshot({
      path: path.join(screenshotDir, `aerospay-login-${viewportId}-live.png`),
      fullPage: true,
    });
  });
});
