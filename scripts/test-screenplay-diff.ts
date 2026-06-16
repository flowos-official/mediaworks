// scripts/test-screenplay-diff.ts
//   - npx tsx scripts/test-screenplay-diff.ts        # units (offline)
//   - npm run test:screenplay-diff                   # + live Gemini rationale
import { computeLineDiff } from "../lib/screenplay/diff";

type Status = "PASS" | "FAIL" | "SKIP";
const results: { name: string; status: Status; detail?: string }[] = [];
function pass(n: string, d = "") { results.push({ name: n, status: "PASS", detail: d }); console.log(`  ✅ ${n}${d ? " — " + d : ""}`); }
function fail(n: string, d = "") { results.push({ name: n, status: "FAIL", detail: d }); console.log(`  ❌ ${n} — ${d}`); }
function skip(n: string, d = "") { results.push({ name: n, status: "SKIP", detail: d }); console.log(`  ⏭️  ${n} — ${d}`); }

function testComputeLineDiff() {
  console.log("\n[computeLineDiff] unit");
  try {
    if (computeLineDiff("a\nb\nc", "a\nb\nc").length !== 0) throw new Error("no-change should be []");
    pass("no change → no hunks");
  } catch (e) { fail("no change → no hunks", (e as Error).message); }

  try {
    const h = computeLineDiff("a\nb", "a\nX\nb");
    if (h.length !== 1) throw new Error(`expected 1 hunk, got ${h.length}`);
    if (!h[0].lines.some((l) => l.type === "added" && l.text === "X")) throw new Error("missing added line X");
    pass("pure addition");
  } catch (e) { fail("pure addition", (e as Error).message); }

  try {
    const h = computeLineDiff("a\nX\nb", "a\nb");
    if (h.length !== 1 || !h[0].lines.some((l) => l.type === "removed" && l.text === "X")) throw new Error("missing removed line X");
    pass("pure removal");
  } catch (e) { fail("pure removal", (e as Error).message); }

  try {
    const h = computeLineDiff("a\nold\nb", "a\nnew\nb");
    const hasRem = h[0].lines.some((l) => l.type === "removed" && l.text === "old");
    const hasAdd = h[0].lines.some((l) => l.type === "added" && l.text === "new");
    if (!hasRem || !hasAdd) throw new Error("modification should show both removed+added");
    pass("modification = removed + added");
  } catch (e) { fail("modification = removed + added", (e as Error).message); }

  try {
    const base = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const next = base.replace("line2", "line2X").replace("line25", "line25X");
    const h = computeLineDiff(base, next);
    if (h.length !== 2) throw new Error(`expected 2 far-apart hunks, got ${h.length}`);
    if (h[0].index !== 0 || h[1].index !== 1) throw new Error("hunk indices must be 0,1");
    pass("two far-apart changes → 2 hunks, indices 0,1");
  } catch (e) { fail("two far-apart changes", (e as Error).message); }
}

async function main() {
  console.log("=== screenplay/diff test ===");
  testComputeLineDiff();
  const f = results.filter((r) => r.status === "FAIL").length;
  const p = results.filter((r) => r.status === "PASS").length;
  const s = results.filter((r) => r.status === "SKIP").length;
  console.log(`\n=== ${p} pass, ${f} fail, ${s} skip ===`);
  process.exit(f > 0 ? 1 : 0);
}
main().catch((e) => { console.error("Unhandled:", e); process.exit(1); });
