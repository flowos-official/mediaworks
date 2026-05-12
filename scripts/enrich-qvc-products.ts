import { enrichQvcProducts } from "../lib/qvc-products/enrich";

function parseArgs(): {
	staleHours: number;
	limit: number | null;
	concurrency: number;
	onlyDates: string[] | undefined;
} {
	const args = process.argv.slice(2);
	const get = (name: string) =>
		args.find((a) => a.startsWith(`--${name}=`))?.replace(`--${name}=`, "");
	const staleHours = parseInt(get("stale") ?? "24", 10);
	const limit = get("limit");
	const concurrency = parseInt(get("concurrency") ?? "3", 10);
	const dates = get("dates");
	return {
		staleHours: Number.isFinite(staleHours) ? staleHours : 24,
		limit: limit ? parseInt(limit, 10) : null,
		concurrency,
		onlyDates: dates ? dates.split(",") : undefined,
	};
}

async function main() {
	const { staleHours, limit, concurrency, onlyDates } = parseArgs();
	console.log(
		`QVC product enrichment: stale>${staleHours}h, limit=${limit ?? "∞"}, concurrency=${concurrency}${onlyDates ? `, dates=${onlyDates.join(",")}` : ""}\n`,
	);

	const result = await enrichQvcProducts({
		staleHours,
		limit: limit ?? undefined,
		concurrency,
		onlyDates,
		onProgress: (msg) => console.log(`  ${msg}`),
	});

	console.log(
		`\nDone. candidates=${result.candidates}, fetched=${result.fetched}, failed=${result.failed}`,
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
