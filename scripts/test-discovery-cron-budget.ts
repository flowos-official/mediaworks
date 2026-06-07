import assert from "node:assert/strict";
import {
	getOptionalStageTimeoutMs,
	hasCronBudget,
	OptionalStageTracker,
	runOptionalStage,
	type StageOutcome,
} from "../lib/discovery/cron-budget";

assert.equal(
	hasCronBudget({
		startedAtMs: 1_000,
		deadlineMs: 271_000,
		minBudgetMs: 45_000,
		nowMs: 200_000,
	}),
	true,
);

assert.equal(
	hasCronBudget({
		startedAtMs: 1_000,
		deadlineMs: 271_000,
		minBudgetMs: 45_000,
		nowMs: 230_000,
	}),
	false,
);

assert.equal(
	getOptionalStageTimeoutMs({
		startedAtMs: 1_000,
		deadlineMs: 271_000,
		minSaveBudgetMs: 20_000,
		nowMs: 200_000,
	}),
	52_000,
);

assert.equal(
	getOptionalStageTimeoutMs({
		startedAtMs: 1_000,
		deadlineMs: 271_000,
		minSaveBudgetMs: 20_000,
		nowMs: 252_000,
	}),
	0,
);

console.log("PASS: discovery cron budget helpers");

(async () => {
	const baseTiming = {
		startedAtMs: 1_000,
		deadlineMs: 271_000,
		minSaveBudgetMs: 20_000,
	};

	// ok: task runs to completion within budget, real value returned.
	const okOutcomes: StageOutcome[] = [];
	const okResult = await runOptionalStage({
		...baseTiming,
		nowMs: 200_000,
		label: "stage-ok",
		fallback: -1,
		task: async () => 42,
		onOutcome: (r) => okOutcomes.push(r),
	});
	assert.equal(okResult, 42, "ok stage returns task value");
	assert.deepEqual(okOutcomes, [{ label: "stage-ok", outcome: "ok" }], "ok outcome reported");

	// skipped_no_budget: timeoutMs <= 0, task never invoked, fallback returned.
	let taskInvoked = false;
	const skipOutcomes: StageOutcome[] = [];
	const skipResult = await runOptionalStage({
		...baseTiming,
		nowMs: 252_000, // remaining budget = 0
		label: "stage-skip",
		fallback: -1,
		task: async () => {
			taskInvoked = true;
			return 7;
		},
		onOutcome: (r) => skipOutcomes.push(r),
	});
	assert.equal(skipResult, -1, "skipped stage returns fallback");
	assert.equal(taskInvoked, false, "skipped stage never invokes task");
	assert.deepEqual(
		skipOutcomes,
		[{ label: "stage-skip", outcome: "skipped_no_budget" }],
		"skipped_no_budget outcome reported",
	);

	// error: task throws, fallback returned, outcome=error.
	const errOutcomes: StageOutcome[] = [];
	const errResult = await runOptionalStage({
		...baseTiming,
		nowMs: 200_000,
		label: "stage-err",
		fallback: "fallback",
		task: async () => {
			throw new Error("boom");
		},
		onOutcome: (r) => errOutcomes.push(r),
	});
	assert.equal(errResult, "fallback", "errored stage returns fallback");
	assert.deepEqual(errOutcomes, [{ label: "stage-err", outcome: "error" }], "error outcome reported");

	// timeout: small positive budget, task never resolves → deadline wins.
	const toOutcomes: StageOutcome[] = [];
	const toResult = await runOptionalStage({
		startedAtMs: 0,
		deadlineMs: 30,
		minSaveBudgetMs: 0,
		nowMs: 0, // remaining budget = 30ms
		label: "stage-timeout",
		fallback: "fb",
		task: () => new Promise<string>(() => {}), // never resolves
		onOutcome: (r) => toOutcomes.push(r),
	});
	assert.equal(toResult, "fb", "timed-out stage returns fallback");
	assert.deepEqual(toOutcomes, [{ label: "stage-timeout", outcome: "timeout" }], "timeout outcome reported");

	// Tracker: skipped() filters out ok, keeps non-ok in order.
	const tracker = new OptionalStageTracker();
	tracker.record({ label: "a", outcome: "ok" });
	tracker.record({ label: "b", outcome: "timeout" });
	tracker.record({ label: "c", outcome: "ok" });
	tracker.record({ label: "d", outcome: "skipped_no_budget" });
	assert.deepEqual(
		tracker.skipped(),
		[
			{ label: "b", outcome: "timeout" },
			{ label: "d", outcome: "skipped_no_budget" },
		],
		"tracker.skipped() returns only non-ok stages",
	);
	assert.equal(tracker.all().length, 4, "tracker.all() returns every outcome");

	console.log("PASS: runOptionalStage outcome reporting + tracker");
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
