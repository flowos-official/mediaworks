import {
	buildRecommendationFlowChecks,
	hasStrictFailures,
	summarizeStrictFailures,
	type RecommendationFlowCheck,
	type RecommendationFlowEvidence,
} from "@/lib/recommendation/flow-readiness";
import {
	hasIntegratedStrategyEvidence,
	summarizeMdStrategyEvidence,
} from "@/lib/recommendation/strategy-evidence";

type QueryResult<T> = {
	data: T | null;
	error: { message: string } | null;
	count?: number | null;
};

type QueryExecutable = PromiseLike<QueryResult<unknown>> & {
	eq(column: string, value: unknown): QueryExecutable;
	in(column: string, values: unknown[]): QueryExecutable;
	not(column: string, operator: string, value: unknown): QueryExecutable;
	order(column: string, options?: { ascending?: boolean }): QueryExecutable;
	limit(count: number): QueryExecutable;
	maybeSingle(): Promise<QueryResult<unknown>>;
};

type QueryStart = {
	select(columns: string, options?: { count?: string; head?: boolean }): QueryExecutable;
};

type QueryClient = {
	from(table: string): unknown;
};

export interface RecommendationFlowStatus {
	evidence: RecommendationFlowEvidence;
	checks: RecommendationFlowCheck[];
	strictReady: boolean;
	strictFailures: string;
}

function failQuery(context: string, error: { message: string } | null): void {
	if (error) {
		throw new Error(`${context}: ${error.message}`);
	}
}

function fromTable(sb: QueryClient, table: string): QueryStart {
	return sb.from(table) as QueryStart;
}

function pct(numerator: number, denominator: number): number {
	if (denominator <= 0) return 0;
	return Math.round((numerator / denominator) * 1000) / 10;
}

async function countRows(
	sb: QueryClient,
	table: string,
	nonNullColumn?: string,
): Promise<number> {
	let query = fromTable(sb, table).select("*", { count: "exact", head: true });
	if (nonNullColumn) {
		query = query.not(nonNullColumn, "is", null);
	}
	const { count, error } = (await query) as QueryResult<null>;
	failQuery(`${table} count failed`, error);
	return count ?? 0;
}

async function loadDistinctStrings(
	sb: QueryClient,
	table: string,
	column: string,
): Promise<string[]> {
	const { data, error } = (await fromTable(sb, table)
		.select(column)
		.not(column, "is", null)
		.limit(10_000)) as QueryResult<Array<Record<string, unknown>>>;
	failQuery(`${table}.${column} distinct load failed`, error);
	const out = new Set<string>();
	for (const row of data ?? []) {
		const value = row[column];
		if (typeof value === "string" && value.trim()) {
			out.add(value.trim());
		}
	}
	return [...out];
}

async function loadNormalizationHitsForRawCategories(
	sb: QueryClient,
	rawCategories: string[],
): Promise<Set<string>> {
	const out = new Set<string>();
	const chunkSize = 50;
	for (let i = 0; i < rawCategories.length; i += chunkSize) {
		const chunk = rawCategories.slice(i, i + chunkSize);
		if (chunk.length === 0) continue;
		const { data, error } = (await fromTable(sb, "discovered_category_normalization")
			.select("raw_category")
			.in("raw_category", chunk)) as QueryResult<Array<{ raw_category: unknown }>>;
		failQuery("discovered_category_normalization discovery hit lookup failed", error);
		for (const row of data ?? []) {
			if (typeof row.raw_category === "string" && row.raw_category.trim()) {
				out.add(row.raw_category.trim());
			}
		}
	}
	return out;
}

async function loadRecommendationDataCoverage(
	sb: QueryClient,
): Promise<RecommendationFlowEvidence["dataCoverage"]> {
	const [
		discoveredRawCategories,
		normalizedRawCategoryCount,
		broadcastsTotal,
		broadcastsWithCategory,
		historicalTotal,
		historicalWithCategory,
		operatorFitTotal,
		operatorFitWithCategory,
	] = await Promise.all([
		loadDistinctStrings(sb, "discovered_products", "category"),
		countRows(sb, "discovered_category_normalization"),
		countRows(sb, "broadcasts"),
		countRows(sb, "broadcasts", "category"),
		countRows(sb, "historical_broadcasts"),
		countRows(sb, "historical_broadcasts", "category"),
		countRows(sb, "competitor_fit_analyses"),
		countRows(sb, "competitor_fit_analyses", "category"),
	]);

	const normalizedSet = await loadNormalizationHitsForRawCategories(
		sb,
		discoveredRawCategories,
	);
	const missingRawCategoryCount = discoveredRawCategories.filter(
		(category) => !normalizedSet.has(category),
	).length;
	const coveredRawCategoryCount =
		discoveredRawCategories.length - missingRawCategoryCount;
	const totalBroadcastRows = broadcastsTotal + historicalTotal;
	const totalCategorizedBroadcastRows =
		broadcastsWithCategory + historicalWithCategory;

	return {
		categoryNormalization: {
			discoveredRawCategoryCount: discoveredRawCategories.length,
			coveredRawCategoryCount,
			normalizedRawCategoryCount,
			missingRawCategoryCount,
			cacheCoveragePct: pct(coveredRawCategoryCount, discoveredRawCategories.length),
		},
		broadcastCategories: {
			broadcastsTotal,
			broadcastsWithCategory,
			historicalTotal,
			historicalWithCategory,
			overallCoveragePct: pct(totalCategorizedBroadcastRows, totalBroadcastRows),
		},
		operatorFitCategories: {
			total: operatorFitTotal,
			withCategory: operatorFitWithCategory,
			coveragePct: pct(operatorFitWithCategory, operatorFitTotal),
		},
	};
}

async function latestContextDiscoveryRun(
	sb: QueryClient,
	context: "home_shopping" | "live_commerce",
): Promise<RecommendationFlowEvidence["contextDiscoveryRuns"][number]> {
	const { data: run, error: runError } = (await fromTable(sb, "discovery_runs")
		.select("id, context, status, run_at")
		.eq("context", context)
		.order("run_at", { ascending: false })
		.limit(1)
		.maybeSingle()) as QueryResult<{ id: string; status: string | null }>;
	failQuery(`${context} discovery_runs query failed`, runError);

	let productCount = 0;
	if (run) {
		const { count, error: countError } = (await fromTable(sb, "discovered_products")
			.select("id", { count: "exact", head: true })
			.eq("session_id", run.id)) as QueryResult<null>;
		failQuery(`${context} discovered_products count failed`, countError);
		productCount = count ?? 0;
	}

	return {
		context,
		status: run?.status ?? null,
		productCount,
	};
}

export async function loadRecommendationFlowEvidence(
	sb: QueryClient,
): Promise<RecommendationFlowEvidence> {
	const { data: latestRun, error: runError } = (await fromTable(sb, "discovery_runs")
		.select("id, context, status, run_at")
		.order("run_at", { ascending: false })
		.limit(1)
		.maybeSingle()) as QueryResult<{ id: string; context: string | null; status: string | null }>;
	failQuery("discovery_runs query failed", runError);
	if (!latestRun) {
		throw new Error("no discovery_runs rows found");
	}

	const { data: discovered, error: discoveredError } = (await fromTable(sb, "discovered_products")
		.select("id, name, category, enrichment_status, c_package")
		.eq("session_id", latestRun.id)
		.limit(5)) as QueryResult<Array<{ id: string }>>;
	failQuery("discovered_products query failed", discoveredError);

	const contextDiscoveryRuns = await Promise.all([
		latestContextDiscoveryRun(sb, "home_shopping"),
		latestContextDiscoveryRun(sb, "live_commerce"),
	]);

	const { data: promoted, error: promotedError } = (await fromTable(sb, "products")
		.select("id, name, discovered_product_id, status")
		.not("discovered_product_id", "is", null)
		.order("created_at", { ascending: false })
		.limit(1)
		.maybeSingle()) as QueryResult<RecommendationFlowEvidence["promotedProduct"]>;
	failQuery("promoted products query failed", promotedError);

	const { data: promotable, error: promotableError } = (await fromTable(sb, "discovered_products")
		.select("id, name")
		.eq("enrichment_status", "completed")
		.order("created_at", { ascending: false })
		.limit(1)
		.maybeSingle()) as QueryResult<RecommendationFlowEvidence["promotableCandidate"]>;
	failQuery("promotable discovery query failed", promotableError);

	const promotedResearchQuery = promoted
		? ((await fromTable(sb, "research_results")
				.select("product_id")
				.eq("product_id", promoted.id)
				.maybeSingle()) as QueryResult<RecommendationFlowEvidence["promotedResearchResult"]>)
		: { data: null, error: null };
	failQuery("promoted research_results query failed", promotedResearchQuery.error);

	const { data: strategies, error: strategyError } = (await fromTable(sb, "md_strategies")
		.select("id, user_goal, product_selection, created_at")
		.order("created_at", { ascending: false })
		.limit(25)) as QueryResult<
		Array<{ id: string; user_goal: string | null; product_selection: unknown }>
	>;
	failQuery("md_strategies query failed", strategyError);
	const strategySummaries = (strategies ?? []).map((strategy) =>
		summarizeMdStrategyEvidence({
			id: strategy.id,
			user_goal: strategy.user_goal,
			product_selection: strategy.product_selection,
		}),
	);
	const integratedMdStrategy = strategySummaries.find(hasIntegratedStrategyEvidence) ?? null;

	const { data: linkedScreenplay, error: screenplayError } = (await fromTable(sb, "screenplays")
		.select("id, product_id, status")
		.not("product_id", "is", null)
		.order("created_at", { ascending: false })
		.limit(1)
		.maybeSingle()) as QueryResult<RecommendationFlowEvidence["latestLinkedScreenplay"]>;
	failQuery("screenplays query failed", screenplayError);

	const promotedLinkedScreenplayQuery = promoted
		? ((await fromTable(sb, "screenplays")
				.select("id, product_id, status")
				.eq("product_id", promoted.id)
				.order("created_at", { ascending: false })
				.limit(1)
				.maybeSingle()) as QueryResult<RecommendationFlowEvidence["promotedLinkedScreenplay"]>)
		: { data: null, error: null };
	failQuery(
		"promoted screenplay query failed",
		promotedLinkedScreenplayQuery.error,
	);

	const dataCoverage = await loadRecommendationDataCoverage(sb);

	return {
		latestDiscoveryRun: latestRun,
		latestDiscoveryProductCount: discovered?.length ?? 0,
		contextDiscoveryRuns,
		promotableCandidate: promotable,
		promotedProduct: promoted,
		promotedResearchResult: promotedResearchQuery.data,
		latestMdStrategy: strategies?.[0]
			? { id: strategies[0].id, user_goal: strategies[0].user_goal }
			: null,
		integratedMdStrategy,
		latestLinkedScreenplay: linkedScreenplay,
		promotedLinkedScreenplay: promotedLinkedScreenplayQuery.data,
		dataCoverage,
	};
}

export async function loadRecommendationFlowStatus(
	sb: QueryClient,
): Promise<RecommendationFlowStatus> {
	const evidence = await loadRecommendationFlowEvidence(sb);
	const checks = buildRecommendationFlowChecks(evidence);
	const strictReady = !hasStrictFailures(checks);

	return {
		evidence,
		checks,
		strictReady,
		strictFailures: strictReady ? "" : summarizeStrictFailures(checks),
	};
}
