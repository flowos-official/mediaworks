import assert from "node:assert/strict";
import {
	outcomeWeight,
	userActionWeight,
	aggregateCategoryWeights,
	type CohortRow,
} from "../lib/discovery/outcome-weight";

// outcomeWeight
assert.equal(outcomeWeight("aired"), 5);
assert.equal(outcomeWeight("scheduled"), 3);
assert.equal(outcomeWeight("sourcing"), 2);
assert.equal(outcomeWeight("selected"), 1);
assert.equal(outcomeWeight("dropped"), -1);
assert.equal(outcomeWeight(null), 0);
assert.equal(outcomeWeight(undefined), 0);

// userActionWeight — interested must still count (it never creates a selection)
assert.equal(userActionWeight("interested"), 1);
assert.equal(userActionWeight("sourced"), 1);
assert.equal(userActionWeight("rejected"), 0);
assert.equal(userActionWeight("duplicate"), 0);
assert.equal(userActionWeight(null), 0);

const row = (
	category: string | null,
	so: CohortRow["selection_outcome"],
	ua: CohortRow["user_action"],
): CohortRow => ({ category, selection_outcome: so, user_action: ua });

// 5 aired rows in one category → success 25 / shown 5 = 5 → capped to 3
{
	const cohort = Array.from({ length: 5 }, () => row("knife", "aired", null));
	const w = aggregateCategoryWeights(cohort, {});
	assert.equal(w.knife, 3);
}

// below min-samples → neutral 0.5
{
	const cohort = [row("rare", "aired", null)];
	const w = aggregateCategoryWeights(cohort, {});
	assert.equal(w.rare, 0.5);
}

// selection_outcome takes precedence over a stale user_action
{
	const cohort = Array.from({ length: 5 }, () => row("backedout", "dropped", "sourced"));
	const w = aggregateCategoryWeights(cohort, {});
	assert.equal(w.backedout, 0); // success -5 / 5 = -1 → clamp to 0
}

// interested floor: no selection_outcome → user_action counts
{
	const cohort = Array.from({ length: 5 }, () => row("liked", null, "interested"));
	const w = aggregateCategoryWeights(cohort, {});
	assert.equal(w.liked, 1); // 5*1 / 5
}

// deep-dive clicks fold in at 0.5 each
{
	const cohort = Array.from({ length: 5 }, () => row("dd", null, null)); // shown 5, success 0
	const w = aggregateCategoryWeights(cohort, { dd: 4 }); // +0.5*4 = 2 success
	assert.equal(w.dd, 0.4); // 2 / 5
}

// null category is ignored
{
	const cohort = [row(null, "aired", null)];
	const w = aggregateCategoryWeights(cohort, {});
	assert.deepEqual(w, {});
}

console.log("PASS: learning outcome weighting");
