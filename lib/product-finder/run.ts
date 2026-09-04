/**
 * Orchestrate one stored-only recommendation run.
 *
 * The run row is the unit of accountability, and the order of writes is what
 * makes it honest: the run is created `running`, items and the knowledge
 * snapshot are written, and only then is it marked `completed`. The CHECK on
 * product_recommendation_runs refuses a completed run without a snapshot, so
 * any failure along the way leaves a row that cannot be mistaken for an answer.
 *
 * Prose is deterministic. `reasons`, `risks` and `missingData` are templates
 * over the axes, not model output: a sentence generated about a ranking is a
 * second, unverifiable account of it, and the surface's whole claim is that
 * what it shows is what it read.
 *
 * Every database touch goes through ProductFinderRepository — the same shape
 * lib/broadcast-intel/queue.ts uses — so orchestration is testable without a
 * database, and the no-network guarantee is a property of a small file rather
 * than of a mock.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createKnowledgeSnapshot } from "@/lib/intelligence/repository";
import type { KnowledgeSnapshotDraft } from "@/lib/intelligence/types";
import { loadStoredCandidates, type StoredCandidate } from "./candidates";
import { ALGORITHM_VERSION, rankStoredCandidates, type RankedCandidate } from "./ranking";
import type { ProductFinderItem, ProductFinderQuery, ProductFinderResult, ScoreAxis } from "./types";

export interface ProductFinderItemInsert {
	canonical_product_id: string;
	rank: number;
	opportunity_index: number;
	expected_contribution_profit_jpy: number | null;
	axes: ScoreAxis[];
	confidence: RankedCandidate["confidence"];
	reasons: string[];
	risks: string[];
	missing_data: string[];
}

export interface ProductFinderRepository {
	createRun(userId: string, query: ProductFinderQuery, algorithmVersion: string): Promise<string>;
	insertItems(runId: string, items: ProductFinderItemInsert[]): Promise<string[]>;
	completeRun(runId: string, snapshotId: string, counts: { candidateCount: number; resultCount: number }): Promise<void>;
	failRun(runId: string, errorCode: string): Promise<void>;
	loadCandidates(query: ProductFinderQuery, dataCutoff: string): Promise<StoredCandidate[]>;
	createSnapshot(draft: KnowledgeSnapshotDraft): Promise<string>;
}

export function createProductFinderRepository(sb: SupabaseClient): ProductFinderRepository {
	return {
		async createRun(userId, query, algorithmVersion) {
			const { data, error } = await sb
				.from("product_recommendation_runs")
				.insert({
					created_by: userId,
					mode: query.mode,
					query_json: query,
					status: "running",
					algorithm_version: algorithmVersion,
				})
				.select("id")
				.single();
			if (error) throw new Error(`product finder run insert failed: ${error.message}`);
			if (!data?.id) throw new Error("product finder run insert returned no id");
			return String(data.id);
		},
		async insertItems(runId, items) {
			if (items.length === 0) return [];
			const { data, error } = await sb
				.from("product_recommendation_items")
				.insert(items.map((item) => ({ run_id: runId, ...item })))
				.select("id");
			if (error) throw new Error(`product finder item insert failed: ${error.message}`);
			return (data ?? []).map((row) => String((row as { id: unknown }).id));
		},
		async completeRun(runId, snapshotId, counts) {
			const { error } = await sb
				.from("product_recommendation_runs")
				.update({
					status: "completed",
					knowledge_snapshot_id: snapshotId,
					completed_at: new Date().toISOString(),
					candidate_count: counts.candidateCount,
					result_count: counts.resultCount,
				})
				.eq("id", runId)
				.eq("status", "running");
			if (error) throw new Error(`product finder run completion failed: ${error.message}`);
		},
		async failRun(runId, errorCode) {
			// Best-effort by design: this runs inside a catch, and letting it
			// throw would replace the real cause with a bookkeeping error.
			const { error } = await sb
				.from("product_recommendation_runs")
				.update({ status: "failed", error_code: errorCode })
				.eq("id", runId)
				.eq("status", "running");
			if (error) console.error(`[product-finder] could not mark run ${runId} failed:`, error.message);
		},
		loadCandidates: (query, dataCutoff) => loadStoredCandidates(sb, query, dataCutoff),
		createSnapshot: (draft) => createKnowledgeSnapshot(sb, draft),
	};
}

const AXIS_REASON: Record<ScoreAxis["key"], string> = {
	market_demand: "他局での放送実績とレビュー数が同カテゴリ内で上位",
	company_fit: "指定された価格帯・自社条件に適合",
	profitability: "自社の内部原価データから貢献利益を算出",
	competition_headroom: "競合の放送回数が少なく参入余地がある",
	broadcast_fit: "分析済み放送データが十分にあり構成を再現しやすい",
};

const AXIS_RISK: Record<ScoreAxis["key"], string> = {
	market_demand: "需要の裏づけが放送回数・レビュー数の代理指標のみ",
	company_fit: "自社適合の判断材料が価格帯のみ",
	profitability: "収益性を裏づける内部データがない",
	competition_headroom: "競合の放送回数が多く価格競争になりやすい",
	broadcast_fit: "参考にできる分析済み放送が乏しい",
};

const AXIS_LABEL_JA: Record<ScoreAxis["key"], string> = {
	market_demand: "市場需要",
	company_fit: "自社適合",
	profitability: "収益性",
	competition_headroom: "競合余地",
	broadcast_fit: "放送適合",
};

/** Strong enough to be worth naming as a reason. */
const REASON_THRESHOLD = 0.6;

function describe(item: RankedCandidate): Pick<ProductFinderItem, "reasons" | "risks" | "missingData"> {
	const reasons: string[] = [];
	const risks: string[] = [];
	const missingData: string[] = [];

	for (const axis of item.axes) {
		if (axis.status === "unknown") {
			// Named, not omitted. An axis quietly absent from the card reads as
			// "not relevant"; the operator needs to see it was never measured.
			missingData.push(`${AXIS_LABEL_JA[axis.key]}: 裏づけとなるデータがありません`);
			continue;
		}
		if (axis.normalized !== null && axis.normalized >= REASON_THRESHOLD) {
			// A proxy-backed reason says so, so a reader never mistakes an
			// airing count for a measured sale.
			reasons.push(axis.status === "proxy" ? `${AXIS_REASON[axis.key]}（代理指標）` : AXIS_REASON[axis.key]);
		}
		if (axis.normalized !== null && axis.normalized < 0.35) {
			risks.push(AXIS_RISK[axis.key]);
		}
	}

	if (item.expectedContributionProfitJpy === null) {
		risks.push(AXIS_RISK.profitability);
	}
	if (item.confidence.level === "low") {
		risks.push(`根拠となる証拠が少なく、順位の確度が低い（カバー率 ${Math.round(item.confidence.coverage * 100)}%）`);
	}

	return { reasons, risks, missingData: [...new Set(missingData)] };
}

export async function runProductFinderFromStoredEvidence(
	repo: ProductFinderRepository,
	userId: string,
	query: ProductFinderQuery,
	options: { mode: "stored_only" },
): Promise<ProductFinderResult> {
	// One cutoff for the whole run. Taken before any read so the candidate set,
	// the ranking and the snapshot all describe the same instant — a cutoff
	// recomputed per query would let evidence arrive mid-run and make the
	// snapshot a description of something that never existed as a whole.
	const dataCutoff = new Date().toISOString();
	const runId = await repo.createRun(userId, query, ALGORITHM_VERSION);

	try {
		const candidates = await repo.loadCandidates(query, dataCutoff);
		const ranked = rankStoredCandidates(candidates, query).slice(0, query.limit);

		const inserts: ProductFinderItemInsert[] = ranked.map((item) => {
			const prose = describe(item);
			return {
				canonical_product_id: item.canonicalProductId,
				rank: item.rank,
				opportunity_index: item.opportunityIndex,
				expected_contribution_profit_jpy: item.expectedContributionProfitJpy,
				axes: item.axes,
				confidence: item.confidence,
				reasons: prose.reasons,
				risks: prose.risks,
				missing_data: prose.missingData,
			};
		});

		const itemIds = await repo.insertItems(runId, inserts);

		// The snapshot names every piece of evidence behind every SHOWN item —
		// not the whole candidate pool. It answers "what did this result rest
		// on", and evidence read for a candidate that did not make the cut did
		// not support anything the operator saw.
		const snapshotItems: KnowledgeSnapshotDraft["items"] = ranked.flatMap((item, i) =>
			[...new Set(item.evidenceIds)].map((evidenceItemId) => ({
				evidenceItemId,
				usageRole: "ranking_input",
				resultLocator: itemIds[i] ?? `rank:${item.rank}`,
			})),
		);

		const snapshotId = await repo.createSnapshot({
			consumerType: "product_recommendation",
			consumerRunId: runId,
			createdBy: userId,
			mode: options.mode,
			query: { ...query },
			dataCutoff,
			algorithmVersion: ALGORITHM_VERSION,
			items: snapshotItems,
		});

		await repo.completeRun(runId, snapshotId, {
			candidateCount: candidates.length,
			resultCount: ranked.length,
		});

		return {
			runId,
			mode: options.mode,
			generatedAt: dataCutoff,
			query,
			candidateCount: candidates.length,
			items: ranked.map((item, i) => ({
				id: itemIds[i] ?? `rank:${item.rank}`,
				canonicalProductId: item.canonicalProductId,
				rank: item.rank,
				name: item.name,
				category: item.category,
				opportunityIndex: item.opportunityIndex,
				expectedContributionProfitJpy: item.expectedContributionProfitJpy,
				axes: item.axes,
				confidence: item.confidence,
				...describe(item),
			})),
		};
	} catch (error) {
		await repo.failRun(runId, "product_finder_failed");
		throw error;
	}
}

export async function runStoredProductFinder(
	sb: SupabaseClient,
	userId: string,
	query: ProductFinderQuery,
): Promise<ProductFinderResult> {
	return runProductFinderFromStoredEvidence(
		createProductFinderRepository(sb),
		userId,
		query,
		{ mode: "stored_only" },
	);
}
