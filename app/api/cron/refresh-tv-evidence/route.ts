import { type NextRequest, NextResponse } from "next/server";
import { computeTvEvidence } from "@/lib/discovery/tv-evidence";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 300;

const BATCH_SIZE = 50;
const STALE_DAYS = 7;
const MAX_ROWS_PER_RUN = 2000; // safety cap; full backlog will need ~5 runs

function verifyCronAuth(req: NextRequest): boolean {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true; // dev mode
	return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
	if (!verifyCronAuth(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const sb = getServiceClient();
	const cutoff = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString();

	// Find candidates whose evidence is null OR older than STALE_DAYS.
	// Index idx_discovered_products_tv_evidence_at handles this query.
	const { data: rows, error } = await sb
		.from("discovered_products")
		.select("id, name, category, price_jpy, tv_channel_source")
		.or(`tv_evidence_at.is.null,tv_evidence_at.lt.${cutoff}`)
		.limit(MAX_ROWS_PER_RUN);

	if (error) {
		console.error("[refresh-tv-evidence] query failed:", error.message);
		return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
	}

	const total = rows?.length ?? 0;
	let updated = 0;
	let failed = 0;
	const start = Date.now();

	for (let i = 0; i < total; i += BATCH_SIZE) {
		const chunk = rows!.slice(i, i + BATCH_SIZE);
		const evidences = await Promise.all(
			chunk.map(async (r) => {
				try {
					const tvChannels = r.tv_channel_source
						? r.tv_channel_source.split(",").map((s: string) => s.trim()).filter(Boolean)
						: undefined;
					const ev = await computeTvEvidence(sb, {
						name: r.name,
						category: r.category,
						price_jpy: r.price_jpy,
						tv_channels: tvChannels,
					});
					return { id: r.id, ev };
				} catch (err) {
					console.warn(`[refresh-tv-evidence] ${r.id} failed:`, err);
					return null;
				}
			}),
		);

		const updates = evidences.filter(
			(e): e is { id: string; ev: ReturnType<typeof computeTvEvidence> extends Promise<infer U> ? U : never } =>
				e !== null,
		);

		for (const u of updates) {
			const upd = await sb
				.from("discovered_products")
				.update({
					tv_evidence: u.ev,
					tv_evidence_at: new Date().toISOString(),
				})
				.eq("id", u.id);
			if (upd.error) {
				console.warn(`[refresh-tv-evidence] update ${u.id} failed:`, upd.error.message);
				failed += 1;
			} else {
				updated += 1;
			}
		}
	}

	const log = {
		event: "refresh-tv-evidence.summary",
		total,
		updated,
		failed,
		durationMs: Date.now() - start,
	};
	console.log(JSON.stringify(log));
	return NextResponse.json({ ok: true, ...log });
}
