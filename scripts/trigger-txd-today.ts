import { txdParser } from "../lib/historical-crawl/parsers/txd";
import { persistRows } from "../lib/historical-crawl/persist";
import { jstToday } from "../lib/historical-crawl/types";

(async () => {
	const date = jstToday();
	console.log(`Fetching txd for JST ${date} ...`);
	const t0 = Date.now();
	const rows = await txdParser.fetchToday(date);
	console.log(`Fetched ${rows.length} rows in ${Date.now() - t0}ms`);

	if (rows.length === 0) {
		console.error("No rows to persist.");
		process.exit(1);
	}

	console.log(`Persisting to historical_broadcasts ...`);
	const outcome = await persistRows(rows);
	console.log("Persist outcome:", outcome);
	console.log("\nSample row:", JSON.stringify(rows[0], null, 2));
})();
