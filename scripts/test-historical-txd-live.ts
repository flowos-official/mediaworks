import { txdParser } from "../lib/historical-crawl/parsers/txd";

async function main() {
	const yesterday = new Date(Date.now() - 86_400_000);
	const jstDate = new Date(yesterday.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
	console.log(`Live txd fetch against ${jstDate} (no DB write)\n`);

	const rows = await txdParser.fetchToday(jstDate);
	console.log(`Returned ${rows.length} rows.`);
	if (rows.length === 0) {
		console.error("✗ Expected at least 1 row — site markup or API contract may have changed.");
		process.exit(1);
	}

	const sample = rows[0];
	console.log("Sample row:", JSON.stringify(sample, null, 2));

	if (sample.channel !== "txd") {
		console.error(`✗ Unexpected channel: ${sample.channel}`);
		process.exit(1);
	}
	if (sample.air_date !== jstDate) {
		console.error(`✗ Unexpected air_date: ${sample.air_date} (wanted ${jstDate})`);
		process.exit(1);
	}
	console.log("\n✓ Live txd fetch OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
