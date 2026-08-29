import assert from "node:assert/strict";

import {
	buildBackfillCursor,
	buildSourcePageQuery,
	CONNECTED_PRODUCT_SOURCE_CHANNELS,
	executeBackfillPage,
	initialBackfillCursor,
	isConnectedProductSource,
	mapBroadcastAnalysisEvidence,
	mapDiscoveredProductEvidence,
	parseBackfillArgs,
	parseBackfillCursor,
	resolveExactCanonicalProduct,
	runFoundationBackfill,
	type BroadcastAnalysisBackfillRow,
	type DiscoveredProductBackfillRow,
	type PipelineRunHandle,
} from "../lib/intelligence/backfill";
import { runCliBackfill } from "./backfill-intelligence-foundation";

const PRODUCT_OBSERVED_AT = "2026-08-29T01:02:03.000Z";

const productRow: DiscoveredProductBackfillRow = {
	id: "discovered-product-1",
	canonicalProductId: "canonical-product-1",
	name: "スチームアイロン",
	category: "家電",
	normalizedCategory: "家電",
	productUrl: "https://www.qvc.jp/product/1",
	priceJpy: 12_800,
	reviewCount: null,
	tvEvidence: { airing_count: 4 },
	observedAt: PRODUCT_OBSERVED_AT,
};

const productEvidence = mapDiscoveredProductEvidence(productRow);
const productByPredicate = new Map(productEvidence.map((draft) => [draft.predicate, draft]));

assert.equal(productEvidence.length, 5);
assert.equal(productByPredicate.get("name")?.evidenceClass, "source_claim");
assert.equal(productByPredicate.get("normalized_category")?.evidenceClass, "inferred");
assert.equal(productByPredicate.get("price_jpy")?.evidenceClass, "verified");
assert.equal(productByPredicate.get("price_jpy")?.valueState, "known");
assert.equal(productByPredicate.get("price_jpy")?.value, 12_800);
assert.equal(productByPredicate.get("review_count")?.evidenceClass, "proxy");
assert.equal(productByPredicate.get("review_count")?.valueState, "unknown");
assert.equal(productByPredicate.get("review_count")?.value, undefined);
assert.equal(productByPredicate.get("tv_airing_count")?.evidenceClass, "proxy");
assert.equal(productByPredicate.get("tv_airing_count")?.valueState, "known");
assert.equal(productByPredicate.get("tv_airing_count")?.value, 4);
for (const draft of productEvidence) {
	assert.equal(draft.sourceUrl, productRow.productUrl);
	assert.equal(draft.observedAt, PRODUCT_OBSERVED_AT);
}

const unknownProductEvidence = mapDiscoveredProductEvidence({
	...productRow,
	name: null,
	priceJpy: null,
	tvEvidence: null,
	normalizedCategory: null,
});
for (const predicate of ["name", "normalized_category", "price_jpy", "review_count", "tv_airing_count"]) {
	const draft = unknownProductEvidence.find((item) => item.predicate === predicate);
	assert.equal(draft?.valueState, "unknown", `${predicate} remains unknown when absent`);
	assert.equal(draft?.value, undefined, `${predicate} never turns absence into numeric zero`);
}

const broadcastRow: BroadcastAnalysisBackfillRow = {
	broadcastId: "broadcast-1",
	channel: "qvc",
	airDate: "2026-08-28",
	durationSec: 1_800,
	segments: [{ act_type: "opening", start_sec: 0, end_sec: 10 }],
	sellingPoints: [{ point_type: "ease_of_use", first_mentioned_sec: 12 }],
	evidenceCues: [{ type: "demo", at_sec: 20 }],
	objectionHandlings: [{ objection_type: "price", at_sec: 30 }],
	offerTimeline: { first_price_sec: 60, cta_secs: [90] },
	observedAt: "2026-08-29T02:03:04.000Z",
	sourceUrl: "https://www.qvc.jp/program/1",
};

const broadcastEvidence = mapBroadcastAnalysisEvidence(broadcastRow);
const broadcastByPredicate = new Map(broadcastEvidence.map((draft) => [draft.predicate, draft]));
assert.equal(broadcastEvidence.length, 7);
assert.equal(broadcastByPredicate.get("air_date")?.evidenceClass, "verified");
assert.equal(broadcastByPredicate.get("duration_sec")?.evidenceClass, "verified");
for (const predicate of ["segment_pattern", "selling_points", "evidence_cues", "objection_handlings", "offer_timing"]) {
	const draft = broadcastByPredicate.get(predicate);
	assert.equal(draft?.evidenceClass, "inferred", `${predicate} is model-derived`);
	assert.equal(draft?.valueState, "known", `${predicate} keeps a known JSON value`);
	assert.equal(draft?.sourceUrl, broadcastRow.sourceUrl);
	assert.equal(draft?.observedAt, broadcastRow.observedAt);
}
assert.deepEqual(broadcastByPredicate.get("segment_pattern")?.value, broadcastRow.segments);
assert.deepEqual(broadcastByPredicate.get("selling_points")?.value, broadcastRow.sellingPoints);
assert.ok(Array.isArray(broadcastByPredicate.get("evidence_cues")?.value));

const unknownBroadcastEvidence = mapBroadcastAnalysisEvidence({
	...broadcastRow,
	airDate: null,
	durationSec: null,
	segments: null,
	sellingPoints: null,
	evidenceCues: null,
	objectionHandlings: null,
	offerTimeline: null,
});
for (const predicate of ["air_date", "duration_sec", "segment_pattern", "selling_points", "evidence_cues", "objection_handlings", "offer_timing"]) {
	const draft = unknownBroadcastEvidence.find((item) => item.predicate === predicate);
	assert.equal(draft?.valueState, "unknown", `${predicate} is honestly unknown when absent`);
	assert.equal(draft?.value, undefined, `${predicate} is never substituted with zero or an empty JSON value`);
}

const argsCursor = buildBackfillCursor({
	products: { done: false, position: { observedAt: "2026-08-01T00:00:00.000Z", id: "discovered-product-0" } },
	broadcasts: { done: true },
});
const parsed = parseBackfillArgs([
	"--since=2026-08-01",
	"--limit=20",
	`--cursor=${argsCursor}`,
	"--apply",
]);
assert.deepEqual(parsed, {
	since: "2026-08-01T00:00:00.000Z",
	limit: 20,
	cursor: argsCursor,
	apply: true,
});
assert.equal(parseBackfillArgs([]).limit, 200);
assert.equal(parseBackfillArgs(["--limit=2000"]).limit, 2000);
assert.throws(() => parseBackfillArgs(["--limit=2001"]), /must not exceed 2000/);
assert.throws(() => parseBackfillArgs(["--limit=0"]), /positive integer/);
assert.throws(() => parseBackfillArgs(["--since=nope"]), /ISO date or timestamp/);

const cursor = buildBackfillCursor({
	products: { done: false, position: { observedAt: PRODUCT_OBSERVED_AT, id: "discovered-product-1" } },
	broadcasts: { done: false, position: { observedAt: "2026-08-29T02:03:04.000Z", id: "broadcast-1" } },
});
assert.deepEqual(parseBackfillCursor(cursor), {
	products: { done: false, position: { observedAt: PRODUCT_OBSERVED_AT, id: "discovered-product-1" } },
	broadcasts: { done: false, position: { observedAt: "2026-08-29T02:03:04.000Z", id: "broadcast-1" } },
});
assert.equal(buildBackfillCursor(parseBackfillCursor(cursor)), cursor, "cursor serialization is deterministic");
assert.throws(() => parseBackfillCursor("not-a-cursor"), /invalid cursor/);

async function verifyDryRun(): Promise<void> {
	let writes = 0;
	let normalizedInputs: string[] = [];
	const dryRun = await executeBackfillPage({
		products: [productRow],
		broadcasts: [broadcastRow],
		normalizeCategories: async (rawCategories) => {
			normalizedInputs = rawCategories;
			return new Map(rawCategories.map((category) => [category, ["家電"]]));
		},
		write: false,
		applyProduct: async () => { writes += 1; },
		applyBroadcast: async () => { writes += 1; },
	});
	assert.equal(writes, 0, "dry run never invokes write callbacks");
	assert.equal(dryRun.productEvidenceCount, 5);
	assert.equal(dryRun.broadcastEvidenceCount, 7);
	assert.equal(dryRun.reviewNeeded.missingNormalizedCategory, 0);
	assert.deepEqual(normalizedInputs, ["家電"], "normalizer receives distinct raw page categories");

	const reviewOnly = await executeBackfillPage({
		products: [productRow],
		broadcasts: [],
		normalizeCategories: async () => new Map(),
		write: false,
	});
	assert.equal(reviewOnly.reviewNeeded.missingNormalizedCategory, 1);
	assert.deepEqual(reviewOnly.reviewNeededCategories, ["家電"], "unclassified raw categories are reported for review");

	assert.throws(() => parseBackfillArgs(["--since=2026-02-30"]), /ISO date or timestamp/);
	assert.throws(() => parseBackfillArgs(["--since=August 1, 2026"]), /ISO date or timestamp/);
	assert.throws(
		() => parseBackfillCursor(Buffer.from(JSON.stringify({ v: 2, products: { done: true } })).toString("base64url")),
		/invalid cursor/,
	);

	const activeCursor = initialBackfillCursor();
	assert.deepEqual(activeCursor, { products: { done: false }, broadcasts: { done: false } });
	const completedProductsCursor = buildBackfillCursor({
		products: { done: true },
		broadcasts: { done: false, position: { observedAt: "2026-08-29T02:03:04.000Z", id: "broadcast-1" } },
	});
	assert.deepEqual(parseBackfillCursor(completedProductsCursor), {
		products: { done: true },
		broadcasts: { done: false, position: { observedAt: "2026-08-29T02:03:04.000Z", id: "broadcast-1" } },
	});
	assert.throws(
		() => parseBackfillCursor(Buffer.from(JSON.stringify({ v: 2, products: { done: true } })).toString("base64url")),
		/invalid cursor/,
		"one-sided cursors are rejected rather than restarting the omitted source",
	);

	const equalTimestampQuery = buildSourcePageQuery(
		"products",
		{ since: "2026-08-01T00:00:00.000Z", limit: 2 },
		{ done: false, position: { observedAt: "2026-08-29T02:03:04.000Z", id: "product-b" } },
	);
	assert.equal(equalTimestampQuery.orderBy[0]?.column, "created_at");
	assert.equal(equalTimestampQuery.orderBy[1]?.column, "id");
	assert.equal(
		equalTimestampQuery.cursorFilter,
		"created_at.lt.2026-08-29T02:03:04.000Z,and(created_at.eq.2026-08-29T02:03:04.000Z,id.lt.product-b)",
		"same-timestamp rows resume using the deterministic id tie-breaker",
	);
	assert.equal(equalTimestampQuery.limit, 2, "the product source query is bounded by the requested limit");
	assert.equal(buildSourcePageQuery("broadcasts", { since: "2026-08-01T00:00:00.000Z", limit: 2 }, { done: false }).limit, 2);

	assert.deepEqual(
		[...CONNECTED_PRODUCT_SOURCE_CHANNELS].sort(),
		["dinos", "ichiban", "japanet", "junsanpo", "kantv", "ntv", "qvc", "rakurakum", "senobura", "shopch", "tbs"],
		"only connected QVC, Shop Channel, and OA source slugs are in scope",
	);
	for (const slug of CONNECTED_PRODUCT_SOURCE_CHANNELS) {
		assert.equal(isConnectedProductSource(slug), true, `${slug} is accepted by the actual source-scope guard`);
	}
	assert.equal(isConnectedProductSource("rakuraku"), false, "the disconnected calendar alias is not accepted");

	const tvObservedAt = "2026-08-29T04:05:06.000Z";
	const tvDraft = mapDiscoveredProductEvidence({
		...productRow,
		observedAt: "2026-08-01T00:00:00.000Z",
		tvEvidenceAt: tvObservedAt,
		tvEvidence: { airing_count: 4, matched_at: "2026-08-28T04:05:06.000Z" },
	}).find((draft) => draft.predicate === "tv_airing_count");
	assert.equal(tvDraft?.observedAt, tvObservedAt, "TV airing evidence keeps its own observation time");

	const eventLog: string[] = [];
	const fakeRun: PipelineRunHandle = {
		id: "run-1",
		heartbeat: async () => { eventLog.push("heartbeat"); },
		succeed: async () => { eventLog.push("succeed"); },
		partial: async () => { eventLog.push("partial"); },
		fail: async () => { eventLog.push("fail"); },
	};
	const runnerDry = await runFoundationBackfill({
		args: { since: "2026-08-01T00:00:00.000Z", limit: 1, apply: false },
		cursor: initialBackfillCursor(),
		fetchProducts: async () => ({ rows: [productRow], exhausted: true, readCount: 1 }),
		fetchBroadcasts: async () => ({ rows: [broadcastRow], exhausted: false, readCount: 1, next: { observedAt: broadcastRow.observedAt, id: broadcastRow.broadcastId } }),
		loadCachedCategories: async () => new Map([["家電", ["家電"]]]),
		normalizeCategories: async () => { throw new Error("dry-run must not normalize/write"); },
		startPipelineRun: async () => { throw new Error("dry-run must not create a run"); },
		writeProduct: async () => { throw new Error("dry-run must not write products"); },
		writeBroadcast: async () => { throw new Error("dry-run must not write broadcasts"); },
	});
	assert.deepEqual(runnerDry.nextCursor, {
		products: { done: true },
		broadcasts: { done: false, position: { observedAt: broadcastRow.observedAt, id: broadcastRow.broadcastId } },
	});
	assert.deepEqual(eventLog, [], "real dry-run orchestration reaches no write dependency");

	const cliReads: string[] = [];
	const cliProduct = {
		id: "cli-product-1",
		name: productRow.name,
		category: productRow.category,
		product_url: productRow.productUrl,
		price_jpy: productRow.priceJpy,
		review_count: productRow.reviewCount,
		tv_evidence: productRow.tvEvidence,
		tv_evidence_at: null,
		created_at: productRow.observedAt,
		tv_channel_source: "qvc",
		user_action: null,
	};
	const cliSupabase = {
		from(table: string) {
			cliReads.push(`from:${table}`);
			const builder: any = {
				select: () => builder,
				eq: () => builder,
				gte: () => builder,
				order: () => builder,
				or: () => builder,
				limit: () => Promise.resolve({
					data: table === "discovered_products" ? [cliProduct] : [],
					error: null,
				}),
				in: () => {
					if (table === "discovered_category_normalization") {
						return Promise.resolve({ data: [{ raw_category: "家電", whitelist_categories: ["家電"] }], error: null });
					}
					return builder;
				},
			};
			return builder;
		},
	};
	const cliDry = await runCliBackfill(
		{ since: "2026-08-01T00:00:00.000Z", limit: 1, apply: false },
		cliSupabase as never,
	);
	assert.equal(cliDry.summary.productRowsWritten, 0);
	assert.deepEqual(
		cliReads.sort(),
		["from:broadcast_speech_analyses", "from:discovered_category_normalization", "from:discovered_products"],
		"the actual CLI dry-run adapter performs only the bounded source/cache reads",
	);

	type CliRaceScenario = "none" | "source-link-winner" | "source-link-restrict";
	function makeCliApplySupabase(options: {
		broadcastQueryFails?: boolean;
		evidenceConflicts?: boolean;
		race?: CliRaceScenario;
	} = {}) {
		const calls: string[] = [];
		const race = options.race ?? "none";
		let sourceLinkLookups = 0;
		let evidenceId = 0;
		const client = {
			from(table: string) {
				calls.push(`from:${table}`);
				const builder: any = {
					select(columns: string) {
						calls.push(`${table}:select:${columns}`);
						if (table === "evidence_items") {
							return {
								in(column: string, keys: string[]) {
									assert.equal(column, "dedupe_key");
									return Promise.resolve({
										data: keys.map((dedupeKey) => ({ id: `resolved:${dedupeKey}`, dedupe_key: dedupeKey })),
										error: null,
									});
								},
							};
						}
						return builder;
					},
					eq(column: string, value: string) { calls.push(`${table}:eq:${column}:${value}`); return builder; },
					gte(column: string, value: string) { calls.push(`${table}:gte:${column}:${value}`); return builder; },
					in(column: string, value: string[]) { calls.push(`${table}:in:${column}:${value.join(",")}`); return builder; },
					order(column: string) { calls.push(`${table}:order:${column}`); return builder; },
					or(value: string) { calls.push(`${table}:or:${value}`); return builder; },
					limit(value: number) {
						calls.push(`${table}:limit:${value}`);
						if (table === "discovered_products") return Promise.resolve({ data: [cliProduct], error: null });
						if (table === "broadcast_speech_analyses") {
							return Promise.resolve(options.broadcastQueryFails
								? { data: null, error: { message: "broadcast query unavailable" } }
								: { data: [], error: null });
						}
						throw new Error(`unexpected bounded query for ${table}`);
					},
					maybeSingle() {
						sourceLinkLookups += 1;
						if (race !== "none" && sourceLinkLookups > 1) {
							return Promise.resolve({ data: { canonical_product_id: "race-winner" }, error: null });
						}
						return Promise.resolve({ data: null, error: null });
					},
					insert(value: unknown) {
						calls.push(`${table}:insert`);
						if (table === "canonical_products") {
							return { select: () => ({ single: () => Promise.resolve({ data: { id: "local-canonical" }, error: null }) }) };
						}
						if (table === "product_source_links") {
							return Promise.resolve(race === "none"
								? { error: null }
								: { error: { message: "duplicate source link" } });
						}
						throw new Error(`unexpected insert for ${table}: ${JSON.stringify(value)}`);
					},
					delete() {
						return {
							eq() {
								calls.push(`${table}:delete`);
								return Promise.resolve(race === "source-link-restrict"
									? { error: { message: "RESTRICT foreign-key constraint" } }
									: { error: null });
							},
						};
					},
					upsert(rows: Array<{ dedupe_key: string }>) {
						calls.push(`${table}:upsert:${rows.length}`);
						return {
							select(columns: string) {
								assert.equal(columns, "id,dedupe_key");
								return Promise.resolve({
									data: options.evidenceConflicts
										? []
										: rows.map((row) => ({ id: `inserted:${++evidenceId}`, dedupe_key: row.dedupe_key })),
									error: null,
								});
							},
						};
					},
				};
				return builder;
			},
		};
		return { client: client as never, calls };
	}

	const failedPeer = makeCliApplySupabase({ broadcastQueryFails: true });
	const failedPeerHeartbeats: Array<{ processed?: number }> = [];
	const failedPeerEvents: string[] = [];
	await assert.rejects(() => runCliBackfill(
		{ since: "2026-08-01T00:00:00.000Z", limit: 1, apply: true },
		failedPeer.client,
		{
			normalizeCategories: async () => new Map(),
			startPipelineRun: async () => ({
				id: "cli-failed-peer",
				heartbeat: async (counts) => { failedPeerHeartbeats.push(counts ?? {}); },
				succeed: async () => { failedPeerEvents.push("succeed"); },
				partial: async () => { failedPeerEvents.push("partial"); },
				fail: async () => { failedPeerEvents.push("fail"); },
			}),
		},
	), /recorded as failed/);
	assert.ok(failedPeerHeartbeats.some((counts) => counts.processed === 1), "actual CLI retains the successful peer source read count after a query error");
	assert.deepEqual(failedPeerEvents, ["fail"], "actual CLI applies a failed terminal state after a pre-write query error");
	assert.equal(failedPeer.calls.includes("canonical_products:insert"), false, "a failed source query reaches no data writer");

	const appliedCli = makeCliApplySupabase();
	const appliedCliEvents: string[] = [];
	let appliedHeartbeats = 0;
	let appliedSuccesses = 0;
	const telemetryReports: string[] = [];
	const appliedResult = await runCliBackfill(
		{ since: "2026-08-01T00:00:00.000Z", limit: 1, apply: true },
		appliedCli.client,
		{
			normalizeCategories: async () => new Map([["家電", ["家電"]]]),
			startPipelineRun: async () => ({
				id: "cli-apply",
				heartbeat: async () => {
					appliedHeartbeats += 1;
					if (appliedHeartbeats === 1) throw new Error("temporary heartbeat outage");
				},
				succeed: async () => {
					appliedSuccesses += 1;
					if (appliedSuccesses === 1) throw new Error("first success settlement failed");
					appliedCliEvents.push("succeed");
				},
				partial: async () => { appliedCliEvents.push("partial"); },
				fail: async () => { appliedCliEvents.push("fail"); },
			}),
			reportTelemetryFailure: (phase) => { telemetryReports.push(phase); },
		},
	);
	assert.deepEqual(appliedResult.counts, { new: 7, updated: 0, duplicate: 0, failed: 0, processed: 1 });
	assert.deepEqual(telemetryReports, ["heartbeat"], "actual CLI reports but does not promote heartbeat failure into data failure");
	assert.equal(appliedSuccesses, 2, "actual CLI retries only the intended success terminal settlement once");
	assert.deepEqual(appliedCliEvents, ["succeed"], "success settlement rejection never flips the data operation to another terminal state");
	assert.ok(appliedCli.calls.includes("discovered_products:limit:1") && appliedCli.calls.includes("broadcast_speech_analyses:limit:1"), "actual CLI adapter keeps each source read bounded by the CLI limit");
	assert.ok(appliedCli.calls.includes("evidence_items:upsert:5"), "actual CLI apply executes the production evidence upsert adapter against the injected client");

	const evidenceRaceCli = makeCliApplySupabase({ evidenceConflicts: true });
	const evidenceRaceResult = await runCliBackfill(
		{ since: "2026-08-01T00:00:00.000Z", limit: 1, apply: true },
		evidenceRaceCli.client,
		{
			normalizeCategories: async () => new Map([["家電", ["家電"]]]),
			startPipelineRun: async () => fakeRun,
		},
	);
	assert.deepEqual(evidenceRaceResult.counts, { new: 2, updated: 0, duplicate: 5, failed: 0, processed: 1 }, "actual CLI counts an ignore-duplicate evidence race as duplicates, never new");

	const linkRaceCli = makeCliApplySupabase({ race: "source-link-winner" });
	const linkRaceResult = await runCliBackfill(
		{ since: "2026-08-01T00:00:00.000Z", limit: 1, apply: true },
		linkRaceCli.client,
		{
			normalizeCategories: async () => new Map([["家電", ["家電"]]]),
			startPipelineRun: async () => fakeRun,
		},
	);
	assert.deepEqual(linkRaceResult.counts, { new: 5, updated: 0, duplicate: 1, failed: 0, processed: 1 }, "actual CLI resolves a unique source-link race to the exact winner without counting reused links as updates");
	assert.ok(linkRaceCli.calls.includes("canonical_products:delete"), "a normal source-link race removes only the just-created orphan canonical");

	const restrictRaceCli = makeCliApplySupabase({ race: "source-link-restrict" });
	const restrictRaceResult = await runCliBackfill(
		{ since: "2026-08-01T00:00:00.000Z", limit: 1, apply: true },
		restrictRaceCli.client,
		{
			normalizeCategories: async () => new Map([["家電", ["家電"]]]),
			startPipelineRun: async () => fakeRun,
		},
	);
	assert.deepEqual(restrictRaceResult.counts, { new: 5, updated: 0, duplicate: 1, failed: 0, processed: 1 }, "actual CLI reuses the winning exact source link when RESTRICT protects shared identity");
	assert.ok(restrictRaceCli.calls.includes("canonical_products:delete"), "RESTRICT cleanup attempts only the locally-created canonical through the injected client");

	const resumedQueries: string[] = [];
	await runFoundationBackfill({
		args: { since: "2026-08-01T00:00:00.000Z", limit: 1, apply: false },
		cursor: runnerDry.nextCursor,
		fetchProducts: async () => { resumedQueries.push("products"); throw new Error("done source must not be queried"); },
		fetchBroadcasts: async (state) => {
			resumedQueries.push(`broadcasts:${state.position?.id}`);
			return { rows: [], exhausted: true, readCount: 0 };
		},
		loadCachedCategories: async () => new Map(),
		normalizeCategories: async () => new Map(),
		startPipelineRun: async () => fakeRun,
		writeProduct: async () => ({ new: 0, duplicate: 0 }),
		writeBroadcast: async () => ({ new: 0, duplicate: 0 }),
	});
	assert.deepEqual(resumedQueries, ["broadcasts:broadcast-1"], "an exhausted source is never queried again");

	const applyEvents: string[] = [];
	const applyRun: PipelineRunHandle = {
		id: "run-apply",
		heartbeat: async () => { applyEvents.push("heartbeat"); },
		succeed: async () => { applyEvents.push("succeed"); },
		partial: async () => { applyEvents.push("partial"); },
		fail: async () => { applyEvents.push("fail"); },
	};
	const applyResult = await runFoundationBackfill({
		args: { since: "2026-08-01T00:00:00.000Z", limit: 1, apply: true },
		cursor: initialBackfillCursor(),
		startPipelineRun: async () => { applyEvents.push("start"); return applyRun; },
		fetchProducts: async () => { applyEvents.push("products"); return { rows: [productRow], exhausted: true, readCount: 1 }; },
		fetchBroadcasts: async () => { applyEvents.push("broadcasts"); return { rows: [], exhausted: true, readCount: 0 }; },
		loadCachedCategories: async () => new Map(),
		normalizeCategories: async () => { applyEvents.push("normalize"); return new Map([["家電", ["家電"]]]); },
		writeProduct: async () => { applyEvents.push("write-product"); return { new: 2, duplicate: 3 }; },
		writeBroadcast: async () => ({ new: 0, duplicate: 0 }),
	});
	assert.ok(applyEvents.indexOf("start") < applyEvents.indexOf("products"), "apply creates the run before source queries");
	assert.ok(applyEvents.indexOf("heartbeat") < applyEvents.indexOf("write-product"), "observed page counts are heartbeated before writes");
	assert.deepEqual(applyEvents.slice(-1), ["succeed"]);
	assert.deepEqual(applyResult.counts, { new: 2, updated: 0, duplicate: 3, failed: 0, processed: 1 }, "reused links/evidence are duplicates, never labeled updates");

	const partialEvents: string[] = [];
	let partialCounts: unknown;
	const partialRun: PipelineRunHandle = {
		id: "run-partial",
		heartbeat: async () => { partialEvents.push("heartbeat"); },
		succeed: async () => { partialEvents.push("succeed"); },
		partial: async (counts) => { partialEvents.push("partial"); partialCounts = counts; },
		fail: async () => { partialEvents.push("fail"); },
	};
	await assert.rejects(() => runFoundationBackfill({
		args: { since: "2026-08-01T00:00:00.000Z", limit: 1, apply: true },
		cursor: initialBackfillCursor(),
		startPipelineRun: async () => partialRun,
		fetchProducts: async () => ({ rows: [productRow], exhausted: true, readCount: 1 }),
		fetchBroadcasts: async () => ({ rows: [broadcastRow], exhausted: true, readCount: 1 }),
		loadCachedCategories: async () => new Map(),
		normalizeCategories: async () => new Map([["家電", ["家電"]]]),
		writeProduct: async () => ({ new: 2, duplicate: 0 }),
		writeBroadcast: async () => { throw new Error("evidence write failed"); },
	}), /recorded as partial/);
	assert.ok(partialEvents.includes("partial"), "a post-write failure is terminally partial");
	assert.equal(partialEvents.includes("fail"), false, "a post-write failure is never mislabeled failed");
	assert.deepEqual(partialCounts, { new: 2, updated: 0, duplicate: 0, failed: 1, processed: 2 }, "partial settlement carries all observed counts");

	const failureEvents: string[] = [];
	const failureHeartbeats: Array<{ failed: number; processed: number }> = [];
	const failureRun: PipelineRunHandle = {
		id: "run-failure",
		heartbeat: async (counts) => {
			failureEvents.push("heartbeat");
			failureHeartbeats.push({ failed: counts?.failed ?? 0, processed: counts?.processed ?? 0 });
		},
		succeed: async () => { failureEvents.push("succeed"); },
		partial: async () => { failureEvents.push("partial"); },
		fail: async () => { failureEvents.push("fail"); },
	};
	await assert.rejects(() => runFoundationBackfill({
		args: { since: "2026-08-01T00:00:00.000Z", limit: 1, apply: true },
		cursor: initialBackfillCursor(),
		startPipelineRun: async () => { failureEvents.push("start"); return failureRun; },
		fetchProducts: async () => { failureEvents.push("products"); throw new Error("source unavailable"); },
		fetchBroadcasts: async () => ({ rows: [], exhausted: true, readCount: 7 }),
		loadCachedCategories: async () => new Map(),
		normalizeCategories: async () => new Map(),
		writeProduct: async () => ({ new: 0, duplicate: 0 }),
		writeBroadcast: async () => ({ new: 0, duplicate: 0 }),
	}), /recorded as failed/);
	assert.ok(failureEvents.indexOf("start") < failureEvents.indexOf("products"), "query failures have an already-created run to settle");
	assert.equal(failureEvents.includes("fail"), true, "a pre-write query failure settles as failed");
	assert.ok(
		failureHeartbeats.some((counts) => counts.processed === 7),
		"a failed peer query retains the successful bounded peer read count for audit telemetry",
	);

	const rejectedHeartbeatEvents: string[] = [];
	let rejectedHeartbeatCalls = 0;
	const rejectedHeartbeatRun: PipelineRunHandle = {
		id: "run-heartbeat-rejection",
		heartbeat: async () => {
			rejectedHeartbeatCalls += 1;
			rejectedHeartbeatEvents.push("heartbeat");
			if (rejectedHeartbeatCalls === 1) throw new Error("temporary recorder outage");
		},
		succeed: async () => { rejectedHeartbeatEvents.push("succeed"); },
		partial: async () => { rejectedHeartbeatEvents.push("partial"); },
		fail: async () => { rejectedHeartbeatEvents.push("fail"); },
	};
	await runFoundationBackfill({
		args: { since: "2026-08-01T00:00:00.000Z", limit: 1, apply: true },
		cursor: initialBackfillCursor(),
		startPipelineRun: async () => rejectedHeartbeatRun,
		fetchProducts: async () => ({ rows: [productRow], exhausted: true, readCount: 1 }),
		fetchBroadcasts: async () => ({ rows: [], exhausted: true, readCount: 0 }),
		loadCachedCategories: async () => new Map(),
		normalizeCategories: async () => new Map([["家電", ["家電"]]]),
		writeProduct: async () => { rejectedHeartbeatEvents.push("write-product"); return { new: 1, duplicate: 0 }; },
		writeBroadcast: async () => ({ new: 0, duplicate: 0 }),
	});
	assert.ok(rejectedHeartbeatEvents.includes("write-product"), "heartbeat telemetry rejection never blocks durable data work");
	assert.equal(rejectedHeartbeatEvents.includes("fail"), false, "heartbeat telemetry rejection never mislabels data work as failed");
	assert.deepEqual(rejectedHeartbeatEvents.slice(-1), ["succeed"], "the terminal success settlement still executes after heartbeat rejection");

	let successSettles = 0;
	const telemetryRun: PipelineRunHandle = {
		id: "run-telemetry",
		heartbeat: async () => undefined,
		succeed: async () => { successSettles += 1; throw new Error("recorder unavailable"); },
		partial: async () => { throw new Error("must not change successful data to partial"); },
		fail: async () => { throw new Error("must not change successful data to failed"); },
	};
	await assert.rejects(() => runFoundationBackfill({
		args: { since: "2026-08-01T00:00:00.000Z", limit: 1, apply: true },
		cursor: initialBackfillCursor(),
		startPipelineRun: async () => telemetryRun,
		fetchProducts: async () => ({ rows: [], exhausted: true, readCount: 0 }),
		fetchBroadcasts: async () => ({ rows: [], exhausted: true, readCount: 0 }),
		loadCachedCategories: async () => new Map(),
		normalizeCategories: async () => new Map(),
		writeProduct: async () => ({ new: 0, duplicate: 0 }),
		writeBroadcast: async () => ({ new: 0, duplicate: 0 }),
	}), /success telemetry settlement failed/);
	assert.equal(successSettles, 2, "the intended success settlement is retried once and never flipped to fail");

	const canonicalCalls: string[] = [];
	const raceResolution = await resolveExactCanonicalProduct({
		findExactSourceLink: async () => canonicalCalls.includes("link") ? { canonicalProductId: "winner" } : null,
		insertCanonical: async () => { canonicalCalls.push("canonical"); return "orphan"; },
		insertExactSourceLink: async () => { canonicalCalls.push("link"); throw new Error("duplicate key"); },
		deleteCanonical: async (id) => { canonicalCalls.push(`delete:${id}`); },
	}, productRow);
	assert.deepEqual(raceResolution, { canonicalProductId: "winner", canonicalCreated: false, sourceLinkDuplicate: true });
	assert.deepEqual(canonicalCalls, ["canonical", "link", "delete:orphan"], "a source-link race cleans up only its orphan canonical");

	let protectedLookupCount = 0;
	const protectedCleanupResolution = await resolveExactCanonicalProduct({
		findExactSourceLink: async () => {
			protectedLookupCount += 1;
			return protectedLookupCount === 1 ? null : { canonicalProductId: "winner-after-restrict" };
		},
		insertCanonical: async () => "shared-canonical",
		insertExactSourceLink: async () => { throw new Error("duplicate key"); },
		deleteCanonical: async () => {
			throw new Error("update violates RESTRICT foreign-key constraint: shared-canonical remains linked");
		},
	}, productRow);
	assert.deepEqual(
		protectedCleanupResolution,
		{ canonicalProductId: "winner-after-restrict", canonicalCreated: false, sourceLinkDuplicate: true },
		"a RESTRICT-protected locally-created canonical is never cascaded away while the exact winning link is reused",
	);

	await assert.rejects(() => resolveExactCanonicalProduct({
		findExactSourceLink: async () => null,
		insertCanonical: async () => "shared-no-winner",
		insertExactSourceLink: async () => { throw new Error("link validation failure"); },
		deleteCanonical: async () => {
			throw new Error("update violates RESTRICT foreign-key constraint: shared-no-winner remains linked");
		},
	}, productRow), /cleanup protected/);

	const cleanupCalls: string[] = [];
	await assert.rejects(() => resolveExactCanonicalProduct({
		findExactSourceLink: async () => null,
		insertCanonical: async () => "orphan-2",
		insertExactSourceLink: async () => { throw new Error("link validation failure"); },
		deleteCanonical: async (id) => { cleanupCalls.push(id); },
	}, productRow), /link validation failure/);
	assert.deepEqual(cleanupCalls, ["orphan-2"], "non-race source-link errors clean up their just-created canonical");
	await assert.rejects(() => resolveExactCanonicalProduct({
		findExactSourceLink: async () => null,
		insertCanonical: async () => "orphan-3",
		insertExactSourceLink: async () => { throw new Error("link validation failure"); },
		deleteCanonical: async () => { throw new Error("delete unavailable"); },
	}, productRow), /link validation failure; orphan canonical cleanup failed: delete unavailable/);

	console.log("PASS: intelligence foundation backfill");
}

verifyDryRun().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
