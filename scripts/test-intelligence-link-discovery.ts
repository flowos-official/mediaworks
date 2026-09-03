/**
 * `product_source_links` used to be written only by the manual CLI backfill,
 * while the readiness denominator is the newest discovery session — which the
 * nightly cron replaces. Canonical-link and category coverage were therefore
 * structurally 0% until an operator remembered to run a script.
 *
 * These cover the stage that closes that gap, and the two properties that make
 * it safe to put in a production cron: it never throws at the caller, and it
 * stops at the budget the cron gives it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { linkDiscoverySessionProducts } from "../lib/intelligence/link-discovery-products";

interface Row {
	id: string;
	name: string | null;
	source: string | null;
	tv_channel_source: string | null;
	category?: string | null;
}

function client(
	rows: Row[],
	overrides: { onLinkInsert?: () => void; categoryCache?: Record<string, string> } = {},
) {
	const categoryCache = overrides.categoryCache ?? {};
	const links = new Map<string, string>();
	const canonicals: string[] = [];
	const canonicalPayloads: Array<Record<string, unknown>> = [];
	const evidence: Array<Record<string, unknown>> = [];

	return {
		links,
		canonicals,
		canonicalPayloads,
		evidence,
		from(table: string) {
			const builder: Record<string, unknown> = {};
			const self = () => builder;
			Object.assign(builder, {
				select: self,
				eq: self,
				is: self,
				// The evidence upsert resolves every draft's id with a follow-up
				// `.in("dedupe_key", ...)`, including the ones it treated as
				// duplicates. The category cache is read the same way.
				in: (_column: string, keys: string[]) => {
					if (table === "evidence_items") {
						return Promise.resolve({
							data: keys.map((key, index) => ({ id: `evidence-${index + 1}`, dedupe_key: key })),
							error: null,
						});
					}
					if (table === "discovered_category_normalization") {
						return Promise.resolve({
							data: keys
								.filter((key) => key in categoryCache)
								.map((key) => ({ raw_category: key, whitelist_categories: [categoryCache[key]] })),
							error: null,
						});
					}
					return builder;
				},
				order: () => (table === "discovered_products"
					? Promise.resolve({
						data: rows.map((row) => ({
							...row,
							category: row.category ?? null,
							price_jpy: 1000,
							review_count: 3,
							product_url: `https://example.test/${row.id}`,
							tv_evidence: null,
							tv_evidence_at: null,
							created_at: "2026-08-29T00:00:00+00:00",
						})),
						error: null,
					})
					: builder),
				maybeSingle: async () => {
					if (table !== "product_source_links") return { data: null, error: null };
					return { data: null, error: null };
				},
				insert(payload: Record<string, unknown>) {
					if (table === "canonical_products") {
						const id = `canonical-${canonicals.length + 1}`;
						canonicals.push(id);
						canonicalPayloads.push(payload);
						return { select: () => ({ single: async () => ({ data: { id }, error: null }) }) };
					}
					if (table === "product_source_links") {
						overrides.onLinkInsert?.();
						links.set(String(payload.source_record_id), String(payload.canonical_product_id));
						return Promise.resolve({ error: null });
					}
					return Promise.resolve({ error: null });
				},
				upsert(payload: Array<Record<string, unknown>>) {
					evidence.push(...payload);
					return {
						select: async () => ({
							data: payload.map((row, index) => ({ id: `evidence-${evidence.length - payload.length + index + 1}`, dedupe_key: row.dedupe_key })),
							error: null,
						}),
					};
				},
				delete: () => ({ eq: async () => ({ error: null }) }),
				update: () => builder,
			});
			return builder;
		},
	};
}

async function main(): Promise<void> {
	{
		const sb = client([
			{ id: "p-1", name: "テスト商品", source: "tv_channel", tv_channel_source: "qvc", category: "家電" },
			{ id: "p-2", name: "対象外", source: "rakuten", tv_channel_source: null },
			{ id: "p-3", name: null, source: "tv_channel", tv_channel_source: "qvc" },
			// txd is excluded by operator policy (EXCLUDED_DISCOVERY_SLUGS) and its rows
			// were purged. kachimo used to stand here and no longer works as a
			// negative case: it is a real discovery source that the connected set was
			// wrongly dropping, which is what this change fixed.
			{ id: "p-4", name: "除外チャネル", source: "tv_channel", tv_channel_source: "txd" },
		]);
		const result = await linkDiscoverySessionProducts(sb as never, "session-1");
		assert.equal(result.considered, 4);
		assert.equal(result.linked, 1, "only an eligible, named, connected-source row is linked");
		assert.equal(result.skipped, 3, "a non-TV source, a nameless row and an excluded channel are skipped, not failed");
		assert.equal(result.failed, 0);
		assert.deepEqual([...sb.links.keys()], ["p-1"]);
		assert.ok(sb.evidence.length > 0, "linking also captures the row's evidence");
	}

	{
		// `normalized_category` must never receive a raw value. 114 of the 135
		// canonical rows were normalized against the whitelist by the CLI; mixing
		// unnormalized values in would make coverage read as satisfied while the
		// stored values are wrong.
		const cached = client(
			[{ id: "p-1", name: "A", source: "tv_channel", tv_channel_source: "qvc", category: "生活家電" }],
			{ categoryCache: { "生活家電": "家電" } },
		);
		const cachedResult = await linkDiscoverySessionProducts(cached as never, "session-cat-1");
		assert.equal(cachedResult.linked, 1);
		assert.equal(cachedResult.categoryUnresolved, 0);
		assert.equal(
			cached.canonicalPayloads[0]?.normalized_category,
			"家電",
			"a cached raw category is stored as its whitelist category",
		);

		const uncached = client([
			{ id: "p-1", name: "A", source: "tv_channel", tv_channel_source: "qvc", category: "謎ジャンル" },
		]);
		const uncachedResult = await linkDiscoverySessionProducts(uncached as never, "session-cat-2");
		assert.equal(uncachedResult.linked, 1, "an unknown category never blocks identity resolution");
		assert.equal(uncachedResult.categoryUnresolved, 1);
		assert.equal(
			uncached.canonicalPayloads[0]?.normalized_category,
			null,
			"an uncached category stores null, not the raw value — repairCanonicalCategory fills it in later",
		);
	}

	{
		// A cron stage that throws takes the night's candidates with it. Per-row
		// failures are counted and stepped over instead.
		const sb = client(
			[
				{ id: "p-1", name: "A", source: "tv_channel", tv_channel_source: "qvc" },
				{ id: "p-2", name: "B", source: "tv_channel", tv_channel_source: "qvc" },
			],
			{ onLinkInsert: () => { throw new Error("link insert unavailable"); } },
		);
		const result = await linkDiscoverySessionProducts(sb as never, "session-2");
		assert.equal(result.considered, 2);
		assert.equal(result.failed, 2, "every row failed, and the caller still got a result");
		assert.equal(result.linked, 0);
	}

	{
		// The cron owns the clock; an exhausted budget stops the stage rather
		// than eating into save/finalize.
		const sb = client([
			{ id: "p-1", name: "A", source: "tv_channel", tv_channel_source: "qvc" },
			{ id: "p-2", name: "B", source: "tv_channel", tv_channel_source: "qvc" },
		]);
		const result = await linkDiscoverySessionProducts(sb as never, "session-3", {
			deadlineAtMs: 1_000,
			now: () => 2_000,
		});
		assert.equal(result.considered, 0, "an already-exhausted budget does no work at all");
		assert.equal(sb.links.size, 0);
	}

	{
		const sb = {
			from: () => ({
				select: () => ({ eq: () => ({ order: async () => ({ data: null, error: { message: "read unavailable" } }) }) }),
			}),
		};
		await assert.rejects(
			() => linkDiscoverySessionProducts(sb as never, "session-4"),
			/discovery session products read failed: read unavailable/,
			"a failure to read the session is surfaced so the optional stage can record it",
		);
	}

	for (const route of ["daily-discovery-home", "daily-discovery-live"]) {
		const source = readFileSync(new URL(`../app/api/cron/${route}/route.ts`, import.meta.url), "utf8");
		assert.match(source, /linkDiscoverySessionProducts/, `${route} must link the session it just produced`);
		assert.match(
			source,
			/runOptionalStage\(\{[\s\S]*?canonical-link/,
			`${route} must run canonical linking as an optional stage so its failure cannot cost the night's candidates`,
		);
	}

	console.log("PASS: discovery session canonical linking");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
