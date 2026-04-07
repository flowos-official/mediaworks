import { getWritable, FatalError } from "workflow";
import {
	fetchLCContext,
	runLCSkill,
	LC_SKILL_NAMES,
	type LCContext,
	type LCProgressEvent,
	type PlatformAnalysisOutput,
} from "@/lib/live-commerce-strategy";
import { discoverNewProducts, type DiscoveredProduct } from "@/lib/md-strategy";
import { getServiceClient } from "@/lib/supabase";

export interface LCWorkflowInput {
	userGoal?: string;
	targetPlatforms?: string[];
}

async function fetchContextStep(input: LCWorkflowInput): Promise<LCContext> {
	"use step";
	const ctx = await fetchLCContext(input.userGoal || undefined, input.targetPlatforms);
	console.log(`[lc-workflow] context fetched (discovery deferred to final step)`);
	return ctx;
}

async function runDiscoveryStep(
	input: LCWorkflowInput,
	context: LCContext,
	outputs: Record<string, unknown>,
): Promise<DiscoveredProduct[] | undefined> {
	"use step";
	console.log(`[lc-workflow] running final discovery with full analysis context`);
	const summary = buildLCAnalysisSummary(outputs);
	try {
		const products = await discoverNewProducts({
			context: "live_commerce",
			topCategoryNames: context.topCategoryNames ?? [],
			userGoal: input.userGoal,
			tvProductNames: context.products.map((p) => p.name),
			tvMarginRate: context.avgMarginRate ?? 0,
			analysisContext: summary,
		});
		console.log(`[lc-workflow] discovery complete: ${products?.length ?? 0} products`);
		return products;
	} catch (err) {
		console.error(`[lc-workflow] discovery failed: ${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	}
}
runDiscoveryStep.maxRetries = 0;

function buildLCAnalysisSummary(outputs: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const key of ["market_research", "platform_analysis", "content_strategy", "execution_plan", "risk_analysis"]) {
		const val = outputs[key];
		if (val && typeof val === "object" && Object.keys(val as object).length > 0) {
			parts.push(`[${key}] ${JSON.stringify(val).slice(0, 900)}`);
		}
	}
	return parts.join("\n\n");
}

async function runSkillStep(
	skillName: typeof LC_SKILL_NAMES[number],
	context: LCContext,
	parsedGoal: LCContext["parsedGoal"] | null,
	priorOutputs: Record<string, unknown>,
): Promise<unknown> {
	"use step";
	console.log(`[lc-workflow] running skill=${skillName} | ctx.recommendedProducts=${context.recommendedProducts?.length ?? "undefined"}`);
	const ctx: LCContext = parsedGoal ? { ...context, parsedGoal } : context;
	try {
		const result = await runLCSkill(skillName, ctx, priorOutputs);
		if (skillName === "platform_analysis") {
			const pa = result as { discovered_new_products?: unknown[] } | undefined;
			console.log(`[lc-workflow] platform_analysis result.discovered_new_products=${pa?.discovered_new_products?.length ?? "undefined"}`);
		}
		console.log(`[lc-workflow] skill=${skillName} complete`);
		return result;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[lc-workflow] skill=${skillName} failed (no retry): ${message}`);
		throw new FatalError(`${skillName}: ${message}`);
	}
}
// 1 retry: with 25s first-chunk watchdog, stalled Gemini fails fast and retry recovers.
runSkillStep.maxRetries = 1;

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
	let aborted = false;
	let abortReason: string | null = null;

	// Foundational skills — downstream skills crash on undefined fields if these fail.
	const FOUNDATIONAL: string[] = ["market_research", "platform_analysis"];

	for (let i = 0; i < LC_SKILL_NAMES.length; i++) {
		const name = LC_SKILL_NAMES[i];
		if (aborted) {
			outputs[name] = {};
			await emitProgressStep({
				skill: name,
				status: "error",
				index: i,
				total: LC_SKILL_NAMES.length,
				error: `Skipped: upstream failure (${abortReason})`,
			});
			continue;
		}
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
			if (FOUNDATIONAL.includes(name)) {
				aborted = true;
				abortReason = name;
				console.error(`[lc-workflow] foundational skill ${name} failed — aborting downstream skills`);
			}
		}
	}

	await emitProgressStep({
		skill: "new_product_discovery",
		status: "running",
		index: LC_SKILL_NAMES.length,
		total: LC_SKILL_NAMES.length + 1,
	});
	const discovered = await runDiscoveryStep(input, context, outputs);
	const paExisting = outputs.platform_analysis as PlatformAnalysisOutput | undefined;
	const paSucceeded = !!paExisting && Object.keys(paExisting).length > 0;
	if (discovered && discovered.length > 0 && paSucceeded) {
		const pa = (outputs.platform_analysis as PlatformAnalysisOutput | undefined) ?? {} as PlatformAnalysisOutput;
		pa.discovered_new_products = discovered;
		pa.discovery_history = [{ generatedAt: new Date().toISOString(), products: discovered }];
		outputs.platform_analysis = pa;
		await emitProgressStep({
			skill: "platform_analysis",
			status: "complete",
			index: 2,
			total: LC_SKILL_NAMES.length,
			data: pa,
		});
	}
	await emitProgressStep({
		skill: "new_product_discovery",
		status: "complete",
		index: LC_SKILL_NAMES.length,
		total: LC_SKILL_NAMES.length + 1,
		data: { count: discovered?.length ?? 0 },
	});

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
