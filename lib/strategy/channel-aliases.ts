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
