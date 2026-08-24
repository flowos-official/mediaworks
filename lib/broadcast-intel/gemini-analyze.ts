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
 * NO `import "server-only"` — imported by tsx smoke scripts.
 */
import { GoogleGenAI, createPartFromUri, createUserContent, ApiError } from "@google/genai";
import { GEMINI_FLASH, GEMINI_PRO_FALLBACK } from "@/lib/gemini-models";
import { AUDIO_MIME, NonRetryableAudioError } from "./audio-extract";
import { ANALYSIS_RESPONSE_SCHEMA, parseAnalysisResponse, type BroadcastAnalysis } from "./schema";

export const MAX_OUTPUT_TOKENS = 32768;

let _genAI: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
	if (!_genAI) _genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
	return _genAI;
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

async function callModel(
	model: string,
	fileUri: string,
	fileMime: string,
	durationSec: number,
): Promise<BroadcastAnalysis> {
	const response = await getGenAI().models.generateContent({
		model,
		contents: createUserContent([createPartFromUri(fileUri, fileMime), ANALYSIS_PROMPT]),
		config: {
			responseMimeType: "application/json",
			responseSchema: ANALYSIS_RESPONSE_SCHEMA,
			maxOutputTokens: MAX_OUTPUT_TOKENS,
		},
	});

	const finish = response.candidates?.[0]?.finishReason;
	if (finish === "MAX_TOKENS") {
		throw new NonRetryableAudioError(
			`analysis exceeded ${MAX_OUTPUT_TOKENS} output tokens; the transcript is too long for one call`,
		);
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

export async function analyzeAudio(
	audio: Buffer,
	durationSec: number,
): Promise<{ analysis: BroadcastAnalysis; model: string }> {
	const ai = getGenAI();
	let fileName: string | null = null;

	try {
		let file = await ai.files.upload({
			file: new Blob([new Uint8Array(audio)], { type: AUDIO_MIME }),
			config: { mimeType: AUDIO_MIME },
		});
		fileName = file.name ?? null;

		// A part referencing a non-ACTIVE file is rejected, so poll until settled.
		const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
		while (file.state === "PROCESSING") {
			if (Date.now() > deadline) throw new Error("Gemini file upload stuck in PROCESSING");
			await new Promise((r) => setTimeout(r, UPLOAD_POLL_INTERVAL_MS));
			file = await ai.files.get({ name: file.name! });
			fileName = file.name ?? fileName;
		}
		if (file.state === "FAILED") throw new Error("Gemini file upload failed");

		try {
			return { analysis: await callModel(GEMINI_FLASH, file.uri!, file.mimeType!, durationSec), model: GEMINI_FLASH };
		} catch (err) {
			if (!isRetryable(err)) throw err;
			return {
				analysis: await callModel(GEMINI_PRO_FALLBACK, file.uri!, file.mimeType!, durationSec),
				model: GEMINI_PRO_FALLBACK,
			};
		}
	} finally {
		// Uploaded files expire in 48h anyway; deleting keeps quota clean and
		// must never mask the real error. fileName is captured before any throw
		// so a PROCESSING/FAILED exit still cleans up.
		if (fileName) {
			try { await ai.files.delete({ name: fileName }); } catch { /* best effort */ }
		}
	}
}
