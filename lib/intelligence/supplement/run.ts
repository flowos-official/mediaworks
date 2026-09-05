/**
 * Go and look, on somebody's explicit instruction, then rank from the database
 * again.
 *
 * The shape is deliberate: research WRITES evidence, and ranking READS it. The
 * re-rank is the same `runProductFinderFromStoredEvidence` the stored-only
 * surface uses, unchanged and still network-free. Nothing here ranks from an
 * in-memory search result, because a recommendation that cannot be reproduced
 * from the ledger is not auditable — and reproducing it is the whole point of
 * the knowledge snapshot.
 *
 * What must survive a failure is the original recommendation. A provider being
 * down is not a reason for an operator to lose the result they were already
 * looking at, so a total failure returns the ORIGINAL run id and creates no new
 * recommendation; a partial failure still produces one, marked `partial`, with
 * whatever was actually found.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildEvidenceDraft } from "@/lib/intelligence/evidence";
import type { EvidenceDraft } from "@/lib/intelligence/types";
import { parseProductFinderQuery } from "@/lib/product-finder/request";
import {
	createProductFinderRepository,
	runProductFinderFromStoredEvidence,
} from "@/lib/product-finder/run";
import { researchGap, type SupplementProduct, type SupplementProviderDeps } from "./providers";
import type { SupplementGap, SupplementObservation } from "./types";

export type SupplementStatus = "completed" | "partial" | "failed";

export interface SupplementResult {
	supplementalRunId: string;
	status: SupplementStatus;
	/** The run the operator should look at now. On total failure this is the
	 *  ORIGINAL run — the result they already had is still the best one. */
	recommendationRunId: string;
	evidenceCount: number;
	failedGaps: SupplementGap[];
}

export interface SupplementRepository {
	/** The owned run, its query, and the snapshot it rested on. Ownership is
	 *  checked in the query rather than after the read. */
	loadOwnedRun(runId: string, userId: string): Promise<{
		id: string;
		query: unknown;
		knowledgeSnapshotId: string | null;
	} | null>;
	canonicalProductInRun(runId: string, canonicalProductId: string): Promise<{ id: string; name: string; category: string | null } | null>;
	createSupplementalRun(input: {
		recommendationRunId: string;
		canonicalProductId: string;
		userId: string;
		gaps: SupplementGap[];
		priorKnowledgeSnapshotId: string;
	}): Promise<string>;
	completeSupplementalRun(id: string, patch: {
		status: SupplementStatus;
		evidenceCount: number;
		resultRecommendationRunId?: string;
		resultKnowledgeSnapshotId?: string;
		errorCode?: string;
		errorSummary?: string;
	}): Promise<void>;
	upsertEvidence(drafts: EvidenceDraft[]): Promise<string[]>;
	rerank(userId: string, query: unknown): Promise<{ runId: string; knowledgeSnapshotId: string | null }>;
}

/**
 * An observation becomes an evidence draft without changing class, and the
 * source URL is part of its identity. Two shops quoting different prices for
 * the same product are two facts, not a conflict to be resolved by whichever
 * was written last.
 */
export function observationToDraft(
	canonicalProductId: string,
	observation: SupplementObservation,
): EvidenceDraft {
	return buildEvidenceDraft({
		subjectType: "product",
		subjectId: canonicalProductId,
		predicate: observation.predicate,
		value: observation.value,
		...(observation.unit ? { unit: observation.unit } : {}),
		valueState: "known",
		evidenceClass: observation.evidenceClass,
		sourceType: observation.sourceType,
		sourceTable: "supplemental_research_runs",
		// The URL, not the run id: re-running the same research over the same
		// unchanged page must not mint a second row for one fact.
		sourceRecordId: observation.sourceUrl,
		sourceUrl: observation.sourceUrl,
		...(observation.sourceLocator ? { sourceLocator: observation.sourceLocator } : {}),
		observedAt: observation.observedAt,
		confidence: observation.confidence,
	});
}

export function createSupplementRepository(
	sb: SupabaseClient,
	serviceClient: SupabaseClient,
): SupplementRepository {
	return {
		async loadOwnedRun(runId, userId) {
			const { data, error } = await sb
				.from("product_recommendation_runs")
				.select("id, query_json, knowledge_snapshot_id")
				.eq("id", runId)
				.eq("created_by", userId)
				.maybeSingle();
			if (error) throw new Error(`recommendation run lookup failed: ${error.message}`);
			if (!data) return null;
			return {
				id: String(data.id),
				query: data.query_json,
				knowledgeSnapshotId: (data.knowledge_snapshot_id as string | null) ?? null,
			};
		},
		async canonicalProductInRun(runId, canonicalProductId) {
			// The product must be one this run actually ranked. Without this a
			// caller could name any canonical product and have us research it
			// under someone else's run.
			const { data, error } = await sb
				.from("product_recommendation_items")
				.select("canonical_product_id, canonical_products!inner(id, display_name, normalized_category)")
				.eq("run_id", runId)
				.eq("canonical_product_id", canonicalProductId)
				.maybeSingle();
			if (error) throw new Error(`recommendation item lookup failed: ${error.message}`);
			if (!data) return null;
			const product = data.canonical_products as unknown as {
				id: string;
				display_name: string;
				normalized_category: string | null;
			};
			return { id: String(product.id), name: product.display_name, category: product.normalized_category };
		},
		async createSupplementalRun(input) {
			const { data, error } = await sb
				.from("supplemental_research_runs")
				.insert({
					recommendation_run_id: input.recommendationRunId,
					canonical_product_id: input.canonicalProductId,
					created_by: input.userId,
					requested_gaps: input.gaps,
					status: "running",
					prior_knowledge_snapshot_id: input.priorKnowledgeSnapshotId,
				})
				.select("id")
				.single();
			if (error) throw new Error(`supplemental run insert failed: ${error.message}`);
			return String(data.id);
		},
		async completeSupplementalRun(id, patch) {
			const { error } = await sb
				.from("supplemental_research_runs")
				.update({
					status: patch.status,
					evidence_count: patch.evidenceCount,
					result_recommendation_run_id: patch.resultRecommendationRunId ?? null,
					result_knowledge_snapshot_id: patch.resultKnowledgeSnapshotId ?? null,
					error_code: patch.errorCode ?? null,
					error_summary: patch.errorSummary ?? null,
					completed_at: new Date().toISOString(),
				})
				.eq("id", id);
			// Best-effort: this runs after the work is done, and letting it throw
			// would replace a usable result with a bookkeeping error.
			if (error) console.error(`[supplement] could not finalise run ${id}:`, error.message);
		},
		// evidence_items is service-role-write by design (20260830100000) — the
		// same single exception the product finder makes for knowledge_snapshots.
		upsertEvidence: async (drafts) => {
			const { upsertEvidence } = await import("@/lib/intelligence/repository");
			return upsertEvidence(serviceClient, drafts);
		},
		async rerank(userId, query) {
			// Re-validated through the strict parser before use: query_json is a
			// stored blob, and a run row that was written under an older shape must
			// not become a way to smuggle a wider query back in.
			const parsed = parseProductFinderQuery(query);
			const result = await runProductFinderFromStoredEvidence(
				createProductFinderRepository(sb),
				userId,
				parsed,
				{ mode: "supplemented" },
			);
			const { data } = await sb
				.from("product_recommendation_runs")
				.select("knowledge_snapshot_id")
				.eq("id", result.runId)
				.maybeSingle();
			return {
				runId: result.runId,
				knowledgeSnapshotId: (data?.knowledge_snapshot_id as string | null) ?? null,
			};
		},
	};
}

export class SupplementError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status: number) {
		super(message);
		this.name = "SupplementError";
		this.code = code;
		this.status = status;
	}
}

export async function runSupplementalResearch(
	repo: SupplementRepository,
	deps: SupplementProviderDeps,
	input: {
		recommendationRunId: string;
		canonicalProductId: string;
		userId: string;
		gaps: SupplementGap[];
	},
): Promise<SupplementResult> {
	const run = await repo.loadOwnedRun(input.recommendationRunId, input.userId);
	if (!run) throw new SupplementError("run_not_found", "recommendation run not found", 404);
	if (!run.knowledgeSnapshotId) {
		// A run with no snapshot never completed, so there is nothing to
		// supplement and nothing to compare the result against.
		throw new SupplementError("run_incomplete", "the recommendation run has no knowledge snapshot", 409);
	}
	const product = await repo.canonicalProductInRun(input.recommendationRunId, input.canonicalProductId);
	if (!product) {
		throw new SupplementError("product_not_in_run", "that product is not part of this run", 404);
	}

	const supplementalRunId = await repo.createSupplementalRun({
		recommendationRunId: run.id,
		canonicalProductId: product.id,
		userId: input.userId,
		gaps: input.gaps,
		priorKnowledgeSnapshotId: run.knowledgeSnapshotId,
	});

	const target: SupplementProduct = product;
	const observations: SupplementObservation[] = [];
	const failedGaps: SupplementGap[] = [];
	for (const gap of input.gaps) {
		try {
			observations.push(...(await researchGap(target, gap, deps)));
		} catch (error) {
			// One provider being down does not invalidate the others' answers.
			failedGaps.push(gap);
			console.warn(
				`[supplement] gap ${gap} failed:`,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	if (failedGaps.length === input.gaps.length) {
		await repo.completeSupplementalRun(supplementalRunId, {
			status: "failed",
			evidenceCount: 0,
			errorCode: "all_gaps_failed",
			errorSummary: `every requested gap failed: ${failedGaps.join(", ")}`,
		});
		return {
			supplementalRunId,
			status: "failed",
			// The original. It is still the best result the operator has.
			recommendationRunId: run.id,
			evidenceCount: 0,
			failedGaps,
		};
	}

	const evidenceIds =
		observations.length > 0
			? await repo.upsertEvidence(observations.map((o) => observationToDraft(product.id, o)))
			: [];

	// Read back from the database. Ranking an in-memory result would produce a
	// recommendation the ledger cannot reproduce.
	const reranked = await repo.rerank(input.userId, run.query);
	const status: SupplementStatus = failedGaps.length > 0 ? "partial" : "completed";

	await repo.completeSupplementalRun(supplementalRunId, {
		status,
		evidenceCount: evidenceIds.length,
		resultRecommendationRunId: reranked.runId,
		...(reranked.knowledgeSnapshotId ? { resultKnowledgeSnapshotId: reranked.knowledgeSnapshotId } : {}),
		...(failedGaps.length > 0
			? { errorCode: "partial_gaps", errorSummary: `failed: ${failedGaps.join(", ")}` }
			: {}),
	});

	return {
		supplementalRunId,
		status,
		recommendationRunId: reranked.runId,
		evidenceCount: evidenceIds.length,
		failedGaps,
	};
}
