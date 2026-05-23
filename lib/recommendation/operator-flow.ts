export type OperatorStepStatus = "already-done" | "would-run" | "will-run" | "blocked";

export interface OperatorFlowArgs {
	id?: string;
	apply: boolean;
	runSynthesis: boolean;
	createScreenplay: boolean;
	wait: boolean;
}

export interface OperatorFlowState {
	discoveredProductId: string;
	promotedProductId: string | null;
	hasResearchResult: boolean;
	promotedScreenplayId: string | null;
	promotedScreenplayStatus: string | null;
}

export interface OperatorFlowStep {
	key: "promote" | "synthesis" | "screenplay" | "strict";
	status: OperatorStepStatus;
	message: string;
	command?: string;
}

export interface OperatorFlowPlan {
	mode: "dry-run" | "apply";
	steps: OperatorFlowStep[];
}

export function parseOperatorFlowArgs(argv: string[]): OperatorFlowArgs {
	let id: string | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg.startsWith("--id=")) {
			id = arg.slice("--id=".length);
		} else if (arg === "--id") {
			id = argv[i + 1];
			i += 1;
		}
	}
	return {
		id,
		apply: argv.includes("--apply"),
		runSynthesis: argv.includes("--run-synthesis"),
		createScreenplay: argv.includes("--create-screenplay"),
		wait: argv.includes("--wait"),
	};
}

function promotionCommand(id: string): string {
	return `npx tsx --env-file=.env.local scripts/complete-recommendation-flow.ts --id=${id} --apply`;
}

export function buildOperatorFlowPlan(
	state: OperatorFlowState,
	args: OperatorFlowArgs,
): OperatorFlowPlan {
	const mode = args.apply ? "apply" : "dry-run";
	const steps: OperatorFlowStep[] = [];

	if (state.promotedProductId) {
		steps.push({
			key: "promote",
			status: "already-done",
			message: `Discovery candidate is already promoted (${state.promotedProductId}).`,
		});
	} else {
		steps.push({
			key: "promote",
			status: args.apply ? "will-run" : "would-run",
			message: "Promote Discovery candidate to Research product.",
			command: args.apply ? undefined : promotionCommand(state.discoveredProductId),
		});
	}

	const productIdAfterPromotion = state.promotedProductId ?? (args.apply ? "<new product id>" : null);
	if (state.hasResearchResult) {
		steps.push({
			key: "synthesis",
			status: "already-done",
			message: "Research result already exists for promoted product.",
		});
	} else if (!productIdAfterPromotion) {
		steps.push({
			key: "synthesis",
			status: "blocked",
			message: "Research synthesis needs a promoted product first.",
		});
	} else {
		steps.push({
			key: "synthesis",
			status: args.runSynthesis ? "will-run" : "would-run",
			message: args.runSynthesis
				? "Run research synthesis directly from the CLI."
				: "Research synthesis is not requested; add --run-synthesis to trigger it.",
		});
	}

	if (state.promotedScreenplayId && state.promotedScreenplayStatus === "ready") {
		steps.push({
			key: "screenplay",
			status: "already-done",
			message: `Promoted product already has a linked screenplay (${state.promotedScreenplayId}).`,
		});
	} else if (state.promotedScreenplayId) {
		steps.push({
			key: "screenplay",
			status: args.createScreenplay ? "will-run" : "would-run",
			message: `Promoted product has a linked screenplay, but it is not ready (${state.promotedScreenplayStatus ?? "unknown"}).`,
		});
	} else if (!state.hasResearchResult) {
		steps.push({
			key: "screenplay",
			status: "blocked",
			message: "Screenplay creation needs a promoted product with completed research first.",
		});
	} else {
		steps.push({
			key: "screenplay",
			status: args.createScreenplay ? "will-run" : "would-run",
			message: args.createScreenplay
				? "Create a product-linked screenplay."
				: "Screenplay creation is not requested; add --create-screenplay to generate it.",
		});
	}

	steps.push({
		key: "strict",
		status:
			state.promotedProductId &&
			state.hasResearchResult &&
			state.promotedScreenplayId &&
			state.promotedScreenplayStatus === "ready"
				? "already-done"
				: "would-run",
		message: "Run npm run smoke:recommendation-flow:strict after requested stages finish.",
	});

	return { mode, steps };
}
