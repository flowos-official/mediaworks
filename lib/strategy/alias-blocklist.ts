/**
 * Broad Japanese category terms that must never appear as a
 * `specific_keyword.aliases` entry. The Gemini classifier is instructed
 * not to emit these, but Gemini compliance is not guaranteed — this
 * deterministic blocklist filters them out post-parse.
 *
 * Keep additions narrow: only category-level nouns that would dilute the
 * tier-4 hard filter. Product-level terms (包丁, ナイフ, ヒーター) MUST NOT
 * appear here.
 */
export const ALIAS_BLOCKLIST: ReadonlySet<string> = new Set([
  // Broad consumer-goods categories
  "キッチン用品",
  "キッチン",
  "家電",
  "家電・雑貨",
  "電気機器",
  "電化製品",
  "服",
  "アパレル",
  "ファッション",
  "靴",
  "バッグ",
  "食品",
  "食料品",
  "美容",
  "化粧品",
  "コスメ",
  "ビューティ",
  "寝具",
  "インテリア",
  "雑貨",
  "生活雑貨",
  "ホーム",
  "ホーム・キッチン",
  "フィットネス",
  "健康食品",
  "医療機器",
  "ジュエリー",
  "宝飾",
  "ゴルフ",
  "アウトドア",
  "その他",
]);

export function filterAliases(aliases: string[], categoryHints: string[]): {
  kept: string[];
  dropped: string[];
} {
  const hintSet = new Set(categoryHints.map((h) => h.trim()));
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const a of aliases) {
    const trimmed = a.trim();
    if (trimmed.length < 2) {
      dropped.push(trimmed);
      continue;
    }
    if (ALIAS_BLOCKLIST.has(trimmed)) {
      dropped.push(trimmed);
      continue;
    }
    if (hintSet.has(trimmed)) {
      dropped.push(trimmed);
      continue;
    }
    kept.push(trimmed);
  }
  return { kept, dropped };
}
