/**
 * Unit assertions for broadcast-calendar accuracy fixes (A, C-guard, D).
 * Pure logic only — no DB. Run: npm run test:calendar-accuracy
 */
import assert from "node:assert";
import { getTodayISOJST } from "../lib/broadcasts/jst-date";
import { isWhitelistedSlot } from "../lib/broadcasts/whitelist-gate";
import { shouldReconcileDate } from "../lib/broadcasts/reconcile";
import { getForwardDates } from "../lib/broadcasts/shopch-forward";
import { KEEP_NON_MISDATED_NTV_OR } from "../lib/broadcasts/ntv-suppression";

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

// --- A: fail-open whitelist gate ---
check("qvc null category shown (fail-open)", isWhitelistedSlot("qvc", null) === true);
check("qvc empty category shown (fail-open)", isWhitelistedSlot("qvc", "") === true);
check("qvc whitelisted category shown", isWhitelistedSlot("qvc", "家電") === true);
check("qvc known non-whitelist hidden", isWhitelistedSlot("qvc", "占い") === false);
check("shopch null category shown (fail-open)", isWhitelistedSlot("shopch", null) === true);
check("shopch whitelisted shown", isWhitelistedSlot("shopch", "コスメ") === true);
check("shopch known non-whitelist hidden", isWhitelistedSlot("shopch", "雑貨") === false);
check("oa channel always shown", isWhitelistedSlot("ntv", null) === true);

// --- C: reconciliation guard (future-only, non-empty scrape) ---
check("reconcile future date with slots", shouldReconcileDate("2026-06-10", "2026-06-03", 20) === true);
check("reconcile NOT today", shouldReconcileDate("2026-06-03", "2026-06-03", 20) === false);
check("reconcile NOT past", shouldReconcileDate("2026-05-30", "2026-06-03", 20) === false);
check("reconcile NOT on empty scrape", shouldReconcileDate("2026-06-10", "2026-06-03", 0) === false);

// --- B: getForwardDates (inclusive of today, month rollover) ---
function isoUTC(d: Date): string {
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
const fd0 = getForwardDates(new Date(Date.UTC(2026, 5, 3)), 0);
check("getForwardDates(0) gives exactly today", fd0.length === 1 && isoUTC(fd0[0]) === "2026-06-03");
const fd2 = getForwardDates(new Date(Date.UTC(2026, 5, 3)), 2);
check("getForwardDates(2) gives today..+2", fd2.length === 3 && isoUTC(fd2[2]) === "2026-06-05");
const fdRoll = getForwardDates(new Date(Date.UTC(2026, 11, 30)), 14);
check("getForwardDates rolls Dec→Jan", isoUTC(fdRoll[14]) === "2027-01-13");

// --- ntv mis-dated display-time suppression (De Morgan of the hide predicate) ---
// Mirror PostgREST `.or()`: keep a row if ANY "col.op.value" clause holds.
function keptByOr(orStr: string, row: Record<string, string>): boolean {
	return orStr.split(",").some((clause) => {
		const [col, op, ...rest] = clause.split(".");
		const val = rest.join(".");
		const cell = String(row[col]);
		if (op === "neq") return cell !== val;
		if (op === "gt") return cell > val; // ISO YYYY-MM-DD compares chronologically
		throw new Error(`unhandled op in KEEP_NON_MISDATED_NTV_OR: ${op}`);
	});
}
const ntvPolluted = { channel: "ntv", source_sheet: "live-crawl:ntv", air_date: "2026-06-05" };
const ntvRebuilt = { channel: "ntv", source_sheet: "live-crawl:ntv", air_date: "2026-06-11" };
const ntvXlsx = { channel: "ntv", source_sheet: "日テレポシュレ", air_date: "2026-05-06" };
const otherOA = { channel: "tbs", source_sheet: "live-crawl:tbs", air_date: "2026-06-05" };
check("ntv mis-dated row (<=cutoff, live-crawl) is hidden", keptByOr(KEEP_NON_MISDATED_NTV_OR, ntvPolluted) === false);
check("ntv rebuilt row (>cutoff) is kept", keptByOr(KEEP_NON_MISDATED_NTV_OR, ntvRebuilt) === true);
check("ntv xlsx-import row (different source_sheet) is kept", keptByOr(KEEP_NON_MISDATED_NTV_OR, ntvXlsx) === true);
check("other OA channel row is kept", keptByOr(KEEP_NON_MISDATED_NTV_OR, otherOA) === true);

console.log(`[test:calendar-accuracy] ${passed} assertions passed`);
