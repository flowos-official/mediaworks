import type { SupabaseClient } from "@supabase/supabase-js";

const STUCK_THRESHOLD_MINUTES = 10;

export interface StuckDetectionResult {
  flagged: {
    pending: number;
    analyzing: number;
  };
}

/**
 * 10 分以上 pending / analyzing 状態に留まる商品を failed にマーク。
 *
 * - pending 10 分超過 → trigger_not_invoked (extract トリガが届かなかった疑い)
 * - analyzing 10 分超過 → analysis_timeout (extract または synthesize が応答しなかった)
 *
 * 10 分の根拠: analyze maxDuration 120s + synthesize maxDuration 300s = 7 分。
 * 10 分なら両方が正常終了した後で、false positive のリスクが低い。
 *
 * 制約: 2 つの UPDATE はトランザクション外で順次実行される。pending 側成功・
 * analyzing 側失敗の場合は前者だけが mutate された状態で例外が投げられる。
 * 次サイクル (15 分後 cron) で残った analyzing 行を拾うため運用上は許容範囲。
 *
 * service_role クライアントを呼び出し側から渡す前提 (cron と admin route 両方が使う)。
 */
export async function detectStuck(sb: SupabaseClient): Promise<StuckDetectionResult> {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000).toISOString();

  // pending 行は status 遷移がまだ起きていないため updated_at == INSERT 時刻。
  // どちらで判定しても等価だが、意図 (= 起票から N 分経過) を明示するため created_at を使う。
  const { count: pendingCount, error: pendingErr } = await sb
    .from("products")
    .update({ status: "failed", error_reason: "trigger_not_invoked" }, { count: "exact" })
    .eq("status", "pending")
    .lt("created_at", cutoff);
  if (pendingErr) throw pendingErr;

  // analyzing 行は extract → synthesize 中に status / その他カラムが更新されるため、
  // 最終アクティビティ時刻として updated_at (trigger が自動更新) を採用する。
  const { count: analyzingCount, error: analyzingErr } = await sb
    .from("products")
    .update({ status: "failed", error_reason: "analysis_timeout" }, { count: "exact" })
    .eq("status", "analyzing")
    .lt("updated_at", cutoff);
  if (analyzingErr) throw analyzingErr;

  return {
    flagged: {
      pending: pendingCount ?? 0,
      analyzing: analyzingCount ?? 0,
    },
  };
}
