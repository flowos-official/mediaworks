import type { MdStrategyEvidenceSummary } from "@/lib/recommendation/strategy-evidence";

export type FlowCheckStatus = "pass" | "warn" | "fail";

export interface RecommendationFlowEvidence {
	latestDiscoveryRun: {
		id: string;
		context: string | null;
		status: string | null;
	} | null;
	latestDiscoveryProductCount: number;
	contextDiscoveryRuns: Array<{
		context: "home_shopping" | "live_commerce";
		status: string | null;
		productCount: number;
	}>;
	promotableCandidate: { id: string; name: string } | null;
	promotedProduct: {
		id: string;
		name: string | null;
		status: string | null;
		discovered_product_id: string | null;
	} | null;
	promotedResearchResult: { product_id: string } | null;
	latestMdStrategy: { id: string; user_goal: string | null } | null;
	integratedMdStrategy: MdStrategyEvidenceSummary | null;
	latestLinkedScreenplay: { id: string; product_id: string | null; status: string | null } | null;
	promotedLinkedScreenplay: { id: string; product_id: string | null; status: string | null } | null;
	dataCoverage: {
		categoryNormalization: {
			discoveredRawCategoryCount: number;
			coveredRawCategoryCount: number;
			normalizedRawCategoryCount: number;
			missingRawCategoryCount: number;
			cacheCoveragePct: number;
		};
		broadcastCategories: {
			broadcastsTotal: number;
			broadcastsWithCategory: number;
			historicalTotal: number;
			historicalWithCategory: number;
			overallCoveragePct: number;
		};
		operatorFitCategories: {
			total: number;
			withCategory: number;
			coveragePct: number;
		};
	};
}

export interface RecommendationFlowCheck {
	key: string;
	status: FlowCheckStatus;
	message: string;
	strictRequired: boolean;
}

function check(
	key: string,
	status: FlowCheckStatus,
	message: string,
	strictRequired = true,
): RecommendationFlowCheck {
	return { key, status, message, strictRequired };
}

function promoteCommand(candidate: { id: string; name: string } | null): string {
	if (!candidate) return "먼저 C package 완료 discovery 후보를 만들어야 함";
	return `npx tsx --env-file=.env.local scripts/promote-discovered-to-research.ts --id=${candidate.id} --apply`;
}

export function buildRecommendationFlowChecks(
	evidence: RecommendationFlowEvidence,
): RecommendationFlowCheck[] {
	const checks: RecommendationFlowCheck[] = [];
	const categoryCoverage = evidence.dataCoverage.categoryNormalization;
	const broadcastCoverage = evidence.dataCoverage.broadcastCategories;
	const operatorFitCoverage = evidence.dataCoverage.operatorFitCategories;

	if (evidence.latestDiscoveryRun) {
		checks.push(
			check(
				"discovery_run",
				"pass",
				`Discovery run 있음 (${evidence.latestDiscoveryRun.context}, ${evidence.latestDiscoveryRun.status})`,
			),
		);
	} else {
		checks.push(check("discovery_run", "fail", "Discovery run 없음"));
	}

	if (evidence.latestDiscoveryProductCount > 0) {
		checks.push(
			check(
				"discovery_products",
				"pass",
				`Discovery 후보 ${evidence.latestDiscoveryProductCount}개 확인`,
			),
		);
	} else {
		checks.push(check("discovery_products", "fail", "최신 Discovery run에 후보 상품 없음"));
	}

	for (const context of ["home_shopping", "live_commerce"] as const) {
		const run = evidence.contextDiscoveryRuns.find((item) => item.context === context);
		if (run?.status === "completed" && run.productCount > 0) {
			checks.push(
				check(
					`discovery_${context}`,
					"pass",
					`${context} Discovery run 완료 (${run.productCount}개 후보)`,
				),
			);
		} else {
			checks.push(
				check(
					`discovery_${context}`,
					"fail",
					`${context} Discovery run이 완료 상태가 아니거나 후보가 없음`,
				),
			);
		}
	}

	if (evidence.promotableCandidate) {
		checks.push(
			check(
				"c_package_candidate",
				"pass",
				`C package 완료 후보 있음 (${evidence.promotableCandidate.id})`,
			),
		);
	} else {
		checks.push(
			check(
				"c_package_candidate",
				"warn",
				"C package 완료 discovery 후보 없음",
			),
		);
	}

	if (evidence.promotedProduct) {
		checks.push(
			check(
				"promoted_product",
				"pass",
				`Discovery→Research 승격 상품 있음 (${evidence.promotedProduct.status})`,
			),
		);
	} else {
		checks.push(
			check(
				"promoted_product",
				"warn",
				`Discovery 후보가 Research 상품으로 승격되지 않음. 실행: ${promoteCommand(
					evidence.promotableCandidate,
				)}`,
			),
		);
	}

	if (evidence.promotedResearchResult) {
		checks.push(check("promoted_research", "pass", "승격 상품의 Research 결과 있음"));
	} else {
		checks.push(
			check(
				"promoted_research",
				"warn",
				evidence.promotedProduct
					? "승격 상품의 Research 결과가 아직 없음. synthesize 실행/완료 필요"
					: "승격 상품이 없어 Research 결과를 확인할 수 없음",
			),
		);
	}

	if (evidence.latestMdStrategy) {
		checks.push(
			check(
				"md_strategy",
				"pass",
				`MD Strategy 있음 (${evidence.latestMdStrategy.user_goal ?? "no user goal"})`,
			),
		);
	} else {
		checks.push(check("md_strategy", "warn", "MD Strategy 결과 없음"));
	}

	if (evidence.integratedMdStrategy) {
		checks.push(
			check(
				"integrated_md_strategy",
				"pass",
				`내부 실적 ${evidence.integratedMdStrategy.internalProductCount}개와 Discovery pool 외부 후보를 포함한 MD Strategy 있음 (외부 ${evidence.integratedMdStrategy.externalCandidateCount}개, ${evidence.integratedMdStrategy.poolSources.join(", ") || "source unknown"})`,
			),
		);
	} else {
		checks.push(
			check(
				"integrated_md_strategy",
				"warn",
				"내부 실적과 Discovery pool 외부 후보를 함께 포함한 MD Strategy 결과 없음",
			),
		);
	}

	if (evidence.latestLinkedScreenplay) {
		const ready = evidence.latestLinkedScreenplay.status === "ready";
		checks.push(
			check(
				"linked_screenplay",
				ready ? "pass" : "warn",
				ready
					? "product_id 연결 screenplay 있음 (ready)"
					: `product_id 연결 screenplay가 ready 상태가 아님 (${evidence.latestLinkedScreenplay.status})`,
			),
		);
	} else {
		checks.push(check("linked_screenplay", "warn", "product_id 연결 screenplay 없음"));
	}

	if (evidence.promotedLinkedScreenplay) {
		const ready = evidence.promotedLinkedScreenplay.status === "ready";
		checks.push(
			check(
				"promoted_linked_screenplay",
				ready ? "pass" : "warn",
				ready
					? "승격 상품 연결 screenplay 있음 (ready)"
					: `승격 상품 연결 screenplay가 ready 상태가 아님 (${evidence.promotedLinkedScreenplay.status})`,
			),
		);
	} else {
		checks.push(
			check(
				"promoted_linked_screenplay",
				"warn",
				evidence.promotedProduct
					? "승격 상품에 연결된 screenplay 없음"
					: "승격 상품이 없어 promoted product screenplay를 확인할 수 없음",
			),
		);
	}

	if (
		categoryCoverage.discoveredRawCategoryCount > 0 &&
		categoryCoverage.missingRawCategoryCount === 0
	) {
		checks.push(
			check(
				"category_normalization_cache",
				"pass",
				`카테고리 정규화 캐시가 discovery raw category ${categoryCoverage.coveredRawCategoryCount}/${categoryCoverage.discoveredRawCategoryCount}개를 커버함 (cache rows ${categoryCoverage.normalizedRawCategoryCount}개)`,
			),
		);
	} else {
		checks.push(
			check(
				"category_normalization_cache",
				"fail",
				`카테고리 정규화 캐시 누락 ${categoryCoverage.missingRawCategoryCount}개 (coverage ${categoryCoverage.cacheCoveragePct}%)`,
			),
		);
	}

	const hasBroadcastGap =
		broadcastCoverage.broadcastsTotal === 0 ||
		broadcastCoverage.broadcastsWithCategory === 0 ||
		(broadcastCoverage.historicalTotal > 0 &&
			broadcastCoverage.historicalWithCategory === 0) ||
		broadcastCoverage.overallCoveragePct < 20;
	checks.push(
		check(
			"broadcast_category_coverage",
			hasBroadcastGap ? "warn" : "pass",
			`방송 카테고리 coverage ${broadcastCoverage.overallCoveragePct}% (QVC/ShopCh ${broadcastCoverage.broadcastsWithCategory}/${broadcastCoverage.broadcastsTotal}, OA ${broadcastCoverage.historicalWithCategory}/${broadcastCoverage.historicalTotal})`,
			false,
		),
	);

	checks.push(
		check(
			"operator_fit_category_coverage",
			operatorFitCoverage.total > 0 &&
				operatorFitCoverage.withCategory === operatorFitCoverage.total
				? "pass"
				: "warn",
			`운영자 fit 분석 카테고리 coverage ${operatorFitCoverage.coveragePct}% (${operatorFitCoverage.withCategory}/${operatorFitCoverage.total})`,
			false,
		),
	);

	return checks;
}

export function hasStrictFailures(checks: RecommendationFlowCheck[]): boolean {
	return checks.some((item) => item.strictRequired && item.status !== "pass");
}

export function summarizeStrictFailures(checks: RecommendationFlowCheck[]): string {
	return checks
		.filter((item) => item.strictRequired && item.status !== "pass")
		.map((item) => `- ${item.message}`)
		.join("\n");
}

export function formatFlowCheck(check: RecommendationFlowCheck): string {
	const prefix =
		check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
	return `${prefix}: ${check.message}`;
}
