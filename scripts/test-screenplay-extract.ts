// scripts/test-screenplay-extract.ts
//
// Smoke test for the three new extractors:
//   - lib/screenplay/extract/from-excel.ts
//   - lib/screenplay/extract/from-url.ts
//   - lib/screenplay/extract/from-pdf.ts  (skipped when no fixture available)
//
// Usage:  npm run test:screenplay-extract
// Requires: GEMINI_API_KEY in .env.local.

import * as XLSX from "xlsx";
import { extractBriefFromExcel } from "@/lib/screenplay/extract/from-excel";
import { extractBriefFromUrl } from "@/lib/screenplay/extract/from-url";
import { extractBriefFromFile } from "@/lib/screenplay/extract/from-pdf";
import { parseBriefJson } from "@/lib/screenplay/extract/brief-prompt";
import { readFile, access } from "node:fs/promises";

type Status = "PASS" | "FAIL" | "SKIP";
interface Result {
  name: string;
  status: Status;
  detail?: string;
  durationMs?: number;
}

const results: Result[] = [];

function pass(name: string, detail: string, durationMs?: number) {
  results.push({ name, status: "PASS", detail, durationMs });
  console.log(`  ✅ ${name} (${durationMs}ms) — ${detail}`);
}
function fail(name: string, detail: string, durationMs?: number) {
  results.push({ name, status: "FAIL", detail, durationMs });
  console.log(`  ❌ ${name} — ${detail}`);
}
function skip(name: string, detail: string) {
  results.push({ name, status: "SKIP", detail });
  console.log(`  ⏭️  ${name} — ${detail}`);
}

function assertBrief(brief: unknown): asserts brief is { name: string; description: string } {
  if (!brief || typeof brief !== "object") throw new Error("brief is not an object");
  const b = brief as Record<string, unknown>;
  if (typeof b.name !== "string" || !b.name.trim()) throw new Error("brief.name missing/empty");
  if (typeof b.description !== "string" || !b.description.trim()) throw new Error("brief.description missing/empty");
  if (b.name.length > 200) throw new Error(`brief.name too long: ${b.name.length}`);
  if (b.description.length > 16_000) throw new Error(`brief.description too long: ${b.description.length}`);
}

// ----------------- parseBriefJson unit tests (no Gemini call) -----------------

function unitTestsParseBriefJson() {
  console.log("\n[1/4] parseBriefJson — unit tests");

  // Happy path
  try {
    const b = parseBriefJson(JSON.stringify({
      name: "テスト商品",
      description: "テスト用の商品説明テキスト",
      category: "ヘルスケア",
      price: { listJpy: 14800, saleJpy: "9,800", shippingJpy: "¥950" }, // mixed types
      bonuses: ["特典1", "特典2", "", "  ", "特典3"],
      guarantee: "1年保証",
      notes: "メモ",
    }));
    if (b.price?.listJpy !== 14800) throw new Error(`listJpy mismatch: ${b.price?.listJpy}`);
    if (b.price?.saleJpy !== 9800) throw new Error(`saleJpy (string-coerce) mismatch: ${b.price?.saleJpy}`);
    if (b.price?.shippingJpy !== 950) throw new Error(`shippingJpy (¥-strip) mismatch: ${b.price?.shippingJpy}`);
    if (b.bonuses?.length !== 3) throw new Error(`bonuses filter: expected 3, got ${b.bonuses?.length}`);
    pass("happy path", `name="${b.name}", bonuses=${b.bonuses?.length}, price.list=${b.price?.listJpy}`);
  } catch (e) {
    fail("happy path", e instanceof Error ? e.message : String(e));
  }

  // Strips prose around JSON
  try {
    const b = parseBriefJson('Sure! Here you go:\n```json\n{"name":"X","description":"D"}\n```\n');
    if (b.name !== "X" || b.description !== "D") throw new Error("did not extract embedded JSON");
    pass("strips surrounding prose / code fence", `name="${b.name}"`);
  } catch (e) {
    fail("strips surrounding prose / code fence", e instanceof Error ? e.message : String(e));
  }

  // Missing name -> rejects
  try {
    parseBriefJson('{"description":"D"}');
    fail("rejects missing name", "did not throw");
  } catch (e) {
    pass("rejects missing name", (e as Error).message);
  }

  // Missing description -> rejects
  try {
    parseBriefJson('{"name":"X"}');
    fail("rejects missing description", "did not throw");
  } catch (e) {
    pass("rejects missing description", (e as Error).message);
  }

  // No JSON object at all -> rejects
  try {
    parseBriefJson("not json");
    fail("rejects non-JSON", "did not throw");
  } catch (e) {
    pass("rejects non-JSON", (e as Error).message);
  }
}

// ----------------- Excel parsing (calls Gemini) -----------------

async function testExcel() {
  console.log("\n[2/4] from-excel — irregular workbook");
  const t0 = Date.now();
  try {
    // Build a workbook with two sheets, mixed layout — exactly the kind of unpredictable
    // input that motivated the SheetJS + LLM flexible approach.
    const wb = XLSX.utils.book_new();

    const productSheet = XLSX.utils.aoa_to_sheet([
      ["商品概要シート"],
      [],
      ["商品名", "プレミアム電気フライヤー DX-300"],
      ["カテゴリ", "キッチン家電"],
      ["メーカー直販価格", "¥19,800"],
      ["本日特別価格", "¥12,800"],
      ["送料", "¥800"],
      ["保証", "1年メーカー保証"],
      [],
      ["説明:", "1.5L 容量、油はね防止カバー付き、油の量を80%カット、温度調整 80〜200℃、タイマー30分。"],
    ]);
    XLSX.utils.book_append_sheet(wb, productSheet, "Overview");

    const bonusSheet = XLSX.utils.aoa_to_sheet([
      ["特典 / 同梱物"],
      ["No.", "内容"],
      [1, "専用バスケット"],
      [2, "レシピブック"],
      [3, "シリコンミトン"],
    ]);
    XLSX.utils.book_append_sheet(wb, bonusSheet, "Bonuses");

    const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const brief = await extractBriefFromExcel(buf, "fryer-dx300.xlsx");
    assertBrief(brief);
    if (!brief.name.includes("DX") && !brief.name.includes("フライヤー")) {
      throw new Error(`brief.name doesn't look right: "${brief.name}"`);
    }
    const dt = Date.now() - t0;
    pass(
      "extracts brief from 2-sheet workbook",
      `name="${brief.name}" / desc=${brief.description.length} chars / bonuses=${brief.bonuses?.length ?? 0} / price.list=${brief.price?.listJpy}`,
      dt,
    );
  } catch (e) {
    fail("extracts brief from 2-sheet workbook", e instanceof Error ? e.message : String(e), Date.now() - t0);
  }
}

// ----------------- URL extraction (calls Gemini, fetches HTML + images) -----------------

async function testUrl() {
  console.log("\n[3/4] from-url — public product page");
  // We pick an evergreen, public Japanese-language product page. Wikipedia gives us a
  // well-structured page with og:image, headings, and stable content — perfect for a
  // smoke test that doesn't depend on a third-party shop site staying up.
  const url = "https://ja.wikipedia.org/wiki/IPhone_15";
  const t0 = Date.now();
  try {
    const { brief, imageCount, finalUrl } = await extractBriefFromUrl(url);
    assertBrief(brief);
    const dt = Date.now() - t0;
    pass(
      "extracts brief from public URL (text + Vision)",
      `name="${brief.name}" / desc=${brief.description.length} chars / images=${imageCount} / finalUrl=${finalUrl}`,
      dt,
    );
  } catch (e) {
    fail("extracts brief from public URL", e instanceof Error ? e.message : String(e), Date.now() - t0);
  }

  // Guard test: rejects private/local URLs without making network calls.
  for (const bad of [
    "http://localhost:3000/x",
    "http://192.168.0.1/admin",
    "http://10.0.0.1/secret",
    "file:///etc/passwd",
    "not-a-url",
  ]) {
    try {
      await extractBriefFromUrl(bad);
      fail(`rejects unsafe URL: ${bad}`, "did not throw");
    } catch (e) {
      pass(`rejects unsafe URL: ${bad}`, (e as Error).message.slice(0, 80));
    }
  }
}

// ----------------- PDF / image extraction (calls Gemini Vision) -----------------

async function testPdfOrImage() {
  console.log("\n[4/4] from-pdf — file fixture (optional)");
  const fixturePath = process.env.SCREENPLAY_EXTRACT_FIXTURE;
  if (!fixturePath) {
    skip("PDF/image extractor", "set SCREENPLAY_EXTRACT_FIXTURE=/path/to/file.pdf to enable");
    return;
  }
  try {
    await access(fixturePath);
  } catch {
    skip("PDF/image extractor", `fixture not found: ${fixturePath}`);
    return;
  }
  const t0 = Date.now();
  try {
    const buf = await readFile(fixturePath);
    const mime = fixturePath.toLowerCase().endsWith(".pdf")
      ? "application/pdf"
      : fixturePath.toLowerCase().endsWith(".png")
      ? "image/png"
      : "image/jpeg";
    const brief = await extractBriefFromFile(buf.toString("base64"), mime, fixturePath.split("/").pop() ?? "fixture");
    assertBrief(brief);
    const dt = Date.now() - t0;
    pass(
      "extracts brief from fixture file",
      `name="${brief.name}" / desc=${brief.description.length} chars`,
      dt,
    );
  } catch (e) {
    fail("extracts brief from fixture file", e instanceof Error ? e.message : String(e), Date.now() - t0);
  }
}

// ----------------- main -----------------

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY not set. Run via: npm run test:screenplay-extract (loads .env.local)");
    process.exit(1);
  }

  console.log("=== screenplay/extract smoke test ===");
  unitTestsParseBriefJson();
  await testExcel();
  await testUrl();
  await testPdfOrImage();

  const pass_ = results.filter((r) => r.status === "PASS").length;
  const fail_ = results.filter((r) => r.status === "FAIL").length;
  const skip_ = results.filter((r) => r.status === "SKIP").length;
  console.log(`\n=== Summary: ${pass_} pass, ${fail_} fail, ${skip_} skip ===`);
  process.exit(fail_ > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
