import { getWritable, FatalError } from "workflow";
import {
	fetchStrategyContext,
	runMDSkill,
	MD_SKILL_NAMES,
	discoverNewProducts,
	type StrategyContext,
	type RecommendInput,
	type ProgressEvent,
	type ParsedGoal,
	type DiscoveredProduct,
	type ProductSelectionOutput,
} from "@/lib/md-strategy";
import { getServiceClient } from "@/lib/supabase";
import { buildTVShoppingProfile } from "@/lib/tv-shopping-profile";

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
	console.log(`[md-workflow] context fetched (discovery deferred to final step)`);
	return ctx;
}

// Final step: use all accumulated skill outputs as analysis context for the discovery
// curation prompt so the new-product recommendations reflect the full strategy.
async function runDiscoveryStep(
	input: MDWorkflowInput,
	context: StrategyContext,
	outputs: Record<string, unknown>,
): Promise<DiscoveredProduct[] | undefined> {
	"use step";
	console.log(`[md-workflow] running final discovery with full analysis context`);
	const summary = buildMDAnalysisSummary(outputs);
	try {
		const tvProfile = buildTVShoppingProfile(
			context.products.map((p) => ({
				product_code: p.code,
				product_name: p.name,
				category: p.category,
				year: 2025,
				total_quantity: p.totalQuantity,
				total_revenue: p.totalRevenue,
				total_cost: p.totalRevenue - p.totalProfit,
				total_profit: p.totalProfit,
				week_count: p.weekCount,
				avg_weekly_qty: p.avgWeeklyQty,
				margin_rate: p.marginRate,
			})),
			context.categoryBreakdown.map((c) => ({
				category: c.category,
				year: 2025,
				total_quantity: c.quantity,
				total_revenue: c.revenue,
				total_profit: c.profit,
				product_count: c.productCount,
				margin_rate: c.marginRate,
			})),
		);
		const products = await discoverNewProducts({
			context: "home_shopping",
			topCategoryNames: context.categoryBreakdown.slice(0, 3).map((c) => c.category),
			explicitCategory: input.category,
			targetMarket: input.targetMarket,
			priceRange: input.priceRange,
			userGoal: input.userGoal,
			tvProductNames: context.products.map((p) => p.name),
			tvMarginRate: context.annualMetrics.marginRate,
			analysisContext: summary,
			tvProfile,
			lightweight: true,
		});
		console.log(`[md-workflow] discovery complete: ${products?.length ?? 0} products`);
		return products;
	} catch (err) {
		console.error(`[md-workflow] discovery failed: ${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	}
}
runDiscoveryStep.maxRetries = 0;

function buildMDAnalysisSummary(outputs: Record<string, unknown>): string {
	const parts: string[] = [];
	const ps = outputs.product_selection as ProductSelectionOutput | undefined;
	if (ps && Object.keys(ps).length > 0) {
		parts.push(`[product_selection] ${JSON.stringify(ps).slice(0, 1200)}`);
	}
	for (const key of ["channel_strategy", "pricing_margin", "marketing_execution", "financial_projection", "risk_contingency"]) {
		const val = outputs[key];
		if (val && typeof val === "object" && Object.keys(val as object).length > 0) {
			parts.push(`[${key}] ${JSON.stringify(val).slice(0, 800)}`);
		}
	}
	return parts.join("\n\n");
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
	const ctx: StrategyContext = parsedGoal ? { ...context, parsedGoal } : context;
	try {
		const result = await runMDSkill(skillName, ctx, priorOutputs);
		console.log(`[md-workflow] skill=${skillName} complete`);
		return result;
	} catch (err) {
		// Convert any failure to FatalError so the workflow runtime does not retry
		// (Gemini hangs would otherwise loop the step 3 more times).
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[md-workflow] skill=${skillName} failed (no retry): ${message}`);
		throw new FatalError(`${skillName}: ${message}`);
	}
}
// Allow 1 retry — with the new 25s first-chunk watchdog, a stalled Gemini stream
// fails fast and a retry usually succeeds. Without retry, intermittent network
// stalls would mark the whole skill as failed.
runSkillStep.maxRetries = 1;

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
	let aborted = false;
	let abortReason: string | null = null;

	// Skills that produce foundational data for downstream skills. If one fails,
	// later skills will crash accessing undefined fields → abort the whole pipeline
	// to avoid burning tokens on guaranteed failures.
	const FOUNDATIONAL: string[] = ["product_selection", "channel_strategy"];

	for (let i = 0; i < MD_SKILL_NAMES.length; i++) {
		const name = MD_SKILL_NAMES[i];
		if (aborted) {
			outputs[name] = {};
			await emitProgressStep({
				skill: name,
				status: "error",
				index: i,
				total: MD_SKILL_NAMES.length,
				error: `Skipped: upstream failure (${abortReason})`,
			});
			continue;
		}
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
			if (FOUNDATIONAL.includes(name)) {
				aborted = true;
				abortReason = name;
				console.error(`[md-workflow] foundational skill ${name} failed — aborting downstream skills`);
			}
		}
	}

	// Final step: discover new products using all prior skill outputs as context.
	// Runs even if some skills failed — hero is still valuable on its own.
	await emitProgressStep({
		skill: "new_product_discovery",
		status: "running",
		index: MD_SKILL_NAMES.length,
		total: MD_SKILL_NAMES.length + 1,
	});
	const discovered = await runDiscoveryStep(input, context, outputs);
	const psExisting = outputs.product_selection as ProductSelectionOutput | undefined;
	const psSucceeded = !!psExisting && Object.keys(psExisting).length > 0;
	if (discovered && discovered.length > 0 && psSucceeded) {
		// Inject into product_selection output so the frontend hero renders from the
		// existing field path (no DB schema change).
		const ps = (outputs.product_selection as ProductSelectionOutput | undefined) ?? {} as ProductSelectionOutput;
		ps.discovered_new_products = discovered;
		ps.discovery_history = [{ generatedAt: new Date().toISOString(), products: discovered }];
		outputs.product_selection = ps;
		await emitProgressStep({
			skill: "product_selection",
			status: "complete",
			index: 1,
			total: MD_SKILL_NAMES.length,
			data: ps,
		});
	}
	await emitProgressStep({
		skill: "new_product_discovery",
		status: "complete",
		index: MD_SKILL_NAMES.length,
		total: MD_SKILL_NAMES.length + 1,
		data: { count: discovered?.length ?? 0 },
	});

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
