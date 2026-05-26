/**
 * Decide which pipeline stage to restart from when retrying a failed/stuck product.
 *
 * - description が空 (NULL / "" / 空白のみ) → extract から再開。
 *   Gemini Vision の抽出が走り終わらなかったか、抽出結果が空だった状態。
 * - description あり → synthesize から再開。Brave + Gemini synthesis を再実行する。
 *
 * 純粋関数 — Supabase クライアントは受け取らない。retry API ハンドラから呼ばれる。
 */
export type RetryStage = "extract" | "synthesize";

export function determineRetryStage(product: { description: string | null }): RetryStage {
  const desc = product.description?.trim() ?? "";
  return desc.length === 0 ? "extract" : "synthesize";
}
