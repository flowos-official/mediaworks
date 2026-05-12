# Broadcast Calendar — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shop Channel (`shopch.jp`) + QVC Japan (`qvc.jp`)의 지난 방송 정보를 매일 JST 01:00에 수집해 Supabase에 저장하고, `/[locale]/broadcasts` 캘린더 페이지에서 월 그리드 + 시간순 통합 리스트로 표시한다.

**Architecture:** 두 채널별 독립 cheerio 파서(`lib/broadcasts/shopch.ts`, `qvc.ts`) → 공통 `persist.upsertBroadcasts()` → Vercel cron(16:00 UTC) + 관리자 수동 트리거 + 1회용 7일 백필. UI는 Server Component shell이 초기 월 데이터를 로드 후 Client `BroadcastCalendar`가 상태/필터/월간 캐싱을 담당. 모든 단계가 `(channel, air_date, start_time)` 유니크 키 + upsert로 멱등.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (PostgreSQL), `cheerio` (신규), Tailwind CSS 4, next-intl, lucide-react.

**Spec reference:** `docs/superpowers/specs/2026-05-12-broadcast-calendar-phase-a-design.md`

**Out of scope:** Phase B (방송별 상품 추출), Phase C (분석/패턴 차트). 본 플랜의 `broadcasts` 테이블이 두 후속 단계의 기반.

---

## File Structure

**Create:**

```
supabase/migrations/2026-05-12_broadcasts_calendar.sql

lib/broadcasts/
  types.ts                                              ScrapedSlot, BroadcastChannel, ScrapeResult
  fetch.ts                                              politeFetch(url) — UA, timeout, retry
  shopch.ts                                             scrapeShopChannelForDate(date)
  qvc.ts                                                scrapeQVCForDate(date)
  persist.ts                                            upsertBroadcasts(slots)
  index.ts                                              scrapeAllForDate(date)

app/api/broadcasts/route.ts                             GET list
app/api/broadcasts/refresh/route.ts                     POST manual trigger
app/api/cron/daily-broadcasts/route.ts                  Vercel cron

app/[locale]/broadcasts/page.tsx                        Server shell
app/[locale]/broadcasts/loading.tsx                     Skeleton

components/broadcasts/
  ChannelBadge.tsx
  BroadcastListItem.tsx
  ChannelFilter.tsx
  DayDetailPanel.tsx
  DateCell.tsx
  MonthGrid.tsx
  BroadcastCalendar.tsx                                 client state hub

scripts/
  backfill-broadcasts.ts                                1회용 7일 백필
  test-broadcasts-shopch-parser.ts                      픽스처 회귀
  test-broadcasts-qvc-parser.ts                         픽스처 회귀
  test-broadcasts-scrape-live.ts                        라이브 통합
  verify-broadcasts-run.ts                              운영 진단
  fixtures/broadcasts/
    shopch-20260511.html
    shopch-20260511.expected.json
    qvc-20260511.html
    qvc-20260511.expected.json
```

**Modify:**

```
package.json                                            +cheerio dep, +6 npm scripts
vercel.json                                             +cron, +function timeouts
components/Navbar.tsx                                   +broadcasts link
messages/ja.json, messages/en.json                      +broadcasts namespace, +nav.broadcasts
CLAUDE.md                                               +feature note
```

---

## Task 1: 환경 준비 — 의존성 + 마이그레이션 작성

**Files:**
- Modify: `package.json`
- Create: `supabase/migrations/2026-05-12_broadcasts_calendar.sql`

- [ ] **Step 1: cheerio 설치**

```bash
npm install cheerio@^1.0.0
```

`package.json`의 `dependencies`에 `"cheerio": "^1.0.0"` 자동 추가됨을 확인.

- [ ] **Step 2: 마이그레이션 SQL 파일 작성**

Write to `supabase/migrations/2026-05-12_broadcasts_calendar.sql`:

```sql
-- Phase A: broadcasts calendar — Shop Channel + QVC Japan

DO $$ BEGIN
  CREATE TYPE broadcast_channel AS ENUM ('shopch', 'qvc');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS broadcasts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         broadcast_channel NOT NULL,
  air_date        date NOT NULL,
  start_time      time NOT NULL,
  program_title   text NOT NULL,
  presenter       text,
  description     text,
  thumbnail_url   text,
  source_url      text NOT NULL,
  scraped_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broadcasts_slot_unique UNIQUE (channel, air_date, start_time)
);

CREATE INDEX IF NOT EXISTS broadcasts_air_date_idx
  ON broadcasts (air_date DESC);
CREATE INDEX IF NOT EXISTS broadcasts_channel_date_idx
  ON broadcasts (channel, air_date DESC);

CREATE OR REPLACE FUNCTION broadcasts_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS broadcasts_updated_at_trg ON broadcasts;
CREATE TRIGGER broadcasts_updated_at_trg
  BEFORE UPDATE ON broadcasts
  FOR EACH ROW EXECUTE FUNCTION broadcasts_set_updated_at();
```

- [ ] **Step 3: 마이그레이션 적용 (Supabase 대시보드 SQL 에디터에서 직접 실행)**

Supabase 대시보드 → SQL Editor → 위 파일 내용 붙여넣고 Run. 또는 Supabase CLI가 연결돼 있으면 `npx supabase db push`.

- [ ] **Step 4: 적용 확인**

대시보드의 Table Editor에서 `broadcasts` 테이블 존재 + 컬럼 9개 + 인덱스 2개 확인. 또는 SQL:

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'broadcasts' ORDER BY ordinal_position;
```

`id, channel, air_date, start_time, program_title, presenter, description, thumbnail_url, source_url, scraped_at, updated_at` (11행) 반환되어야 함.

- [ ] **Step 5: 커밋**

```bash
git add package.json package-lock.json supabase/migrations/2026-05-12_broadcasts_calendar.sql
git commit -m "feat(broadcasts): add cheerio dep + broadcasts table migration"
```

---

## Task 2: 공통 타입 + 정중한 HTTP fetcher

**Files:**
- Create: `lib/broadcasts/types.ts`
- Create: `lib/broadcasts/fetch.ts`

- [ ] **Step 1: 타입 정의**

Write to `lib/broadcasts/types.ts`:

```ts
export type BroadcastChannel = "shopch" | "qvc";

export interface ScrapedSlot {
	channel: BroadcastChannel;
	air_date: string; // YYYY-MM-DD (JST)
	start_time: string; // HH:MM:SS (JST)
	program_title: string;
	presenter: string | null;
	description: string | null;
	thumbnail_url: string | null;
	source_url: string;
}

export interface ScrapeHealth {
	expectedNonZero: boolean;
	actualCount: number;
	fieldCoverage: {
		presenter: number;
		description: number;
		thumbnail_url: number;
	};
}

export interface ScrapeResult {
	channel: BroadcastChannel;
	date: string; // YYYY-MM-DD
	slots: ScrapedSlot[];
	ok: boolean;
	error?: string;
	health: ScrapeHealth;
}

export interface PersistResult {
	inserted: number;
	updated: number;
	errors: Array<{ slot: ScrapedSlot; error: string }>;
}

export const USER_AGENT =
	"MediaWorks-Broadcast-Calendar/1.0 (+contact@mediaw-b.com)";

export function computeHealth(
	slots: ScrapedSlot[],
	expectedNonZero: boolean,
): ScrapeHealth {
	const n = slots.length;
	const coverage = (key: keyof ScrapedSlot) =>
		n === 0 ? 0 : slots.filter((s) => s[key] != null && s[key] !== "").length / n;
	return {
		expectedNonZero,
		actualCount: n,
		fieldCoverage: {
			presenter: coverage("presenter"),
			description: coverage("description"),
			thumbnail_url: coverage("thumbnail_url"),
		},
	};
}
```

- [ ] **Step 2: 정중한 fetcher**

Write to `lib/broadcasts/fetch.ts`:

```ts
import { USER_AGENT } from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface FetchResult {
	ok: boolean;
	status?: number;
	body?: string;
	error?: string;
}

export async function politeFetch(
	url: string,
	opts: { timeoutMs?: number; retry?: boolean } = {},
): Promise<FetchResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const retry = opts.retry ?? true;

	const attempt = async (): Promise<FetchResult> => {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const res = await fetch(url, {
				headers: {
					"User-Agent": USER_AGENT,
					Accept: "text/html,application/xhtml+xml",
					"Accept-Language": "ja,en;q=0.8",
				},
				signal: ctrl.signal,
				redirect: "follow",
			});
			clearTimeout(timer);
			if (!res.ok) {
				return { ok: false, status: res.status, error: `HTTP ${res.status}` };
			}
			const body = await res.text();
			return { ok: true, status: res.status, body };
		} catch (e) {
			clearTimeout(timer);
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	};

	const first = await attempt();
	// 4xx는 재시도 안 함. 그 외 실패만 1회 재시도
	if (first.ok || (first.status && first.status >= 400 && first.status < 500)) {
		return first;
	}
	if (!retry) return first;
	return attempt();
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
```

- [ ] **Step 3: 빌드 확인**

```bash
npx tsc --noEmit
```

Expected: no errors related to `lib/broadcasts/*`.

- [ ] **Step 4: 커밋**

```bash
git add lib/broadcasts/types.ts lib/broadcasts/fetch.ts
git commit -m "feat(broadcasts): add types and polite HTTP fetcher"
```

---

## Task 3: Shop Channel 파서 — 픽스처 캡처 + TDD

**Files:**
- Create: `scripts/fixtures/broadcasts/shopch-20260511.html`
- Create: `scripts/fixtures/broadcasts/shopch-20260511.expected.json`
- Create: `lib/broadcasts/shopch.ts`
- Create: `scripts/test-broadcasts-shopch-parser.ts`
- Modify: `package.json` (add `test:broadcasts-shopch` script)

- [ ] **Step 1: 실제 페이지 캡처 (어제 날짜 사용 — 데이터 안정)**

```bash
mkdir -p scripts/fixtures/broadcasts
DATE=$(node -e "const d=new Date(Date.now()-86400000); console.log(d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0'))")
curl -sL -A "MediaWorks-Broadcast-Calendar/1.0" \
  "https://www.shopch.jp/pc/tv/programlist?onAirDay=${DATE}" \
  -o "scripts/fixtures/broadcasts/shopch-${DATE}.html"
```

> 캡처된 파일명에 실제 날짜가 들어감(예: `shopch-20260511.html`). 이후 단계는 그 파일명에 맞춰 작업.

- [ ] **Step 2: 픽스처 검사**

브라우저 또는 에디터로 HTML을 열어 다음을 확인 (selector 결정을 위한 사전조사):
1. 시간 슬롯이 들어있는 컨테이너의 CSS 클래스 (예: `class="program-..."`, `data-time=...`)
2. 시작 시각이 표시된 엘리먼트
3. 프로그램 제목 엘리먼트
4. 진행자 이름 노출 위치(있다면)
5. 한줄 설명 노출 위치(있다면)
6. 썸네일 `<img>` src 위치(있다면)

> 메모: 메인 콘텐츠는 보통 `<main>` 또는 `id="contents"` 안. 헤더/푸터 노이즈 제외.

- [ ] **Step 3: expected.json 작성 (검사 결과를 손으로 기록)**

Write to `scripts/fixtures/broadcasts/shopch-20260511.expected.json` (날짜 부분은 캡처 파일명에 맞춤):

```json
{
  "minSlots": 20,
  "maxSlots": 80,
  "minPresenterCoverage": 0.3,
  "minDescriptionCoverage": 0.3,
  "minThumbnailCoverage": 0.3,
  "firstSlot": {
    "channel": "shopch",
    "startTimePattern": "^\\d{2}:\\d{2}:\\d{2}$",
    "programTitleMinLength": 2
  }
}
```

> coverage 임계값은 일단 0.3로 보수적 설정. 실제 추출률 측정 후 Task 마지막에 상향 조정.

- [ ] **Step 4: 테스트 스크립트 작성 (파서가 아직 없으므로 실패해야 함)**

Write to `scripts/test-broadcasts-shopch-parser.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scrapeShopChannelFromHTML } from "../lib/broadcasts/shopch";

const FIXTURE_DIR = join(process.cwd(), "scripts/fixtures/broadcasts");

interface Expected {
	minSlots: number;
	maxSlots: number;
	minPresenterCoverage: number;
	minDescriptionCoverage: number;
	minThumbnailCoverage: number;
	firstSlot: {
		channel: string;
		startTimePattern: string;
		programTitleMinLength: number;
	};
}

function loadFixturePairs(): Array<{ html: string; expected: Expected; date: string }> {
	const files = readdirSync(FIXTURE_DIR);
	const htmlFiles = files.filter((f) => f.startsWith("shopch-") && f.endsWith(".html"));
	return htmlFiles.map((html) => {
		const base = html.replace(".html", "");
		const date = base.replace("shopch-", "");
		const expected = JSON.parse(
			readFileSync(join(FIXTURE_DIR, `${base}.expected.json`), "utf-8"),
		) as Expected;
		return {
			html: readFileSync(join(FIXTURE_DIR, html), "utf-8"),
			expected,
			date,
		};
	});
}

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else {
		console.log(`✓ ${msg}`);
	}
}

async function main() {
	const pairs = loadFixturePairs();
	if (pairs.length === 0) {
		console.error("No shopch fixtures found in", FIXTURE_DIR);
		process.exit(1);
	}

	for (const { html, expected, date } of pairs) {
		console.log(`\n=== shopch-${date} ===`);
		const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
		const slots = scrapeShopChannelFromHTML(html, iso);

		assert(
			slots.length >= expected.minSlots && slots.length <= expected.maxSlots,
			`slot count ${slots.length} within [${expected.minSlots}, ${expected.maxSlots}]`,
		);

		if (slots.length > 0) {
			const first = slots[0];
			assert(first.channel === expected.firstSlot.channel, "first slot channel");
			assert(
				new RegExp(expected.firstSlot.startTimePattern).test(first.start_time),
				`first slot start_time matches ${expected.firstSlot.startTimePattern}`,
			);
			assert(
				first.program_title.length >= expected.firstSlot.programTitleMinLength,
				`first slot program_title length ≥ ${expected.firstSlot.programTitleMinLength}`,
			);
			assert(
				typeof first.source_url === "string" && first.source_url.startsWith("https://"),
				"first slot source_url is https",
			);

			const cov = (key: "presenter" | "description" | "thumbnail_url") =>
				slots.filter((s) => s[key] != null && s[key] !== "").length / slots.length;
			assert(cov("presenter") >= expected.minPresenterCoverage,
				`presenter coverage ${cov("presenter").toFixed(2)} ≥ ${expected.minPresenterCoverage}`);
			assert(cov("description") >= expected.minDescriptionCoverage,
				`description coverage ${cov("description").toFixed(2)} ≥ ${expected.minDescriptionCoverage}`);
			assert(cov("thumbnail_url") >= expected.minThumbnailCoverage,
				`thumbnail coverage ${cov("thumbnail_url").toFixed(2)} ≥ ${expected.minThumbnailCoverage}`);

			// 시간 정렬 확인
			const times = slots.map((s) => s.start_time);
			const sorted = [...times].sort();
			assert(JSON.stringify(times) === JSON.stringify(sorted),
				"slots are sorted by start_time");
		}
	}

	if (process.exitCode) {
		console.error("\nSome assertions failed.");
		process.exit(process.exitCode);
	}
	console.log("\nAll shopch parser assertions passed.");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
```

- [ ] **Step 5: 파서 스켈레톤 작성 (셀렉터는 Step 2 검사 결과를 반영)**

Write to `lib/broadcasts/shopch.ts`:

```ts
import * as cheerio from "cheerio";
import { politeFetch } from "./fetch";
import { computeHealth, type ScrapeResult, type ScrapedSlot } from "./types";

const BASE_URL = "https://www.shopch.jp/pc/tv/programlist";

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function formatYYYYMMDD(date: Date): string {
	return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

function formatISODate(date: Date): string {
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function normalizeTime(raw: string): string | null {
	// "10:30", "10時30分", "10:30:00" 등 다양한 입력 → "HH:MM:SS"
	const cleaned = raw.replace(/[^\d:時分]/g, "");
	const m = cleaned.match(/^(\d{1,2})(?::|時)(\d{1,2})(?::|分)?(\d{1,2})?/);
	if (!m) return null;
	const hh = pad2(parseInt(m[1], 10));
	const mm = pad2(parseInt(m[2], 10));
	const ss = pad2(parseInt(m[3] ?? "0", 10));
	if (parseInt(hh, 10) > 23 || parseInt(mm, 10) > 59) return null;
	return `${hh}:${mm}:${ss}`;
}

function absoluteUrl(href: string | undefined): string | null {
	if (!href) return null;
	if (href.startsWith("http")) return href;
	if (href.startsWith("//")) return `https:${href}`;
	if (href.startsWith("/")) return `https://www.shopch.jp${href}`;
	return null;
}

/**
 * Pure parser — given the HTML body, extract slots.
 * Exposed separately so fixture tests can call it without HTTP.
 *
 * NOTE: selectors below are educated guesses from Step 2 of Task 3.
 * If `npm run test:broadcasts-shopch` fails on slot count or field coverage,
 * inspect the fixture and adjust the selectors here until the test passes.
 */
export function scrapeShopChannelFromHTML(
	html: string,
	airDate: string, // YYYY-MM-DD
): ScrapedSlot[] {
	const $ = cheerio.load(html);
	const slots: ScrapedSlot[] = [];

	// 시간 슬롯 컨테이너 — fixture 검사 후 정확한 셀렉터로 교체.
	// 후보: `.programlist .program`, `[id^="program-"]`, `ul.tv-list > li` 등.
	const slotElements = $("[data-onairtime], .programItem, .program-item, .schedule__item");

	const sourceUrl = `${BASE_URL}?onAirDay=${airDate.replace(/-/g, "")}`;

	slotElements.each((_, el) => {
		const $el = $(el);

		// 시작 시각: data-onairtime 또는 시간 텍스트 추출
		const rawTime =
			$el.attr("data-onairtime") ??
			$el.find(".time, .onair-time, .programTime").first().text().trim();
		const startTime = normalizeTime(rawTime);
		if (!startTime) return;

		// 제목
		const programTitle = $el.find(".title, .programTitle, h3, h4").first().text().trim();
		if (!programTitle) return;

		// 진행자, 설명, 썸네일 — 없으면 null
		const presenter =
			$el.find(".navigator, .presenter, .cast").first().text().trim() || null;
		const description =
			$el.find(".description, .summary, .lead").first().text().trim() || null;
		const thumbnailUrl = absoluteUrl(
			$el.find("img").first().attr("src") ?? undefined,
		);

		// 슬롯별 deep-link가 있으면 그것을 source_url로, 없으면 페이지 URL
		const slotLink = absoluteUrl($el.find("a").first().attr("href") ?? undefined);

		slots.push({
			channel: "shopch",
			air_date: airDate,
			start_time: startTime,
			program_title: programTitle,
			presenter,
			description,
			thumbnail_url: thumbnailUrl,
			source_url: slotLink ?? sourceUrl,
		});
	});

	slots.sort((a, b) => a.start_time.localeCompare(b.start_time));
	return slots;
}

export async function scrapeShopChannelForDate(date: Date): Promise<ScrapeResult> {
	const yyyymmdd = formatYYYYMMDD(date);
	const iso = formatISODate(date);
	const url = `${BASE_URL}?onAirDay=${yyyymmdd}`;

	const fetched = await politeFetch(url);
	if (!fetched.ok || !fetched.body) {
		return {
			channel: "shopch",
			date: iso,
			slots: [],
			ok: false,
			error: fetched.error ?? "no body",
			health: computeHealth([], true),
		};
	}

	const slots = scrapeShopChannelFromHTML(fetched.body, iso);

	return {
		channel: "shopch",
		date: iso,
		slots,
		ok: true,
		health: computeHealth(slots, true),
	};
}
```

- [ ] **Step 6: package.json에 테스트 스크립트 추가**

`package.json`의 `scripts` 객체에 추가:

```json
"test:broadcasts-shopch": "tsx --env-file=.env.local scripts/test-broadcasts-shopch-parser.ts"
```

- [ ] **Step 7: 테스트 실행 → 보통 첫 시도는 실패**

```bash
npm run test:broadcasts-shopch
```

Expected: 일부 assertion 실패 (셀렉터 mismatch). 어떤 assertion이 실패하는지 출력 확인.

- [ ] **Step 8: 픽스처 검사 결과를 반영해 셀렉터 조정 → 재실행 반복**

`lib/broadcasts/shopch.ts`의 `scrapeShopChannelFromHTML` 안의 셀렉터를 Step 2에서 발견한 실제 패턴으로 교체. `npm run test:broadcasts-shopch` 재실행하며 다음 순서로 통과시킴:
1. slot count 범위 — 컨테이너 셀렉터가 맞으면 통과
2. start_time / program_title 추출 — 내부 셀렉터 정확
3. coverage 임계값 — nullable 필드 셀렉터 정확

> 임계값(0.3)이 너무 빡빡하면 `expected.json`의 `minPresenterCoverage` 등을 조정. 단, 0.1 미만으로 낮추지 말 것(파서 의미 없어짐).

- [ ] **Step 9: 통과 확인 + 커밋**

```bash
npm run test:broadcasts-shopch
# All shopch parser assertions passed.
git add lib/broadcasts/shopch.ts scripts/fixtures/broadcasts/shopch-*.html scripts/fixtures/broadcasts/shopch-*.expected.json scripts/test-broadcasts-shopch-parser.ts package.json
git commit -m "feat(broadcasts): add Shop Channel parser with fixture-based test"
```

---

## Task 4: QVC Japan 파서 — 같은 TDD 패턴

**Files:**
- Create: `scripts/fixtures/broadcasts/qvc-20260511.html`
- Create: `scripts/fixtures/broadcasts/qvc-20260511.expected.json`
- Create: `lib/broadcasts/qvc.ts`
- Create: `scripts/test-broadcasts-qvc-parser.ts`
- Modify: `package.json` (add `test:broadcasts-qvc` script)

- [ ] **Step 1: 픽스처 캡처**

```bash
DATE=$(node -e "const d=new Date(Date.now()-86400000); console.log(d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0'))")
curl -sL -A "MediaWorks-Broadcast-Calendar/1.0" \
  "https://qvc.jp/content/programguide.qvc.${DATE}0000.html" \
  -o "scripts/fixtures/broadcasts/qvc-${DATE}.html"
```

- [ ] **Step 2: 픽스처 검사**

QVC는 24개 시간섹션(`0時`~`23時`)이 수직 배열. 다음 셀렉터 후보 확인:
- 시간 섹션 컨테이너 (보통 `.hour-block`, `.timeBlock`, `[id^="hour"]` 등)
- 각 슬롯의 시작 시각 표시
- 쇼 제목, 내비게이터 이름, 설명, 썸네일 위치
- "표시할 정보가 없습니다" 메시지의 클래스 (빈 날짜 처리용)

- [ ] **Step 3: expected.json 작성**

Write to `scripts/fixtures/broadcasts/qvc-20260511.expected.json` (날짜 캡처 파일에 맞춤):

```json
{
  "minSlots": 10,
  "maxSlots": 60,
  "minPresenterCoverage": 0.4,
  "minDescriptionCoverage": 0.5,
  "minThumbnailCoverage": 0.3,
  "firstSlot": {
    "channel": "qvc",
    "startTimePattern": "^\\d{2}:\\d{2}:\\d{2}$",
    "programTitleMinLength": 2
  }
}
```

- [ ] **Step 4: 테스트 스크립트**

Write to `scripts/test-broadcasts-qvc-parser.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scrapeQVCFromHTML } from "../lib/broadcasts/qvc";

const FIXTURE_DIR = join(process.cwd(), "scripts/fixtures/broadcasts");

interface Expected {
	minSlots: number;
	maxSlots: number;
	minPresenterCoverage: number;
	minDescriptionCoverage: number;
	minThumbnailCoverage: number;
	firstSlot: {
		channel: string;
		startTimePattern: string;
		programTitleMinLength: number;
	};
}

function loadFixturePairs(): Array<{ html: string; expected: Expected; date: string }> {
	const files = readdirSync(FIXTURE_DIR);
	const htmlFiles = files.filter((f) => f.startsWith("qvc-") && f.endsWith(".html"));
	return htmlFiles.map((html) => {
		const base = html.replace(".html", "");
		const date = base.replace("qvc-", "");
		const expected = JSON.parse(
			readFileSync(join(FIXTURE_DIR, `${base}.expected.json`), "utf-8"),
		) as Expected;
		return {
			html: readFileSync(join(FIXTURE_DIR, html), "utf-8"),
			expected,
			date,
		};
	});
}

function assert(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; }
	else { console.log(`✓ ${msg}`); }
}

async function main() {
	const pairs = loadFixturePairs();
	if (pairs.length === 0) {
		console.error("No qvc fixtures found in", FIXTURE_DIR);
		process.exit(1);
	}

	for (const { html, expected, date } of pairs) {
		console.log(`\n=== qvc-${date} ===`);
		const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
		const slots = scrapeQVCFromHTML(html, iso);

		assert(
			slots.length >= expected.minSlots && slots.length <= expected.maxSlots,
			`slot count ${slots.length} within [${expected.minSlots}, ${expected.maxSlots}]`,
		);

		if (slots.length > 0) {
			const first = slots[0];
			assert(first.channel === expected.firstSlot.channel, "first slot channel");
			assert(
				new RegExp(expected.firstSlot.startTimePattern).test(first.start_time),
				"first slot start_time pattern",
			);
			assert(
				first.program_title.length >= expected.firstSlot.programTitleMinLength,
				"first slot program_title length",
			);
			assert(
				typeof first.source_url === "string" && first.source_url.startsWith("https://"),
				"first slot source_url is https",
			);

			const cov = (key: "presenter" | "description" | "thumbnail_url") =>
				slots.filter((s) => s[key] != null && s[key] !== "").length / slots.length;
			assert(cov("presenter") >= expected.minPresenterCoverage,
				`presenter coverage ${cov("presenter").toFixed(2)} ≥ ${expected.minPresenterCoverage}`);
			assert(cov("description") >= expected.minDescriptionCoverage,
				`description coverage ${cov("description").toFixed(2)} ≥ ${expected.minDescriptionCoverage}`);
			assert(cov("thumbnail_url") >= expected.minThumbnailCoverage,
				`thumbnail coverage ${cov("thumbnail_url").toFixed(2)} ≥ ${expected.minThumbnailCoverage}`);

			const times = slots.map((s) => s.start_time);
			const sorted = [...times].sort();
			assert(JSON.stringify(times) === JSON.stringify(sorted),
				"slots are sorted by start_time");
		}
	}

	if (process.exitCode) process.exit(process.exitCode);
	console.log("\nAll qvc parser assertions passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 5: 파서 스켈레톤**

Write to `lib/broadcasts/qvc.ts`:

```ts
import * as cheerio from "cheerio";
import { politeFetch } from "./fetch";
import { computeHealth, type ScrapeResult, type ScrapedSlot } from "./types";

const BASE_HOST = "https://qvc.jp";

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function formatYYYYMMDD(date: Date): string {
	return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

function formatISODate(date: Date): string {
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function normalizeTime(raw: string): string | null {
	const cleaned = raw.replace(/[^\d:時分]/g, "");
	const m = cleaned.match(/^(\d{1,2})(?::|時)(\d{1,2})(?::|分)?(\d{1,2})?/);
	if (!m) return null;
	const hh = pad2(parseInt(m[1], 10));
	const mm = pad2(parseInt(m[2], 10));
	const ss = pad2(parseInt(m[3] ?? "0", 10));
	if (parseInt(hh, 10) > 23 || parseInt(mm, 10) > 59) return null;
	return `${hh}:${mm}:${ss}`;
}

function absoluteUrl(href: string | undefined): string | null {
	if (!href) return null;
	if (href.startsWith("http")) return href;
	if (href.startsWith("//")) return `https:${href}`;
	if (href.startsWith("/")) return `${BASE_HOST}${href}`;
	return null;
}

export function scrapeQVCFromHTML(html: string, airDate: string): ScrapedSlot[] {
	const $ = cheerio.load(html);
	const slots: ScrapedSlot[] = [];

	const yyyymmdd = airDate.replace(/-/g, "");
	const sourceUrl = `${BASE_HOST}/content/programguide.qvc.${yyyymmdd}0000.html`;

	// "표시할 정보가 없음" 텍스트는 빈 날짜 — 빈 배열 반환 (정상)
	if (
		html.includes("表示できる番組情報がありません") ||
		html.includes("番組情報はありません")
	) {
		return [];
	}

	// 시간 슬롯 — fixture 검사 후 정확한 셀렉터로 교체.
	// QVC는 24개 시간 섹션 구조. 후보: `.hour-block`, `.timetable__row`, `[id^="time-"]` 등.
	const slotElements = $(".programItem, .timeBlock__item, [data-starttime], li.programGuideItem");

	slotElements.each((_, el) => {
		const $el = $(el);

		const rawTime =
			$el.attr("data-starttime") ??
			$el.find(".startTime, .time, .hour").first().text().trim();
		const startTime = normalizeTime(rawTime);
		if (!startTime) return;

		const programTitle = $el.find(".showTitle, .programTitle, h3, h4").first().text().trim();
		if (!programTitle) return;

		const presenter =
			$el.find(".navigator, .host, .navigatorName").first().text().trim() || null;
		const description =
			$el.find(".description, .summary, .programDescription").first().text().trim() || null;
		const thumbnailUrl = absoluteUrl(
			$el.find("img").first().attr("src") ?? undefined,
		);

		const slotLink = absoluteUrl($el.find("a").first().attr("href") ?? undefined);

		slots.push({
			channel: "qvc",
			air_date: airDate,
			start_time: startTime,
			program_title: programTitle,
			presenter,
			description,
			thumbnail_url: thumbnailUrl,
			source_url: slotLink ?? sourceUrl,
		});
	});

	slots.sort((a, b) => a.start_time.localeCompare(b.start_time));
	return slots;
}

export async function scrapeQVCForDate(date: Date): Promise<ScrapeResult> {
	const yyyymmdd = formatYYYYMMDD(date);
	const iso = formatISODate(date);
	const url = `${BASE_HOST}/content/programguide.qvc.${yyyymmdd}0000.html`;

	const fetched = await politeFetch(url);
	if (!fetched.ok || !fetched.body) {
		return {
			channel: "qvc",
			date: iso,
			slots: [],
			ok: false,
			error: fetched.error ?? "no body",
			health: computeHealth([], true),
		};
	}

	const slots = scrapeQVCFromHTML(fetched.body, iso);

	return {
		channel: "qvc",
		date: iso,
		slots,
		ok: true,
		health: computeHealth(slots, true),
	};
}
```

- [ ] **Step 6: package.json 스크립트 추가**

```json
"test:broadcasts-qvc": "tsx --env-file=.env.local scripts/test-broadcasts-qvc-parser.ts",
"test:broadcasts-parsers": "npm run test:broadcasts-shopch && npm run test:broadcasts-qvc"
```

- [ ] **Step 7: 테스트 → 셀렉터 조정 반복**

```bash
npm run test:broadcasts-qvc
```

Task 3 Step 8과 동일한 흐름. 셀렉터를 픽스처에 맞춰 조정.

- [ ] **Step 8: 통과 확인 + 커밋**

```bash
npm run test:broadcasts-parsers
git add lib/broadcasts/qvc.ts scripts/fixtures/broadcasts/qvc-*.html scripts/fixtures/broadcasts/qvc-*.expected.json scripts/test-broadcasts-qvc-parser.ts package.json
git commit -m "feat(broadcasts): add QVC Japan parser with fixture-based test"
```

---

## Task 5: 영속화 (`persist.ts`)

**Files:**
- Create: `lib/broadcasts/persist.ts`

- [ ] **Step 1: persist 구현**

Write to `lib/broadcasts/persist.ts`:

```ts
import { getServiceClient } from "@/lib/supabase";
import type { PersistResult, ScrapedSlot } from "./types";

const CHUNK_SIZE = 100;

/**
 * Inserted/updated 정확 카운트:
 * - 한 청크 내 슬롯들의 (channel, air_date, start_time) 조합으로 PostgREST `or` 필터를 빌드해
 *   기존 행을 조회 → 매칭되는 키 집합 → upsert 결과를 inserted/updated로 분류.
 * - upsert는 항상 멱등(`onConflict`).
 */
export async function upsertBroadcasts(slots: ScrapedSlot[]): Promise<PersistResult> {
	if (slots.length === 0) {
		return { inserted: 0, updated: 0, errors: [] };
	}

	const sb = getServiceClient();
	const errors: PersistResult["errors"] = [];
	let inserted = 0;
	let updated = 0;

	for (let i = 0; i < slots.length; i += CHUNK_SIZE) {
		const chunk = slots.slice(i, i + CHUNK_SIZE);

		// 청크의 키 조합으로 정확한 기존행 조회 — PostgREST `or` 필터
		const orFilter = chunk
			.map(
				(s) =>
					`and(channel.eq.${s.channel},air_date.eq.${s.air_date},start_time.eq.${s.start_time})`,
			)
			.join(",");

		const { data: existing, error: selectError } = await sb
			.from("broadcasts")
			.select("channel,air_date,start_time")
			.or(orFilter);

		if (selectError) {
			console.warn(
				`upsertBroadcasts: existing-row lookup failed (${selectError.message}); inserted/updated counts may be imprecise.`,
			);
		}

		const existingSet = new Set(
			(existing ?? []).map(
				(e: { channel: string; air_date: string; start_time: string }) =>
					`${e.channel}|${e.air_date}|${e.start_time}`,
			),
		);

		const { error: upsertError } = await sb
			.from("broadcasts")
			.upsert(chunk, { onConflict: "channel,air_date,start_time" });

		if (upsertError) {
			for (const slot of chunk) {
				errors.push({ slot, error: upsertError.message });
			}
			continue;
		}

		for (const slot of chunk) {
			const key = `${slot.channel}|${slot.air_date}|${slot.start_time}`;
			if (existingSet.has(key)) updated++;
			else inserted++;
		}
	}

	return { inserted, updated, errors };
}
```

- [ ] **Step 2: 빌드 확인**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: 커밋**

```bash
git add lib/broadcasts/persist.ts
git commit -m "feat(broadcasts): add upsert persistence layer"
```

---

## Task 6: 스크레이프 합성 (`index.ts`)

**Files:**
- Create: `lib/broadcasts/index.ts`

- [ ] **Step 1: 구현**

Write to `lib/broadcasts/index.ts`:

```ts
import { upsertBroadcasts } from "./persist";
import { scrapeQVCForDate } from "./qvc";
import { scrapeShopChannelForDate } from "./shopch";
import type { PersistResult, ScrapeResult } from "./types";

export interface ScrapeAllSummary {
	results: ScrapeResult[];
	totalInserted: number;
	totalUpdated: number;
	totalErrors: number;
}

export async function scrapeAllForDate(date: Date): Promise<ScrapeAllSummary> {
	const [shopchResult, qvcResult] = await Promise.all([
		scrapeShopChannelForDate(date).catch(
			(e): ScrapeResult => ({
				channel: "shopch",
				date: date.toISOString().slice(0, 10),
				slots: [],
				ok: false,
				error: e instanceof Error ? e.message : String(e),
				health: { expectedNonZero: true, actualCount: 0, fieldCoverage: { presenter: 0, description: 0, thumbnail_url: 0 } },
			}),
		),
		scrapeQVCForDate(date).catch(
			(e): ScrapeResult => ({
				channel: "qvc",
				date: date.toISOString().slice(0, 10),
				slots: [],
				ok: false,
				error: e instanceof Error ? e.message : String(e),
				health: { expectedNonZero: true, actualCount: 0, fieldCoverage: { presenter: 0, description: 0, thumbnail_url: 0 } },
			}),
		),
	]);

	const persistPromises: Promise<PersistResult>[] = [];
	for (const r of [shopchResult, qvcResult]) {
		if (r.ok && r.slots.length > 0) {
			persistPromises.push(upsertBroadcasts(r.slots));
		}
		// 마크업 변경 의심 경고
		if (r.health.expectedNonZero && r.health.actualCount === 0 && r.ok) {
			console.warn(
				`WARN: ${r.channel} returned 0 slots for ${r.date} — markup change suspected?`,
			);
		}
	}
	const persisted = await Promise.all(persistPromises);

	const totalInserted = persisted.reduce((sum, p) => sum + p.inserted, 0);
	const totalUpdated = persisted.reduce((sum, p) => sum + p.updated, 0);
	const totalErrors = persisted.reduce((sum, p) => sum + p.errors.length, 0);

	return {
		results: [shopchResult, qvcResult],
		totalInserted,
		totalUpdated,
		totalErrors,
	};
}

// Public re-exports
export type { BroadcastChannel, ScrapedSlot, ScrapeResult } from "./types";
```

- [ ] **Step 2: 빌드 확인**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: 커밋**

```bash
git add lib/broadcasts/index.ts
git commit -m "feat(broadcasts): add scrapeAllForDate composition"
```

---

## Task 7: 7일 백필 스크립트

**Files:**
- Create: `scripts/backfill-broadcasts.ts`
- Modify: `package.json` (add `backfill:broadcasts` script)

- [ ] **Step 1: 스크립트 작성**

Write to `scripts/backfill-broadcasts.ts`:

```ts
import { scrapeAllForDate } from "../lib/broadcasts";
import { sleep } from "../lib/broadcasts/fetch";

function parseArgs(): { days: number } {
	const arg = process.argv.find((a) => a.startsWith("--days="));
	const days = arg ? parseInt(arg.replace("--days=", ""), 10) : 7;
	if (!Number.isFinite(days) || days < 1 || days > 60) {
		console.error("--days must be 1..60");
		process.exit(1);
	}
	return { days };
}

async function main() {
	const { days } = parseArgs();
	console.log(`Backfilling last ${days} days...`);

	const today = new Date();
	for (let i = 1; i <= days; i++) {
		const d = new Date(today);
		d.setDate(d.getDate() - i);
		const iso = d.toISOString().slice(0, 10);
		console.log(`\n--- ${iso} ---`);

		const summary = await scrapeAllForDate(d);
		for (const r of summary.results) {
			console.log(
				`  ${r.channel}: ok=${r.ok} slots=${r.slots.length}${r.error ? ` error=${r.error}` : ""}`,
			);
		}
		console.log(
			`  → inserted=${summary.totalInserted} updated=${summary.totalUpdated} errors=${summary.totalErrors}`,
		);

		if (i < days) await sleep(1000); // 정중함: 날짜 간 1초
	}

	console.log("\nBackfill complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: package.json**

```json
"backfill:broadcasts": "tsx --env-file=.env.local scripts/backfill-broadcasts.ts"
```

- [ ] **Step 3: 로컬 1일 테스트 실행 (DB 환경 확인)**

```bash
npm run backfill:broadcasts -- --days=1
```

Expected output (예시):
```
Backfilling last 1 days...

--- 2026-05-11 ---
  shopch: ok=true slots=58
  qvc: ok=true slots=24
  → inserted=82 updated=0 errors=0

Backfill complete.
```

Supabase 대시보드의 Table Editor → `broadcasts` 에서 행이 들어왔는지 확인.

- [ ] **Step 4: 커밋 (실제 7일 백필은 출시 직전에 1회만)**

```bash
git add scripts/backfill-broadcasts.ts package.json
git commit -m "feat(broadcasts): add one-shot backfill script"
```

---

## Task 8: Vercel Cron 라우트

**Files:**
- Create: `app/api/cron/daily-broadcasts/route.ts`

- [ ] **Step 1: 라우트 작성**

Write to `app/api/cron/daily-broadcasts/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { scrapeAllForDate } from "@/lib/broadcasts";

export const maxDuration = 60;

function verifyCronAuth(req: NextRequest): boolean {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true; // dev mode
	const header = req.headers.get("authorization");
	return header === `Bearer ${secret}`;
}

function getYesterdayJST(nowUtc: Date): Date {
	// JST = UTC + 9. Shift to JST clock, then go back 1 day.
	const jstMs = nowUtc.getTime() + 9 * 3600 * 1000;
	const jstNow = new Date(jstMs);
	jstNow.setUTCDate(jstNow.getUTCDate() - 1);
	// Strip time — only date matters
	return new Date(
		Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate()),
	);
}

export async function GET(req: NextRequest) {
	if (!verifyCronAuth(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const start = Date.now();
	const target = getYesterdayJST(new Date());
	const targetIso = target.toISOString().slice(0, 10);

	const summary = await scrapeAllForDate(target);

	const log = {
		event: "broadcasts.scrape.summary",
		date: targetIso,
		channels: Object.fromEntries(
			summary.results.map((r) => [
				r.channel,
				{
					ok: r.ok,
					count: r.slots.length,
					...(r.error ? { error: r.error } : {}),
					coverage: r.health.fieldCoverage,
				},
			]),
		),
		totals: {
			inserted: summary.totalInserted,
			updated: summary.totalUpdated,
			errors: summary.totalErrors,
		},
		durationMs: Date.now() - start,
	};
	console.log(JSON.stringify(log));

	return NextResponse.json({ ok: true, ...log });
}
```

- [ ] **Step 2: 로컬 dev 서버로 호출 테스트**

별도 터미널:
```bash
npm run dev
```

다른 터미널:
```bash
curl -s http://localhost:3000/api/cron/daily-broadcasts | jq
```

Expected: `{ok:true, event:"broadcasts.scrape.summary", channels:{...}, totals:{...}}` JSON. DB에 어제 데이터가 들어옴 (이미 Task 7로 들어가 있으면 `updated` 증가).

- [ ] **Step 3: 커밋**

```bash
git add app/api/cron/daily-broadcasts/route.ts
git commit -m "feat(broadcasts): add daily cron route for JST yesterday scrape"
```

---

## Task 9: 수동 트리거 API

**Files:**
- Create: `app/api/broadcasts/refresh/route.ts`

- [ ] **Step 1: 라우트 작성**

Write to `app/api/broadcasts/refresh/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { scrapeAllForDate } from "@/lib/broadcasts";
import { sleep } from "@/lib/broadcasts/fetch";

export const maxDuration = 60;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function verifyAuth(req: NextRequest): boolean {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true;
	const header = req.headers.get("authorization");
	return header === `Bearer ${secret}`;
}

function parseISO(d: string): Date | null {
	if (!ISO_DATE.test(d)) return null;
	const date = new Date(`${d}T00:00:00Z`);
	if (Number.isNaN(date.getTime())) return null;
	return date;
}

function diffDays(a: Date, b: Date): number {
	return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

interface RefreshBody {
	date?: string;
	from?: string;
	to?: string;
}

export async function POST(req: NextRequest) {
	if (!verifyAuth(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	let body: RefreshBody;
	try {
		body = (await req.json()) as RefreshBody;
	} catch {
		return NextResponse.json({ error: "invalid json" }, { status: 400 });
	}

	const dates: Date[] = [];
	if (body.date) {
		const d = parseISO(body.date);
		if (!d) return NextResponse.json({ error: "bad date" }, { status: 400 });
		dates.push(d);
	} else if (body.from && body.to) {
		const from = parseISO(body.from);
		const to = parseISO(body.to);
		if (!from || !to) {
			return NextResponse.json({ error: "bad from/to" }, { status: 400 });
		}
		if (to.getTime() < from.getTime()) {
			return NextResponse.json({ error: "to < from" }, { status: 400 });
		}
		const days = diffDays(from, to) + 1;
		if (days > 7) {
			return NextResponse.json({ error: "range > 7 days" }, { status: 400 });
		}
		for (let i = 0; i < days; i++) {
			const d = new Date(from);
			d.setUTCDate(d.getUTCDate() + i);
			dates.push(d);
		}
	} else {
		return NextResponse.json(
			{ error: "provide date or from+to" },
			{ status: 400 },
		);
	}

	const results: Array<Record<string, unknown>> = [];
	let totalInserted = 0;
	let totalUpdated = 0;
	let totalErrors = 0;

	for (const [i, d] of dates.entries()) {
		const iso = d.toISOString().slice(0, 10);
		const summary = await scrapeAllForDate(d);
		totalInserted += summary.totalInserted;
		totalUpdated += summary.totalUpdated;
		totalErrors += summary.totalErrors;
		results.push({
			date: iso,
			channels: Object.fromEntries(
				summary.results.map((r) => [
					r.channel,
					{ ok: r.ok, count: r.slots.length, ...(r.error ? { error: r.error } : {}) },
				]),
			),
			inserted: summary.totalInserted,
			updated: summary.totalUpdated,
			errors: summary.totalErrors,
		});
		if (i < dates.length - 1) await sleep(1000);
	}

	return NextResponse.json({
		ok: true,
		results,
		totals: { inserted: totalInserted, updated: totalUpdated, errors: totalErrors },
	});
}
```

- [ ] **Step 2: dev 서버에서 호출 테스트**

```bash
curl -s -X POST http://localhost:3000/api/broadcasts/refresh \
  -H "Content-Type: application/json" \
  -d '{"date":"2026-05-10"}' | jq
```

Expected: `{ok:true, results:[...], totals:{...}}`.

- [ ] **Step 3: 범위 호출 + 검증 에러 테스트**

```bash
# 정상 (3일)
curl -s -X POST http://localhost:3000/api/broadcasts/refresh \
  -H "Content-Type: application/json" \
  -d '{"from":"2026-05-08","to":"2026-05-10"}' | jq

# 8일 → 400
curl -s -X POST http://localhost:3000/api/broadcasts/refresh \
  -H "Content-Type: application/json" \
  -d '{"from":"2026-05-01","to":"2026-05-08"}' | jq
```

- [ ] **Step 4: 커밋**

```bash
git add app/api/broadcasts/refresh/route.ts
git commit -m "feat(broadcasts): add admin refresh endpoint with range validation"
```

---

## Task 10: 조회 API (`GET /api/broadcasts`)

**Files:**
- Create: `app/api/broadcasts/route.ts`

- [ ] **Step 1: 라우트 작성**

Write to `app/api/broadcasts/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_CHANNELS = new Set(["shopch", "qvc"]);
const MAX_RANGE_DAYS = 62;

export async function GET(req: NextRequest) {
	const { searchParams } = new URL(req.url);
	const from = searchParams.get("from");
	const to = searchParams.get("to");
	const channel = searchParams.get("channel");

	if (!from || !ISO_DATE.test(from)) {
		return NextResponse.json({ error: "missing or invalid 'from'" }, { status: 400 });
	}
	if (!to || !ISO_DATE.test(to)) {
		return NextResponse.json({ error: "missing or invalid 'to'" }, { status: 400 });
	}
	if (to < from) {
		return NextResponse.json({ error: "to < from" }, { status: 400 });
	}
	const days =
		Math.round(
			(new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) /
				86_400_000,
		) + 1;
	if (days > MAX_RANGE_DAYS) {
		return NextResponse.json(
			{ error: `range > ${MAX_RANGE_DAYS} days` },
			{ status: 400 },
		);
	}
	if (channel && !VALID_CHANNELS.has(channel)) {
		return NextResponse.json({ error: "invalid channel" }, { status: 400 });
	}

	const sb = getServiceClient();
	let query = sb
		.from("broadcasts")
		.select(
			"id,channel,air_date,start_time,program_title,presenter,description,thumbnail_url,source_url",
		)
		.gte("air_date", from)
		.lte("air_date", to)
		.order("air_date", { ascending: true })
		.order("start_time", { ascending: true })
		.order("channel", { ascending: true });

	if (channel) query = query.eq("channel", channel);

	const { data, error } = await query;
	if (error) {
		console.error("broadcasts list error", error);
		return NextResponse.json({ error: "db error" }, { status: 500 });
	}

	return NextResponse.json(
		{ broadcasts: data ?? [], total: data?.length ?? 0 },
		{
			headers: {
				"Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
			},
		},
	);
}
```

- [ ] **Step 2: 호출 테스트**

```bash
curl -s "http://localhost:3000/api/broadcasts?from=2026-05-05&to=2026-05-11" | jq '.total'
curl -s "http://localhost:3000/api/broadcasts?from=2026-05-05&to=2026-05-11&channel=shopch" | jq '.total'
curl -s "http://localhost:3000/api/broadcasts?from=invalid" -w "\nHTTP %{http_code}\n"
```

Expected: 정상 응답 + 400 에러 응답.

- [ ] **Step 3: 커밋**

```bash
git add app/api/broadcasts/route.ts
git commit -m "feat(broadcasts): add GET list endpoint with range and channel filters"
```

---

## Task 11: 운영 진단 스크립트

**Files:**
- Create: `scripts/verify-broadcasts-run.ts`
- Modify: `package.json` (add `verify:broadcasts`)

- [ ] **Step 1: 진단 스크립트 작성**

Write to `scripts/verify-broadcasts-run.ts`:

```ts
import { getServiceClient } from "../lib/supabase";

async function main() {
	const sb = getServiceClient();

	console.log("=== broadcasts diagnostic ===\n");

	// 전체 카운트
	const { count: total } = await sb
		.from("broadcasts")
		.select("*", { count: "exact", head: true });
	console.log(`Total rows: ${total ?? 0}`);

	// 어제/오늘 (UTC 기준)
	const today = new Date().toISOString().slice(0, 10);
	const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

	for (const date of [today, yesterday]) {
		const { data, count } = await sb
			.from("broadcasts")
			.select("channel", { count: "exact" })
			.eq("air_date", date);
		const byCh = (data ?? []).reduce<Record<string, number>>((acc, r: any) => {
			acc[r.channel] = (acc[r.channel] ?? 0) + 1;
			return acc;
		}, {});
		console.log(
			`${date}: total=${count ?? 0}, shopch=${byCh.shopch ?? 0}, qvc=${byCh.qvc ?? 0}`,
		);
	}

	// 최근 24시간 스크레이프
	const since = new Date(Date.now() - 86_400_000).toISOString();
	const { count: recent } = await sb
		.from("broadcasts")
		.select("*", { count: "exact", head: true })
		.gte("scraped_at", since);
	console.log(`\nScraped in last 24h: ${recent ?? 0}`);

	// 필드 충전율 (최근 1000행 샘플)
	const { data: sample } = await sb
		.from("broadcasts")
		.select("presenter,description,thumbnail_url")
		.order("scraped_at", { ascending: false })
		.limit(1000);
	if (sample && sample.length > 0) {
		const n = sample.length;
		const pres = sample.filter((r: any) => r.presenter).length / n;
		const desc = sample.filter((r: any) => r.description).length / n;
		const thumb = sample.filter((r: any) => r.thumbnail_url).length / n;
		console.log(`\nField coverage (recent ${n} rows):`);
		console.log(`  presenter:     ${(pres * 100).toFixed(1)}%`);
		console.log(`  description:   ${(desc * 100).toFixed(1)}%`);
		console.log(`  thumbnail_url: ${(thumb * 100).toFixed(1)}%`);
	}
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: package.json**

```json
"verify:broadcasts": "tsx --env-file=.env.local scripts/verify-broadcasts-run.ts"
```

- [ ] **Step 3: 실행 확인**

```bash
npm run verify:broadcasts
```

Expected output:
```
=== broadcasts diagnostic ===

Total rows: N
2026-05-12: total=0, shopch=0, qvc=0
2026-05-11: total=82, shopch=58, qvc=24
...
```

- [ ] **Step 4: 커밋**

```bash
git add scripts/verify-broadcasts-run.ts package.json
git commit -m "feat(broadcasts): add operational diagnostic script"
```

---

## Task 12: 라이브 통합 테스트

**Files:**
- Create: `scripts/test-broadcasts-scrape-live.ts`
- Modify: `package.json` (add `test:broadcasts-live`)

- [ ] **Step 1: 스크립트 작성**

Write to `scripts/test-broadcasts-scrape-live.ts`:

```ts
import { scrapeQVCForDate } from "../lib/broadcasts/qvc";
import { scrapeShopChannelForDate } from "../lib/broadcasts/shopch";

async function main() {
	const yesterday = new Date(Date.now() - 86_400_000);
	const iso = yesterday.toISOString().slice(0, 10);
	console.log(`Live scrape test against ${iso} (no DB write)\n`);

	const [shopch, qvc] = await Promise.all([
		scrapeShopChannelForDate(yesterday),
		scrapeQVCForDate(yesterday),
	]);

	let failed = false;
	for (const r of [shopch, qvc]) {
		const ok = r.ok && r.slots.length >= 1;
		console.log(
			`${ok ? "✓" : "✗"} ${r.channel}: ok=${r.ok} slots=${r.slots.length}${r.error ? ` error=${r.error}` : ""}`,
		);
		if (!ok) failed = true;
	}

	if (failed) {
		console.error("\nLive scrape failed — site markup may have changed.");
		process.exit(1);
	}
	console.log("\nLive scrape OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: package.json**

```json
"test:broadcasts-live": "tsx --env-file=.env.local scripts/test-broadcasts-scrape-live.ts"
```

- [ ] **Step 3: 1회 실행 확인**

```bash
npm run test:broadcasts-live
```

Expected: `✓ shopch`, `✓ qvc`, `Live scrape OK.`

- [ ] **Step 4: 커밋**

```bash
git add scripts/test-broadcasts-scrape-live.ts package.json
git commit -m "feat(broadcasts): add live-site integration test script"
```

---

## Task 13: i18n 메시지 + Navbar 링크

**Files:**
- Modify: `messages/ja.json`
- Modify: `messages/en.json`
- Modify: `components/Navbar.tsx`

- [ ] **Step 1: 기존 메시지 파일 구조 확인**

```bash
head -30 messages/ja.json
head -30 messages/en.json
```

기존 `nav` 네임스페이스 위치 확인.

- [ ] **Step 2: messages/ja.json에 추가**

`nav` 네임스페이스에 `broadcasts` 키 추가, 그리고 새 네임스페이스 `broadcasts` 전체 추가:

```json
{
  "nav": {
    "home": "ホーム",
    "analytics": "分析",
    "broadcasts": "番組カレンダー"
  },
  "broadcasts": {
    "title": "番組カレンダー",
    "subtitle": "Shop Channel と QVC Japan の過去の放送",
    "channels": {
      "shopch": "Shop Channel",
      "qvc": "QVC Japan"
    },
    "channelShort": {
      "shopch": "Shop CH",
      "qvc": "QVC"
    },
    "filters": {
      "all": "全て",
      "shopch": "Shop CH",
      "qvc": "QVC"
    },
    "broadcastCount": "{count} 件",
    "monthNav": {
      "prev": "前月",
      "next": "翌月"
    },
    "openSource": "原本を見る",
    "empty": {
      "all": "まだ番組情報がありません。明日の JST 01:00 以降にデータが入ります。",
      "day": "この日の番組情報はまだ収集されていません。",
      "filtered": "このチャネルの番組はありません。フィルターを変更してください。",
      "apiError": "番組情報の取得に失敗しました。"
    },
    "retry": "再試行"
  }
}
```

> 기존 키와 합치되, 다른 네임스페이스는 그대로 유지.

- [ ] **Step 3: messages/en.json에 추가**

```json
{
  "nav": {
    "home": "Home",
    "analytics": "Analytics",
    "broadcasts": "Broadcast Calendar"
  },
  "broadcasts": {
    "title": "Broadcast Calendar",
    "subtitle": "Past broadcasts from Shop Channel and QVC Japan",
    "channels": {
      "shopch": "Shop Channel",
      "qvc": "QVC Japan"
    },
    "channelShort": {
      "shopch": "Shop CH",
      "qvc": "QVC"
    },
    "filters": {
      "all": "All",
      "shopch": "Shop CH",
      "qvc": "QVC"
    },
    "broadcastCount": "{count} broadcasts",
    "monthNav": {
      "prev": "Prev",
      "next": "Next"
    },
    "openSource": "Open source page",
    "empty": {
      "all": "No broadcast data yet. The first batch arrives after JST 01:00 tomorrow.",
      "day": "No broadcasts collected for this day yet.",
      "filtered": "No broadcasts for this channel. Try a different filter.",
      "apiError": "Failed to load broadcasts."
    },
    "retry": "Retry"
  }
}
```

- [ ] **Step 4: Navbar에 링크 추가**

Modify `components/Navbar.tsx` — `analytics` 링크 옆에 `broadcasts` 추가:

```tsx
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import LanguageSwitcher from './LanguageSwitcher';
import { BarChart3, Calendar } from 'lucide-react';

export default function Navbar() {
  const t = useTranslations('nav');
  const locale = useLocale();

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Link href={`/${locale}`} className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <BarChart3 size={18} className="text-white" />
            </div>
            <span className="text-lg font-bold text-gray-900">MediaWorks</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link
              href={`/${locale}`}
              className="text-sm text-gray-600 hover:text-gray-900 font-medium"
            >
              {t('home')}
            </Link>
            <Link
              href={`/${locale}/broadcasts`}
              className="text-sm text-gray-600 hover:text-gray-900 font-medium flex items-center gap-1"
            >
              <Calendar size={14} />
              {t('broadcasts')}
            </Link>
            <Link
              href={`/${locale}/analytics`}
              className="text-sm text-gray-600 hover:text-gray-900 font-medium flex items-center gap-1"
            >
              <BarChart3 size={14} />
              {t('analytics')}
            </Link>
            <LanguageSwitcher />
          </div>
        </div>
      </div>
    </nav>
  );
}
```

- [ ] **Step 5: lint + build 확인**

```bash
npm run lint
npx tsc --noEmit
```

- [ ] **Step 6: 커밋**

```bash
git add messages/ja.json messages/en.json components/Navbar.tsx
git commit -m "feat(broadcasts): add i18n namespace and Navbar link"
```

---

## Task 14: UI 원자 컴포넌트 — `ChannelBadge`

**Files:**
- Create: `components/broadcasts/ChannelBadge.tsx`

- [ ] **Step 1: 컴포넌트 작성**

Write to `components/broadcasts/ChannelBadge.tsx`:

```tsx
import { useTranslations } from "next-intl";

type Channel = "shopch" | "qvc";

interface Props {
	channel: Channel;
	short?: boolean;
}

const COLORS: Record<Channel, string> = {
	shopch: "bg-red-100 text-red-700 border-red-300",
	qvc: "bg-violet-100 text-violet-700 border-violet-300",
};

export default function ChannelBadge({ channel, short = true }: Props) {
	const t = useTranslations("broadcasts");
	const label = short ? t(`channelShort.${channel}`) : t(`channels.${channel}`);
	return (
		<span
			className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${COLORS[channel]}`}
		>
			{label}
		</span>
	);
}
```

- [ ] **Step 2: 커밋**

```bash
git add components/broadcasts/ChannelBadge.tsx
git commit -m "feat(broadcasts): add ChannelBadge component"
```

---

## Task 15: UI — `BroadcastListItem`

**Files:**
- Create: `components/broadcasts/BroadcastListItem.tsx`

- [ ] **Step 1: 컴포넌트 작성**

Write to `components/broadcasts/BroadcastListItem.tsx`:

```tsx
import { useTranslations } from "next-intl";
import { ExternalLink } from "lucide-react";
import ChannelBadge from "./ChannelBadge";

export interface Broadcast {
	id: string;
	channel: "shopch" | "qvc";
	air_date: string;
	start_time: string;
	program_title: string;
	presenter: string | null;
	description: string | null;
	thumbnail_url: string | null;
	source_url: string;
}

interface Props {
	broadcast: Broadcast;
}

function formatTime(t: string): string {
	// "10:30:00" → "10:30"
	return t.slice(0, 5);
}

export default function BroadcastListItem({ broadcast }: Props) {
	const t = useTranslations("broadcasts");
	const b = broadcast;
	return (
		<div className="flex gap-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
			{b.thumbnail_url ? (
				// eslint-disable-next-line @next/next/no-img-element
				<img
					src={b.thumbnail_url}
					alt=""
					className="w-16 h-12 object-cover rounded flex-shrink-0 bg-gray-100"
					loading="lazy"
					onError={(e) => {
						(e.target as HTMLImageElement).style.visibility = "hidden";
					}}
				/>
			) : (
				<div className="w-16 h-12 bg-gray-100 rounded flex-shrink-0" />
			)}
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2 text-sm">
					<span className="font-mono font-semibold text-gray-900">{formatTime(b.start_time)}</span>
					<ChannelBadge channel={b.channel} />
				</div>
				<div className="font-medium text-gray-900 mt-1 truncate">{b.program_title}</div>
				{(b.presenter || b.description) && (
					<div className="text-xs text-gray-500 mt-0.5 truncate">
						{b.presenter && <span className="mr-2">ナビ: {b.presenter}</span>}
						{b.description && <span>{b.description}</span>}
					</div>
				)}
			</div>
			<a
				href={b.source_url}
				target="_blank"
				rel="noopener noreferrer"
				className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 flex-shrink-0 self-start mt-1"
			>
				<ExternalLink size={12} />
				{t("openSource")}
			</a>
		</div>
	);
}
```

- [ ] **Step 2: lint + 빌드 확인**

```bash
npm run lint
npx tsc --noEmit
```

- [ ] **Step 3: 커밋**

```bash
git add components/broadcasts/BroadcastListItem.tsx
git commit -m "feat(broadcasts): add BroadcastListItem component"
```

---

## Task 16: UI — `ChannelFilter`

**Files:**
- Create: `components/broadcasts/ChannelFilter.tsx`

- [ ] **Step 1: 컴포넌트 작성**

Write to `components/broadcasts/ChannelFilter.tsx`:

```tsx
"use client";

import { useTranslations } from "next-intl";

export type ChannelFilterValue = "all" | "shopch" | "qvc";

interface Props {
	value: ChannelFilterValue;
	onChange: (v: ChannelFilterValue) => void;
}

const OPTIONS: ChannelFilterValue[] = ["all", "shopch", "qvc"];

const STYLES: Record<ChannelFilterValue, { active: string; inactive: string }> = {
	all: {
		active: "bg-gray-900 text-white border-gray-900",
		inactive: "bg-white text-gray-700 border-gray-300 hover:bg-gray-50",
	},
	shopch: {
		active: "bg-red-600 text-white border-red-600",
		inactive: "bg-white text-red-700 border-red-300 hover:bg-red-50",
	},
	qvc: {
		active: "bg-violet-600 text-white border-violet-600",
		inactive: "bg-white text-violet-700 border-violet-300 hover:bg-violet-50",
	},
};

export default function ChannelFilter({ value, onChange }: Props) {
	const t = useTranslations("broadcasts");
	return (
		<div className="inline-flex items-center gap-2">
			{OPTIONS.map((opt) => {
				const active = value === opt;
				const style = STYLES[opt][active ? "active" : "inactive"];
				return (
					<button
						key={opt}
						type="button"
						onClick={() => onChange(opt)}
						className={`px-3 py-1 rounded-full text-xs font-medium border ${style} transition-colors`}
					>
						{t(`filters.${opt}`)}
					</button>
				);
			})}
		</div>
	);
}
```

- [ ] **Step 2: 커밋**

```bash
git add components/broadcasts/ChannelFilter.tsx
git commit -m "feat(broadcasts): add ChannelFilter component"
```

---

## Task 17: UI — `DayDetailPanel`

**Files:**
- Create: `components/broadcasts/DayDetailPanel.tsx`

- [ ] **Step 1: 구현**

Write to `components/broadcasts/DayDetailPanel.tsx`:

```tsx
"use client";

import { useTranslations } from "next-intl";
import BroadcastListItem, { type Broadcast } from "./BroadcastListItem";
import ChannelFilter, { type ChannelFilterValue } from "./ChannelFilter";

interface Props {
	date: string | null; // YYYY-MM-DD
	broadcasts: Broadcast[];
	channelFilter: ChannelFilterValue;
	onChannelFilterChange: (v: ChannelFilterValue) => void;
}

function formatDateLabel(iso: string): string {
	// "2026-05-11" → "2026年5月11日"
	const [y, m, d] = iso.split("-");
	return `${y}年${parseInt(m, 10)}月${parseInt(d, 10)}日`;
}

export default function DayDetailPanel({
	date,
	broadcasts,
	channelFilter,
	onChannelFilterChange,
}: Props) {
	const t = useTranslations("broadcasts");

	if (!date) {
		return (
			<div className="text-sm text-gray-500 p-6 text-center">
				{t("empty.day")}
			</div>
		);
	}

	const filtered =
		channelFilter === "all"
			? broadcasts
			: broadcasts.filter((b) => b.channel === channelFilter);

	const sorted = [...filtered].sort((a, b) => {
		if (a.start_time !== b.start_time) return a.start_time.localeCompare(b.start_time);
		return a.channel.localeCompare(b.channel);
	});

	return (
		<div>
			<div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
				<div>
					<h2 className="text-xl font-semibold text-gray-900">{formatDateLabel(date)}</h2>
					<p className="text-xs text-gray-500">
						{t("broadcastCount", { count: filtered.length })}
					</p>
				</div>
				<ChannelFilter value={channelFilter} onChange={onChannelFilterChange} />
			</div>

			{sorted.length === 0 ? (
				<div className="text-sm text-gray-500 p-6 text-center border border-dashed border-gray-200 rounded-lg">
					{broadcasts.length === 0 ? t("empty.day") : t("empty.filtered")}
				</div>
			) : (
				<div className="flex flex-col gap-2">
					{sorted.map((b) => (
						<BroadcastListItem key={b.id} broadcast={b} />
					))}
				</div>
			)}
		</div>
	);
}
```

- [ ] **Step 2: 커밋**

```bash
git add components/broadcasts/DayDetailPanel.tsx
git commit -m "feat(broadcasts): add DayDetailPanel with channel filter"
```

---

## Task 18: UI — `DateCell`

**Files:**
- Create: `components/broadcasts/DateCell.tsx`

- [ ] **Step 1: 구현**

Write to `components/broadcasts/DateCell.tsx`:

```tsx
"use client";

interface Props {
	iso: string; // YYYY-MM-DD
	dayLabel: number; // 1..31
	isCurrentMonth: boolean;
	isToday: boolean;
	isSelected: boolean;
	shopchCount: number;
	qvcCount: number;
	onClick: (iso: string) => void;
}

export default function DateCell({
	iso,
	dayLabel,
	isCurrentMonth,
	isToday,
	isSelected,
	shopchCount,
	qvcCount,
	onClick,
}: Props) {
	const total = shopchCount + qvcCount;
	const base = "aspect-square rounded-lg p-1.5 text-left transition-colors border";
	const muted = !isCurrentMonth;
	const selected = isSelected;
	const todayRing = isToday && !selected;

	const cls = [
		base,
		selected
			? "bg-blue-600 text-white border-blue-600 hover:bg-blue-700"
			: muted
				? "bg-gray-50 text-gray-400 border-gray-100 hover:bg-gray-100"
				: "bg-white text-gray-900 border-gray-200 hover:bg-gray-50",
		todayRing ? "ring-2 ring-blue-400" : "",
	].join(" ");

	return (
		<button type="button" onClick={() => onClick(iso)} className={cls}>
			<div className="text-sm font-semibold leading-tight">{dayLabel}</div>
			{total > 0 ? (
				<div className={`text-[10px] leading-tight mt-1 ${selected ? "text-blue-100" : "text-gray-500"}`}>
					<div>S·{shopchCount}</div>
					<div>Q·{qvcCount}</div>
				</div>
			) : (
				<div className={`text-[10px] leading-tight mt-1 ${selected ? "text-blue-200" : "text-gray-300"}`}>—</div>
			)}
		</button>
	);
}
```

- [ ] **Step 2: 커밋**

```bash
git add components/broadcasts/DateCell.tsx
git commit -m "feat(broadcasts): add DateCell with per-channel mini counts"
```

---

## Task 19: UI — `MonthGrid`

**Files:**
- Create: `components/broadcasts/MonthGrid.tsx`

- [ ] **Step 1: 구현**

Write to `components/broadcasts/MonthGrid.tsx`:

```tsx
"use client";

import DateCell from "./DateCell";
import type { Broadcast } from "./BroadcastListItem";

interface Props {
	year: number;
	month: number; // 1..12
	broadcasts: Broadcast[]; // 해당 월에 속한 모든 방송
	selectedDate: string | null;
	onDateClick: (iso: string) => void;
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function buildGrid(year: number, month: number) {
	// month is 1-indexed. Build 6×7 grid Mon-Sun.
	const first = new Date(Date.UTC(year, month - 1, 1));
	const firstDow = first.getUTCDay(); // 0=Sun
	// 월요일 시작 그리드: 일요일을 7번째 칸으로
	const offset = (firstDow + 6) % 7;
	const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

	const cells: { iso: string; day: number; inMonth: boolean }[] = [];

	// 이전 달 꼬리
	const prevMonthLast = new Date(Date.UTC(year, month - 1, 0));
	const prevDays = prevMonthLast.getUTCDate();
	const prevYear = month === 1 ? year - 1 : year;
	const prevMonth = month === 1 ? 12 : month - 1;
	for (let i = offset - 1; i >= 0; i--) {
		const d = prevDays - i;
		cells.push({
			iso: `${prevYear}-${pad2(prevMonth)}-${pad2(d)}`,
			day: d,
			inMonth: false,
		});
	}

	// 현재 달
	for (let d = 1; d <= daysInMonth; d++) {
		cells.push({
			iso: `${year}-${pad2(month)}-${pad2(d)}`,
			day: d,
			inMonth: true,
		});
	}

	// 다음 달 머리 — 42칸 채우기
	const nextYear = month === 12 ? year + 1 : year;
	const nextMonth = month === 12 ? 1 : month + 1;
	let nextDay = 1;
	while (cells.length < 42) {
		cells.push({
			iso: `${nextYear}-${pad2(nextMonth)}-${pad2(nextDay)}`,
			day: nextDay,
			inMonth: false,
		});
		nextDay++;
	}

	return cells;
}

export default function MonthGrid({
	year,
	month,
	broadcasts,
	selectedDate,
	onDateClick,
}: Props) {
	const cells = buildGrid(year, month);

	// 날짜별 채널 카운트 사전계산
	const counts = new Map<string, { shopch: number; qvc: number }>();
	for (const b of broadcasts) {
		const c = counts.get(b.air_date) ?? { shopch: 0, qvc: 0 };
		c[b.channel]++;
		counts.set(b.air_date, c);
	}

	const todayIso = new Date().toISOString().slice(0, 10);
	const headers = ["月", "火", "水", "木", "金", "土", "日"];

	return (
		<div>
			<div className="grid grid-cols-7 gap-1 mb-1 text-xs text-gray-500">
				{headers.map((h) => (
					<div key={h} className="text-center py-1">{h}</div>
				))}
			</div>
			<div className="grid grid-cols-7 gap-1">
				{cells.map((c) => {
					const cnt = counts.get(c.iso) ?? { shopch: 0, qvc: 0 };
					return (
						<DateCell
							key={c.iso}
							iso={c.iso}
							dayLabel={c.day}
							isCurrentMonth={c.inMonth}
							isToday={c.iso === todayIso}
							isSelected={c.iso === selectedDate}
							shopchCount={cnt.shopch}
							qvcCount={cnt.qvc}
							onClick={onDateClick}
						/>
					);
				})}
			</div>
		</div>
	);
}
```

- [ ] **Step 2: 커밋**

```bash
git add components/broadcasts/MonthGrid.tsx
git commit -m "feat(broadcasts): add MonthGrid with prev/next-month spillover cells"
```

---

## Task 20: UI 상태 허브 — `BroadcastCalendar`

**Files:**
- Create: `components/broadcasts/BroadcastCalendar.tsx`

- [ ] **Step 1: 구현**

Write to `components/broadcasts/BroadcastCalendar.tsx`:

```tsx
"use client";

import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Broadcast } from "./BroadcastListItem";
import type { ChannelFilterValue } from "./ChannelFilter";
import DayDetailPanel from "./DayDetailPanel";
import MonthGrid from "./MonthGrid";

interface Props {
	initialYear: number;
	initialMonth: number; // 1..12
	initialDate: string | null;
	initialBroadcasts: Broadcast[];
}

function monthKey(y: number, m: number) {
	return `${y}-${String(m).padStart(2, "0")}`;
}

function monthBounds(y: number, m: number): { from: string; to: string } {
	const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
	return {
		from: `${y}-${String(m).padStart(2, "0")}-01`,
		to: `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`,
	};
}

function gridBounds(y: number, m: number): { from: string; to: string } {
	// 그리드는 인접 월의 일부도 포함 — 그 데이터까지 fetch하면 셀 카운트가 정확해짐
	const prevY = m === 1 ? y - 1 : y;
	const prevM = m === 1 ? 12 : m - 1;
	const nextY = m === 12 ? y + 1 : y;
	const nextM = m === 12 ? 1 : m + 1;
	const prevLast = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
	const nextLast = new Date(Date.UTC(nextY, nextM, 0)).getUTCDate();
	return {
		from: `${prevY}-${String(prevM).padStart(2, "0")}-${String(Math.max(prevLast - 6, 1)).padStart(2, "0")}`,
		to: `${nextY}-${String(nextM).padStart(2, "0")}-${String(Math.min(nextLast, 7)).padStart(2, "0")}`,
	};
}

export default function BroadcastCalendar({
	initialYear,
	initialMonth,
	initialDate,
	initialBroadcasts,
}: Props) {
	const t = useTranslations("broadcasts");
	const router = useRouter();
	const searchParams = useSearchParams();

	const [year, setYear] = useState(initialYear);
	const [month, setMonth] = useState(initialMonth);
	const [selectedDate, setSelectedDate] = useState<string | null>(initialDate);
	const [channelFilter, setChannelFilter] = useState<ChannelFilterValue>(
		(searchParams.get("ch") as ChannelFilterValue) ?? "all",
	);

	const initialKey = monthKey(initialYear, initialMonth);
	const [cache, setCache] = useState<Map<string, Broadcast[]>>(
		() => new Map([[initialKey, initialBroadcasts]]),
	);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const currentKey = monthKey(year, month);
	const currentMonthData = cache.get(currentKey) ?? [];

	// 월 변경 시 데이터 fetch
	useEffect(() => {
		if (cache.has(currentKey)) return;
		const { from, to } = gridBounds(year, month);
		setLoading(true);
		setError(null);
		fetch(`/api/broadcasts?from=${from}&to=${to}`)
			.then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
			.then((json: { broadcasts: Broadcast[] }) => {
				setCache((prev) => new Map(prev).set(currentKey, json.broadcasts));
			})
			.catch((e) => setError(String(e)))
			.finally(() => setLoading(false));
	}, [currentKey, year, month, cache]);

	// URL 동기화
	const syncUrl = useCallback(
		(date: string | null, ch: ChannelFilterValue) => {
			const params = new URLSearchParams();
			if (date) params.set("date", date);
			if (ch !== "all") params.set("ch", ch);
			const qs = params.toString();
			router.replace(qs ? `?${qs}` : "?", { scroll: false });
		},
		[router],
	);

	const handleDateClick = useCallback(
		(iso: string) => {
			setSelectedDate(iso);
			// 선택 날짜가 다른 월이면 월 이동
			const [y, m] = iso.split("-").map((x) => parseInt(x, 10));
			if (y !== year || m !== month) {
				setYear(y);
				setMonth(m);
			}
			syncUrl(iso, channelFilter);
		},
		[year, month, channelFilter, syncUrl],
	);

	const handleFilterChange = useCallback(
		(v: ChannelFilterValue) => {
			setChannelFilter(v);
			syncUrl(selectedDate, v);
		},
		[selectedDate, syncUrl],
	);

	const goPrev = useCallback(() => {
		if (month === 1) {
			setYear(year - 1);
			setMonth(12);
		} else {
			setMonth(month - 1);
		}
		setSelectedDate(null);
	}, [year, month]);

	const goNext = useCallback(() => {
		if (month === 12) {
			setYear(year + 1);
			setMonth(1);
		} else {
			setMonth(month + 1);
		}
		setSelectedDate(null);
	}, [year, month]);

	const dayBroadcasts = useMemo(
		() =>
			selectedDate
				? currentMonthData.filter((b) => b.air_date === selectedDate)
				: [],
		[selectedDate, currentMonthData],
	);

	const monthLabel = `${year}年 ${month}月`;

	return (
		<div className="grid md:grid-cols-2 gap-6">
			<div>
				<div className="flex items-center justify-between mb-3">
					<button
						type="button"
						onClick={goPrev}
						className="p-1.5 rounded hover:bg-gray-100"
						aria-label={t("monthNav.prev")}
					>
						<ChevronLeft size={18} />
					</button>
					<h2 className="text-lg font-semibold text-gray-900">{monthLabel}</h2>
					<button
						type="button"
						onClick={goNext}
						className="p-1.5 rounded hover:bg-gray-100"
						aria-label={t("monthNav.next")}
					>
						<ChevronRight size={18} />
					</button>
				</div>
				{loading && (
					<div className="text-xs text-gray-500 mb-2">Loading…</div>
				)}
				{error && (
					<div className="text-xs text-red-600 mb-2">
						{t("empty.apiError")} ({error})
					</div>
				)}
				<MonthGrid
					year={year}
					month={month}
					broadcasts={currentMonthData}
					selectedDate={selectedDate}
					onDateClick={handleDateClick}
				/>
			</div>

			<div>
				<DayDetailPanel
					date={selectedDate}
					broadcasts={dayBroadcasts}
					channelFilter={channelFilter}
					onChannelFilterChange={handleFilterChange}
				/>
			</div>
		</div>
	);
}
```

- [ ] **Step 2: lint + 빌드**

```bash
npm run lint
npx tsc --noEmit
```

- [ ] **Step 3: 커밋**

```bash
git add components/broadcasts/BroadcastCalendar.tsx
git commit -m "feat(broadcasts): add BroadcastCalendar client state hub"
```

---

## Task 21: UI — 페이지 + Skeleton

**Files:**
- Create: `app/[locale]/broadcasts/page.tsx`
- Create: `app/[locale]/broadcasts/loading.tsx`

- [ ] **Step 1: 페이지 (Server Component)**

Write to `app/[locale]/broadcasts/page.tsx`:

```tsx
import { getTranslations } from "next-intl/server";
import { getServiceClient } from "@/lib/supabase";
import BroadcastCalendar from "@/components/broadcasts/BroadcastCalendar";
import type { Broadcast } from "@/components/broadcasts/BroadcastListItem";

interface PageProps {
	params: Promise<{ locale: string }>;
	searchParams: Promise<{ date?: string; ch?: string }>;
}

function pad2(n: number) {
	return String(n).padStart(2, "0");
}

function monthBoundsAround(iso: string): { y: number; m: number; from: string; to: string } {
	const [yy, mm] = iso.split("-").map((x) => parseInt(x, 10));
	const prevY = mm === 1 ? yy - 1 : yy;
	const prevM = mm === 1 ? 12 : mm - 1;
	const nextY = mm === 12 ? yy + 1 : yy;
	const nextM = mm === 12 ? 1 : mm + 1;
	const prevLast = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
	const nextLast = new Date(Date.UTC(nextY, nextM, 0)).getUTCDate();
	return {
		y: yy,
		m: mm,
		from: `${prevY}-${pad2(prevM)}-${pad2(Math.max(prevLast - 6, 1))}`,
		to: `${nextY}-${pad2(nextM)}-${pad2(Math.min(nextLast, 7))}`,
	};
}

export default async function Page({ params, searchParams }: PageProps) {
	const { locale } = await params;
	const sp = await searchParams;
	const t = await getTranslations({ locale, namespace: "broadcasts" });

	const today = new Date();
	const todayIso = today.toISOString().slice(0, 10);
	const selected = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayIso;
	const { y, m, from, to } = monthBoundsAround(selected);

	const sb = getServiceClient();
	const { data } = await sb
		.from("broadcasts")
		.select(
			"id,channel,air_date,start_time,program_title,presenter,description,thumbnail_url,source_url",
		)
		.gte("air_date", from)
		.lte("air_date", to)
		.order("air_date", { ascending: true })
		.order("start_time", { ascending: true })
		.order("channel", { ascending: true });

	const initialBroadcasts: Broadcast[] = data ?? [];

	const hasAny = initialBroadcasts.length > 0;

	return (
		<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
			<header className="mb-6">
				<h1 className="text-2xl font-bold text-gray-900">{t("title")}</h1>
				<p className="text-sm text-gray-500 mt-1">{t("subtitle")}</p>
			</header>

			{!hasAny ? (
				<div className="text-sm text-gray-500 p-12 text-center border border-dashed border-gray-200 rounded-lg">
					{t("empty.all")}
				</div>
			) : (
				<BroadcastCalendar
					initialYear={y}
					initialMonth={m}
					initialDate={selected}
					initialBroadcasts={initialBroadcasts}
				/>
			)}
		</div>
	);
}
```

- [ ] **Step 2: loading skeleton**

Write to `app/[locale]/broadcasts/loading.tsx`:

```tsx
export default function Loading() {
	return (
		<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
			<div className="h-8 w-48 bg-gray-200 rounded animate-pulse mb-2" />
			<div className="h-4 w-64 bg-gray-100 rounded animate-pulse mb-6" />
			<div className="grid md:grid-cols-2 gap-6">
				<div>
					<div className="h-8 w-32 bg-gray-100 rounded animate-pulse mb-3" />
					<div className="grid grid-cols-7 gap-1">
						{Array.from({ length: 42 }).map((_, i) => (
							<div key={i} className="aspect-square bg-gray-100 rounded-lg animate-pulse" />
						))}
					</div>
				</div>
				<div>
					<div className="h-6 w-40 bg-gray-100 rounded animate-pulse mb-4" />
					{Array.from({ length: 6 }).map((_, i) => (
						<div key={i} className="h-16 bg-gray-100 rounded-lg animate-pulse mb-2" />
					))}
				</div>
			</div>
		</div>
	);
}
```

- [ ] **Step 3: 페이지 수동 확인**

```bash
npm run dev
```

브라우저: `http://localhost:3000/ja/broadcasts` 접근 → 캘린더가 보여야 함. 데이터가 없으면 "まだ番組情報がありません" 빈 상태.

- [ ] **Step 4: 커밋**

```bash
git add 'app/[locale]/broadcasts/page.tsx' 'app/[locale]/broadcasts/loading.tsx'
git commit -m "feat(broadcasts): add page + loading skeleton"
```

---

## Task 22: `vercel.json` 업데이트 (cron + 함수 타임아웃)

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: 기존 vercel.json 읽기**

```bash
cat vercel.json
```

- [ ] **Step 2: 함수 + cron 항목 추가**

Edit `vercel.json` — `functions` 섹션에 추가:

```json
"app/api/cron/daily-broadcasts/route.ts": {
  "maxDuration": 60
},
"app/api/broadcasts/refresh/route.ts": {
  "maxDuration": 60
}
```

`crons` 배열에 추가:

```json
{
  "path": "/api/cron/daily-broadcasts",
  "schedule": "0 16 * * *"
}
```

전체 파일이 다음 형태가 되도록 정렬:

```json
{
  "functions": {
    "app/api/analyze/synthesize/route.ts": { "maxDuration": 300 },
    "app/api/analyze/route.ts": { "maxDuration": 120 },
    "app/api/cron/daily-refresh/route.ts": { "maxDuration": 300 },
    "app/api/cron/daily-discovery/route.ts": { "maxDuration": 10 },
    "app/api/cron/daily-discovery-home/route.ts": { "maxDuration": 300 },
    "app/api/cron/daily-discovery-live/route.ts": { "maxDuration": 300 },
    "app/api/cron/daily-broadcasts/route.ts": { "maxDuration": 60 },
    "app/api/broadcasts/refresh/route.ts": { "maxDuration": 60 },
    "app/api/recommend/route.ts": { "maxDuration": 60 },
    "app/api/analytics/expansion/route.ts": { "maxDuration": 120 },
    "app/api/products/upload-taicho/route.ts": { "maxDuration": 120 },
    "app/api/analytics/md-strategy/route.ts": { "maxDuration": 300 },
    "app/api/analytics/live-commerce/route.ts": { "maxDuration": 300 },
    "app/api/discovery/manual-trigger/route.ts": { "maxDuration": 300 },
    "app/api/discovery/enrich/[productId]/route.ts": { "maxDuration": 30 },
    "app/api/discovery/enrich/[productId]/worker/route.ts": { "maxDuration": 60 },
    "app/api/discovery/feedback/route.ts": { "maxDuration": 10 },
    "app/api/cron/daily-learning/route.ts": { "maxDuration": 60 },
    "app/api/cron/weekly-insights/route.ts": { "maxDuration": 120 }
  },
  "crons": [
    { "path": "/api/cron/daily-refresh", "schedule": "0 9 * * *" },
    { "path": "/api/cron/daily-discovery-home", "schedule": "0 23 * * *" },
    { "path": "/api/cron/daily-discovery-live", "schedule": "30 23 * * *" },
    { "path": "/api/cron/daily-broadcasts", "schedule": "0 16 * * *" },
    { "path": "/api/cron/daily-learning", "schedule": "45 22 * * *" },
    { "path": "/api/cron/weekly-insights", "schedule": "0 1 * * 1" }
  ]
}
```

- [ ] **Step 3: 커밋**

```bash
git add vercel.json
git commit -m "feat(broadcasts): register daily-broadcasts cron + function timeouts"
```

---

## Task 23: CLAUDE.md 업데이트

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 새 섹션 추가**

`CLAUDE.md`의 "External Services" 표 뒤, "Supabase Schema" 섹션 앞에 다음 추가:

```markdown
### Broadcast Calendar (Phase A — read-only)

- Daily JST 01:00 cron (`16:00 UTC` → `app/api/cron/daily-broadcasts/route.ts`) scrapes yesterday's broadcasts from Shop Channel (`shopch.jp`) and QVC Japan (`qvc.jp`) via cheerio.
- Read API: `GET /api/broadcasts?from=YYYY-MM-DD&to=YYYY-MM-DD[&channel=shopch|qvc]` (max 62-day range).
- Admin recovery: `POST /api/broadcasts/refresh` with `{date}` or `{from,to}` (max 7 days), `Bearer ${CRON_SECRET}`.
- UI: `/[locale]/broadcasts` — month grid + time-sorted unified day list with channel filter.
- Module layout: `lib/broadcasts/{types,fetch,shopch,qvc,persist,index}.ts`.
- Fixture-based parser tests: `npm run test:broadcasts-parsers`. Live integration: `npm run test:broadcasts-live`. Operational diagnostic: `npm run verify:broadcasts`. One-shot 7-day backfill: `npm run backfill:broadcasts -- --days=7`.
- Phases B (product extraction from each broadcast) and C (time-slot analytics) build on this `broadcasts` table without modifying it.
```

- [ ] **Step 2: 커밋**

```bash
git add CLAUDE.md
git commit -m "docs: document broadcast calendar feature in CLAUDE.md"
```

---

## Task 24: 출시 검증 — 7일 백필 + 전체 통합

**Files:** (none — operational steps)

- [ ] **Step 1: 7일 백필 실행 (로컬, 프로덕션 Supabase 대상)**

`.env.local`이 프로덕션 Supabase URL/키를 가리키는지 확인 후:

```bash
npm run backfill:broadcasts -- --days=7
```

> 14 HTTP 요청(7일 × 2채널). 약 30-60초 소요. 각 날짜별 결과 콘솔에 출력.

- [ ] **Step 2: 진단 스크립트로 결과 확인**

```bash
npm run verify:broadcasts
```

Expected: Total rows ≥ 200, 어제 날짜 ≥ 50, 필드 충전율 (presenter) ≥ 30%.

- [ ] **Step 3: dev 서버에서 페이지 확인**

```bash
npm run dev
```

브라우저: `http://localhost:3000/ja/broadcasts` — 캘린더에 7일치 데이터가 보임. 다음 체크리스트 통과:

- [ ] `/ja/broadcasts`가 캘린더 렌더링
- [ ] 월 ←/→ 네비 동작
- [ ] 날짜 클릭 시 디테일 패널 갱신, URL `?date=...` 업데이트
- [ ] 채널 필터 동작, URL `?ch=...` 업데이트
- [ ] 새 탭에서 전체 URL 붙여넣기 → 같은 상태 재현
- [ ] 빈 날짜 클릭 시 "수집되지 않음" 메시지
- [ ] 모바일 너비(브라우저 너비 375px)에서 세로 스택
- [ ] `/en/broadcasts`에서 영어 UI 셸 + 일본어 콘텐츠
- [ ] Navbar 링크가 동작 + 활성 상태
- [ ] "原本を見る" 클릭 시 새 탭으로 source_url

- [ ] **Step 4: Lint + Build 확인**

```bash
npm run lint
npm run build
```

Expected: 모두 통과.

- [ ] **Step 5: 라이브 통합 + 파서 회귀 재확인**

```bash
npm run test:broadcasts-parsers
npm run test:broadcasts-live
```

- [ ] **Step 6: 최종 출시 커밋 (있다면) + 푸시**

체크리스트 미달인 항목이 있으면 수정해서 커밋. 모두 통과하면 브랜치 푸시:

```bash
git status
git push -u origin HEAD
```

- [ ] **Step 7: Vercel 배포 후 cron 등록 확인**

Vercel 대시보드 → Project → Settings → Cron Jobs → `daily-broadcasts` 항목이 `0 16 * * *` 스케줄로 등록돼 있는지 확인.

`CRON_SECRET` 환경변수가 Production에 설정돼 있는지 확인 (Settings → Environment Variables).

- [ ] **Step 8: 프로덕션 cron 수동 실행으로 동작 확인**

```bash
curl -s -X POST "https://<your-vercel-url>/api/broadcasts/refresh" \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"date\":\"$(date -v-1d +%Y-%m-%d)\"}" | jq
```

Expected: `{ok:true, results:[...], totals:{inserted:N or updated:N}}`.

- [ ] **Step 9: 다음 날 아침 cron 결과 확인 (운영)**

다음 날 아침에 Vercel 로그(Functions → `daily-broadcasts` → Logs)에서 `broadcasts.scrape.summary` JSON 로그 확인. `npm run verify:broadcasts`로 어제 날짜 데이터가 추가됐는지 검증.

---

## Definition of Done

전체 플랜 완료 기준:

- [ ] 모든 24개 Task 통과
- [ ] `npm run lint` 통과
- [ ] `npm run build` 통과
- [ ] `npm run test:broadcasts-parsers` 통과
- [ ] `npm run test:broadcasts-live` 1회 실행, 양 채널 ≥ 1 슬롯
- [ ] `npm run backfill:broadcasts -- --days=7` 실행 후 DB에 ≥ 200행
- [ ] Task 24 Step 3의 10개 UI 체크리스트 모두 통과
- [ ] Vercel 대시보드에 `daily-broadcasts` cron 등록 확인
- [ ] 출시 후 다음 날 cron이 자동 실행되어 어제 데이터 추가 확인
