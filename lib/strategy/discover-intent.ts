/**
 * DiscoverIntent — structured representation of the user's free-text goal
 * (e.g. "冬に売れる商品を探して") that drives discovery filtering and search.
 *
 * Produced by `runGoalAnalysis` in both MD and LC pipelines (they extend
 * their respective `ParsedGoal` with these fields). Consumed by:
 *   - `lib/strategy/pool-query.ts`  → soft fuzzy filter on the discovery pool
 *   - `lib/md-strategy.ts::discoverNewProducts` → extra Rakuten/Brave search
 *     keywords + Gemini curation prompt section
 *
 * Keep this file framework-agnostic. No imports from md-strategy or
 * live-commerce-strategy (avoid circular deps).
 */

export type IntentTier = "broad" | "seasonal" | "genre" | "specific_keyword";

export interface ChannelScope {
  channel_slug: string;
  raw_mention: string;
  confidence: number;
}

export interface SpecificKeyword {
  raw: string;
  normalized: string;
  aliases: string[];
  confidence: number;
}

export interface DiscoverIntent {
	/** 季節キーワード — 冬 / 夏 / 春 / 秋 / 年末 / 梅雨 / 花粉 etc. */
	seasonal_keywords: string[];
	/** テーマキーワード — 暖かい / 防寒 / ギフト / 新生活 / 防災 etc. */
	theme_keywords: string[];
	/** 推奨カテゴリ候補 — 暖房家電 / 鍋・キッチン家電 / 防寒衣料 etc. */
	category_hints: string[];
	/** 除外したいテーマ — ユーザー目標と矛盾するもの (夏物, クーラー etc.) */
	excluded_themes: string[];
	/** Granularity tier — how specific the user's intent is */
	intent_tier?: IntentTier;
	/** TV channel scope constraints extracted from the user's goal */
	channel_scope?: ChannelScope[];
	/** Specific product keyword when the user names a concrete item */
	specific_keyword?: SpecificKeyword | null;
}

export function emptyDiscoverIntent(): DiscoverIntent {
	return {
		seasonal_keywords: [],
		theme_keywords: [],
		category_hints: [],
		excluded_themes: [],
		intent_tier: "broad",
		channel_scope: [],
		specific_keyword: null,
	};
}

/**
 * Normalize any partial input (e.g. Gemini JSON output) into a valid
 * DiscoverIntent. Strips non-string entries, trims, dedupes, caps length.
 */
export function normalizeDiscoverIntent(input: unknown): DiscoverIntent {
	const out = emptyDiscoverIntent();
	if (!input || typeof input !== "object") return out;
	const obj = input as Record<string, unknown>;
	for (const key of [
		"seasonal_keywords",
		"theme_keywords",
		"category_hints",
		"excluded_themes",
	] as const) {
		const arr = obj[key];
		if (!Array.isArray(arr)) continue;
		const cleaned = Array.from(
			new Set(
				arr
					.filter((s): s is string => typeof s === "string")
					.map((s) => s.trim())
					.filter((s) => s.length > 0 && s.length <= 40),
			),
		).slice(0, 10);
		out[key] = cleaned;
	}

	// New fields — tier defaults to "broad"; channel_scope + specific_keyword normalize defensively
	const tierRaw = obj["intent_tier"];
	if (tierRaw === "broad" || tierRaw === "seasonal" || tierRaw === "genre" || tierRaw === "specific_keyword") {
		out.intent_tier = tierRaw;
	}

	const scopeRaw = obj["channel_scope"];
	if (Array.isArray(scopeRaw)) {
		out.channel_scope = scopeRaw
			.filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
			.map((x) => ({
				channel_slug: typeof x.channel_slug === "string" ? x.channel_slug.trim() : "",
				raw_mention: typeof x.raw_mention === "string" ? x.raw_mention.trim() : "",
				confidence: typeof x.confidence === "number" && x.confidence >= 0 && x.confidence <= 1 ? x.confidence : 0,
			}))
			.filter((c) => c.channel_slug.length > 0)
			.slice(0, 5);
	}

	const skRaw = obj["specific_keyword"];
	if (skRaw && typeof skRaw === "object") {
		const sk = skRaw as Record<string, unknown>;
		const normalized = typeof sk.normalized === "string" ? sk.normalized.trim() : "";
		if (normalized.length > 0) {
			out.specific_keyword = {
				raw: typeof sk.raw === "string" ? sk.raw.trim() : normalized,
				normalized,
				aliases: Array.isArray(sk.aliases)
					? sk.aliases.filter((s): s is string => typeof s === "string" && s.trim().length >= 2).map((s) => s.trim()).slice(0, 6)
					: [],
				confidence: typeof sk.confidence === "number" && sk.confidence >= 0 && sk.confidence <= 1 ? sk.confidence : 0,
			};
		}
	}

	return out;
}

/**
 * Heuristic fallback: if Gemini returned an empty intent but the raw goal
 * obviously mentions a season/theme, extract a minimal signal so downstream
 * filtering still benefits.
 *
 * Used as a SAFETY NET, not the primary path. The LLM should usually
 * produce richer fields.
 */
const FALLBACK_SEASONAL = [
	"冬",
	"夏",
	"春",
	"秋",
	"年末",
	"年始",
	"クリスマス",
	"ハロウィン",
	"バレンタイン",
	"ホワイトデー",
	"母の日",
	"父の日",
	"梅雨",
	"花粉",
	"お歳暮",
	"お中元",
	"防災",
	"新生活",
];

export function ensureDiscoverIntent(
	intent: DiscoverIntent | null | undefined,
	rawGoal: string | null | undefined,
): DiscoverIntent {
	const base = intent ? normalizeDiscoverIntent(intent) : emptyDiscoverIntent();
	const hasAny =
		base.seasonal_keywords.length > 0 ||
		base.theme_keywords.length > 0 ||
		base.category_hints.length > 0;
	if (hasAny) return base;
	if (!rawGoal) return base;
	const hits: string[] = [];
	for (const kw of FALLBACK_SEASONAL) {
		if (rawGoal.includes(kw)) hits.push(kw);
	}
	if (hits.length > 0) {
		base.seasonal_keywords = hits.slice(0, 5);
	}
	return base;
}

/**
 * Flatten intent into a single keyword set used by the pool query's fuzzy
 * matcher. Excludes `excluded_themes` — those are filter-out signals handled
 * at the Gemini curation stage, not pool matching.
 */
export function deriveIntentKeywords(
	intent: DiscoverIntent | null | undefined,
): string[] {
	if (!intent) return [];
	const merged = [
		...intent.seasonal_keywords,
		...intent.theme_keywords,
		...intent.category_hints,
	]
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return Array.from(new Set(merged)).slice(0, 12);
}

/**
 * Extra search keywords to run against Rakuten/Brave on TOP of the TV
 * category keywords. Combines seasonal × category-hint for higher precision
 * (e.g. "冬 暖房家電", "年末 鍋"). Capped to avoid quota blowup.
 */
export function buildIntentSearchQueries(
	intent: DiscoverIntent | null | undefined,
	maxQueries = 4,
): string[] {
	if (!intent) return [];
	const seasons = intent.seasonal_keywords.slice(0, 2);
	const cats = intent.category_hints.slice(0, 3);
	const themes = intent.theme_keywords.slice(0, 2);
	const queries: string[] = [];
	// Compose: season × category first (most specific)
	for (const s of seasons) {
		for (const c of cats) {
			queries.push(`${s} ${c}`);
		}
	}
	// Then season × theme
	for (const s of seasons) {
		for (const t of themes) {
			queries.push(`${s} ${t}`);
		}
	}
	// Then bare category hints (for cases without seasonal context)
	if (queries.length === 0) {
		queries.push(...cats);
	}
	// Then bare seasonal as last resort
	if (queries.length === 0) {
		queries.push(...seasons);
	}
	return Array.from(new Set(queries.filter((q) => q.trim().length > 0))).slice(
		0,
		maxQueries,
	);
}

/**
 * Build a human-readable section for the Gemini curation prompt.
 * Empty string if no signal — caller can concatenate safely.
 */
export function formatIntentPromptSection(
	intent: DiscoverIntent | null | undefined,
	rawGoal?: string | null,
): string {
	if (!intent) return "";
	const parts: string[] = [];
	if (intent.seasonal_keywords.length > 0) {
		parts.push(`季節/タイミング: ${intent.seasonal_keywords.join(", ")}`);
	}
	if (intent.theme_keywords.length > 0) {
		parts.push(`テーマ: ${intent.theme_keywords.join(", ")}`);
	}
	if (intent.category_hints.length > 0) {
		parts.push(`想定カテゴリ: ${intent.category_hints.join(", ")}`);
	}
	if (intent.excluded_themes.length > 0) {
		parts.push(`除外テーマ (選定禁止): ${intent.excluded_themes.join(", ")}`);
	}
	if (parts.length === 0) return "";
	const goalLine = rawGoal ? `ユーザー原文: ${rawGoal}\n` : "";
	return `\n=== ユーザー意図 (USER INTENT — STRICTLY HONOR) ===\n${goalLine}${parts.join("\n")}\n\nIMPORTANT:\n- 上記の季節/テーマと明確に矛盾する商品 (例: 「冬」目標で扇風機、「夏」目標でヒーター) は選定から除外すること。\n- 「除外テーマ」に該当する商品は recommended_products から外すこと。\n- 上記意図と整合する商品を優先し、recommendation_reason に該当意図 (季節/テーマ) への適合根拠を明記すること。\n`;
}
