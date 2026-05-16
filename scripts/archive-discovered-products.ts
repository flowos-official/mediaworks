import { archiveDiscoveredProducts } from "../lib/discovery/archive-worker";
import { checkFfmpegAvailable } from "../lib/archive/video-pipeline";

function parseArgs(): {
	limit: number | null;
	staleHours: number;
	includeVideo: boolean;
	videoQuality: "720p" | "source";
} {
	const args = process.argv.slice(2);
	const get = (name: string) =>
		args.find((a) => a.startsWith(`--${name}=`))?.replace(`--${name}=`, "");
	const limit = get("limit");
	const staleHours = parseInt(get("stale") ?? `${24 * 30}`, 10);
	const includeVideo = args.includes("--with-video");
	const q = get("quality");
	return {
		limit: limit ? parseInt(limit, 10) : null,
		staleHours: Number.isFinite(staleHours) ? staleHours : 24 * 30,
		includeVideo,
		videoQuality: q === "720p" ? "720p" : "source",
	};
}

async function main() {
	const { limit, staleHours, includeVideo, videoQuality } = parseArgs();

	if (includeVideo) {
		const ok = await checkFfmpegAvailable();
		if (!ok) {
			console.error("ffmpeg not on PATH. Install or omit --with-video.");
			process.exit(1);
		}
	}

	console.log(
		`Discovery archive: limit=${limit ?? "∞"}, stale>${staleHours}h, video=${
			includeVideo ? videoQuality : "skip"
		}\n`,
	);

	const r = await archiveDiscoveredProducts({
		limit: limit ?? undefined,
		staleHours,
		includeVideo,
		videoQuality,
		onProgress: (msg) => console.log(msg),
	});

	console.log(
		`\nDone. candidates=${r.candidates} complete=${r.completed} partial=${r.partial} failed=${r.failed}`,
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
