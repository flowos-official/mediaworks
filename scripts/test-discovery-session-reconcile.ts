import assert from "node:assert/strict";
import { __test } from "@/lib/discovery/save";

assert.equal(__test.reconciledStatusForProductCount(30, 30), "completed");
assert.equal(__test.reconciledStatusForProductCount(12, 30), "partial");
assert.equal(__test.reconciledStatusForProductCount(0, 30), "failed");

const now = new Date("2026-05-23T00:00:00.000Z").getTime();
assert.equal(
	__test.hasCategoryEnrichmentBudget({
		nowMs: now,
		deadlineMs: now + 15_000,
		minBudgetMs: 10_000,
	}),
	true,
);
assert.equal(
	__test.hasCategoryEnrichmentBudget({
		nowMs: now,
		deadlineMs: now + 9_000,
		minBudgetMs: 10_000,
	}),
	false,
);
assert.equal(
	__test.hasCategoryEnrichmentBudget({
		nowMs: now,
		deadlineMs: undefined,
		minBudgetMs: 10_000,
	}),
	true,
);

console.log("PASS: discovery session reconciliation helpers");
