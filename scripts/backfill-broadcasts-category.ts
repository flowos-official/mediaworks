/**
 * One-shot backfill: fill `broadcasts.category` for legacy rows that were
 * persisted before / between Phase 1-C policy changes.
 *
 * Strategy:
 *  - QVC: look up `qvc_products.category` by the slot's first product_id and
 *    UPDATE. Cheap, deterministic. Skipped products that haven't been
 *    enriched yet (qvc_products.category IS NULL) remain NULL — re-run
 *    after `npm run enrich:qvc-products` to fill them.
 *  - ShopCh: send all NULL-category slots' (program_title + description)
 *    to the existing Gemini batch classifier in chunks of 24
 *    (matches the daily crawl size). Writes back via UPDATE.
 *
 * Usage:
 *   tsx --env-file=.env.local scripts/backfill-broadcasts-category.ts
 *   tsx --env-file=.env.local scripts/backfill-broadcasts-category.ts --channel=qvc
 *   tsx --env-file=.env.local scripts/backfill-broadcasts-category.ts --dry-run
 */
import { getServiceClient } from "../lib/supabase";
import {
	buildProgramId,
	fetchShopChSlotMetadataBatch,
} from "../lib/broadcasts/shopch-json";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const channelArg = [...args]
	.find((a) => a.startsWith("--channel="))
	?.slice("--channel=".length);
const onlyChannel: "qvc" | "shopch" | null =
	channelArg === "qvc" || channelArg === "shopch" ? channelArg : null;

const SHOPCH_BATCH_SIZE = 60;

async function backfillQVC(): Promise<{
	candidates: number;
	updated: number;
	skipped: number;
}> {
	const sb = getServiceClient();
	// Pull every QVC row where category is null and at least one product_id exists.
	const { data: rows, error } = await sb
		.from("broadcasts")
		.select("id, product_ids")
		.eq("channel", "qvc")
		.is("category", null)
		.not("product_ids", "is", null);
	if (error || !rows) {
		console.error("[qvc] fetch rows failed:", error?.message);
		return { candidates: 0, updated: 0, skipped: 0 };
	}
	const candidates = rows.length;
	if (candidates === 0) return { candidates: 0, updated: 0, skipped: 0 };

	// Collect ALL product_ids (not just the lead one) and look up their category
	// from qvc_products. QVC's lead product is often unenriched while a later
	// product carries the category, so scanning all ids recovers slots the
	// first-only lookup would skip.
	const productIds = Array.from(
		new Set(
			(rows as { id: string; product_ids: string[] | null }[])
				.flatMap((r) => r.product_ids ?? [])
				.filter((p): p is string => typeof p === "string"),
		),
	);

	const { data: products } = await sb
		.from("qvc_products")
		.select("id, category")
		.in("id", productIds);
	const productCategory = new Map<string, string>();
	for (const p of (products ?? []) as { id: string; category: string | null }[]) {
		if (p.category) productCategory.set(p.id, p.category);
	}

	let updated = 0;
	let skipped = 0;
	for (const r of rows as { id: string; product_ids: string[] | null }[]) {
		// First product (in slot order) that has a known category.
		const category = (r.product_ids ?? [])
			.map((pid) => productCategory.get(pid))
			.find((c): c is string => typeof c === "string");
		if (!category) {
			skipped += 1;
			continue;
		}
		if (dryRun) {
			updated += 1;
			continue;
		}
		const { error: upErr } = await sb
			.from("broadcasts")
			.update({ category })
			.eq("id", r.id);
		if (upErr) {
			console.warn(`[qvc] update ${r.id} failed:`, upErr.message);
			skipped += 1;
			continue;
		}
		updated += 1;
	}
	return { candidates, updated, skipped };
}

async function backfillShopCh(): Promise<{
	candidates: number;
	updated: number;
	skipped: number;
}> {
	const sb = getServiceClient();
	// Migration 2026-05-19: source of truth switched from Gemini to the site's
	// own JSON endpoint. Backfill therefore rewrites EVERY ShopCh row (not
	// just NULL-category ones) because previously-classified rows may carry
	// the Gemini-assigned value that disagrees with the site (observed 24%
	// disagreement). Also populates product_ids from prodList1.
	// PostgREST caps an unbounded select at 1000 rows, which silently limited
	// this rewrite to a third of the ShopCh history. Page to exhaustion.
	const rows: unknown[] = [];
	for (let from = 0; ; from += 1000) {
		const { data, error } = await sb
			.from("broadcasts")
			.select("id, air_date, start_time, category, product_ids")
			.eq("channel", "shopch")
			.order("id", { ascending: true })
			.range(from, from + 999);
		if (error) {
			console.error("[shopch] fetch rows failed:", error.message);
			return { candidates: 0, updated: 0, skipped: 0 };
		}
		rows.push(...(data ?? []));
		if (!data || data.length < 1000) break;
	}
	const typedRows = rows as Array<{
		id: string;
		air_date: string;
		start_time: string;
		category: string | null;
		product_ids: string[] | null;
	}>;
	const candidates = typedRows.length;
	if (candidates === 0) return { candidates: 0, updated: 0, skipped: 0 };

	let updated = 0;
	let skipped = 0;
	for (let i = 0; i < typedRows.length; i += SHOPCH_BATCH_SIZE) {
		const chunk = typedRows.slice(i, i + SHOPCH_BATCH_SIZE);
		const pidByRow = new Map(
			chunk.map((r) => [r.id, buildProgramId(r.air_date, r.start_time)]),
		);
		const metaByPid = await fetchShopChSlotMetadataBatch(
			[...pidByRow.values()],
		);
		for (const row of chunk) {
			const pid = pidByRow.get(row.id)!;
			const meta = metaByPid.get(pid);
			if (!meta || meta.category === null) {
				// JSON unreachable for this slot (transient ~15% rate). Leave the
				// row as-is — next monthly refresh retries.
				skipped += 1;
				continue;
			}
			const newProductIds =
				meta.productIds.length > 0 ? meta.productIds : row.product_ids;
			const noChange =
				meta.category === row.category &&
				JSON.stringify(newProductIds) === JSON.stringify(row.product_ids);
			if (noChange) continue;
			if (dryRun) {
				updated += 1;
				continue;
			}
			const { error: upErr } = await sb
				.from("broadcasts")
				.update({ category: meta.category, product_ids: newProductIds })
				.eq("id", row.id);
			if (upErr) {
				console.warn(`[shopch] update ${row.id} failed:`, upErr.message);
				skipped += 1;
				continue;
			}
			updated += 1;
		}
		console.log(
			`[shopch] chunk ${Math.min(i + SHOPCH_BATCH_SIZE, typedRows.length)}/${typedRows.length} done — updated=${updated} skipped=${skipped}`,
		);
	}
	return { candidates, updated, skipped };
}

(async () => {
	console.log(
		`backfill-broadcasts-category${dryRun ? " (dry-run)" : ""}${onlyChannel ? ` --channel=${onlyChannel}` : ""}`,
	);

	if (onlyChannel === null || onlyChannel === "qvc") {
		console.log("\n=== QVC ===");
		const r = await backfillQVC();
		console.log(r);
	}
	if (onlyChannel === null || onlyChannel === "shopch") {
		console.log("\n=== ShopCh ===");
		const r = await backfillShopCh();
		console.log(r);
	}
})();
