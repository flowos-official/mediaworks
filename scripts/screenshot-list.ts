// Quick screenshot of /screenplays in its current state — used for visual review.
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.E2E_EMAIL!;
const PASSWORD = process.env.E2E_PASSWORD!;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ja-JP" });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);

  await page.goto(`${BASE}/screenplays`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.screenshot({ path: "/tmp/screenplay-e2e/list-view.png", fullPage: true });
  console.log("screenshot → /tmp/screenplay-e2e/list-view.png");

  await ctx.close();
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
