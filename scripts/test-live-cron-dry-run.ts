/**
 * Run the live_commerce stage-1 pipeline (plan → pool → curate) without
 * touching the database. Prints the category/price distribution of the
 * curated candidates so you can verify the new prompts are steering
 * Gemini toward TikTok Shop JP categories.
 *
 * Usage: npx tsx scripts/test-live-cron-dry-run.ts
 */
import { runStage1 } from "@/lib/discovery/orchestrator";
import { DEFAULT_LEARNING_STATE } from "@/lib/discovery/types";

async function main() {
	console.log("Running runStage1('live_commerce') — no DB writes\n");
	const t0 = Date.now();
	const result = await runStage1(DEFAULT_LEARNING_STATE, 30, "live_commerce");
	const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

	console.log(`pool size:   ${result.poolSize}`);
	console.log(`iterations:  ${result.iterations}`);
	console.log(`candidates:  ${result.candidates.length}`);
	console.log(`elapsed:     ${elapsed}s\n`);

	const byChannel = new Map<string, number>();
	const byPriceBand = new Map<string, number>();
	const byCategory = new Map<string, number>();

	for (const c of result.candidates) {
		const ch = c.tvChannelSource ?? "(none)";
		byChannel.set(ch, (byChannel.get(ch) ?? 0) + 1);

		const cat = c.category ?? "(uncategorized)";
		byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);

		const p = c.priceJpy ?? 0;
		let band: string;
		if (p === 0) band = "unknown";
		else if (p < 1000) band = "<¥1k";
		else if (p < 5000) band = "¥1-5k";
		else if (p < 8000) band = "¥5-8k";
		else if (p < 12000) band = "¥8-12k";
		else band = "¥12k+";
		byPriceBand.set(band, (byPriceBand.get(band) ?? 0) + 1);
	}

	const printDist = (label: string, m: Map<string, number>) => {
		console.log(`\n${label}:`);
		const entries = [...m.entries()].sort((a, b) => b[1] - a[1]);
		for (const [k, v] of entries) {
			console.log(`  ${String(v).padStart(3)}  ${k}`);
		}
	};

	printDist("by tv_channel_source", byChannel);
	printDist("by price band", byPriceBand);
	printDist("by category (top entries)", byCategory);

	console.log(`\nplan keywords:`);
	console.log(`  tv_proven:   ${result.plan.tv_proven.join(", ")}`);
	console.log(`  exploration: ${result.plan.exploration.join(", ")}`);
}

void main();
