import { getWritable } from "workflow";
import {
	fetchLCContext,
	runLCSkill,
	LC_SKILL_NAMES,
	type LCContext,
	type LCProgressEvent,
} from "@/lib/live-commerce-strategy";
import { getServiceClient } from "@/lib/supabase";

export interface LCWorkflowInput {
	userGoal?: string;
	targetPlatforms?: string[];
}

async function fetchContextStep(input: LCWorkflowInput): Promise<LCContext> {
	"use step";
	const ctx = await fetchLCContext(input.userGoal || undefined, input.targetPlatforms);
	if (ctx.recommendedProductsPromise) {
		ctx.recommendedProducts = await ctx.recommendedProductsPromise;
		delete ctx.recommendedProductsPromise;
	}
	console.log(`[lc-workflow] context fetched, discovered=${ctx.recommendedProducts?.length ?? 0}`);
	return ctx;
}

async function runSkillStep(
	skillName: typeof LC_SKILL_NAMES[number],
	context: LCContext,
	parsedGoal: LCContext["parsedGoal"] | null,
	priorOutputs: Record<string, unknown>,
): Promise<unknown> {
	"use step";
	console.log(`[lc-workflow] running skill=${skillName}`);
	const ctx: LCContext = parsedGoal ? { ...context, parsedGoal } : context;
	const result = await runLCSkill(skillName, ctx, priorOutputs);
	console.log(`[lc-workflow] skill=${skillName} complete`);
	return result;
}

async function emitProgressStep(event: LCProgressEvent): Promise<void> {
	"use step";
	const writer = getWritable<LCProgressEvent>({ namespace: "progress" }).getWriter();
	try {
		await writer.write(event);
	} finally {
		writer.releaseLock();
	}
}

async function closeProgressStep(): Promise<void> {
	"use step";
	await getWritable<LCProgressEvent>({ namespace: "progress" }).close();
}

async function saveStrategyStep(
	input: LCWorkflowInput,
	context: LCContext,
	outputs: Record<string, unknown>,
): Promise<string | null> {
	"use step";
	try {
		const supabase = getServiceClient();
		const { data, error } = await supabase
			.from("live_commerce_strategies")
			.insert({
				user_goal: input.userGoal || null,
				target_platforms: input.targetPlatforms ?? context.parsedGoal?.target_platforms ?? null,
				market_research: outputs.market_research as Record<string, unknown>,
				platform_analysis: outputs.platform_analysis as Record<string, unknown>,
				content_strategy: outputs.content_strategy as Record<string, unknown>,
				execution_plan: outputs.execution_plan as Record<string, unknown>,
				risk_analysis: outputs.risk_analysis as Record<string, unknown>,
				search_sources: context.searchSources as unknown as Record<string, unknown>[],
			})
			.select("id")
			.single();
		if (error) {
			console.error("[lc-workflow] save failed:", error.message);
			return null;
		}
		return data?.id ?? null;
	} catch (err) {
		console.error("[lc-workflow] save error:", err);
		return null;
	}
}

export async function liveCommerceWorkflow(input: LCWorkflowInput) {
	"use workflow";

	await emitProgressStep({ skill: "data_fetch", status: "running", index: -1, total: 6 });
	const context = await fetchContextStep(input);
	await emitProgressStep({ skill: "data_fetch", status: "complete", index: -1, total: 6 });

	const outputs: Record<string, unknown> = {};
	let parsedGoal: LCContext["parsedGoal"] | null = null;

	for (let i = 0; i < LC_SKILL_NAMES.length; i++) {
		const name = LC_SKILL_NAMES[i];
		await emitProgressStep({ skill: name, status: "running", index: i, total: LC_SKILL_NAMES.length });
		try {
			const result = await runSkillStep(name, context, parsedGoal, outputs);
			outputs[name] = result;
			if (name === "goal_analysis" && result) {
				parsedGoal = result as LCContext["parsedGoal"];
			}
			await emitProgressStep({
				skill: name,
				status: "complete",
				index: i,
				total: LC_SKILL_NAMES.length,
				data: result ?? undefined,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			outputs[name] = {};
			await emitProgressStep({
				skill: name,
				status: "error",
				index: i,
				total: LC_SKILL_NAMES.length,
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
			total: LC_SKILL_NAMES.length,
			data: { complete: true, strategyId, generatedAt: new Date().toISOString() },
		});
	} finally {
		await closeProgressStep();
	}

	return { strategyId, generatedAt: new Date().toISOString() };
}
