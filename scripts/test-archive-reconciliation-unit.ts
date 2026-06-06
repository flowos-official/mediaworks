/** DB-free unit tests for archive-reconciliation pure functions.
 *   npx tsx scripts/test-archive-reconciliation-unit.ts
 */
import { classifyCandidate, computeCoverage, selectAlertWorthy, buildWebhookPayload, type GapRecord } from "../lib/broadcasts/archive-reconciliation";

let failures = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) console.log(`  ok: ${msg}`);
  else { console.error(`  FAIL: ${msg}\n    expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`); failures++; }
}

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

if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1); }
console.log("\nall unit assertions passed.");
