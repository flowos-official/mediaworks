import { scrapeAllForDate } from "../lib/broadcasts";
import { sleep } from "../lib/broadcasts/fetch";

function parseArgs(): { days: number } {
	const arg = process.argv.find((a) => a.startsWith("--days="));
	const days = arg ? parseInt(arg.replace("--days=", ""), 10) : 7;
	if (!Number.isFinite(days) || days < 1 || days > 60) {
		console.error("--days must be 1..60");
		process.exit(1);
	}
	return { days };
}

async function main() {
	const { days } = parseArgs();
	console.log(`Backfilling last ${days} days...`);

	const today = new Date();
	for (let i = 1; i <= days; i++) {
		const d = new Date(today);
		d.setDate(d.getDate() - i);
		const iso = d.toISOString().slice(0, 10);
		console.log(`\n--- ${iso} ---`);

		const summary = await scrapeAllForDate(d);
		for (const r of summary.results) {
			console.log(
				`  ${r.channel}: ok=${r.ok} slots=${r.slots.length}${r.error ? ` error=${r.error}` : ""}`,
			);
		}
		console.log(
			`  → inserted=${summary.totalInserted} updated=${summary.totalUpdated} errors=${summary.totalErrors}`,
		);

		if (i < days) await sleep(1000); // 정중함: 날짜 간 1초
	}

	console.log("\nBackfill complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
