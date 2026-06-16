/**
 * Unit assertions for broadcast-calendar accuracy fixes (A, C-guard, D).
 * Pure logic only — no DB. Run: npm run test:calendar-accuracy
 */
import assert from "node:assert";
import { getTodayISOJST } from "../lib/broadcasts/jst-date";
import { isWhitelistedSlot } from "../lib/broadcasts/whitelist-gate";
import { shouldReconcileDate } from "../lib/broadcasts/reconcile";
import { getForwardDates } from "../lib/broadcasts/shopch-forward";
import { MISDATED_OA_OR_CLAUSES } from "../lib/broadcasts/misdated-suppression";

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

// --- mis-dated OA display-time suppression (De Morgan of the hide predicate) ---
// Mirror PostgREST: a row is kept iff it passes EVERY channel's `.or()` clause
// (chained .or() calls AND-combine); within a clause, keep if ANY term holds.
function keptByClause(orStr: string, row: Record<string, string>): boolean {
	return orStr.split(",").some((clause) => {
		const [col, op, ...rest] = clause.split(".");
		const val = rest.join(".");
		const cell = String(row[col]);
		if (op === "neq") return cell !== val;
		if (op === "gt") return cell > val; // ISO YYYY-MM-DD compares chronologically
		throw new Error(`unhandled op in MISDATED_OA_OR_CLAUSES: ${op}`);
	});
}
function kept(row: Record<string, string>): boolean {
	return MISDATED_OA_OR_CLAUSES.every((c) => keptByClause(c, row));
}
check("ntv mis-dated row (<=cutoff) hidden", kept({ channel: "ntv", source_sheet: "live-crawl:ntv", air_date: "2026-06-05" }) === false);
check("junsanpo mis-dated row (<=cutoff) hidden", kept({ channel: "junsanpo", source_sheet: "live-crawl:junsanpo", air_date: "2026-05-16" }) === false);
check("tbs mis-dated row (<=cutoff) hidden", kept({ channel: "tbs", source_sheet: "live-crawl:tbs", air_date: "2026-06-01" }) === false);
check("ntv rebuilt row (>cutoff) kept", kept({ channel: "ntv", source_sheet: "live-crawl:ntv", air_date: "2026-06-11" }) === true);
check("junsanpo rebuilt row (>cutoff) kept", kept({ channel: "junsanpo", source_sheet: "live-crawl:junsanpo", air_date: "2026-06-10" }) === true);
check("tbs rebuilt row (>cutoff) kept", kept({ channel: "tbs", source_sheet: "live-crawl:tbs", air_date: "2026-06-15" }) === true);
check("dinos May pollution (<=cutoff) hidden", kept({ channel: "dinos", source_sheet: "live-crawl:dinos", air_date: "2026-05-20" }) === false);
check("dinos June rebuilt (>cutoff) kept", kept({ channel: "dinos", source_sheet: "live-crawl:dinos", air_date: "2026-06-05" }) === true);
check("ntv xlsx-import row (different source_sheet) kept", kept({ channel: "ntv", source_sheet: "日テレポシュレ", air_date: "2026-05-06" }) === true);
check("unaffected OA channel (kantv) kept", kept({ channel: "kantv", source_sheet: "live-crawl:kantv", air_date: "2026-05-20" }) === true);
// uranoura needs no suppression clause — its parser now emits zero rows (the
// asahi page has no dates), so there is nothing mis-dated to hide. Any uranoura
// row that exists (xlsx import) passes through.
check("uranoura xlsx-import row kept (no suppression clause)", kept({ channel: "uranoura", source_sheet: "ABCウラのウラまで失礼します", air_date: "2026-05-01" }) === true);

console.log(`[test:calendar-accuracy] ${passed} assertions passed`);
