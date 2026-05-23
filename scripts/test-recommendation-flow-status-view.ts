import assert from "node:assert/strict";
import {
	buildRecommendationFlowStatusView,
	getRecommendationFlowStatusUiText,
} from "../lib/recommendation/flow-status-view";
import type { RecommendationFlowStatus } from "../lib/recommendation/flow-evidence";

const readyStatus: RecommendationFlowStatus = {
	strictReady: true,
	strictFailures: "",
	evidence: {
		latestDiscoveryRun: { id: "run-1", context: "home_shopping", status: "completed" },
		latestDiscoveryProductCount: 5,
		contextDiscoveryRuns: [
			{ context: "home_shopping", status: "completed", productCount: 30 },
			{ context: "live_commerce", status: "completed", productCount: 30 },
		],
		promotableCandidate: { id: "dp-1", name: "候補商品" },
		promotedProduct: { id: "p-1", name: "昇格商品", status: "completed", discovered_product_id: "dp-1" },
		promotedResearchResult: { product_id: "p-1" },
		latestMdStrategy: { id: "strategy-1", user_goal: "月商500万" },
		integratedMdStrategy: {
			id: "strategy-1",
			user_goal: "月商500万",
			internalProductCount: 8,
			externalCandidateCount: 20,
			poolSources: ["discovery_pool", "fresh_search"],
			poolSourceCounts: [
				{ source: "discovery_pool", count: 12 },
				{ source: "fresh_search", count: 8 },
			],
			discoveryPoolCount: 12,
			freshSearchCount: 8,
			researchCandidateCount: 0,
			tvSignalCount: 4,
			discoveredProductIds: ["dp-1"],
		},
		latestLinkedScreenplay: { id: "sp-1", product_id: "p-1", status: "ready" },
		promotedLinkedScreenplay: { id: "sp-1", product_id: "p-1", status: "ready" },
		dataCoverage: {
			categoryNormalization: {
				discoveredRawCategoryCount: 428,
				coveredRawCategoryCount: 428,
				normalizedRawCategoryCount: 428,
				missingRawCategoryCount: 0,
				cacheCoveragePct: 100,
			},
			broadcastCategories: {
				broadcastsTotal: 1668,
				broadcastsWithCategory: 1402,
				historicalTotal: 49320,
				historicalWithCategory: 0,
				overallCoveragePct: 2.8,
			},
			operatorFitCategories: {
				total: 2,
				withCategory: 0,
				coveragePct: 0,
			},
		},
	},
	checks: [
		{ key: "discovery_run", status: "pass", message: "latest run ok", strictRequired: true },
		{ key: "discovery_home_shopping", status: "pass", message: "home ok", strictRequired: true },
		{ key: "integrated_md_strategy", status: "pass", message: "strategy ok", strictRequired: true },
		{ key: "category_normalization_cache", status: "pass", message: "category ok", strictRequired: true },
		{ key: "broadcast_category_coverage", status: "warn", message: "broadcast coverage low", strictRequired: false },
		{ key: "operator_fit_category_coverage", status: "warn", message: "operator fit coverage low", strictRequired: false },
	],
};

const readyView = buildRecommendationFlowStatusView(readyStatus);
assert.equal(readyView.headline, "連携OK");
assert.equal(readyView.tone, "ready");
assert.equal(readyView.summary, "必須チェック通過 / 注意 2件");
assert.equal(readyView.checks[0].title, "Discovery run");
assert.equal(readyView.checks[0].statusLabel, "OK");
assert.equal(readyView.checks[0].message, "最新Discovery runを確認済みです。");
assert.equal(
	readyView.checks.find((check) => check.key === "integrated_md_strategy")?.title,
	"統合根拠",
);
assert.equal(
	readyView.checks.find((check) => check.key === "integrated_md_strategy")?.message,
	"内部実績8件と外部候補20件を含むMD戦略があります。",
);
assert.deepEqual(
	readyView.cards.map((card) => [card.key, card.title, card.status, card.metric]),
	[
		["home_discovery", "ホーム発掘", "pass", "30"],
		["live_discovery", "ライブ発掘", "pass", "30"],
		["research", "リサーチ", "pass", "completed"],
		["strategy", "MD戦略", "pass", "8 / 20"],
		["screenplay", "台本", "pass", "ready"],
		["data_coverage", "根拠データ", "warn", "100%"],
	],
);
assert.equal(
	readyView.checks.find((check) => check.key === "category_normalization_cache")?.message,
	"Discovery raw category 428/428件が正規化キャッシュに接続済みです (cache rows 428件)。",
);
assert.equal(
	readyView.checks.find((check) => check.key === "broadcast_category_coverage")?.message,
	"放送カテゴリ coverage 2.8%: QVC/ShopCh 1402/1668, OA 0/49320.",
);
assert.equal(
	readyView.checks.find((check) => check.key === "operator_fit_category_coverage")?.message,
	"運営者fit分析カテゴリ coverage 0% (0/2).",
);

const readyKoView = buildRecommendationFlowStatusView(readyStatus, "ko");
assert.equal(readyKoView.headline, "연결 정상");
assert.equal(readyKoView.summary, "필수 체크 통과 / 확인 필요 2개");
assert.equal(readyKoView.cards.find((card) => card.key === "home_discovery")?.title, "홈쇼핑 발굴");
assert.equal(readyKoView.cards.find((card) => card.key === "screenplay")?.description, "Research 상품에 연결된 대본");
assert.equal(readyKoView.cards.find((card) => card.key === "data_coverage")?.title, "근거 데이터");
assert.equal(readyKoView.checks[0].statusLabel, "정상");
assert.equal(readyKoView.checks[0].message, "최신 Discovery run을 확인했습니다.");
assert.equal(
	readyKoView.checks.find((check) => check.key === "integrated_md_strategy")?.message,
	"내부 실적 8개와 외부 후보 20개를 포함한 MD 전략이 있습니다.",
);

const jaUi = getRecommendationFlowStatusUiText("ja");
assert.equal(jaUi.loadingHeadline, "確認中");
assert.equal(jaUi.refresh, "更新");
assert.equal(jaUi.strictChecks, "必須チェック");
const koUi = getRecommendationFlowStatusUiText("ko");
assert.equal(koUi.loadingHeadline, "확인 중");
assert.equal(koUi.refresh, "새로고침");
assert.equal(koUi.strictChecks, "필수 체크");

const blockedStatus: RecommendationFlowStatus = {
	...readyStatus,
	strictReady: false,
	strictFailures: "- live_commerce Discovery run이 완료 상태가 아니거나 후보가 없음",
	evidence: {
		...readyStatus.evidence,
		contextDiscoveryRuns: [
			{ context: "home_shopping", status: "completed", productCount: 30 },
			{ context: "live_commerce", status: "failed", productCount: 0 },
		],
		promotedLinkedScreenplay: { id: "sp-1", product_id: "p-1", status: "generating" },
	},
	checks: [
		{ key: "discovery_live_commerce", status: "fail", message: "live missing", strictRequired: true },
		{ key: "promoted_linked_screenplay", status: "warn", message: "screenplay generating", strictRequired: true },
	],
};

const blockedView = buildRecommendationFlowStatusView(blockedStatus);
assert.equal(blockedView.headline, "対応が必要");
assert.equal(blockedView.tone, "blocked");
assert.equal(blockedView.summary, "2件の必須チェックが未通過");
assert.equal(blockedView.cards.find((card) => card.key === "live_discovery")?.status, "fail");
assert.equal(blockedView.cards.find((card) => card.key === "screenplay")?.status, "warn");
assert.equal(
	blockedView.checks.find((check) => check.key === "discovery_live_commerce")?.message,
	"live_commerce Discovery runが完了していないか、候補がありません。",
);
assert.equal(
	blockedView.checks.find((check) => check.key === "promoted_linked_screenplay")?.message,
	"昇格Research商品に紐づく台本がready状態ではありません。",
);
assert.equal(
	blockedView.checks.some((check) => /완료|후보|승격|없음|생성/.test(check.message)),
	false,
);

const blockedKoView = buildRecommendationFlowStatusView(blockedStatus, "ko");
assert.equal(blockedKoView.headline, "조치 필요");
assert.equal(blockedKoView.summary, "필수 체크 2개 미통과");
assert.equal(
	blockedKoView.checks.find((check) => check.key === "discovery_live_commerce")?.message,
	"live_commerce Discovery run이 완료 상태가 아니거나 후보가 없습니다.",
);

console.log("PASS: recommendation flow status view model");
