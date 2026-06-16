// scripts/test-screenplay-import.ts
//
// Units + round-trip fidelity gate + (skip-guarded) live normalize smoke for
// the Word draft import pipeline.
//   - npx tsx scripts/test-screenplay-import.ts        # units + round-trip (offline)
//   - npm run test:screenplay-import                   # + live Gemini normalize
import { parseBriefObject, parseBriefJson } from "../lib/screenplay/extract/brief-prompt";
import { parseImportJson, IMPORT_MARKDOWN_MAX } from "../lib/screenplay/import/normalize-prompt";

type Status = "PASS" | "FAIL" | "SKIP";
const results: { name: string; status: Status; detail?: string }[] = [];
function pass(n: string, d = "") { results.push({ name: n, status: "PASS", detail: d }); console.log(`  ✅ ${n}${d ? " — " + d : ""}`); }
function fail(n: string, d = "") { results.push({ name: n, status: "FAIL", detail: d }); console.log(`  ❌ ${n} — ${d}`); }
function skip(n: string, d = "") { results.push({ name: n, status: "SKIP", detail: d }); console.log(`  ⏭️  ${n} — ${d}`); }

function testParseBriefObject() {
  console.log("\n[parseBriefObject] unit");
  try {
    const b = parseBriefObject({ name: "X", description: "D", price: { saleJpy: "9,800" } });
    if (b.name !== "X" || b.description !== "D") throw new Error("field mismatch");
    if (b.price?.saleJpy !== 9800) throw new Error("price string coerce failed");
    pass("parseBriefObject happy path");
  } catch (e) { fail("parseBriefObject happy path", (e as Error).message); }
  try { parseBriefObject({ description: "D" } as Record<string, unknown>); fail("rejects missing name", "did not throw"); }
  catch (e) { pass("rejects missing name", (e as Error).message); }
  try {
    const b = parseBriefJson('{"name":"Y","description":"D2"}');
    if (b.name !== "Y") throw new Error("name mismatch");
    pass("parseBriefJson regression");
  } catch (e) { fail("parseBriefJson regression", (e as Error).message); }
}

function testParseImportJson() {
  console.log("\n[parseImportJson] unit");
  try {
    const r = parseImportJson(JSON.stringify({
      markdown: "# 台本\n\n[N] （明るく）\nこんにちは。",
      brief: { name: "商品A", description: "説明テキスト" },
    }));
    if (!r.markdown.includes("こんにちは")) throw new Error("markdown lost");
    if (r.brief.name !== "商品A") throw new Error("brief.name mismatch");
    pass("parseImportJson happy path");
  } catch (e) { fail("parseImportJson happy path", (e as Error).message); }

  try { parseImportJson(JSON.stringify({ brief: { name: "A", description: "D" } })); fail("rejects missing markdown", "did not throw"); }
  catch (e) { pass("rejects missing markdown", (e as Error).message); }

  try { parseImportJson(JSON.stringify({ markdown: "x" })); fail("rejects missing brief", "did not throw"); }
  catch (e) { pass("rejects missing brief", (e as Error).message); }

  try {
    const big = "あ".repeat(IMPORT_MARKDOWN_MAX + 500);
    parseImportJson(JSON.stringify({ markdown: "# h\n" + big, brief: { name: "A", description: "D" } }));
    fail("rejects oversized markdown", "did not throw");
  } catch (e) { pass("rejects oversized markdown", (e as Error).message); }

  try {
    const r = parseImportJson('prefix ```json\n{"markdown":"# t\\n本文","brief":{"name":"A","description":"D"}}\n``` suffix');
    if (!r.markdown.includes("本文")) throw new Error("did not strip prose/fence");
    pass("strips surrounding prose / code fence");
  } catch (e) { fail("strips surrounding prose / code fence", (e as Error).message); }
}

async function main() {
  console.log("=== screenplay/import test ===");
  testParseBriefObject();
  testParseImportJson();
  const f = results.filter((r) => r.status === "FAIL").length;
  const p = results.filter((r) => r.status === "PASS").length;
  const s = results.filter((r) => r.status === "SKIP").length;
  console.log(`\n=== ${p} pass, ${f} fail, ${s} skip ===`);
  process.exit(f > 0 ? 1 : 0);
}
main().catch((e) => { console.error("Unhandled:", e); process.exit(1); });
