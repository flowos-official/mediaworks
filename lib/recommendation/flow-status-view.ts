import type { RecommendationFlowStatus } from "@/lib/recommendation/flow-evidence";
import type { FlowCheckStatus } from "@/lib/recommendation/flow-readiness";

type StatusTone = "ready" | "blocked";
export type RecommendationFlowLocale = "ja" | "ko";

export interface RecommendationFlowStatusCard {
	key:
		| "home_discovery"
		| "live_discovery"
		| "research"
		| "strategy"
		| "screenplay"
		| "data_coverage";
	title: string;
	status: FlowCheckStatus;
	metric: string;
	description: string;
}

export interface RecommendationFlowStatusCheckView {
	key: string;
	title: string;
	status: FlowCheckStatus;
	statusLabel: string;
	required: boolean;
	message: string;
}

export interface RecommendationFlowStatusView {
	headline: string;
	tone: StatusTone;
	summary: string;
	cards: RecommendationFlowStatusCard[];
	checks: RecommendationFlowStatusCheckView[];
}

export interface RecommendationFlowStatusUiText {
	loadingHeadline: string;
	loadingSummary: string;
	unavailableHeadline: string;
	refresh: string;
	strictChecks: string;
	required: string;
}

const UI_TEXT: Record<RecommendationFlowLocale, RecommendationFlowStatusUiText> = {
	ja: {
		loadingHeadline: "確認中",
		loadingSummary: "現在の推薦フロー状態を確認しています。",
		unavailableHeadline: "取得できません",
		refresh: "更新",
		strictChecks: "必須チェック",
		required: "必須",
	},
	ko: {
		loadingHeadline: "확인 중",
		loadingSummary: "현재 추천 플로우 상태를 확인하고 있습니다.",
		unavailableHeadline: "확인 불가",
		refresh: "새로고침",
		strictChecks: "필수 체크",
		required: "필수",
	},
};

const STATUS_LABELS: Record<RecommendationFlowLocale, Record<FlowCheckStatus, string>> = {
	ja: {
		pass: "OK",
		warn: "注意",
		fail: "未通過",
	},
	ko: {
		pass: "정상",
		warn: "확인 필요",
		fail: "미통과",
	},
};

const HEADLINE: Record<RecommendationFlowLocale, Record<StatusTone, string>> = {
	ja: {
		ready: "連携OK",
		blocked: "対応が必要",
	},
	ko: {
		ready: "연결 정상",
		blocked: "조치 필요",
	},
};

const CARD_TEXT: Record<
	RecommendationFlowLocale,
	Record<RecommendationFlowStatusCard["key"], { title: string; description: string }>
> = {
	ja: {
		home_discovery: { title: "ホーム発掘", description: "最新ホームショッピング候補" },
		live_discovery: { title: "ライブ発掘", description: "最新ライブコマース候補" },
		research: { title: "リサーチ", description: "Discovery候補のResearch昇格" },
		strategy: { title: "MD戦略", description: "内部実績 / 外部候補" },
		screenplay: { title: "台本", description: "Research商品に紐づく台本" },
		data_coverage: { title: "根拠データ", description: "カテゴリ / 競合カバレッジ" },
	},
	ko: {
		home_discovery: { title: "홈쇼핑 발굴", description: "최신 홈쇼핑 후보" },
		live_discovery: { title: "라이브 발굴", description: "최신 라이브 커머스 후보" },
		research: { title: "리서치", description: "Discovery 후보의 Research 승격" },
		strategy: { title: "MD 전략", description: "내부 실적 / 외부 후보" },
		screenplay: { title: "대본", description: "Research 상품에 연결된 대본" },
		data_coverage: { title: "근거 데이터", description: "카테고리 / 경쟁 커버리지" },
	},
};

function statusForContext(
	status: RecommendationFlowStatus,
	context: "home_shopping" | "live_commerce",
): FlowCheckStatus {
	const run = status.evidence.contextDiscoveryRuns.find((item) => item.context === context);
	if (run?.status === "completed" && run.productCount > 0) return "pass";
	if (run?.status === "completed") return "warn";
	return "fail";
}

function metricForContext(
	status: RecommendationFlowStatus,
	context: "home_shopping" | "live_commerce",
): string {
	const run = status.evidence.contextDiscoveryRuns.find((item) => item.context === context);
	return String(run?.productCount ?? 0);
}

function researchStatus(status: RecommendationFlowStatus): FlowCheckStatus {
	if (status.evidence.promotedProduct && status.evidence.promotedResearchResult) return "pass";
	if (status.evidence.promotedProduct) return "warn";
	return "fail";
}

function screenplayStatus(status: RecommendationFlowStatus): FlowCheckStatus {
	if (status.evidence.promotedLinkedScreenplay?.status === "ready") return "pass";
	if (status.evidence.promotedLinkedScreenplay) return "warn";
	return "fail";
}

function dataCoverageStatus(status: RecommendationFlowStatus): FlowCheckStatus {
	const category = status.evidence.dataCoverage.categoryNormalization;
	if (
		category.discoveredRawCategoryCount === 0 ||
		category.missingRawCategoryCount > 0
	) {
		return "fail";
	}
	const broadcast = status.evidence.dataCoverage.broadcastCategories;
	const fit = status.evidence.dataCoverage.operatorFitCategories;
	if (
		broadcast.broadcastsWithCategory === 0 ||
		(broadcast.historicalTotal > 0 && broadcast.historicalWithCategory === 0) ||
		(fit.total > 0 && fit.withCategory < fit.total)
	) {
		return "warn";
	}
	return "pass";
}

function normalizeLocale(locale: string | undefined): RecommendationFlowLocale {
	return locale === "ko" ? "ko" : "ja";
}

export function getRecommendationFlowStatusUiText(
	locale?: string,
): RecommendationFlowStatusUiText {
	return UI_TEXT[normalizeLocale(locale)];
}

function statusLabel(
	status: FlowCheckStatus,
	locale: RecommendationFlowLocale,
): RecommendationFlowStatusCheckView["statusLabel"] {
	return STATUS_LABELS[locale][status];
}

function checkTitle(key: string, locale: RecommendationFlowLocale): string {
	const titles: Record<string, string> = {
		discovery_run: "Discovery run",
		discovery_products: locale === "ko" ? "Discovery 후보" : "Discovery候補",
		discovery_home_shopping: CARD_TEXT[locale].home_discovery.title,
		discovery_live_commerce: CARD_TEXT[locale].live_discovery.title,
		c_package_candidate: "C package",
		promoted_product: locale === "ko" ? "Research 승격" : "Research昇格",
		promoted_research: locale === "ko" ? "Research 결과" : "Research結果",
		md_strategy: CARD_TEXT[locale].strategy.title,
		integrated_md_strategy: locale === "ko" ? "통합 근거" : "統合根拠",
		linked_screenplay: locale === "ko" ? "연결 대본" : "連携台本",
		promoted_linked_screenplay: locale === "ko" ? "승격 상품 대본" : "昇格商品台本",
		category_normalization_cache: locale === "ko" ? "카테고리 정규화" : "カテゴリ正規化",
		broadcast_category_coverage: locale === "ko" ? "방송 카테고리" : "放送カテゴリ",
		operator_fit_category_coverage: locale === "ko" ? "운영자 평가 카테고리" : "運営者評価カテゴリ",
	};
	return titles[key] ?? key;
}

function checkMessage(
	status: RecommendationFlowStatus,
	key: string,
	locale: RecommendationFlowLocale,
): string {
	const homeRun = status.evidence.contextDiscoveryRuns.find(
		(item) => item.context === "home_shopping",
	);
	const liveRun = status.evidence.contextDiscoveryRuns.find(
		(item) => item.context === "live_commerce",
	);

	switch (key) {
		case "discovery_run":
			if (locale === "ko") {
				return status.evidence.latestDiscoveryRun
					? "최신 Discovery run을 확인했습니다."
					: "Discovery run이 아직 없습니다.";
			}
			return status.evidence.latestDiscoveryRun
				? "最新Discovery runを確認済みです。"
				: "Discovery runがまだありません。";
		case "discovery_products":
			if (locale === "ko") {
				return status.evidence.latestDiscoveryProductCount > 0
					? `최신 Discovery run에 후보가 ${status.evidence.latestDiscoveryProductCount}개 있습니다.`
					: "최신 Discovery run에 후보 상품이 없습니다.";
			}
			return status.evidence.latestDiscoveryProductCount > 0
				? `最新Discovery runに候補が${status.evidence.latestDiscoveryProductCount}件あります。`
				: "最新Discovery runに候補商品がありません。";
		case "discovery_home_shopping":
			if (locale === "ko") {
				return homeRun?.status === "completed" && homeRun.productCount > 0
					? `home_shopping Discovery run은 완료 상태입니다 (${homeRun.productCount}개).`
					: "home_shopping Discovery run이 완료 상태가 아니거나 후보가 없습니다.";
			}
			return homeRun?.status === "completed" && homeRun.productCount > 0
				? `home_shopping Discovery runは完了済みです (${homeRun.productCount}件)。`
				: "home_shopping Discovery runが完了していないか、候補がありません。";
		case "discovery_live_commerce":
			if (locale === "ko") {
				return liveRun?.status === "completed" && liveRun.productCount > 0
					? `live_commerce Discovery run은 완료 상태입니다 (${liveRun.productCount}개).`
					: "live_commerce Discovery run이 완료 상태가 아니거나 후보가 없습니다.";
			}
			return liveRun?.status === "completed" && liveRun.productCount > 0
				? `live_commerce Discovery runは完了済みです (${liveRun.productCount}件)。`
				: "live_commerce Discovery runが完了していないか、候補がありません。";
		case "c_package_candidate":
			if (locale === "ko") {
				return status.evidence.promotableCandidate
					? `Research 승격 가능한 C package 후보가 있습니다 (${status.evidence.promotableCandidate.id}).`
					: "Research 승격에 사용할 C package 완료 후보가 없습니다.";
			}
			return status.evidence.promotableCandidate
				? `Research昇格可能なC package候補があります (${status.evidence.promotableCandidate.id})。`
				: "Research昇格に使えるC package完了候補がありません。";
		case "promoted_product":
			if (locale === "ko") {
				return status.evidence.promotedProduct
					? `Discovery 후보가 Research 상품으로 승격됐습니다 (${status.evidence.promotedProduct.status ?? "status unknown"}).`
					: "Discovery 후보가 아직 Research 상품으로 승격되지 않았습니다.";
			}
			return status.evidence.promotedProduct
				? `Discovery候補からResearch商品へ昇格済みです (${status.evidence.promotedProduct.status ?? "status unknown"})。`
				: "Discovery候補がまだResearch商品へ昇格されていません。";
		case "promoted_research":
			if (locale === "ko") {
				return status.evidence.promotedResearchResult
					? "승격된 Research 상품의 분석 결과가 있습니다."
					: "승격된 Research 상품의 분석 결과가 아직 없습니다.";
			}
			return status.evidence.promotedResearchResult
				? "昇格Research商品の分析結果があります。"
				: "昇格Research商品の分析結果がまだありません。";
		case "md_strategy":
			if (locale === "ko") {
				return status.evidence.latestMdStrategy
					? `MD 전략이 있습니다 (${status.evidence.latestMdStrategy.user_goal ?? "goal 없음"}).`
					: "MD 전략 결과가 아직 없습니다.";
			}
			return status.evidence.latestMdStrategy
				? `MD戦略があります (${status.evidence.latestMdStrategy.user_goal ?? "目標なし"})。`
				: "MD戦略結果がまだありません。";
		case "integrated_md_strategy":
			if (locale === "ko") {
				return status.evidence.integratedMdStrategy
					? `내부 실적 ${status.evidence.integratedMdStrategy.internalProductCount}개와 외부 후보 ${status.evidence.integratedMdStrategy.externalCandidateCount}개를 포함한 MD 전략이 있습니다.`
					: "내부 실적과 Discovery pool 외부 후보를 함께 포함한 MD 전략이 없습니다.";
			}
			return status.evidence.integratedMdStrategy
				? `内部実績${status.evidence.integratedMdStrategy.internalProductCount}件と外部候補${status.evidence.integratedMdStrategy.externalCandidateCount}件を含むMD戦略があります。`
				: "内部実績とDiscovery pool外部候補を同時に含むMD戦略がありません。";
		case "linked_screenplay":
			if (locale === "ko") {
				return status.evidence.latestLinkedScreenplay?.status === "ready"
					? "Research 상품에 연결된 ready 대본이 있습니다."
					: "Research 상품에 연결된 ready 대본이 없습니다.";
			}
			return status.evidence.latestLinkedScreenplay?.status === "ready"
				? "Research商品に紐づくready台本があります。"
				: "Research商品に紐づくready台本がありません。";
		case "promoted_linked_screenplay":
			if (locale === "ko") {
				return status.evidence.promotedLinkedScreenplay?.status === "ready"
					? "승격된 Research 상품에 연결된 ready 대본이 있습니다."
					: "승격된 Research 상품에 연결된 대본이 ready 상태가 아닙니다.";
			}
			return status.evidence.promotedLinkedScreenplay?.status === "ready"
				? "昇格Research商品に紐づくready台本があります。"
				: "昇格Research商品に紐づく台本がready状態ではありません。";
		case "category_normalization_cache": {
			const coverage = status.evidence.dataCoverage.categoryNormalization;
			if (locale === "ko") {
				return coverage.missingRawCategoryCount === 0
					? `Discovery raw category ${coverage.coveredRawCategoryCount}/${coverage.discoveredRawCategoryCount}개가 정규화 캐시에 연결되어 있습니다 (cache rows ${coverage.normalizedRawCategoryCount}개).`
					: `정규화 캐시에 없는 raw category가 ${coverage.missingRawCategoryCount}개 있습니다.`;
			}
			return coverage.missingRawCategoryCount === 0
				? `Discovery raw category ${coverage.coveredRawCategoryCount}/${coverage.discoveredRawCategoryCount}件が正規化キャッシュに接続済みです (cache rows ${coverage.normalizedRawCategoryCount}件)。`
				: `正規化キャッシュにないraw categoryが${coverage.missingRawCategoryCount}件あります。`;
		}
		case "broadcast_category_coverage": {
			const coverage = status.evidence.dataCoverage.broadcastCategories;
			if (locale === "ko") {
				return `방송 카테고리 coverage ${coverage.overallCoveragePct}%: QVC/ShopCh ${coverage.broadcastsWithCategory}/${coverage.broadcastsTotal}, OA ${coverage.historicalWithCategory}/${coverage.historicalTotal}.`;
			}
			return `放送カテゴリ coverage ${coverage.overallCoveragePct}%: QVC/ShopCh ${coverage.broadcastsWithCategory}/${coverage.broadcastsTotal}, OA ${coverage.historicalWithCategory}/${coverage.historicalTotal}.`;
		}
		case "operator_fit_category_coverage": {
			const coverage = status.evidence.dataCoverage.operatorFitCategories;
			if (locale === "ko") {
				return `운영자 fit 분석 카테고리 coverage ${coverage.coveragePct}% (${coverage.withCategory}/${coverage.total}).`;
			}
			return `運営者fit分析カテゴリ coverage ${coverage.coveragePct}% (${coverage.withCategory}/${coverage.total}).`;
		}
		default:
			if (locale === "ko") return "이 체크의 상태를 확인하세요.";
			return "このチェックの状態を確認してください。";
	}
}

export function buildRecommendationFlowStatusView(
	status: RecommendationFlowStatus,
	localeInput?: string,
): RecommendationFlowStatusView {
	const locale = normalizeLocale(localeInput);
	const failedRequiredCount = status.checks.filter(
		(check) => check.strictRequired && check.status !== "pass",
	).length;
	const optionalWarningCount = status.checks.filter(
		(check) => !check.strictRequired && check.status !== "pass",
	).length;
	const tone = status.strictReady ? "ready" : "blocked";

	return {
		headline: HEADLINE[locale][tone],
		tone,
		summary: status.strictReady
			? optionalWarningCount > 0
				? locale === "ko"
					? `필수 체크 통과 / 확인 필요 ${optionalWarningCount}개`
					: `必須チェック通過 / 注意 ${optionalWarningCount}件`
				: locale === "ko"
					? "모든 체크 통과"
					: "全チェック通過"
			: locale === "ko"
				? `필수 체크 ${failedRequiredCount}개 미통과`
				: `${failedRequiredCount}件の必須チェックが未通過`,
		cards: [
			{
				key: "home_discovery",
				title: CARD_TEXT[locale].home_discovery.title,
				status: statusForContext(status, "home_shopping"),
				metric: metricForContext(status, "home_shopping"),
				description: CARD_TEXT[locale].home_discovery.description,
			},
			{
				key: "live_discovery",
				title: CARD_TEXT[locale].live_discovery.title,
				status: statusForContext(status, "live_commerce"),
				metric: metricForContext(status, "live_commerce"),
				description: CARD_TEXT[locale].live_discovery.description,
			},
			{
				key: "research",
				title: CARD_TEXT[locale].research.title,
				status: researchStatus(status),
				metric: status.evidence.promotedProduct?.status ?? "missing",
				description: CARD_TEXT[locale].research.description,
			},
			{
				key: "strategy",
				title: CARD_TEXT[locale].strategy.title,
				status: status.evidence.integratedMdStrategy ? "pass" : "fail",
				metric: status.evidence.integratedMdStrategy
					? `${status.evidence.integratedMdStrategy.internalProductCount} / ${status.evidence.integratedMdStrategy.externalCandidateCount}`
					: "missing",
				description: CARD_TEXT[locale].strategy.description,
			},
			{
				key: "screenplay",
				title: CARD_TEXT[locale].screenplay.title,
				status: screenplayStatus(status),
				metric: status.evidence.promotedLinkedScreenplay?.status ?? "missing",
				description: CARD_TEXT[locale].screenplay.description,
			},
			{
				key: "data_coverage",
				title: CARD_TEXT[locale].data_coverage.title,
				status: dataCoverageStatus(status),
				metric: `${status.evidence.dataCoverage.categoryNormalization.cacheCoveragePct}%`,
				description: CARD_TEXT[locale].data_coverage.description,
			},
		],
		checks: status.checks.map((check) => ({
			key: check.key,
			title: checkTitle(check.key, locale),
			status: check.status,
			statusLabel: statusLabel(check.status, locale),
			required: check.strictRequired,
			message: checkMessage(status, check.key, locale),
		})),
	};
}
