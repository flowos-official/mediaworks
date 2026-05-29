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
import { loadSeedContexts } from "@/lib/strategy/seed-context";
import { invalidateStrategyList } from "@/lib/analytics/cached";
import { persistStrategyFreshSearch } from "@/lib/strategy/fresh-search-persist";
import { runPreliminaryDiscovery } from "@/lib/strategy/preliminary-discovery";
import { runFastPreviewSearch, derivePreviewKeyword, mergePreviewByKeyword } from "@/lib/strategy/fast-preview-search";
import { analyzeGoalToIntent, projectParsedGoalToIntent } from "@/lib/strategy/intent-projection";

export interface MDWorkflowInput {
	userGoal?: string;
	category?: string;
	targetMarket?: string;
	priceRange?: string;
	seedProductId?: string;          // 후방 호환 — 단일 시드
	seedProductIds?: string[];       // 신규 — 다중 시드
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

	// Backward compat: 단일 seedProductId 가 들어오면 배열로 정규화.
	const allSeedIds = [
		...(input.seedProductId ? [input.seedProductId] : []),
		...(input.seedProductIds ?? []),
	];
	if (allSeedIds.length > 0) {
		const seeds = await loadSeedContexts(allSeedIds);
		if (seeds.length > 0) {
			// 단일 시드면 기존 필드 유지 (다른 코드가 의존), 다중이면 신규 필드도 채움.
			if (seeds.length === 1) {
				ctx.seedProduct = seeds[0];
			}
			ctx.seedProducts = seeds;
		}
	}
	console.log(`[md-workflow] context fetched (discovery deferred to final step), seeds=${allSeedIds.length}`);
	return ctx;
}

// Final step: use all accumulated skill outputs as analysis context for the discovery
// curation prompt so the new-product recommendations reflect the full strategy.
async function runDiscoveryStep(
	input: MDWorkflowInput,
	context: StrategyContext,
	outputs: Record<string, unknown>,
	parsedGoal: ParsedGoal | null,
): Promise<DiscoveredProduct[] | undefined> {
	"use step";
	console.log(
		`[md-workflow] running final discovery with full analysis context | parsedGoal=${parsedGoal ? "yes" : "no"}`,
	);
	const summary = buildMDAnalysisSummary(outputs);
	try {
		// Fetch authoritative data from Supabase (same pattern as LC workflow)
		const supabase = getServiceClient();
		const [prodResult, catResult] = await Promise.all([
			supabase.from("product_summaries").select("*").in("year", [2025, 2026]).order("total_revenue", { ascending: false }).limit(60),
			supabase.from("category_summaries").select("*").in("year", [2025, 2026]),
		]);
		const tvProfile = buildTVShoppingProfile(prodResult.data ?? [], catResult.data ?? []);

		// Project parsedGoal into the DiscoverIntent shape consumed by discovery.
		// Done here (not inside discoverNewProducts) to keep the discovery API
		// pipeline-agnostic — LC workflow does the same projection from its
		// own ParsedGoal shape. Routes through the projector so the Phase 0.5
		// SearchIntent fields propagate correctly when the flag is on.
		const intent = parsedGoal ? projectParsedGoalToIntent(parsedGoal) : undefined;

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
			seedProductIds: (context.seedProducts ?? []).map((s) => s.id),
			seedCategories: (context.seedProducts ?? [])
				.map((s) => s.category)
				.filter((c): c is string => !!c),
			intent,
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
// Step: Phase 0.5 pre-run goal_analysis. Runs once before preliminary
// discovery so the intent flows into the pool query, AND the in-loop
// runMDSkill('goal_analysis') short-circuits to the cached value (no
// double Gemini call, no classification drift between runs).
// Failure is non-fatal — pipeline continues without intent.
// ---------------------------------------------------------------------------
async function preRunGoalAnalysisStep(userGoal: string): Promise<ParsedGoal | null> {
	"use step";
	try {
		const { parsedGoal } = await analyzeGoalToIntent(userGoal);
		return parsedGoal;
	} catch (err) {
		console.warn(
			`[md-workflow] pre-run goal_analysis failed, continuing without intent: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}
preRunGoalAnalysisStep.maxRetries = 0;

// ---------------------------------------------------------------------------
// Step: preliminary discovery — pool-only, runs right after fetchContext so
// the user sees candidate cards within ~1-2s instead of waiting for all
// skills + final curated discovery. Final discovery still runs at the end
// and replaces these items with strategy-aligned curation.
// ---------------------------------------------------------------------------
async function runPreliminaryDiscoveryStep(
	input: MDWorkflowInput,
	context: StrategyContext,
	parsedGoal: ParsedGoal | null,
): Promise<DiscoveredProduct[]> {
	"use step";
	try {
		const seedIds = (context.seedProducts ?? []).map((s) => s.id);
		const seedCategories = (context.seedProducts ?? [])
			.map((s) => s.category)
			.filter((c): c is string => !!c);
		const intent = parsedGoal ? projectParsedGoalToIntent(parsedGoal) : undefined;
		const products = await runPreliminaryDiscovery({
			context: "home_shopping",
			uiCategory: input.category,
			priceRange: input.priceRange,
			excludeProductIds: seedIds.length > 0 ? seedIds : undefined,
			supplementCategoriesFromSeeds: seedCategories.length > 0 ? seedCategories : undefined,
			intent,
		});
		console.log(`[md-workflow] preliminary discovery: ${products.length} products`);
		return products;
	} catch (err) {
		console.warn(
			`[md-workflow] preliminary discovery failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
		);
		return [];
	}
}
runPreliminaryDiscoveryStep.maxRetries = 0;

// ---------------------------------------------------------------------------
// Step: fast preview search — ONE Rakuten keyword search so the hero shows the
// actually-searched product (~1s) instead of the generic pool top. Runs right
// after the pool preview; emits a second preliminary_discovery event the client
// replaces the preview with. Display-only (not persisted). Independent of the
// Phase 0.5 flag (keyword falls back to category_hints[0]).
// ---------------------------------------------------------------------------
async function runFastPreviewSearchStep(
	input: MDWorkflowInput,
	preliminary: DiscoveredProduct[],
	parsedGoal: ParsedGoal | null,
): Promise<DiscoveredProduct[]> {
	"use step";
	try {
		const intent = parsedGoal ? projectParsedGoalToIntent(parsedGoal) : undefined;
		const fresh = await runFastPreviewSearch({ intent, priceRange: input.priceRange });
		if (fresh.length === 0) return [];
		const merged = mergePreviewByKeyword(preliminary, fresh, derivePreviewKeyword(intent));
		console.log(`[md-workflow] fast preview: ${merged.length} products (fresh=${fresh.length})`);
		return merged;
	} catch (err) {
		console.warn(
			`[md-workflow] fast preview failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
		);
		return [];
	}
}
runFastPreviewSearchStep.maxRetries = 0;

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
				goal_analysis: (outputs.goal_analysis ?? context.parsedGoal ?? null) as Record<string, unknown> | null,
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
		const id = data?.id ?? null;
		if (id) invalidateStrategyList("md-strategy-workflow-save");
		return id;
	} catch (err) {
		console.error("[md-workflow] save error:", err);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Step: persist fresh_search / research recs into discovered_products and
// back-fill discovered_product_id onto the items so the saved JSONB carries them.
// ---------------------------------------------------------------------------
async function persistFreshSearchStep(
	discovered: DiscoveredProduct[],
	strategyRunId: string,
): Promise<DiscoveredProduct[]> {
	"use step";
	try {
		const { idByUrl } = await persistStrategyFreshSearch(
			discovered.map((p) => ({
				name: p.name,
				source: p.source,
				source_url: p.source_url,
				estimated_price_jpy: p.estimated_price_jpy,
				tv_channel_source: p.tv_channel_source ?? null,
				pool_source: p.pool_source,
				discovered_product_id: p.discovered_product_id,
			})),
			{ strategyId: strategyRunId, context: "home_shopping" },
		);
		const enriched = discovered.map((p) => {
			if (!p.discovered_product_id) {
				const mapped = idByUrl.get(p.source_url);
				if (mapped) return { ...p, discovered_product_id: mapped };
			}
			return p;
		});
		console.log(`[md-workflow] fresh-search persistence complete — enriched ${idByUrl.size} URLs`);
		return enriched;
	} catch (err) {
		console.warn("[md-workflow] fresh-search persistence failed (non-fatal):", err);
		return discovered;
	}
}
persistFreshSearchStep.maxRetries = 0;

// ---------------------------------------------------------------------------
// Workflow entrypoint
// ---------------------------------------------------------------------------
export async function mdStrategyWorkflow(input: MDWorkflowInput) {
	"use workflow";

	await emitProgressStep({ skill: "data_fetch", status: "running", index: -1, total: 7 });
	const context = await fetchContextStep(input);
	await emitProgressStep({ skill: "data_fetch", status: "complete", index: -1, total: 7 });

	// Phase 0.5: pre-run goal_analysis so preliminary discovery has intent
	// and the skill-loop runMDSkill('goal_analysis') short-circuits to the
	// cached ParsedGoal (no double Gemini call, no classification drift).
	let preRunParsedGoal: ParsedGoal | null = null;
	if (input.userGoal) {
		preRunParsedGoal = await preRunGoalAnalysisStep(input.userGoal);
		if (preRunParsedGoal) {
			context.parsedGoal = preRunParsedGoal;
		}
	}

	// Fast pool-only discovery so the hero gets real cards immediately while
	// skills (and the final curated discovery) keep running in the background.
	await emitProgressStep({ skill: "preliminary_discovery", status: "running", index: -1, total: 7 });
	const preliminary = await runPreliminaryDiscoveryStep(input, context, preRunParsedGoal);
	await emitProgressStep({
		skill: "preliminary_discovery",
		status: "complete",
		index: -1,
		total: 7,
		data: { products: preliminary },
	});

	// Replace the pool preview with a fast keyword search (~1s) so the hero
	// shows the actually-searched product. Non-fatal; pool preview stands on miss.
	const fastPreview = await runFastPreviewSearchStep(input, preliminary, preRunParsedGoal);
	if (fastPreview.length > 0) {
		await emitProgressStep({
			skill: "preliminary_discovery",
			status: "complete",
			index: -1,
			total: 7,
			data: { products: fastPreview },
		});
	}

	const outputs: Record<string, unknown> = {};
	// Seed parsedGoal with the pre-run value so the skill loop's goal_analysis
	// step short-circuits via context.parsedGoal (Phase 0.5).
	let parsedGoal: ParsedGoal | null = preRunParsedGoal;
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
	const discovered = await runDiscoveryStep(input, context, outputs, parsedGoal);
	const psExisting = outputs.product_selection as ProductSelectionOutput | undefined;
	const psSucceeded = !!psExisting && Object.keys(psExisting).length > 0;

	// Persist fresh_search / research items into discovered_products before saving
	// the strategy so the JSONB carries discovered_product_id for each rec.
	// strategyRunId is a per-invocation UUID used only as a seed_keyword label.
	const strategyRunId = crypto.randomUUID();
	const enrichedDiscovered =
		discovered && discovered.length > 0
			? await persistFreshSearchStep(discovered, strategyRunId)
			: discovered;

	if (enrichedDiscovered && enrichedDiscovered.length > 0 && psSucceeded) {
		// Inject into product_selection output so the frontend hero renders from the
		// existing field path (no DB schema change).
		const ps = (outputs.product_selection as ProductSelectionOutput | undefined) ?? {} as ProductSelectionOutput;
		ps.discovered_new_products = enrichedDiscovered;
		ps.discovery_history = [{ generatedAt: new Date().toISOString(), products: enrichedDiscovered }];
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
		data: { count: enrichedDiscovered?.length ?? 0 },
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
