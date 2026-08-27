# 경쟁 방송 화법 코퍼스 → 구성 패턴 반영 대본 설계

- 작성일: 2026-08-24
- 개정: 2026-08-24 v2 — 5개 병렬 리뷰 반영. v1의 §4.3·§5.1·§5.2에 사실과 다른 단언이 있어 정정했다. 변경 요약은 §16.
- 상태: Design approved (brainstorming), v2 pending review
- 관련: `2026-05-19-competitive-snapshot-archival-design.md` (영상 아카이브 = 이 설계의 입력),
  `docs/superpowers/plans/2026-08-20-data-intelligence-sankey.md` (`planned` 노드 선언),
  `lib/pipeline/data-intelligence-graph.ts` (완료 정의가 걸려 있는 그래프 모델)

## 1. 배경 / 문제

`/analytics/pipeline` 상단의 데이터 인텔리전스 Sankey는 네 개 노드를 `planned`로 선언하고 있다.

| 노드 | 단계 |
| --- | --- |
| `datasetSceneIndex` (장면·시연 인덱스) | dataset |
| `datasetSellingLanguage` (판매 포인트·화법 데이터셋) | dataset |
| `outcomeCompetitiveScript` (경쟁 방송 패턴 반영 대본) | outcome |
| `outcomeDemoPlan` (시연·연출 설계) | outcome |

2026-08-24 코드·DB 감사에서 확인된 현재 상태:

- 영상 아카이브는 살아 있다. `broadcasts.archived_video_s3`가 채워진 행이 **5,019편, 3.2 TB** (중앙값 606 MB, p90 1.2 GB). QVC·ShopCh 두 채널만 대상.
- 그 영상은 **재생 외 용도가 없다.** `whisper|transcrib|transcript|STT` 코드 히트 0건. Gemini에 `mp4|m3u8|fileUri|audio/`를 넘기는 코드도 0건.
- 대본 생성기(`lib/screenplay/*`)를 `broadcasts|broadcast_products|qvc_products|historical_broadcasts|archived_video`로 grep한 실질 히트 **0건**.
- `styleBible`의 관측 표본은 `lib/screenplay/style-bible.json`의 `product_lineup_observed` = **대본 1편**(레이콥 침구청소기)이고, `buildSafeStyleReference`가 필러·전환 표현 최대 24개로 깎아 넣는다.

즉 3.2 TB의 경쟁사 방송을 모으면서, 대본은 그 데이터를 한 바이트도 보지 않는다.

## 2. 목표 / 비목표

**목표**

- 아카이브 영상에서 **구성·화법 패턴**을 구조화 데이터로 추출해 `datasetSellingLanguage`를 실재하게 만든다.
- 같은 카테고리 경쟁 방송의 집계 패턴을 대본 생성 프롬프트에 주입해 `outcomeCompetitiveScript`를 실재하게 만든다.
- Sankey의 두 노드를 `planned` → `current`로 전환하고, `scripts/test-data-intelligence-graph.ts`가 그 상태로 통과하게 한다.

**비목표 (다음 사이클)**

- `datasetSceneIndex`, `outcomeDemoPlan` — 시각 정보에 의존하므로 함께 미룬다.
- 전량 5,019편 처리. 이번 범위는 `家電` 단일 카테고리다 (§11).
- **방송 카테고리 ↔ 상품 카테고리 매퍼** (§6 참조). 이번 사이클은 화이트리스트 완전일치만 지원한다.
- `refine` 모드 대본에의 패턴 주입 (§7).
- 임베딩 / 벡터 검색. 구조적 집계만 사용한다.

## 3. 브레인스토밍 확정 사항

| 축 | 결정 | 이유 |
| --- | --- | --- |
| 범위 | **세로 슬라이스** — 영상 → 코퍼스 → 대본 프롬프트까지 최소 경로 하나 관통 | 이 코드베이스에는 이미 `broadcast_products` 22,645행과 `top_timeslots`가 "만들었는데 아무도 안 읽는" 상태로 있다. 소비처 없는 데이터셋을 또 만들지 않는다. |
| 활용 수준 | **구조·패턴만** | 고객의 `転用禁止` 원칙과 경쟁사 저작권. |
| 패턴 선택 | **카테고리 자동 매칭** | 운영자 추가 입력 없이 기존 플로우 유지. |
| 추출 방식 | **오디오 우선** (ffmpeg `-vn` → Gemini) | 오디오는 약 32 토큰/초로 영상 기본 해상도(약 263 토큰/초) 대비 약 1/8. 영상은 S3에 남아 장면 인덱스는 나중에 재처리 가능. |

## 4. 데이터 모델

### 4.1 `broadcasts` 큐 컬럼 추가

```sql
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS analysis_status   text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS analysis_error    text,
  ADD COLUMN IF NOT EXISTS analysis_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS analyzed_at       timestamptz;

-- ADD COLUMN IF NOT EXISTS ... CHECK 는 컬럼이 이미 있으면 제약까지 건너뛴다.
-- 멱등 재실행에서도 제약이 반드시 붙도록 따로 건다.
ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_analysis_status_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_analysis_status_check
  CHECK (analysis_status IN ('pending','queued','running','done','failed','skipped'));
```

상태 의미:

- `pending` — 아직 큐에 오르지 않음. 아카이브가 없거나 카테고리가 없는 슬롯도 여기 머문다. 나중에 enrich로 카테고리가 채워지면 자연히 시딩 대상이 된다.
- `queued` → `running` → `done | failed`
- `skipped` — 시딩 후 실행 시점에 조건이 깨진 경우(예: 카테고리가 지워짐). 시딩 단계는 `skipped`를 쓰지 않는다.

### 4.2 `broadcast_transcripts` — 원문, admin 전용

```sql
CREATE TABLE IF NOT EXISTS broadcast_transcripts (
  broadcast_id   uuid PRIMARY KEY REFERENCES broadcasts(id) ON DELETE CASCADE,
  segments       jsonb NOT NULL,   -- [{start_sec, end_sec, speaker_hint, text_ja}]
  act_summaries  jsonb NOT NULL,   -- [{start_sec, end_sec, act_type, summary_ja}]
  urgency_cues   jsonb NOT NULL,   -- 방송에서 들린 긴급성 문구 원문
  language       text  NOT NULL DEFAULT 'ja',
  model          text  NOT NULL,
  schema_version int   NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE broadcast_transcripts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON broadcast_transcripts FROM authenticated;

COMMENT ON TABLE broadcast_transcripts IS
  '경쟁 방송 축어 전사. 검증·재분석 전용. 프롬프트·API·UI 어디에도 연결하지 말 것. '
  'scripts/test-broadcast-intel-guard.ts 가 이 테이블명의 참조 위치를 강제한다.';
```

**자유 텍스트는 전부 여기에만 존재한다.** v1은 액트 요약(`summary_ja`)과 긴급성 문구를 member 읽기 테이블에 두었는데, `NEXT_PUBLIC_SUPABASE_ANON_KEY`는 브라우저에 나가므로 로그인한 member 누구나 PostgREST로 직접 읽을 수 있었다. 두 필드 모두 파이프라인 어디에서도 읽히지 않는 순수 부채였으므로 이 테이블로 옮긴다.

### 4.3 `broadcast_speech_analyses` — 패턴, member 읽기

```sql
CREATE TABLE IF NOT EXISTS broadcast_speech_analyses (
  broadcast_id        uuid PRIMARY KEY REFERENCES broadcasts(id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('qvc','shopch')),
  air_date            date NOT NULL,
  category            text,
  duration_sec        int  NOT NULL CHECK (duration_sec > 0),
  segments            jsonb NOT NULL,  -- [{startSec, endSec, actType}]
  selling_points      jsonb NOT NULL,  -- [{order, pointType, firstMentionedSec, repeatCount}]
  evidence_cues       jsonb NOT NULL,  -- [{type, atSec}]
  objection_handlings jsonb NOT NULL,  -- [{objectionType, atSec}]
  offer_timeline      jsonb NOT NULL,  -- {firstPriceSec, ctaSecs[]}
  model               text NOT NULL,
  schema_version      int  NOT NULL DEFAULT 1,
  analyzed_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bsa_category_idx
  ON broadcast_speech_analyses (category, air_date DESC);

ALTER TABLE broadcast_speech_analyses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bsa_select ON broadcast_speech_analyses;
CREATE POLICY bsa_select
  ON broadcast_speech_analyses FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member','admin'));
```

**이 테이블의 모든 jsonb 값은 숫자와 열거 라벨뿐이다.** 자유 텍스트 필드가 하나도 없으므로, member가 이 테이블 전체를 덤프해도 경쟁사 문장·상품명·가격은 나오지 않는다. v1은 같은 주장을 하면서 `summary_ja`와 `urgency_cues`를 담고 있었다 — 이제 그 주장이 참이다.

RLS는 인라인 `EXISTS(SELECT … FROM profiles)`가 아니라 최신 컨벤션인 `public.current_user_role()`(SECURITY DEFINER·stable)을 쓴다.

### 4.4 열거값

- `act_type`: `opening | problem | product_intro | demo | evidence | testimonial | offer | cta | closing`
- `point_type`: `efficacy | ease_of_use | price_value | safety | size_fit | durability | design | aftercare | scarcity`
- `evidence_cues.type`: `lab_test | demo | comparison | testimonial | expert | certification`
- `objection_type`: `price | doubt_efficacy | difficulty | space | maintenance | timing`

`lib/broadcast-intel/schema.ts` 한 곳에 정의하고, Gemini 스키마와 집계 코드가 같은 상수를 import한다.

### 4.5 `screenplay_versions` 재현성 컬럼

```sql
ALTER TABLE screenplay_versions
  ADD COLUMN IF NOT EXISTS pattern_snapshot jsonb;
```

### 4.6 마이그레이션 파일

`supabase/migrations/20260825090000_broadcast_speech_analyses.sql` 단일 파일에 4.1–4.3, 4.5를 담는다. 이 저장소에는 마이그레이션 러너가 없고 `scripts/apply-sql-file.ts`가 파일 하나를 적용한다 — 접두 타임스탬프는 정렬 규약일 뿐 순서를 보장하지 않는다. `SUPABASE_DB_PASSWORD`가 `.env.local`에 필요하며 현재 없다 (§14).

## 5. 추출 파이프라인

새 모듈 `lib/broadcast-intel/`.

| 파일 | 책임 |
| --- | --- |
| `schema.ts` | 열거값 + Gemini 스키마 + 결과 타입. 순수. |
| `audio-extract.ts` | S3 스트림 → ffmpeg → 모노 AAC(ADTS) + 실측 러닝타임 |
| `gemini-analyze.ts` | Files API 업로드 → 구조화 호출 → 검증된 JSON |
| `persist.ts` | 두 테이블 분리 저장 (자유 텍스트는 transcripts에만) |
| `analyze-one.ts` | 단일 슬롯 오케스트레이션 |
| `queue.ts` | 시딩 + 스테일 회수 |
| `category-pattern.ts` | 카테고리 집계 |
| `format-prompt.ts` | 프롬프트 블록 생성 |

- ffmpeg는 번들된 `@ffmpeg-installer/ffmpeg`를 쓴다.
- 출력은 **ADTS AAC(`-f adts`, `audio/aac`)**. `audio/mp4`는 Gemini 지원 오디오 MIME이 아니다.
- 모델은 `GEMINI_FLASH`, 5xx 시 `GEMINI_PRO_FALLBACK`. `maxOutputTokens: 32768`을 명시한다 — 25분 축어 전사는 15,000~30,000 출력 토큰이라 상한 없이 두면 절단되고, 절단은 `JSON.parse` 실패 → 606 MB 재다운로드로 이어진다. `finishReason === "MAX_TOKENS"`는 재시도하지 않고 즉시 `failed`로 고정한다.

### 5.1 러닝타임 — 헤더가 아니라 진행 출력에서 읽는다

아카이브는 `-movflags frag_keyframe+empty_moov`로 기록되어 **moov에 duration이 없다.** 저장된 MP4를 non-seekable 파이프로 다시 읽으면 ffmpeg는 프로브 창 길이를 duration으로 보고한다.

실측 (600초 fragmented MP4, 동일 플래그, `-i pipe:0`):

```
Duration: 00:00:50.02      ← 헤더 보고값. 틀림
time=00:09:59.97           ← 마지막 진행 출력. 정확
```

따라서 `lib/broadcasts/video-archival.ts::parseDurationFromStderr`(= `Duration:` 파싱)를 **재사용해서는 안 된다.** 새 `parseOutputDurationFromStderr`가 stderr의 **마지막 `time=`** 을 읽는다. 이 값은 실제로 디먹싱된 길이이므로 컨테이너 메타데이터와 무관하게 정확하다.

v1은 "저장된 MP4는 길이가 확정되어 있다"고 단언했다. 근거 없는 가정이었고, 그대로 구현했다면 모든 슬롯의 러닝타임이 50초 안팎으로 오염된 채 `duration_sec > 0` CHECK를 통과해 **아무 테스트도 실패하지 않았을 것이다.**

파싱에 실패하면(진행 출력이 하나도 없으면) 그 슬롯은 **재시도 없이 즉시 `failed`** 로 고정한다. 결정론적 실패에 606 MB 다운로드를 3회 반복할 이유가 없다.

진행 출력을 살려야 하므로 `-nostats`를 쓸 수 없다. 대신 stderr 버퍼를 마지막 64 KB로 링 버퍼링해 25분 트랜스코드의 progress 라인이 무한 누적되지 않게 한다.

### 5.2 큐, 시딩, 회수, 처리량

**시딩** (`queue.ts::seedAnalysisQueue({ limit, category })`): `archived_video_s3 IS NOT NULL` 이고 `category`가 해당 채널 화이트리스트에 있는 `pending` 행을 `queued`로 올린다.

PostgREST는 **UPDATE에 걸린 `.limit()`을 무시한다** (실측: `limit(2)`로 13행이 갱신됨). 반드시 `SELECT id … ORDER BY air_date DESC LIMIT n` → `UPDATE … IN (ids)` 2단계로 분리한다. 이 단계에 `category` 인자가 없으면 첫 실행에 아카이브 전체가 큐로 올라가 §11의 슬라이스 범위와 §12의 egress 판단이 무의미해진다.

**스테일 회수** (`queue.ts::recoverStaleAnalysis`): 함수 타임아웃·배포·로컬 Ctrl-C로 `running`에 갇힌 슬롯은 자가 치유되지 않는다 — 큐는 `queued`만 선택하고 `analyzeOne`의 모든 UPDATE에 `.eq("analysis_status","running")` 가드가 있기 때문이다. `lib/broadcasts/stale-downloading-recovery.ts::recoverStaleDownloading`과 같은 형태로 `updated_at < now() - 30m AND analysis_status = 'running'` → `queued`, attempts+1을 구현하고 크론·드레인 양쪽 첫머리에서 호출한다.

**처리량.** v1의 "실행당 6~10편"은 산술적으로 불가능했다. 편당 지연은 Gemini 출력 토큰이 지배하며 100~200초다. `maxDuration=300`, 예산 240초, 동시성 2면 크론 1회에 **최대 2~4편**이다.

따라서 **백필은 크론이 아니라 로컬 드레인으로 한다.** 크론은 매일 새로 아카이브되는 소량을 따라잡는 역할만 맡는다. 예산은 배치 시작 시점뿐 아니라 **슬롯 예상 소요를 뺀 값**으로 확인하고, `analyzeOne` 자체에 200초 타임아웃을 걸어 함수 수명을 넘기지 못하게 한다.

크론 시각은 `archive-videos`(`0 */2`)와 겹치지 않는 **홀수시**로 잡는다. v1의 `0 20 * * *`는 짝수시라 정면 충돌이었다.

## 6. 카테고리 집계

`lib/broadcast-intel/category-pattern.ts::loadCategoryPattern(category)`.

집계 테이블을 두지 않고 대본 생성 시점에 계산한다. 대본 생성은 전체 이력 22건으로 빈도가 낮다.

**카테고리 매칭 — 이번 사이클은 화이트리스트 완전일치만.** v1은 `lib/strategy/category-mapping.ts::buildCategoryMatchTerms`를 재사용하려 했으나, 그 헬퍼는 방송 분류가 아니라 **자사 매출 분류**로 매핑한다. `家電`은 우연히 양쪽에 존재해 테스트가 통과할 뿐이고, `美容・スキンケア` → `["美容","スキンケア","化粧品",…]`는 QVC의 `ビューティ`·ShopCh의 `コスメ` 어느 것과도 매칭되지 않아 대부분의 카테고리에서 조용히 null이 된다.

이번 사이클은 상품 카테고리가 `CATEGORIES_BY_CHANNEL`의 값과 **정확히 일치할 때만** 집계한다. 그 외에는 null을 반환하고 블록을 주입하지 않는다. 방송 카테고리 ↔ 상품 카테고리 매퍼는 §15로 미룬다 — 슬라이스가 `家電` 하나이므로 이번 사이클에 필요하지 않다.

**쿼리 상한.** SELECT 목록에 자유 텍스트가 없으므로(§4.3) 행이 가볍지만, 그래도 `air_date >= now() - BROADCAST_INTEL_LOOKBACK_DAYS`(기본 180)와 `maxRows` 상한을 건다. 호출부는 5초 타임아웃으로 감싸 집계가 대본 생성을 블로킹하지 못하게 한다.

**러닝타임 정규화.** 모든 타이밍은 러닝타임 대비 비율로 집계하고 중앙값 절대시간을 병기한다. 운영자가 `customization.runtimeMinutes`를 지정한 경우의 환산은 **프롬프트 지시로 처리한다** — 블록이 비율을 싣고 모델이 본 상품의 尺에 맞춰 환산한다. v1은 코드 레벨 환산을 시사했으나 구현이 없었다.

**최소 표본 게이트는 fail-closed.** `BROADCAST_INTEL_MIN_SAMPLES`(기본 5) 미만이면 `null`. `competitor_fit_analyses`가 총 7행으로 fit-weighting을 사실상 죽여 놓은 것과 같은 함정을 피한다.

**액트 시퀀스의 의미론.** `medianShare`는 액트별 독립 중앙값이라 합이 1이 아니고, 한 방송에 두 번 등장한 액트는 두 번 계산되며, 40편 중 1편에만 있는 액트가 전편에 있는 액트와 같은 비중으로 정렬될 수 있다. 따라서 각 액트에 `presenceRate`를 함께 싣고, 프롬프트는 이를 "標準構成比"라고 단정하지 않는다.

```ts
interface CategoryPattern {
  category: string;
  sampleSize: number;
  channels: string[];
  runtimeMedianSec: number;
  actSequence: Array<{ actType: ActType; medianShare: number; medianStartShare: number; presenceRate: number }>;
  sellingPointOrder: Array<{ pointType: PointType; medianOrder: number; presenceRate: number }>;
  evidenceMix: Array<{ type: EvidenceType; presenceRate: number }>;
  objectionMix: Array<{ type: ObjectionType; presenceRate: number }>;
  offerTiming: { firstPriceShare: number | null; firstPriceMedianSec: number | null; ctaCountMedian: number };
}
```

## 7. 프롬프트 주입

`format-prompt.ts::formatCategoryPatternBlock(pattern)`. `buildUserPrompt`의 **`initial` 모드에만** 주입한다.

**`category` 살균.** `pattern.category`는 DB 화이트리스트 값이 아니라 상품 브리프의 편집 가능한 자유 텍스트이며 블록에 그대로 렌더링된다. 개행·마크다운 헤딩·제어문자를 제거하고 40자로 자른 뒤 렌더한다. 이것이 이 블록의 유일한 사용자 입력 경로다.

```
## 競合放送の構成パターン（同カテゴリ N件の集計・構成の参考のみ）
- 集計対象: {category} / {channels} / N番組 / 尺中央値 M分
- よく見られる構成: 導入 8%（出現 100%） → 問題提起 12%（92%） → …
- 販売ポイント提示順: …
- 根拠提示の型: 実演 92% / 比較 61% / 試験成績 38%
- 想定される視聴者の懸念: 価格への抵抗 70% / 効果への疑い 55%
- オファー進行: 価格初出は尺の 62%（中央値 15分00秒）、CTA 中央値 3回
- 用途制限: 構成設計にのみ使用する。競合商品の名称・数値・性能・特典・固有の実演内容は
  含まれておらず、推測して補完してはならない。上記の比率は本商品の尺に換算して用いる。
```

`## 根拠の優先順位`는 4단에서 5단이 되고 새 블록이 **3위**에 들어간다. 패턴이 `null`이거나 `BROADCAST_INTEL_ENABLED`가 꺼져 있으면 블록도 우선순위 항목도 넣지 않으며, 프롬프트는 기존과 바이트 단위로 동일하다.

## 8. 노출과 재현성

`screenplay_versions.pattern_snapshot`에 생성 시 계산된 `CategoryPattern`을 저장한다. **`initial` 모드에서만** 저장한다 — `screenplay.workflow.ts`의 `generateStep`/`persistStep` 호출 지점은 initial과 refine이 공유하므로, `input.mode`로 게이트하지 않으면 refine 버전이 쓰지도 않은 패턴을 주장하게 된다.

대본 상세에 "경쟁 방송 구성 패턴 N편 반영"을 표시한다. 현재 이 화면에는 model·thinking_level 같은 provenance를 렌더하는 자리가 **하나도 없으므로** 새로 만들어야 하며, 페이지 쿼리에 `pattern_snapshot`을 추가해야 한다.

## 9. Sankey 상태 전환 — 완료 정의

`lib/pipeline/data-intelligence-graph.ts`에서 네 가지를 `planned` → `current`로 바꾼다: 노드 `datasetSellingLanguage`, `outcomeCompetitiveScript`, 링크 `sourceMediaArchive → datasetSellingLanguage`, `datasetSellingLanguage → outcomeCompetitiveScript`. `datasetSceneIndex`·`outcomeDemoPlan`과 그에 닿는 링크는 `planned`로 남는다.

`scripts/test-data-intelligence-graph.ts`가 갱신된 기대값으로 통과하는 시점이 이 기능의 완료 정의다.

## 10. 테스트

| 명령 | 성격 | 내용 |
| --- | --- | --- |
| `npm run test:broadcast-intel-schema` | 순수 | 파서 동작(열거값 보존/미지값 드롭/범위 밖 드롭), 러닝타임 파서 |
| `npm run test:broadcast-intel-aggregate` | 순수 | 집계 수학, 비율 정규화, 러닝타임 혼재, fail-closed 게이트 |
| `npm run test:broadcast-intel-prompt` | 순수 | 블록 수치 정확성, **집계 산출물 누출 테스트**, category 살균, refine 미주입 |
| `npm run test:broadcast-intel-guard` | 순수 | `broadcast_transcripts` 참조가 허용목록 밖에 등장하면 실패 |
| `npm run test:data-intelligence-graph` | 순수 | §9 기대값 |
| `npm run check:i18n` | 순수 | ja/ko 키 패리티 (`test:message-parity`라는 alias는 없다) |
| `npm run test:broadcast-intel-live` | 라이브 | 실제 방송 1편 관통 + `pattern_snapshot` 확인 |

**누출 테스트의 경계는 포매터가 아니라 집계 산출물과 SELECT 목록이다.** v1은 `formatCategoryPatternBlock`의 출력에 금지 문자열이 없음을 단언했는데, `CategoryPattern` 타입에 애초에 그 필드가 없어 빈 구현으로도 통과하는 무의미한 테스트였다. v2는 `aggregatePattern`이 반환한 객체 전체를 `JSON.stringify`해 검사하고, 키 집합을 고정해 자유 텍스트 필드가 몰래 추가되면 실패하게 한다.

품질 판정은 자동 테스트로 대신하지 않는다. 40편 처리 후 같은 상품으로 **주입 전/후 대본을 블라인드 비교**하며, 채점 항목은 `docs/japan/2026-08-21-client-request-ja.md`의 기록 시트를 그대로 쓴다.

## 11. 범위 — 초기 슬라이스

`家電` 카테고리 345편(QVC·ShopCh 양쪽) 중 **최근 40편**. `家電`은 두 채널 화이트리스트에 모두 존재하는 값이라 §6의 완전일치 매칭이 성립한다. 유일하게 확보된 승인 대본(레이콥 침구청소기)과 같은 상품군이고, 기존 `competitor_fit_analyses` 2건도 전부 `家電`이다.

참고 — 아카이브 카테고리 분포: ファッション 1,244 · ビューティ 503(qvc) · ホーム・インテリア 448(shopch) · コスメ 426(shopch) · 健康・ダイエット 382(qvc) · 家電 345(양쪽).

## 12. 비용·운영

- **S3 egress**: 40편 × 606 MB(중앙값) = 24 GB. p90 1.2 GB의 우편향을 감안하면 실제 30~48 GB. 인터넷 egress $0.09/GB 기준 슬라이스 약 $2~4. 전량 5,019편은 3.0~3.2 TB, 약 $290 (1회). **비용은 걸림돌이 아니다** — 걸림돌은 §5.2의 처리량이다.
- **메모리**: 606 MB는 S3 스트림에서 ffmpeg stdin으로 버퍼링 없이 흐른다. 메모리에 남는 것은 추출된 오디오 약 6 MB뿐이고 `/tmp`를 쓰지 않는다.
- **처리 속도**: 편당 100~200초. 초기 40편은 로컬 드레인으로 약 1.5~2.5시간.

## 13. 환경변수

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `BROADCAST_INTEL_ENABLED` | `false` | 프롬프트 주입 킬 스위치 |
| `BROADCAST_INTEL_MIN_SAMPLES` | `5` | 집계 최소 표본 (fail-closed) |
| `BROADCAST_INTEL_LOOKBACK_DAYS` | `180` | 집계 대상 기간 |
| `BROADCAST_INTEL_BATCH_CONCURRENCY` | `2` | 드레인 동시성 |
| `BROADCAST_INTEL_MAX_ATTEMPTS` | `3` | 실패 고정 임계 |
| `BROADCAST_INTEL_SLOT_TIMEOUT_MS` | `200000` | 단일 슬롯 상한 |

v1의 `PATTERN_MIN_SAMPLES`는 접두사가 없어 충돌 위험이 있었으므로 이름을 바꿨다.

## 14. 착수 전 조치 (블로커)

1. **`SUPABASE_DB_PASSWORD`가 `.env.local`에 없다.** `scripts/apply-sql-file.ts`가 이 값을 요구하므로 마이그레이션 적용이 불가능하다. 값을 채워야 Task 1이 시작된다.
2. **죽은 `GEMINI_API_KEY`.** `~/.zshenv:2`와 `~/.zshrc:10`이 무효 키(HTTP 400)를 export하고, Node의 `--env-file`은 기존 환경변수를 덮어쓰지 않으므로 모든 로컬 `tsx --env-file=.env.local` 실행이 죽은 키를 쓴다. `.env.local`의 키는 정상(HTTP 200)이다. **이 두 줄 제거는 사람이 해야 하며 에이전트가 대신 수행해서는 안 된다.**

## 15. 스코프 외 / 다음 사이클

- **방송 카테고리 ↔ 상품 카테고리 매퍼** — `家電` 외 카테고리로 넓히려면 필수. 이번 사이클의 완전일치는 임시 조치다.
- `datasetSceneIndex` / `outcomeDemoPlan` — 아카이브 영상 재처리. 영상은 삭제하지 않으므로 언제든 가능.
- 전량 5,019편 확장 (§5.2 처리량 해결 이후).
- `refine` 모드 패턴 주입.
- `broadcast_transcripts` 보존 기한·퍼지 잡.
- OA 10채널 — `historical_broadcasts`에는 영상이 없다.
- 운영자 수동 참조 방송 선택.

## 16. v1 → v2 변경 요약

병렬 리뷰 5건에서 블로커 11건·MAJOR 17건이 나왔다. 설계에 영향을 준 것만:

| v1 | v2 |
| --- | --- |
| "저장된 MP4는 길이가 확정되어 있다" | **거짓.** 프로브 창 값이 나온다(실측 600초 → 50초 보고). 마지막 `time=`을 쓴다 (§5.1) |
| 패턴 테이블에 "자유 텍스트 컬럼이 없다" | **거짓이었다.** `summary_ja`·`urgency_cues`를 담고 있었고 member가 anon key로 읽을 수 있었다. transcripts로 이관해 이제 참 (§4.2·§4.3) |
| `buildCategoryMatchTerms` 재사용 | 매출 분류 매퍼라 부적합. 화이트리스트 완전일치로 축소, 매퍼는 §15 |
| `.update().limit()`로 시딩 | PostgREST가 limit을 무시한다. SELECT→UPDATE IN 2단계 (§5.2) |
| `audio/mp4` | Gemini 미지원 MIME. ADTS AAC (§5) |
| 크론이 백필, 실행당 6~10편 | 산술 불가. 크론 2~4편, 백필은 로컬 드레인 (§5.2) |
| `running` 회수 없음 | `recoverStaleAnalysis` 추가 (§5.2) |
| `maxOutputTokens` 없음 | 32768 명시 + MAX_TOKENS 즉시 failed (§5) |
| 누출 테스트 = 포매터 출력 | 빈 구현으로도 통과했다. 집계 산출물과 키 집합으로 이동 (§10) |
| `category` 무살균 | 프롬프트 인젝션 경로. 살균 후 렌더 (§7) |
| `PATTERN_MIN_SAMPLES` | `BROADCAST_INTEL_MIN_SAMPLES` (§13) |
| 크론 `0 20 * * *` | `archive-videos`와 충돌. 홀수시 (§5.2) |

## 17. 구현 상태 (2026-08-27 갱신)

코드는 전부 `main`에 병합됐고, 파이프라인이 실제 방송으로 관통 검증됐다. 남은 것은 코퍼스 적재와 사람에 의한 품질 평가다.

**그린**: `npm run test:broadcast-intel`(순수 5종), `test:data-intelligence-graph`, `check:i18n`, `tsc --noEmit`, `lint`.

### 라이브 검증에서 드러난 것 (테스트로는 잡히지 않던 것들)

| 결함 | 조치 |
| --- | --- |
| S3 `GetObject` 권한 없음 | CloudFront 경유로 전환 |
| 분석이 러닝타임의 77~80%에서 끊기고 `closing`으로 위장 | 프롬프트에 실측 러닝타임 명시 → 양쪽 100% |
| `duration_sec < 300` 단언이 정상 데이터 탈락 | 커버리지 기준으로 교체 |
| CloudFront 403을 영구 실패로 오분류 | 403은 재시도 가능, 404만 영구 |
| 액트 반복을 개별 인스턴스 길이로 집계 | 총 점유율 + 반복 횟수로 변경 |
| 고정 10액트가 측정 패턴을 완전히 무력화 | 패턴 있을 때 러닝오더를 패턴에서 도출 |
| 콜드 사전 확인이 `HeadObject` 403으로 무용지물 | `ListObjectsV2` 기반으로 교체 |

### 패턴 주입 효과 — 대조군 포함 측정 (2026-08-27, ShopCh ファッション 5편 집계)

| | OFF ×3 | ON ×4 |
| --- | --- | --- |
| 액트 수 | 9 / 9 / 9 (템플릿 고정) | 10 / 17 / 17 / 17 |
| 실연 전용 액트 | 0 | 4 |
| 문면 거리 | 그룹내 0.754 | 그룹간 0.806 (11쌍 전부 같은 방향) |
| 경쟁사 고유명사 | 없음 | 없음 |
| 전문가·후기 날조 | 0 | 0 (패턴이 100%라 해도 브리프 근거 없으면 생성 안 함) |

**주의**: 이는 "구조가 바뀐다"의 증명이지 "대본이 더 좋다"의 증명이 아니다. 사람에 의한 채점은 아직 없다.

### 정식 경로 통합 검증 (2026-08-27, 로컬 dev 3001)

배포 없이 실제 엔드포인트를 그대로 호출해 확인했다. 그 전까지 A/B 는 `generateScreenplay` 를 직접 불러 우회했기 때문에 라우트·워크플로·UI 가 한 번도 실행되지 않은 상태였다.

**크론 라우트** `GET /api/cron/analyze-broadcast-audio`
`{"ok":true,"seeded":10,"processed":94,"skipped":94,"duration_ms":10160}` — 94편 전부 콜드로 걸러졌고 다운로드는 0건. `ListObjectsV2` 기반 사전 확인이 실제로 동작함을 확인.

**대본 워크플로** `POST /api/screenplays` (브라우저 로그인 세션 사용)

| | 플래그 OFF | 플래그 ON |
| --- | --- | --- |
| HTTP / 완료 | 200 / ready 80초 | 200 / ready 80초 |
| `pattern_snapshot` | null | `ファッション` 5편 |
| 액트 | 9개 (템플릿) | 17개 (패턴 기반) |
| UI 표시 | 없음 | `競合放送の構成パターン 5件を反映` |

考査 패널도 자동 실행되어 `QUALITY INDEX 93 / 高リスク 0件` — 패턴 주입 대본이 기존 심의 체크를 통과한다.

**운영 주의**: `BROADCAST_INTEL_ENABLED` 는 앱 프로세스 환경에서 읽힌다. 워크플로가 Next 서버 안에서 실행되므로 스크립트에 걸면 무시된다. 배포 시 **Vercel 환경변수**로 설정할 것. 재배포 없이 값만 지우면 즉시 원복된다.

**참고**: 워크플로 SDK 는 `"use workflow"` 지시어를 Next 빌드가 변환하므로, tsx 로 `start(screenplayWorkflow, ...)` 를 직접 호출할 수 없다. 정식 경로 검증은 반드시 HTTP 라우트를 통해야 한다.

**별건**: `npm run e2e:screenplay` 가 11 스텝 중 8개 실패. 원인은 `3874c8b Revamp MediaWorks UI and screenplay workspace` 이후 UI 가 바뀌었는데 스크립트가 따라가지 않은 것 — 이 기능과 무관하나 대본 생성 골든패스 회귀 테스트가 죽어 있다.

### 인프라 상태

- S3 라이프사이클: `holding-archive-2026-08-08` 규칙이 **생성 1일 후 DEEP_ARCHIVE**로 전환하고 있었다(설계 문서의 "N년 후" 의도와 어긋남). 2026-08-27 **Glacier Instant Retrieval로 변경** — 이후 신규 객체는 복원 불필요.
- 기존 콜드 5,051건(3.24TB)은 자동 복구되지 않음. `家電` 345편(160GB)에 **2026-08-27 Standard tier 복원 요청 완료**, 14일 보관. 약 12시간 후 사용 가능.
- IAM `mediaworks-broadcast-archiver`에 `s3:GetObject` + `s3:RestoreObject` 추가됨(2026-08-27).

### 다음 순서

1. `npm run restore:archives -- --category=家電 --status` — 복원 완료 확인
2. `npm run drain:broadcast-analysis -- --limit=40 --category=家電 --channel=shopch` (약 43분, Gemini 약 $4.4)
3. `家電` 집계로 프롬프트 블록 생성 확인
4. **정식 워크플로로** 대본 A/B 생성 — `pattern_snapshot`이 DB에 남아야 함 (현재 0건)
5. **운영자 채점** — `docs/japan/2026-08-21-client-request-ja.md`의 시트로 블라인드 평가. 이 단계만이 "쓸 만한가"에 답한다

### 운영 메모

- 로컬 실행은 `env -u GEMINI_API_KEY` 를 붙일 것. Claude Code 프로세스가 죽은 키를 물려받은 경우가 있었다(셸 rc는 2026-08-27 정리됨).
- 로컬 드레인은 `BROADCAST_INTEL_SLOT_TIMEOUT_MS=600000` 권장. 기본 200초는 인리전 S3 기준이라 가정 회선에서는 부족하다.

### 후속 과제 (병합 차단 아님)

- 채널별 매체가 다름: QVC는 2분 다이제스트(오퍼 구간 없음), ShopCh는 59분 완결 프로그램. 한 집계에 섞으면 안 되며 `--channel`로 분리한다.
- ShopCh 전사 커버리지는 43% 수준(59분에 28줄). 구조 분석은 100%지만 축어 전사는 표본에 가깝다. 테이블 주석의 "축어 전사" 표현을 정정할 것.
- 방송 카테고리 ↔ 상품 카테고리 매퍼 부재 — 현재 완전일치만 지원.
- 신규 두 테이블의 RLS를 member/viewer 클라이언트로 검증하는 테스트 없음.
