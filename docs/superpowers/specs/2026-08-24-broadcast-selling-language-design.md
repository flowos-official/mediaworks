# 경쟁 방송 화법 코퍼스 → 구성 패턴 반영 대본 설계

- 작성일: 2026-08-24
- 상태: Design approved (brainstorming) → pending spec review
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
- 대본 생성기(`lib/screenplay/*`)를 `broadcasts|broadcast_products|qvc_products|historical_broadcasts|archived_video`로 grep한 실질 히트 **0건**. 프롬프트 입력은 정적 페르소나 + 상품 브리프 + 운영자 지시 + `styleBible` 네 개뿐이다.
- `styleBible`의 관측 표본은 `lib/screenplay/style-bible.json`의 `product_lineup_observed` = **대본 1편**(레이콥 침구청소기)이고, `buildSafeStyleReference`가 필러·전환 표현 최대 24개로 깎아 넣는다. `lib/screenplay/style/`에는 `README.md`만 있고 테넌트 파일은 없다.

즉 3.2 TB의 경쟁사 방송을 모으면서, 대본은 그 데이터를 한 바이트도 보지 않는다. 2026-08-21 고객 문서(`docs/japan/2026-08-21-client-request-ja.md`)가 지적한 "범용 AI와 무엇이 다른가"에 대한 유일한 고유 자산이 사용되지 않은 채 저장만 되고 있는 상태다.

## 2. 목표 / 비목표

**목표**

- 아카이브 영상에서 **구성·화법 패턴**을 구조화 데이터로 추출해 `datasetSellingLanguage`를 실재하게 만든다.
- 같은 카테고리 경쟁 방송의 집계 패턴을 대본 생성 프롬프트에 주입해 `outcomeCompetitiveScript`를 실재하게 만든다.
- Sankey의 두 노드를 `planned` → `current`로 전환하고, `scripts/test-data-intelligence-graph.ts`가 그 상태로 통과하게 한다.

**비목표 (다음 사이클)**

- `datasetSceneIndex` — 시각 정보(클로즈업, 텔롭, 비교 실험 화면). 오디오만 쓰므로 이번에 만들지 않는다.
- `outcomeDemoPlan` — 시연·연출 설계. 장면 인덱스에 의존하므로 함께 미룬다.
- 전량 5,019편 처리. 이번 범위는 단일 카테고리 슬라이스다 (§9).
- `refine` 모드 대본에의 패턴 주입 (§7).
- 임베딩 / 벡터 검색. 구조적 집계만 사용한다.

## 3. 브레인스토밍 확정 사항

| 축 | 결정 | 이유 |
| --- | --- | --- |
| 범위 | **세로 슬라이스** — 영상 → 코퍼스 → 대본 프롬프트까지 최소 경로 하나를 관통 | 이 코드베이스에는 이미 `broadcast_products` 22,645행과 `top_timeslots`가 "만들었는데 아무도 안 읽는" 상태로 있다. 소비처 없는 데이터셋을 또 만들지 않는다. |
| 활용 수준 | **구조·패턴만** — 원문은 코퍼스에 남기되 프롬프트에는 추상화된 것만 | 고객의 `転用禁止` 원칙(상품명·수치·성능·시험·전문가·후기·특전·고유 실연)과 경쟁사 저작권. |
| 패턴 선택 | **카테고리 자동 매칭** | 운영자 추가 입력 없이 기존 대본 생성 플로우 유지. 카테고리 집계라 특정 방송 모방 위험이 낮다. |
| 추출 방식 | **오디오 우선** (ffmpeg `-vn` → Gemini) | 오디오는 약 32 토큰/초로 영상 기본 해상도(약 263 토큰/초) 대비 약 1/8. 이번 목표에 필요한 신호는 대부분 발화에 있다. 영상은 S3에 남아 있어 장면 인덱스는 나중에 재처리 가능. |

## 4. 데이터 모델

### 4.1 `broadcasts` 큐 컬럼 추가

기존 `video_status` 큐 패턴을 그대로 복제한다.

```sql
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS analysis_status   text NOT NULL DEFAULT 'pending'
    CHECK (analysis_status IN ('pending','queued','running','done','failed','skipped')),
  ADD COLUMN IF NOT EXISTS analysis_error    text,
  ADD COLUMN IF NOT EXISTS analysis_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS analyzed_at       timestamptz;

CREATE INDEX IF NOT EXISTS broadcasts_analysis_queue_idx
  ON broadcasts (analysis_status, air_date DESC)
  WHERE archived_video_s3 IS NOT NULL;
```

큐 조건은 `archived_video_s3 IS NOT NULL` **그리고** `category`가 non-null이면서 해당 채널의 화이트리스트(`lib/broadcasts/whitelist-gate.ts::CATEGORIES_BY_CHANNEL`)에 있는 것. 나머지는 `skipped`.

주의: 이 조건은 표시용 게이트 `isWhitelistedSlot`과 **다르다.** 표시 게이트는 fail-open이라 category가 null인 슬롯을 통과시키지만, 카테고리 집계가 목적인 이 큐에서는 category가 없는 슬롯을 분석해도 어디에도 귀속시킬 수 없으므로 제외한다. 나중에 enrich로 category가 채워지면 `pending`으로 되돌려 재평가할 수 있게 `skipped` 사유를 `analysis_error`에 남긴다.

### 4.2 `broadcast_transcripts` — 원문, admin 전용

```sql
CREATE TABLE IF NOT EXISTS broadcast_transcripts (
  broadcast_id   uuid PRIMARY KEY REFERENCES broadcasts(id) ON DELETE CASCADE,
  segments       jsonb NOT NULL,   -- [{start_sec, end_sec, speaker_hint, text_ja}]
  language       text  NOT NULL DEFAULT 'ja',
  model          text  NOT NULL,
  schema_version int   NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE broadcast_transcripts ENABLE ROW LEVEL SECURITY;

-- Group B: admin read only, service_role write. Deliberately NOT member-readable.
DROP POLICY IF EXISTS broadcast_transcripts_select ON broadcast_transcripts;
CREATE POLICY broadcast_transcripts_select
  ON broadcast_transcripts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));
```

검증·재분석 용도로만 존재한다. member가 읽는 어떤 경로에도 연결하지 않는다.

### 4.3 `broadcast_speech_analyses` — 패턴, member 읽기

```sql
CREATE TABLE IF NOT EXISTS broadcast_speech_analyses (
  broadcast_id        uuid PRIMARY KEY REFERENCES broadcasts(id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('qvc','shopch')),
  air_date            date NOT NULL,
  category            text,
  duration_sec        int  NOT NULL CHECK (duration_sec > 0),
  segments            jsonb NOT NULL,  -- [{start_sec, end_sec, act_type, summary_ja}]
  selling_points      jsonb NOT NULL,  -- [{order, point_type, first_mentioned_sec, repeat_count}]
  evidence_cues       jsonb NOT NULL,  -- [{type, at_sec}]
  objection_handlings jsonb NOT NULL,  -- [{objection_type, at_sec}]
  offer_timeline      jsonb NOT NULL,  -- {first_price_sec, cta_secs[], urgency_cues[]}
  model               text NOT NULL,
  schema_version      int  NOT NULL DEFAULT 1,
  analyzed_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bsa_category_idx ON broadcast_speech_analyses (category, air_date DESC);

ALTER TABLE broadcast_speech_analyses ENABLE ROW LEVEL SECURITY;

-- Group A: member/admin read, service_role write.
DROP POLICY IF EXISTS bsa_select ON broadcast_speech_analyses;
CREATE POLICY bsa_select
  ON broadcast_speech_analyses FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('member','admin')));
```

`channel`/`air_date`/`category`는 집계 성능을 위한 비정규화다.

**이 테이블에는 상품명·가격·수치·문장 컬럼이 존재하지 않는다.** "구조·패턴만"이라는 결정이 주석이 아니라 스키마로 강제되며, 원문이 프롬프트로 새는 경로가 물리적으로 없다.

### 4.4 열거값

- `act_type`: `opening | problem | product_intro | demo | evidence | testimonial | offer | cta | closing`
- `point_type`: `efficacy | ease_of_use | price_value | safety | size_fit | durability | design | aftercare | scarcity`
- `evidence_cues.type`: `lab_test | demo | comparison | testimonial | expert | certification`
- `objection_type`: `price | doubt_efficacy | difficulty | space | maintenance | timing`

열거값은 `lib/broadcast-intel/schema.ts` 한 곳에 정의하고, Gemini structured output 스키마와 집계 코드가 같은 상수를 import한다.

### 4.5 `screenplay_versions` 재현성 컬럼

```sql
ALTER TABLE screenplay_versions
  ADD COLUMN IF NOT EXISTS pattern_snapshot jsonb;
```

기존 `model` / `thinking_level` / `token_usage`와 같은 성격이다. 어떤 집계 패턴이 그 버전을 만들었는지 남긴다.

### 4.6 마이그레이션 파일

최신 컨벤션(타임스탬프 접두 — `20260824120000_drop_korean_market_columns.sql` 등)을 따른다: `supabase/migrations/20260825090000_broadcast_speech_analyses.sql` 단일 파일에 4.1–4.3, 4.5를 담는다.

## 5. 추출 파이프라인

새 모듈 `lib/broadcast-intel/`. 다음 사이클의 장면 인덱스도 같은 모듈에 들어온다.

| 파일 | 책임 |
| --- | --- |
| `schema.ts` | 열거값 + Gemini structured output 스키마 + 결과 타입. 순수. |
| `audio-extract.ts` | S3 `GetObject` 스트림 → ffmpeg → 모노 오디오 버퍼 + 정확한 러닝타임 |
| `gemini-analyze.ts` | Files API 업로드 → `gemini-3.5-flash` → 검증된 JSON |
| `persist.ts` | `broadcast_transcripts` + `broadcast_speech_analyses` upsert, 큐 상태 전이 |
| `analyze-one.ts` | 위 셋을 묶은 단일 방송 처리 단위 (`archiveOne`에 대응) |
| `category-pattern.ts` | 카테고리 집계 (§6) |
| `format-prompt.ts` | 프롬프트 블록 생성 (§7) |

- ffmpeg는 이미 번들된 `@ffmpeg-installer/ffmpeg`를 쓴다 (`lib/broadcasts/video-archival.ts`와 동일). 추가 인프라 없음.
- 인자: `-vn -ac 1 -ar 16000`. 606 MB → 6 MB 수준이라 Files API 업로드가 병목이 되지 않는다.
- 모델은 `GEMINI_FLASH`(`lib/gemini-models.ts`)를 쓰고, 5xx 시 `GEMINI_PRO_FALLBACK`으로 기존 `lib/gemini/retry.ts` 정책을 재사용한다.

### 5.1 `video_duration_sec` 결함 동시 수정

현재 `broadcasts.video_duration_sec`는 아카이브된 5,019편 **전부 비어 있다**. `lib/broadcasts/video-archival.ts:219`의 ffmpeg stderr `Duration:` 파싱이 라이브 m3u8에서 실패하기 때문이다.

타이밍은 이 설계의 기준축이다 — 러닝타임이 없으면 "가격은 尺의 62% 지점" 같은 값 자체가 성립하지 않는다. 라이브 m3u8과 달리 S3에 저장된 MP4는 길이가 확정되어 있으므로, 오디오 추출과 같은 ffmpeg 패스의 stderr에서 러닝타임을 파싱해 `broadcasts.video_duration_sec`를 함께 채운다. `broadcast_speech_analyses.duration_sec`는 이 값을 쓴다.

파싱에 실패하면 그 방송은 `failed` 처리하고 분석하지 않는다 — 러닝타임 없는 분석 결과는 집계에 넣을 수 없으므로 저장할 가치가 없다.

### 5.2 큐 드레인

- `app/api/cron/analyze-broadcast-audio/route.ts` — `app/api/cron/archive-videos/route.ts`와 동일 구조(`maxDuration = 300`, 240초 예산, `Bearer ${CRON_SECRET}`). 편당 60~120초이므로 concurrency 2, 실행당 6~10편.
- `scripts/drain-broadcast-analysis.ts` + `npm run drain:broadcast-analysis` — 기존 `drain:archive-queue`와 짝. 초기 40편은 이 스크립트로 처리한다.
- 실패는 `analysis_attempts` 증가 + `analysis_error` 기록. 3회 초과 시 `failed`로 고정해 큐가 무한 재시도하지 않게 한다.

## 6. 카테고리 집계

`lib/broadcast-intel/category-pattern.ts::loadCategoryPattern(category, opts)`.

집계 테이블을 두지 않고 대본 생성 시점에 계산한다. 대본 생성은 전체 이력 22건으로 빈도가 낮고, 카테고리당 행 수가 수백 규모라 단일 쿼리 + 메모리 집계로 충분하다. 새 테이블은 YAGNI다.

- **카테고리 매칭**: `lib/strategy/category-mapping.ts`의 기존 alias를 재사용한다. exact match 취약점은 `docs/current-system-feature-map.md` P2에 이미 기록되어 있다.
- **러닝타임 정규화**: 12분 슬롯과 50분 슬롯을 절대 초로 섞으면 결과가 무의미해진다. 모든 타이밍을 **러닝타임 대비 비율**로 집계하고 중앙값 절대시간을 병기한다. 운영자가 `customization.runtimeMinutes`를 지정하면 비율이 그 尺으로 환산된다.
- **최소 표본 게이트는 fail-closed**: `PATTERN_MIN_SAMPLES`(기본 5) 미만이면 `null`을 반환하고 블록을 주입하지 않는다. 방송 2편에서 뽑은 패턴을 "집계 근거"로 제시하는 것이 가장 나쁜 실패다. `competitor_fit_analyses`가 총 7행으로 fit-weighting을 사실상 죽여 놓은 것과 같은 함정이며, 화이트리스트 게이트(`lib/broadcasts/whitelist-gate.ts`)의 fail-open과 방향이 반대인 것은 의도적이다.

반환 형태:

```ts
interface CategoryPattern {
  category: string;
  sampleSize: number;
  channels: string[];
  runtimeMedianSec: number;
  actSequence: Array<{ actType: ActType; medianShare: number; order: number }>;
  sellingPointOrder: Array<{ pointType: PointType; medianOrder: number; presenceRate: number }>;
  evidenceMix: Array<{ type: EvidenceType; presenceRate: number }>;
  objectionMix: Array<{ type: ObjectionType; presenceRate: number }>;
  offerTiming: { firstPriceShare: number; firstPriceMedianSec: number; ctaCountMedian: number };
}
```

## 7. 프롬프트 주입

`lib/broadcast-intel/format-prompt.ts::formatCategoryPatternBlock(pattern)`이 문자열을 만든다. 역할은 `lib/research/competitor-context.ts::formatBroadcastContextPrompt`와 같다.

`lib/screenplay/prompt.ts::buildUserPrompt`의 **`initial` 모드에만** 주입한다. `refine`은 이미 현재 대본과 디렉터 피드백이 기준이라, 패턴을 다시 넣으면 지시받지 않은 구조 변경(드리프트)만 생긴다.

```
## 競合放送の構成パターン（同カテゴリ N件の集計・構成の参考のみ）
- 集計対象: {category} / {channels} / N番組 / 尺中央値 M分
- 標準構成比: 導入 8% → 問題提起 12% → 商品紹介 18% → 実演 25% → 根拠提示 12% → …
- 販売ポイント提示順: …
- 根拠提示の型: 実演 92% / 比較 61% / 試験成績 38%
- 価格初出: 尺の 62%（中央値 15分00秒）、CTA 中央値 3回
- 用途制限: 構成設計にのみ使用する。競合商品の名称・数値・性能・特典・固有の実演内容は
  含まれておらず、推測して補完してはならない。
```

`## 根拠の優先順位`는 4단에서 5단이 된다:

1. 確認済み商品情報・価格・特典・保証
2. ユーザー指定の作家指示
3. **競合放送の構成パターン（構成の骨格のみ）** ← 신규
4. 企画参考情報（構成だけに使用し、事実として断定しない）
5. 放送文体リファレンス（リズムだけに使用し、内容を転用しない）

구성에 관한 한 실측 집계가 AI 가설(`企画参考情報`)보다 우선해야 하므로 3위에 넣는다. 상품 사실과 운영자 지시는 그대로 위에 남는다.

패턴이 `null`이거나(표본 부족 / 카테고리 없음) `BROADCAST_INTEL_ENABLED`가 꺼져 있으면 블록도 우선순위 항목도 넣지 않는다 — 기존 프롬프트와 바이트 단위로 동일해진다. 즉 코퍼스 구축과 대본 반영을 따로 켤 수 있고, 문제가 생기면 재배포 없이 원래 동작으로 되돌릴 수 있다.

## 8. 노출과 재현성

- 생성 시 계산된 `CategoryPattern`을 `screenplay_versions.pattern_snapshot`에 저장한다.
- 대본 상세 화면(`app/[locale]/(produce)/screenplays/[id]`)에 "경쟁 방송 구성 패턴 N편 반영" 수준의 표시를 넣는다. 보이지 않는 변경은 신뢰받지 못하고, 블라인드 비교(§10)에서 어느 쪽이 패턴 적용본인지 사후 확인할 근거가 된다.
- i18n 키는 ja/ko 양쪽에 추가한다 (`messages/ja.json`, `messages/ko.json`).

## 9. Sankey 상태 전환 — 완료 정의

`lib/pipeline/data-intelligence-graph.ts`에서:

- `datasetSellingLanguage`: `planned` → `current`
- `outcomeCompetitiveScript`: `planned` → `current`
- `sourceMediaArchive → datasetSellingLanguage`: `planned` → `current`
- `datasetSellingLanguage → outcomeCompetitiveScript`: `planned` → `current`

`datasetSceneIndex`와 `outcomeDemoPlan`, 그리고 그것들을 잇는 링크는 `planned`로 남는다.

`scripts/test-data-intelligence-graph.ts`가 "planned 데이터셋은 current 링크를 낼 수 없다"와 "current 링크는 current 노드끼리만 잇는다"를 단언하므로, 그래프 모델과 테스트가 함께 바뀌어야 한다. **이 테스트가 갱신된 기대값으로 통과하는 시점이 이 기능의 완료 정의다.**

## 10. 테스트

| 명령 | 성격 | 내용 |
| --- | --- | --- |
| `npm run test:broadcast-intel-aggregate` | 순수 | 집계 수학, 비율 정규화, 러닝타임 혼재 케이스, 최소 표본 게이트, 빈 입력 → `null` |
| `npm run test:broadcast-intel-prompt` | 순수 | **누출 테스트.** 상품명·수치가 잔뜩 든 fixture 원문으로 분석 결과를 구성하고, 생성된 블록에 그 문자열이 하나도 포함되지 않음을 단언 |
| `npx tsx scripts/test-data-intelligence-graph.ts` | 순수 | §9 기대값 갱신 (기존 스크립트, `package.json` alias 없음 — 이번에 `test:data-intelligence-graph` alias를 추가한다) |
| `npm run test:broadcast-intel-live` | 라이브 | 실제 방송 1편 S3 → ffmpeg → Gemini → row 관통. `.env.local` 필요 |

품질 판정은 자동 테스트로 대신하지 않는다. 40편 처리 후 같은 상품으로 **패턴 주입 전/후 대본을 뽑아 블라인드 비교**한다 — `docs/japan/2026-08-21-client-request-ja.md`에 고객과 합의된 평가 틀과 같은 방식이며, 채점 항목(사실 오인 수, 심의 리스크 수, 구성 1~5, MWB다움 1~5, 수정 시간)도 그 문서의 기록 시트를 그대로 쓴다.

## 11. 범위 — 초기 슬라이스

`家電` 카테고리 345편(QVC·ShopCh 양쪽) 중 **최근 40편**으로 시작한다.

- 유일하게 확보된 승인 대본(레이콥 침구청소기)과 같은 상품군이라 비교 기준이 있다.
- 기존 `competitor_fit_analyses` 2건도 전부 `家電`이다.
- 40편 × 약 5만 토큰 ≈ 200만 입력 토큰.

참고 — 아카이브 영상의 카테고리 분포: ファッション 1,244 · ビューティ 503(qvc) · ホーム・インテリア 448(shopch) · コスメ 426(shopch) · 健康・ダイエット 382(qvc) · 家電 345(양쪽).

## 12. 비용·운영

- **S3 egress**: 오디오만 쓰더라도 ffmpeg는 MP4 전체를 읽어야 한다. 40편 ≈ 24 GB로 슬라이스에서는 문제없다. 전량 5,019편으로 확장하면 **3.2 TB egress**이며, 이는 별도 판단이 필요한 사항이다. 확장 전에 실측 편당 비용을 기록한다.
- **처리 속도**: 편당 60~120초, 크론 1회당 6~10편. 초기 40편은 로컬 드레인 스크립트로 처리한다 (기존 `npm run daily:archive` 운용과 동일).
- **크론 스케줄**: 신규 크론은 기존 `archive-videos`(`0 */2`)와 겹치지 않게 배치한다. 두 작업 모두 ffmpeg + 대역폭을 쓴다.

## 13. 환경변수

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `BROADCAST_INTEL_ENABLED` | `false` | 프롬프트 주입 킬 스위치. 코퍼스 구축과 대본 반영을 따로 켤 수 있게 한다 |
| `PATTERN_MIN_SAMPLES` | `5` | 집계 최소 표본 (fail-closed) |
| `BROADCAST_INTEL_BATCH_CONCURRENCY` | `2` | 큐 드레인 동시성 |
| `BROADCAST_INTEL_MAX_ATTEMPTS` | `3` | 실패 고정 임계 |

## 14. 착수 전 조치 (블로커)

`~/.zshenv:2`와 `~/.zshrc:10`이 죽은 `GEMINI_API_KEY`(HTTP 400)를 export하고 있다. Node의 `--env-file`은 이미 설정된 환경변수를 덮어쓰지 않으므로, 모든 로컬 `npx tsx --env-file=.env.local` 실행이 이 죽은 키를 쓴다. `.env.local`의 키는 정상(HTTP 200)이다. **이 두 줄을 제거해야 라이브 스모크와 초기 40편 드레인을 로컬에서 돌릴 수 있다.**

## 15. 스코프 외 / 다음 사이클

- `datasetSceneIndex` — 아카이브 영상 재처리로 시각 정보 추출. 이번 사이클에서 영상을 삭제하지 않으므로 언제든 가능하다.
- `outcomeDemoPlan` — 시연 순서·카메라 큐·진행자 동작.
- 전량 5,019편 확장 (§12의 egress 판단 이후).
- `refine` 모드 패턴 주입.
- OA 10채널 — `historical_broadcasts`에는 영상이 없으므로 이 경로의 대상이 아니다.
- 운영자 수동 참조 방송 선택 (카테고리 자동 매칭 품질을 먼저 검증한 뒤 판단).
