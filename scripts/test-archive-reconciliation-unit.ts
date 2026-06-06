/** DB-free unit tests for archive-reconciliation pure functions.
 *   npx tsx scripts/test-archive-reconciliation-unit.ts
 */
import { classifyCandidate, computeCoverage, selectAlertWorthy, buildWebhookPayload, type GapRecord } from "../lib/broadcasts/archive-reconciliation";
import { postWebhook } from "../lib/alerts/webhook";

let failures = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) console.log(`  ok: ${msg}`);
  else { console.error(`  FAIL: ${msg}\n    expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`); failures++; }
}

async function main() {
  // --- classifyCandidate ---
  eq(classifyCandidate("pending", true), "requeue", "pending + video → requeue");
  eq(classifyCandidate("deferred", true), "requeue", "deferred + video → requeue");
  eq(classifyCandidate("abandoned", true), "alert", "abandoned + video → alert");
  eq(classifyCandidate("failed", true), "alert", "failed + video → alert");
  eq(classifyCandidate("failed_unsupported", true), "alert", "failed_unsupported + video → alert");
  eq(classifyCandidate("pending", false), "skip", "pending + no video → skip");
  eq(classifyCandidate("abandoned", false), "skip", "abandoned + no video → skip");

  // --- computeCoverage ---
  eq(
    computeCoverage([{ channel: "qvc", air_date: "2026-06-05", archived: 17, gapsWithVideo: 0 }]),
    [{ channel: "qvc", air_date: "2026-06-05", expected: 17, archived: 17, coverage: 100 }],
    "full coverage → 100",
  );
  eq(
    computeCoverage([{ channel: "shopch", air_date: "2026-06-05", archived: 24, gapsWithVideo: 1 }]),
    [{ channel: "shopch", air_date: "2026-06-05", expected: 25, archived: 24, coverage: 96 }],
    "1 gap of 25 → 96",
  );
  eq(
    computeCoverage([{ channel: "qvc", air_date: "2026-06-05", archived: 0, gapsWithVideo: 0 }]),
    [{ channel: "qvc", air_date: "2026-06-05", expected: 0, archived: 0, coverage: 100 }],
    "no expected → 100 (n/a)",
  );

  // --- selectAlertWorthy ---
  const gHealed: GapRecord = { broadcast_id: "a", channel: "shopch", air_date: "2026-06-01", start_time: "15:00:00", status: "deferred", classification: "healed", reason: "requeued" };
  const gUnheal: GapRecord = { broadcast_id: "b", channel: "qvc", air_date: "2026-06-01", start_time: "20:00:00", status: "abandoned", classification: "unhealable", reason: "abandoned, video present" };
  eq(selectAlertWorthy([gHealed, gUnheal], new Set()).map((g) => g.broadcast_id), ["b"], "first-seen healed excluded; unhealable alerts");
  eq(selectAlertWorthy([gHealed], new Set(["a"])).map((g) => g.broadcast_id), ["a"], "healed gap persisting from previous run → alerts");
  eq(selectAlertWorthy([gHealed], new Set()).map((g) => g.broadcast_id), [], "first-seen healed gap → no alert");

  // --- buildWebhookPayload ---
  const payload = buildWebhookPayload(
    [gUnheal],
    [{ channel: "qvc", air_date: "2026-06-01", expected: 20, archived: 19, coverage: 95 }],
  );
  eq(payload.text === payload.content, true, "text and content identical (Slack+Discord)");
  eq(payload.text.includes("1 un-healable gap"), true, "header counts gaps");
  eq(payload.text.includes("[qvc] 2026-06-01 20:00:00"), true, "lists the gap");
  eq(payload.text.includes("qvc 95% (19/20)"), true, "coverage summary present");

  // --- postWebhook ---
  {
    const calls: Array<{ url: string; body: string }> = [];
    const okFetch = async (url: string, init: { body: string }) => { calls.push({ url, body: init.body }); return { ok: true, status: 200 }; };
    const r1 = await postWebhook("https://hook.test/x", { text: "hi" }, okFetch as never);
    eq(r1, { ok: true }, "postWebhook success");
    eq(calls.length === 1 && JSON.parse(calls[0].body).text === "hi", true, "posts JSON body");
    const badFetch = async () => ({ ok: false, status: 500 });
    const r2 = await postWebhook("https://hook.test/x", { text: "hi" }, badFetch as never);
    eq(r2.ok, false, "non-2xx → ok:false");
    const throwFetch = async () => { throw new Error("network down"); };
    const r3 = await postWebhook("https://hook.test/x", { text: "hi" }, throwFetch as never);
    eq(r3.ok === false && (r3.error ?? "").includes("network down"), true, "throw → ok:false with error");
  }

  if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1); }
  console.log("\nall unit assertions passed.");
}

main().then(() => { if (failures > 0) process.exit(1); else process.exit(0); });
