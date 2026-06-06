/** DB-free unit tests for archive-reconciliation pure functions.
 *   npx tsx scripts/test-archive-reconciliation-unit.ts
 */
import { classifyCandidate, computeCoverage } from "../lib/broadcasts/archive-reconciliation";

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

if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1); }
console.log("\nall unit assertions passed.");
