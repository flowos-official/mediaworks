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
import { classifyShopChSlots } from "../lib/broadcasts/shopch-category";
import type { ScrapedSlot } from "../lib/broadcasts/types";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const channelArg = [...args]
	.find((a) => a.startsWith("--channel="))
	?.slice("--channel=".length);
const onlyChannel: "qvc" | "shopch" | null =
	channelArg === "qvc" || channelArg === "shopch" ? channelArg : null;

const SHOPCH_BATCH_SIZE = 24;

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

	// Collect first product_ids and look up their category from qvc_products.
	const productIds = Array.from(
		new Set(
			(rows as { id: string; product_ids: string[] | null }[])
				.map((r) => r.product_ids?.[0])
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
		const firstId = r.product_ids?.[0];
		const category = firstId ? productCategory.get(firstId) : undefined;
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
	const { data: rows, error } = await sb
		.from("broadcasts")
		.select(
			"id, channel, air_date, start_time, program_title, presenter, description, thumbnail_url, source_url, product_ids",
		)
		.eq("channel", "shopch")
		.is("category", null);
	if (error || !rows) {
		console.error("[shopch] fetch rows failed:", error?.message);
		return { candidates: 0, updated: 0, skipped: 0 };
	}
	const candidates = rows.length;
	if (candidates === 0) return { candidates: 0, updated: 0, skipped: 0 };

	let updated = 0;
	let skipped = 0;
	// Process in chunks of 24 (matches typical daily slot count for Gemini batch sanity).
	for (let i = 0; i < rows.length; i += SHOPCH_BATCH_SIZE) {
		const chunk = (rows as Array<{ id: string } & ScrapedSlot>).slice(
			i,
			i + SHOPCH_BATCH_SIZE,
		);
		const classified = await classifyShopChSlots(
			chunk.map((r) => ({ ...r, category: null })),
		);
		for (let j = 0; j < chunk.length; j++) {
			const row = chunk[j];
			const result = classified[j];
			if (!result.category) {
				skipped += 1;
				continue;
			}
			if (dryRun) {
				updated += 1;
				continue;
			}
			const { error: upErr } = await sb
				.from("broadcasts")
				.update({ category: result.category })
				.eq("id", row.id);
			if (upErr) {
				console.warn(`[shopch] update ${row.id} failed:`, upErr.message);
				skipped += 1;
				continue;
			}
			updated += 1;
		}
		console.log(
			`[shopch] chunk ${Math.min(i + SHOPCH_BATCH_SIZE, rows.length)}/${rows.length} done — updated=${updated} skipped=${skipped}`,
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
