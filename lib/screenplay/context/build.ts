/**
 * Assemble everything a screenplay run reads, persist it, and only then draft.
 *
 * The order is the point. A context row exists before the first token of prose,
 * so a generation that fails at the model leaves a complete account of what it
 * was about to write from — which is exactly the case where "what did it read"
 * was previously unanswerable.
 *
 * A refine reuses its base context. Re-reading the world for a rewrite would
 * mean the second version rests on evidence the first never saw, while
 * presenting itself as an edit of it; the knowledge snapshot would describe a
 * state that never produced anything. The one thing a refine does regenerate
 * is the structure plan, because feedback is allowed to move the running
 * order — and if that regeneration produces something invalid, the base plan
 * is kept rather than failing a rewrite that was otherwise fine.
 *
 * Every write here needs the service client: evidence_items,
 * knowledge_snapshots and screenplay_generation_contexts are all
 * service-role-write by design (20260830100000, 20260829150000).
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { modelForStage } from "@/lib/gemini-models";
import { createKnowledgeSnapshot } from "@/lib/intelligence/repository";
import type { KnowledgeSnapshotDraft } from "@/lib/intelligence/types";
import { selectAllPages } from "@/lib/supabase/paginate";
import type { ProductBrief } from "@/lib/screenplay/types";
import { buildProductFactPack, briefEvidenceDrafts } from "./product-facts";
import { loadPatternResult, type PatternLoadResult } from "./pattern-result";
import { loadReferenceBroadcasts, type ReferenceBroadcast } from "./reference-broadcasts";
import {
	buildStructurePlan,
	StructurePlanError,
	type ScreenplayStructurePlan,
	type StructurePlanGenerator,
} from "./structure-plan";
import { geminiStructurePlanGenerator } from "./structure-plan-gemini";
import type { ProductFactPack } from "./types";

export const CONTEXT_ALGORITHM_VERSION = "grounded-screenplay-v1";

export interface ScreenplayGenerationContext {
	id: string;
	screenplayId: string;
	runId: string;
	knowledgeSnapshotId: string;
	productFactPack: ProductFactPack;
	referenceBroadcasts: ReferenceBroadcast[];
	patternResult: PatternLoadResult;
	structurePlan: ScreenplayStructurePlan;
	createdAt: string;
}

export interface ContextInsert {
	screenplayId: string;
	runId: string;
	knowledgeSnapshotId: string;
	productFactPack: ProductFactPack;
	referenceBroadcasts: ReferenceBroadcast[];
	patternResult: PatternLoadResult;
	structurePlan: ScreenplayStructurePlan;
	modelVersion: string | null;
}

export interface ScreenplayContextRepository {
	loadFactPack(input: {
		screenplayId: string;
		canonicalProductId: string | null;
		brief: ProductBrief;
		observedAt: string;
	}): Promise<ProductFactPack>;
	loadReferences(brief: ProductBrief): Promise<ReferenceBroadcast[]>;
	loadPattern(category: string | null): Promise<PatternLoadResult>;
	/** Evidence rows describing the referenced broadcasts, so the snapshot can
	 *  name what the structure actually rested on. */
	loadBroadcastEvidence(broadcastIds: string[]): Promise<Array<{ subjectId: string; evidenceItemId: string }>>;
	createSnapshot(draft: KnowledgeSnapshotDraft): Promise<string>;
	insertContext(row: ContextInsert): Promise<{ id: string; createdAt: string }>;
	loadBaseContext(versionId: string): Promise<ScreenplayGenerationContext | null>;
	generateStructurePlan: StructurePlanGenerator;
}

export interface BuildContextInput {
	screenplayId: string;
	runId: string;
	canonicalProductId: string | null;
	brief: ProductBrief;
	mode: "initial" | "refine";
	baseVersionId?: string;
}

/**
 * Did the operator change the product between the base version and this
 * refine? Compared on the brief's own values rather than on a timestamp: a
 * brief edited and edited back is the same brief, and a re-save that changed
 * nothing must not cost a fresh snapshot.
 */
export function briefMatchesPack(brief: ProductBrief, pack: ProductFactPack): boolean {
	const drafts = briefEvidenceDrafts(pack.subjectId, brief, pack.builtAt);
	const stored = new Map(
		pack.facts.filter((f) => f.sourceLabel === "screenplay_brief").map((f) => [f.key, JSON.stringify(f.value)]),
	);
	if (stored.size !== drafts.length) return false;
	return drafts.every((draft) => stored.get(draft.predicate) === JSON.stringify(draft.value));
}

export function createScreenplayContextRepository(sb: SupabaseClient): ScreenplayContextRepository {
	return {
		loadFactPack: (input) => buildProductFactPack(sb, input),
		loadReferences: (brief) => loadReferenceBroadcasts(sb, brief),
		loadPattern: (category) => loadPatternResult(category),
		async loadBroadcastEvidence(broadcastIds) {
			if (broadcastIds.length === 0) return [];
			const rows = await selectAllPages<{ id: string; subject_id: string }>(
				({ from, to }) =>
					sb
						.from("evidence_items")
						.select("id, subject_id")
						.eq("subject_type", "broadcast")
						.in("subject_id", broadcastIds)
						.order("id", { ascending: true })
						.range(from, to),
				{ pageSize: 800, label: "screenplay:reference-evidence" },
			);
			return rows.map((row) => ({ subjectId: row.subject_id, evidenceItemId: row.id }));
		},
		createSnapshot: (draft) => createKnowledgeSnapshot(sb, draft),
		async insertContext(row) {
			const { data, error } = await sb
				.from("screenplay_generation_contexts")
				.insert({
					screenplay_id: row.screenplayId,
					run_id: row.runId,
					knowledge_snapshot_id: row.knowledgeSnapshotId,
					product_fact_pack: row.productFactPack,
					reference_broadcasts: row.referenceBroadcasts,
					pattern_status: row.patternResult.status,
					pattern_detail: row.patternResult.detail,
					// Persisted even when the status is not `applied`: pattern_snapshot
					// is then null and the STATUS carries the reason, which is the whole
					// point of the column.
					pattern_snapshot: row.patternResult.pattern,
					outline: {
						basis: row.structurePlan.basis,
						runtimeMinutes: row.structurePlan.runtimeMinutes,
						sections: row.structurePlan.sections,
					},
					demo_plan: row.structurePlan.demos,
					model_version: row.modelVersion,
				})
				.select("id, created_at")
				.single();
			if (error) throw new Error(`generation context insert failed: ${error.message}`);
			return { id: String(data.id), createdAt: String(data.created_at) };
		},
		async loadBaseContext(versionId) {
			const { data: version, error: versionError } = await sb
				.from("screenplay_versions")
				.select("generation_context_id")
				.eq("id", versionId)
				.maybeSingle();
			if (versionError) throw new Error(`base version lookup failed: ${versionError.message}`);
			const contextId = version?.generation_context_id;
			// A legacy version predates the context table. That is a real state,
			// not an error: the refine builds a fresh context instead.
			if (!contextId) return null;

			const { data, error } = await sb
				.from("screenplay_generation_contexts")
				.select("*")
				.eq("id", contextId as string)
				.maybeSingle();
			if (error) throw new Error(`base context lookup failed: ${error.message}`);
			if (!data) return null;
			return rowToContext(data as Record<string, unknown>);
		},
		generateStructurePlan: geminiStructurePlanGenerator(),
	};
}

export function rowToContext(row: Record<string, unknown>): ScreenplayGenerationContext {
	const outline = (row.outline ?? {}) as {
		basis?: ScreenplayStructurePlan["basis"];
		runtimeMinutes?: number;
		sections?: ScreenplayStructurePlan["sections"];
	};
	return {
		id: String(row.id),
		screenplayId: String(row.screenplay_id),
		runId: String(row.run_id),
		knowledgeSnapshotId: String(row.knowledge_snapshot_id),
		productFactPack: row.product_fact_pack as ProductFactPack,
		referenceBroadcasts: (row.reference_broadcasts ?? []) as ReferenceBroadcast[],
		patternResult: {
			status: row.pattern_status as PatternLoadResult["status"],
			pattern: (row.pattern_snapshot ?? null) as PatternLoadResult["pattern"],
			detail: String(row.pattern_detail ?? ""),
		},
		structurePlan: {
			basis: outline.basis ?? "generic",
			runtimeMinutes: outline.runtimeMinutes ?? 25,
			sections: outline.sections ?? [],
			demos: (row.demo_plan ?? []) as ScreenplayStructurePlan["demos"],
		},
		createdAt: String(row.created_at),
	};
}

function snapshotItems(
	factPack: ProductFactPack,
	referenceEvidence: Array<{ subjectId: string; evidenceItemId: string }>,
): KnowledgeSnapshotDraft["items"] {
	const items: KnowledgeSnapshotDraft["items"] = [];
	const seen = new Set<string>();
	for (const fact of factPack.facts) {
		for (const evidenceItemId of fact.evidenceItemIds) {
			const key = `fact:${evidenceItemId}:${fact.key}`;
			if (seen.has(key)) continue;
			seen.add(key);
			items.push({ evidenceItemId, usageRole: "product_fact", resultLocator: fact.key });
		}
	}
	for (const { subjectId, evidenceItemId } of referenceEvidence) {
		const key = `ref:${evidenceItemId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		items.push({ evidenceItemId, usageRole: "reference_broadcast", resultLocator: subjectId });
	}
	return items;
}

export async function buildScreenplayGenerationContext(
	repo: ScreenplayContextRepository,
	input: BuildContextInput,
): Promise<ScreenplayGenerationContext> {
	// One instant for the whole context. Taken before any read, so the facts,
	// the references and the snapshot all describe the same moment.
	const observedAt = new Date().toISOString();

	const base =
		input.mode === "refine" && input.baseVersionId
			? await repo.loadBaseContext(input.baseVersionId)
			: null;

	// A refine adopts the canonical product its base recorded. The screenplay
	// row does not carry that link — the context does — and the refine caller
	// has no way to know it, so demanding it from the caller would make every
	// refine of a product-finder screenplay look like a product change.
	const canonicalProductId =
		base && input.canonicalProductId === null
			? base.productFactPack.canonicalProductId
			: input.canonicalProductId;

	// A refine inherits its base's evidence, but only while it is still about
	// the same product. Swap the linked product or edit the brief and the
	// inherited snapshot would describe something else.
	const inherits =
		base !== null &&
		base.productFactPack.canonicalProductId === canonicalProductId &&
		briefMatchesPack(input.brief, base.productFactPack);

	const factPack = inherits ? base.productFactPack : await repo.loadFactPack({
		screenplayId: input.screenplayId,
		canonicalProductId,
		brief: input.brief,
		observedAt,
	});
	const references = inherits ? base.referenceBroadcasts : await repo.loadReferences(input.brief);
	const patternResult = inherits
		? base.patternResult
		: await repo.loadPattern(input.brief.category ?? null);

	const planInput = { factPack, patternResult, references, brief: input.brief };
	let structurePlan: ScreenplayStructurePlan;
	try {
		structurePlan = await buildStructurePlan(planInput, repo.generateStructurePlan);
	} catch (error) {
		// An initial run has nothing to fall back to: an unusable plan is a
		// failed generation, and the structured error says why. A refine has a
		// plan that already worked, and keeping it is better than refusing an
		// otherwise valid rewrite.
		if (!base) throw error;
		console.warn(
			`[screenplay] refine kept the base structure plan: ${error instanceof StructurePlanError ? error.code : String(error)}`,
		);
		structurePlan = base.structurePlan;
	}

	const knowledgeSnapshotId = inherits
		? base.knowledgeSnapshotId
		: await repo.createSnapshot({
				consumerType: "screenplay",
				consumerRunId: input.runId,
				createdBy: null,
				// The screenplay path reads stored evidence only. When
				// supplemental research lands it has to change this value, which
				// makes "did anything reach the internet" answerable from the row.
				mode: "stored_only",
				query: {
					screenplayId: input.screenplayId,
					canonicalProductId,
					category: input.brief.category ?? null,
					mode: input.mode,
				},
				dataCutoff: observedAt,
				algorithmVersion: CONTEXT_ALGORITHM_VERSION,
				items: snapshotItems(
					factPack,
					await repo.loadBroadcastEvidence(references.map((r) => r.broadcastId)),
				),
			});

	const inserted = await repo.insertContext({
		screenplayId: input.screenplayId,
		runId: input.runId,
		knowledgeSnapshotId,
		productFactPack: factPack,
		referenceBroadcasts: references,
		patternResult,
		structurePlan,
		modelVersion: modelForStage("screenplay_structure"),
	});

	return {
		id: inserted.id,
		screenplayId: input.screenplayId,
		runId: input.runId,
		knowledgeSnapshotId,
		productFactPack: factPack,
		referenceBroadcasts: references,
		patternResult,
		structurePlan,
		createdAt: inserted.createdAt,
	};
}

/** Convenience wrapper for the workflow: the service client, wired to the real
 *  repository. Tests drive buildScreenplayGenerationContext directly. */
export async function buildScreenplayContext(
	sb: SupabaseClient,
	input: BuildContextInput,
): Promise<ScreenplayGenerationContext> {
	return buildScreenplayGenerationContext(createScreenplayContextRepository(sb), input);
}
