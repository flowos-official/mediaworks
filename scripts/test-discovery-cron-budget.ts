import assert from "node:assert/strict";
import {
	getOptionalStageTimeoutMs,
	hasCronBudget,
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
