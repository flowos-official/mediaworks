import { appConfig } from "@/config/app";

type MarketRecord = Record<string, unknown>;

const HANGUL_RE = /[\u3131-\u318e\uac00-\ud7a3]/g;
const JAPANESE_RE = /[\u3040-\u30ff\u3400-\u9fff]/g;

const KOREAN_HOSTS = [
	"coupang.com",
	"naver.com",
	"gmarket.co.kr",
	"11st.co.kr",
	"auction.co.kr",
	"lotteon.com",
	"kakao.com",
	"musinsa.com",
	"kurly.com",
	"ssg.com",
	"wemakeprice.com",
	"tmon.co.kr",
	"grip.show",
] as const;

const KOREAN_BROADCAST_CHANNELS = new Set([
	"cjonstyle",
	"lotteimall",
	"gongyoungshop",
	"hnsmall",
	"hmall",
	"nsmall",
]);

function textValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function hostname(value: unknown): string {
	if (typeof value !== "string" || !value) return "";
	try {
		return new URL(value).hostname.toLowerCase();
	} catch {
		return "";
	}
}

function matchesHost(host: string, domain: string): boolean {
	return host === domain || host.endsWith(`.${domain}`);
}

function scriptCount(text: string, pattern: RegExp): number {
	return text.match(pattern)?.length ?? 0;
}

/**
 * Legacy rows predate deployment/tenant columns, so market visibility has to
 * be inferred without mutating or deleting the shared data. Explicit market
 * metadata wins when it becomes available; otherwise URL and script balance
 * provide a conservative JP/KR split.
 */
export function isKoreanMarketRecord(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const record = value as MarketRecord;
	const nested =
		record.product_info_snapshot && typeof record.product_info_snapshot === "object"
			? (record.product_info_snapshot as MarketRecord)
			: {};

	const explicitVariant = textValue(
		record.app_variant || record.market_scope || nested.app_variant || nested.market_scope,
	);
	if (explicitVariant) return explicitVariant === "lotte-kr";
	const explicitCountry = textValue(
		record.country_code || record.market_country || nested.country_code || nested.market_country,
	);
	if (explicitCountry) return explicitCountry.toUpperCase() === "KR";
	if (KOREAN_BROADCAST_CHANNELS.has(textValue(record.channel).toLowerCase())) return true;

	const host = hostname(
		record.product_url ||
			record.source_url ||
			record.url ||
			nested.product_url ||
			nested.productUrl ||
			nested.source_url ||
			nested.url,
	);
	if (host.endsWith(".jp")) return false;
	if (host.endsWith(".kr") || KOREAN_HOSTS.some((domain) => matchesHost(host, domain))) {
		return true;
	}

	const primaryText = [
		record.name,
		record.product_name,
		record.program_title,
		record.title,
		nested.name,
		nested.product_name,
		nested.title,
	]
		.map(textValue)
		.filter(Boolean)
		.join(" ");
	const fallbackText = [
		record.description,
		record.tv_fit_reason,
		record.snippet,
		nested.description,
		nested.tv_fit_reason,
		nested.snippet,
	]
		.map(textValue)
		.filter(Boolean)
		.join(" ");
	const text = primaryText || fallbackText;
	const hangulCount = scriptCount(text, HANGUL_RE);
	const japaneseCount = scriptCount(text, JAPANESE_RE);

	// Keep Japanese product names with a short Korean translation or annotation,
	// while also catching short Korean names such as "협탁 101" and "N32 토퍼".
	return (
		(hangulCount > 0 && japaneseCount === 0) ||
		(hangulCount >= 4 && hangulCount > japaneseCount)
	);
}

export function isMarketRecordVisible(value: unknown): boolean {
	if (appConfig.market.countryCode === "KR") return true;
	return !isKoreanMarketRecord(value);
}

export function filterMarketRecords<T>(records: readonly T[]): T[] {
	return records.filter(isMarketRecordVisible);
}

/**
 * Discovery runs are generated for one market at a time. If fewer than half
 * of a legacy run's records belong to the active market, hide the whole run
 * instead of leaking a few ambiguous English/short-title rows from it.
 */
export function filterMarketBatchRecords<T>(records: readonly T[]): T[] {
	if (appConfig.market.countryCode === "KR") return [...records];
	if (records.length === 0) return [];
	const visible = filterMarketRecords(records);
	return visible.length / records.length >= 0.5 ? visible : [];
}
