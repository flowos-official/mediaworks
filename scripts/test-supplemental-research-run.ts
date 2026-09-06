/**
 * Explicit research: what it writes, what it re-reads, and what survives a
 * provider being down.
 *
 * Two properties carry this feature.
 *
 *   Research WRITES evidence; ranking READS it. The re-rank goes back to the
 *   database rather than ranking the search results in memory, because a
 *   recommendation the ledger cannot reproduce is not auditable — which is the
 *   entire purpose of the knowledge snapshot it produces.
 *
 *   A total provider failure must leave the operator exactly where they were.
 *   The response names the ORIGINAL run, and no new recommendation exists to
 *   be mistaken for a better one.
 */
import assert from "node:assert/strict";
import {
	observationToDraft,
	runSupplementalResearch,
	SupplementError,
	type SupplementRepository,
} from "../lib/intelligence/supplement/run";
import type { SupplementProviderDeps } from "../lib/intelligence/supplement/providers";
import type { SupplementObservation } from "../lib/intelligence/supplement/types";
import type { EvidenceDraft } from "../lib/intelligence/types";
import { assembleCandidate, type EvidenceRow } from "../lib/product-finder/candidates";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const SNAPSHOT_ID = "44444444-4444-4444-8444-444444444444";

interface Calls {
	gaps: string[];
	drafts: EvidenceDraft[];
	reranks: number;
	completed: Array<Record<string, unknown>>;
	reaped: number;
}

function harness(
	over: {
		repo?: Partial<SupplementRepository>;
		failGaps?: string[];
	} = {},
): { repo: SupplementRepository; deps: SupplementProviderDeps; calls: Calls } {
	const calls: Calls = { gaps: [], drafts: [], reranks: 0, completed: [], reaped: 0 };

	const repo: SupplementRepository = {
		async reapOrphans() {
			calls.reaped++;
			return 0;
		},
		async loadOwnedRun(runId, userId) {
			return runId === RUN_ID && userId === USER_ID
				? { id: RUN_ID, query: { mode: "stored_only", limit: 10 }, knowledgeSnapshotId: SNAPSHOT_ID }
				: null;
		},
		async canonicalProductInRun(_runId, id) {
			return id === PRODUCT_ID ? { id: PRODUCT_ID, name: "静音ブレンダー", category: "家電" } : null;
		},
		async createSupplementalRun() {
			return "sup-1";
		},
		async completeSupplementalRun(id, patch) {
			calls.completed.push({ id, ...patch });
		},
		async upsertEvidence(drafts) {
			calls.drafts.push(...drafts);
			return drafts.map((_, i) => `ev-${i}`);
		},
		async rerank() {
			calls.reranks++;
			return { runId: "run-2", knowledgeSnapshotId: "snap-2" };
		},
		...over.repo,
	};

	const deps: SupplementProviderDeps = {
		async braveSearch() {
			return [{ title: "累計突破", description: "累計10万台突破", url: "https://example.test/p" }];
		},
		async rakutenSearch() {
			return {
				items: [
					{
						rank: 1,
						itemName: "静音ブレンダー",
						itemPrice: 14800,
						itemCaption: "",
						itemUrl: "https://item.rakuten.co.jp/s/x/",
						shopName: "店",
						reviewCount: 12,
						reviewAverage: 4.2,
					},
				],
			};
		},
		async fetchPage(url) {
			return { finalUrl: url, contentType: "text/html", text: "<meta name=\"description\" content=\"仕様\">" };
		},
		now: () => new Date("2026-09-05T00:00:00.000Z"),
	};

	// Wrap the providers so a named gap can be made to fail.
	const failing = new Set(over.failGaps ?? []);
	const wrapped: SupplementProviderDeps = {
		...deps,
		async braveSearch(query, count) {
			calls.gaps.push("brave");
			if (failing.has("brave")) throw new Error("brave unavailable");
			return deps.braveSearch(query, count);
		},
		async rakutenSearch(keyword, sort, limit) {
			calls.gaps.push("rakuten");
			if (failing.has("rakuten")) throw new Error("rakuten unavailable");
			return deps.rakutenSearch(keyword, sort, limit);
		},
	};

	return { repo, deps: wrapped, calls };
}

async function main(): Promise<void> {
	// --- ownership is checked before anything happens -----------------------
	{
		const { repo, deps, calls } = harness();
		await assert.rejects(
			runSupplementalResearch(repo, deps, {
				recommendationRunId: RUN_ID,
				canonicalProductId: PRODUCT_ID,
				userId: "someone-else",
				gaps: ["current_price"],
			}),
			(e: unknown) => e instanceof SupplementError && e.code === "run_not_found",
		);
		assert.deepEqual(calls.gaps, [], "a run we do not own must cost no external call");
		// The sweep runs BEFORE ownership is even checked: a row another
		// operator's killed function stranded should not wait for that operator
		// to come back.
		assert.equal(calls.reaped, 1, "the orphan sweep is a preflight on every attempt");
	}
	{
		const { repo, deps, calls } = harness();
		await assert.rejects(
			runSupplementalResearch(repo, deps, {
				recommendationRunId: RUN_ID,
				canonicalProductId: "55555555-5555-4555-8555-555555555555",
				userId: USER_ID,
				gaps: ["current_price"],
			}),
			(e: unknown) => e instanceof SupplementError && e.code === "product_not_in_run",
			"researching a product this run never ranked would be researching on someone else's behalf",
		);
		assert.deepEqual(calls.gaps, []);
	}
	console.log("✓ ownership and run membership are checked before a provider is touched");

	// --- an incomplete run cannot be supplemented ---------------------------
	{
		const { repo, deps } = harness({
			repo: {
				async loadOwnedRun() {
					return { id: RUN_ID, query: {}, knowledgeSnapshotId: null };
				},
			},
		});
		await assert.rejects(
			runSupplementalResearch(repo, deps, {
				recommendationRunId: RUN_ID,
				canonicalProductId: PRODUCT_ID,
				userId: USER_ID,
				gaps: ["current_price"],
			}),
			(e: unknown) => e instanceof SupplementError && e.code === "run_incomplete",
		);
	}
	console.log("✓ a run with no snapshot has nothing to supplement");

	// --- only the requested gap's provider is called ------------------------
	{
		const { repo, deps, calls } = harness();
		const result = await runSupplementalResearch(repo, deps, {
			recommendationRunId: RUN_ID,
			canonicalProductId: PRODUCT_ID,
			userId: USER_ID,
			gaps: ["current_price"],
		});
		assert.deepEqual(calls.gaps, ["rakuten"], "a price question must not spend a web search");
		assert.equal(result.status, "completed");
		assert.equal(result.recommendationRunId, "run-2");
		assert.equal(calls.reranks, 1);
		assert.equal(calls.drafts.length, 1);
		assert.equal(calls.drafts[0].predicate, "marketplace_price_jpy");
		assert.equal(calls.drafts[0].subjectId, PRODUCT_ID);
		assert.equal(calls.drafts[0].valueState, "known");
	}
	console.log("✓ one gap calls one provider, writes evidence, and re-ranks once");

	// --- one failed gap is partial, not a failure ---------------------------
	{
		const { repo, deps, calls } = harness({ failGaps: ["brave"] });
		const result = await runSupplementalResearch(repo, deps, {
			recommendationRunId: RUN_ID,
			canonicalProductId: PRODUCT_ID,
			userId: USER_ID,
			gaps: ["current_price", "seller_sales_claim"],
		});
		assert.equal(result.status, "partial", "one provider down does not invalidate the other's answer");
		assert.deepEqual(result.failedGaps, ["seller_sales_claim"]);
		assert.equal(result.recommendationRunId, "run-2", "a partial run still produces a new ranking");
		assert.equal(calls.reranks, 1);
		assert.equal(calls.completed[0].status, "partial");
	}
	console.log("✓ a partial failure still delivers what was found, marked partial");

	// --- total failure leaves the original result intact --------------------
	{
		const { repo, deps, calls } = harness({ failGaps: ["brave", "rakuten"] });
		const result = await runSupplementalResearch(repo, deps, {
			recommendationRunId: RUN_ID,
			canonicalProductId: PRODUCT_ID,
			userId: USER_ID,
			gaps: ["current_price", "seller_sales_claim"],
		});
		assert.equal(result.status, "failed");
		assert.equal(
			result.recommendationRunId,
			RUN_ID,
			"a provider outage must not cost the operator the result they already had",
		);
		assert.equal(calls.reranks, 0, "no new ranking is created from nothing");
		assert.equal(calls.drafts.length, 0, "and no evidence is written");
		assert.equal(calls.completed[0].status, "failed");
		assert.equal(calls.completed[0].errorCode, "all_gaps_failed");
	}
	console.log("✓ a total provider failure returns the original run and writes nothing");

	// --- the draft keeps the class and identifies the source ----------------
	{
		const claim: SupplementObservation = {
			gap: "seller_sales_claim",
			predicate: "seller_claim",
			value: "累計10万台突破",
			evidenceClass: "source_claim",
			sourceType: "brave_result",
			sourceUrl: "https://example.test/a",
			sourceTitle: "t",
			observedAt: "2026-09-05T00:00:00.000Z",
			confidence: 0.3,
		};
		const draft = observationToDraft(PRODUCT_ID, claim);
		assert.equal(draft.evidenceClass, "source_claim", "a claim is never promoted on the way in");
		// The URL, not the run id: re-running the same research over an unchanged
		// page must not mint a second row for one fact.
		assert.equal(draft.sourceRecordId, "https://example.test/a");
		assert.equal(draft.sourceUrl, "https://example.test/a");
		assert.equal(draft.subjectType, "product");
	}
	console.log("✓ an observation becomes evidence without changing class, keyed on its source");

	// --- revoked evidence never reaches a candidate -------------------------
	// Rollback revokes rather than deletes, so a past snapshot still resolves.
	// It must not reach a NEW ranking.
	{
		const row = (over: Partial<EvidenceRow> & Pick<EvidenceRow, "predicate">): EvidenceRow => ({
			id: `ev-${over.predicate}`,
			subject_id: PRODUCT_ID,
			value_json: null,
			value_state: "known",
			evidence_class: "internal_input",
			confidence: 1,
			observed_at: "2026-09-05T00:00:00.000Z",
			revoked_at: null,
			...over,
		});
		const active = assembleCandidate(
			{ id: PRODUCT_ID, display_name: "x", normalized_category: null },
			[row({ predicate: "gross_profit_jpy", value_json: 5000 })],
		);
		assert.equal(active.signals.internalProfitJpy?.value, 5000);

		const revoked = assembleCandidate(
			{ id: PRODUCT_ID, display_name: "x", normalized_category: null },
			[row({ predicate: "gross_profit_jpy", value_json: 5000, revoked_at: "2026-09-05T01:00:00.000Z" })],
		);
		assert.equal(
			revoked.signals.internalProfitJpy,
			undefined,
			"a rolled-back profit figure must not rank a product",
		);
		assert.equal(revoked.evidenceIds.length, 1, "but it is still recorded as consulted");
	}
	console.log("✓ rolled-back evidence is excluded from a new ranking");

	// --- the re-rank goes through the strict parser -------------------------
	{
		const { readFileSync } = await import("node:fs");
		const source = readFileSync("lib/intelligence/supplement/run.ts", "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		assert.ok(
			source.includes("parseProductFinderQuery(query)"),
			"query_json is a stored blob; it must be re-validated before it steers a new run",
		);
		assert.ok(
			source.includes('{ mode: "supplemented" }'),
			"the re-ranked run must record that supplemental evidence preceded it",
		);
		assert.ok(
			source.includes("runProductFinderFromStoredEvidence"),
			"the re-rank must be the same database-only runner, not a bespoke path",
		);
	}
	console.log("✓ the re-rank re-validates the stored query and uses the database-only runner");

	console.log("PASS: supplemental research run");
}

main().catch((error) => {
	console.error("FAIL:", error);
	process.exit(1);
});
