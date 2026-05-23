import { getServiceClient } from "../lib/supabase";
import {
	buildRecommendationFlowChecks,
	formatFlowCheck,
	hasStrictFailures,
	summarizeStrictFailures,
	type RecommendationFlowCheck,
} from "../lib/recommendation/flow-readiness";
import { loadRecommendationFlowEvidence } from "../lib/recommendation/flow-evidence";

const sb = getServiceClient();
const strict = process.argv.includes("--strict");

function fail(message: string): never {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

function pass(message: string) {
	console.log(`PASS: ${message}`);
}

async function main() {
	let checks: RecommendationFlowCheck[];
	try {
		const evidence = await loadRecommendationFlowEvidence(sb);
		checks = buildRecommendationFlowChecks(evidence);
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
	for (const item of checks) {
		const line = formatFlowCheck(item);
		if (item.status === "pass") {
			console.log(line);
		} else if (item.status === "warn") {
			console.warn(line);
		} else {
			console.error(line);
		}
	}

	if (strict && hasStrictFailures(checks)) {
		console.error("\nSTRICT recommendation-flow failures:");
		console.error(summarizeStrictFailures(checks));
		process.exit(1);
	}

	if (!strict && hasStrictFailures(checks)) {
		console.warn("\nRun with --strict to fail CI/operator checks on the warnings above.");
	}

	pass(strict ? "strict recommendation flow complete" : "recommendation flow diagnostic complete");
}

void main();
