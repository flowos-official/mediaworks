/**
 * Mono audio → structured broadcast analysis via Gemini.
 *
 * The prompt asks only for structure and a transcript. It never asks the model
 * to judge, rank or rewrite the competitor's copy — the corpus is evidence.
 *
 * Output budget matters: 25 minutes of timecoded Japanese transcript is
 * 15k-30k output tokens. Without an explicit cap the response truncates,
 * JSON.parse throws, and the retry re-downloads 606 MB for nothing. A
 * MAX_TOKENS finish is therefore non-retryable.
 *
 * Slot ceiling: the whole leg (file upload, PROCESSING poll, and both
 * callModel attempts together) is bounded by a `deadline` the caller passes
 * in — analyzeOne computes ONE deadline from BROADCAST_INTEL_SLOT_TIMEOUT_MS
 * and threads it through both this module and audio-extract.ts's ffmpeg
 * SIGKILL, so the two legs share a single budget instead of each getting
 * their own (which would let a pathological slot run 2x SLOT_TIMEOUT_MS
 * before either side notices). Without a deadline at all, callModel had no
 * timeout: a slow/hung Gemini response could push a slot past the cron's
 * maxDuration, stranding the row in 'running' until the next daily
 * recoverStaleAnalysis() call (up to ~24h) instead of the rare exception it
 * should be.
 *
 * @google/genai's `config.abortSignal` is wired through to the underlying
 * fetch for `generateContent` and `files.get` (verified against
 * node_modules/@google/genai/dist/node/index.cjs), so callModel gets a real
 * per-attempt AbortController. `files.upload`'s resumable byte-upload loop
 * does NOT forward `config.abortSignal` at all (same file — neither
 * `fetchUploadUrl` nor `uploadBlobInternal` receives it), so the upload step
 * is bounded with Promise.race instead: our own await settles at the
 * deadline even though the abandoned upload keeps running server-side
 * (Gemini expires unreferenced files in 48h regardless).
 *
 * A deadline timeout is retryable, not NonRetryableAudioError — it is
 * indistinguishable from any other transient failure to isRetryable() and to
 * analyzeOne(), which already treats every non-NonRetryableAudioError as
 * retryable. Its message deliberately does not match the
 * overloaded/UNAVAILABLE fallback trigger below, so a Flash-call timeout does
 * not spend a second full-length attempt against GEMINI_PRO_FALLBACK — it
 * just requeues.
 *
 * NO `import "server-only"` — imported by tsx smoke scripts.
 */
import { GoogleGenAI, createPartFromUri, createUserContent, ApiError } from "@google/genai";
import { GEMINI_FLASH, GEMINI_PRO_FALLBACK } from "@/lib/gemini-models";
import { AUDIO_MIME, NonRetryableAudioError, SLOT_TIMEOUT_MS } from "./audio-extract";
import { ANALYSIS_RESPONSE_SCHEMA, parseAnalysisResponse, type BroadcastAnalysis } from "./schema";
import type { AnalysisErrorCode } from "./error-codes";

export const MAX_OUTPUT_TOKENS = 32768;

let _genAI: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
	if (!_genAI) _genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
	return _genAI;
}

/** The runtime is measured by ffmpeg before this call, but was not being told
 *  to the model — and both probe runs stopped analysing at 77-80% of the file
 *  and labelled that point `closing`, silently dropping the tail (on a 59-min
 *  ShopCh programme that meant losing the closing CTA, the single most useful
 *  timing a script writer wants). Stating the exact length and demanding the
 *  last act reach it gives the model something to check itself against. */
export function buildAnalysisPrompt(durationSec: number): string {
	const mm = Math.floor(durationSec / 60);
	const ss = String(Math.round(durationSec % 60)).padStart(2, "0");
	return [
		`この音声の長さは正確に ${durationSec} 秒（${mm}分${ss}秒）です。`,
		`最後の act は ${durationSec} 秒で終わらなければならない。`,
		`途中で終了と判断しないこと。${durationSec} 秒の直前まで発話が続いている。`,
		"",
		ANALYSIS_PROMPT,
	].join("\n");
}

export const ANALYSIS_PROMPT = [
	"これは日本のテレビショッピング番組の音声です。",
	"番組の構成と話法を、後の統計処理のために構造化データとして書き出してください。",
	"",
	"- transcript: 発話をタイムコード付きで文字起こしする。要約や言い換えをしない。",
	"- segments: 番組全体を act_type で区切る。全区間を隙間なく覆うこと。",
	"- selling_points: 販売ポイントを提示された順に並べ、初出秒と反復回数を記録する。",
	"- evidence_cues: 主張の裏づけとして提示された手段と、その時刻。",
	"- objection_handlings: 視聴者の懸念に応えた箇所と、その懸念の型。",
	"- offer_timeline: 価格が最初に提示された秒、CTA の各時刻、緊急性を煽る表現。",
	"",
	"推測で埋めないこと。音声に無いものは配列を空にする。",
	"すべての秒数は番組先頭からの経過秒とする。",
].join("\n");

const UPLOAD_POLL_INTERVAL_MS = 2_000;
const UPLOAD_TIMEOUT_MS = 120_000;

/** Thrown when a Gemini sub-step (upload, PROCESSING poll, or a callModel
 *  attempt) outruns the shared slot deadline. Deliberately a plain Error
 *  subclass, not NonRetryableAudioError — isRetryable() and analyzeOne() both
 *  already treat an unrecognized Error as retryable, exactly like a transient
 *  5xx: the slot goes back to 'queued' and consumes one attempt. */
export class GeminiTimeoutError extends Error {
	constructor(stage: string) {
		super(`Gemini ${stage} exceeded the ${SLOT_TIMEOUT_MS}ms slot deadline`);
		this.name = "GeminiTimeoutError";
	}
}

/**
 * Races `factory()` against the time remaining to the shared `deadline`.
 * Fails fast without starting the call if the deadline has already passed —
 * this is what turns "Flash timed out" into "skip Pro, don't spend a second
 * full-length call." Clears the timer in `finally` so no handle leaks past
 * whichever branch settles first. `onTimeout` lets the caller additionally
 * abort the real in-flight request when the SDK honors it (see callModel).
 */
async function withDeadline<T>(
	deadline: number,
	stage: string,
	factory: () => Promise<T>,
	onTimeout?: () => void,
): Promise<T> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) {
		onTimeout?.();
		throw new GeminiTimeoutError(stage);
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	const attempt = factory();
	// If the timer wins, `attempt` is abandoned but may still settle later
	// (e.g. once abort() finally propagates through fetch). Swallow that here
	// so a late rejection can't surface as an unhandled rejection — Promise.race
	// below observes `attempt` directly, so this doesn't change its outcome.
	attempt.catch(() => {});
	try {
		return await Promise.race([
			attempt,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					onTimeout?.();
					reject(new GeminiTimeoutError(stage));
				}, remaining);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * What one analysis actually consumed.
 *
 * The response carried this all along and it was being discarded, so the only
 * way to price a bulk drain was to model it — audio seconds times an assumed
 * tokens-per-second, output characters times an assumed tokens-per-character.
 * Both assumptions are plausible and neither was ever checked against a bill.
 * Logging the real numbers turns a 2,445-slot run into its own measurement.
 */
export interface AnalysisUsage {
	model: string;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

export function usageFromResponse(
	model: string,
	usage: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined,
): AnalysisUsage | null {
	if (!usage) return null;
	const inputTokens = Number(usage.promptTokenCount ?? 0);
	const outputTokens = Number(usage.candidatesTokenCount ?? 0);
	if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
	return {
		model,
		inputTokens,
		outputTokens,
		totalTokens: Number(usage.totalTokenCount ?? inputTokens + outputTokens),
	};
}

async function callModel(
	model: string,
	fileUri: string,
	fileMime: string,
	durationSec: number,
	abortSignal: AbortSignal,
): Promise<BroadcastAnalysis> {
	const response = await getGenAI().models.generateContent({
		model,
		contents: createUserContent([
			createPartFromUri(fileUri, fileMime),
			buildAnalysisPrompt(durationSec),
		]),
		config: {
			responseMimeType: "application/json",
			responseSchema: ANALYSIS_RESPONSE_SCHEMA,
			maxOutputTokens: MAX_OUTPUT_TOKENS,
			abortSignal,
		},
	});

	const finish = response.candidates?.[0]?.finishReason;
	if (finish === "MAX_TOKENS") {
		throw new NonRetryableAudioError(
			`analysis exceeded ${MAX_OUTPUT_TOKENS} output tokens; the transcript is too long for one call`,
		);
	}
	const usage = usageFromResponse(model, response.usageMetadata);
	if (usage) {
		// One line per call, greppable, so a drain can be priced from its own log
		// rather than from a model of it.
		console.log(`[broadcast-intel] usage ${JSON.stringify({ ...usage, durationSec })}`);
	}

	const text = response.text;
	if (!text) throw new Error("Gemini returned an empty analysis");
	return parseAnalysisResponse(JSON.parse(text), durationSec);
}

function isRetryable(err: unknown): boolean {
	if (err instanceof NonRetryableAudioError) return false;
	if (err instanceof ApiError) {
		return [408, 429, 500, 502, 503, 504].includes(err.status);
	}
	const m = err instanceof Error ? err.message : String(err);
	return /overloaded|UNAVAILABLE/i.test(m);
}

/**
 * Maps a thrown error from this module (and the parsing it drives in
 * schema.ts) to a DB-safe code. `SyntaxError` is the money check here — it is
 * exactly what `JSON.parse(text)` throws in callModel() when Gemini returns
 * prose instead of JSON, and its message embeds a snippet of that raw text.
 * We classify on the error's TYPE, never its content, so no snippet of it
 * ever reaches this function's return value. Returns null for anything not
 * recognized as this module's own throw sites.
 */
export function classifyGeminiError(e: unknown): AnalysisErrorCode | null {
	if (e instanceof SyntaxError) return "parse_failed"; // JSON.parse(text) in callModel
	if (e instanceof GeminiTimeoutError) return "gemini_timeout";
	// MAX_TOKENS truncation: raised as NonRetryableAudioError, but it is this
	// module's throw site, not audio-extract.ts's — the response was too long
	// to ever parse, so group it with parse_failed.
	if (e instanceof NonRetryableAudioError && e.message.includes("output tokens")) return "parse_failed";
	if (e instanceof ApiError) return "gemini_error";
	if (e instanceof Error) {
		// schema.ts's shape-validation throw: "broadcast-intel: <field> must be an array".
		if (e.message.startsWith("broadcast-intel:")) return "parse_failed";
		if (e.message === "Gemini returned an empty analysis") return "gemini_error";
		if (e.message === "Gemini file upload stuck in PROCESSING") return "gemini_error";
		if (e.message === "Gemini file upload failed") return "gemini_error";
	}
	return null;
}

/**
 * `deadline` is an absolute Date.now()-scale timestamp shared with
 * extractAudio (see audio-extract.ts) — analyzeOne computes it once so the
 * ffmpeg leg and this Gemini leg share a single SLOT_TIMEOUT_MS budget
 * instead of each getting their own. Defaults to a fresh SLOT_TIMEOUT_MS-out
 * deadline so this stays callable standalone (tests, the live smoke script).
 */
export async function analyzeAudio(
	audio: Buffer,
	durationSec: number,
	deadline: number = Date.now() + SLOT_TIMEOUT_MS,
): Promise<{ analysis: BroadcastAnalysis; model: string }> {
	const ai = getGenAI();
	let fileName: string | null = null;

	try {
		let file = await withDeadline(deadline, "file upload", () =>
			ai.files.upload({
				file: new Blob([new Uint8Array(audio)], { type: AUDIO_MIME }),
				config: { mimeType: AUDIO_MIME },
			}),
		);
		fileName = file.name ?? null;

		// A part referencing a non-ACTIVE file is rejected, so poll until settled.
		// withDeadline() below also enforces the shared slot deadline on every
		// GET, so this loop cannot outlive it even when UPLOAD_TIMEOUT_MS alone
		// would not have caught a slow-to-settle file.
		const uploadPollDeadline = Date.now() + UPLOAD_TIMEOUT_MS;
		while (file.state === "PROCESSING") {
			if (Date.now() > uploadPollDeadline) throw new Error("Gemini file upload stuck in PROCESSING");
			await new Promise((r) => setTimeout(r, UPLOAD_POLL_INTERVAL_MS));
			file = await withDeadline(deadline, "file processing poll", () => ai.files.get({ name: file.name! }));
			fileName = file.name ?? fileName;
		}
		if (file.state === "FAILED") throw new Error("Gemini file upload failed");

		try {
			const flashController = new AbortController();
			return {
				analysis: await withDeadline(
					deadline,
					"analysis (flash)",
					() => callModel(GEMINI_FLASH, file.uri!, file.mimeType!, durationSec, flashController.signal),
					() => flashController.abort(),
				),
				model: GEMINI_FLASH,
			};
		} catch (err) {
			if (!isRetryable(err)) throw err;
			const proController = new AbortController();
			return {
				analysis: await withDeadline(
					deadline,
					"analysis (pro fallback)",
					() => callModel(GEMINI_PRO_FALLBACK, file.uri!, file.mimeType!, durationSec, proController.signal),
					() => proController.abort(),
				),
				model: GEMINI_PRO_FALLBACK,
			};
		}
	} finally {
		// Uploaded files expire in 48h anyway; deleting keeps quota clean and
		// must never mask the real error. fileName is captured before any throw
		// so a PROCESSING/FAILED exit — or a deadline timeout anywhere above —
		// still cleans up. Deliberately not bound to the (already-elapsed) slot
		// deadline: cleanup must still run when the ceiling has fired.
		if (fileName) {
			try { await ai.files.delete({ name: fileName }); } catch { /* best effort */ }
		}
	}
}
