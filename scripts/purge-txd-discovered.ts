/**
 * Guarded one-shot purge of legacy txd rows from discovered_products.
 * Mirrors supabase/migrations/2026-06-03_purge_txd_discovered_products.sql.
 * Run: npx tsx --env-file=.env.local scripts/purge-txd-discovered.ts
 *
 * Deletes discovered_products whose tv_channel_source contains the whole token
 * "txd" AND that have no non-closed product_selection. KEEPS historical_broadcasts.
 */
import { getServiceClient } from "../lib/supabase";

function hasTxdToken(v: string | null): boolean {
	return String(v ?? "").split(",").map((s) => s.trim()).includes("txd");
}

(async () => {
	const sb = getServiceClient();

	const { data: rows, error } = await sb
		.from("discovered_products")
		.select("id, tv_channel_source")
		.not("tv_channel_source", "is", null);
	if (error) throw new Error(error.message);

	const candidates = (rows ?? []).filter((r) => hasTxdToken(r.tv_channel_source as string | null));
	const ids = candidates.map((r) => (r as { id: string }).id);
	console.log(`txd candidates: ${ids.length}`);
	if (ids.length === 0) { console.log("nothing to purge"); process.exit(0); }

	// Guard: protect any product that has ANY product_selection (active OR closed).
	// Closed selections + their append-only events are retention history; deleting
	// the product would cascade them away. A guard-query FAILURE must abort — never
	// treat an errored/empty result as "nothing protected" (that would delete all).
	const { data: sels, error: selErr } = await sb
		.from("product_selections")
		.select("discovered_product_id")
		.in("discovered_product_id", ids);
	if (selErr) throw new Error("guard query failed, aborting purge: " + selErr.message);
	const protectedIds = new Set((sels ?? []).map((s) => s.discovered_product_id));
	const toDelete = ids.filter((id) => !protectedIds.has(id));
	console.log(`protected by selection history: ${protectedIds.size}; deleting: ${toDelete.length}`);

	for (let i = 0; i < toDelete.length; i += 100) {
		const batch = toDelete.slice(i, i + 100);
		const { error: delErr } = await sb.from("discovered_products").delete().in("id", batch);
		if (delErr) throw new Error(`delete batch ${i}: ${delErr.message}`);
	}

	// Verify
	const after = await sb
		.from("discovered_products")
		.select("id, tv_channel_source")
		.not("tv_channel_source", "is", null);
	const remaining = (after.data ?? []).filter((r) => hasTxdToken(r.tv_channel_source as string | null)).length;
	console.log(`remaining txd rows after purge: ${remaining}`);
	process.exit(0);
})();
