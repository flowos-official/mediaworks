import { getWritable } from "workflow";
import {
	fetchStrategyContext,
	runMDSkill,
	MD_SKILL_NAMES,
	type StrategyContext,
	type RecommendInput,
	type ProgressEvent,
	type ParsedGoal,
} from "@/lib/md-strategy";
import { getServiceClient } from "@/lib/supabase";

export interface MDWorkflowInput {
	userGoal?: string;
	category?: string;
	targetMarket?: string;
	priceRange?: string;
}

// ---------------------------------------------------------------------------
// Step: fetch context (DB + initial brave queries + new-product discovery).
// Resolves the discovery promise so the returned context is fully serializable.
// ---------------------------------------------------------------------------
async function fetchContextStep(input: MDWorkflowInput): Promise<StrategyContext> {
	"use step";
	const recommend: RecommendInput | undefined =
		input.category && input.targetMarket
			? { category: input.category, targetMarket: input.targetMarket, priceRange: input.priceRange }
			: undefined;
	const ctx = await fetchStrategyContext(input.userGoal || undefined, recommend);
	if (ctx.recommendedProductsPromise) {
		ctx.recommendedProducts = await ctx.recommendedProductsPromise;
		delete ctx.recommendedProductsPromise;
	}
	console.log(`[md-workflow] context fetched, discovered=${ctx.recommendedProducts?.length ?? 0}`);
	return ctx;
}

// ---------------------------------------------------------------------------
// Step: run a single skill. Each invocation is its own function call,
// so the 300s Vercel ceiling no longer applies to the aggregate pipeline.
// ---------------------------------------------------------------------------
async function runSkillStep(
	skillName: typeof MD_SKILL_NAMES[number],
	context: StrategyContext,
	parsedGoal: ParsedGoal | null,
	priorOutputs: Record<string, unknown>,
): Promise<unknown> {
	"use step";
	console.log(`[md-workflow] running skill=${skillName}`);
	// Re-attach parsedGoal inside the step so we don't rely on coordinator-side mutation.
	const ctx: StrategyContext = parsedGoal ? { ...context, parsedGoal } : context;
	const result = await runMDSkill(skillName, ctx, priorOutputs);
	console.log(`[md-workflow] skill=${skillName} complete`);
	return result;
}

// ---------------------------------------------------------------------------
// Step: emit a progress event to the namespaced stream consumed by the client.
// ---------------------------------------------------------------------------
async function emitProgressStep(event: ProgressEvent): Promise<void> {
	"use step";
	const writable = getWritable<ProgressEvent>({ namespace: "progress" });
	const writer = writable.getWriter();
	try {
		await writer.write(event);
	} finally {
		writer.releaseLock();
	}
}

async function closeProgressStep(): Promise<void> {
	"use step";
	await getWritable<ProgressEvent>({ namespace: "progress" }).close();
}

// ---------------------------------------------------------------------------
// Step: persist the final strategy to Supabase.
// ---------------------------------------------------------------------------
async function saveStrategyStep(
	input: MDWorkflowInput,
	context: StrategyContext,
	outputs: Record<string, unknown>,
): Promise<string | null> {
	"use step";
	try {
		const supabase = getServiceClient();
		const { data, error } = await supabase
			.from("md_strategies")
			.insert({
				user_goal: input.userGoal || null,
				category: input.category || null,
				target_market: input.targetMarket || null,
				price_range: input.priceRange || null,
				product_selection: outputs.product_selection as Record<string, unknown>,
				channel_strategy: outputs.channel_strategy as Record<string, unknown>,
				pricing_margin: outputs.pricing_margin as Record<string, unknown>,
				marketing_execution: outputs.marketing_execution as Record<string, unknown>,
				financial_projection: outputs.financial_projection as Record<string, unknown>,
				risk_contingency: outputs.risk_contingency as Record<string, unknown>,
			})
			.select("id")
			.single();
		if (error) {
			console.error("[md-workflow] save failed:", error.message);
			return null;
		}
		return data?.id ?? null;
	} catch (err) {
		console.error("[md-workflow] save error:", err);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Workflow entrypoint
// ---------------------------------------------------------------------------
export async function mdStrategyWorkflow(input: MDWorkflowInput) {
	"use workflow";

	await emitProgressStep({ skill: "data_fetch", status: "running", index: -1, total: 7 });
	const context = await fetchContextStep(input);
	await emitProgressStep({ skill: "data_fetch", status: "complete", index: -1, total: 7 });

	const outputs: Record<string, unknown> = {};
	let parsedGoal: ParsedGoal | null = null;

	for (let i = 0; i < MD_SKILL_NAMES.length; i++) {
		const name = MD_SKILL_NAMES[i];
		await emitProgressStep({ skill: name, status: "running", index: i, total: MD_SKILL_NAMES.length });
		try {
			const result = await runSkillStep(name, context, parsedGoal, outputs);
			outputs[name] = result;
			if (name === "goal_analysis" && result) {
				parsedGoal = result as ParsedGoal;
			}
			await emitProgressStep({
				skill: name,
				status: "complete",
				index: i,
				total: MD_SKILL_NAMES.length,
				data: result ?? undefined,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			outputs[name] = {};
			await emitProgressStep({
				skill: name,
				status: "error",
				index: i,
				total: MD_SKILL_NAMES.length,
				error: message,
			});
		}
	}

	let strategyId: string | null = null;
	try {
		strategyId = await saveStrategyStep(input, context, outputs);
		await emitProgressStep({
			skill: "data_fetch",
			status: "complete",
			index: 999,
			total: MD_SKILL_NAMES.length,
			data: { complete: true, strategyId, generatedAt: new Date().toISOString() },
		});
	} finally {
		await closeProgressStep();
	}

	return { strategyId, generatedAt: new Date().toISOString() };
}
