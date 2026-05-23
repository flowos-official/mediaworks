import assert from "node:assert/strict";
import {
	buildOperatorFlowPlan,
	parseOperatorFlowArgs,
	type OperatorFlowState,
} from "../lib/recommendation/operator-flow";

const emptyState: OperatorFlowState = {
	discoveredProductId: "dp-1",
	promotedProductId: null,
	hasResearchResult: false,
	promotedScreenplayId: null,
	promotedScreenplayStatus: null,
};

assert.deepEqual(parseOperatorFlowArgs(["--id=dp-1", "--apply", "--run-synthesis"]), {
	id: "dp-1",
	apply: true,
	runSynthesis: true,
	createScreenplay: false,
	wait: false,
});

assert.deepEqual(parseOperatorFlowArgs(["--id", "dp-2", "--create-screenplay", "--wait"]), {
	id: "dp-2",
	apply: false,
	runSynthesis: false,
	createScreenplay: true,
	wait: true,
});

const dryRunPlan = buildOperatorFlowPlan(emptyState, parseOperatorFlowArgs([]));
assert.equal(dryRunPlan.mode, "dry-run");
assert.deepEqual(dryRunPlan.steps.map((step) => step.key), [
	"promote",
	"synthesis",
	"screenplay",
	"strict",
]);
assert.equal(dryRunPlan.steps[0].status, "would-run");
assert.match(
	dryRunPlan.steps[0].command ?? "",
	/npx tsx --env-file=.env.local scripts\/complete-recommendation-flow.ts --id=dp-1 --apply/,
);

const applyPlan = buildOperatorFlowPlan(emptyState, parseOperatorFlowArgs(["--apply", "--run-synthesis", "--create-screenplay"]));
assert.equal(applyPlan.mode, "apply");
assert.equal(applyPlan.steps[0].status, "will-run");
assert.equal(applyPlan.steps[1].status, "will-run");
assert.equal(applyPlan.steps[2].status, "blocked");

const researchReady: OperatorFlowState = {
	discoveredProductId: "dp-1",
	promotedProductId: "p-1",
	hasResearchResult: true,
	promotedScreenplayId: null,
	promotedScreenplayStatus: null,
};
const screenplayPlan = buildOperatorFlowPlan(
	researchReady,
	parseOperatorFlowArgs(["--apply", "--create-screenplay"]),
);
assert.equal(screenplayPlan.steps[0].status, "already-done");
assert.equal(screenplayPlan.steps[1].status, "already-done");
assert.equal(screenplayPlan.steps[2].status, "will-run");

const screenplayGenerating: OperatorFlowState = {
	...researchReady,
	promotedScreenplayId: "sp-1",
	promotedScreenplayStatus: "generating",
};
const generatingPlan = buildOperatorFlowPlan(
	screenplayGenerating,
	parseOperatorFlowArgs(["--apply", "--create-screenplay"]),
);
assert.equal(generatingPlan.steps[2].status, "will-run");
assert.match(generatingPlan.steps[2].message, /not ready/);
assert.equal(generatingPlan.steps[3].status, "would-run");

console.log("PASS: recommendation operator flow helpers");
