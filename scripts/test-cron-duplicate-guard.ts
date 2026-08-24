/**
 * Unit tests for the cron duplicate guard. Pure — no DB, no clock dependency.
 *   npx tsx scripts/test-cron-duplicate-guard.ts
 */
import { isDuplicateInvocation, DUPLICATE_WINDOW_MS } from "@/lib/cron/duplicate-guard";

let failures = 0;
function ok(cond: boolean, msg: string) {
	if (cond) console.log(`  ok: ${msg}`);
	else { console.error(`  FAIL: ${msg}`); failures++; }
}
const now = new Date("2026-08-24T23:00:49Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

// The observed duplicates: 26-47 s after the run that already started.
ok(isDuplicateInvocation(ago(47_000), now), "47s after the previous run → duplicate");
ok(isDuplicateInvocation(ago(26_000), now), "26s after → duplicate");
ok(isDuplicateInvocation(ago(0), now), "same instant → duplicate");

// The real schedule: the OA crawl's two daily runs are 8h apart, discovery
// home and live are 30 min apart.
ok(!isDuplicateInvocation(ago(8 * 3600_000), now), "8h apart → the next scheduled run");
ok(!isDuplicateInvocation(ago(30 * 60_000), now), "30min apart → not a duplicate");
ok(!isDuplicateInvocation(ago(DUPLICATE_WINDOW_MS), now), "exactly at the window edge → not a duplicate");
ok(isDuplicateInvocation(ago(DUPLICATE_WINDOW_MS - 1), now), "just inside the window → duplicate");

// The guard must never be the reason a job stops running.
ok(!isDuplicateInvocation(null, now), "no previous run → proceed");
ok(!isDuplicateInvocation(undefined, now), "undefined → proceed");
ok(!isDuplicateInvocation("not-a-date", now), "unparseable timestamp → proceed");
ok(!isDuplicateInvocation(new Date(now.getTime() + 60_000), now), "future timestamp (clock skew) → proceed");

// Accepts a Date as well as the ISO string the database returns.
ok(isDuplicateInvocation(new Date(now.getTime() - 10_000), now), "Date input works like the ISO string");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
