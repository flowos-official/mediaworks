# Seed-Aware Strategy Generation Design Spec

- **Date**: 2026-04-18
- **Author**: MediaWorks Engineering
- **Status**: Draft (awaiting user review)
- **Target**: 発掘된 신상품(seed product) 의 상세 정보를 AI 프롬프트에 주입해 拡大戦略 + ライブコマース戦略 정확도 대폭 향상
- **Depends on**: Phase 1-4 완료 (특히 enrichment C 패키지, 메뉴 재그룹핑)
- **Out of scope**: 전략 결과의 라이브 재계산, seed 이력 추적 테이블

---

## 1. 목적 (Goal)

`/analytics/strategy/expansion` 과 `/analytics/strategy/live` 가 현재 `product_summaries` (기존 TV 매출)만 분석 입력으로 사용한다. 발굴 카드에서 "戦略を作成" 버튼으로 넘어왔을 때 해당 신상품의 B 패키지(이름/가격/리뷰/판매자) + C 패키지(제조사/도매가/TV스크립트/SNS) 를 AI 프롬프트에 주입해, 추상적인 카테고리 평균이 아닌 **신상품 실제 데이터 기반 전략**이 생성되도록 한다.

### 1.1 성공 기준
- 발굴 카드 → 戦略作成 클릭 시 URL에 `seedId=<UUID>` 포함
- C 패키지 없을 때 사용자에게 "깊이 파기 자동 실행?" 선택 가능한 모달 표시 (Hybrid Gate)
- 戦略生成 시 Gemini prompt에 "新商品候補データ" + "深掘り情報" 섹션이 주입됨
- 결과 전략이 `product_summaries`를 참고로만 사용하고, 신상품 실제 가격/리뷰/제조사 수치에 맞게 생성됨

### 1.2 범위 밖 (Out of Scope)
- DB 스키마 변경 (md_strategies / live_commerce_strategies 그대로)
- seed 없는 기존 전략 생성 플로우는 동작 유지 (하위 호환)
- 전략 결과를 발굴 DB에 역참조 연결 (별도 phase)
- 전략 결과 "재생성" 시 새 seed 데이터 반영 UI

---

## 2. 아키텍처 개요

```
[사용자] 발굴 카드 "拡大戦略을作成" 클릭
  ↓
[SeedEnrichGate]
  ├─ C 패키지 있음 → 바로 navigate
  └─ 없음 → 모달: "자동 깊이 파기?"
      ├─ Yes: enrichment 실행 + 완료 대기 → navigate
      └─ No: seedId만 가지고 navigate
  ↓
URL: /analytics/strategy/{expansion|live}?seedId=<UUID>
  ↓
[MDStrategyPanel / LiveCommercePanel]
  - useSearchParams('seedId') 읽음
  - userGoal 자동 pre-fill (기존 동작 유지)
  - 戦略生成 버튼 클릭 시 body에 seedProductId 포함
  ↓
[POST /api/analytics/expansion or /live-commerce]
  - body.seedProductId → workflow input에 전달
  ↓
[workflow (md-strategy or live-commerce)]
  - loadSeedContext(seedProductId) 호출
  - 각 skill에 seedContext 전달
  ↓
[각 skill (Gemini call)]
  - prompt = 기본 프롬프트 + formatSeedPromptSection(seedContext)
  - Gemini가 seed 상세 데이터 기반으로 섹션 생성
  ↓
[결과 저장]
  md_strategies / live_commerce_strategies (기존 스키마)
```

---

## 3. 데이터 모델

### 3.1 공통 타입 (신규 파일: `lib/strategy/seed-context.ts`)

```typescript
export interface SeedContext {
	id: string;
	name: string;
	priceJpy: number | null;
	category: string | null;
	reviewCount: number | null;
	reviewAvg: number | null;
	sellerName: string | null;
	productUrl: string;
	tvFitScore: number;
	tvFitReason: string | null;
	context: "home_shopping" | "live_commerce";
	broadcastTag: "broadcast_confirmed" | "broadcast_likely" | "unknown" | null;

	enriched?: {
		manufacturer: {
			name: string | null;
			official_site: string | null;
			address: string | null;
			contact_hints: string[];
			confidence: "high" | "medium" | "low";
		};
		wholesale: {
			estimated_cost_jpy: number | null;
			estimated_margin_rate: number | null;
			method: string;
			confidence: "high" | "medium" | "low";
		};
		moqHint: string | null;
		tvScriptDraft: string;
		snsTrend: { signal_strength: string; sources: string[] };
	};
}

export async function loadSeedContext(seedProductId: string): Promise<SeedContext | null>;
export function formatSeedPromptSection(seed: SeedContext): string;
```

### 3.2 `loadSeedContext` 동작

```sql
SELECT id, name, price_jpy, category, review_count, review_avg, 
       seller_name, product_url, tv_fit_score, tv_fit_reason,
       context, broadcast_tag, c_package, enrichment_status
FROM discovered_products
WHERE id = $1
LIMIT 1;
```

- 없으면 `null` 반환 (API가 seed 없이 기존 방식으로 계속 진행)
- `c_package` (jsonb) 가 있으면 파싱하여 `enriched` 필드 채움
- `enrichment_status != 'completed'` 이면 `enriched` 제외 (partial data 방지)

### 3.3 `formatSeedPromptSection` 출력 예시

```
【新商品候補データ — 分析対象】
- 商品名: パナソニック ナノケアドライヤー EH-NA0J
- 価格: ¥38,000
- Rakuten評価: ★4.6 (3,422件)
- 販売者: Amazon.co.jp
- カテゴリ: 美容家電
- TVフィットスコア: 92/100
- TVフィット理由: 実演映え、ブランド信頼度、高級感のある価格帯
- 競合放送状況: 情報なし
- 対象チャネル: ホームショッピング
- 商品URL: https://item.rakuten.co.jp/.../

【深掘り情報】
- 製造元: パナソニック株式会社 (信頼度:高)
- 公式サイト: panasonic.jp
- 住所: 大阪府門真市...
- 連絡先: [panasonic-customer@jp.panasonic.com, 03-XXXX-XXXX]
- 卸値推定: ¥20,900 (マージン45%, 方法: blended, 信頼度:medium)
- 既存TVスクリプト案:
  "頭皮から美髪をケア..."
- SNSトレンド: high (tiktok, instagram)

【分析ガイダンス】
各スキルは上記の「新商品候補データ」を中心に具体的な戦略を生成してください。
product_summaries (既存MediaWorks実績) は「過去のカテゴリ成功パターン」の参考材料として使用してください。
```

`enriched` 가 없으면 "【深掘り情報】 未実行 — 詳細データなし" 로 표시.

---

## 4. API 변경

### 4.1 `POST /api/analytics/expansion`

**body 확장**:
```typescript
{
  userGoal?: string;        // 기존
  category?: string;        // 기존
  targetMarket?: string;    // 기존
  priceRange?: string;      // 기존
  focus?: string;           // 기존
  seedProductId?: string;   // NEW (optional)
}
```

- `seedProductId` 가 오면 workflow input에 전달
- 없으면 기존 동작 그대로

### 4.2 `POST /api/analytics/live-commerce`

**body 확장**:
```typescript
{
  userGoal?: string;              // 기존
  targetPlatforms?: string[];     // 기존
  seedProductId?: string;         // NEW (optional)
}
```

---

## 5. 워크플로 + Skills 프롬프트 변경

### 5.1 `lib/workflows/md-strategy.workflow.ts`

현재 workflow input:
```typescript
{ userGoal, category, targetMarket, priceRange, focus }
```

확장:
```typescript
{ userGoal, category, targetMarket, priceRange, focus, seedProductId? }
```

Workflow 시작 시:
```typescript
const seedContext = input.seedProductId 
  ? await loadSeedContext(input.seedProductId) 
  : null;
```

각 skill 호출에 `seedContext` 추가 (또는 workflow-scoped state에 저장).

### 5.2 `lib/md-strategy.ts` — 6 skills 프롬프트

각 skill 함수 시그니처 확장:
```typescript
// 기존
export async function runProductSelection(
  userGoal: string,
  productSummaries: ...,
  ...
): Promise<ProductSelectionOutput>;

// 확장
export async function runProductSelection(
  userGoal: string,
  productSummaries: ...,
  ...,
  seedContext?: SeedContext,
): Promise<ProductSelectionOutput>;
```

프롬프트 빌드 시:
```typescript
const seedSection = seedContext 
  ? `\n\n${formatSeedPromptSection(seedContext)}\n` 
  : '';
const prompt = `${existingBase}${seedSection}${existingRest}`;
```

적용 대상 6 skills:
- product_selection
- channel_strategy
- pricing_margin
- marketing_execution
- financial_projection
- risk_contingency

각 skill 내부 로직 변경 없음 — 프롬프트에 섹션만 추가.

### 5.3 `lib/live-commerce-strategy.ts` — 6 skills 프롬프트

6 skills 모두 동일 패턴:
- goal_analysis
- market_research
- platform_analysis
- content_strategy
- execution_plan
- risk_analysis

---

## 6. UI 변경

### 6.1 `SeedEnrichGate.tsx` (신규)

Props:
```typescript
{
  productId: string;
  enrichmentStatus: 'idle' | 'queued' | 'running' | 'completed' | 'failed';
  hasCPackage: boolean;
  targetHref: string;   // e.g. /ja/analytics/strategy/expansion?seedId=UUID
  children: React.ReactNode;  // 기존 버튼
}
```

동작:
- C 패키지 있음 (`hasCPackage === true`): children 클릭 시 바로 router.push(targetHref)
- 없음: children 클릭 시 모달 표시
  - "スキップ(簡易戦略)" → router.push(targetHref) 그대로
  - "深掘りして戦略作成" → enrichment POST → 완료 polling → router.push(targetHref)

### 6.2 `IntegrationActions.tsx` 수정

```tsx
// 기존
const href = `${targetPath}?${params.toString()}`;
// params: seed, category, sourceUrl, price

// 확장
params.set('seedId', productId);   // NEW
// 기존 seed, category, sourceUrl, price는 fallback으로 유지 (하위 호환)
const href = `${targetPath}?${params.toString()}`;
```

Wrap with SeedEnrichGate:
```tsx
<SeedEnrichGate
  productId={productId}
  enrichmentStatus={enrichmentStatus}
  hasCPackage={hasCPackage}
  targetHref={href}
>
  <Link href={href}>...</Link>
</SeedEnrichGate>
```

(Link는 실제 navigate 전 Gate가 가로챔)

### 6.3 `MDStrategyPanel.tsx` / `LiveCommercePanel.tsx` 수정

```typescript
const seedId = searchParams?.get("seedId") ?? null;

// 기존 userGoal pre-fill 유지
// 戦略生成 버튼 클릭 시:
body: JSON.stringify({
  userGoal,
  category,
  targetMarket,
  priceRange,
  seedProductId: seedId ?? undefined,  // NEW
}),
```

### 6.4 i18n 키 추가

```json
// messages/ja.json (discovery 블록)
"seedGateTitle": "深掘り情報なし",
"seedGateBody": "この商品はまだ詳細分析されていません。製造元・卸値・TVスクリプトなどが欠落します。戦略生成前に自動で深掘りしますか？",
"seedGateSkip": "スキップ(簡易戦略)",
"seedGateEnrich": "深掘りして戦略作成",
"seedGateRunning": "深掘り中...",
"seedGateFailed": "深掘り失敗. 簡易戦略で続行しますか？"

// messages/en.json
"seedGateTitle": "Deep Dive Missing",
"seedGateBody": "This product hasn't been deep-analyzed yet. Manufacturer/wholesale/TV-script info will be unavailable. Run deep dive before strategy generation?",
"seedGateSkip": "Skip (simple strategy)",
"seedGateEnrich": "Deep Dive & Generate",
"seedGateRunning": "Deep diving...",
"seedGateFailed": "Deep dive failed. Continue with simple strategy?"
```

---

## 7. 에러 처리

| 시나리오 | 처리 |
|---------|------|
| seedProductId 제공, DB에 없음 | `loadSeedContext` null 반환 → workflow가 seed 없이 진행 (경고 로깅) |
| seedProductId 제공, c_package 파싱 실패 | enriched 필드 없이 반환, 경고 로깅 |
| Gate에서 enrichment 실패 | 에러 토스트 + "簡易戦略で続行?" 재확인 |
| API body에 seedProductId 문자열 포맷 잘못 | Zod validation (추후) 혹은 undefined 처리 |

모든 실패는 **fail-open**: seed 없이 기존 전략 생성으로 폴백.

---

## 8. 파일 영향 요약

**신규**:
```
lib/strategy/seed-context.ts              — SeedContext 타입, loader, formatter
components/discovery/SeedEnrichGate.tsx   — C 패키지 유무 체크 + 팝업
```

**수정**:
```
app/api/analytics/expansion/route.ts              — body.seedProductId 수용
app/api/analytics/live-commerce/route.ts          — 동일
lib/workflows/md-strategy.workflow.ts             — workflow input에 seedProductId
lib/workflows/live-commerce.workflow.ts           — 동일
lib/md-strategy.ts                                — 6 skills 함수에 seedContext param + 프롬프트 주입
lib/live-commerce-strategy.ts                     — 6 skills 동일
components/discovery/IntegrationActions.tsx       — seedId URL param + Gate 래핑
components/analytics/MDStrategyPanel.tsx          — seedId 읽고 body 포함
components/analytics/LiveCommercePanel.tsx        — 동일
messages/ja.json, messages/en.json                — seedGate* 키 추가
```

---

## 9. 결정 기록

| # | 결정 | 근거 |
|---|------|------|
| 1 | Hybrid gate (C 패키지 없을 때 팝업) | 사용자가 속도 vs 품질 선택, 강제 없음 |
| 2 | 拡大 + ライブ 동시 적용 | 공통 seed util로 중복 감소, 일관된 UX |
| 3 | seed 정보는 옵션 (없어도 동작) | 하위 호환, 기존 전략 생성 플로우 유지 |
| 4 | product_summaries 보존 + seed 추가 | "과거 성공 패턴 vs 신상품" 비교 AI에게 제공 |
| 5 | C 패키지 파싱 (jsonb → 객체) 는 loadSeedContext가 담당 | 워크플로는 순수 객체만 봄 |
| 6 | TV 스크립트: C 패키지 것을 참고로 Gemini에 전달 | AI가 리파인 버전 생성 (재활용 + 개선) |
| 7 | DB 스키마 변경 없음 | md_strategies snapshot 그대로, seedProductId는 user_goal 텍스트에 녹아듦 |
| 8 | 실패 시 fail-open | seed 문제로 전체 전략 생성 막지 않음 |

---

## 10. 예상 효과 (사용자 워크플로)

### Before (현재)
```
발굴 → 拡大戦略作成 → userGoal에 제품명만 → AI가 일반적 전략 생성 
→ 사람이 "이 제품에 맞게" 수동 조정 (20-30분)
```

### After (옵션 C 적용)
```
발굴 → (자동/수동) 깊이 파기 → 拡大戦略作成 → seed 상세 데이터 AI 주입 
→ AI가 신상품 실제 데이터 기반 전략 생성 → 즉시 사용 가능
```

**효과 추정**:
- 전략 정확도: 일반 → 맞춤 (제품별 차별화)
- 사용자 조정 시간: 20-30분 → 2-5분
- AI 중복 작업: TV 스크립트 재생성 없음
- 공급망 연결: 제조사 정보 자동 포함 → 실행 가능 수준

---

## 11. 오픈 이슈

없음. 모든 결정 항목 해소.
