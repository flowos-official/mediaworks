import { scrapeQVCForDate } from "../lib/broadcasts/qvc";
import { scrapeShopChannelForDate } from "../lib/broadcasts/shopch";

async function main() {
	const yesterday = new Date(Date.now() - 86_400_000);
	const iso = yesterday.toISOString().slice(0, 10);
	console.log(`Live scrape test against ${iso} (no DB write)\n`);

	const [shopch, qvc] = await Promise.all([
		scrapeShopChannelForDate(yesterday),
		scrapeQVCForDate(yesterday),
	]);

	let failed = false;
	for (const r of [shopch, qvc]) {
		const ok = r.ok && r.slots.length >= 1;
		console.log(
			`${ok ? "✓" : "✗"} ${r.channel}: ok=${r.ok} slots=${r.slots.length}${r.error ? ` error=${r.error}` : ""}`,
		);
		if (!ok) failed = true;
	}

	if (failed) {
		console.error("\nLive scrape failed — site markup may have changed.");
		process.exit(1);
	}
	console.log("\nLive scrape OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
