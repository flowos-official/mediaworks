import { enrichShopchProducts } from "../lib/shopch-products/enrich";

function parseArgs(): {
	onlyDates: string[] | undefined;
	limit: number | null;
	concurrency: number;
} {
	const args = process.argv.slice(2);
	const get = (name: string) =>
		args.find((a) => a.startsWith(`--${name}=`))?.replace(`--${name}=`, "");
	const dates = get("dates");
	const limit = get("limit");
	const concurrency = parseInt(get("concurrency") ?? "3", 10);
	return {
		onlyDates: dates ? dates.split(",") : undefined,
		limit: limit ? parseInt(limit, 10) : null,
		concurrency: Number.isFinite(concurrency) ? concurrency : 3,
	};
}

async function main() {
	const { onlyDates, limit, concurrency } = parseArgs();
	console.log(
		`Shop Channel slot-JSON enrichment: dates=${onlyDates?.join(",") ?? "(all w/o product_ids)"}, limit=${limit ?? "∞"}, concurrency=${concurrency}\n`,
	);

	const r = await enrichShopchProducts({
		onlyDates,
		limit: limit ?? undefined,
		concurrency,
		onProgress: (msg) => console.log(`  ${msg}`),
	});

	console.log(
		`\nDone. slots=${r.slots_processed} products=${r.products_upserted} broadcasts=${r.broadcasts_updated} errors=${r.errors.length}`,
	);
	if (r.errors.length > 0) {
		console.log("\nErrors:");
		for (const e of r.errors.slice(0, 20)) console.log(`  ${e}`);
		if (r.errors.length > 20) console.log(`  ...and ${r.errors.length - 20} more`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
