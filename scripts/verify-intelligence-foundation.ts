import type { SupabaseClient } from "@supabase/supabase-js";

import { isConnectedProductSource } from "../lib/intelligence/backfill";
import { loadIntelligenceReadiness, percent } from "../lib/intelligence/readiness";
import { getServiceClient } from "../lib/supabase";

const REQUIRED_TABLES = [
	"canonical_products",
	"product_source_links",
	"evidence_items",
	"insight_snapshots",
	"insight_snapshot_evidence",
	"knowledge_snapshots",
	"knowledge_snapshot_items",
	"data_pipeline_runs",
	"import_batches",
	"import_rows",
] as const;

const PAGE_SIZE = 500;

interface CheckResult {
	name: string;
	passed: boolean;
	detail: string;
}

interface InsightRow {
	id: string;
	evidence_count: number;
}

interface InsightLinkRow {
	insight_snapshot_id: string;
}

interface LegacyCategoryCoverage {
	rawActiveProducts: number;
	activeProducts: number;
	categorizedActive: number;
	categoryPct: number | null;
}

export interface LegacyDiscoveryEligibilityInput {
	source: string | null;
	userAction: string | null;
	tvChannelSource: string | null;
}

export function isLegacyFoundationEligible(input: LegacyDiscoveryEligibilityInput): boolean {
	return input.source === "tv_channel"
		&& (input.userAction === null || input.userAction === "sourced" || input.userAction === "interested")
		&& isConnectedProductSource(input.tvChannelSource);
}

/** Gate on raw counts; percentages are rounded only when rendered. */
export function passesRecentCategoryCoverage(categorized: number, eligible: number): boolean {
	return Number.isInteger(categorized)
		&& Number.isInteger(eligible)
		&& eligible > 0
		&& categorized >= 0
		&& categorized <= eligible
		&& categorized * 100 >= eligible * 95;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function exactCount(
	sb: SupabaseClient,
	table: string,
	configure: (query: any) => any = (query) => query,
): Promise<number> {
	const { count, error } = await configure(
		(sb as any).from(table).select("id", { count: "exact", head: true }),
	);
	if (error) throw new Error(`${table} count failed: ${error.message}`);
	return count ?? 0;
}

async function readAll<T>(
	label: string,
	createQuery: () => any,
): Promise<T[]> {
	const rows: T[] = [];
	for (let from = 0; ; from += PAGE_SIZE) {
		const { data, error } = await createQuery().range(from, from + PAGE_SIZE - 1);
		if (error) throw new Error(`${label} failed: ${error.message}`);
		const page = (data ?? []) as T[];
		rows.push(...page);
		if (page.length < PAGE_SIZE) return rows;
	}
}

function chunks<T>(values: T[], size = 200): T[][] {
	const result: T[][] = [];
	for (let offset = 0; offset < values.length; offset += size) {
		result.push(values.slice(offset, offset + size));
	}
	return result;
}

async function loadLegacyRecentCategoryCoverage(sb: SupabaseClient): Promise<LegacyCategoryCoverage> {
	const runResults = await Promise.all(["home_shopping", "live_commerce"].map((context) => (sb as any)
		.from("discovery_runs")
		.select("id")
		.eq("context", context)
		.eq("status", "completed")
		.order("run_at", { ascending: false })
		.limit(1)
		.maybeSingle()));
	for (const result of runResults) {
		if (result.error) throw new Error(`latest legacy Discovery run query failed: ${result.error.message}`);
	}
	const runIds = runResults
		.map((result) => result.data?.id)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
	if (runIds.length === 0) return { rawActiveProducts: 0, activeProducts: 0, categorizedActive: 0, categoryPct: null };

	const rawProducts = await readAll<{
		id: string;
		source: string | null;
		user_action: string | null;
		tv_channel_source: string | null;
	}>("latest legacy Discovery products", () => (sb as any)
		.from("discovered_products")
		.select("id,source,user_action,tv_channel_source")
		.in("session_id", runIds)
		.or("user_action.is.null,user_action.in.(sourced,interested)")
		.order("id", { ascending: true }));
	const products = rawProducts.filter((product) => isLegacyFoundationEligible({
		source: product.source,
		userAction: product.user_action,
		tvChannelSource: product.tv_channel_source,
	}));
	const productIds = [...new Set(products.map((product) => product.id))];
	const links: Array<{ source_record_id: string; canonical_product_id: string }> = [];
	for (const ids of chunks(productIds)) {
		links.push(...await readAll<{ source_record_id: string; canonical_product_id: string }>("latest legacy Discovery canonical links", () => (sb as any)
			.from("product_source_links")
			.select("source_record_id,canonical_product_id")
			.eq("source_type", "discovery")
			.eq("source_table", "discovered_products")
			.in("source_record_id", ids)
			.order("id", { ascending: true })));
	}
	const linkByProductId = new Map(links.map((link) => [link.source_record_id, link.canonical_product_id]));
	const canonicalIds = [...new Set(links.map((link) => link.canonical_product_id))];
	const canonicals: Array<{ id: string; normalized_category: string | null }> = [];
	for (const ids of chunks(canonicalIds)) {
		canonicals.push(...await readAll<{ id: string; normalized_category: string | null }>("latest legacy Discovery active canonicals", () => (sb as any)
			.from("canonical_products")
			.select("id,normalized_category")
			.eq("status", "active")
			.in("id", ids)
			.order("id", { ascending: true })));
	}
	const canonicalById = new Map(canonicals.map((canonical) => [canonical.id, canonical]));
	const categorizedActive = productIds.filter((productId) => {
		const canonicalId = linkByProductId.get(productId);
		return Boolean(canonicalId && canonicalById.get(canonicalId)?.normalized_category?.trim());
	}).length;
	return {
		rawActiveProducts: rawProducts.length,
		activeProducts: productIds.length,
		categorizedActive,
		categoryPct: percent(categorizedActive, productIds.length),
	};
}

async function tableAvailability(sb: SupabaseClient): Promise<Map<string, string | null>> {
	const results = await Promise.all(REQUIRED_TABLES.map(async (table) => {
		try {
			// PostgREST can return a bare 204 for a HEAD request even when its
			// schema cache does not know the table. A one-row GET surfaces PGRST205.
			const { error } = await (sb as any).from(table).select("*").limit(1);
			if (error) throw new Error(`${table} availability failed: ${error.message}`);
			return [table, null] as const;
		} catch (error) {
			return [table, errorMessage(error)] as const;
		}
	}));
	return new Map(results);
}

async function verifyInsightLinks(sb: SupabaseClient): Promise<{
	insightCount: number;
	mismatches: Array<{ id: string; expected: number; observed: number }>;
}> {
	const [insights, links] = await Promise.all([
		readAll<InsightRow>("insight snapshot scan", () => (sb as any)
			.from("insight_snapshots")
			.select("id,evidence_count")
			.order("id", { ascending: true })),
		readAll<InsightLinkRow>("insight evidence-link scan", () => (sb as any)
			.from("insight_snapshot_evidence")
			.select("insight_snapshot_id")
			.order("insight_snapshot_id", { ascending: true })),
	]);
	const linkedBySnapshot = new Map<string, number>();
	for (const link of links) {
		linkedBySnapshot.set(link.insight_snapshot_id, (linkedBySnapshot.get(link.insight_snapshot_id) ?? 0) + 1);
	}
	return {
		insightCount: insights.length,
		mismatches: insights
			.filter((insight) => insight.evidence_count !== (linkedBySnapshot.get(insight.id) ?? 0))
			.map((insight) => ({
				id: insight.id,
				expected: insight.evidence_count,
				observed: linkedBySnapshot.get(insight.id) ?? 0,
			})),
	};
}

async function runVerification(sb: SupabaseClient): Promise<CheckResult[]> {
	const availability = await tableAvailability(sb);
	const missingTables = [...availability.entries()]
		.filter(([, error]) => error !== null)
		.map(([table]) => table);
	const checks: CheckResult[] = [{
		name: "additive intelligence migrations",
		passed: missingTables.length === 0,
		detail: missingTables.length === 0
			? `all ${REQUIRED_TABLES.length} required tables are queryable`
			: `missing or inaccessible tables: ${missingTables.join(", ")}`,
	}];

	if (missingTables.length > 0) {
		checks.push(
			{ name: "latest source attempt", passed: false, detail: "unavailable until data_pipeline_runs exists" },
			{ name: "canonical links", passed: false, detail: "count unavailable until product_source_links exists" },
			{ name: "recent-active category coverage", passed: false, detail: "coverage unavailable until intelligence tables exist" },
			{ name: "evidence items", passed: false, detail: "count unavailable until evidence_items exists" },
			{ name: "insight evidence links", passed: false, detail: "unavailable until insight tables exist" },
			{ name: "known evidence value integrity", passed: false, detail: "unavailable until evidence_items exists" },
			{ name: "non-known evidence value integrity", passed: false, detail: "unavailable until evidence_items exists" },
		);
		return checks;
	}

	const [
		latestAttemptResult,
		canonicalLinkCount,
		evidenceCount,
		knownNullCount,
		nonKnownValueCount,
		insightLinks,
		readiness,
		legacyCategoryCoverage,
	] = await Promise.all([
		(sb as any)
			.from("data_pipeline_runs")
			.select("source_type,job_type,status,started_at")
			.order("started_at", { ascending: false })
			.limit(1)
			.maybeSingle(),
		exactCount(sb, "product_source_links"),
		exactCount(sb, "evidence_items"),
		exactCount(sb, "evidence_items", (query) => query.eq("value_state", "known").is("value_json", null)),
		exactCount(sb, "evidence_items", (query) => query.neq("value_state", "known").not("value_json", "is", null)),
		verifyInsightLinks(sb),
		loadIntelligenceReadiness(sb, new Date()),
		loadLegacyRecentCategoryCoverage(sb),
	]);
	if (latestAttemptResult.error) {
		throw new Error(`latest source attempt query failed: ${latestAttemptResult.error.message}`);
	}
	const latestAttempt = latestAttemptResult.data as {
		source_type: string;
		job_type: string;
		status: string;
		started_at: string;
	} | null;
	const categoryCoverage = legacyCategoryCoverage;
	const categoryPct = categoryCoverage.categoryPct;
	const analysisPct = readiness.coverage.analysisPct;

	checks.push(
		{
			name: "latest source attempt",
			passed: latestAttempt !== null,
			detail: latestAttempt
				? `${latestAttempt.source_type}/${latestAttempt.job_type} ${latestAttempt.status} at ${latestAttempt.started_at}`
				: "no data_pipeline_runs attempt is visible",
		},
		{
			name: "canonical links",
			passed: canonicalLinkCount > 0,
			detail: `product_source_links=${canonicalLinkCount}`,
		},
		{
			name: "recent-active category coverage",
			passed: passesRecentCategoryCoverage(categoryCoverage.categorizedActive, categoryCoverage.activeProducts),
			detail: `source=latest successful legacy Discovery sessions, rawActive=${categoryCoverage.rawActiveProducts}, eligible=${categoryCoverage.activeProducts}, categorized=${categoryCoverage.categorizedActive}/${categoryCoverage.activeProducts}, categoryPct=${categoryPct ?? "null"}%, analysisPct=${analysisPct ?? "null"}% (${readiness.coverage.analyzedBroadcasts}/${readiness.coverage.archivedBroadcasts})`,
		},
		{
			name: "evidence items",
			passed: evidenceCount > 0,
			detail: `evidence_items=${evidenceCount}`,
		},
		{
			name: "insight evidence links",
			passed: insightLinks.mismatches.length === 0,
			detail: `insight_snapshots=${insightLinks.insightCount}, mismatched_link_counts=${insightLinks.mismatches.length}`,
		},
		{
			name: "known evidence value integrity",
			passed: knownNullCount === 0,
			detail: `known_with_null_value=${knownNullCount}`,
		},
		{
			name: "non-known evidence value integrity",
			passed: nonKnownValueCount === 0,
			detail: `non_known_with_value=${nonKnownValueCount}`,
		},
	);
	return checks;
}

async function main(): Promise<void> {
	const checks = await runVerification(getServiceClient());
	for (const check of checks) {
		console.log(`${check.passed ? "PASS" : "FAIL"}: ${check.name} — ${check.detail}`);
	}
	const failures = checks.filter((check) => !check.passed);
	console.log(`Foundation verification: ${checks.length - failures.length}/${checks.length} checks passed.`);
	if (failures.length > 0) process.exitCode = 1;
}

if (require.main === module) {
	main().catch((error) => {
		console.error(`FAIL: foundation verifier execution — ${errorMessage(error)}`);
		process.exitCode = 1;
	});
}
