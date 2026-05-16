import { archiveQvcProducts } from "../lib/qvc-products/archive";
import { checkFfmpegAvailable } from "../lib/archive/video-pipeline";

function parseArgs(): {
	limit: number | null;
	staleHours: number;
	skipVideo: boolean;
	videoQuality: "720p" | "source";
} {
	const args = process.argv.slice(2);
	const get = (name: string) =>
		args.find((a) => a.startsWith(`--${name}=`))?.replace(`--${name}=`, "");
	const limit = get("limit");
	const staleHours = parseInt(get("stale") ?? `${24 * 30}`, 10);
	const skipVideo = args.includes("--skip-video");
	const q = get("quality");
	return {
		limit: limit ? parseInt(limit, 10) : null,
		staleHours: Number.isFinite(staleHours) ? staleHours : 24 * 30,
		skipVideo,
		videoQuality: q === "720p" ? "720p" : "source",
	};
}

async function main() {
	const { limit, staleHours, skipVideo, videoQuality } = parseArgs();

	if (!skipVideo) {
		const ok = await checkFfmpegAvailable();
		if (!ok) {
			console.error("ffmpeg not on PATH. Install it or pass --skip-video.");
			process.exit(1);
		}
	}

	console.log(
		`QVC archive: limit=${limit ?? "∞"}, stale>${staleHours}h, video=${
			skipVideo ? "skip" : videoQuality
		}\n`,
	);

	const result = await archiveQvcProducts({
		limit: limit ?? undefined,
		staleHours,
		skipVideo,
		videoQuality,
		onProgress: (msg) => console.log(msg),
	});

	console.log(
		`\nDone. candidates=${result.candidates} complete=${result.completed} partial=${result.partial} failed=${result.failed}`,
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
