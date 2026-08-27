/**
 * Unit tests for the cron duplicate guard. Pure — no DB, no clock dependency.
 *   npx tsx scripts/test-cron-duplicate-guard.ts
 */
import {
	isDuplicateInvocation,
	DUPLICATE_WINDOW_MS,
	waitForBlockingRun,
	decideDuplicateAction,
	isDuplicateRunError,
} from "@/lib/cron/duplicate-guard";

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

// ── taking over from a run that failed ───────────────────────────────────────
// The stale build wins the live_commerce race most nights and fails ~80s in.
// First-one-wins handed it the night; the healthy caller must be able to take
// over once that run has actually failed — and only then.
// ── what to do when a run already holds the window ───────────────────────────
// Skipping on sight is what let the stale build keep live_commerce: it was
// still "running" when the healthy caller checked, so the caller stood down
// and the run it was waiting on failed 80s later.
{
	const at = (s: string, status: string) => ({ run_at: s, status });
	const now = new Date("2026-08-26T23:30:50Z");
	ok(decideDuplicateAction(at("2026-08-26T23:30:25Z", "running"), now) === "wait", "in-flight run → wait it out, do not stand down");
	ok(decideDuplicateAction(at("2026-08-26T23:30:25Z", "failed"), now) === "proceed", "failed run → proceed at once");
	ok(decideDuplicateAction(at("2026-08-26T23:30:25Z", "completed"), now) === "skip", "completed run → skip");
	ok(decideDuplicateAction(at("2026-08-26T23:30:25Z", "partial"), now) === "skip", "partial run → skip");
	ok(decideDuplicateAction(at("2026-08-26T23:00:00Z", "running"), now) === "proceed", "outside the window → proceed regardless of status");
	ok(decideDuplicateAction(null, now) === "proceed", "no previous run → proceed");
}

async function takeover() {
	const seq = (statuses: string[]) => {
		let i = 0;
		return async () => (i < statuses.length ? { status: statuses[i++], run_at: "2026-08-26T23:30:25Z" } : null);
	};
	const noSleep = async () => {};

	ok((await waitForBlockingRun(seq(["failed"]), { sleep: noSleep })) === "failed", "already failed → take over immediately");
	ok((await waitForBlockingRun(seq(["running", "running", "failed"]), { sleep: noSleep })) === "failed", "fails while waiting → take over");
	ok((await waitForBlockingRun(seq(["completed"]), { sleep: noSleep })) === "settled", "the other run succeeded → stand down");
	ok((await waitForBlockingRun(seq(["running", "partial"]), { sleep: noSleep })) === "settled", "partial counts as settled");
	ok((await waitForBlockingRun(async () => null, { sleep: noSleep })) === "failed", "blocking row gone → slot is free");
	ok(
		(await waitForBlockingRun(async () => ({ status: "running", run_at: "x" }), { sleep: noSleep, timeoutMs: 0 })) === "still-running",
		"still running at the deadline → stand down rather than pile on",
	);

	ok(isDuplicateRunError(new Error("duplicate discovery invocation for live_commerce: a run started at ...")), "recognises the discovery trigger message");
	ok(isDuplicateRunError(new Error("duplicate crawl invocation: a run started at ...")), "recognises the crawl trigger message");
	ok(!isDuplicateRunError(new Error("connection reset")), "an unrelated error is not a duplicate");
}

takeover()
	.then(() => {
		console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
		process.exit(failures === 0 ? 0 : 1);
	})
	.catch((e) => { console.error(e); process.exit(1); });
