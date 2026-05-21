/**
 * Backfill image_url for an OA channel's existing rows.
 *
 * Required flag: --channel=<slug> (one of: junsanpo, ntv, tbs, dinos, senobura, uranoura)
 * Optional:      --limit=N    (default: process all matching rows)
 *                --throttle=N (ms between requests; default 350)
 *                --concurrency=N (default 4 — within one channel, parallel rows)
 *
 * Reads rows where image_url IS NULL AND source_url IS NOT NULL.
 * For each row, calls the channel's image extractor and updates image_url.
 * Failures stay null — re-run to retry.
 *
 * Does NOT support txd (txd backfill is a re-run of scripts/backfill-txd.ts
 * after the parser patch lands).
 *
 * Spec: docs/superpowers/specs/2026-05-21-oa-channel-images-design.md §8
 */

import { createClient } from "@supabase/supabase-js";
import { IMAGE_EXTRACTORS, mapWithConcurrency, type ImageExtractor } from "../lib/historical-crawl/image-extractors";
import type { OAChannelSlug } from "../lib/historical-crawl/types";

const SUPPORTED_CHANNELS: readonly OAChannelSlug[] = [
	"junsanpo",
	"ntv",
	"tbs",
	"dinos",
	"senobura",
	"uranoura",
];

interface Args {
	channel: OAChannelSlug;
	limit: number | null;
	throttleMs: number;
	concurrency: number;
}

function parseArgs(): Args {
	const a = process.argv.slice(2);
	const get = (name: string): string | undefined => {
		const hit = a.find((x) => x.startsWith(`--${name}=`));
		return hit?.split("=", 2)[1];
	};
	const channel = get("channel");
	if (!channel || !SUPPORTED_CHANNELS.includes(channel as OAChannelSlug)) {
		console.error(`--channel=<slug> is required. Supported: ${SUPPORTED_CHANNELS.join(", ")}`);
		console.error("(txd backfill uses scripts/backfill-txd.ts, not this script.)");
		process.exit(2);
	}
	const limit = get("limit") ? parseInt(get("limit")!, 10) : null;
	const throttleMs = get("throttle") ? parseInt(get("throttle")!, 10) : 350;
	const concurrency = get("concurrency") ? parseInt(get("concurrency")!, 10) : 4;
	return { channel: channel as OAChannelSlug, limit, throttleMs, concurrency };
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

(async () => {
	const args = parseArgs();
	const extractor: ImageExtractor | null = IMAGE_EXTRACTORS[args.channel];
	if (!extractor) {
		console.error(`No extractor registered for channel ${args.channel}.`);
		process.exit(2);
	}

	const sb = createClient(
		process.env.NEXT_PUBLIC_SUPABASE_URL!,
		process.env.SUPABASE_SERVICE_ROLE_KEY!,
	);

	console.log(`Backfill — channel=${args.channel} concurrency=${args.concurrency} throttle=${args.throttleMs}ms${args.limit ? ` limit=${args.limit}` : ""}`);

	let query = sb
		.from("historical_broadcasts")
		.select("id, source_url")
		.eq("channel", args.channel)
		.is("image_url", null)
		.not("source_url", "is", null)
		.order("air_date", { ascending: false });
	if (args.limit) query = query.limit(args.limit);

	const { data, error } = await query;
	if (error) {
		console.error("SELECT failed:", error.message);
		process.exit(1);
	}
	const rows = (data ?? []) as Array<{ id: string; source_url: string }>;
	console.log(`Found ${rows.length} rows to enrich.\n`);

	if (rows.length === 0) {
		console.log("Nothing to do.");
		return;
	}

	let updated = 0;
	let failed = 0;
	const startedAt = Date.now();

	const CHUNK = args.concurrency;
	for (let i = 0; i < rows.length; i += CHUNK) {
		const chunk = rows.slice(i, i + CHUNK);
		const imageUrls = await mapWithConcurrency(chunk, CHUNK, async (row) => {
			try {
				return await extractor.extract(row.source_url);
			} catch {
				return null;
			}
		});
		for (let j = 0; j < chunk.length; j++) {
			const newUrl = imageUrls[j];
			if (!newUrl) { failed++; continue; }
			const { error: upErr } = await sb
				.from("historical_broadcasts")
				.update({ image_url: newUrl })
				.eq("id", chunk[j].id);
			if (upErr) { failed++; continue; }
			updated++;
		}

		if ((i + chunk.length) % 50 === 0 || i + chunk.length >= rows.length) {
			const pct = (((i + chunk.length) / rows.length) * 100).toFixed(1);
			const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
			console.log(`[${i + chunk.length}/${rows.length} ${pct}%]  updated=${updated}  failed=${failed}  elapsed=${elapsed}s`);
		}

		if (i + CHUNK < rows.length) await sleep(args.throttleMs);
	}

	const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
	console.log(`\n=== Summary ===`);
	console.log(`channel:   ${args.channel}`);
	console.log(`total:     ${rows.length}`);
	console.log(`updated:   ${updated}`);
	console.log(`failed:    ${failed} (image stayed NULL — re-run to retry)`);
	console.log(`elapsed:   ${elapsed}s`);
})();
