/** DB-free unit tests for archive-reconciliation pure functions.
 *   npx tsx scripts/test-archive-reconciliation-unit.ts
 */
import { classifyCandidate } from "../lib/broadcasts/archive-reconciliation";

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

if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1); }
console.log("\nall unit assertions passed.");
