/**
 * The one way to start a screenplay generation.
 *
 * Before this there were three: the create route, the refine route, and
 * scripts/complete-recommendation-flow.ts, which called generateScreenplay
 * directly and inserted a version itself. That third path produced rows that
 * sit in screenplay_versions next to workflow-generated ones and are not the
 * same thing — no compliance check, no remediation, and now no generation
 * context, no knowledge snapshot and no claim links. Nothing on the row says
 * so.
 *
 * The invariants live here rather than in each caller for the same reason: a
 * refine without a base version is a bug in whichever caller forgot, and it
 * should be impossible to write a caller that forgets.
 *
 * NOTE: `start()` only works inside the Workflow DevKit's compiled runtime —
 * a Next.js route handler. A plain `tsx` script gets
 * `WorkflowRuntimeError: 'start' received an invalid workflow function`,
 * which is thrown through with that context attached rather than swallowed.
 */
import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import { screenplayWorkflow, type ScreenplayWorkflowInput } from "@/lib/workflows/screenplay.workflow";
import type { ProductBrief } from "./types";

export interface StartScreenplayGenerationInput {
	screenplayId: string;
	mode: "initial" | "refine";
	productBrief: ProductBrief;
	/** The canonical product this brief describes, when it came from the
	 *  product finder. Null for an uploaded or manually entered product — the
	 *  fact pack then rests on the brief alone. */
	canonicalProductId: string | null;
	feedback?: string;
	baseVersionId?: string;
}

export class ScreenplayStartError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "ScreenplayStartError";
		this.code = code;
	}
}

export async function startScreenplayGeneration(
	input: StartScreenplayGenerationInput,
): Promise<{ runId: string }> {
	if (!input.screenplayId) {
		throw new ScreenplayStartError("missing_screenplay", "screenplayId is required");
	}
	if (input.mode === "refine") {
		if (!input.baseVersionId) {
			throw new ScreenplayStartError("missing_base_version", "refine mode requires baseVersionId");
		}
		if (!input.feedback?.trim()) {
			throw new ScreenplayStartError("missing_feedback", "refine mode requires feedback");
		}
	}
	if (input.mode === "initial" && input.baseVersionId) {
		throw new ScreenplayStartError(
			"unexpected_base_version",
			"initial mode must not carry a baseVersionId",
		);
	}

	// Minted here, not in the workflow: a workflow body is replayed on retry, so
	// randomUUID() inside it would produce a different id each replay and break
	// determinism. Deriving one from the screenplay would collide on the second
	// refine, since both the context and its knowledge snapshot are unique on it.
	const payload: ScreenplayWorkflowInput = {
		screenplayId: input.screenplayId,
		runId: randomUUID(),
		mode: input.mode,
		productBrief: input.productBrief,
		canonicalProductId: input.canonicalProductId,
		...(input.feedback ? { feedback: input.feedback } : {}),
		...(input.baseVersionId ? { baseVersionId: input.baseVersionId } : {}),
	};

	try {
		const run = await start(screenplayWorkflow, [payload]);
		return { runId: run.runId };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("invalid workflow function")) {
			throw new ScreenplayStartError(
				"workflow_runtime_unavailable",
				"the Workflow DevKit runtime is not available here — screenplay generation must be started from the app, not from a plain script",
			);
		}
		throw error;
	}
}

/**
 * Import is a faithful separate branch: the operator's reviewed draft becomes
 * v1 unchanged. It generates no prose, so it builds no generation context and
 * asks for none — a version with a null context_id is honestly saying it was
 * not generated from evidence.
 */
export async function startScreenplayImport(input: {
	screenplayId: string;
	productBrief: ProductBrief;
	importedMarkdown: string;
}): Promise<{ runId: string }> {
	const run = await start(screenplayWorkflow, [
		{
			screenplayId: input.screenplayId,
			runId: randomUUID(),
			mode: "import" as const,
			productBrief: input.productBrief,
			canonicalProductId: null,
			importedMarkdown: input.importedMarkdown,
		},
	]);
	return { runId: run.runId };
}
