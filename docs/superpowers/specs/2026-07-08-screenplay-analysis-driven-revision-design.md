# 分析 기반 개정 방침(Analysis-driven Revision Plan) 설계

- 작성일: 2026-07-08
- 대상 화면: `/[locale]/screenplays/[id]` (제작 영역 상세, ReviewPanel `개정` 탭)
- 상태: Draft v2 (서브에이전트 코드-검증 리뷰 반영)

## 1. 배경 / 문제

현재 대본 상세 화면에는 세 가지 리뷰 탭이 있다: `試験結果`(compliance check), `변경점`(version diff), `개정`(수동 피드백으로 재생성).

지금은 초고를 올리면 **자동으로 分析(corpus check)** 이 붙어 `試験結果` 점수가 나온다. 하지만 그 분석 결과를 **"그래서 어떻게 개정할지"** 로 이어주는 다리가 없다. 개정하려면 사용자가 `개정` 탭에서 피드백을 **처음부터 직접** 써야 한다. 각 지적(finding)에 `修正案`(suggestedRewrite)이 붙어 있지만, 그것이 하나의 실행 가능한 개정 방침으로 묶여 사용자 검토 → 적용으로 흐르지 않는다.

원하는 흐름:

```
試験結果 분석(자동) → AI 개정 방침 제안(편집·가감 가능) + 내 피드백 병합
  → 개정본(第2稿) 생성 → 변경점 diff 확인 → 확정
```

즉 **분석 → 개정 방침(사람 검토) → 개정본** 의 반자동(human-in-the-loop) 개정 루프를 추가한다. 기존의 전자동 `remediate` 루프(생성/개정 시 high 위반을 사람 개입 없이 고침)와 달리, 이 기능은 **사람이 방침을 확인·수정한 뒤 승인**하는 것이 핵심이다.

## 2. 목표 / 비목표

### 목표
- `試験結果` findings(legal + facts + quality **전 관점**)를 바탕으로 간결하고 실행 가능한 **개정 방침**을 AI가 생성한다.
- 사용자가 방침을 **항목별로 취사선택(keep/제거)** 하고, **자유 피드백을 병합**한 뒤 승인한다.
- 승인 시 **기존 `/refine` 파이프라인을 그대로 재사용**해 개정본(第2稿)을 만든다 (구성 재배치 포함 가능).
- 초고(import)와 생성본 모두에 동일하게 동작한다.

### 비목표 (YAGNI)
- 방침을 별도 테이블에 **영속 저장하지 않는다** (client 상태만). 합성된 최종 지시는 第2稿의 `feedback` 컬럼에 남아 추적성은 유지된다 → **DB 스키마 변경 없음**.
- 방침 항목의 **본문 인라인 편집은 하지 않는다** (MVP): 항목은 keep/제거 토글만. 문구 보정은 자유 피드백 textarea로 흡수한다.
- 개정 **적용 전용 엔드포인트를 새로 만들지 않는다**: 승인은 기존 `POST /api/screenplays/:id/refine` 재사용.
- 다중 버전 동시 방침, 방침 버전 이력 UI 등은 다루지 않는다.

## 3. 현재 시스템(재사용 대상) — 코드 확인 완료

- `lib/screenplay/compliance/types.ts:20-38` — `Finding = { axis:"legal"|"facts"|"quality", severity:"high"|"med"|"low", quote, reason, citedRule, suggestedRewrite, source, references? }`; `ScriptCheckResult = { overallScore, legal[], facts[], quality[], grounding?, remediation? }`. **`Finding`에는 law code가 없다** — axis(3종)와 free-text `citedRule`만 있다.
- 채점: `check.ts:277-281` `score() = max(0, 100 - Σ penalty)`, penalty = high 15 / med 7 / low 3.
- `screenplay_version_checks`(`2026-06-03_...sql`) — `version_id, overall_score, result jsonb, is_auto, lexicon_version, created_by, created_at`, index `(version_id, created_at DESC)`. 최신 check 읽기 패턴은 `check/route.ts:45-51` 및 상세 페이지 `[id]/page.tsx:39-46` 참고.
- `lib/workflows/screenplay.workflow.ts:312-343` — `refine` mode: previousMarkdown 로드 → `generateScreenplay(feedback)` → check → `remediateLoopStep` → `persistStep(第2稿, base_version_id=이전)`.
- `POST /api/screenplays/[id]/refine`(`refine/route.ts`) — body `{ feedback, baseVersionId }` → `{ runId }`. **주의: `feedback` 비어있으면 400(:26), `feedback.length > 4000`이면 400(:32).** `getServiceClient()` + `requireUser` 사용, `baseVersionId`는 `screenplay_id` 스코프 확인(:64-77).
- `components/screenplay/ReviewPanel.tsx:78-85` — `개정` 탭(`refine`)에 `FeedbackForm` 렌더. `onRefineStart(runId)` → 상위 `ScreenplayWorkspace`가 `GenerationProgress` 부착 → 완료 시 diff 탭 전환.
- `lib/screenplay/remediate.ts:16` — `LlmCall = (prompt) => Promise<string>` 주입식(pure) 패턴. `check.ts:114-133 parseJSON`(fenced/balanced-brace) + `coerceFinding`(빈 quote drop, 필드 slice) 은 신규 모듈이 미러링할 파서/코어서 템플릿.

## 4. 설계

### 4.1 데이터 흐름

```
[개정 탭]
  1. [試験結果로 개정 방침 제안] 버튼
        │  POST /versions/:versionId/revision-plan
        ▼
  2. RevisionPlan 수신 → 항목 목록(각 keep/제거 토글) 렌더
        │
  3. + 내 피드백 textarea (+ 기존 자주 쓰는 요청 chips)
        │  [이 방침으로 개정]  ← 선택 항목 + 피드백 합성(4000자 캡)
        ▼
  4. POST /api/screenplays/:id/refine { feedback: 합성문, baseVersionId }
        │  (기존 파이프라인: generate → check → remediate → persist 第2稿)
        ▼
  5. GenerationProgress → 완료 → 변경점 diff 탭 자동 전환 → 확정
```

핵심: **1~3만 신규**, 4~5는 기존 흐름 그대로.

### 4.2 신규 모듈 — `lib/screenplay/revision-plan.ts`

`check.ts` / `remediate.ts` 와 동일하게 **LLM 호출을 주입식(`callLLM`)** 으로 받아 순수(pure)하게 유지 → tsx 스모크에서 fake LLM으로 테스트 가능.

```ts
export type LlmCall = (prompt: string) => Promise<string>;

export interface RevisionPlanItem {
  axis: "legal" | "facts" | "quality";
  severity: "high" | "med" | "low";
  target: string;       // 대본 내 대상(가능하면 verbatim JP 인용; 구성 항목은 위치 서술).
  instruction: string;  // 何を・なぜ・どう直すか (JP, 간결한 지시). axis 라벨 접두어를 넣지 않는다.
}
export interface RevisionPlan { items: RevisionPlanItem[] }

export async function buildRevisionPlan(
  markdown: string,
  brief: ProductBrief,
  check: ScriptCheckResult,
  callLLM: LlmCall,
): Promise<RevisionPlan>
```

- 입력: 해당 버전 markdown + brief + 최신 `ScriptCheckResult`(findings). **markdown은 `check.ts`와 동일하게 12000자로 slice** 후 프롬프트에 주입(비용/컨텍스트 방어).
- LLM 합성: findings를 **중복 제거·우선순위화**하고, 특히 quality 항목을 **구체적 구성 지시**(예: `実演デモを終盤へ移動`)로 승격. 단순 findings 나열이 아니라 실행 가능한 방침으로 올리는 것이 이 모듈의 가치(check가 이미 exact-dup을 제거하고 항목별 suggestedRewrite를 주므로, LLM의 순수 가치는 quality 재구성 + 관점 교차 근접중복 병합).
- 프롬프트는 **영어로 작성**(global rule), 입력 대본/브리프/findings는 데이터로 주입, 출력은 **JP `instruction` + 가능하면 verbatim JP `target`** 를 담은 순수 JSON.
- **JSON 파싱/코어스**: `check.ts::parseJSON`(코드펜스/prose 감싸기 견딤, balanced-brace) 재사용 또는 동형 구현. 각 item 코어스 시 **`instruction`·`target`이 모두 빈 항목은 drop**, 필드 길이 slice(quote/instruction ~300).
- **결정적 폴백** (LLM 실패/빈 응답): findings에서 직접 조립 — 각 finding → `{ axis, severity, target: quote, instruction: (suggestedRewrite || reason) }`. **`instruction`에 axis 접두어를 넣지 않는다**(라벨은 4.4 compose가 소유 → 이중 라벨 방지). quality의 빈 suggestedRewrite는 `reason`으로 대체. 이로써 LLM이 죽어도(로컬 키 zero-quota 포함) 방침 단계가 항상 동작.
- findings가 0건이면 `items: []` 반환 → UI는 "지적 없음, 개정 방침 불필요" 상태.

### 4.3 신규 엔드포인트 — `POST /api/screenplays/[id]/versions/[versionId]/revision-plan`

**sibling `check/route.ts` 패턴을 그대로 따른다** (auth·소유 스코프·maxDuration).

- `export const maxDuration = 90;` (무-check 경로에서 최대 2회 직렬 Gemini 호출: on-demand check + plan 생성).
- 인증: `requireUser(['member','admin'])`. **`getServiceClient()`** 사용. RLS는 **role-only**(소유권 개념 없음, `2026-05-26_screenplays_rls.sql:15-31`)이므로 버전→대본 스코프는 **명시 가드로** 보장:
  `loadOwnedVersion(supabase, id, versionId, "id, markdown")` = `.eq("id", versionId).eq("screenplay_id", id).maybeSingle()` (`check/route.ts:12-25` 재사용/복제). 없으면 404.
- 절차:
  1. `screenplays`에서 `product_info_snapshot`(=brief) 로드. 없으면 404.
  2. `loadOwnedVersion` 으로 version markdown 로드(소유 스코프).
  3. 최신 check 로드: `screenplay_version_checks`에서 `version_id` 최신 `result`. **없으면** `loadActiveRules()`/`loadActiveReferences()` + `checkScreenplay(markdown, brief, rules, references, { factSearch: false })` 즉석 실행(corpus-only, **외부 Brave egress 없음** — `check.ts:312-316`). 이 즉석 check는 저장하지 않는다(방침 생성용 일회성). 단 factSearch=false라 fact 관점이 얕을 수 있음 → 안내 문구로 "더 정밀히 하려면 먼저 試験結果 재시험" 유도.
  4. `buildRevisionPlan(markdown, brief, check, callGemini)` 호출.
  5. `{ plan: RevisionPlan, basedOnScore: check.overallScore, findingCount }` 반환.
- 저장 없음(방침 영속화 안 함). 재호출 시 매번 새로 생성.
- 실패 처리: LLM 실패는 모듈 내부 폴백으로 흡수. 그 외(버전 없음 등)는 명확한 4xx.
- **egress 주의**: plan 생성 Gemini 호출은 대본을 보내지만, 이는 **모든 `checkScreenplay` LLM 패스가 이미 하는 것**(`check.ts:339`)과 동일 클래스 — 신규 egress 아님. Brave는 corpus-only라 안 나감.

### 4.4 승인 시 합성 (client) — 정밀 규칙

선택된(keep) 항목 + 자유 피드백을 **하나의 JP feedback 문자열**로 조립해 기존 `/refine`에 전송.

- **axis→JP 라벨 맵**(신규 상수; `describeLegalAxis`는 **law code용이라 재사용 불가** — `check.ts:171-187`, Finding엔 law code 없음): `legal → 法規`, `facts → 事実`, `quality → 構成`. (특정 법명(薬機法 등)은 항목이 보유하지 않으므로 일반 라벨 사용.)
- **항목 렌더 규칙**: 선택 항목만 순번을 매겨 나열. 각 항목은
  - `target`이 비어있지 않고 **현재 markdown에 verbatim 존재**하면 → `N. [{label}] 「{target}」→ {instruction}`
  - 그렇지 않으면(구성/위치 서술 등) → `N. [{label}] {instruction}`
- **하드코딩 JP 상수**(i18n 금지 — JP 생성기에 먹이고 `feedback` 컬럼에 영속되는 콘텐츠): 헤더 `【考査結果に基づく修正方針】`, `【追加のご要望】`.

```
【考査結果に基づく修正方針】
1. [法規] 「業界No.1」→ 根拠不明のため削除
2. [事実] 「売上3億」→ 裏付けが取れないため表現を緩和
3. [構成] 実演デモを終盤へ移動
【追加のご要望】
<자유 피드백 원문>
```

- **4000자 캡 강제**(`refine/route.ts:32`): 합성 결과가 4000자를 넘지 않도록 클라이언트에서 보장.
  1. 자유 피드백은 항상 보존(사용자 입력). 헤더 + 피드백 길이를 먼저 예약.
  2. 남은 예산으로 선택 항목을 **severity 우선(high→med→low)** 정렬해 순차 포함, 예산 초과 직전에서 중단.
  3. 길이 때문에 제외된 항목이 있으면 UI에 "N개 항목이 길이 제한으로 제외됨" 소형 안내.
  4. (자유 피드백만으로 이미 4000자 초과 시엔 사용자 텍스트이므로 그대로 400 가능 — 기존 동작; 안내로 사용자가 줄이게 함.)
- 선택 0건 + 피드백 공백이면 `개정` 버튼 비활성.

### 4.5 UI 컴포넌트

`개정` 탭 내용물을 확장. 현재 `ReviewPanel.tsx:78-85`의 `refine` TabsContent가 `<FeedbackForm>` 하나만 렌더.

- 신규 `components/screenplay/RevisionPlanPanel.tsx`:
  - 상단: `[試験結果로 개정 방침 제안]` 버튼(로딩/재생성 상태 포함). 결과 수신 후 항목 리스트 — 각 항목 axis chip + severity chip + `target`(작게) + `instruction` + 좌측 keep/제거 체크박스(기본 keep).
  - 하단: 자유 피드백 textarea + **기존 `FeedbackForm`의 자주 쓰는 요청 chips(`t.raw("suggestions")`, `FeedbackForm.tsx:66-81`) 이식**(대체 시 UX 상실 방지) + `[이 방침으로 개정]` 제출.
  - **버전 전환 stale-drop 가드**(필수, `CheckResultPanel.tsx:186-232` 패턴): `versionId` 키로 방침 상태 clear + `versionRef`로 in-flight 응답 drop. 없으면 第N稿용 방침이 전환된 `baseVersionId`에 합성되는 버그.
- 제출 로직(`/refine` POST + `onRefineStart(runId)`)은 **한 곳에만** 둔다 — 작은 공유 훅 `use-refine-submit.ts`로 추출해 `RevisionPlanPanel`이 사용(기존 `FeedbackForm`은 제거되거나 훅을 공유). §4.5의 "대체 vs 추가"는 구현 시 결정하되 이 단일-POST 불변식과 stale-drop 가드는 방식과 무관하게 고정.
- `ReviewPanel`의 `refine` 탭: `FeedbackForm` → `RevisionPlanPanel` 배선. `ScreenplayWorkspace`의 `onRefineStart`/`GenerationProgress`/diff 전환은 무변경.

### 4.6 i18n

`messages/ja.json` · `messages/ko.json` 의 `screenplay.review.plan.*` 신규 키(ja≡ko parity, `scripts/check-message-parity.ts`로 강제). 예: `proposeBtn`, `regenerate`, `emptyNoFindings`, `keepToggle`, `applyBtn`, `planHeading`, `basedOnScore`, `generating`, `failed`, `itemsTrimmed`. axis/severity 칩 라벨은 기존 `review.axis*`/`review.sev*` 재사용. **모든 신규 키는 scalar**(배열 아님) → parity 스크립트의 배열 length 비교 이슈 없음.

- 방침 **본문(instruction/target)** 과 **compose 상수/라벨**(`【…】`, `法規`/`事実`/`構成`)은 JP로 고정, i18n 대상 아님(런타임 LLM 데이터 + JP 생성기 입력 + `feedback` 영속). UI chrome(버튼·헤딩·안내)만 ko/ja 대응. 기존 `試験結果` 패널이 이미 JP quote/reason을 양 locale에서 노출하는 것과 일관.

## 5. 에러 / 엣지 케이스

- **check 없음** → 엔드포인트가 corpus-only(factSearch=false) check 즉석 실행 후 방침 생성(저장 안 함).
- **findings 0건** → 방침 items 빈 배열 → "개정할 지적이 없습니다" 안내, 자유 피드백만으로 개정 가능.
- **LLM 실패** → 결정적 폴백으로 findings 기반 방침. 그래도 실패면 방침 없이 자유 피드백 경로 유지(graceful).
- **합성 4000자 초과** → severity 우선 항목 트림 + 안내(§4.4). 피드백은 항상 보존.
- **생성 중 version 전환** → RevisionPlanPanel의 versionId-keyed clear + stale-drop(§4.5).
- **`target` verbatim 불일치**(버전 불변이라 저위험) → compose가 자동으로 instruction-only 렌더로 폴백.
- **동시 refine** → 기존 `/refine`의 CAS claim(`refine/route.ts:85-101`)에 위임. 신규 경쟁 없음.

## 6. 테스트

`scripts/test-screenplay-revision-plan.ts` (tsx, fake `callLLM`; `server-only` 미포함; `getServiceClient` 가드):
- findings(각 axis 혼합) → `buildRevisionPlan` 이 관점별 항목을 포함.
- **JSON 파서 강건성**: 코드펜스/prose로 감싼 LLM 출력에서 정상 파싱(`check.ts::parseJSON` 미러).
- **per-item 코어스**: `instruction`·`target` 모두 빈 항목 drop.
- **폴백**: LLM throw/빈 응답 → findings 기반 조립, `instruction`에 axis 접두어 **없음**(이중 라벨 회귀 방지).
- findings 0건 → 빈 plan.
- **compose 함수**(선택 항목 + 피드백 → JP 문자열):
  - axis→JP 라벨 매핑(`法規/事実/構成`).
  - verbatim target → `「…」→`, 아니면 instruction-only.
  - **4000자 캡**: 다수 항목 + 피드백 시 severity 우선 트림 + 피드백 보존 확인.
  - 선택 0건 처리.
- 라이브 Gemini는 로컬 zero-quota이므로 배포 환경에서 확인(기존 관행).

## 7. 파일 요약

**신규**
- `lib/screenplay/revision-plan.ts` — 방침 생성(주입식 LLM) + 결정적 폴백 + compose 헬퍼(axis→JP 맵, verbatim 규칙, 4000자 캡).
- `app/api/screenplays/[id]/versions/[versionId]/revision-plan/route.ts` — 엔드포인트(`getServiceClient` + `loadOwnedVersion` + maxDuration 90).
- `components/screenplay/RevisionPlanPanel.tsx` — 방침 UI + 자유 피드백 + suggestion chips + stale-drop 가드 + 제출.
- `components/screenplay/use-refine-submit.ts` — `/refine` 제출 공유 훅(단일 POST 위치).
- `scripts/test-screenplay-revision-plan.ts` — 스모크 테스트.
- 본 스펙 + 구현 계획 문서.

**수정**
- `components/screenplay/ReviewPanel.tsx` — `refine` 탭에 `RevisionPlanPanel` 배선.
- `components/screenplay/FeedbackForm.tsx` — 제출 로직을 공유 훅으로 이동(또는 `RevisionPlanPanel`로 흡수, chips 이식).
- `messages/ja.json` · `messages/ko.json` — `screenplay.review.plan.*` 신규 키.

**안 건드림**
- `screenplay.workflow.ts`, `/refine`(4000자 캡은 client가 준수), `check.ts`, `remediate.ts`, `ChangeDiffView`, DB 스키마.

## 8. 확정된 결정 (리뷰 반영)

- 방침 본문 언어 = **JP** (생성기 입력 + 심의 도메인 용어 JP 유지 원칙과 일치, 저위험).
- `개정` 탭을 `RevisionPlanPanel`로 **대체**(자유 피드백 + suggestion chips 흡수). 단일-POST·stale-drop 불변식은 방식 무관 고정.
- axis 라벨은 일반 라벨(`法規/事実/構成`) — Finding에 law code가 없어 특정 법명 불가.
- on-demand check는 corpus-only(factSearch=false); 더 정밀한 fact 근거가 필요하면 사용자가 먼저 `試験結果` 재시험(factSearch=true) 후 방침 생성.

## 9. 리뷰 이력

- v2 (2026-07-08): architect-advisor + general-purpose 서브에이전트가 코드 대조 검증. 반영: `/refine` 4000자 캡 대응, auth를 `getServiceClient`+`loadOwnedVersion`으로 정정(RLS role-only 명시), `describeLegalAxis` 오재사용 → axis→JP 맵, 폴백 이중 라벨 제거, 버전전환 stale-drop 명시, suggestion chips 이식, markdown 12000 slice, maxDuration 90, JSON 파서/코어스 + 테스트 보강, JP compose 상수 비-i18n 명시.
