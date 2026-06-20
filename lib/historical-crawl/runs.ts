import { type SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "@/lib/supabase";

export interface PerChannelRunEntry {
	channel: string;
	ok: boolean;
	rowCount: number;
	durationMs: number;
	error?: string;
}

export type RunStatus = "running" | "completed" | "partial" | "failed";

/**
 * Insert a row with status='running' and return its id.
 * The cron path uses the service client (non-user-initiated).
 */
export async function startRun(jstDate: string): Promise<string> {
	const sb = getServiceClient();
	const { data, error } = await sb
		.from("historical_crawl_runs")
		.insert({ jst_date: jstDate, status: "running" as RunStatus })
		.select("id")
		.single();
	if (error || !data) {
		throw new Error(`startRun failed: ${error?.message ?? "unknown"}`);
	}
	return data.id as string;
}

export interface FinalizeRunInput {
	runId: string;
	status: RunStatus;
	totalRows: number;
	upserted: number;
	skippedDup: number;
	channels: PerChannelRunEntry[];
	durationMs: number;
	error?: string;
}

/**
 * Update the run row with final counts. Best-effort: a logging failure
 * must not propagate and break the cron itself.
 */
export async function finalizeRun(input: FinalizeRunInput): Promise<void> {
	const sb = getServiceClient();
	const { error } = await sb
		.from("historical_crawl_runs")
		.update({
			status: input.status,
			total_rows: input.totalRows,
			upserted: input.upserted,
			skipped_dup: input.skippedDup,
			channels: input.channels,
			duration_ms: input.durationMs,
			error: input.error ?? null,
			completed_at: new Date().toISOString(),
		})
		.eq("id", input.runId);
	if (error) {
		console.warn("[historical-crawl-runs] finalizeRun failed:", error.message);
	}
}

export interface ChannelBaseline {
	channel: string;
	median7d: number;
	samples: number;
}

/**
 * Median row count per channel over the most recent `lookbackDays` of
 * completed/partial runs. Used by the admin UI to flag anomalies
 * (current run row count < 50% of median).
 *
 * Accepts an optional pre-bound Supabase client so the user-route caller can
 * pass `auth.sb` (server client, RLS-respecting) instead of constructing a
 * service client. Defaults to service client for cron usage.
 */
export async function loadBaseline(
	lookbackDays = 7,
	client?: SupabaseClient,
): Promise<ChannelBaseline[]> {
	const sb = client ?? getServiceClient();
	const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
		.toISOString();
	const { data, error } = await sb
		.from("historical_crawl_runs")
		.select("channels")
		.gte("run_at", cutoff)
		.in("status", ["completed", "partial"]);
	if (error || !data) return [];

	const byChannel = new Map<string, number[]>();
	for (const row of data) {
		const channels = (row as { channels: PerChannelRunEntry[] }).channels ?? [];
		for (const c of channels) {
			const arr = byChannel.get(c.channel) ?? [];
			arr.push(c.rowCount);
			byChannel.set(c.channel, arr);
		}
	}

	const out: ChannelBaseline[] = [];
	for (const [channel, counts] of byChannel) {
		const sorted = [...counts].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		const median =
			sorted.length % 2 === 0
				? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
				: sorted[mid];
		out.push({ channel, median7d: median, samples: sorted.length });
	}
	return out;
}

/**
 * The `channels` snapshot of the most recent `limit` runs (newest first). Used
 * by the silent-zero alert to detect a channel that's returned 0 rows for N
 * consecutive runs — the blind spot the median-based undercapture check can't
 * see (a brand-new parser has no median; a quietly-empty source throws no error).
 */
export async function loadRecentRunChannels(
	limit: number,
	client?: SupabaseClient,
): Promise<{ channels: PerChannelRunEntry[] }[]> {
	const sb = client ?? getServiceClient();
	const { data, error } = await sb
		.from("historical_crawl_runs")
		.select("channels")
		.order("run_at", { ascending: false })
		.limit(limit);
	if (error || !data) return [];
	return data.map((r) => ({
		channels: (r as { channels: PerChannelRunEntry[] }).channels ?? [],
	}));
}
