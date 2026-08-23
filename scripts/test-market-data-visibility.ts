import { appConfig } from "../config/app";
import {
	filterMarketBatchRecords,
	filterMarketRecords,
	isKoreanMarketRecord,
	isMarketRecordVisible,
} from "../lib/market/data-visibility";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const koreanName = {
	name: "하루틴 혈당 혈압 혈행 기억력 건강기능식품",
	product_url: "https://www.youtube.com/watch?v=example",
};
const koreanDomain = {
	name: "Wireless speaker special edition",
	product_url: "https://www.coupang.com/vp/products/123",
};
const shortKoreanName = { name: "협탁 101" };
const japaneseName = {
	name: "家庭用コードレス掃除機 軽量モデル",
	product_url: "https://item.rakuten.co.jp/example/123",
};
const japaneseWithKoreanAnnotation = {
	name: "ひろがる木陰 遮熱ブリーズハット (기능성 모자)",
};
const koreanBroadcast = {
	program_title: "재방_가공축산",
	source_url: "https://www.gongyoungshop.kr/tvshopping/selectSchedule.do",
};
const koreanBroadcastChannel = {
	channel: "cjonstyle",
	program_title: "Exclusive Model X",
};
const koreanScreenplay = {
	title: "Model X",
	product_info_snapshot: { name: "하루틴 리포좀비타민C프로 6개월분" },
};

assert(isKoreanMarketRecord(koreanName), "Hangul-dominant products must be classified as Korean");
assert(isKoreanMarketRecord(koreanDomain), "Korean commerce domains must be classified as Korean");
assert(isKoreanMarketRecord(shortKoreanName), "Short Korean product names must be classified as Korean");
assert(isKoreanMarketRecord(koreanBroadcast), "Korean broadcast rows must be classified as Korean");
assert(
	isKoreanMarketRecord(koreanBroadcastChannel),
	"Korean broadcast channel codes must be classified even when text is ambiguous",
);
assert(isKoreanMarketRecord(koreanScreenplay), "Nested Korean screenplay snapshots must be classified as Korean");
assert(!isKoreanMarketRecord(japaneseName), "Japanese commerce products must stay Japanese");
assert(
	!isKoreanMarketRecord(japaneseWithKoreanAnnotation),
	"A Japanese product with a short Korean annotation must remain visible",
);

const records = [
	koreanName,
	koreanDomain,
	shortKoreanName,
	japaneseName,
	japaneseWithKoreanAnnotation,
];
const visible = filterMarketRecords(records);
if (appConfig.id === "mediaworks-jp") {
	assert(!isMarketRecordVisible(koreanName), "Japan must hide Korean products");
	assert(visible.length === 2, "Japan must return only Japanese records");
	assert(
		filterMarketBatchRecords([koreanName, koreanDomain, shortKoreanName, { name: "Model X" }])
			.length === 0,
		"Japan must hide a Korean discovery run even when one ambiguous row remains",
	);
	assert(
		filterMarketBatchRecords([japaneseName, japaneseWithKoreanAnnotation, koreanName]).length === 2,
		"Japan must retain the Japanese subset of a predominantly Japanese run",
	);
} else {
	assert(isMarketRecordVisible(koreanName), "LOTTE must retain Korean products");
	assert(visible.length === records.length, "LOTTE must retain the original shared records");
}

console.log(`market data visibility checks passed (${appConfig.id})`);
