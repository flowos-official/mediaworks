/**
 * Unit assertions for broadcast-calendar accuracy fixes (A, C-guard, D).
 * Pure logic only — no DB. Run: npm run test:calendar-accuracy
 */
import assert from "node:assert";
import { getTodayISOJST } from "../lib/broadcasts/jst-date";

let passed = 0;
function check(label: string, cond: boolean) {
	assert.ok(cond, `FAILED: ${label}`);
	passed++;
}

// --- D: getTodayISOJST ---
// 2026-06-02T18:30:00Z is 2026-06-03 03:30 JST → JST date is 2026-06-03.
check(
	"getTodayISOJST rolls to JST day during JST early morning",
	getTodayISOJST(new Date("2026-06-02T18:30:00Z")) === "2026-06-03",
);
// 2026-06-02T02:00:00Z is 2026-06-02 11:00 JST → 2026-06-02.
check(
	"getTodayISOJST same day midday",
	getTodayISOJST(new Date("2026-06-02T02:00:00Z")) === "2026-06-02",
);

console.log(`[test:calendar-accuracy] ${passed} assertions passed`);
