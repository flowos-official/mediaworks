# 대본 목록 구분 표시 + 제작 영역 UI 한국어화 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/[locale]/screenplays` 목록에 "무엇으로 만들었는지"(소스 종류·카테고리·개정수·상품 연결) 구분 표시를 추가하고, 제작(produce) 영역 UI 전체를 next-intl로 한국어 대응한다.

**Architecture:** Part A는 `screenplays`에 `source_kind` 컬럼을 추가하고 생성 시점에 기록, 목록 쿼리·행 UI를 확장한다. Part B는 이미 존재하는 next-intl 인프라 위에 `screenplay` 메시지 네임스페이스를 확장하고 제작 영역 페이지 3개 + 컴포넌트 13개에 `getTranslations`/`useTranslations`를 배선한다. 생성된 대본 본문·심의 도메인 용어는 일본어로 유지한다.

**Tech Stack:** Next.js App Router (server/client components), next-intl, Supabase(PostgREST, RLS), Tailwind, lucide-react, TypeScript.

**Spec:** `docs/superpowers/specs/2026-07-07-screenplay-list-distinguishers-and-produce-i18n-design.md`

## Global Constraints

- 작업 디렉터리: 워크트리 `E:\Github\mediaworks\.claude\worktrees\screenplay-list-distinguishers-i18n` (브랜치 `worktree-screenplay-list-distinguishers-i18n`). 모든 경로는 이 워크트리 기준.
- 테스트 프레임워크 없음 → 각 코드 태스크의 게이트는 `npx tsc --noEmit` + `npm run lint` 무오류, 그리고 해당 화면 렌더 확인.
- 마이그레이션은 **수동 DB 적용**(레포에 supabase CLI 없음). `source_kind` 컬럼은 **코드 배포 전에 DB에 먼저 적용·검증**해야 한다. 미적용 시 목록 쿼리가 실패해 목록 전체가 빈 화면이 된다.
- ja/ko 메시지 파일은 **키 셋 동일** 유지. ja 값은 **컴포넌트에 현재 렌더되는 실제 문자열과 바이트 동일**(회귀 0). ko 값만 한국어.
- **일본어 유지(ko에서도 번역 금지)**: 대본 마크다운 본문, 법령명(`薬機法`/`景表法` 등), DB corpus 값(`f.citedRule`/`f.suggestedRewrite`), 심의 용어(`第 N 稿`/`試験結果`/`稿`), 텔롭·화자 맵(`markdown-renderer.tsx:8-21`). 접두 라벨(`根拠:`/`修正案:`)만 번역.
- `source_kind` 값은 서버에서만 세팅(클라이언트 문자열 그대로 신뢰 금지). CHECK: `'upload'|'url'|'import'|'product'`, nullable.
- 커밋 메시지 말미에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` 포함.

---

## Task 1: 메시지 네임스페이스 스캐폴드 (ja + ko)

Part B의 토대. 컴포넌트를 건드리기 전에 전체 키 트리를 두 파일에 심어 파리티를 확보한다.

**Files:**
- Modify: `messages/ja.json` (기존 `screenplay` 네임스페이스 확장)
- Modify: `messages/ko.json` (동일 키, 한국어 값)
- Create: `scripts/check-message-parity.ts` (ja/ko 키 파리티 검증 스크립트)

**Interfaces:**
- Produces: `screenplay.*` 메시지 키 트리. 이후 모든 Task가 `useTranslations("screenplay")` / `getTranslations("screenplay")`로 소비.

**네임스페이스 스키마 (두 파일 동일 구조):**

```
screenplay
  list:      { title, subtitle, new, empty.title, empty.body, col.title, col.status, col.updated, count, revisions }
  status:    { pending, generating, ready, failed }        # 기존 키 재사용(값 재조정)
  source:    { upload, url, import, product, unknown }
  detail:    { back, badge, revisionsCount }
  new:       { back, badge, title, subtitle, step.source, step.review, step.generate,
               mode.upload.title, mode.upload.desc, mode.url.title, mode.url.desc,
               upload.heading, upload.desc, upload.cta, upload.ctaBusy, upload.change, upload.dnd, upload.max,
               url.heading, url.desc, url.cta, url.ctaBusy, url.httpsOnly, url.jsNote,
               review.badge, review.heading, review.desc, review.reextract, review.image,
               submit, submitBusy, generateTarget, generateNote }
  tabs:      { create, import }                              # ScreenplayNewTabs
  form:      { productName, category, description, guarantee, notes, bonuses,
               listPrice, salePrice, shippingPrice, submit }  # ProductBriefEditor
  import:    { heading, desc, cta, ctaBusy, dropHint, ... }   # ScreenplayImportForm (harvest)
  progress:  { generating, checking, remediating, done, ... } # GenerationProgress (harvest)
  workspace: { history, downloadMd, copyMd, copied, version, current }  # Workspace/HeaderBar/VersionTimeline
  feedback:  { label, placeholder, submit, sending }         # 기존 재사용
  review:    { title, score, findings, none, prefixCitedRule, prefixSuggestedRewrite, ... }  # CheckResultPanel/ReviewPanel/ChangeDiffView (harvest, stay-JP 준수)
  renderer:  { finalScript, sceneChange }                    # markdown-renderer 2개
  errors:    { extractFailed, extractEmpty, requiredFields, createFailed, ... }  # harvest
  a11y:      { steps, inputMethod, removeFile, createMethod }
```

**확정 값(고정·공유 키, 정확히 이 값 사용):**

`messages/ja.json` → `screenplay`:
```json
{
  "list": {
    "title": "台本一覧",
    "subtitle": "商品を選んで、生放送さながらのテレビショッピング台本を作成します。フィードバックを送ると何度でも改稿できます。",
    "new": "新しい台本を作成",
    "empty": { "title": "まだ台本がありません", "body": "「新しい台本を作成」から、商品資料をアップロードするか URL を指定して生成を開始してください。" },
    "col": { "title": "タイトル", "status": "状態", "updated": "最終更新" },
    "count": "{count} 件",
    "revisions": "改稿 {count} 回"
  },
  "status": { "pending": "待機中", "generating": "生成中", "ready": "完成", "failed": "失敗" },
  "source": { "upload": "ファイル", "url": "URL", "import": "Word取込", "product": "商品", "unknown": "その他" },
  "detail": { "back": "台本一覧に戻る", "badge": "テレビショッピング台本", "revisionsCount": "改稿 {count} 回" }
}
```

`messages/ko.json` → `screenplay` (동일 키, 한국어):
```json
{
  "list": {
    "title": "대본 목록",
    "subtitle": "상품을 선택해 생방송 같은 TV 홈쇼핑 대본을 생성합니다. 피드백을 보내면 몇 번이든 개정할 수 있습니다.",
    "new": "새 대본 만들기",
    "empty": { "title": "아직 대본이 없습니다", "body": "'새 대본 만들기'에서 상품 자료를 업로드하거나 URL을 지정해 생성을 시작하세요." },
    "col": { "title": "제목", "status": "상태", "updated": "최종 수정" },
    "count": "{count}건",
    "revisions": "개정 {count}회"
  },
  "status": { "pending": "대기 중", "generating": "생성 중", "ready": "완성", "failed": "실패" },
  "source": { "upload": "파일", "url": "URL", "import": "Word 가져오기", "product": "상품", "unknown": "기타" },
  "detail": { "back": "대본 목록으로", "badge": "TV 홈쇼핑 대본", "revisionsCount": "개정 {count}회" }
}
```

> 주의: 기존 `screenplay` 네임스페이스에 이미 `navLabel/title/subtitle/new/noneYet/status/form/workspace/feedback` 키가 있고 **값이 드리프트**돼 있다(예: 기존 `status.pending="待機"`). 위 스키마로 **덮어써 재조정**하되, ja는 현재 컴포넌트 렌더 문자열에 맞춘다. 나머지 서브트리(`new/tabs/import/progress/review/renderer/errors/a11y`)의 값은 각 컴포넌트 Task에서 그 파일의 실제 문자열을 수확(harvest)해 채운다 — 이 Task에서는 **키 자리(빈 문자열 금지, 실제 문자열)만 확정 가능한 것부터** 채우고, 컴포넌트 Task가 자기 파일 문자열로 완성한다.

- [ ] **Step 1: ja.json / ko.json의 기존 `screenplay` 네임스페이스를 위 확정 값으로 재작성**

`list/status/source/detail` 서브트리를 정확히 위 JSON대로 두 파일에 반영. 기존 드리프트 값 제거.

- [ ] **Step 2: 파리티 체크 스크립트 작성**

Create `scripts/check-message-parity.ts`:
```ts
import ja from "../messages/ja.json";
import ko from "../messages/ko.json";

function keys(obj: unknown, prefix = ""): string[] {
  if (!obj || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    keys(v, prefix ? `${prefix}.${k}` : k),
  );
}

const jaKeys = new Set(keys(ja));
const koKeys = new Set(keys(ko));
const onlyJa = [...jaKeys].filter((k) => !koKeys.has(k));
const onlyKo = [...koKeys].filter((k) => !jaKeys.has(k));

if (onlyJa.length || onlyKo.length) {
  console.error("KEY MISMATCH");
  if (onlyJa.length) console.error("  ja-only:", onlyJa);
  if (onlyKo.length) console.error("  ko-only:", onlyKo);
  process.exit(1);
}
console.log(`OK — ${jaKeys.size} keys match`);
```

- [ ] **Step 3: 파리티 + 타입 확인**

Run: `npx tsx scripts/check-message-parity.ts`
Expected: `OK — N keys match`
Run: `npx tsc --noEmit`
Expected: 무오류

- [ ] **Step 4: package.json에 스크립트 별칭 추가 (선택)**

`"check:i18n": "tsx scripts/check-message-parity.ts"` 를 `scripts`에 추가.

- [ ] **Step 5: Commit**

```bash
git add messages/ja.json messages/ko.json scripts/check-message-parity.ts package.json
git commit -m "feat(screenplay-i18n): scaffold screenplay message namespace + parity check"
```

---

## Task 2: 마이그레이션 — `source_kind` 컬럼

**Files:**
- Create: `supabase/migrations/2026-07-07_screenplays_source_kind.sql`

**Interfaces:**
- Produces: `screenplays.source_kind text` (nullable, CHECK `'upload'|'url'|'import'|'product'`).

- [ ] **Step 1: 마이그레이션 파일 작성**

```sql
-- 2026-07-07: record how each screenplay was created, for list-view distinction.
-- upload = PDF/Excel/image extract, url = product page URL, import = Word draft,
-- product = generated from an existing researched product. NULL = pre-feature rows.
BEGIN;

ALTER TABLE screenplays
  ADD COLUMN IF NOT EXISTS source_kind text
    CHECK (source_kind IN ('upload','url','import','product'));

COMMENT ON COLUMN screenplays.source_kind IS
  'How the screenplay was created: upload|url|import|product. NULL for rows predating the feature.';

COMMIT;
```

- [ ] **Step 2: DB에 수동 적용**

이 프로젝트엔 `db:push`가 없다. Supabase SQL 에디터(또는 psql)로 위 SQL을 **실제 DB에 실행**한다. 적용 후:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name='screenplays' AND column_name='source_kind';
```
Expected: `source_kind` 1행 반환.

> **중요**: 이 컬럼이 DB에 없으면 Task 4의 목록 쿼리가 실패해 목록이 통째로 빈 화면이 된다. Task 4 배포 전 반드시 이 Step을 완료.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-07-07_screenplays_source_kind.sql
git commit -m "feat(screenplay): add screenplays.source_kind column"
```

---

## Task 3: 생성 시점 `source_kind` 기록

**Files:**
- Modify: `app/api/screenplays/route.ts` (POST insert)
- Modify: `components/screenplay/ScreenplayCreateForm.tsx` (submit body)

**Interfaces:**
- Consumes: `screenplays.source_kind` (Task 2).
- Produces: 생성되는 모든 신규 screenplay 행에 `source_kind` 세팅.

**서버 결정 규칙 (route.ts):**
- `importedMarkdown` 존재 → `'import'`
- `v.productId` 존재(상품 경로) → `'product'`
- body `sourceKind` ∈ `{'upload','url'}` → 그 값
- 그 외 → `null`

- [ ] **Step 1: route.ts에 sourceKind 해석 추가**

`app/api/screenplays/route.ts` POST 내 insert 직전. 현재 insert(`route.ts:98-107`):
```ts
const { data: inserted, error: insErr } = await supabase
  .from("screenplays")
  .insert({
    product_id: v.productId,
    title: productBrief.name,
    product_info_snapshot: productBrief,
    status: "generating",
  })
```
를 다음으로 교체:
```ts
const rawSourceKind =
  body && typeof body === "object" ? (body as Record<string, unknown>).sourceKind : undefined;
const clientSourceKind =
  rawSourceKind === "upload" || rawSourceKind === "url" ? rawSourceKind : null;
const sourceKind: "upload" | "url" | "import" | "product" | null = importedMarkdown
  ? "import"
  : v.productId
  ? "product"
  : clientSourceKind;

const { data: inserted, error: insErr } = await supabase
  .from("screenplays")
  .insert({
    product_id: v.productId,
    title: productBrief.name,
    product_info_snapshot: productBrief,
    status: "generating",
    source_kind: sourceKind,
  })
```

- [ ] **Step 2: ScreenplayCreateForm.submit()에서 sourceKind 전송**

`components/screenplay/ScreenplayCreateForm.tsx` `submit()`의 fetch body(`~259`). 현재:
```ts
body: JSON.stringify({ productBrief }),
```
를:
```ts
body: JSON.stringify({
  productBrief,
  sourceKind: source?.kind === "url" ? "url" : source?.kind ? "upload" : undefined,
}),
```
(`source`는 추출 시 세팅되며 submit 시점에 유효. `source?.kind` null-guard 적용.)

- [ ] **Step 3: 타입/린트 확인**

Run: `npx tsc --noEmit` / `npm run lint`
Expected: 무오류

- [ ] **Step 4: 수동 검증 (DB)**

`npm run dev` 후 업로드/URL 경로로 각각 대본 1개 생성. 이어서:
```sql
SELECT title, source_kind FROM screenplays ORDER BY created_at DESC LIMIT 5;
```
Expected: 업로드→`upload`, URL→`url`. (임포트/상품 경로는 Task 5/기존 경로에서 확인.)

- [ ] **Step 5: Commit**

```bash
git add app/api/screenplays/route.ts components/screenplay/ScreenplayCreateForm.tsx
git commit -m "feat(screenplay): record source_kind on creation"
```

---

## Task 4: 목록 화면 — 쿼리 확장 + 구분 UI + i18n (`/screenplays`, `/screenplays/[id]`)

Part A(A3/A4)와 Part B(목록·상세 i18n)를 한 파일군에서 함께 처리(이중 편집 방지).

**Files:**
- Modify: `app/[locale]/(produce)/screenplays/page.tsx` (쿼리·i18n)
- Modify: `components/screenplay/ScreenplayList.tsx` (구분 UI·i18n)
- Modify: `app/[locale]/(produce)/screenplays/[id]/page.tsx` (i18n·중복 status 맵 제거)

**Interfaces:**
- Consumes: `screenplay.list.*`, `screenplay.status.*`, `screenplay.source.*`, `screenplay.detail.*` (Task 1); `screenplays.source_kind` (Task 2).
- Produces: `Row` 타입 `{ id, title, status, updated_at, sourceKind, category, hasProduct, versionCount }`.

- [ ] **Step 1: page.tsx `fetchList` 쿼리·매핑 확장**

현재 select(`page.tsx:16-20`)를 교체:
```ts
const { data, error } = await sb
  .from("screenplays")
  .select(
    "id, title, status, updated_at, source_kind, product_id, product_info_snapshot, screenplay_versions!screenplay_id(count)",
  )
  .order("updated_at", { ascending: false })
  .limit(50);
if (error) {
  console.warn("[screenplays/page] list fetch failed:", error.message);
  return [];
}
return (data ?? []).map((r) => {
  const snap = (r.product_info_snapshot ?? {}) as { category?: string };
  const vc = Array.isArray(r.screenplay_versions) ? r.screenplay_versions[0]?.count ?? 0 : 0;
  return {
    id: r.id as string,
    title: r.title as string,
    status: r.status as Row["status"],
    updated_at: r.updated_at as string,
    sourceKind: (r.source_kind ?? null) as Row["sourceKind"],
    category: typeof snap.category === "string" && snap.category.trim() ? snap.category.trim() : null,
    hasProduct: Boolean(r.product_id),
    versionCount: vc as number,
  };
});
```
> FK 명시(`!screenplay_id`) 필수 — 두 테이블 사이 FK가 2개라 생략 시 PostgREST가 에러를 던져 목록이 통째로 빈다. count는 배열 `[{count}]` 형태.

행 타입을 `page.tsx`와 `ScreenplayList.tsx`가 공유하도록 `Row`를 갱신(아래 Step 2에서 정의). `ScreenplaysPage`는 `getTranslations`로 헤더 문자열을 조회:
```ts
import { getTranslations } from "next-intl/server";
// ...
const t = await getTranslations("screenplay.list");
```
그리고 헤더 하드코딩(`page.tsx:35-46`)을 `t("title")`, `t("subtitle")`, `t("new")`로 교체.

- [ ] **Step 2: ScreenplayList.tsx — Row 타입·구분 UI·i18n**

`Row` 인터페이스를 다음으로 확장:
```ts
interface Row {
  id: string;
  title: string;
  status: "pending" | "generating" | "ready" | "failed";
  updated_at: string;
  sourceKind: "upload" | "url" | "import" | "product" | null;
  category: string | null;
  hasProduct: boolean;
  versionCount: number;
}
```
`"use client"` 유지, `useTranslations` 도입:
```ts
import { useTranslations } from "next-intl";
// 컴포넌트 내부:
const t = useTranslations("screenplay");
```
- `STATUS_CONFIG`의 `label`을 제거하고 렌더 시 `t(\`status.${r.status}\`)` 사용(아이콘/색상 cls는 유지).
- 헤더 스트립 라벨(`タイトル/状態/最終更新`)을 `t("list.col.title")` 등으로.
- 빈 상태(`まだ台本がありません` 등)를 `t("list.empty.title")`, `t("list.empty.body")`로.
- 카운트(`{n} 件`)를 `t("list.count", { count: rows.length })`로.
- **소스 배지**: 각 행에 소스 칩 추가 — `t(\`source.${r.sourceKind ?? "unknown"}\`)`, 소스별 lucide 아이콘(`Upload`/`Link2`/`FileText`/`Package`) + 고정 색상.
- **아바타**: 행 좌측 기존 `FileText` 아이콘 블록을, 소스별 아이콘(위 매핑) 또는 카테고리 이니셜로 대체. 색상은 소스 종류별 팔레트.
- **카테고리 칩**: `r.category` 있을 때만 작은 회색 칩.
- **개정수**: `t("list.revisions", { count: r.versionCount })` 를 상태 배지 옆 또는 메타 라인에.
- **상품 연결**: `r.hasProduct`면 `Package`/`Link` 아이콘 배지.
- 데스크톱 그리드 컬럼과 모바일 스택 모두에 배지가 겹치지 않게 배치. (카테고리 종종 null → 없을 때 레이아웃이 깨지지 않게.)

- [ ] **Step 3: [id]/page.tsx — i18n + 중복 status 맵 제거**

`getTranslations("screenplay")` 도입. 하드코딩 교체:
- `台本一覧に戻る` → `t("detail.back")`
- `テレビショッピング台本` → `t("detail.badge")`
- `改稿 {n} 回` → `t("detail.revisionsCount", { count: versions.length })`
- `STATUS_BADGE`(`[id]/page.tsx:55-60`)의 `label`을 제거하고 `t(\`status.${screenplay.status}\`)`로 렌더(cls만 유지). 이로써 `screenplay.status.*` 단일 출처로 일원화.

- [ ] **Step 4: 타입·린트·파리티 확인**

Run: `npx tsc --noEmit` / `npm run lint` / `npx tsx scripts/check-message-parity.ts`
Expected: 전부 무오류/OK

- [ ] **Step 5: 렌더 확인**

`npm run dev` → `/ko/screenplays`, `/ja/screenplays`, `/ko/screenplays/<id>` 확인:
- ko: 한국어 헤더/컬럼/상태, 각 행에 소스 배지·(있으면)카테고리·개정수·상품연결 표시.
- ja: 기존 일본어와 문구 동일.
- 목록이 비지 않음(FK 명시가 맞는지 검증). 상세 상태 배지도 로케일 반영.

- [ ] **Step 6: Commit**

```bash
git add app/[locale]/(produce)/screenplays/page.tsx components/screenplay/ScreenplayList.tsx "app/[locale]/(produce)/screenplays/[id]/page.tsx"
git commit -m "feat(screenplay): list distinguishers (source/category/revisions/product) + ko/ja list i18n"
```

---

## Task 5: 생성 플로우 i18n (new 페이지 + 생성/임포트 폼)

**Files:**
- Modify: `app/[locale]/(produce)/screenplays/new/page.tsx`
- Modify: `components/screenplay/ScreenplayNewTabs.tsx`
- Modify: `components/screenplay/ScreenplayCreateForm.tsx`
- Modify: `components/screenplay/ProductBriefEditor.tsx`
- Modify: `components/screenplay/ScreenplayImportForm.tsx`
- Modify: `components/screenplay/GenerationProgress.tsx`
- Modify: `messages/ja.json`, `messages/ko.json` (`new/tabs/form/import/progress/errors/a11y` 값 완성)

**Interfaces:**
- Consumes: Task 1 네임스페이스 스캐폴드.

**Harvest 규칙 (각 파일 공통):**
1. 파일을 읽고 사용자에게 보이는 모든 일본어 문자열(본문·버튼·placeholder·**aria-label**·**에러/토스트**)을 식별.
2. 각 문자열을 스키마의 해당 서브트리 키에 매핑(신규 키는 `screenplay.<sub>.<camelCaseKey>`). ja 값=원문 그대로, ko 값=한국어 번역.
3. 에러/토스트는 `screenplay.errors.*`, aria-label은 `screenplay.a11y.*`.
4. 컴포넌트에서 `useTranslations("screenplay")`(클라이언트) / `getTranslations("screenplay")`(서버: new/page.tsx만) 도입 후 각 리터럴을 `t("...")`로 교체. 변수 삽입은 `t("key", { name })` 형식.
5. **일본어 유지 항목은 건드리지 않는다**(이 Task엔 해당 없음 — 전부 UI 크롬).

**명시 대상 위치(누락 방지, spec 근거):**
- aria-label: `ScreenplayCreateForm:82 作成ステップ, :298 入力方法, :449 ファイルを削除`; `ScreenplayImportForm:225 ファイルを削除`; `ScreenplayNewTabs:17 作成方法`.
- 에러/토스트: `ScreenplayCreateForm:194,195,233,265`; `ScreenplayImportForm:76,79,96,99,128,156`; `GenerationProgress:81,85,87`.

- [ ] **Step 1: new/page.tsx (서버) i18n**

`getTranslations("screenplay.new")` 도입. 하드코딩 교체: `台本一覧に戻る`→`t("back")`, `新しい台本を作成`(제목)→`t("title")`, 부제 단락→`t("subtitle")`. `Screenplay Studio` 배지는 브랜드 고유명 → 유지.

- [ ] **Step 2: ScreenplayNewTabs.tsx i18n**

탭 라벨(생성/임포트)·aria-label을 `t("tabs.create")`, `t("tabs.import")`, `t("a11y.createMethod")`로.

- [ ] **Step 3: ScreenplayCreateForm.tsx i18n**

`useTranslations("screenplay")` 도입. Stepper 라벨(`ソース/確認/生成`), 모드 카드(`ファイルをアップロード`/`商品ページURL` + desc), 업로드/URL 패널 문구, 추출 버튼(`Geminiで情報を抽出`/`抽出中...`/`解析中...`), 리뷰 헤더(`抽出完了`/`抽出結果を確認・編集`/`別の素材で再抽出`), 하단 바(`生成対象`/`台本を生成`/`作成中...`), 에러 문자열, aria-label 전부 교체. (Source 아이콘·색상 로직은 유지.)

- [ ] **Step 4: ProductBriefEditor.tsx i18n**

필드 라벨(상품명/카테고리/특징·스펙/보증/비고/특전/가격들)을 `screenplay.form.*`로. 기존 `form` 키 확장.

- [ ] **Step 5: ScreenplayImportForm.tsx i18n**

헤딩·설명·CTA·드롭 힌트 + **.docx 검증 에러 메시지 6종**(`:76,79,96,99,128,156`)을 `screenplay.import.*` / `screenplay.errors.*`로. aria-label 포함.

- [ ] **Step 6: GenerationProgress.tsx i18n**

진행 단계 라벨·상태 문구·에러(`:81,85,87`)를 `screenplay.progress.*` / `screenplay.errors.*`로.

- [ ] **Step 7: 확인**

Run: `npx tsc --noEmit` / `npm run lint` / `npx tsx scripts/check-message-parity.ts`
Expected: 무오류/OK
렌더: `/ko/screenplays/new` 전 스텝(업로드·URL·리뷰·생성 진행) 한국어, `/ja/...` 동일 일본어. 실제 업로드로 추출→생성까지 1회 통과.

- [ ] **Step 8: Commit**

```bash
git add "app/[locale]/(produce)/screenplays/new/page.tsx" components/screenplay/ScreenplayNewTabs.tsx components/screenplay/ScreenplayCreateForm.tsx components/screenplay/ProductBriefEditor.tsx components/screenplay/ScreenplayImportForm.tsx components/screenplay/GenerationProgress.tsx messages/ja.json messages/ko.json
git commit -m "feat(screenplay-i18n): localize creation flow (new/create/import/progress)"
```

---

## Task 6: 워크스페이스 i18n (상세 편집 화면)

**Files:**
- Modify: `components/screenplay/ScreenplayWorkspace.tsx`
- Modify: `components/screenplay/ScreenplayHeaderBar.tsx`
- Modify: `components/screenplay/VersionTimeline.tsx`
- Modify: `components/screenplay/FeedbackForm.tsx`
- Modify: `components/screenplay/markdown-renderer.tsx` (UI 문자열 2개만)
- Modify: `messages/ja.json`, `messages/ko.json` (`workspace/feedback/renderer` 완성)

**Interfaces:**
- Consumes: Task 1 스캐폴드.

- [ ] **Step 1: ScreenplayWorkspace.tsx i18n**

Harvest 규칙(Task 5) 적용. 다운로드/복사(`downloadMd`/`copyMd`/`copied`)·버전 라벨·상태 문구를 `screenplay.workspace.*`로. `ScreenplayViewer.tsx`는 **문자열 0개 → 손대지 않음**.

- [ ] **Step 2: ScreenplayHeaderBar.tsx i18n**

헤더 액션/라벨을 `screenplay.workspace.*`로.

- [ ] **Step 3: VersionTimeline.tsx i18n**

버전 이력 라벨(`改稿 N 回`/`初稿` 등 UI 크롬)을 `screenplay.workspace.*`로. **`第 N 稿`류 심의 용어는 review 규칙 참고** — 단순 UI 카운트면 번역, 도메인 용어면 유지(파일 문맥 보고 판단).

- [ ] **Step 4: FeedbackForm.tsx i18n**

`useTranslations("screenplay.feedback")`. 라벨/placeholder/제출/전송중(`:65` placeholder 포함)·에러(`:37`)를 기존 `feedback.*` + `errors.*`로.

- [ ] **Step 5: markdown-renderer.tsx — 2개만**

파일 상단에 `"use client";` 추가, `useTranslations("screenplay.renderer")` 도입. **L35 `完成版 台本` → `t("finalScript")`, L62 `場面転換` → `t("sceneChange")` 두 곳만** 교체. **L8-21 텔롭/화자 맵은 절대 건드리지 않음**(corpus 키).

- [ ] **Step 6: 확인**

Run: `npx tsc --noEmit` / `npm run lint` / `npx tsx scripts/check-message-parity.ts`
렌더: `/ko/screenplays/<id>` 워크스페이스 한국어(대본 본문은 일본어 유지), 다운로드/복사/피드백 동작. `/ja` 동일.

- [ ] **Step 7: Commit**

```bash
git add components/screenplay/ScreenplayWorkspace.tsx components/screenplay/ScreenplayHeaderBar.tsx components/screenplay/VersionTimeline.tsx components/screenplay/FeedbackForm.tsx components/screenplay/markdown-renderer.tsx messages/ja.json messages/ko.json
git commit -m "feat(screenplay-i18n): localize workspace (header/timeline/feedback/renderer)"
```

---

## Task 7: 심의·리뷰 패널 i18n (stay-JP 주의)

**Files:**
- Modify: `components/screenplay/CheckResultPanel.tsx`
- Modify: `components/screenplay/ReviewPanel.tsx`
- Modify: `components/screenplay/ChangeDiffView.tsx`
- Modify: `messages/ja.json`, `messages/ko.json` (`review/errors` 완성)

**Interfaces:**
- Consumes: Task 1 스캐폴드.

**stay-JP 엄수(번역 금지):**
- `CheckResultPanel.tsx:263` `薬機法・景表法` (법령명).
- `CheckResultPanel.tsx:50` `根拠: {f.citedRule}` → **`根拠:` 접두만** `t("review.prefixCitedRule")`, 값 `{f.citedRule}`는 그대로.
- `CheckResultPanel.tsx:54` `修正案: {f.suggestedRewrite}` → 접두만 `t("review.prefixSuggestedRewrite")`.
- `ReviewPanel.tsx:41 試験結果`, `:49/51 第 N 稿` → 심의 도메인 용어 **유지**.
- 에러(`CheckResultPanel:205,229`)는 `screenplay.errors.*`.

- [ ] **Step 1: CheckResultPanel.tsx i18n**

`useTranslations("screenplay")`. UI 크롬(패널 제목·점수 라벨·발견 없음 등)만 `screenplay.review.*`로. 접두 라벨 2개는 위 규칙대로. 법령명·corpus 값은 유지. 에러 2개는 `errors.*`.

- [ ] **Step 2: ReviewPanel.tsx i18n**

UI 크롬만 `screenplay.review.*`로. `試験結果`/`第 N 稿`는 유지(파일 문맥 확인).

- [ ] **Step 3: ChangeDiffView.tsx i18n**

diff UI 라벨(추가/삭제/변경점/근거 등 17개 중 UI 크롬)을 `screenplay.review.*`로. diff 대상 텍스트(대본 내용)는 유지.

- [ ] **Step 4: 확인**

Run: `npx tsc --noEmit` / `npm run lint` / `npx tsx scripts/check-message-parity.ts`
렌더: `/ko/screenplays/<id>`에서 심의 결과 패널·리뷰·diff 확인 — UI는 한국어, 법령명/`第N稿`/corpus 값은 일본어 유지.

- [ ] **Step 5: Commit**

```bash
git add components/screenplay/CheckResultPanel.tsx components/screenplay/ReviewPanel.tsx components/screenplay/ChangeDiffView.tsx messages/ja.json messages/ko.json
git commit -m "feat(screenplay-i18n): localize review/check panels (compliance terms stay JA)"
```

---

## Task 8: 최종 검증 + 잔여 하드코딩 스윕

**Files:** (수정 없을 수도 있음 — 스윕 결과에 따라)

- [ ] **Step 1: 제작 영역 하드코딩 잔여 스윕**

Grep로 제작 영역에 남은 일본어(가나/한자) 리터럴을 훑는다:
```bash
grep -rnE '[ぁ-んァ-ヶ一-龥]' app/[locale]/\(produce\)/screenplays components/screenplay --include='*.tsx' | grep -vE '//|/\*'
```
남은 항목이 **stay-JP 목록(법령명/corpus 값/텔롭·화자 맵/第N稿/試験結果/브랜드명)에 해당하는지** 하나씩 확인. UI 크롬인데 누락된 게 있으면 해당 Task 규칙대로 처리 후 커밋.

- [ ] **Step 2: 전체 게이트**

Run: `npx tsc --noEmit` → 무오류
Run: `npm run lint` → 무오류
Run: `npx tsx scripts/check-message-parity.ts` → OK
Run: `npm run build` → 성공(next-intl 키 누락/빌드 에러 없음)

- [ ] **Step 3: 로케일 회귀 확인**

`npm run dev` 후:
- `/ja/screenplays` 전체(목록·생성·워크스페이스·리뷰)가 **변경 전과 문구 동일**(회귀 0).
- `/ko/screenplays` 전체가 한국어. 대본 본문·법령명·`第N稿`·텔롭 맵은 일본어 유지.
- 4개 소스 경로(업로드/URL/임포트/상품) 각각 생성 후 목록 소스 배지 정확.

- [ ] **Step 4: 최종 커밋(잔여 있으면)**

```bash
git add -A
git commit -m "chore(screenplay-i18n): sweep residual hardcoded strings + final verification"
```

---

## Self-Review 체크 결과

- **Spec 커버리지**: A-1 마이그레이션(T2)·A-2 캡처(T3)·A-3 쿼리(T4/S1)·A-4 UI(T4/S2) / B-1 네임스페이스(T1,T5-7)·B-2 배선(T4-7)·B-3 stay-JP(T6/S5,T7). 검토 보완(FK 명시·마이그레이션 순서·ScreenplayViewer 제외·값 드리프트·errors/a11y·중복 status 맵·markdown 2문자열) 모두 태스크에 반영.
- **타입 일관성**: `Row { sourceKind, category, hasProduct, versionCount }`가 page.tsx(T4/S1 매핑)와 ScreenplayList(T4/S2 정의)에서 동일. `source_kind` 유니온 4값 + null 일관.
- **비범위**: 테넌트/스타일 선택 UI, 대본 본문 한국어화, 실제 썸네일 이미지 — 계획 외 유지.
