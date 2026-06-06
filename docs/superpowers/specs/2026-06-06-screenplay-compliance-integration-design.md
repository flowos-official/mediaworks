# 台本生成 × コンプライアンス統合 設計 (A: 生成時予防 + B: ターゲット自動修正)

- Date: 2026-06-06
- Status: brainstorming approved → pending spec review
- Builds on: `2026-06-02-screenplay-check-tool-design.md` (考査 v1), `2026-06-04-screenplay-check-grounding-design.md` (考査 v2), 台本生成パイプライン (`lib/screenplay/*`)

## 1. 배경 / 문제

考査(check) 도구는 6월에 룰/근거 코퍼스를 확장했지만, **그 룰은 검수 단계에서만 소비**된다. 두 파이프라인이 분리돼 있다:

- **생성**: `lib/screenplay/prompt.ts`의 `SYSTEM_INSTRUCTION`은 **하드코딩된 금지사항**만 가지며, `compliance_rules` / `compliance_references` DB를 **전혀 읽지 않는다**(검증: 생성 경로 전체에 compliance import 0건). 외부 입력은 `style-bible.json` 파일 하나뿐.
- **검수**: `lib/screenplay/compliance/check.ts`가 런타임에 `loadActiveRules()` / `loadActiveReferences()`로 DB 룰을 읽어 검수 프롬프트에 주입.

결과적으로 룰을 추가해도 **생성된 대본을 사후 "검출"하는 능력만 강화**되고, **생성 시점에 룰을 "준수/예방"하지는 못한다**. 또한 위반을 고치려면 오퍼레이터가 findings를 수동으로 `refine` feedback에 옮겨 적어야 한다(check→refine 자동 연결 없음).

추가로, 현행 `refine` 모드는 **전체 대본을 통째로 재출력**한다(`prompt.ts` "差分ではなく全文出力"). 자동 교정에 그대로 쓰면 위반 1건에도 Pro+HIGH 풀생성이 발생하고(3~6분/회), **깨끗한 섹션까지 흔들려 새 위반을 유발**할 수 있어 비효율적이다.

## 2. 목표 / 비목표

**목표**
- **(A) 생성 시점 예방**: 상품 카테고리에 해당하는 NG/허용 패턴 + 근거 코퍼스를 **생성 프롬프트에 주입**해, AI가 룰을 "알고" 초안을 쓰게 한다. 비용 거의 0(프롬프트 확장뿐) → 항상 ON.
- **(B) 사후 자동 교정 루프**: 생성 직후 考査(corpus-only)를 돌려, high severity 위반이 있으면 **문제 부분만 효율적으로** 교정하고 재검수한다(최대 3회). 하이브리드(결정론 치환 → 섹션 단위 재생성)로 **전체 재생성을 피한다**.

**비목표 (v1 제외)**
- 중간 교정 버전의 영속화(최종본만 저장).
- 위치를 특정할 수 없는 구조적/품질 위반의 자동 수정(잔여로 표시, 오퍼레이터 처리).
- 루프 내 외부 웹 검색(미공개 카피 외부 유출 금지 — Codex #1 준수, corpus-only).
- 전량 룰 주입(카테고리 스코프만).
- 신규 UI 컴포넌트(기존 `CheckResultPanel`이 교정 후 결과를 그대로 표시; "自動修正 N件" 배지는 선택).

## 3. 아키텍처 개요

```
A(예방):  카테고리 룰/근거 로드 → 생성 프롬프트 주입 → 룰을 "아는" 초안
B(교정):  generate(A 적용)
            → check(corpus-only) → result(findings)
            → while hasHigh(result) && iter < MAX(3):
                 md = Tier1: applyDeterministicPatches(md, findings)   # LLM 0회
                 md = Tier2: remediateSections(md, remaining, …)        # 해당 액트 섹션만
                 result = check(md, corpus-only)
                 iter++
            → persist(최종 md) + persist(최종 check + remediation trail)
```

A가 초안 위반을 줄여 B 루프가 보통 0~1회로 수렴(시너지). 모든 단계는 Vercel Workflow의 durable `"use step"`.

## 4. A — 생성 시점 예방

### 4.1 컴포넌트
- **`lib/screenplay/compliance/context.ts`** (신규, pure — `server-only` import 금지, tsx 테스트 가능)
  - `buildGenerationComplianceBlock(category: string | null, rules: ComplianceRule[], references: ComplianceReference[]): string`
  - 카테고리 스코프 필터(`category_scope` 비었으면 전체, 아니면 category 포함). `lib/screenplay/compliance/lexicon-match.ts`의 `inScope`, `reference-retrieval.ts`의 스코프 로직과 동일 의미(중복 최소화 위해 필요 시 헬퍼 추출).
  - 구성:
    - `### 禁止表現（使用しない）`: `!allowed` NG 패턴 + `reason` (cap `GEN_NG_CAP`, 기본 40)
    - `### 許容表現（これは問題ない）`: `allowed` 패턴 (cap 30) — 56効能 등 과대 위축 방지
    - `### 根拠資料（カテゴリ基準）`: references `topic` + `body` 발췌 + `citation` (cap `GEN_REF_CAP`, 기본 6, body는 ~300자 절단)
  - 헤더: `## コンプライアンス遵守ルール（生成時に厳守）` + 1줄 지시("以下のNG表現を避け、許容表現・根拠資料の範囲で訴求すること").
  - 룰/근거 0건이면 **빈 문자열 반환**(graceful no-op).

### 4.2 타입 / 프롬프트
- **`lib/screenplay/types.ts`**: `GenerateInput`에 `complianceBlock?: string` 추가.
- **`lib/screenplay/prompt.ts`** `buildUserPrompt`: `input.complianceBlock`가 비어있지 않으면 **initial·refine 양쪽**에서 상품 브리프 직후, style-bible 앞에 주입. 블록 앞에 `--- 必須遵守 ---` 마킹. (style-bible은 "참고", compliance는 "필수"로 우선순위 구분.)

### 4.3 워크플로 결선
- **`lib/workflows/screenplay.workflow.ts`** `generateStep`(또는 신규 `loadComplianceStep`):
  - `loadActiveRules()` + `loadActiveReferences()` 병렬 로드(이미 존재).
  - `buildGenerationComplianceBlock(brief.category ?? null, rules, references)` → block.
  - `generateScreenplay({ …, complianceBlock: block })`.
  - 로드 실패는 non-fatal(빈 블록으로 진행).

## 5. B — 타깃 자동 교정 (하이브리드)

### 5.1 섹션 분할/병합
- **`lib/screenplay/sections.ts`** (신규, pure)
  - `type Section = { heading: string; level: 2 | 3; text: string; start: number; end: number }` (text = 헤딩 포함 원문 verbatim, start/end = 문자 오프셋).
  - `splitSections(md: string): Section[]` — `^## ` / `^### ` 경계로 분절. 첫 헤딩 이전 서두(메타/구성)는 level 2의 prologue 섹션으로 취급하거나 별도 보존. 헤딩 없는 본문도 손실 없이 보존(전부 합치면 원문과 동일해야 함 — 라운드트립 불변식).
  - `spliceSection(md: string, section: Section, newText: string): string` — 오프셋 기반 치환(원문 다른 부분 무손실).
  - 라운드트립 불변식: `splitSections(md).map(s=>s.text).join("") === md` (서두/구분자 포함).

### 5.2 교정 엔진
- **`lib/screenplay/remediate.ts`** (신규)
  - **Tier 1 — 결정론 치환** `applyDeterministicPatches(md, findings): { md, patched, remaining }`
    - 대상: `suggestedRewrite`(LLM) 또는 `safe_rewrite`(lexicon) 비어있지 않고, `quote`가 `md`에 **정확 substring 매칭**되는 finding.
    - `quote.length >= 3` 가드(과도 일반 매칭 방지), 빈 quote skip.
    - 매칭 occurrence를 치환(전체 occurrence). 미매칭은 `remaining`으로.
    - LLM 호출 0회. lexicon NG 대부분이 여기서 해소.
  - **Tier 2 — 섹션 재생성** `remediateSections(md, remaining, brief, complianceBlock): Promise<string>`
    - `remaining` finding을 `quote` 위치로 섹션 그룹핑(`splitSections` 사용). **주의**: Tier1이 md를 이미 변경했으므로 위치는 **Tier1 적용 후의 현재 md 기준으로 `indexOf` 재탐색**(stale 오프셋 재사용 금지). 위치 못 찾는 finding은 `unlocatable`로 분리 → 로깅(v1 자동수정 제외).
    - 영향받은 섹션마다 집중 프롬프트로 재생성(`sectionRewritePrompt`): "이 액트 1개만, 아래 컴플라이언스 이슈(quote/reason/suggestedRewrite + 근거)를 해소하도록 재작성. 화자/연출 큐/구조/길이/100% 일본어 유지. 이 섹션 markdown만 출력." → `spliceSection`으로 병합.
    - **모델: Flash-first + Pro fallback**(`GEMINI_MODELS_WITH_FALLBACK`, `check.ts`의 `callGemini` 패턴 재사용). 섹션 단위 제약 편집이라 Flash로 충분, 전체 재생성 대비 훨씬 저렴.
    - 재생성 섹션 검증: 빈/과소(예: 원본의 30% 미만) 출력이면 **원본 섹션 유지**(파손 방지).
  - `remediate(md, findings, brief, block)` — Tier1 → Tier2 오케스트레이션, `{ md, tier1Count, sectionsRewritten, unlocatable }` 반환.

### 5.3 워크플로 루프
- **`lib/workflows/screenplay.workflow.ts`** 재구성:
  - **순서 변경**: 기존 `generate → persist → checkStep(post-hoc)` → 신규 `generate → [check → remediate]loop → persist(final) → persist final check`.
  - 신규 `remediateLoopStep`(durable) 또는 워크플로 본문에서 step 조합:
    ```
    md = generate(...)
    result = checkScreenplay(md, brief, rules, refs)        # corpus-only (factSearch 미지정)
    let iter = 0, trail = []
    while AUTO_REMEDIATE && hasHighViolation(result) && iter < MAX_REMEDIATE_ITERS:
      const before = result.overallScore
      const r = await remediate(md, allFindings(result), brief, block)
      md = r.md
      result = checkScreenplay(md, brief, rules, refs)
      trail.push({ iter, tier1: r.tier1Count, sections: r.sectionsRewritten, scoreBefore: before, scoreAfter: result.overallScore, residualHigh: countHigh(result) })
      iter++
    ```
  - `persistStep(md)` → 최종본만 버전 저장(중간 버전 미저장).
  - 최종 `result`를 `screenplay_version_checks`에 저장(`is_auto=true`, `created_by=null`), `result.remediation = { enabled, iterations: trail, finalHigh }` 포함.
  - `MAX_REMEDIATE_ITERS = 3`, `AUTO_REMEDIATE = process.env.SCREENPLAY_AUTO_REMEDIATE !== "false"`.

### 5.4 트리거 판정
- **`lib/screenplay/compliance/check.ts`** (또는 remediate.ts)에 `hasHighViolation(result): boolean` 헬퍼:
  - `result.legal` ∪ `result.facts` 중 `severity === "high"`가 1개라도 있으면 true.
  - lexicon NG(source `"lexicon"`)는 결정론적 위반이므로 severity 무관하게 포함(legal 축에 들어옴).
  - quality 축은 트리거에서 제외(구조 권고는 자동수정 비대상).

## 6. 에러 처리 (non-fatal 일관)
- 교정 전체는 **non-fatal**: LLM 에러/splice 불일치/예외 시 **마지막 정상 `md` 유지, 루프 중단, 그대로 persist + warn 로그**. 생성은 교정 실패로 **절대 깨지지 않음**(현 `checkStep` 철학 계승).
- Tier1: 정확 매칭만 → 미스매치 시 본문 훼손 0.
- Tier2: 섹션 재생성 실패/과소 출력 → 해당 섹션 원본 유지.
- 루프 내 모든 check는 **corpus-only**(`factSearch` 미지정) → 미공개 카피 외부 egress 0.
- 루프 상한 3 + 각 LLM 호출 타임아웃(`check.ts` callOnce의 60s 패턴 재사용).
- 무한루프 방지: `hasHighViolation`이 줄지 않아도 `iter < 3`에서 종료.

## 7. 데이터 / 타입 변경
- `types.ts`: `GenerateInput.complianceBlock?: string`; `ScriptCheckResult`(또는 `GroundingMeta` 인근)에 선택적 `remediation?: { enabled: boolean; iterations: RemediationStep[]; finalHigh: number }`, `RemediationStep = { iter, tier1, sections, scoreBefore, scoreAfter, residualHigh }`.
- DB 스키마 변경 **없음**(remediation trail은 기존 `screenplay_version_checks.result` JSONB에 포함). 마이그레이션 불필요.

## 8. 테스트
- pure 단위(tsx, env 불필요):
  - `scripts/test-screenplay-sections.ts` — split/splice 라운드트립 불변식, 오프셋 정확성, 헤딩 없는 서두 보존.
  - `scripts/test-screenplay-remediate.ts`(Tier1 부분) — 정확 치환/미스매치 skip/다중 occurrence/`quote<3자` 가드.
  - `scripts/test-compliance-context.ts` — 카테고리 스코프, cap, 빈-입력 no-op, NG/허용/근거 포맷.
- skip-guard 스모크(`.env.local` + Gemini 필요): Tier2 `remediateSections` 1섹션 재생성, 워크플로 루프 1회.
- 기존 `npm run test:screenplay-check`, `test:compliance-*` 회귀 통과 유지.
- `npx tsc --noEmit`.
- package.json 별칭 추가: `test:screenplay-sections`, `test:screenplay-remediate`, `test:compliance-context`.

## 9. 변경 파일
**신규**
- `lib/screenplay/compliance/context.ts` (A)
- `lib/screenplay/sections.ts` (B)
- `lib/screenplay/remediate.ts` (B)
- `scripts/test-screenplay-sections.ts`, `scripts/test-screenplay-remediate.ts`, `scripts/test-compliance-context.ts`

**수정**
- `lib/screenplay/types.ts` (`complianceBlock`, `remediation` trail 타입)
- `lib/screenplay/prompt.ts` (블록 주입 — initial·refine)
- `lib/workflows/screenplay.workflow.ts` (A 로드/주입; B 루프 + trail + flag; 순서 재구성)
- `lib/screenplay/compliance/check.ts` (`hasHighViolation` export; 필요 시 스코프 헬퍼 추출)
- `.env.example` (`SCREENPLAY_AUTO_REMEDIATE`, 선택 `GEN_NG_CAP`/`GEN_REF_CAP`/`MAX_REMEDIATE_ITERS`)

## 10. 범위 경계 (YAGNI)
- 중간 교정 버전 저장 ✕ / 구조적 위반 자동수정 ✕(잔여 표시) / 루프 내 웹검색 ✕ / 전량 룰 주입 ✕ / 신규 UI 필수 ✕.
- A는 무플래그 항상 ON(룰 없으면 no-op). B만 env로 게이트(기본 ON).

## 11. 미해결 / 후속
- Tier2 섹션 모델을 Pro로 올릴지(품질) 운영 데이터로 재평가(현 Flash-first).
- "自動修正 N件 / 残課題 M件" 배지를 `CheckResultPanel`에 노출(후속 UI).
- 구조적/품질 위반 자동수정(액트 삽입) — 별도 설계.
- A 주입이 생성 토큰/지연에 주는 영향 측정 후 cap 튜닝.
