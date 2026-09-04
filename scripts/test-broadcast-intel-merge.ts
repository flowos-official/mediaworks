import assert from "node:assert/strict";
import { mergeChunkAnalyses, type AnalysisChunkResult } from "../lib/broadcast-intel/merge-chunks";
import type { BroadcastAnalysis } from "../lib/broadcast-intel/schema";

function analysis(over: {
	acts?: Array<{ startSec: number; endSec: number; actType: BroadcastAnalysis["patterns"]["segments"][number]["actType"]; summaryJa?: string }>;
	transcript?: Array<{ startSec: number; endSec: number; textJa: string }>;
	sellingPoints?: Array<{ pointType: BroadcastAnalysis["patterns"]["sellingPoints"][number]["pointType"]; firstMentionedSec: number; repeatCount: number }>;
	evidence?: Array<{ type: BroadcastAnalysis["patterns"]["evidenceCues"][number]["type"]; atSec: number }>;
	objections?: Array<{ objectionType: BroadcastAnalysis["patterns"]["objectionHandlings"][number]["objectionType"]; atSec: number }>;
	firstPriceSec?: number | null;
	ctaSecs?: number[];
	urgencyCues?: string[];
}): BroadcastAnalysis {
	const acts = over.acts ?? [];
	return {
		patterns: {
			segments: acts.map(({ startSec, endSec, actType }) => ({ startSec, endSec, actType })),
			sellingPoints: (over.sellingPoints ?? []).map((sp, i) => ({ order: i + 1, ...sp })),
			evidenceCues: over.evidence ?? [],
			objectionHandlings: over.objections ?? [],
			offerTimeline: { firstPriceSec: over.firstPriceSec ?? null, ctaSecs: over.ctaSecs ?? [] },
		},
		verbatim: {
			transcript: (over.transcript ?? []).map((t) => ({ ...t, speakerHint: null })),
			actSummaries: acts.map((a) => ({ ...a, summaryJa: a.summaryJa ?? "" })),
			urgencyCues: over.urgencyCues ?? [],
		},
	};
}

const chunk = (offsetSec: number, durationSec: number, a: BroadcastAnalysis): AnalysisChunkResult => ({
	offsetSec,
	durationSec,
	analysis: a,
});

// --- offsets ---------------------------------------------------------------
// Every timecode a chunk reports is relative to its own start. The whole point
// of merging is that the caller never has to trust the model with that sum.
{
	const merged = mergeChunkAnalyses(
		[
			chunk(0, 100, analysis({
				acts: [{ startSec: 0, endSec: 100, actType: "opening" }],
				transcript: [{ startSec: 10, endSec: 20, textJa: "A" }],
				evidence: [{ type: "demo", atSec: 30 }],
				objections: [{ objectionType: "price", atSec: 40 }],
				ctaSecs: [50],
			})),
			chunk(100, 100, analysis({
				acts: [{ startSec: 0, endSec: 100, actType: "offer" }],
				transcript: [{ startSec: 10, endSec: 20, textJa: "B" }],
				evidence: [{ type: "comparison", atSec: 30 }],
				objections: [{ objectionType: "doubt_efficacy", atSec: 40 }],
				ctaSecs: [50],
			})),
		],
		200,
	);
	assert.deepEqual(merged.verbatim.transcript.map((t) => [t.startSec, t.endSec, t.textJa]), [
		[10, 20, "A"],
		[110, 120, "B"],
	]);
	assert.deepEqual(merged.patterns.evidenceCues.map((e) => e.atSec), [30, 130]);
	assert.deepEqual(merged.patterns.objectionHandlings.map((o) => o.atSec), [40, 140]);
	assert.deepEqual(merged.patterns.offerTimeline.ctaSecs, [50, 150]);
	assert.deepEqual(merged.patterns.segments.map((s) => [s.startSec, s.endSec, s.actType]), [
		[0, 100, "opening"],
		[100, 200, "offer"],
	]);
}
console.log("✓ chunk-relative timecodes are shifted onto the programme timeline");

// --- seam coalescing -------------------------------------------------------
// A demo running across the seam is one act the split broke in two; a demo
// that stops and restarts inside a chunk is two acts that really happened.
{
	const merged = mergeChunkAnalyses(
		[
			chunk(0, 100, analysis({ acts: [{ startSec: 0, endSec: 100, actType: "demo", summaryJa: "前半" }] })),
			chunk(100, 100, analysis({ acts: [{ startSec: 0, endSec: 100, actType: "demo", summaryJa: "後半" }] })),
		],
		200,
	);
	assert.equal(merged.patterns.segments.length, 1, "an act split by the seam is rejoined");
	assert.deepEqual(merged.patterns.segments[0], { startSec: 0, endSec: 200, actType: "demo" });
	assert.equal(merged.verbatim.actSummaries[0]!.summaryJa, "前半 後半", "no summary is dropped");
}
{
	const merged = mergeChunkAnalyses(
		[
			chunk(0, 200, analysis({
				acts: [
					{ startSec: 0, endSec: 50, actType: "demo" },
					{ startSec: 50, endSec: 120, actType: "evidence" },
					{ startSec: 120, endSec: 200, actType: "demo" },
				],
			})),
			chunk(200, 100, analysis({ acts: [{ startSec: 0, endSec: 100, actType: "demo" }] })),
		],
		300,
	);
	// The two in-chunk demos are separated by `evidence` and stay separate; the
	// demo touching the 200s seam absorbs the next chunk's opening demo.
	assert.deepEqual(merged.patterns.segments.map((s) => [s.startSec, s.endSec, s.actType]), [
		[0, 50, "demo"],
		[50, 120, "evidence"],
		[120, 300, "demo"],
	]);
}
console.log("✓ only acts meeting at a seam are rejoined; repeats inside a chunk survive");

// A seam boundary the model reports a shade early must still count as a seam.
{
	const merged = mergeChunkAnalyses(
		[
			chunk(0, 100, analysis({ acts: [{ startSec: 0, endSec: 98.5, actType: "demo" }] })),
			chunk(100, 100, analysis({ acts: [{ startSec: 0, endSec: 100, actType: "demo" }] })),
		],
		200,
	);
	assert.equal(merged.patterns.segments.length, 1, "a near-seam boundary is still a seam");
}
console.log("✓ seam matching tolerates the model rounding a boundary");

// --- selling points --------------------------------------------------------
// A point raised in three chunks was raised three times; its position in the
// programme is the earliest chunk that raised it.
{
	const merged = mergeChunkAnalyses(
		[
			chunk(0, 100, analysis({ sellingPoints: [{ pointType: "efficacy", firstMentionedSec: 80, repeatCount: 2 }] })),
			chunk(100, 100, analysis({
				sellingPoints: [
					{ pointType: "efficacy", firstMentionedSec: 10, repeatCount: 3 },
					{ pointType: "price_value", firstMentionedSec: 5, repeatCount: 1 },
				],
			})),
		],
		200,
	);
	assert.deepEqual(
		merged.patterns.sellingPoints.map((s) => [s.order, s.pointType, s.firstMentionedSec, s.repeatCount]),
		[
			[1, "efficacy", 80, 5],
			[2, "price_value", 105, 1],
		],
	);
}
console.log("✓ selling points sum their repeats and keep the earliest mention");

// --- offer timeline --------------------------------------------------------
// A price restated in every chunk is one offer, not five.
{
	const merged = mergeChunkAnalyses(
		[
			chunk(0, 100, analysis({ firstPriceSec: null, ctaSecs: [90] })),
			chunk(100, 100, analysis({ firstPriceSec: 20, ctaSecs: [50] })),
			chunk(200, 100, analysis({ firstPriceSec: 10, ctaSecs: [] })),
		],
		300,
	);
	assert.equal(merged.patterns.offerTimeline.firstPriceSec, 120, "earliest price across the programme");
	assert.deepEqual(merged.patterns.offerTimeline.ctaSecs, [90, 150]);
}
{
	const merged = mergeChunkAnalyses([chunk(0, 100, analysis({ firstPriceSec: null }))], 100);
	assert.equal(merged.patterns.offerTimeline.firstPriceSec, null, "no price stays unknown, never 0");
}
console.log("✓ offer timeline keeps the first price and drops duplicate CTAs");

// --- bounds ----------------------------------------------------------------
// The model can overrun its chunk by a second; nothing may land past the
// programme runtime, because parseAnalysisResponse's own range check would
// have dropped it.
{
	const merged = mergeChunkAnalyses(
		[chunk(100, 100, analysis({
			acts: [{ startSec: 0, endSec: 105, actType: "closing" }],
			transcript: [{ startSec: 99, endSec: 110, textJa: "tail" }],
		}))],
		200,
	);
	assert.equal(merged.patterns.segments[0]!.endSec, 200);
	assert.equal(merged.verbatim.transcript[0]!.endSec, 200);
}
console.log("✓ merged timecodes stay inside the programme runtime");

// --- invariants ------------------------------------------------------------
{
	const merged = mergeChunkAnalyses(
		[
			chunk(100, 100, analysis({ acts: [{ startSec: 0, endSec: 100, actType: "offer" }], urgencyCues: ["今だけ"] })),
			chunk(0, 100, analysis({ acts: [{ startSec: 0, endSec: 100, actType: "opening" }], urgencyCues: ["今だけ", "残りわずか"] })),
		],
		200,
	);
	// Chunks arriving out of order must not produce an out-of-order programme.
	assert.deepEqual(merged.patterns.segments.map((s) => s.actType), ["opening", "offer"]);
	assert.deepEqual(merged.verbatim.urgencyCues, ["今だけ", "残りわずか"], "urgency cues dedupe");
	// persist.ts writes these to two different tables; they must not disagree.
	assert.deepEqual(
		merged.patterns.segments,
		merged.verbatim.actSummaries.map(({ startSec, endSec, actType }) => ({ startSec, endSec, actType })),
	);
}
console.log("✓ merge is order-independent and the two act views stay in lockstep");

assert.throws(() => mergeChunkAnalyses([], 100), /empty chunk list/);
console.log("✓ an empty merge is an error, not an empty analysis");


async function main() {
	// --- chunk prompt ----------------------------------------------------------
	// A chunk that is not told it is a chunk reads its own last second as the end
	// of the programme. That would put a `closing` act at every seam.
	{
		const { buildAnalysisPrompt } = await import("../lib/broadcast-intel/gemini-analyze");

		const whole = buildAnalysisPrompt(3600);
		assert.ok(!whole.includes("第 1 部"), "an unchunked call keeps its original framing");
		assert.ok(whole.includes("3600 秒"));

		const first = buildAnalysisPrompt(1500, { index: 1, total: 3 });
		assert.ok(first.includes("第 1 部（全 3 部）"));
		assert.ok(first.includes("closing と判断しないこと"), "a non-final chunk must not close the programme");
		assert.ok(!first.includes("opening と判断しないこと"), "the first chunk really is the opening");
		assert.ok(first.includes("この抜粋の先頭を 0 とする"), "timecodes stay chunk-relative");

		const middle = buildAnalysisPrompt(1500, { index: 2, total: 3 });
		assert.ok(middle.includes("closing と判断しないこと"));
		assert.ok(middle.includes("opening と判断しないこと"), "a middle chunk is neither end");

		const last = buildAnalysisPrompt(600, { index: 3, total: 3 });
		assert.ok(last.includes("この抜粋の末尾が番組の終わりである"));
		assert.ok(!last.includes("closing と判断しないこと"));
		assert.ok(last.includes("600 秒"), "the last chunk is told its own short length");
	}
	console.log("✓ chunk prompts tell the model which end of the programme it is holding");

	// --- splitAudio ------------------------------------------------------------
	// Exercised against real ffmpeg output, because the failure this guards is a
	// container detail: ADTS has no index, so a wrong muxer choice yields one file
	// or unplayable pieces rather than a clean error.
	{
		const { splitAudio } = await import("../lib/broadcast-intel/audio-extract");
		const { spawn } = await import("node:child_process");
		const ffmpeg = (await import("@ffmpeg-installer/ffmpeg")).default;

		const tone = await new Promise<Buffer>((resolve, reject) => {
			const proc = spawn(ffmpeg.path, [
				"-hide_banner", "-loglevel", "error",
				"-f", "lavfi", "-i", "sine=frequency=440:duration=10",
				"-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "32k", "-f", "adts", "pipe:1",
			]);
			const out: Buffer[] = [];
			proc.stdout.on("data", (c: Buffer) => out.push(c));
			proc.on("error", reject);
			proc.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}`))));
		});
		assert.ok(tone.length > 0, "fixture bug: no audio was generated");

		const single = await splitAudio(tone, 10, 30);
		assert.equal(single.length, 1, "audio shorter than a chunk is not split");
		assert.equal(single[0]!.audio, tone, "and is passed through untouched, not re-encoded");

		const parts = await splitAudio(tone, 10, 4);
		assert.equal(parts.length, 3, "10s at 4s per chunk is three pieces");
		assert.deepEqual(parts.map((p) => p.offsetSec), [0, 4, 8]);
		assert.deepEqual(parts.map((p) => p.durationSec), [4, 4, 2], "the tail reports its real length, not the nominal one");
		for (const p of parts) assert.ok(p.audio.length > 0, "every chunk carries audio");
		// Offsets must tile the runtime with no gap and no overlap; a merged
		// timeline is built entirely out of them.
		assert.equal(
			parts.reduce((sum, p) => sum + p.durationSec, 0),
			10,
			"chunk durations reconstruct the runtime exactly",
		);

		await assert.rejects(() => splitAudio(tone, 10, 0), /chunkSec must be positive/);
	}
	console.log("✓ splitAudio tiles the runtime and leaves short audio alone");

	console.log("PASS: broadcast-intel merge + chunking");
}

main();
