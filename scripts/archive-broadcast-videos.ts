import { archiveBroadcastVideos } from "../lib/broadcasts/video-archive";
import { checkFfmpegAvailable } from "../lib/archive/video-pipeline";

function parseArgs(): {
	limit: number | null;
	onlyDates: string[] | undefined;
	videoQuality: "720p" | "source";
} {
	const args = process.argv.slice(2);
	const get = (name: string) =>
		args.find((a) => a.startsWith(`--${name}=`))?.replace(`--${name}=`, "");
	const limit = get("limit");
	const dates = get("dates");
	const q = get("quality");
	return {
		limit: limit ? parseInt(limit, 10) : null,
		onlyDates: dates ? dates.split(",") : undefined,
		videoQuality: q === "720p" ? "720p" : "source",
	};
}

async function main() {
	const ok = await checkFfmpegAvailable();
	if (!ok) {
		console.error("ffmpeg not on PATH. Install it first.");
		process.exit(1);
	}

	const { limit, onlyDates, videoQuality } = parseArgs();
	console.log(
		`Shop Channel broadcast video archive: limit=${limit ?? 5} (default), dates=${onlyDates?.join(",") ?? "any pending"}, quality=${videoQuality}\n`,
	);

	const r = await archiveBroadcastVideos({
		limit: limit ?? undefined,
		onlyDates,
		videoQuality,
		onProgress: (msg) => console.log(msg),
	});

	console.log(
		`\nDone. candidates=${r.candidates} done=${r.done} failed=${r.failed} skipped=${r.skipped}`,
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
