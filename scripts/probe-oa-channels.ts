// Live end-to-end test: crawl + persist all 8 channels for today.
import { crawlAll } from "../lib/historical-crawl";

(async () => {
	const result = await crawlAll();
	console.log("\n=== crawl summary ===");
	console.log("date:", result.jstDate);
	console.log("totalRows:", result.totalRows);
	console.log("persist:", result.persist);
	console.log("\nper-channel:");
	for (const r of result.results) {
		console.log(
			"  " + r.channel.padEnd(10) + " ok=" + r.ok + "  rows=" + r.rows.length + "  ms=" + r.durationMs +
			(r.error ? "  err=" + r.error : ""),
		);
	}
})();
