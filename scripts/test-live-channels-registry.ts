/**
 * Ping each LIVE_CHANNELS siteQuery for a 2xx/3xx response. Run before
 * deployment to confirm none of the configured platforms went dark.
 *
 * Usage: npx tsx scripts/test-live-channels-registry.ts
 *
 * Exit code: 0 if all reachable, 1 if any returned 4xx/5xx or network
 * error.
 */
import { LIVE_CHANNELS } from "@/lib/discovery/live-channels";

const TIMEOUT_MS = 10_000;

async function ping(siteQuery: string): Promise<{ ok: boolean; status: number | string }> {
	// Brave site:queries use the bare host; for ping we hit https://<host>/.
	const host = siteQuery.split("/")[0];
	const url = `https://${host}/`;
	try {
		const res = await fetch(url, {
			method: "GET",
			redirect: "follow",
			headers: {
				"User-Agent":
					"Mozilla/5.0 (registry-ping; +https://github.com/flowos-official/mediaworks)",
			},
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		return { ok: res.ok, status: res.status };
	} catch (err) {
		return {
			ok: false,
			status: err instanceof Error ? err.message : "unknown",
		};
	}
}

async function main() {
	let allOk = true;
	for (const ch of LIVE_CHANNELS) {
		const { ok, status } = await ping(ch.siteQuery);
		const flag = ok ? "OK" : "FAIL";
		console.log(`[${flag}] ${ch.slug.padEnd(28)} ${String(status).padEnd(8)} ${ch.siteQuery}`);
		if (!ok) allOk = false;
	}
	process.exit(allOk ? 0 : 1);
}

void main();
