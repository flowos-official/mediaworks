# Broadcast Selling-Language Corpus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract structural selling patterns from archived QVC/ShopCh broadcast audio and inject a same-category aggregate into the initial screenplay prompt, turning the pipeline page's `datasetSellingLanguage` and `outcomeCompetitiveScript` nodes from `planned` into `current`.

**Architecture:** A new `lib/broadcast-intel/` module mirrors the existing archive pipeline: a queue column on `broadcasts`, a per-slot worker (`analyzeOne`, modelled on `archiveOne`), a budgeted cron drain, and a local drain script. Each worker streams the archived MP4 out of S3 through ffmpeg to mono audio, sends it to Gemini for a structured act/selling-point/evidence breakdown, and writes the verbatim transcript to an admin-only table while writing only abstract patterns to a member-readable one. At screenplay generation time a pure aggregator turns the same-category rows into runtime-normalised percentages, and a formatter renders them as one prompt block — routed exactly like the existing `complianceBlock`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (postgres + RLS), `@google/genai` 1.48 (Files API + structured output), `@ffmpeg-installer/ffmpeg`, `@aws-sdk/client-s3`, `tsx` + `node:assert/strict` tests.

**Spec:** `docs/superpowers/specs/2026-08-24-broadcast-selling-language-design.md`

## Global Constraints

- Structure-only: `broadcast_speech_analyses` must never gain a column holding a product name, figure, or sentence. Verbatim text lives only in `broadcast_transcripts` (admin RLS).
- Prompt injection happens in `initial` mode only. `refine` is untouched.
- `PATTERN_MIN_SAMPLES` (default 5) is **fail-closed**: below it, inject nothing.
- Model IDs come from `lib/gemini-models.ts` (`GEMINI_FLASH`, `GEMINI_PRO_FALLBACK`). Never hard-code a model string.
- Any file imported by a `scripts/test-*.ts` smoke must NOT `import "server-only"` (it throws outside Next's bundler alias). Rely on `getServiceClient` as the server-side guard.
- Reads that can exceed 1000 rows must go through `lib/supabase/paginate.ts::selectAllPages` with a stable `.order()`.
- New tables get an explicit RLS policy in the same migration. Group A = member/admin read; Group B = admin read.
- Every task ends with a commit. Do not batch commits across tasks.

---

## File Structure

### Created

| File | Responsibility |
| --- | --- |
| `supabase/migrations/20260825090000_broadcast_speech_analyses.sql` | Queue columns, both new tables + RLS, `screenplay_versions.pattern_snapshot` |
| `lib/broadcast-intel/schema.ts` | Enums, Gemini response schema, result types. Pure — no I/O. |
| `lib/broadcast-intel/audio-extract.ts` | S3 object → ffmpeg → mono audio buffer + runtime seconds |
| `lib/broadcast-intel/gemini-analyze.ts` | Files API upload → structured Gemini call → validated result |
| `lib/broadcast-intel/persist.ts` | Writes both tables, moves queue state |
| `lib/broadcast-intel/analyze-one.ts` | Single-slot orchestration (claim → extract → analyse → persist) |
| `lib/broadcast-intel/category-pattern.ts` | Same-category aggregation into runtime-normalised percentages |
| `lib/broadcast-intel/format-prompt.ts` | Renders `CategoryPattern` as the Japanese prompt block |
| `app/api/cron/analyze-broadcast-audio/route.ts` | Budgeted queue drain |
| `scripts/drain-broadcast-analysis.ts` | Local drain (initial 40-slot batch) |
| `scripts/test-broadcast-intel-schema.ts` | Enum ↔ Gemini-schema drift guard |
| `scripts/test-broadcast-intel-aggregate.ts` | Aggregation maths |
| `scripts/test-broadcast-intel-prompt.ts` | Prompt block + **leak test** |
| `scripts/test-broadcast-intel-live.ts` | One real broadcast, end to end |

### Modified

| File | Change |
| --- | --- |
| `lib/broadcasts/video-archival.ts` | Export nothing new — `parseDurationFromStderr` is already exported and gets reused |
| `lib/screenplay/types.ts` | `GenerateInput.patternBlock?: string` |
| `lib/screenplay/prompt.ts` | Inject the block; priority list 4 → 5 items |
| `lib/workflows/screenplay.workflow.ts` | Build the pattern, pass it, persist `pattern_snapshot` |
| `lib/pipeline/data-intelligence-graph.ts` | Two nodes + two links `planned` → `current` |
| `scripts/test-data-intelligence-graph.ts` | Updated expectations |
| `components/screenplay/*` (detail view) | "경쟁 방송 구성 패턴 N편 반영" indicator |
| `messages/ja.json`, `messages/ko.json` | Indicator copy |
| `package.json` | 5 new test/drain aliases |
| `vercel.json` | New cron entry + `maxDuration` |

---

## Task 1: Schema migration

**Files:**
- Create: `supabase/migrations/20260825090000_broadcast_speech_analyses.sql`
- Modify: `scripts/check-migrations.ts`

**Interfaces:**
- Produces: tables `broadcast_transcripts`, `broadcast_speech_analyses`; columns `broadcasts.analysis_status|analysis_error|analysis_attempts|analyzed_at`, `screenplay_versions.pattern_snapshot`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260825090000_broadcast_speech_analyses.sql`:

```sql
-- 2026-08-25: broadcast selling-language corpus
-- Spec: docs/superpowers/specs/2026-08-24-broadcast-selling-language-design.md

BEGIN;

-- 1) Analysis queue on broadcasts, mirroring the video_status queue pattern.
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS analysis_status   text NOT NULL DEFAULT 'pending'
    CHECK (analysis_status IN ('pending','queued','running','done','failed','skipped')),
  ADD COLUMN IF NOT EXISTS analysis_error    text,
  ADD COLUMN IF NOT EXISTS analysis_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS analyzed_at       timestamptz;

CREATE INDEX IF NOT EXISTS broadcasts_analysis_queue_idx
  ON broadcasts (analysis_status, air_date DESC)
  WHERE archived_video_s3 IS NOT NULL;

-- 2) Verbatim transcript. Group B — admin read only. Never joined into a
--    member-facing path; exists for verification and re-analysis.
CREATE TABLE IF NOT EXISTS broadcast_transcripts (
  broadcast_id   uuid PRIMARY KEY REFERENCES broadcasts(id) ON DELETE CASCADE,
  segments       jsonb NOT NULL,
  language       text  NOT NULL DEFAULT 'ja',
  model          text  NOT NULL,
  schema_version int   NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE broadcast_transcripts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS broadcast_transcripts_select ON broadcast_transcripts;
CREATE POLICY broadcast_transcripts_select
  ON broadcast_transcripts FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- 3) Structural patterns only. Group A — member/admin read.
--    NOTE: deliberately has no product-name, price or free-text column.
CREATE TABLE IF NOT EXISTS broadcast_speech_analyses (
  broadcast_id        uuid PRIMARY KEY REFERENCES broadcasts(id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('qvc','shopch')),
  air_date            date NOT NULL,
  category            text,
  duration_sec        int  NOT NULL CHECK (duration_sec > 0),
  segments            jsonb NOT NULL,
  selling_points      jsonb NOT NULL,
  evidence_cues       jsonb NOT NULL,
  objection_handlings jsonb NOT NULL,
  offer_timeline      jsonb NOT NULL,
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
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('member','admin'))
  );

-- 4) Reproducibility: which aggregate shaped this screenplay version.
ALTER TABLE screenplay_versions
  ADD COLUMN IF NOT EXISTS pattern_snapshot jsonb;

COMMIT;
```

- [ ] **Step 2: Apply it**

Run: `npx tsx --env-file=.env.local scripts/apply-sql-file.ts supabase/migrations/20260825090000_broadcast_speech_analyses.sql`

Expected: `[apply] connecting to pooler...` then a success line. Requires `SUPABASE_DB_PASSWORD` in `.env.local`.

- [ ] **Step 3: Add the new tables to the migration check**

In `scripts/check-migrations.ts`, add to `REQUIRED_TABLES` (after `"broadcast_products",`):

```ts
	"broadcast_transcripts",
	"broadcast_speech_analyses",
```

- [ ] **Step 4: Verify**

Run: `npm run test:migrations`
Expected: PASS, listing the two new tables as present.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260825090000_broadcast_speech_analyses.sql scripts/check-migrations.ts
git commit -m "feat(broadcast-intel): schema for the selling-language corpus

Transcripts land in an admin-RLS table; the member-readable pattern table
has no column that can hold a product name or figure, so 'structure only'
is enforced by the schema rather than by convention."
```

---

## Task 2: Pure schema module

**Files:**
- Create: `lib/broadcast-intel/schema.ts`
- Create: `scripts/test-broadcast-intel-schema.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `ACT_TYPES`, `POINT_TYPES`, `EVIDENCE_TYPES`, `OBJECTION_TYPES`, `ANALYSIS_RESPONSE_SCHEMA`, `SCHEMA_VERSION`, types `ActType`, `PointType`, `EvidenceType`, `ObjectionType`, `BroadcastAnalysis`, `TranscriptSegment`, and `parseAnalysisResponse(raw: unknown, durationSec: number): BroadcastAnalysis`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-broadcast-intel-schema.ts`:

```ts
import assert from "node:assert/strict";
import {
	ACT_TYPES,
	ANALYSIS_RESPONSE_SCHEMA,
	EVIDENCE_TYPES,
	OBJECTION_TYPES,
	POINT_TYPES,
	parseAnalysisResponse,
} from "../lib/broadcast-intel/schema";

// The Gemini schema and the TS enums must not drift: a value the model is
// allowed to return but the aggregator does not know about is a silent
// category of lost data.
const schemaEnum = (path: string[]): string[] => {
	let node: Record<string, unknown> = ANALYSIS_RESPONSE_SCHEMA as Record<string, unknown>;
	for (const key of path) node = (node as Record<string, Record<string, unknown>>)[key];
	return node.enum as unknown as string[];
};

assert.deepEqual(schemaEnum(["properties", "segments", "items", "properties", "act_type"]), [...ACT_TYPES]);
assert.deepEqual(schemaEnum(["properties", "selling_points", "items", "properties", "point_type"]), [...POINT_TYPES]);
assert.deepEqual(schemaEnum(["properties", "evidence_cues", "items", "properties", "type"]), [...EVIDENCE_TYPES]);
assert.deepEqual(schemaEnum(["properties", "objection_handlings", "items", "properties", "objection_type"]), [...OBJECTION_TYPES]);

const good = {
	transcript: [{ start_sec: 0, end_sec: 12, speaker_hint: "host", text_ja: "こんにちは" }],
	segments: [{ start_sec: 0, end_sec: 120, act_type: "opening", summary_ja: "導入" }],
	selling_points: [{ order: 1, point_type: "efficacy", first_mentioned_sec: 130, repeat_count: 4 }],
	evidence_cues: [{ type: "demo", at_sec: 300 }],
	objection_handlings: [{ objection_type: "price", at_sec: 900 }],
	offer_timeline: { first_price_sec: 940, cta_secs: [960, 1200], urgency_cues: ["残りわずか"] },
};

const parsed = parseAnalysisResponse(good, 1500);
assert.equal(parsed.segments[0].actType, "opening");
assert.equal(parsed.sellingPoints[0].pointType, "efficacy");
assert.equal(parsed.offerTimeline.firstPriceSec, 940);
assert.equal(parsed.transcript[0].textJa, "こんにちは");

// An unknown enum value is dropped, not silently coerced to a known one.
const withJunk = { ...good, evidence_cues: [{ type: "telepathy", at_sec: 10 }, { type: "demo", at_sec: 20 }] };
assert.deepEqual(parseAnalysisResponse(withJunk, 1500).evidenceCues, [{ type: "demo", atSec: 20 }]);

// A cue past the runtime is impossible and must be dropped.
const pastEnd = { ...good, evidence_cues: [{ type: "demo", at_sec: 9999 }] };
assert.deepEqual(parseAnalysisResponse(pastEnd, 1500).evidenceCues, []);

// A malformed payload throws rather than yielding a half-built record.
assert.throws(() => parseAnalysisResponse({ segments: "nope" }, 1500), /segments/);

console.log("PASS: broadcast-intel schema");
```

- [ ] **Step 2: Run it and observe RED**

Run: `npx tsx scripts/test-broadcast-intel-schema.ts`
Expected: failure — `Cannot find module '../lib/broadcast-intel/schema'`.

- [ ] **Step 3: Implement**

Create `lib/broadcast-intel/schema.ts`:

```ts
/**
 * Enums, Gemini response schema and validated result types for the broadcast
 * selling-language corpus.
 *
 * Single source of truth: the Gemini structured-output schema is generated
 * FROM the same const arrays the aggregator switches on, so the model can
 * never return a value the aggregator silently discards.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */

export const SCHEMA_VERSION = 1;

export const ACT_TYPES = [
	"opening", "problem", "product_intro", "demo", "evidence",
	"testimonial", "offer", "cta", "closing",
] as const;

export const POINT_TYPES = [
	"efficacy", "ease_of_use", "price_value", "safety", "size_fit",
	"durability", "design", "aftercare", "scarcity",
] as const;

export const EVIDENCE_TYPES = [
	"lab_test", "demo", "comparison", "testimonial", "expert", "certification",
] as const;

export const OBJECTION_TYPES = [
	"price", "doubt_efficacy", "difficulty", "space", "maintenance", "timing",
] as const;

export type ActType = (typeof ACT_TYPES)[number];
export type PointType = (typeof POINT_TYPES)[number];
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
export type ObjectionType = (typeof OBJECTION_TYPES)[number];

export interface TranscriptSegment {
	startSec: number;
	endSec: number;
	speakerHint: string | null;
	textJa: string;
}

export interface BroadcastAnalysis {
	transcript: TranscriptSegment[];
	segments: Array<{ startSec: number; endSec: number; actType: ActType; summaryJa: string }>;
	sellingPoints: Array<{ order: number; pointType: PointType; firstMentionedSec: number; repeatCount: number }>;
	evidenceCues: Array<{ type: EvidenceType; atSec: number }>;
	objectionHandlings: Array<{ objectionType: ObjectionType; atSec: number }>;
	offerTimeline: { firstPriceSec: number | null; ctaSecs: number[]; urgencyCues: string[] };
}

export const ANALYSIS_RESPONSE_SCHEMA = {
	type: "object",
	required: ["transcript", "segments", "selling_points", "evidence_cues", "objection_handlings", "offer_timeline"],
	properties: {
		transcript: {
			type: "array",
			items: {
				type: "object",
				required: ["start_sec", "end_sec", "text_ja"],
				properties: {
					start_sec: { type: "number" },
					end_sec: { type: "number" },
					speaker_hint: { type: "string" },
					text_ja: { type: "string" },
				},
			},
		},
		segments: {
			type: "array",
			items: {
				type: "object",
				required: ["start_sec", "end_sec", "act_type", "summary_ja"],
				properties: {
					start_sec: { type: "number" },
					end_sec: { type: "number" },
					act_type: { type: "string", enum: [...ACT_TYPES] },
					summary_ja: { type: "string" },
				},
			},
		},
		selling_points: {
			type: "array",
			items: {
				type: "object",
				required: ["order", "point_type", "first_mentioned_sec", "repeat_count"],
				properties: {
					order: { type: "number" },
					point_type: { type: "string", enum: [...POINT_TYPES] },
					first_mentioned_sec: { type: "number" },
					repeat_count: { type: "number" },
				},
			},
		},
		evidence_cues: {
			type: "array",
			items: {
				type: "object",
				required: ["type", "at_sec"],
				properties: {
					type: { type: "string", enum: [...EVIDENCE_TYPES] },
					at_sec: { type: "number" },
				},
			},
		},
		objection_handlings: {
			type: "array",
			items: {
				type: "object",
				required: ["objection_type", "at_sec"],
				properties: {
					objection_type: { type: "string", enum: [...OBJECTION_TYPES] },
					at_sec: { type: "number" },
				},
			},
		},
		offer_timeline: {
			type: "object",
			required: ["cta_secs", "urgency_cues"],
			properties: {
				first_price_sec: { type: "number" },
				cta_secs: { type: "array", items: { type: "number" } },
				urgency_cues: { type: "array", items: { type: "string" } },
			},
		},
	},
} as const;

function arr(value: unknown, field: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`broadcast-intel: ${field} must be an array`);
	return value;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Coerce a raw Gemini payload into the validated shape.
 *  Unknown enum members and out-of-range timecodes are DROPPED, never guessed:
 *  a wrong act label distorts the aggregate more than a missing one. */
export function parseAnalysisResponse(raw: unknown, durationSec: number): BroadcastAnalysis {
	const r = (raw ?? {}) as Record<string, unknown>;
	const inRange = (v: number | null): v is number => v !== null && v >= 0 && v <= durationSec;

	const acts = new Set<string>(ACT_TYPES);
	const points = new Set<string>(POINT_TYPES);
	const evidence = new Set<string>(EVIDENCE_TYPES);
	const objections = new Set<string>(OBJECTION_TYPES);

	const transcript: TranscriptSegment[] = arr(r.transcript, "transcript").flatMap((row) => {
		const o = row as Record<string, unknown>;
		const start = num(o.start_sec);
		const end = num(o.end_sec);
		if (!inRange(start) || end === null || typeof o.text_ja !== "string") return [];
		return [{
			startSec: start,
			endSec: end,
			speakerHint: typeof o.speaker_hint === "string" ? o.speaker_hint : null,
			textJa: o.text_ja,
		}];
	});

	const segments = arr(r.segments, "segments").flatMap((row) => {
		const o = row as Record<string, unknown>;
		const start = num(o.start_sec);
		const end = num(o.end_sec);
		if (!inRange(start) || !inRange(end) || typeof o.act_type !== "string") return [];
		if (!acts.has(o.act_type)) return [];
		return [{
			startSec: start,
			endSec: end,
			actType: o.act_type as ActType,
			summaryJa: typeof o.summary_ja === "string" ? o.summary_ja : "",
		}];
	});

	const sellingPoints = arr(r.selling_points, "selling_points").flatMap((row) => {
		const o = row as Record<string, unknown>;
		const first = num(o.first_mentioned_sec);
		if (!inRange(first) || typeof o.point_type !== "string" || !points.has(o.point_type)) return [];
		return [{
			order: num(o.order) ?? 0,
			pointType: o.point_type as PointType,
			firstMentionedSec: first,
			repeatCount: Math.max(1, Math.round(num(o.repeat_count) ?? 1)),
		}];
	});

	const evidenceCues = arr(r.evidence_cues, "evidence_cues").flatMap((row) => {
		const o = row as Record<string, unknown>;
		const at = num(o.at_sec);
		if (!inRange(at) || typeof o.type !== "string" || !evidence.has(o.type)) return [];
		return [{ type: o.type as EvidenceType, atSec: at }];
	});

	const objectionHandlings = arr(r.objection_handlings, "objection_handlings").flatMap((row) => {
		const o = row as Record<string, unknown>;
		const at = num(o.at_sec);
		if (!inRange(at) || typeof o.objection_type !== "string" || !objections.has(o.objection_type)) return [];
		return [{ objectionType: o.objection_type as ObjectionType, atSec: at }];
	});

	const offer = (r.offer_timeline ?? {}) as Record<string, unknown>;
	const firstPrice = num(offer.first_price_sec);
	const offerTimeline = {
		firstPriceSec: inRange(firstPrice) ? firstPrice : null,
		ctaSecs: (Array.isArray(offer.cta_secs) ? offer.cta_secs : [])
			.map(num).filter(inRange),
		urgencyCues: (Array.isArray(offer.urgency_cues) ? offer.urgency_cues : [])
			.filter((v): v is string => typeof v === "string"),
	};

	return { transcript, segments, sellingPoints, evidenceCues, objectionHandlings, offerTimeline };
}
```

- [ ] **Step 4: Run the test and observe GREEN**

Run: `npx tsx scripts/test-broadcast-intel-schema.ts`
Expected: `PASS: broadcast-intel schema`

- [ ] **Step 5: Add the alias**

In `package.json` scripts, after `"test:discovery-cron-budget"`:

```json
    "test:broadcast-intel-schema": "tsx scripts/test-broadcast-intel-schema.ts",
```

- [ ] **Step 6: Commit**

```bash
git add lib/broadcast-intel/schema.ts scripts/test-broadcast-intel-schema.ts package.json
git commit -m "feat(broadcast-intel): enums, Gemini schema and response parser

The structured-output enums are generated from the same const arrays the
aggregator switches on, so the model cannot return a label that would be
silently discarded downstream. Unknown labels and out-of-range timecodes
are dropped rather than guessed."
```

---

## Task 3: Audio extraction

**Files:**
- Create: `lib/broadcast-intel/audio-extract.ts`
- Modify: `scripts/test-broadcast-intel-schema.ts` (no) — instead extend `package.json` only
- Test: covered by Task 12's live smoke; the pure part is tested here

**Interfaces:**
- Consumes: `parseDurationFromStderr` from `lib/broadcasts/video-archival.ts`.
- Produces: `buildAudioFfmpegArgs(): string[]`, `extractAudio(s3Key: string): Promise<{ audio: Buffer; durationSec: number }>`, `AUDIO_MIME = "audio/mp4"`.

- [ ] **Step 1: Write the failing test**

Add this import to the TOP of `scripts/test-broadcast-intel-schema.ts`, with the other imports (ESLint's `import/first` rejects a mid-file import):

```ts
import { buildAudioFfmpegArgs } from "../lib/broadcast-intel/audio-extract";
```

Then append the assertions above the final `console.log`:

```ts
const args = buildAudioFfmpegArgs();
// Video must be dropped (-vn) or we pay for pixels we never send to Gemini,
// and the audio must be mono 16 kHz to keep the upload small.
assert.ok(args.includes("-vn"), "audio extraction must drop the video stream");
assert.deepEqual(args.slice(args.indexOf("-ac"), args.indexOf("-ac") + 2), ["-ac", "1"]);
assert.deepEqual(args.slice(args.indexOf("-ar"), args.indexOf("-ar") + 2), ["-ar", "16000"]);
assert.equal(args.at(-1), "pipe:1", "ffmpeg must write to stdout");
assert.equal(args[args.indexOf("-i") + 1], "pipe:0", "ffmpeg must read the S3 stream from stdin");
```

- [ ] **Step 2: Run it and observe RED**

Run: `npx tsx scripts/test-broadcast-intel-schema.ts`
Expected: failure — `Cannot find module '../lib/broadcast-intel/audio-extract'`.

- [ ] **Step 3: Implement**

Create `lib/broadcast-intel/audio-extract.ts`:

```ts
/**
 * Archived MP4 (S3) → mono 16 kHz AAC audio buffer + exact runtime.
 *
 * Why the runtime is taken here: broadcasts.video_duration_sec is null on all
 * archived rows because the archival pass parses ffmpeg's stderr while reading
 * a LIVE m3u8, which prints `Duration: N/A`. The stored MP4 has a real
 * duration, so this pass is the first place the value can actually be learned.
 *
 * NO `import "server-only"` — imported by tsx smoke scripts.
 */
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getVideoStorageClient } from "@/lib/broadcasts/video-storage";
import { parseDurationFromStderr } from "@/lib/broadcasts/video-archival";

export const AUDIO_MIME = "audio/mp4";

/** Mono 16 kHz AAC is the smallest form Gemini still transcribes reliably.
 *  A 25-minute slot lands around 6 MB, against 606 MB for the source MP4. */
export function buildAudioFfmpegArgs(): string[] {
	return [
		"-hide_banner",
		"-loglevel", "info",   // `info` so the Duration line reaches stderr
		"-i", "pipe:0",
		"-vn",
		"-ac", "1",
		"-ar", "16000",
		"-c:a", "aac",
		"-b:a", "32k",
		"-movflags", "frag_keyframe+empty_moov",
		"-f", "mp4",
		"pipe:1",
	];
}

export async function extractAudio(
	s3Key: string,
): Promise<{ audio: Buffer; durationSec: number }> {
	const bucket = process.env.VIDEO_ARCHIVE_AWS_BUCKET;
	if (!bucket) throw new Error("Missing required env var: VIDEO_ARCHIVE_AWS_BUCKET");

	const object = await getVideoStorageClient().send(
		new GetObjectCommand({ Bucket: bucket, Key: s3Key }),
	);
	const source = object.Body as Readable | undefined;
	if (!source) throw new Error(`S3 object has no body: ${s3Key}`);

	const proc = spawn(ffmpegInstaller.path, buildAudioFfmpegArgs(), {
		stdio: ["pipe", "pipe", "pipe"],
	});

	const stderrChunks: string[] = [];
	proc.stderr.on("data", (c: Buffer) => stderrChunks.push(c.toString("utf-8")));

	const audioChunks: Buffer[] = [];
	proc.stdout.on("data", (c: Buffer) => audioChunks.push(c));

	// EPIPE is expected if ffmpeg exits before the whole MP4 is written.
	source.on("error", () => proc.kill("SIGKILL"));
	proc.stdin.on("error", () => {});
	source.pipe(proc.stdin);

	const code = await new Promise<number | null>((resolve) =>
		proc.on("close", resolve),
	);
	const stderr = stderrChunks.join("");
	if (code !== 0) {
		throw new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`);
	}

	const durationSec = parseDurationFromStderr(stderr);
	if (durationSec === null || durationSec <= 0) {
		// A pattern without a runtime cannot be normalised, so it is worthless
		// to the aggregate. Fail loudly rather than store an unusable row.
		throw new Error(`could not determine runtime for ${s3Key}`);
	}

	return { audio: Buffer.concat(audioChunks), durationSec };
}
```

- [ ] **Step 4: Run the test and observe GREEN**

Run: `npx tsx scripts/test-broadcast-intel-schema.ts`
Expected: `PASS: broadcast-intel schema`

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/broadcast-intel/audio-extract.ts scripts/test-broadcast-intel-schema.ts
git commit -m "feat(broadcast-intel): S3 MP4 to mono audio, with the real runtime

Also the first place video_duration_sec can be learned: the archival pass
reads a live m3u8, which reports Duration: N/A, which is why the column is
null on all 5,019 archived rows. Refuse to store an analysis with no
runtime — it cannot be normalised into the aggregate."
```

---

## Task 4: Gemini analysis call

**Files:**
- Create: `lib/broadcast-intel/gemini-analyze.ts`

**Interfaces:**
- Consumes: `ANALYSIS_RESPONSE_SCHEMA`, `parseAnalysisResponse`, `BroadcastAnalysis` from `./schema`; `AUDIO_MIME` from `./audio-extract`; `GEMINI_FLASH` from `@/lib/gemini-models`.
- Produces: `analyzeAudio(audio: Buffer, durationSec: number): Promise<{ analysis: BroadcastAnalysis; model: string }>`, `ANALYSIS_PROMPT`.

- [ ] **Step 1: Implement**

Create `lib/broadcast-intel/gemini-analyze.ts`:

```ts
/**
 * Mono audio → structured broadcast analysis via Gemini.
 *
 * The prompt asks only for structure and a transcript. It never asks the model
 * to judge, rank or rewrite the competitor's selling copy — the corpus is
 * evidence, and the abstraction happens later in category-pattern.ts.
 *
 * NO `import "server-only"` — imported by tsx smoke scripts.
 */
import { GoogleGenAI, createPartFromUri, createUserContent } from "@google/genai";
import { GEMINI_FLASH } from "@/lib/gemini-models";
import { AUDIO_MIME } from "./audio-extract";
import { ANALYSIS_RESPONSE_SCHEMA, parseAnalysisResponse, type BroadcastAnalysis } from "./schema";

let _genAI: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
	if (!_genAI) _genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
	return _genAI;
}

export const ANALYSIS_PROMPT = [
	"これは日本のテレビショッピング番組の音声です。",
	"番組の構成と話法を、後の統計処理のために構造化データとして書き出してください。",
	"",
	"- transcript: 発話をタイムコード付きで文字起こしする。要約や言い換えをしない。",
	"- segments: 番組全体を act_type で区切る。全区間を隙間なく覆うこと。",
	"- selling_points: 販売ポイントを提示された順に並べ、初出秒と反復回数を記録する。",
	"- evidence_cues: 主張の裏づけとして提示された手段と、その時刻。",
	"- objection_handlings: 視聴者の懸念に応えた箇所と、その懸念の型。",
	"- offer_timeline: 価格が最初に提示された秒、CTA の各時刻、緊急性を煽る表現。",
	"",
	"推測で埋めないこと。音声に無いものは配列を空にする。",
	"すべての秒数は番組先頭からの経過秒とする。",
].join("\n");

const UPLOAD_POLL_INTERVAL_MS = 2_000;
const UPLOAD_TIMEOUT_MS = 120_000;

export async function analyzeAudio(
	audio: Buffer,
	durationSec: number,
): Promise<{ analysis: BroadcastAnalysis; model: string }> {
	const ai = getGenAI();

	let file = await ai.files.upload({
		file: new Blob([new Uint8Array(audio)], { type: AUDIO_MIME }),
		config: { mimeType: AUDIO_MIME },
	});

	// The Files API returns PROCESSING first; a part referencing a non-ACTIVE
	// file is rejected, so poll until it settles.
	const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
	while (file.state === "PROCESSING") {
		if (Date.now() > deadline) throw new Error("Gemini file upload stuck in PROCESSING");
		await new Promise((r) => setTimeout(r, UPLOAD_POLL_INTERVAL_MS));
		file = await ai.files.get({ name: file.name! });
	}
	if (file.state === "FAILED") throw new Error("Gemini file upload failed");

	try {
		const response = await ai.models.generateContent({
			model: GEMINI_FLASH,
			contents: createUserContent([
				createPartFromUri(file.uri!, file.mimeType!),
				ANALYSIS_PROMPT,
			]),
			config: {
				responseMimeType: "application/json",
				responseSchema: ANALYSIS_RESPONSE_SCHEMA,
			},
		});

		const text = response.text;
		if (!text) throw new Error("Gemini returned an empty analysis");
		return {
			analysis: parseAnalysisResponse(JSON.parse(text), durationSec),
			model: GEMINI_FLASH,
		};
	} finally {
		// Uploaded files expire after 48h anyway; deleting keeps the quota clean
		// and must never mask a real analysis error.
		try {
			await ai.files.delete({ name: file.name! });
		} catch {
			/* best effort */
		}
	}
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0. If `createPartFromUri` / `createUserContent` are not exported by the installed `@google/genai`, check the version with `npm ls @google/genai` and use `{ fileData: { fileUri: file.uri, mimeType: file.mimeType } }` parts inline instead.

- [ ] **Step 3: Commit**

```bash
git add lib/broadcast-intel/gemini-analyze.ts
git commit -m "feat(broadcast-intel): structured audio analysis via Gemini Files API

The prompt asks for structure and a verbatim transcript only. It never asks
the model to judge or rewrite competitor copy; abstraction is the
aggregator's job, so the stored evidence stays auditable."
```

---

## Task 5: Persistence and single-slot orchestration

**Files:**
- Create: `lib/broadcast-intel/persist.ts`
- Create: `lib/broadcast-intel/analyze-one.ts`

**Interfaces:**
- Consumes: `extractAudio`, `analyzeAudio`, `BroadcastAnalysis`, `SCHEMA_VERSION`.
- Produces: `QueuedAnalysisSlot`, `AnalyzeResult`, `persistAnalysis(...)`, `analyzeOne(slot): Promise<AnalyzeResult>`, `MAX_ATTEMPTS`.

- [ ] **Step 1: Implement persistence**

Create `lib/broadcast-intel/persist.ts`:

```ts
/**
 * Writes one analysis to both tables.
 *
 * The split is the enforcement of the structure-only policy: verbatim text
 * goes to broadcast_transcripts (admin RLS), and only abstractions go to
 * broadcast_speech_analyses (member-readable, and the only table any prompt
 * path may read).
 */
import { getServiceClient } from "@/lib/supabase";
import { SCHEMA_VERSION, type BroadcastAnalysis } from "./schema";

export interface PersistInput {
	broadcastId: string;
	channel: "qvc" | "shopch";
	airDate: string;
	category: string | null;
	durationSec: number;
	analysis: BroadcastAnalysis;
	model: string;
}

export async function persistAnalysis(input: PersistInput): Promise<void> {
	const sb = getServiceClient();
	const { analysis } = input;

	const { error: transcriptErr } = await sb.from("broadcast_transcripts").upsert({
		broadcast_id: input.broadcastId,
		segments: analysis.transcript,
		language: "ja",
		model: input.model,
		schema_version: SCHEMA_VERSION,
	});
	if (transcriptErr) throw new Error(`transcript upsert failed: ${transcriptErr.message}`);

	const { error: analysisErr } = await sb.from("broadcast_speech_analyses").upsert({
		broadcast_id: input.broadcastId,
		channel: input.channel,
		air_date: input.airDate,
		category: input.category,
		duration_sec: input.durationSec,
		segments: analysis.segments,
		selling_points: analysis.sellingPoints,
		evidence_cues: analysis.evidenceCues,
		objection_handlings: analysis.objectionHandlings,
		offer_timeline: analysis.offerTimeline,
		model: input.model,
		schema_version: SCHEMA_VERSION,
	});
	if (analysisErr) throw new Error(`analysis upsert failed: ${analysisErr.message}`);
}
```

- [ ] **Step 2: Implement the worker**

Create `lib/broadcast-intel/analyze-one.ts`:

```ts
/**
 * Single-slot analysis job, modelled on lib/broadcasts/video-archival.ts.
 *
 * Failure model: any throw rolls the slot back to `queued` with an incremented
 * attempt count. At attempts >= MAX_ATTEMPTS the status becomes `failed` and
 * the row stops being retried.
 */
import { getServiceClient } from "@/lib/supabase";
import { extractAudio } from "./audio-extract";
import { analyzeAudio } from "./gemini-analyze";
import { persistAnalysis } from "./persist";

export const MAX_ATTEMPTS = Number(process.env.BROADCAST_INTEL_MAX_ATTEMPTS) || 3;

export interface QueuedAnalysisSlot {
	id: string;
	channel: "qvc" | "shopch";
	air_date: string;
	category: string | null;
	archived_video_s3: string | null;
	analysis_attempts: number;
}

export interface AnalyzeResult {
	broadcastId: string;
	status: "done" | "queued" | "failed" | "skipped";
	durationSec?: number;
	error?: string;
}

export async function analyzeOne(slot: QueuedAnalysisSlot): Promise<AnalyzeResult> {
	const sb = getServiceClient();
	const broadcastId = slot.id;

	// Claim so a parallel drain does not double-spend a Gemini call.
	const { data: claimed, error: claimErr } = await sb
		.from("broadcasts")
		.update({ analysis_status: "running" })
		.eq("id", broadcastId)
		.eq("analysis_status", "queued")
		.select("id");
	if (claimErr) return { broadcastId, status: "queued", error: claimErr.message };
	if (!claimed || claimed.length === 0) {
		return { broadcastId, status: "queued", error: "claim lost: slot was no longer queued" };
	}

	if (!slot.archived_video_s3 || !slot.category) {
		const reason = !slot.archived_video_s3 ? "no archived video" : "no category to aggregate under";
		await sb.from("broadcasts")
			.update({ analysis_status: "skipped", analysis_error: reason })
			.eq("id", broadcastId).eq("analysis_status", "running");
		return { broadcastId, status: "skipped", error: reason };
	}

	try {
		const { audio, durationSec } = await extractAudio(slot.archived_video_s3);
		const { analysis, model } = await analyzeAudio(audio, durationSec);

		await persistAnalysis({
			broadcastId,
			channel: slot.channel,
			airDate: slot.air_date,
			category: slot.category,
			durationSec,
			analysis,
			model,
		});

		// Backfill the runtime the archival pass could never learn.
		const { error: updateErr } = await sb.from("broadcasts").update({
			analysis_status: "done",
			analysis_error: null,
			analyzed_at: new Date().toISOString(),
			video_duration_sec: durationSec,
		}).eq("id", broadcastId).eq("analysis_status", "running");
		if (updateErr) return { broadcastId, status: "queued", error: updateErr.message };

		return { broadcastId, status: "done", durationSec };
	} catch (e) {
		const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
		const attempts = (slot.analysis_attempts ?? 0) + 1;
		const finalStatus = attempts >= MAX_ATTEMPTS ? "failed" : "queued";
		await sb.from("broadcasts").update({
			analysis_status: finalStatus,
			analysis_attempts: attempts,
			analysis_error: msg,
		}).eq("id", broadcastId).eq("analysis_status", "running");
		return { broadcastId, status: finalStatus === "failed" ? "failed" : "queued", error: msg };
	}
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add lib/broadcast-intel/persist.ts lib/broadcast-intel/analyze-one.ts
git commit -m "feat(broadcast-intel): persistence and the single-slot worker

Claim-then-run mirrors archiveOne so two drains cannot double-spend a
Gemini call on the same slot. A slot with no category is skipped rather
than analysed: the aggregate has nowhere to put it."
```

---

## Task 6: Queue seeding, cron and drain script

**Files:**
- Create: `lib/broadcast-intel/queue.ts`
- Create: `app/api/cron/analyze-broadcast-audio/route.ts`
- Create: `scripts/drain-broadcast-analysis.ts`
- Modify: `package.json`, `vercel.json`, `.env.example`

**Interfaces:**
- Consumes: `analyzeOne`, `QueuedAnalysisSlot`, `AnalyzeResult`, `MAX_ATTEMPTS`; `CATEGORIES_BY_CHANNEL` from `@/lib/broadcasts/whitelist-gate`.
- Produces: `seedAnalysisQueue(limit: number): Promise<number>` from `lib/broadcast-intel/queue.ts`.

- [ ] **Step 1: Implement queue seeding**

Seeding lives in `lib/` rather than in the route so the drain script does not
have to import a Next route module (and with it `next/server`) just to reuse
one query.

Create `lib/broadcast-intel/queue.ts`:

```ts
/**
 * Promotes archived, whitelist-category slots from 'pending' to 'queued'.
 *
 * NOTE the difference from the display gate isWhitelistedSlot(), which is
 * fail-OPEN and shows an uncategorised slot. Here a null category means the
 * analysis could never be attributed to a category aggregate, so the slot is
 * left 'pending' and picked up later once enrichment fills the category in.
 *
 * NO `import "server-only"` — imported by the drain script under tsx.
 */
import { getServiceClient } from "@/lib/supabase";
import { CATEGORIES_BY_CHANNEL } from "@/lib/broadcasts/whitelist-gate";

export async function seedAnalysisQueue(limit: number): Promise<number> {
	const sb = getServiceClient();
	let promoted = 0;

	for (const channel of ["qvc", "shopch"] as const) {
		const remaining = limit - promoted;
		if (remaining <= 0) break;

		const { data, error } = await sb
			.from("broadcasts")
			.update({ analysis_status: "queued" })
			.eq("analysis_status", "pending")
			.eq("channel", channel)
			.not("archived_video_s3", "is", null)
			.in("category", [...CATEGORIES_BY_CHANNEL[channel]])
			.select("id")
			.limit(remaining);

		if (error) throw new Error(`seed failed for ${channel}: ${error.message}`);
		promoted += data?.length ?? 0;
	}
	return promoted;
}
```

- [ ] **Step 2: Implement the cron**

Create `app/api/cron/analyze-broadcast-audio/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { seedAnalysisQueue } from "@/lib/broadcast-intel/queue";
import {
  analyzeOne,
  MAX_ATTEMPTS,
  type AnalyzeResult,
  type QueuedAnalysisSlot,
} from "@/lib/broadcast-intel/analyze-one";

export const maxDuration = 300;

function verifyCronAuth(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev mode
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

async function pBoundedAll<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function runWorker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runWorker),
  );
  return results;
}

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sb = getServiceClient();
  const BUDGET_MS = 240_000;
  const BATCH_SIZE = 4;
  const MAX_BATCHES = 50;
  const CONCURRENCY = Number(process.env.BROADCAST_INTEL_BATCH_CONCURRENCY) || 2;
  const startedAt = Date.now();

  const summary = { seeded: 0, processed: 0, done: 0, queued: 0, failed: 0, skipped: 0, batches: 0 };

  try {
    summary.seeded = await seedAnalysisQueue(50);
  } catch (err) {
    console.warn("[analyze-broadcast-audio] seed failed:", err);
  }

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    if (Date.now() - startedAt >= BUDGET_MS) break;

    const { data: slots, error } = await sb
      .from("broadcasts")
      .select("id, channel, air_date, category, archived_video_s3, analysis_attempts")
      .eq("analysis_status", "queued")
      .lt("analysis_attempts", MAX_ATTEMPTS)
      .order("air_date", { ascending: false })
      .limit(BATCH_SIZE);

    if (error) return NextResponse.json({ error: error.message, ...summary }, { status: 500 });

    const queued = (slots ?? []) as QueuedAnalysisSlot[];
    if (queued.length === 0) break;

    const results: AnalyzeResult[] = await pBoundedAll(queued, CONCURRENCY, analyzeOne);
    summary.batches++;
    for (const r of results) {
      summary.processed++;
      summary[r.status] += 1;
    }
  }

  return NextResponse.json({ ok: true, ...summary, duration_ms: Date.now() - startedAt });
}
```

- [ ] **Step 3: Implement the drain script**

Create `scripts/drain-broadcast-analysis.ts`:

```ts
/**
 * Local drain for the broadcast analysis queue.
 * Usage: npm run drain:broadcast-analysis -- --limit=40 --category=家電
 *
 * Mirrors scripts/drain-archive-queue.ts. Used for the initial backfill batch,
 * which is far larger than one cron window can absorb.
 */
import { getServiceClient } from "@/lib/supabase";
import { analyzeOne, MAX_ATTEMPTS, type QueuedAnalysisSlot } from "@/lib/broadcast-intel/analyze-one";
import { seedAnalysisQueue } from "@/lib/broadcast-intel/queue";

function flag(name: string): string | undefined {
	return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main(): Promise<void> {
	const limit = Number(flag("limit") ?? 40);
	const category = flag("category") ?? null;
	const concurrency = Number(process.env.BROADCAST_INTEL_BATCH_CONCURRENCY) || 2;
	const sb = getServiceClient();

	const seeded = await seedAnalysisQueue(limit);
	console.log(`[drain] seeded ${seeded} slot(s) into the queue`);

	let done = 0, failed = 0, skipped = 0, processed = 0;

	while (processed < limit) {
		let q = sb
			.from("broadcasts")
			.select("id, channel, air_date, category, archived_video_s3, analysis_attempts")
			.eq("analysis_status", "queued")
			.lt("analysis_attempts", MAX_ATTEMPTS)
			.order("air_date", { ascending: false })
			.limit(Math.min(concurrency, limit - processed));
		if (category) q = q.eq("category", category);

		const { data, error } = await q;
		if (error) throw new Error(error.message);
		const slots = (data ?? []) as QueuedAnalysisSlot[];
		if (slots.length === 0) break;

		const results = await Promise.all(slots.map(analyzeOne));
		for (const r of results) {
			processed++;
			if (r.status === "done") done++;
			else if (r.status === "failed") failed++;
			else if (r.status === "skipped") skipped++;
			console.log(`  ${r.status.padEnd(8)} ${r.broadcastId}${r.error ? ` — ${r.error}` : ""}`);
		}
	}

	console.log(`\n[drain] processed=${processed} done=${done} failed=${failed} skipped=${skipped}`);
}

main();
```

- [ ] **Step 4: Register the script alias**

In `package.json` scripts, next to `"drain:archive-queue"`:

```json
    "drain:broadcast-analysis": "tsx --env-file=.env.local scripts/drain-broadcast-analysis.ts",
```

- [ ] **Step 5: Document the env knobs**

Append to `.env.example`:

```bash
# Broadcast selling-language corpus (docs/superpowers/specs/2026-08-24-broadcast-selling-language-design.md)
BROADCAST_INTEL_ENABLED=false              # inject the competitor structure block into screenplay prompts
PATTERN_MIN_SAMPLES=5                      # fail-closed floor for the category aggregate
BROADCAST_INTEL_BATCH_CONCURRENCY=2        # parallel slots per drain batch
BROADCAST_INTEL_MAX_ATTEMPTS=3             # attempts before a slot is marked failed
```

- [ ] **Step 6: Register the cron**

In `vercel.json`, add to `crons` (JST 05:00 = UTC 20:00 — clear of `archive-videos` on `0 */2` even hours):

```json
    { "path": "/api/cron/analyze-broadcast-audio", "schedule": "0 20 * * *" }
```

and to `functions`:

```json
    "app/api/cron/analyze-broadcast-audio/route.ts": { "maxDuration": 300 }
```

- [ ] **Step 7: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint lib/broadcast-intel/queue.ts app/api/cron/analyze-broadcast-audio/route.ts scripts/drain-broadcast-analysis.ts`
Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add lib/broadcast-intel/queue.ts app/api/cron/analyze-broadcast-audio scripts/drain-broadcast-analysis.ts package.json vercel.json .env.example
git commit -m "feat(broadcast-intel): queue seeding, budgeted cron and local drain

Seeding requires a non-null whitelist category, unlike the fail-open
display gate: an analysis with no category has no aggregate to belong to,
so the slot waits in 'pending' until enrichment fills one in."
```

---

## Task 7: Category aggregation

**Files:**
- Create: `lib/broadcast-intel/category-pattern.ts`
- Create: `scripts/test-broadcast-intel-aggregate.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `selectAllPages` from `@/lib/supabase/paginate`; `buildCategoryMatchTerms` from `@/lib/strategy/category-mapping`; enums from `./schema`.
- Produces: `CategoryPattern`, `AnalysisRow`, `aggregatePattern(rows: AnalysisRow[], category: string): CategoryPattern | null`, `loadCategoryPattern(category: string | null): Promise<CategoryPattern | null>`, `PATTERN_MIN_SAMPLES`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-broadcast-intel-aggregate.ts`:

```ts
import assert from "node:assert/strict";
import { aggregatePattern, type AnalysisRow } from "../lib/broadcast-intel/category-pattern";

function row(durationSec: number, over: Partial<AnalysisRow> = {}): AnalysisRow {
	return {
		duration_sec: durationSec,
		channel: "qvc",
		segments: [
			{ startSec: 0, endSec: durationSec * 0.1, actType: "opening", summaryJa: "" },
			{ startSec: durationSec * 0.1, endSec: durationSec * 0.5, actType: "demo", summaryJa: "" },
			{ startSec: durationSec * 0.5, endSec: durationSec, actType: "offer", summaryJa: "" },
		],
		selling_points: [
			{ order: 1, pointType: "efficacy", firstMentionedSec: durationSec * 0.2, repeatCount: 3 },
			{ order: 2, pointType: "price_value", firstMentionedSec: durationSec * 0.6, repeatCount: 2 },
		],
		evidence_cues: [{ type: "demo", atSec: durationSec * 0.3 }],
		objection_handlings: [{ objectionType: "price", atSec: durationSec * 0.55 }],
		offer_timeline: { firstPriceSec: durationSec * 0.6, ctaSecs: [durationSec * 0.7, durationSec * 0.9], urgencyCues: [] },
		...over,
	};
}

// Below the sample floor the aggregate must refuse to exist. A pattern from
// two broadcasts presented as "measured" is worse than no pattern at all.
assert.equal(aggregatePattern([row(1500), row(1500)], "家電"), null);
assert.equal(aggregatePattern([], "家電"), null);

// Runtimes differ wildly between slots; shares must be runtime-relative so a
// 12-minute slot and a 50-minute slot can be averaged at all.
const mixed = [row(720), row(3000), row(1500), row(1800), row(2400)];
const p = aggregatePattern(mixed, "家電")!;
assert.equal(p.sampleSize, 5);
assert.equal(p.category, "家電");
assert.deepEqual(p.channels, ["qvc"]);
assert.equal(p.runtimeMedianSec, 1800);

const opening = p.actSequence.find((a) => a.actType === "opening")!;
assert.ok(Math.abs(opening.medianShare - 0.1) < 1e-6, "opening should be 10% of runtime at every length");
assert.deepEqual(p.actSequence.map((a) => a.actType), ["opening", "demo", "offer"], "acts are ordered by median start");

assert.deepEqual(p.sellingPointOrder.map((s) => s.pointType), ["efficacy", "price_value"]);
assert.equal(p.sellingPointOrder[0].presenceRate, 1);
assert.equal(p.evidenceMix[0].type, "demo");
assert.equal(p.evidenceMix[0].presenceRate, 1);
assert.equal(p.objectionMix[0].type, "price");
assert.ok(Math.abs(p.offerTiming.firstPriceShare - 0.6) < 1e-6);
assert.equal(p.offerTiming.ctaCountMedian, 2);

// A row missing the offer timeline must not drag the median to zero.
const noOffer = row(1500, { offer_timeline: { firstPriceSec: null, ctaSecs: [], urgencyCues: [] } });
const withGap = aggregatePattern([...mixed, noOffer], "家電")!;
assert.ok(Math.abs(withGap.offerTiming.firstPriceShare - 0.6) < 1e-6, "null first-price is excluded, not counted as 0");

// Two channels are both reported, sorted.
const both = aggregatePattern(mixed.map((r, i) => (i % 2 ? { ...r, channel: "shopch" as const } : r)), "家電")!;
assert.deepEqual(both.channels, ["qvc", "shopch"]);

console.log("PASS: broadcast-intel aggregate");
```

- [ ] **Step 2: Run it and observe RED**

Run: `npx tsx scripts/test-broadcast-intel-aggregate.ts`
Expected: failure — module not found.

- [ ] **Step 3: Implement**

Create `lib/broadcast-intel/category-pattern.ts`:

```ts
/**
 * Same-category aggregation of broadcast_speech_analyses into runtime-relative
 * structural patterns.
 *
 * Two rules carry the design:
 *  1. Everything is a SHARE of the runtime, never an absolute second. Slots run
 *     from 12 to 50 minutes; averaging raw seconds across them is meaningless.
 *  2. The sample floor is fail-CLOSED. Below PATTERN_MIN_SAMPLES this returns
 *     null and no block is injected. competitor_fit_analyses shows what a
 *     seven-row "aggregate" is worth.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import { getServiceClient } from "@/lib/supabase";
import { selectAllPages } from "@/lib/supabase/paginate";
import { buildCategoryMatchTerms } from "@/lib/strategy/category-mapping";
import type { ActType, EvidenceType, ObjectionType, PointType } from "./schema";

export const PATTERN_MIN_SAMPLES = Number(process.env.PATTERN_MIN_SAMPLES) || 5;

export interface AnalysisRow {
	duration_sec: number;
	channel: "qvc" | "shopch";
	segments: Array<{ startSec: number; endSec: number; actType: ActType; summaryJa: string }>;
	selling_points: Array<{ order: number; pointType: PointType; firstMentionedSec: number; repeatCount: number }>;
	evidence_cues: Array<{ type: EvidenceType; atSec: number }>;
	objection_handlings: Array<{ objectionType: ObjectionType; atSec: number }>;
	offer_timeline: { firstPriceSec: number | null; ctaSecs: number[]; urgencyCues: string[] };
}

export interface CategoryPattern {
	category: string;
	sampleSize: number;
	channels: string[];
	runtimeMedianSec: number;
	actSequence: Array<{ actType: ActType; medianShare: number; medianStartShare: number }>;
	sellingPointOrder: Array<{ pointType: PointType; medianOrder: number; presenceRate: number }>;
	evidenceMix: Array<{ type: EvidenceType; presenceRate: number }>;
	objectionMix: Array<{ type: ObjectionType; presenceRate: number }>;
	offerTiming: { firstPriceShare: number | null; firstPriceMedianSec: number | null; ctaCountMedian: number };
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function aggregatePattern(rows: AnalysisRow[], category: string): CategoryPattern | null {
	const usable = rows.filter((r) => r.duration_sec > 0);
	if (usable.length < PATTERN_MIN_SAMPLES) return null;

	const runtimeMedianSec = median(usable.map((r) => r.duration_sec))!;

	// Acts: share of runtime and median start, both runtime-relative.
	const actShares = new Map<ActType, number[]>();
	const actStarts = new Map<ActType, number[]>();
	for (const r of usable) {
		for (const seg of r.segments) {
			const share = (seg.endSec - seg.startSec) / r.duration_sec;
			if (!(share > 0)) continue;
			(actShares.get(seg.actType) ?? actShares.set(seg.actType, []).get(seg.actType)!).push(share);
			(actStarts.get(seg.actType) ?? actStarts.set(seg.actType, []).get(seg.actType)!)
				.push(seg.startSec / r.duration_sec);
		}
	}
	const actSequence = [...actShares.entries()]
		.map(([actType, shares]) => ({
			actType,
			medianShare: median(shares)!,
			medianStartShare: median(actStarts.get(actType)!)!,
		}))
		.sort((a, b) => a.medianStartShare - b.medianStartShare);

	// Selling points: typical position in the ordering, and how often present.
	const pointOrders = new Map<PointType, number[]>();
	const pointPresence = new Map<PointType, number>();
	for (const r of usable) {
		const seen = new Set<PointType>();
		for (const sp of r.selling_points) {
			(pointOrders.get(sp.pointType) ?? pointOrders.set(sp.pointType, []).get(sp.pointType)!).push(sp.order);
			seen.add(sp.pointType);
		}
		for (const t of seen) pointPresence.set(t, (pointPresence.get(t) ?? 0) + 1);
	}
	const sellingPointOrder = [...pointOrders.entries()]
		.map(([pointType, orders]) => ({
			pointType,
			medianOrder: median(orders)!,
			presenceRate: (pointPresence.get(pointType) ?? 0) / usable.length,
		}))
		.sort((a, b) => a.medianOrder - b.medianOrder);

	const rate = <K extends string>(pick: (r: AnalysisRow) => K[]): Array<{ key: K; presenceRate: number }> => {
		const counts = new Map<K, number>();
		for (const r of usable) {
			for (const k of new Set(pick(r))) counts.set(k, (counts.get(k) ?? 0) + 1);
		}
		return [...counts.entries()]
			.map(([key, n]) => ({ key, presenceRate: n / usable.length }))
			.sort((a, b) => b.presenceRate - a.presenceRate);
	};

	const evidenceMix = rate<EvidenceType>((r) => r.evidence_cues.map((c) => c.type))
		.map(({ key, presenceRate }) => ({ type: key, presenceRate }));
	const objectionMix = rate<ObjectionType>((r) => r.objection_handlings.map((o) => o.objectionType))
		.map(({ key, presenceRate }) => ({ type: key, presenceRate }));

	// A slot that never announced a price contributes nothing here — counting it
	// as 0 would pull the median toward the opening.
	const firstPriceShares = usable
		.filter((r) => r.offer_timeline.firstPriceSec !== null)
		.map((r) => r.offer_timeline.firstPriceSec! / r.duration_sec);
	const firstPriceShare = median(firstPriceShares);

	return {
		category,
		sampleSize: usable.length,
		channels: [...new Set(usable.map((r) => r.channel))].sort(),
		runtimeMedianSec,
		actSequence,
		sellingPointOrder,
		evidenceMix,
		objectionMix,
		offerTiming: {
			firstPriceShare,
			firstPriceMedianSec: firstPriceShare === null ? null : Math.round(firstPriceShare * runtimeMedianSec),
			ctaCountMedian: median(usable.map((r) => r.offer_timeline.ctaSecs.length)) ?? 0,
		},
	};
}

/** Load and aggregate. Returns null when the category is unknown, unmapped, or
 *  under-sampled — the caller then injects nothing. */
export async function loadCategoryPattern(category: string | null): Promise<CategoryPattern | null> {
	if (!category) return null;
	const terms = buildCategoryMatchTerms([category]);
	if (terms.length === 0) return null;

	const sb = getServiceClient();
	const rows = await selectAllPages<AnalysisRow>(
		(range) =>
			sb
				.from("broadcast_speech_analyses")
				.select("duration_sec, channel, segments, selling_points, evidence_cues, objection_handlings, offer_timeline")
				.in("category", terms)
				.order("broadcast_id", { ascending: true })
				.range(range.from, range.to),
		{ label: "broadcast-intel:category-pattern" },
	);

	return aggregatePattern(rows, category);
}
```

- [ ] **Step 4: Run the test and observe GREEN**

Run: `npx tsx scripts/test-broadcast-intel-aggregate.ts`
Expected: `PASS: broadcast-intel aggregate`

- [ ] **Step 5: Add the alias**

```json
    "test:broadcast-intel-aggregate": "tsx scripts/test-broadcast-intel-aggregate.ts",
```

- [ ] **Step 6: Commit**

```bash
git add lib/broadcast-intel/category-pattern.ts scripts/test-broadcast-intel-aggregate.ts package.json
git commit -m "feat(broadcast-intel): runtime-normalised category aggregation

Every timing is a share of the slot's runtime, so a 12-minute and a
50-minute broadcast can be averaged at all. The sample floor is
fail-closed: under five rows the aggregate returns null and nothing is
injected."
```

---

## Task 8: Prompt block and leak test

**Files:**
- Create: `lib/broadcast-intel/format-prompt.ts`
- Create: `scripts/test-broadcast-intel-prompt.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `CategoryPattern` from `./category-pattern`.
- Produces: `formatCategoryPatternBlock(pattern: CategoryPattern): string`, `ACT_LABELS_JA`, `POINT_LABELS_JA`, `EVIDENCE_LABELS_JA`, `OBJECTION_LABELS_JA`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-broadcast-intel-prompt.ts`:

```ts
import assert from "node:assert/strict";
import { formatCategoryPatternBlock } from "../lib/broadcast-intel/format-prompt";
import { aggregatePattern, type AnalysisRow } from "../lib/broadcast-intel/category-pattern";

// Deliberately load the fixture with the exact things that must never reach a
// prompt: a competitor product name, a performance figure, a price.
const FORBIDDEN = ["レイコップ", "ダイソン", "99.9%", "19800", "税込19,800円", "特許第1234567号"];

function row(durationSec: number, channel: "qvc" | "shopch" = "qvc"): AnalysisRow {
	return {
		duration_sec: durationSec,
		channel,
		segments: [
			{ startSec: 0, endSec: durationSec * 0.12, actType: "opening", summaryJa: `レイコップの導入 99.9%` },
			{ startSec: durationSec * 0.12, endSec: durationSec * 0.55, actType: "demo", summaryJa: "ダイソンと比較 19800" },
			{ startSec: durationSec * 0.55, endSec: durationSec, actType: "offer", summaryJa: "税込19,800円 特許第1234567号" },
		],
		selling_points: [
			{ order: 1, pointType: "efficacy", firstMentionedSec: durationSec * 0.2, repeatCount: 3 },
			{ order: 2, pointType: "price_value", firstMentionedSec: durationSec * 0.6, repeatCount: 2 },
		],
		evidence_cues: [{ type: "demo", atSec: durationSec * 0.3 }, { type: "lab_test", atSec: durationSec * 0.4 }],
		objection_handlings: [{ objectionType: "price", atSec: durationSec * 0.58 }],
		offer_timeline: {
			firstPriceSec: durationSec * 0.62,
			ctaSecs: [durationSec * 0.7, durationSec * 0.95],
			urgencyCues: ["残り19800個"],
		},
	};
}

const pattern = aggregatePattern(
	[row(1500), row(1800, "shopch"), row(1200), row(2400), row(3000, "shopch")],
	"家電",
)!;
const block = formatCategoryPatternBlock(pattern);

// THE test this module exists for.
for (const needle of FORBIDDEN) {
	assert.ok(!block.includes(needle), `prompt block leaked "${needle}"`);
}
// Digits are allowed (percentages, counts) but no yen sign should appear:
// prices are the highest-risk figure and have no place in a structure block.
assert.ok(!block.includes("¥") && !block.includes("円"), "prompt block must carry no price");

assert.ok(block.startsWith("## 競合放送の構成パターン"), "block must be a single markdown section");
assert.ok(block.includes("家電"), "block states the category it aggregates");
assert.ok(block.includes("5番組"), "block states the sample size");
assert.ok(block.includes("QVC") && block.includes("ShopCh"), "block states the channels");
assert.ok(block.includes("導入") && block.includes("実演"), "act labels are Japanese, not enum keys");
assert.ok(!/opening|demo|efficacy|lab_test/.test(block), "no raw enum keys leak into the prompt");
assert.ok(block.includes("用途制限"), "block restates the usage restriction");

console.log("PASS: broadcast-intel prompt block");
```

- [ ] **Step 2: Run it and observe RED**

Run: `npx tsx scripts/test-broadcast-intel-prompt.ts`
Expected: failure — module not found.

- [ ] **Step 3: Implement**

Create `lib/broadcast-intel/format-prompt.ts`:

```ts
/**
 * Renders a CategoryPattern as the one prompt block the screenplay generator
 * receives about competitors.
 *
 * This is the boundary the whole design defends: only aggregate shares,
 * ordering and frequencies cross it. Segment summaries, transcripts, product
 * names, figures and prices never enter this function's output — see
 * scripts/test-broadcast-intel-prompt.ts, which asserts exactly that.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import type { CategoryPattern } from "./category-pattern";
import type { ActType, EvidenceType, ObjectionType, PointType } from "./schema";

export const ACT_LABELS_JA: Record<ActType, string> = {
	opening: "導入",
	problem: "問題提起",
	product_intro: "商品紹介",
	demo: "実演",
	evidence: "根拠提示",
	testimonial: "利用者の声",
	offer: "オファー",
	cta: "行動喚起",
	closing: "締め",
};

export const POINT_LABELS_JA: Record<PointType, string> = {
	efficacy: "効果",
	ease_of_use: "手軽さ",
	price_value: "価格納得感",
	safety: "安全性",
	size_fit: "サイズ・適合",
	durability: "耐久性",
	design: "デザイン",
	aftercare: "アフターケア",
	scarcity: "希少性",
};

export const EVIDENCE_LABELS_JA: Record<EvidenceType, string> = {
	lab_test: "試験成績",
	demo: "実演",
	comparison: "比較",
	testimonial: "利用者の声",
	expert: "専門家",
	certification: "認証",
};

export const OBJECTION_LABELS_JA: Record<ObjectionType, string> = {
	price: "価格への抵抗",
	doubt_efficacy: "効果への疑い",
	difficulty: "使いこなせるか",
	space: "置き場所",
	maintenance: "手入れの手間",
	timing: "今買う理由",
};

const CHANNEL_LABELS: Record<string, string> = { qvc: "QVC", shopch: "ShopCh" };

const pct = (share: number): string => `${Math.round(share * 100)}%`;

function mmss(totalSec: number): string {
	const m = Math.floor(totalSec / 60);
	const s = Math.round(totalSec % 60);
	return `${m}分${String(s).padStart(2, "0")}秒`;
}

export function formatCategoryPatternBlock(pattern: CategoryPattern): string {
	const channels = pattern.channels.map((c) => CHANNEL_LABELS[c] ?? c).join("・");
	const runtimeMin = Math.round(pattern.runtimeMedianSec / 60);

	const acts = pattern.actSequence
		.map((a) => `${ACT_LABELS_JA[a.actType]} ${pct(a.medianShare)}`)
		.join(" → ");

	const points = pattern.sellingPointOrder
		.map((p) => `${POINT_LABELS_JA[p.pointType]}（${pct(p.presenceRate)}）`)
		.join(" → ");

	const evidence = pattern.evidenceMix
		.map((e) => `${EVIDENCE_LABELS_JA[e.type]} ${pct(e.presenceRate)}`)
		.join(" / ");

	const objections = pattern.objectionMix
		.map((o) => `${OBJECTION_LABELS_JA[o.type]} ${pct(o.presenceRate)}`)
		.join(" / ");

	const offer =
		pattern.offerTiming.firstPriceShare === null
			? `価格提示のタイミングは集計できていない。CTA 中央値 ${pattern.offerTiming.ctaCountMedian}回`
			: `価格初出は尺の ${pct(pattern.offerTiming.firstPriceShare)}（中央値 ${mmss(pattern.offerTiming.firstPriceMedianSec!)}地点）、CTA 中央値 ${pattern.offerTiming.ctaCountMedian}回`;

	return [
		`## 競合放送の構成パターン（同カテゴリ ${pattern.sampleSize}件の集計・構成の参考のみ）`,
		`- 集計対象: ${pattern.category} / ${channels} / ${pattern.sampleSize}番組 / 尺中央値 ${runtimeMin}分`,
		`- 標準構成比: ${acts}`,
		`- 販売ポイント提示順: ${points}`,
		`- 根拠提示の型: ${evidence}`,
		`- 想定される視聴者の懸念: ${objections}`,
		`- オファー進行: ${offer}`,
		"- 用途制限: 構成設計にのみ使用する。競合商品の名称・数値・性能・特典・固有の実演内容は",
		"  含まれておらず、推測して補完してはならない。上記の比率は本商品の尺に換算して用いる。",
	].join("\n");
}
```

- [ ] **Step 4: Run the test and observe GREEN**

Run: `npx tsx scripts/test-broadcast-intel-prompt.ts`
Expected: `PASS: broadcast-intel prompt block`

- [ ] **Step 5: Add the alias**

```json
    "test:broadcast-intel-prompt": "tsx scripts/test-broadcast-intel-prompt.ts",
```

- [ ] **Step 6: Commit**

```bash
git add lib/broadcast-intel/format-prompt.ts scripts/test-broadcast-intel-prompt.ts package.json
git commit -m "feat(broadcast-intel): the competitor-pattern prompt block

The leak test loads the fixture with a competitor brand, a performance
figure and a price, then asserts none of them survive into the block. That
assertion is the reason this module is separate from the aggregator."
```

---

## Task 9: Wire the block into screenplay generation

**Files:**
- Modify: `lib/screenplay/types.ts`
- Modify: `lib/screenplay/prompt.ts:296-336`
- Modify: `lib/workflows/screenplay.workflow.ts:74-99, 101-108, 320-345`

**Interfaces:**
- Consumes: `loadCategoryPattern`, `formatCategoryPatternBlock`, `CategoryPattern`.
- Produces: `GenerateInput.patternBlock?: string`; `persistStep(..., patternSnapshot: CategoryPattern | null)`.

- [ ] **Step 1: Extend the input type**

In `lib/screenplay/types.ts`, inside `GenerateInput`, after `complianceBlock`:

```ts
  /** Pre-built competitor structure block. Aggregate shares only — never
   *  competitor product facts. Empty/undefined → not injected. Built by
   *  lib/broadcast-intel/format-prompt.ts. */
  patternBlock?: string;
```

- [ ] **Step 2: Inject it in the initial prompt**

In `lib/screenplay/prompt.ts`, replace the `## 根拠の優先順位` list inside the `initial` branch:

```ts
			"## 根拠の優先順位",
			"1. 確認済み商品情報・価格・特典・保証",
			"2. ユーザー指定の作家指示",
			"3. 企画参考情報（構成だけに使用し、事実として断定しない）",
			"4. 放送文体リファレンス（リズムだけに使用し、内容を転用しない）",
			"根拠が足りない要素は創作せず、省略または一般的な使用シーンに置き換える。",
```

with:

```ts
			"## 根拠の優先順位",
			"1. 確認済み商品情報・価格・特典・保証",
			"2. ユーザー指定の作家指示",
			...(input.patternBlock?.trim()
				? ["3. 競合放送の構成パターン（構成の骨格のみ。商品事実として使用しない）"]
				: []),
			`${input.patternBlock?.trim() ? "4" : "3"}. 企画参考情報（構成だけに使用し、事実として断定しない）`,
			`${input.patternBlock?.trim() ? "5" : "4"}. 放送文体リファレンス（リズムだけに使用し、内容を転用しない）`,
			"根拠が足りない要素は創作せず、省略または一般的な使用シーンに置き換える。",
```

Then, immediately after the `complianceInitial` push block and before the `放送文体の限定リファレンス` push, add:

```ts
		const patternInitial = input.patternBlock?.trim();
		if (patternInitial) parts.push("", "---", "", patternInitial);
```

Leave the `refine` branch untouched.

- [ ] **Step 3: Build and pass the block in the workflow**

In `lib/workflows/screenplay.workflow.ts`, add imports:

```ts
import { loadCategoryPattern, type CategoryPattern } from "@/lib/broadcast-intel/category-pattern";
import { formatCategoryPatternBlock } from "@/lib/broadcast-intel/format-prompt";
```

Add a step function next to `generateStep`:

```ts
/** Aggregate same-category competitor structure. Non-fatal: a screenplay must
 *  still generate when the corpus is thin, disabled or unreachable. */
async function loadPatternStep(
  category: string | null,
): Promise<{ pattern: CategoryPattern | null; block: string }> {
  "use step";
  if (process.env.BROADCAST_INTEL_ENABLED !== "true") return { pattern: null, block: "" };
  try {
    const pattern = await loadCategoryPattern(category);
    return { pattern, block: pattern ? formatCategoryPatternBlock(pattern) : "" };
  } catch (err) {
    console.warn(
      "[screenplay] competitor pattern lookup failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { pattern: null, block: "" };
  }
}
```

Change `generateStep`'s signature to take the block and forward it:

```ts
async function generateStep(
  input: ScreenplayWorkflowInput,
  previousMarkdown: string | undefined,
  complianceBlock: string,
  patternBlock: string,
) {
```

and inside the `generateScreenplay` call add `patternBlock,` next to `complianceBlock,`.

At the `initial` call site (around line 324-330), insert before `generateStep`:

```ts
    const { pattern, block: patternBlock } = await loadPatternStep(
      input.productBrief.category ?? null,
    );
```

and pass `patternBlock` as the new fourth argument.

- [ ] **Step 4: Persist the snapshot**

Extend `persistStep`'s signature with `patternSnapshot: CategoryPattern | null` and add to the insert payload:

```ts
        pattern_snapshot: patternSnapshot,
```

Pass `pattern` at the initial call site and `null` at the refine/import call site (refine does not inject a pattern, so it must not claim one).

- [ ] **Step 5: Verify the prompt is unchanged when disabled**

Add this import to the TOP of `scripts/test-broadcast-intel-prompt.ts`, with the other imports:

```ts
import { buildUserPrompt } from "../lib/screenplay/prompt";
```

Then append these assertions before the final log:

```ts
const brief = { name: "テスト商品", category: "家電", description: "説明" };
const without = await buildUserPrompt({ mode: "initial", productBrief: brief });
const with_ = await buildUserPrompt({ mode: "initial", productBrief: brief, patternBlock: block });

assert.ok(!without.includes("競合放送の構成パターン"), "no block when none is supplied");
assert.ok(without.includes("3. 企画参考情報"), "priority list stays 4 items when not injected");
assert.ok(with_.includes("競合放送の構成パターン"), "block is injected when supplied");
assert.ok(with_.includes("3. 競合放送の構成パターン") && with_.includes("4. 企画参考情報"), "priority list renumbers");

const refined = await buildUserPrompt({
	mode: "refine", productBrief: brief, patternBlock: block,
	feedback: "テンポを上げて", previousMarkdown: "# 台本",
});
assert.ok(!refined.includes("競合放送の構成パターン"), "refine mode must never receive the pattern block");
```

The script's top-level `await` requires it to run under tsx as an ES module — it already does.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm run test:broadcast-intel-prompt && npx tsc --noEmit`
Expected: `PASS: broadcast-intel prompt block`, then exit 0.

- [ ] **Step 7: Commit**

```bash
git add lib/screenplay/types.ts lib/screenplay/prompt.ts lib/workflows/screenplay.workflow.ts scripts/test-broadcast-intel-prompt.ts
git commit -m "feat(screenplay): inject same-category competitor structure

Routed exactly like complianceBlock. Initial mode only — refine already has
the current draft and the director's notes, and a second structural voice
there only causes unrequested drift. Off by default behind
BROADCAST_INTEL_ENABLED; when off the prompt is byte-identical to today's."
```

---

## Task 10: Surface it in the screenplay detail view

**Files:**
- Modify: the screenplay detail page under `app/[locale]/(produce)/screenplays/[id]/`
- Modify: `messages/ja.json`, `messages/ko.json`

**Interfaces:**
- Consumes: `screenplay_versions.pattern_snapshot` (shape `CategoryPattern`).

- [ ] **Step 1: Locate the version metadata display**

Run: `grep -rn "thinking_level\|token_usage" app/\[locale\]/\(produce\)/screenplays components/screenplay | head`

Add the indicator next to wherever model/thinking metadata is already rendered, so it sits with the other provenance fields.

- [ ] **Step 2: Add the copy**

In `messages/ja.json` under the screenplay section:

```json
      "patternApplied": "競合放送の構成パターン {count}件を反映",
      "patternNone": "競合放送パターンなし"
```

In `messages/ko.json`, the same keys:

```json
      "patternApplied": "경쟁 방송 구성 패턴 {count}편 반영",
      "patternNone": "경쟁 방송 패턴 없음"
```

- [ ] **Step 3: Render it**

Where version metadata is rendered, add:

```tsx
{version.pattern_snapshot ? (
  <span className="text-xs text-muted-foreground">
    {t("patternApplied", { count: version.pattern_snapshot.sampleSize })}
  </span>
) : null}
```

Add `pattern_snapshot?: CategoryPattern | null` to the `ScreenplayVersionRow` type in `lib/screenplay/types.ts`.

- [ ] **Step 4: Check message parity**

Run: `npm run test:message-parity`
Expected: PASS — ja and ko carry the same keys.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: exit 0, no new warnings.

- [ ] **Step 6: Commit**

```bash
git add app/\[locale\]/\(produce\)/screenplays components/screenplay lib/screenplay/types.ts messages/ja.json messages/ko.json
git commit -m "feat(screenplay): show how many competitor broadcasts shaped a version

An invisible prompt change is an untrustworthy one, and the blind
before/after comparison needs a way to tell the two arms apart afterwards."
```

---

## Task 11: Flip the pipeline Sankey

**Files:**
- Modify: `lib/pipeline/data-intelligence-graph.ts`
- Modify: `scripts/test-data-intelligence-graph.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `datasetSellingLanguage` and `outcomeCompetitiveScript` as `current`; the two links joining them as `current`.

- [ ] **Step 1: Update the test first**

In `scripts/test-data-intelligence-graph.ts`, change the two expectations in the node-status map:

```ts
		datasetSellingLanguage: "dataset:current",
```

```ts
		outcomeCompetitiveScript: "outcome:current",
```

- [ ] **Step 2: Run it and observe RED**

Run: `npx tsx scripts/test-data-intelligence-graph.ts`
Expected: FAIL — the graph still marks both `planned`.

- [ ] **Step 3: Update the graph model**

In `lib/pipeline/data-intelligence-graph.ts`:

- `datasetSellingLanguage`: `status: "planned"` → `status: "current"`
- `outcomeCompetitiveScript`: `status: "planned"` → `status: "current"`
- `{ source: "sourceMediaArchive", target: "datasetSellingLanguage", value: 4, status: "planned" }` → `status: "current"`
- `{ source: "datasetSellingLanguage", target: "outcomeCompetitiveScript", value: 3, status: "current" }`

Leave `datasetSceneIndex`, `outcomeDemoPlan` and every link touching them as `planned`.

- [ ] **Step 4: Run it and observe GREEN**

Run: `npx tsx scripts/test-data-intelligence-graph.ts`
Expected: `PASS: data intelligence graph model`

- [ ] **Step 5: Update the Japanese/Korean node copy**

In `messages/ja.json` and `messages/ko.json`, the `pipeline.vision.nodes.datasetSellingLanguage.description` and `.outcomeCompetitiveScript.description` both begin with 「향후」/「今後」. Drop that prefix — the descriptions now state what the system does, not what it will do.

- [ ] **Step 6: Add the alias and verify parity**

```json
    "test:data-intelligence-graph": "tsx scripts/test-data-intelligence-graph.ts",
```

Run: `npm run test:message-parity`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/pipeline/data-intelligence-graph.ts scripts/test-data-intelligence-graph.ts messages/ja.json messages/ko.json package.json
git commit -m "feat(pipeline): selling-language and competitive script are now current

Scene index and demo plan stay planned — this cycle deliberately took one
path through the graph, not the whole planned half."
```

---

## Task 12: Live smoke and the first 40 slots

**Files:**
- Create: `scripts/test-broadcast-intel-live.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Clear the dead shell key**

The repo's `.env.local` key is valid, but `~/.zshenv:2` and `~/.zshrc:10` export a dead `GEMINI_API_KEY` (HTTP 400), and Node's `--env-file` does not override an already-set variable — so every local `tsx --env-file=.env.local` run uses the dead key.

**This step needs the user.** Ask them to delete those two lines, then verify:

```bash
exec zsh -l
echo "${GEMINI_API_KEY:-unset}"
```

Expected: `unset`.

- [ ] **Step 2: Write the live smoke**

Create `scripts/test-broadcast-intel-live.ts`:

```ts
/**
 * One real broadcast, end to end: S3 → ffmpeg → Gemini → both tables.
 * Usage: npm run test:broadcast-intel-live
 *
 * Picks the most recent archived 家電 slot that has not been analysed yet.
 */
import { getServiceClient } from "@/lib/supabase";
import { analyzeOne, type QueuedAnalysisSlot } from "@/lib/broadcast-intel/analyze-one";

async function main(): Promise<void> {
	const sb = getServiceClient();

	const { data, error } = await sb
		.from("broadcasts")
		.select("id, channel, air_date, category, archived_video_s3, analysis_attempts")
		.not("archived_video_s3", "is", null)
		.eq("category", "家電")
		.neq("analysis_status", "done")
		.order("air_date", { ascending: false })
		.limit(1);
	if (error) throw new Error(error.message);

	const slot = (data ?? [])[0] as QueuedAnalysisSlot | undefined;
	if (!slot) throw new Error("no archived 家電 slot available to analyse");

	console.log(`[live] slot ${slot.id} ${slot.channel} ${slot.air_date}`);
	await sb.from("broadcasts").update({ analysis_status: "queued" }).eq("id", slot.id);

	const started = Date.now();
	const result = await analyzeOne(slot);
	console.log(`[live] ${result.status} in ${Math.round((Date.now() - started) / 1000)}s`, result.error ?? "");
	if (result.status !== "done") throw new Error(`analysis did not complete: ${result.error}`);

	const { data: analysis } = await sb
		.from("broadcast_speech_analyses")
		.select("duration_sec, segments, selling_points, evidence_cues, offer_timeline")
		.eq("broadcast_id", slot.id)
		.single();
	const { data: transcript } = await sb
		.from("broadcast_transcripts")
		.select("segments")
		.eq("broadcast_id", slot.id)
		.single();

	if (!analysis) throw new Error("no analysis row written");
	if (!transcript) throw new Error("no transcript row written");

	const a = analysis as { duration_sec: number; segments: unknown[]; selling_points: unknown[]; evidence_cues: unknown[] };
	console.log(`  duration_sec   ${a.duration_sec}`);
	console.log(`  segments       ${a.segments.length}`);
	console.log(`  selling_points ${a.selling_points.length}`);
	console.log(`  evidence_cues  ${a.evidence_cues.length}`);
	console.log(`  transcript     ${(transcript as { segments: unknown[] }).segments.length} lines`);

	if (a.duration_sec <= 0) throw new Error("runtime was not learned");
	if (a.segments.length === 0) throw new Error("no acts were segmented");

	console.log("\nPASS: broadcast-intel live");
}

main();
```

- [ ] **Step 3: Add the aliases**

```json
    "test:broadcast-intel-live": "tsx --env-file=.env.local scripts/test-broadcast-intel-live.ts",
    "test:broadcast-intel": "npm run test:broadcast-intel-schema && npm run test:broadcast-intel-aggregate && npm run test:broadcast-intel-prompt",
```

- [ ] **Step 4: Run the live smoke**

Run: `npm run test:broadcast-intel-live`
Expected: `PASS: broadcast-intel live`, with a non-zero `duration_sec` and a non-empty segment list.

If it fails on the Gemini call, check `npm ls @google/genai` and confirm the Files API surface matches Task 4 Step 2's note.

- [ ] **Step 5: Drain the first 40 家電 slots**

Run: `npm run drain:broadcast-analysis -- --limit=40 --category=家電`
Expected: `processed=40` with `failed` in the low single digits. Roughly 40–80 minutes.

Record the observed per-slot wall time and any S3 egress figure in the spec's §12 so the full-corpus decision has real numbers.

- [ ] **Step 6: Verify the aggregate exists**

Append to `scripts/test-broadcast-intel-live.ts`, at the end of `main()` before the final log (and add `loadCategoryPattern` to the imports at the top):

```ts
	const pattern = await loadCategoryPattern("家電");
	console.log(`  aggregate      ${pattern ? `${pattern.sampleSize} samples` : "null (under the floor)"}`);
```

Run: `npm run test:broadcast-intel-live`
Expected: after the 40-slot drain, `aggregate  ~40 samples` rather than `null`. Before the drain it legitimately prints `null` — that is the fail-closed floor working.

- [ ] **Step 7: Enable injection and generate a comparison pair**

Set `BROADCAST_INTEL_ENABLED=true` in `.env.local`, then generate two screenplays for the same 家電 product — one with the flag off, one on — and record both against the scoring sheet in `docs/japan/2026-08-21-client-request-ja.md` (事実誤認数 / 審査リスク数 / 構成 1–5 / MWBらしさ 1–5 / 修正時間).

- [ ] **Step 8: Commit**

```bash
git add scripts/test-broadcast-intel-live.ts package.json docs/superpowers/specs/2026-08-24-broadcast-selling-language-design.md
git commit -m "test(broadcast-intel): live end-to-end smoke, plus measured costs

Records the observed per-slot wall time and egress in the spec so the
full-corpus expansion is decided on numbers rather than estimates."
```

---

## Verification Summary

Run before declaring the feature done:

```bash
npm run test:broadcast-intel          # schema + aggregate + prompt (incl. leak test)
npm run test:data-intelligence-graph  # the completion definition
npm run test:message-parity
npm run test:migrations
npx tsc --noEmit
npm run lint
npm run test:broadcast-intel-live     # requires .env.local and the dead shell key removed
```
