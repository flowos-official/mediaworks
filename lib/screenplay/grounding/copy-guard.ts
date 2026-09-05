/**
 * Did we write their script?
 *
 * Reference broadcasts are supposed to contribute structure — when the demo
 * runs, when the price lands, which objections get answered. The failure mode
 * is that a model handed structural guidance about a competitor's programme
 * reproduces their phrasing, and nothing downstream would notice: the copy
 * reads well, passes compliance, and is somebody else's.
 *
 * The comparison is LOCAL and one-directional. broadcast_transcripts is
 * admin-only verbatim competitor text and is read here, in memory, purely to
 * ask whether our own output contains a long run of it. It never reaches a
 * prompt, an API response or the UI — what gets reported is the offending
 * passage OF OUR SCRIPT, which the operator is already looking at, plus which
 * broadcast it collided with.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Long enough that a collision is not coincidence. Japanese has no word
 *  spacing, so this is roughly a sentence and a half — two independently
 *  written scripts do not share one. */
export const MIN_OVERLAP_CHARS = 30;

export interface ReferencePhrase {
	analysisId: string;
	broadcastId: string;
	text: string;
}

export interface CopyOverlap {
	analysisId: string;
	broadcastId: string;
	/** The run as it appears in OUR script, unnormalised. */
	phrase: string;
	length: number;
	lineStart: number;
	lineEnd: number;
}

/** Offer language that is near-identical everywhere by convention, and notices
 *  that are identical by law. A collision here is not copying. */
const BOILERPLATE: readonly string[] = [
	"個人差があります",
	"効果効能を保証するものではありません",
	"数量限定のため、なくなり次第終了となります",
	"送料無料でお届けします",
	"お電話またはインターネットからご注文ください",
];

/**
 * NFKC, then strip everything that is presentation rather than words: speaker
 * labels, markdown syntax, stage directions in brackets, punctuation and all
 * whitespace. Two scripts that say the same thing with different formatting
 * must normalise to the same string, or the guard is trivially defeated by a
 * line break.
 */
export function normaliseForOverlap(text: string): string {
	return text
		.normalize("NFKC")
		.replace(/[（(][^）)]*[）)]/g, "")
		.replace(/[【\[][^】\]]*[】\]]/g, "")
		.replace(/^\s*[#>\-*|]+/gm, "")
		.replace(/^\s*[^\s:：]{1,12}[:：]/gm, "")
		.replace(/[\s　]+/g, "")
		.replace(/[、。！？!?,.…・「」『』"'”“‘’~〜ー―—\-—_/\\|]/g, "");
}

/** Per-character map from the normalised script back to its source line. */
function normaliseWithLineMap(markdown: string): { text: string; lines: number[] } {
	const out: string[] = [];
	const lines: number[] = [];
	const sourceLines = markdown.split("\n");
	for (let i = 0; i < sourceLines.length; i++) {
		const normalised = normaliseForOverlap(sourceLines[i]);
		if (!normalised) continue;
		out.push(normalised);
		for (let c = 0; c < normalised.length; c++) lines.push(i + 1);
	}
	return { text: out.join(""), lines };
}

function excludedRanges(normalisedScript: string, exclusions: readonly string[]): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	for (const raw of exclusions) {
		const needle = normaliseForOverlap(raw);
		if (needle.length < 4) continue;
		let from = 0;
		for (;;) {
			const at = normalisedScript.indexOf(needle, from);
			if (at === -1) break;
			ranges.push([at, at + needle.length]);
			from = at + 1;
		}
	}
	return ranges;
}

/**
 * Every run of MIN_OVERLAP_CHARS or more that our script shares with a
 * reference. Overlapping hits from one reference are merged so a 200-character
 * lift is reported once rather than 170 times.
 */
export function findReferencePhraseOverlap(
	markdown: string,
	referencePhrases: readonly ReferencePhrase[],
	exclusions: readonly string[] = [],
): CopyOverlap[] {
	const script = normaliseWithLineMap(markdown);
	if (script.text.length < MIN_OVERLAP_CHARS) return [];
	const skip = excludedRanges(script.text, [...exclusions, ...BOILERPLATE]);
	const isExcluded = (start: number, end: number): boolean =>
		skip.some(([from, to]) => start >= from && end <= to);

	const overlaps: CopyOverlap[] = [];
	for (const reference of referencePhrases) {
		const normalised = normaliseForOverlap(reference.text);
		if (normalised.length < MIN_OVERLAP_CHARS) continue;
		const grams = new Set<string>();
		for (let i = 0; i + MIN_OVERLAP_CHARS <= normalised.length; i++) {
			grams.add(normalised.slice(i, i + MIN_OVERLAP_CHARS));
		}

		let runStart = -1;
		for (let i = 0; i + MIN_OVERLAP_CHARS <= script.text.length; i++) {
			const hit = grams.has(script.text.slice(i, i + MIN_OVERLAP_CHARS));
			if (hit && runStart === -1) runStart = i;
			if (!hit && runStart !== -1) {
				pushRun(runStart, i - 1 + MIN_OVERLAP_CHARS);
				runStart = -1;
			}
		}
		if (runStart !== -1) pushRun(runStart, script.text.length);

		function pushRun(start: number, end: number): void {
			if (isExcluded(start, end)) return;
			overlaps.push({
				analysisId: reference.analysisId,
				broadcastId: reference.broadcastId,
				phrase: script.text.slice(start, end),
				length: end - start,
				lineStart: script.lines[start] ?? 1,
				lineEnd: script.lines[end - 1] ?? script.lines[start] ?? 1,
			});
		}
	}

	return overlaps.sort((a, b) => b.length - a.length);
}

/**
 * Verbatim text for the referenced analyses. Reads the admin-only table and
 * returns it to the caller in memory only — see the file header. The rows are
 * keyed on broadcast_id, which is also the analysis id.
 */
export async function loadReferencePhrases(
	sb: SupabaseClient,
	analysisIds: readonly string[],
): Promise<ReferencePhrase[]> {
	if (analysisIds.length === 0) return [];
	const { data, error } = await sb
		.from("broadcast_transcripts")
		.select("broadcast_id, segments")
		.in("broadcast_id", [...analysisIds]);
	if (error) {
		// Non-fatal: the guard is a check on our output, not a precondition for
		// having produced it. A version that could not be checked says so.
		console.warn("[screenplay] copy guard could not read reference phrases:", error.message);
		return [];
	}
	return (data ?? []).flatMap((row) => {
		const segments = (row.segments ?? []) as Array<{ textJa?: string }>;
		const text = segments.map((s) => s.textJa ?? "").join("");
		return text ? [{ analysisId: String(row.broadcast_id), broadcastId: String(row.broadcast_id), text }] : [];
	});
}
