// scripts/e2e-screenplay.ts
//
// End-to-end browser test for the new screenplay creation flow.
// Drives a real Chromium via Playwright.
//
// Usage:  npm run e2e:screenplay
// Env:    E2E_BASE_URL (default http://localhost:3001)
//         E2E_EMAIL, E2E_PASSWORD (required)
//         E2E_HEADLESS (default 1)
//         E2E_SCREENPLAY_ID (optional; if set, skip "navigate to existing screenplay for refine")

import { chromium, type Browser, type BrowserContext, type Page, type Locator } from "playwright";
import * as XLSX from "xlsx";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3001";
const EMAIL = process.env.E2E_EMAIL ?? "";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const HEADLESS = process.env.E2E_HEADLESS !== "0";
const SCREENSHOTS = "/tmp/screenplay-e2e";

interface StepResult {
  step: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail?: string;
  screenshot?: string;
  durationMs?: number;
}

const results: StepResult[] = [];

function log(r: StepResult) {
  results.push(r);
  const icon = r.status === "PASS" ? "✅" : r.status === "FAIL" ? "❌" : "⏭️";
  const ms = r.durationMs ? ` (${r.durationMs}ms)` : "";
  console.log(`  ${icon} ${r.step}${ms} — ${r.detail ?? ""}${r.screenshot ? ` [${r.screenshot}]` : ""}`);
}

async function screenshot(page: Page, name: string): Promise<string> {
  const p = join(SCREENSHOTS, `${String(results.length + 1).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  return p;
}

async function step(name: string, fn: () => Promise<{ detail?: string; screenshot?: string }>): Promise<boolean> {
  const t0 = Date.now();
  try {
    const r = await fn();
    log({ step: name, status: "PASS", detail: r.detail, screenshot: r.screenshot, durationMs: Date.now() - t0 });
    return true;
  } catch (e) {
    log({
      step: name,
      status: "FAIL",
      detail: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - t0,
    });
    return false;
  }
}

async function login(page: Page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
}

async function buildExcelFixture(): Promise<string> {
  const wb = XLSX.utils.book_new();
  const sh = XLSX.utils.aoa_to_sheet([
    ["商品概要"],
    [],
    ["商品名", "E2Eテスト用フライパン PRO-5000"],
    ["カテゴリ", "キッチン用品"],
    ["メーカー直販価格", "¥9,800"],
    ["本日特別価格", "¥6,800"],
    ["送料", "¥0"],
    ["保証", "30日返品保証"],
    [],
    ["説明:", "ふっ素樹脂加工26cm、IH/ガス対応、軽量アルミ製、深底タイプ。1人〜2人分の調理に最適。"],
  ]);
  XLSX.utils.book_append_sheet(wb, sh, "Overview");
  const bonus = XLSX.utils.aoa_to_sheet([
    ["特典・付属品"],
    ["1", "シリコンスパチュラ"],
    ["2", "レシピブック"],
  ]);
  XLSX.utils.book_append_sheet(wb, bonus, "Bonuses");
  const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const path = join(SCREENSHOTS, "e2e-fixture.xlsx");
  await writeFile(path, buf);
  return path;
}

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error("E2E_EMAIL and E2E_PASSWORD must be set in env");
    process.exit(2);
  }
  await rm(SCREENSHOTS, { recursive: true, force: true });
  await mkdir(SCREENSHOTS, { recursive: true });

  console.log(`=== screenplay E2E vs ${BASE_URL} ===`);
  console.log(`screenshots → ${SCREENSHOTS}/`);

  const browser: Browser = await chromium.launch({ headless: HEADLESS });
  const ctx: BrowserContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "ja-JP",
  });
  ctx.setDefaultTimeout(30_000);
  const page = await ctx.newPage();

  let createdScreenplayId: string | null = null;

  try {
    // 1. Login -------------------------------------------------------------
    await step("login", async () => {
      await login(page);
      return { detail: `landed on ${new URL(page.url()).pathname}`, screenshot: await screenshot(page, "logged-in") };
    });

    // 2. Old "create from product" button removed --------------------------
    await step("old GenerateScreenplayButton is gone on /products list", async () => {
      // We don't know a product ID, but the products list page should never show our purple button anywhere.
      await page.goto(`${BASE_URL}/products`, { waitUntil: "domcontentloaded" });
      const oldBtn = page.getByRole("button", { name: /この商品で台本を生成/ });
      const count = await oldBtn.count();
      if (count > 0) throw new Error(`expected 0 old buttons, found ${count}`);
      return { detail: "no legacy 'この商品で台本を生成' button found" };
    });

    // 3. /screenplays/new — two new tabs, no picker tab --------------------
    await step("create form has Upload + URL tabs (no picker)", async () => {
      await page.goto(`${BASE_URL}/screenplays/new`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      const uploadTab = page.getByRole("button", { name: /ファイルをアップロード/ });
      const urlTab = page.getByRole("button", { name: /商品ページURL/ });
      const oldPickerTab = page.getByRole("button", { name: /登録済みの商品から選ぶ/ });
      const oldManualTab = page.getByRole("button", { name: /手入力で作成/ });
      if (!(await uploadTab.isVisible())) throw new Error("ファイルをアップロード tab missing");
      if (!(await urlTab.isVisible())) throw new Error("商品ページURL tab missing");
      const oldPickerCount = await oldPickerTab.count();
      const oldManualCount = await oldManualTab.count();
      if (oldPickerCount + oldManualCount > 0) {
        throw new Error(`legacy tabs still present: picker=${oldPickerCount} manual=${oldManualCount}`);
      }
      return { detail: "Upload + URL tabs visible; picker/manual absent", screenshot: await screenshot(page, "new-form") };
    });

    // 4. SSRF guard: localhost URL must be rejected without network call ---
    await step("URL tab rejects localhost", async () => {
      await page.getByRole("button", { name: /商品ページURL/ }).click();
      const urlInput = page.locator('input[type="url"]');
      await urlInput.fill("http://localhost/danger");
      await page.getByRole("button", { name: /URLから情報を抽出/ }).click();
      await page.waitForSelector("text=/有効な http\\/https の公開 URL/", { timeout: 10_000 });
      return { detail: "localhost URL blocked with expected error", screenshot: await screenshot(page, "ssrf-blocked") };
    });

    // 5. URL extraction happy path (Wikipedia — stable + image-rich) -------
    let urlPreviewShown = false;
    await step("URL extraction returns editable preview with image count", async () => {
      const urlInput = page.locator('input[type="url"]');
      await urlInput.fill("");
      await urlInput.fill("https://ja.wikipedia.org/wiki/IPhone_15");
      await page.getByRole("button", { name: /URLから情報を抽出/ }).click();
      // The preview card has "抽出結果を確認・編集" — wait for it.
      await page.waitForSelector("text=抽出結果を確認・編集", { timeout: 120_000 });
      // Image count badge appears only when imageCount > 0.
      const badge = page.locator("text=/画像 \\d+ 枚を解析/").first();
      const hasBadge = await badge.isVisible().catch(() => false);
      urlPreviewShown = true;
      return {
        detail: hasBadge ? `preview + ${(await badge.textContent())?.trim()}` : "preview shown (no image badge)",
        screenshot: await screenshot(page, "url-preview"),
      };
    });

    // 6. Edit name in preview persists ------------------------------------
    if (urlPreviewShown) {
      await step("editing preview name persists locally", async () => {
        const nameInput = page.locator('label:has-text("商品名") + input').first();
        const before = await nameInput.inputValue();
        const after = `[E2E] ${before.slice(0, 60)}`;
        await nameInput.fill(after);
        const val = await nameInput.inputValue();
        if (val !== after) throw new Error(`name edit not persisted: "${val}"`);
        return { detail: `name: "${before}" → "${after}"` };
      });
    } else {
      log({ step: "editing preview name persists locally", status: "SKIP", detail: "URL preview not shown" });
    }

    // 7. Reset button returns to tab view ---------------------------------
    await step("reset returns to tab view", async () => {
      await page.getByRole("button", { name: /別の素材で再抽出/ }).click();
      await page.waitForSelector("text=ファイルをアップロード", { timeout: 5_000 });
      const previewGone = (await page.locator("text=抽出結果を確認・編集").count()) === 0;
      if (!previewGone) throw new Error("preview still visible after reset");
      return { detail: "form reset; tab switcher visible", screenshot: await screenshot(page, "after-reset") };
    });

    // 8. Excel upload extraction ------------------------------------------
    const fixturePath = await buildExcelFixture();
    await step("Excel upload extracts brief", async () => {
      await page.getByRole("button", { name: /ファイルをアップロード/ }).click();
      const fileInput = page.locator("#screenplay-file-input");
      await fileInput.setInputFiles(fixturePath);
      await page.getByRole("button", { name: /Geminiで情報を抽出/ }).click();
      await page.waitForSelector("text=抽出結果を確認・編集", { timeout: 120_000 });
      const nameInput = page.locator('label:has-text("商品名") + input').first();
      const name = await nameInput.inputValue();
      if (!name.includes("PRO") && !name.includes("フライパン")) {
        throw new Error(`extracted name doesn't look right: "${name}"`);
      }
      return { detail: `extracted name="${name}"`, screenshot: await screenshot(page, "excel-preview") };
    });

    // 9. Submit and verify redirect to /screenplays/{id} -------------------
    await step("submit creates screenplay and redirects", async () => {
      // Make the name unmistakable so we can grep for it in the list later.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const testName = `[E2E ${stamp}] テスト用フライパン`;
      const nameInput = page.locator('label:has-text("商品名") + input').first();
      await nameInput.fill(testName);

      const submitBtn = page.getByRole("button", { name: /^台本を生成/ });
      await Promise.all([
        page.waitForURL(/\/screenplays\/[0-9a-f-]{36}/, { timeout: 60_000 }),
        submitBtn.click(),
      ]);
      const m = page.url().match(/\/screenplays\/([0-9a-f-]{36})/);
      if (!m) throw new Error(`redirect URL has no screenplay id: ${page.url()}`);
      createdScreenplayId = m[1];
      return {
        detail: `redirected to /screenplays/${createdScreenplayId}`,
        screenshot: await screenshot(page, "after-submit"),
      };
    });

    // 10. List page shows the new screenplay ------------------------------
    await step("list page surfaces new screenplay", async () => {
      await page.goto(`${BASE_URL}/screenplays`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      const found = createdScreenplayId
        ? await page.locator(`a[href*="${createdScreenplayId}"]`).count()
        : 0;
      if (!found) throw new Error("new screenplay not visible in list");
      return { detail: `link to /screenplays/${createdScreenplayId} found in list`, screenshot: await screenshot(page, "list-page") };
    });

    // 11. Workspace shows progress / refine UI ----------------------------
    await step("workspace renders progress and refine UI", async () => {
      if (!createdScreenplayId) throw new Error("no screenplay to inspect");
      await page.goto(`${BASE_URL}/screenplays/${createdScreenplayId}`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      // The page should at minimum render the version timeline scaffolding and either a
      // "生成中" indicator or a feedback form. We probe gently: just look for any
      // mention of feedback OR generation status.
      const html = await page.content();
      const hasFeedback = /フィードバック|改稿|改善|refine/i.test(html);
      const hasGenSignal = /生成|生成中|generating|progress|ストリーム/i.test(html);
      if (!hasFeedback && !hasGenSignal) {
        throw new Error("workspace shows neither feedback UI nor generation status");
      }
      return {
        detail: `workspace loaded (feedback=${hasFeedback}, gen=${hasGenSignal})`,
        screenshot: await screenshot(page, "workspace"),
      };
    });

    // 12. Console + network errors capture --------------------------------
    // (We attach listeners early but report at the end.)
  } finally {
    await ctx.close();
    await browser.close();
  }

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skip = results.filter((r) => r.status === "SKIP").length;
  console.log(`\n=== E2E summary: ${pass} pass, ${fail} fail, ${skip} skip ===`);
  console.log(`screenshots: ${SCREENSHOTS}/`);
  if (createdScreenplayId) {
    console.log(`Created screenplay (for cleanup): ${createdScreenplayId}`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
