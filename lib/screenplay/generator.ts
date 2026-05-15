// lib/screenplay/generator.ts
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { buildPrompt } from "./prompt";
import type { GenerateInput, GenerationResult } from "./types";

let _genAI: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
  if (!_genAI) _genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  return _genAI;
}

const HARD_TIMEOUT_MS = 360_000;
const FIRST_CHUNK_MS = 180_000;
const MODEL = "gemini-3.1-pro-preview";

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

async function callOnce(prompt: string, onChunk?: (chars: number) => void): Promise<string> {
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
      contents: prompt,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
        abortSignal: controller.signal,
      },
    });
    let text = "";
    for await (const chunk of stream) {
      if (firstChunkTimer) {
        clearTimeout(firstChunkTimer);
        firstChunkTimer = null;
      }
      const t = chunk.text ?? "";
      text += t;
      onChunk?.(text.length);
    }
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
  const prompt = await buildPrompt(input);
  const ATTEMPTS = 3;
  let lastErr: unknown;
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      const raw = await callOnce(prompt, onChunk);
      let md = raw.trim();
      const fence = md.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
      if (fence) md = fence[1].trim();
      if (md.length < 1000) throw new Error(`output suspiciously short: ${md.length} chars`);
      return {
        markdown: md,
        model: MODEL,
        thinkingLevel: "HIGH",
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
