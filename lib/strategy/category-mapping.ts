/**
 * UI 카테고리 라벨(일본어) → sales DB 카테고리 배열 매핑.
 * - 戦略立案 입력 폼 옵션 (MDStrategyPanel CATEGORIES)
 * - discovered_products 카테고리 필터 (pool-query)
 * - product_summaries 카테고리 필터 (fetchStrategyContext)
 * 모두 동일한 매핑을 사용해야 한다.
 */
export const CATEGORY_MAPPING: Record<string, string[]> = {
	"美容・スキンケア": ["美容・運動", "化粧品"],
	"健康食品": ["食品"],
	"キッチン用品": ["キッチン"],
	"ファッション": ["アパレル", "靴・バッグ"],
	"生活雑貨": ["家電・雑貨", "掃除・洗濯"],
	"電気機器": ["家電・雑貨"],
	"フィットネス": ["美容・運動", "医療機器"],
	"その他": ["その他", "寝具", "宝飾", "防災・防犯", "ゴルフ"],
};

/**
 * UI category label → 매칭 가능한 sales DB 카테고리 배열.
 * 알 수 없는 라벨은 빈 배열 반환 (호출부가 fail-open 판단).
 */
export function mapUiCategoryToSalesCategories(ui: string | undefined): string[] {
	if (!ui) return [];
	return CATEGORY_MAPPING[ui] ?? [];
}
