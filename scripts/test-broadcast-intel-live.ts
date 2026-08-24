/**
 * One real broadcast, end to end: S3 → ffmpeg → Gemini → both tables.
 * Usage: npm run test:broadcast-intel-live
 */
import { getServiceClient } from "@/lib/supabase";
import { analyzeOne, type QueuedAnalysisSlot } from "@/lib/broadcast-intel/analyze-one";
import { loadCategoryPattern } from "@/lib/broadcast-intel/category-pattern";

const CATEGORY = process.env.BROADCAST_INTEL_CATEGORY || "家電";

async function main(): Promise<void> {
	const sb = getServiceClient();

	const { data, error } = await sb
		.from("broadcasts")
		.select("id, channel, air_date, category, archived_video_s3, analysis_attempts")
		.not("archived_video_s3", "is", null)
		.eq("category", CATEGORY)
		.neq("analysis_status", "done")
		.order("air_date", { ascending: false })
		.limit(1);
	if (error) throw new Error(error.message);

	const slot = (data ?? [])[0] as QueuedAnalysisSlot | undefined;
	if (!slot) throw new Error(`no archived ${CATEGORY} slot available`);

	console.log(`[live] slot ${slot.id} ${slot.channel} ${slot.air_date}`);
	await sb.from("broadcasts").update({ analysis_status: "queued" }).eq("id", slot.id);

	const started = Date.now();
	const result = await analyzeOne(slot);
	const secs = Math.round((Date.now() - started) / 1000);
	console.log(`[live] ${result.status} in ${secs}s`, result.error ?? "");
	if (result.status !== "done") throw new Error(`analysis did not complete: ${result.error}`);

	const { data: analysis } = await sb
		.from("broadcast_speech_analyses")
		.select("duration_sec, segments, selling_points, evidence_cues, objection_handlings, offer_timeline")
		.eq("broadcast_id", slot.id).single();
	const { data: transcript } = await sb
		.from("broadcast_transcripts")
		.select("segments, act_summaries").eq("broadcast_id", slot.id).single();

	if (!analysis) throw new Error("no analysis row written");
	if (!transcript) throw new Error("no transcript row written");

	const a = analysis as { duration_sec: number; segments: unknown[]; selling_points: unknown[]; evidence_cues: unknown[] };
	const t = transcript as { segments: unknown[]; act_summaries: unknown[] };
	console.log(`  duration_sec   ${a.duration_sec}`);
	console.log(`  segments       ${a.segments.length}`);
	console.log(`  selling_points ${a.selling_points.length}`);
	console.log(`  transcript     ${t.segments.length} lines`);

	// The runtime bug this design was rewritten around: a probe-window value
	// would land near 25-50s regardless of the real programme length.
	if (a.duration_sec < 300) {
		throw new Error(`duration_sec=${a.duration_sec} looks like a probe window, not a programme runtime`);
	}
	if (a.segments.length === 0) throw new Error("no acts were segmented");

	// The transcript row existing is not enough: `transcript` on the Gemini
	// response is built independently of `segments`, so a row can be present
	// with zero lines — the corpus's entire evidentiary value, silently empty.
	if (t.segments.length === 0) {
		throw new Error("broadcast_transcripts row exists but has zero segments — the verbatim transcript came back empty");
	}

	// No verbatim text may have reached the member-readable row.
	const dump = JSON.stringify(analysis);
	if (/[ぁ-んァ-ヶ一-龯]/.test(dump)) {
		throw new Error(`analysis row contains Japanese text — a free-text field leaked: ${dump.slice(0, 200)}`);
	}

	const pattern = await loadCategoryPattern(CATEGORY);
	console.log(`  aggregate      ${pattern ? `${pattern.sampleSize} samples` : "null (under the floor)"}`);

	console.log("\nPASS: broadcast-intel live");
}

main();
