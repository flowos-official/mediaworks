import type { ResearchOutput } from "../gemini";

/**
 * schema 適用後の text を ResearchOutput に変換する。
 *
 * - JSON.parse の上に Phase 1 の korea_market_fit.fit_score サニタイザを乗せる。
 *   schema が minimum/maximum を強制するが、防御的に Math.trunc + Number.isFinite で再正規化。
 * - schema 失敗で空応答 / 不正 JSON が返るケースは、呼び出し元 (retry helper) が catch して
 *   classifyGeminiError で kind 判定する。本関数は parse 失敗時に Error を throw するだけ。
 */
export function parseResearchOutput(text: string): ResearchOutput {
  const trimmed = text.trim();
  // schema mode で fence は付かないが、互換のため除去。
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse JSON from research synthesis: ${message}. Head: ${stripped.slice(0, 200)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Failed to parse JSON from research synthesis: not an object");
  }

  const research = parsed as ResearchOutput;

  // korea_market_fit.fit_score の整数化 (Phase 1 と同じ防御)
  if (research.korea_market_fit) {
    const raw = (research.korea_market_fit as { fit_score?: unknown }).fit_score;
    const num = typeof raw === "number" ? Math.trunc(raw) : Number.parseInt(String(raw ?? ""), 10);
    (research.korea_market_fit as { fit_score?: number | null }).fit_score = Number.isFinite(num) ? num : null;
  }

  return research;
}
