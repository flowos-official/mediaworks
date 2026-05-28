import { TV_CHANNELS } from "@/lib/discovery/tv-channels";

/**
 * Free-text channel mentions → canonical registry slug.
 * Used by runGoalAnalysis to normalize channel_scope.channel_slug.
 *
 * Source of truth for slugs: lib/discovery/tv-channels.ts (16 channels).
 * Slugs not in TV_CHANNELS are rejected (resolveChannelSlug returns null).
 */
const ALIAS_MAP: Record<string, string> = {
  // QVC
  "qvc": "qvc",
  "qvcジャパン": "qvc",
  "qvc japan": "qvc",
  // Shop Channel
  "shop channel": "shopch",
  "ショップチャンネル": "shopch",
  "shopch": "shopch",
  // テレ東マート (canonical slug from tv-channels.ts:55 — txd)
  "テレ東マート": "txd",
  "テレビ東京マート": "txd",
  "txd": "txd",
  // Japanet
  "japanet": "japanet",
  "ジャパネット": "japanet",
  "ジャパネットたかた": "japanet",
  // Dinos
  "dinos": "dinos",
  "ディノス": "dinos",
  // Ropping
  "ropping": "ropping",
  "ロッピング": "ropping",
  // Senobura
  "senobura": "senobura",
  "せのぶら": "senobura",
  // NTV (日テレポシュレ)
  "ntv": "ntv",
  "日テレ": "ntv",
  "日テレポシュレ": "ntv",
  "ポシュレ": "ntv",
  // TBS (グッとライフ)
  "tbs": "tbs",
  "グッとライフ": "tbs",
  // Ichiban Honpo (いちばん本舗 — 東海テレビ)
  "ichiban": "ichiban",
  "いちばん本舗": "ichiban",
  "いちばん": "ichiban",
  "東海テレビショップ": "ichiban",
  // Kachimo (カチモ)
  "kachimo": "kachimo",
  "カチモ": "kachimo",
  // Kaidoki Market (買いドキ！マーケット — SATV)
  "kaidoki": "kaidoki",
  "買いドキ": "kaidoki",
  "買いドキ！マーケット": "kaidoki",
  "satvショップ": "kaidoki",
  // Kantv (関テレ)
  "kantv": "kantv",
  "関テレ": "kantv",
  "関西テレビショップ": "kantv",
  // Junsanpo (テレ朝じゅん散歩)
  "junsanpo": "junsanpo",
  "じゅん散歩": "junsanpo",
  "テレ朝じゅん散歩": "junsanpo",
  // Uranoura (ABCウラのウラまで)
  "uranoura": "uranoura",
  "ウラのウラまで": "uranoura",
  "abcウラのウラまで": "uranoura",
};

const VALID_SLUGS = new Set(TV_CHANNELS.map((c) => c.slug));

export function resolveChannelSlug(rawMention: string): string | null {
  const lower = rawMention.trim().toLowerCase();
  const mapped = ALIAS_MAP[lower] ?? ALIAS_MAP[rawMention.trim()];
  if (mapped && VALID_SLUGS.has(mapped)) return mapped;
  // Direct slug match (e.g. user typed "qvc")
  if (VALID_SLUGS.has(lower)) return lower;
  return null;
}
