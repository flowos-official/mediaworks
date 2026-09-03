// lib/screenplay/generator.ts
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { GEMINI_PRO_FALLBACK } from "@/lib/gemini-models";
import { recordGeminiUsage, toUsageRecord, type GeminiUsageMetadata } from "@/lib/gemini-usage";
import { buildUserPrompt, buildSystemInstruction } from "./prompt";
import type { GenerateInput, GenerationResult } from "./types";

let _genAI: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
  if (!_genAI) _genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  return _genAI;
}

// Per user request: switched back to Gemini 3.1 Pro preview with HIGH thinking.
// Pro+HIGH produces denser, more faithful Japanese output and obeys
// "100% Japanese, no English" instructions more reliably than Flash.
const MODEL = GEMINI_PRO_FALLBACK;
const THINKING_LEVEL_NAME = "HIGH";
const HARD_TIMEOUT_MS = 540_000;       // 9 min — Pro+HIGH can take 3-6 min
const FIRST_CHUNK_MS = 240_000;        // 4 min for first byte (Pro thinks longer before streaming)

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    m.includes("503") || m.includes("429") || m.includes("500") ||
    m.includes("502") || m.includes("504") ||
    m.includes("overloaded") || m.includes("UNAVAILABLE") ||
    m.includes("aborted") || m.includes("timeout") ||
    m.includes("ECONNRESET") || m.includes("ETIMEDOUT")
  );
}

export function stripInternalNotes(markdown: string): string {
  return markdown
    .replace(/\n##\s+スタイル・コンプライアンス・ノート[\s\S]*$/m, "")
    .trim();
}

async function callOnce(
  userPrompt: string,
  systemInstruction: string,
  onChunk?: (chars: number) => void,
): Promise<string> {
  const controller = new AbortController();
  const hardTimer = setTimeout(
    () => controller.abort(new Error(`Gemini hard timeout ${HARD_TIMEOUT_MS}ms`)),
    HARD_TIMEOUT_MS,
  );
  let firstChunkTimer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => controller.abort(new Error(`Gemini first-chunk timeout ${FIRST_CHUNK_MS}ms`)),
    FIRST_CHUNK_MS,
  );
  try {
    const stream = await getGenAI().models.generateContentStream({
      model: MODEL,
      contents: userPrompt,
      config: {
        systemInstruction,
        thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
        abortSignal: controller.signal,
      },
    });
    let text = "";
    // The streaming API carries usageMetadata on the trailing chunks; keep the
    // last one seen. This is the most expensive call in the project — Pro with
    // HIGH thinking, retried up to three times — and it was reporting nothing,
    // so its share of the bill could only ever be guessed at. Thinking tokens
    // bill at the output rate and never appear in `text`, which is why counting
    // the generated characters cannot stand in for this.
    let usage: GeminiUsageMetadata | undefined;
    for await (const chunk of stream) {
      if (firstChunkTimer) {
        clearTimeout(firstChunkTimer);
        firstChunkTimer = null;
      }
      const t = chunk.text ?? "";
      text += t;
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      onChunk?.(text.length);
    }
    void recordGeminiUsage(toUsageRecord({ stage: "screenplay_generation", model: MODEL, usage }));
    return text;
  } finally {
    clearTimeout(hardTimer);
    if (firstChunkTimer) clearTimeout(firstChunkTimer);
  }
}

export async function generateScreenplay(
  input: GenerateInput,
  onChunk?: (chars: number) => void,
): Promise<GenerationResult> {
  const userPrompt = await buildUserPrompt(input);
  // A measured competitor structure replaces the invented ten-act running
  // order. With the fixed acts in place the injected pattern moved nothing —
  // see PATTERN_DRIVEN_ACT_SECTION in prompt.ts for the measurement.
  const systemInstruction = buildSystemInstruction(Boolean(input.patternBlock?.trim()));
  const ATTEMPTS = 3;
  let lastErr: unknown;
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      const raw = await callOnce(userPrompt, systemInstruction, onChunk);
      let md = raw.trim();
      const fence = md.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
      if (fence) md = fence[1].trim();
      md = stripInternalNotes(md);
      if (md.length < 1000) throw new Error(`output suspiciously short: ${md.length} chars`);
      return {
        markdown: md,
        model: MODEL,
        thinkingLevel: THINKING_LEVEL_NAME,
      };
    } catch (err) {
      lastErr = err;
      if (i === ATTEMPTS || !isRetryable(err)) throw err;
      const delay = 4000 * i;
      console.warn(`[screenplay] attempt ${i}/${ATTEMPTS} failed: ${(err as Error).message} — waiting ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
