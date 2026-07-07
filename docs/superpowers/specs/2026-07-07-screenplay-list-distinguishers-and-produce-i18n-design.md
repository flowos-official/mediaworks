# 대본 목록 구분 표시 + 제작 영역 UI 한국어화 — 설계

- 날짜: 2026-07-07
- 범위: `/[locale]/screenplays` (제작(produce) 영역 전반)
- 대상 브랜치: `worktree-screenplay-list-distinguishers-i18n`

## 배경 / 문제

`/ko/screenplays` 화면에 대해 두 가지 개선 요청.

1. **구분 부재**: 대본 목록이 각 행에 대해 **제목(=상품명) · 상태 · 최종수정일** 3개만 표시한다. 여러 대본을 만들었을 때 "각각 무엇으로 어떻게 만들었는지"를 목록에서 구분할 수 없다.
2. **언어 대응 부재**: 제작 영역 UI 전체가 일본어로 하드코딩되어 있다. `messages/ko.json`·`ja.json`에 `screenplay` 네임스페이스가 일부 존재하나 **어떤 컴포넌트도 이를 사용하지 않는다**(`useTranslations`를 쓰는 스크린플레이 컴포넌트 0개). `/ko/`로 접속해도 제작 영역이 일본어로 나온다.

## 현재 구조 (근거)

- 목록 페이지: `app/[locale]/(produce)/screenplays/page.tsx` — 직접 Supabase 쿼리(`fetchList`)로 `id, title, status, updated_at`만 select.
- 목록 렌더: `components/screenplay/ScreenplayList.tsx` — 상태 라벨/헤더/카운트 전부 일본어 하드코딩.
- 데이터 모델: `supabase/migrations/2026-05-13_screenplays.sql`
  - `screenplays(id, product_id, title, product_info_snapshot jsonb, current_version_id, status, last_run_id, created_at, updated_at)`
  - `screenplay_versions(screenplay_id, version_number, …)`
- 생성 경로:
  - 폼 `components/screenplay/ScreenplayCreateForm.tsx` — 소스 선택(업로드/URL) → `POST /api/screenplays/extract`가 `source.kind ∈ {pdf,image,excel,url}` 반환. 단, **생성 POST(`/api/screenplays`)에는 소스 정보를 싣지 않아 DB에 저장되지 않음.**
  - 임포트 `components/screenplay/ScreenplayImportForm.tsx` → `importedMarkdown` 전달(mode `import`).
  - 상품에서 생성 → `POST /api/screenplays` body의 `productId` → `loadProductBriefForScreenplay`.
- 이미지: `product_info_snapshot`(ProductBrief)에 이미지 필드 없음. 생성 경로 어디에도 스크린플레이용 이미지가 저장되지 않음. 상품 연결 행만 `discovered_products.thumbnail_url` 등으로 부분 복구 가능.
- 테넌트/스타일: `loadActiveRules`/`loadStyleBible`는 `tenant`를 받지만 워크플로에서 항상 기본값 `mediaworks`. **생성 UI에 테넌트 선택지가 없어** 대본 간 구분 기준이 되지 못함 → 본 작업 범위 밖.

## 결정 사항 (사용자 확정)

- 구분 표시 항목: **카테고리 · 소스 종류 · 개정 버전 수 · 상품 연결** 4가지 모두.
- 썸네일: **아바타 방식** (소스 아이콘/카테고리 이니셜, 이미지 의존성 없음).
- i18n 롤아웃: **제작 영역 전체 1패스**.
- 대본 본문(마크다운)·컴플라이언스 법령명(薬機法 등)은 **일본어 유지**.
- Part A/B **함께** 진행(같은 워크트리·스펙).

## 설계

### Part A — 목록 구분 표시

#### A-1. 스키마: 소스 종류 컬럼

마이그레이션 `supabase/migrations/2026-07-07_screenplays_source_kind.sql`:

```sql
ALTER TABLE screenplays
  ADD COLUMN IF NOT EXISTS source_kind text
    CHECK (source_kind IN ('upload','url','import','product'));
```

- nullable, 기본 NULL. 기존 행은 NULL → UI에서 "기타"로 표시.
- CHECK 위반 방지를 위해 서버에서만 세팅(클라이언트 문자열 그대로 신뢰 금지).
- 마이그레이션은 수동 적용(레포에 supabase CLI 없음, memory: migrations-applied-manually). 스펙/플랜에 "DB에 수동 적용 필요" 명시.

#### A-2. 생성 시점 기록

- `ScreenplayCreateForm.submit()`: `source.kind`를 정규화(`pdf|image|excel → 'upload'`, `url → 'url'`)해 POST body에 `sourceKind` 추가. 검토 확인: `source`는 두 추출 경로에서 세팅되고 `resetAll`(재추출) 외엔 클리어되지 않으며 `brief` 없이 `source`가 비는 경우 없음 → submit 시점에 신뢰 가능. 그래도 `source?.kind` **null-guard 적용**.
- `POST /api/screenplays` (`app/api/screenplays/route.ts`):
  - body에 `importedMarkdown` 있으면 → `source_kind = 'import'`.
  - body에 `productId` 있으면 → `source_kind = 'product'`.
  - 그 외 `sourceKind`가 화이트리스트(`upload|url`)에 있으면 그 값, 없으면 NULL.
  - `insert({... source_kind})`.
- 임포트 폼(`ScreenplayImportForm`)도 동일 엔드포인트 사용 → import 분기에서 자동 처리.

#### A-3. 목록 쿼리 확장

`app/[locale]/(produce)/screenplays/page.tsx::fetchList`:

```ts
.select("id, title, status, updated_at, source_kind, product_id, product_info_snapshot, screenplay_versions!screenplay_id(count)")
```

- **[블로커 수정] FK 모호성**: `screenplays`↔`screenplay_versions` 사이엔 FK가 2개다 — `screenplay_versions.screenplay_id → screenplays.id`(2026-05-13:19)와 `screenplays.current_version_id → screenplay_versions.id`(2026-05-13:31-35). 그냥 `screenplay_versions(count)`로 쓰면 PostgREST가 "more than one relationship" 에러를 던지고, `fetchList`가 이를 catch해 `[]`를 반환(page.tsx:21-24) → **목록 전체가 빈 화면**이 된다(degrade 아님). 반드시 관계를 명시: `screenplay_versions!screenplay_id(count)`.
- **count 반환 형태**: 스칼라가 아니라 배열 `[{ count: N }]`. 서버에서 `row.screenplay_versions?.[0]?.count ?? 0`로 매핑.
- `product_info_snapshot`에서 `category`만 뽑아 행 타입에 매핑(전체 jsonb를 클라이언트로 넘기지 않고 서버에서 `{ id, title, status, updated_at, sourceKind, category, hasProduct, versionCount }`로 축약).
- RLS 확인 완료: `screenplay_versions_member_read`(2026-05-26_screenplays_rls.sql)가 member/admin SELECT 허용, 목록 페이지는 `getServerClient()`(RLS 적용)이고 produce 레이아웃이 이미 member/admin 게이트 → 임베드 count 통과.

#### A-4. 목록 UI (`ScreenplayList.tsx`)

각 행에:
- **아바타**: 소스 종류별 아이콘(업로드/URL/Word/상품) 또는 카테고리 이니셜. 색상은 소스별 고정 팔레트.
- **카테고리 칩**: `category` 있을 때만. 주의: `category`는 자주 null이다(Gemini가 반환할 때만 세팅; route.ts:47 / product 경로는 product-brief.ts:164에서 종종 undefined). 상당수 행에서 칩이 비어 보일 수 있으므로 **카테고리를 대표 구분자로 내세우지 말 것** — 소스 배지/개정수가 더 안정적.
- **소스 배지**: 소스 종류 라벨(i18n). NULL → "기타".
- **개정 수**: "개정 N회" (i18n, `versionCount`).
- **상품 연결**: `hasProduct`면 링크 아이콘/배지.
- 기존 상태 배지·최종수정일 유지.
- 데스크톱 그리드/모바일 스택 모두 대응.

### Part B — 제작 영역 UI 한국어화 (전체 1패스)

#### B-1. 메시지 네임스페이스 확장

`messages/ja.json` + `messages/ko.json`의 `screenplay` 네임스페이스를 하위 구조로 확장. 두 파일 **키 동일**하게 유지:

```
screenplay.list.*        (제목/부제/헤더 컬럼/빈 상태/카운트/신규 버튼)
screenplay.status.*      (pending|generating|ready|failed) — 이미 존재, 재사용
screenplay.source.*      (upload|url|import|product|unknown)  ← 신규
screenplay.revisions     ("개정 {count}회")                    ← 신규
screenplay.new.*         (스텝/모드 선택/업로드/URL/추출)
screenplay.form.*        (ProductBriefEditor 필드) — 일부 존재, 확장
screenplay.detail.*      (상세 헤더/뒤로가기/배지)
screenplay.workspace.*   (워크스페이스/뷰어/버전 타임라인/다운로드)
screenplay.feedback.*    (피드백 폼) — 존재, 재사용
screenplay.review.*      (CheckResultPanel/ReviewPanel/ChangeDiffView)
screenplay.errors.*      (추출/작성/임포트 실패·검증 토스트)         ← 신규(누락 보완)
screenplay.a11y.*        (aria-label 5종)                          ← 신규(누락 보완)
```

- ja.json 값 = **컴포넌트에 현재 렌더되는 실제 문자열** 그대로 이관(문구 변경 없음, 회귀 방지).
- **[검토 보완] 기존 네임스페이스 값 드리프트 주의**: ja.json·ko.json에 `screenplay` 네임스페이스가 이미 존재하고 두 파일 키 셋은 동일하나, 일부 기존 값이 실제 하드코딩과 어긋난다 — 예: 기존 `status.pending="待機"`인데 실제 렌더는 `"待機中"`(page.tsx / ScreenplayList / [id]/page.tsx:56). 기존 값을 맹목 재사용하지 말고 **현재 화면 문자열에 맞춰 재조정**할 것(ja 회귀 0 목표).
- ko.json 값 = 한국어. **일본어 유지 항목 예외**는 B-3 참조.
- **[검토 보완] 누락 문자열**: 약 20개 에러/토스트 문자열이 초안 스케치에 슬롯이 없었음 → `screenplay.errors.*`로 수용. 위치: `CheckResultPanel:205,229`; `FeedbackForm:37`; `GenerationProgress:81,85,87`; `ScreenplayCreateForm:194,195,233,265`; `ScreenplayImportForm:76,79,96,99,128,156`(.docx 검증 메시지).
- **[검토 보완] aria-label 5종**(a11y): `ScreenplayCreateForm:82 作成ステップ, :298 入力方法, :449 / ScreenplayImportForm:225 ファイルを削除, ScreenplayNewTabs:17 作成方法` → `screenplay.a11y.*`.

#### B-2. 컴포넌트 배선

대상 (제작 영역 하드코딩 파일):

- 페이지(서버): `screenplays/page.tsx`, `screenplays/new/page.tsx`, `screenplays/[id]/page.tsx` → `getTranslations`.
- 컴포넌트(클라이언트, 13개): `ScreenplayList`, `ScreenplayNewTabs`, `ScreenplayCreateForm`, `ProductBriefEditor`, `ScreenplayImportForm`, `GenerationProgress`, `ScreenplayWorkspace`, `ScreenplayHeaderBar`, `VersionTimeline`, `FeedbackForm`, `ChangeDiffView`, `CheckResultPanel`, `ReviewPanel` → `useTranslations`. (모두 `"use client"` 확인됨.)
- **[검토 보완] `ScreenplayViewer.tsx` 제외**: 사용자 텍스트 0개(17줄, `ScreenplayMarkdown` 래퍼). i18n 배선 불필요 → 대상에서 제거(컴포넌트 14→13개).
- **[검토 보완] `markdown-renderer.tsx` 부분 대상**: L8-21의 텔롭/화자 색상 맵(`テロップ/カメラ/...`, 화자명 `高橋/山内/...`)은 **DB 생성 마크다운과 매칭되는 corpus 키 → 일본어 유지**. UI 크롬 문자열 **L35 `完成版 台本`, L62 `場面転換` 2개만 번역**. 이 파일은 `"use client"`가 없고 클라이언트 부모가 렌더 → `useTranslations` 쓰려면 `"use client"` 추가하거나 두 문자열을 부모에서 prop으로 주입(후자 권장, 서버/클라 경계 최소 변경).

- 서버 컴포넌트는 `getTranslations`, 클라이언트는 `useTranslations`. 이미 `next-intl` 설정 존재(`layout.tsx`, `research/page.tsx`가 사용 중) → 인프라 변경 불필요.
- 소스 종류/상태 라벨 등 Part A에서 추가한 값도 이 네임스페이스에서 조회.

#### B-3. 유지(비대상) — ko에서도 일본어 유지

검토가 특정한 구체 위치(값 부분은 번역 금지, 접두 라벨만 번역 가능):
- **법령명**: `CheckResultPanel.tsx:263` `薬機法・景表法` 등.
- **DB corpus 값**: `CheckResultPanel.tsx:50` `根拠: {f.citedRule}`, `:54` `修正案: {f.suggestedRewrite}` — 값은 corpus, **접두 `根拠:`/`修正案:`만 번역**.
- **심의 도메인 용어**: `ReviewPanel.tsx:49/51` `第 N 稿`, `:41` `試験結果`(稿).
- **텔롭/화자 맵**: `markdown-renderer.tsx:8-21`.
- 생성된 대본 마크다운 본문 전체.
- 콘솔 로그/개발자용 문자열.
- **[검토 보완] `[id]/page.tsx:56-59` 중복 상태 맵**: `待機中/生成中/完成/失敗`를 하드코딩한 두 번째 STATUS_BADGE 맵이 있음 → `screenplay.status.*`로 일원화(중복 제거).

## 파일 변경 요약

**신규**
- `supabase/migrations/2026-07-07_screenplays_source_kind.sql`

**수정 (Part A)**
- `app/api/screenplays/route.ts` — source_kind 기록
- `components/screenplay/ScreenplayCreateForm.tsx` — sourceKind 전송(+ i18n)
- `app/[locale]/(produce)/screenplays/page.tsx` — 쿼리 확장(+ i18n)
- `components/screenplay/ScreenplayList.tsx` — 구분 UI(+ i18n)

**수정 (Part B)**
- `messages/ja.json`, `messages/ko.json` — screenplay 네임스페이스 확장
- 위 제작 영역 페이지 3개 + 컴포넌트 ~14개 — i18n 배선

## 검증

- `npx tsc --noEmit` (memory: TS 변경 후 필수).
- `npm run lint`.
- ja/ko 메시지 **키 패리티** 확인(스크립트 또는 수동 diff — 누락 키는 런타임 폴백되나 회귀).
- 로컬 실행으로 `/ko/screenplays`·`/ja/screenplays` 렌더 확인:
  - ko: 한국어 UI, 소스/카테고리/개정수/상품연결 배지 표시.
  - ja: 기존과 동일 일본어(문구 무변경).
  - 대본 본문은 양쪽 다 일본어 유지.
- 소스 종류 저장: 업로드/URL/임포트/상품 각 경로로 생성 → DB `source_kind` 확인.
- **[블로커 수정] 마이그레이션 순서 강제**: `source_kind`가 없는 상태로 코드가 배포되면 `.select("... source_kind ...")`가 에러 → `fetchList`가 `[]` 반환 → **목록 전체가 사라진다**(PostgREST에서 미지 컬럼 select는 graceful degrade 불가). "방어 쿼리"에 기대지 말 것. **안전 순서: (1) DB에 마이그레이션 적용·검증 → (2) 코드 머지/배포.** 스펙에 migrations-applied-manually 전제 명시.

## 비범위 (YAGNI)

- 테넌트/스타일 선택 UI(도쿄TV vs mediaworks) — 별도 작업.
- 대본 본문 한국어 생성.
- 실제 상품 썸네일 이미지 로드(아바타로 대체).
- 목록 필터/정렬 추가(소스별 필터 등).
