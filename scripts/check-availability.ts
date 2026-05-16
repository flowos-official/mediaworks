import { checkAvailability } from "../lib/discovery/availability-check";

function parseArgs(): { limit: number | null; concurrency: number } {
	const args = process.argv.slice(2);
	const get = (name: string) =>
		args.find((a) => a.startsWith(`--${name}=`))?.replace(`--${name}=`, "");
	const limit = get("limit");
	const concurrency = parseInt(get("concurrency") ?? "6", 10);
	return {
		limit: limit ? parseInt(limit, 10) : null,
		concurrency: Number.isFinite(concurrency) ? concurrency : 6,
	};
}

async function main() {
	const { limit, concurrency } = parseArgs();
	console.log(`Availability check: limit=${limit ?? 500}, concurrency=${concurrency}\n`);

	const r = await checkAvailability({
		limit: limit ?? undefined,
		concurrency,
		onProgress: (msg) => console.log(`  ${msg}`),
	});

	console.log(
		`\nDone. checked=${r.checked} available=${r.available} gone=${r.gone} errors=${r.errors} snapshots=${r.snapshots_added}`,
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
