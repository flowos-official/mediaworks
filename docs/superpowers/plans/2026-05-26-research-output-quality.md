# Research Output Quality (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the research-pipeline output quality on three axes — multi-file extract, schema-enforced synthesize output, and classified retry — and add user-facing polling cap + failure messages on top of Phase 2's `error_reason` taxonomy.

**Architecture:** Three new small `lib/gemini/` files (`errors.ts`, `retry.ts`, `research-schema.ts`) plus one new `lib/research/error-reason-explain.ts` form the shared spine. Existing call sites (`extractProductInfo`, `synthesizeResearch`, `analyzeExpansionStrategy`, `loadBroadcastContext`, `synthesize-product.ts`) are refactored to compose these helpers. UI gains a polling timeout and elapsed-time + per-kind failure messages. No DB migration.

**Tech Stack:** Next.js 16, `@google/generative-ai` SDK, TypeScript, `tsx` smoke runner.

**Spec:** `docs/superpowers/specs/2026-05-26-research-output-quality-design.md` (commit `19eb38a`).

**Branch:** `research/output-quality` (worktree `.claude/worktrees/research-output-quality`, branched from `main@3dccf1c`).

---

## File Structure

### New files
- `lib/gemini/errors.ts` — `GeminiErrorKind`, `GeminiCallError`, `classifyGeminiError`
- `lib/gemini/retry.ts` — `callGeminiWithRetry` + `RetryOptions`
- `lib/gemini/research-schema.ts` — `researchOutputSchema` (Gemini SDK Schema type)
- `lib/gemini/parse-research-output.ts` — `parseResearchOutput` (text → ResearchOutput with sanitization)
- `lib/research/error-reason-explain.ts` — `explainErrorReason(reason, locale)` + label maps
- `scripts/test-gemini-classify-error.ts` — pure unit for the kind classifier
- `scripts/test-gemini-retry.ts` — pure unit for backoff/retry helper
- `scripts/test-research-schema-shape.ts` — pure unit for schema validity
- `scripts/test-error-reason-explain.ts` — pure unit for label map coverage

### Modified files
- `lib/gemini.ts` — `extractProductInfo` signature change, `synthesizeResearch` schema/retry/prompt-order, `analyzeExpansionStrategy` retry adoption
- `app/api/analyze/route.ts` — body shape: `files[]` (with legacy compat) + size guards
- `app/api/upload/route.ts` — pass all uploaded files to analyze
- `lib/research/synthesize-product.ts` — broadcast context error surfacing + GeminiCallError catch
- `lib/research/competitor-context.ts` — drop silent swallow, throw `BroadcastContextLoadError`
- `components/ProductList.tsx` — polling cap (12 min)
- `components/ProductCard.tsx` — elapsed-time badge + failure message via `explainErrorReason`
- `app/[locale]/(admin)/admin/research-pipeline/page.tsx` — kind-prefix label map for cards
- `messages/ja.json`, `messages/ko.json` — new i18n keys for elapsed/warning/stuck/reupload

### Boundary notes
- All new `lib/gemini/*` and `lib/research/*` files must be smoke-importable: **no `import "server-only"`**.
- `lib/research/error-reason-explain.ts` is consumed by client `ProductCard` — must compile under "use client" boundary (pure function, no Node-only imports).
- `researchOutputSchema` lives in its own file so the smoke can import it without dragging the rest of `lib/gemini.ts` into the runner.

---

## Task 1: GeminiErrorKind taxonomy + `classifyGeminiError`

**Files:**
- Create: `lib/gemini/errors.ts`
- Create: `scripts/test-gemini-classify-error.ts`
- Modify: `package.json` (add `test:gemini-classify-error` script)

- [ ] **Step 1: Write the failing classifier unit test**

`scripts/test-gemini-classify-error.ts`:
```ts
/**
 * 単位テスト: classifyGeminiError の 7 分岐検証。
 * 実行: npm run test:gemini-classify-error
 */
import { classifyGeminiError } from "../lib/gemini/errors";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function main(): void {
  // 1) safety: candidates[0].finishReason === 'SAFETY'
  const safetyFinish = { response: { candidates: [{ finishReason: "SAFETY" }] } };
  assert(classifyGeminiError(safetyFinish) === "safety_blocked", "candidates[0].finishReason=SAFETY → safety_blocked");

  // 2) safety: promptFeedback.blockReason
  const safetyPrompt = { response: { promptFeedback: { blockReason: "HATE_SPEECH" } } };
  assert(classifyGeminiError(safetyPrompt) === "safety_blocked", "promptFeedback.blockReason → safety_blocked");

  // 3) rate-limited: status 429
  const rate = Object.assign(new Error("rate limit exceeded"), { status: 429 });
  assert(classifyGeminiError(rate) === "rate_limited", "status=429 → rate_limited");

  // 4) server error: status 5xx
  const serverErr = Object.assign(new Error("upstream"), { status: 503 });
  assert(classifyGeminiError(serverErr) === "server_error", "status=503 → server_error");

  // 5) extract_empty: explicit empty text marker
  const emptyErr = new Error("empty model response");
  assert(classifyGeminiError(emptyErr) === "extract_empty", "empty model response → extract_empty");

  // 6) parse_failed: SyntaxError style
  const parseErr = new SyntaxError("Unexpected token } in JSON at position 14");
  assert(classifyGeminiError(parseErr) === "parse_failed", "SyntaxError → parse_failed");

  // 7) parse_failed: "Failed to parse JSON" message
  const parseErr2 = new Error("Failed to parse JSON from research synthesis: ...");
  assert(classifyGeminiError(parseErr2) === "parse_failed", "Failed to parse JSON message → parse_failed");

  // 8) schema_validation_failed: message mentions schema
  const schemaErr = new Error("response did not match schema: missing required field korea_market_fit");
  assert(classifyGeminiError(schemaErr) === "schema_validation_failed", "schema mention → schema_validation_failed");

  // 9) unknown: fallback
  const random = new Error("network reset");
  assert(classifyGeminiError(random) === "unknown", "unknown fallback");

  console.log("[ok] classifyGeminiError 全9ケース通過");
}

main();
```

- [ ] **Step 2: Run failing test**

```bash
npm run test:gemini-classify-error
```
Expected: FAIL — script not in package.json or module not found.

- [ ] **Step 3: Wire up npm script**

Edit `package.json`. After the last existing test script, add:
```json
"test:gemini-classify-error": "tsx scripts/test-gemini-classify-error.ts"
```

- [ ] **Step 4: Implement `lib/gemini/errors.ts`**

```ts
export type GeminiErrorKind =
  | "safety_blocked"
  | "rate_limited"
  | "server_error"
  | "parse_failed"
  | "schema_validation_failed"
  | "extract_empty"
  | "unknown";

export class GeminiCallError extends Error {
  constructor(
    public readonly kind: GeminiErrorKind,
    public readonly attempts: number,
    public readonly summary: string,
    public readonly lastError: unknown,
  ) {
    super(`${kind}: ${summary}`);
    this.name = "GeminiCallError";
  }
}

function pickStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function pickResponse(err: unknown): { promptFeedback?: { blockReason?: string }; candidates?: Array<{ finishReason?: string }> } | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const response = (err as { response?: unknown }).response;
  return typeof response === "object" && response !== null ? response as { promptFeedback?: { blockReason?: string }; candidates?: Array<{ finishReason?: string }> } : undefined;
}

export function classifyGeminiError(err: unknown): GeminiErrorKind {
  // Some callers wrap a GenerativeAI response object inside an error-shaped throw.
  const response = pickResponse(err);
  if (response?.candidates?.[0]?.finishReason === "SAFETY") return "safety_blocked";
  if (response?.promptFeedback?.blockReason) return "safety_blocked";

  const status = pickStatus(err);
  if (status === 429) return "rate_limited";
  if (typeof status === "number" && status >= 500 && status < 600) return "server_error";

  const message = err instanceof Error ? err.message : String(err ?? "");

  if (/empty model response/i.test(message)) return "extract_empty";
  if (err instanceof SyntaxError) return "parse_failed";
  if (/failed to parse json|invalid json|unexpected token/i.test(message)) return "parse_failed";
  if (/schema|missing required field/i.test(message)) return "schema_validation_failed";
  if (/rate limit|quota/i.test(message)) return "rate_limited";
  if (/network|timeout|fetch failed/i.test(message)) return "server_error";

  return "unknown";
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm run test:gemini-classify-error
```
Expected: `[ok] classifyGeminiError 全9ケース通過`.

- [ ] **Step 6: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add lib/gemini/errors.ts scripts/test-gemini-classify-error.ts package.json
git commit -m "feat(gemini): error kind taxonomy + classifier with 9-case unit"
```

---

## Task 2: `callGeminiWithRetry` helper + unit smoke

**Files:**
- Create: `lib/gemini/retry.ts`
- Create: `scripts/test-gemini-retry.ts`
- Modify: `package.json` (add `test:gemini-retry`)

- [ ] **Step 1: Write the failing retry unit test**

`scripts/test-gemini-retry.ts`:
```ts
/**
 * 単位テスト: callGeminiWithRetry の retry 数 / backoff / no-retry kind 判定。
 * 実行: npm run test:gemini-retry
 */
import { callGeminiWithRetry } from "../lib/gemini/retry";
import { GeminiCallError } from "../lib/gemini/errors";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function main(): Promise<void> {
  // Case 1: 成功は 1 回目で返る
  {
    let calls = 0;
    const result = await callGeminiWithRetry(async () => {
      calls += 1;
      return { result: "ok", responseText: "ok" };
    });
    assert(result === "ok", "result should be 'ok'");
    assert(calls === 1, "should call once on immediate success");
  }

  // Case 2: 1 回目失敗 (server_error)、2 回目成功 → 2 回呼ばれる
  {
    let calls = 0;
    const result = await callGeminiWithRetry(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("upstream"), { status: 503 });
      return { result: "ok2", responseText: "ok2" };
    }, { baseDelayMs: 1 });
    assert(result === "ok2", "result should be 'ok2'");
    assert(calls === 2, `should call twice, got ${calls}`);
  }

  // Case 3: safety_blocked は retry しない
  {
    let calls = 0;
    let thrown: unknown;
    try {
      await callGeminiWithRetry(async () => {
        calls += 1;
        throw { response: { candidates: [{ finishReason: "SAFETY" }] } };
      }, { baseDelayMs: 1 });
    } catch (err) {
      thrown = err;
    }
    assert(thrown instanceof GeminiCallError, "should throw GeminiCallError");
    assert((thrown as GeminiCallError).kind === "safety_blocked", "kind should be safety_blocked");
    assert(calls === 1, `safety_blocked: should call once, got ${calls}`);
  }

  // Case 4: 全 attempt 失敗 → GeminiCallError with attempts = max
  {
    let calls = 0;
    let thrown: unknown;
    try {
      await callGeminiWithRetry(async () => {
        calls += 1;
        throw new SyntaxError("Unexpected token } at position 5");
      }, { baseDelayMs: 1, maxAttempts: 3 });
    } catch (err) {
      thrown = err;
    }
    assert(thrown instanceof GeminiCallError, "should throw GeminiCallError after exhaust");
    assert((thrown as GeminiCallError).kind === "parse_failed", `kind should be parse_failed (got ${(thrown as GeminiCallError).kind})`);
    assert((thrown as GeminiCallError).attempts === 3, `attempts should be 3, got ${(thrown as GeminiCallError).attempts}`);
    assert(calls === 3, `should call 3 times, got ${calls}`);
  }

  // Case 5: responseText が空文字 → extract_empty で再分類、retry 適用
  {
    let calls = 0;
    const result = await callGeminiWithRetry(async () => {
      calls += 1;
      if (calls === 1) return { result: null as unknown as string, responseText: "" };
      return { result: "ok3", responseText: "ok3" };
    }, { baseDelayMs: 1 });
    assert(result === "ok3", `result should be 'ok3', got ${result}`);
    assert(calls === 2, `should call twice on empty-then-success, got ${calls}`);
  }

  // Case 6: promptForAttempt が attempt 番号と前回 kind を受け取る
  {
    const seen: Array<{ attempt: number; kind: string | undefined }> = [];
    let calls = 0;
    try {
      await callGeminiWithRetry(async () => {
        calls += 1;
        throw Object.assign(new Error("upstream"), { status: 503 });
      }, {
        baseDelayMs: 1,
        maxAttempts: 2,
        promptForAttempt: (attempt, kind) => {
          seen.push({ attempt, kind });
          return null;
        },
      });
    } catch {
      // expected
    }
    assert(seen.length === 2, `promptForAttempt should be called 2 times, got ${seen.length}`);
    assert(seen[0].attempt === 1 && seen[0].kind === undefined, "first call: attempt=1, kind=undefined");
    assert(seen[1].attempt === 2 && seen[1].kind === "server_error", `second call: attempt=2 kind=server_error, got ${seen[1].kind}`);
  }

  console.log("[ok] callGeminiWithRetry 全6ケース通過");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run failing test**

```bash
npm run test:gemini-retry
```
Expected: FAIL — script not registered.

- [ ] **Step 3: Wire up npm script**

Add to `package.json`:
```json
"test:gemini-retry": "tsx scripts/test-gemini-retry.ts"
```

- [ ] **Step 4: Implement `lib/gemini/retry.ts`**

```ts
import { GeminiCallError, type GeminiErrorKind, classifyGeminiError } from "./errors";

const NO_RETRY_KINDS: ReadonlySet<GeminiErrorKind> = new Set(["safety_blocked"]);

const BACKOFF_MULTIPLIER: Record<GeminiErrorKind, number> = {
  safety_blocked: 1.0,
  rate_limited: 1.5,
  server_error: 2.0,
  parse_failed: 1.5,
  schema_validation_failed: 1.5,
  extract_empty: 1.5,
  unknown: 1.5,
};

export interface InvokerResult<T> {
  result: T;
  responseText?: string;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  onAttempt?: (attempt: number, lastKind?: GeminiErrorKind) => void;
  promptForAttempt?: (attempt: number, lastKind?: GeminiErrorKind) => string | null;
}

export async function callGeminiWithRetry<T>(
  invoker: (attempt: number, promptOverride: string | null) => Promise<InvokerResult<T>>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;

  let lastKind: GeminiErrorKind | undefined;
  let lastSummary = "";
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const promptOverride = options.promptForAttempt?.(attempt, lastKind) ?? null;
    options.onAttempt?.(attempt, lastKind);

    try {
      const { result, responseText } = await invoker(attempt, promptOverride);
      if (responseText !== undefined && responseText.trim().length === 0) {
        throw new Error("empty model response");
      }
      return result;
    } catch (err) {
      lastError = err;
      lastKind = classifyGeminiError(err);
      lastSummary = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);

      if (NO_RETRY_KINDS.has(lastKind)) break;
      if (attempt >= maxAttempts) break;

      const multiplier = BACKOFF_MULTIPLIER[lastKind] ?? 1.5;
      const delay = Math.round(baseDelayMs * Math.pow(multiplier, attempt - 1));
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new GeminiCallError(
    lastKind ?? "unknown",
    Math.min(maxAttempts, maxAttempts),
    `${lastSummary} after ${maxAttempts} attempts`,
    lastError,
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm run test:gemini-retry
```
Expected: `[ok] callGeminiWithRetry 全6ケース通過`.

- [ ] **Step 6: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add lib/gemini/retry.ts scripts/test-gemini-retry.ts package.json
git commit -m "feat(gemini): callGeminiWithRetry helper with 6-case unit"
```

---

## Task 3: `researchOutputSchema` + shape smoke

**Files:**
- Create: `lib/gemini/research-schema.ts`
- Create: `scripts/test-research-schema-shape.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing schema-shape smoke**

`scripts/test-research-schema-shape.ts`:
```ts
/**
 * 単位テスト: researchOutputSchema が Gemini SDK の Schema 型として
 *   受け入れ可能か、required フィールドが ResearchOutput と一致しているか。
 * 実行: npm run test:research-schema-shape
 */
import { researchOutputSchema } from "../lib/gemini/research-schema";
import { SchemaType } from "@google/generative-ai";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function main(): void {
  // 1) Root is OBJECT
  assert(researchOutputSchema.type === SchemaType.OBJECT, "root.type should be OBJECT");

  // 2) properties has all required research keys
  const props = (researchOutputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  const expected = [
    "marketability_score", "marketability_description", "demographics", "seasonality",
    "cogs_estimate", "influencers", "content_ideas", "competitor_analysis",
    "recommended_price_range", "broadcast_scripts", "japan_export_fit_score",
    "distribution_channels", "pricing_strategy", "marketing_strategy",
    "korea_market_fit", "live_commerce",
  ];
  for (const key of expected) {
    assert(key in props, `properties missing key: ${key}`);
  }

  // 3) required = expected (same length, same values)
  const required = (researchOutputSchema as { required?: string[] }).required ?? [];
  assert(required.length === expected.length, `required length mismatch (got ${required.length}, expected ${expected.length})`);
  for (const key of expected) {
    assert(required.includes(key), `required missing: ${key}`);
  }

  // 4) marketability_score is integer with 0..100 bounds
  const m = props.marketability_score as { type?: SchemaType; minimum?: number; maximum?: number };
  assert(m.type === SchemaType.INTEGER, "marketability_score type should be INTEGER");
  assert(m.minimum === 0 && m.maximum === 100, "marketability_score bounds should be [0,100]");

  // 5) korea_market_fit.properties.fit_score nested check
  const k = props.korea_market_fit as { properties?: { fit_score?: { type?: SchemaType; minimum?: number; maximum?: number } } };
  assert(k.properties?.fit_score?.type === SchemaType.INTEGER, "korea_market_fit.fit_score type should be INTEGER");
  assert(k.properties.fit_score.minimum === 0 && k.properties.fit_score.maximum === 100, "korea_market_fit.fit_score bounds should be [0,100]");

  // 6) influencers is ARRAY with minItems/maxItems
  const inf = props.influencers as { type?: SchemaType; minItems?: number; maxItems?: number };
  assert(inf.type === SchemaType.ARRAY, "influencers type should be ARRAY");
  assert(typeof inf.minItems === "number" && typeof inf.maxItems === "number", "influencers should have minItems and maxItems");

  console.log("[ok] researchOutputSchema shape 検証通過 (16 required keys, nested bounds OK)");
}

main();
```

- [ ] **Step 2: Run failing test**

```bash
npm run test:research-schema-shape
```
Expected: FAIL — module not found.

- [ ] **Step 3: Wire up npm script**

Add to `package.json`:
```json
"test:research-schema-shape": "tsx scripts/test-research-schema-shape.ts"
```

- [ ] **Step 4: Implement `lib/gemini/research-schema.ts`**

```ts
import { SchemaType, type Schema } from "@google/generative-ai";

const channelType: Schema = {
  type: SchemaType.STRING,
  enum: ["TV通販", "EC", "SNSコマース", "カタログ通販", "クラウドファンディング", "メディア", "オフライン", "その他"],
  format: "enum",
};

const distributionChannelItem: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    channel_name: { type: SchemaType.STRING },
    channel_type: channelType,
    primary_age_group: { type: SchemaType.STRING },
    fit_score: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
    reason: { type: SchemaType.STRING },
    monthly_visitors: { type: SchemaType.STRING },
    commission_rate: { type: SchemaType.STRING },
    url: { type: SchemaType.STRING },
    broadcaster: { type: SchemaType.STRING },
    evidence_sources: {
      type: SchemaType.ARRAY,
      maxItems: 2,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          title: { type: SchemaType.STRING },
          url: { type: SchemaType.STRING },
          snippet: { type: SchemaType.STRING },
        },
        required: ["title", "url", "snippet"],
      },
    },
    similar_products_on_channel: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          product_name: { type: SchemaType.STRING },
          price: { type: SchemaType.STRING },
          source_url: { type: SchemaType.STRING },
        },
        required: ["product_name"],
      },
    },
    scoring_breakdown: {
      type: SchemaType.OBJECT,
      properties: {
        demographic_match: { type: SchemaType.INTEGER, minimum: 0, maximum: 25 },
        category_track_record: { type: SchemaType.INTEGER, minimum: 0, maximum: 25 },
        price_point_fit: { type: SchemaType.INTEGER, minimum: 0, maximum: 25 },
        presentation_format_fit: { type: SchemaType.INTEGER, minimum: 0, maximum: 25 },
      },
      required: ["demographic_match", "category_track_record", "price_point_fit", "presentation_format_fit"],
    },
  },
  required: ["channel_name", "channel_type", "primary_age_group", "fit_score", "reason", "scoring_breakdown"],
};

export const researchOutputSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    marketability_score: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
    marketability_description: { type: SchemaType.STRING },

    demographics: {
      type: SchemaType.OBJECT,
      properties: {
        age_group: { type: SchemaType.STRING },
        gender: { type: SchemaType.STRING },
        interests: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        income_level: { type: SchemaType.STRING },
      },
      required: ["age_group", "gender", "interests", "income_level"],
    },

    seasonality: {
      type: SchemaType.OBJECT,
      properties: {
        jan: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
        feb: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
        mar: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
        apr: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
        may: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
        jun: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
        jul: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
        aug: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
        sep: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
        oct: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
        nov: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
        dec: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
      },
      required: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
    },

    cogs_estimate: {
      type: SchemaType.OBJECT,
      properties: {
        items: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              supplier: { type: SchemaType.STRING },
              estimated_cost: { type: SchemaType.STRING },
              moq: { type: SchemaType.STRING },
              link: { type: SchemaType.STRING },
            },
            required: ["supplier", "estimated_cost", "moq"],
          },
        },
        summary: { type: SchemaType.STRING },
      },
      required: ["items", "summary"],
    },

    influencers: {
      type: SchemaType.ARRAY,
      minItems: 3,
      maxItems: 5,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          name: { type: SchemaType.STRING },
          platform: { type: SchemaType.STRING },
          followers: { type: SchemaType.STRING },
          match_reason: { type: SchemaType.STRING },
          profile_url: { type: SchemaType.STRING },
        },
        required: ["name", "platform", "followers", "match_reason"],
      },
    },

    content_ideas: {
      type: SchemaType.ARRAY,
      minItems: 3,
      maxItems: 5,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          title: { type: SchemaType.STRING },
          description: { type: SchemaType.STRING },
          format: { type: SchemaType.STRING },
        },
        required: ["title", "description", "format"],
      },
    },

    competitor_analysis: {
      type: SchemaType.ARRAY,
      minItems: 3,
      maxItems: 3,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          name: { type: SchemaType.STRING },
          price: { type: SchemaType.STRING },
          platform: { type: SchemaType.STRING },
          key_difference: { type: SchemaType.STRING },
        },
        required: ["name", "price", "platform", "key_difference"],
      },
    },

    recommended_price_range: { type: SchemaType.STRING },

    broadcast_scripts: {
      type: SchemaType.OBJECT,
      properties: {
        sec30: { type: SchemaType.STRING },
        sec60: { type: SchemaType.STRING },
        min5: { type: SchemaType.STRING },
      },
      required: ["sec30", "sec60", "min5"],
    },

    japan_export_fit_score: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },

    distribution_channels: {
      type: SchemaType.ARRAY,
      minItems: 6,
      maxItems: 10,
      items: distributionChannelItem,
    },

    pricing_strategy: {
      type: SchemaType.OBJECT,
      properties: {
        channel_pricing: {
          type: SchemaType.ARRAY,
          minItems: 2,
          maxItems: 4,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              channel: { type: SchemaType.STRING },
              benchmark_price: { type: SchemaType.STRING },
              recommended_price: { type: SchemaType.STRING },
              estimated_margin_pct: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
              reason: { type: SchemaType.STRING },
            },
            required: ["channel", "benchmark_price", "recommended_price", "estimated_margin_pct", "reason"],
          },
        },
        bep_analysis: {
          type: SchemaType.OBJECT,
          properties: {
            estimated_cogs_per_unit: { type: SchemaType.STRING },
            fixed_cost_assumption: { type: SchemaType.STRING },
            bep_units_per_channel: {
              type: SchemaType.ARRAY,
              items: {
                type: SchemaType.OBJECT,
                properties: {
                  channel: { type: SchemaType.STRING },
                  bep_units: { type: SchemaType.INTEGER, minimum: 0 },
                  bep_revenue: { type: SchemaType.STRING },
                },
                required: ["channel", "bep_units", "bep_revenue"],
              },
            },
            summary: { type: SchemaType.STRING },
          },
          required: ["estimated_cogs_per_unit", "fixed_cost_assumption", "bep_units_per_channel", "summary"],
        },
      },
      required: ["channel_pricing", "bep_analysis"],
    },

    marketing_strategy: {
      type: SchemaType.ARRAY,
      minItems: 3,
      maxItems: 5,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          strategy_name: { type: SchemaType.STRING },
          type: { type: SchemaType.STRING },
          estimated_cost: { type: SchemaType.STRING },
          expected_reach: { type: SchemaType.STRING },
          efficiency_score: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
          steps: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          best_for_channels: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        },
        required: ["strategy_name", "type", "estimated_cost", "expected_reach", "efficiency_score", "steps", "best_for_channels"],
      },
    },

    korea_market_fit: {
      type: SchemaType.OBJECT,
      properties: {
        fit_score: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
        target_products: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        recommended_channels: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              channel_name: { type: SchemaType.STRING },
              target_age: { type: SchemaType.STRING },
              strategy: { type: SchemaType.STRING },
              estimated_entry_cost: { type: SchemaType.STRING },
            },
            required: ["channel_name", "target_age", "strategy", "estimated_entry_cost"],
          },
        },
        korean_consumer_insight: { type: SchemaType.STRING },
      },
      required: ["fit_score", "target_products", "recommended_channels", "korean_consumer_insight"],
    },

    live_commerce: {
      type: SchemaType.OBJECT,
      properties: {
        platforms: {
          type: SchemaType.ARRAY,
          minItems: 3,
          maxItems: 3,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              platform_name: { type: SchemaType.STRING },
              platform_type: { type: SchemaType.STRING },
              target_audience: { type: SchemaType.STRING },
              fit_score: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
              reason: { type: SchemaType.STRING },
            },
            required: ["platform_name", "platform_type", "target_audience", "fit_score", "reason"],
          },
        },
        scripts: {
          type: SchemaType.OBJECT,
          properties: {
            instagram_live: { type: SchemaType.STRING },
            tiktok_live: { type: SchemaType.STRING },
            youtube_live: { type: SchemaType.STRING },
          },
          required: ["instagram_live", "tiktok_live", "youtube_live"],
        },
        talking_points: { type: SchemaType.ARRAY, minItems: 5, maxItems: 5, items: { type: SchemaType.STRING } },
        engagement_tips: { type: SchemaType.ARRAY, minItems: 3, maxItems: 3, items: { type: SchemaType.STRING } },
        recommended_products_angle: { type: SchemaType.STRING },
      },
      required: ["platforms", "scripts", "talking_points", "engagement_tips", "recommended_products_angle"],
    },
  },
  required: [
    "marketability_score", "marketability_description",
    "demographics", "seasonality", "cogs_estimate", "influencers",
    "content_ideas", "competitor_analysis", "recommended_price_range",
    "broadcast_scripts", "japan_export_fit_score",
    "distribution_channels", "pricing_strategy", "marketing_strategy",
    "korea_market_fit", "live_commerce",
  ],
};
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm run test:research-schema-shape
```
Expected: `[ok] researchOutputSchema shape 検証通過 (16 required keys, nested bounds OK)`.

- [ ] **Step 6: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add lib/gemini/research-schema.ts scripts/test-research-schema-shape.ts package.json
git commit -m "feat(gemini): full responseSchema for ResearchOutput + shape unit"
```

---

## Task 4: `parseResearchOutput` helper (schema + sanitization)

**Files:**
- Create: `lib/gemini/parse-research-output.ts`

This task is small and tightly coupled to Task 3, so it has only the implement step.

- [ ] **Step 1: Implement `lib/gemini/parse-research-output.ts`**

```ts
import type { ResearchOutput } from "../gemini";

/**
 * schema 適用後の text を ResearchOutput に変換する。
 *
 * - JSON.parse の上に Phase 1 の korea_market_fit.fit_score サニタイザを乗せる。
 *   schema が minimum/maximum を強制するが、防御的に Math.trunc + Number.isFinite で再正規化。
 * - schema 失敗で空応答 / 不正 JSON が返るケースは、呼び出し元 (retry helper) が catch して
 *   classifyGeminiError で kind 判定する。本関数は parse 失敗時に Error を throw するだけ。
 */
export function parseResearchOutput(text: string): ResearchOutput {
  const trimmed = text.trim();
  // schema mode で fence は付かないが、互換のため除去。
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse JSON from research synthesis: ${message}. Head: ${stripped.slice(0, 200)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Failed to parse JSON from research synthesis: not an object");
  }

  const research = parsed as ResearchOutput;

  // korea_market_fit.fit_score の整数化 (Phase 1 と同じ防御)
  if (research.korea_market_fit) {
    const raw = (research.korea_market_fit as { fit_score?: unknown }).fit_score;
    const num = typeof raw === "number" ? Math.trunc(raw) : Number.parseInt(String(raw ?? ""), 10);
    (research.korea_market_fit as { fit_score?: number | null }).fit_score = Number.isFinite(num) ? num : null;
  }

  return research;
}
```

- [ ] **Step 2: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add lib/gemini/parse-research-output.ts
git commit -m "feat(gemini): parseResearchOutput with korea_fit sanitization"
```

---

## Task 5: Refactor `synthesizeResearch` to use schema + retry + reordered prompt

**Files:**
- Modify: `lib/gemini.ts:244-482` (the `synthesizeResearch` function)

- [ ] **Step 1: Read current `synthesizeResearch`**

The function is at `lib/gemini.ts:244-482`. Current behaviour:
- `generationConfig: { maxOutputTokens: 32768, responseMimeType: "application/json" }`
- prose template followed by Web Search Results, broadcast context, channel reference (i.e. context appears AFTER output schema description because the schema description is embedded in the prompt body).
- 2 attempts, no backoff, attempt 2 appends a terser suffix.

Read the file to confirm exact lines.

- [ ] **Step 2: Apply the rewrite**

Replace the entire body of `synthesizeResearch` (between the function signature and the closing `}`) with:

```ts
	const modelName = GEMINI_FLASH;
	const model = genAI.getGenerativeModel({
		model: modelName,
		generationConfig: {
			maxOutputTokens: 32768,
			responseMimeType: "application/json",
			responseSchema: researchOutputSchema,
		},
	});

	const contextSections: string[] = [];
	contextSections.push("=== 入力商品情報 ===");
	contextSections.push(JSON.stringify(productInfo, null, 2));
	contextSections.push("");
	contextSections.push("=== Web検索結果 (Brave + Rakuten) ===");
	contextSections.push(
		Object.entries(searchResults)
			.map(([key, val]) => `## ${key}\n${val}`)
			.join("\n\n"),
	);
	if (broadcastContextPrompt && broadcastContextPrompt.trim().length > 0) {
		contextSections.push("");
		contextSections.push("=== 競合放送コンテキスト ===");
		contextSections.push(broadcastContextPrompt.trim());
	}
	contextSections.push("");
	contextSections.push("=== TVチャネル参考 ===");
	contextSections.push(buildChannelReferencePrompt());

	const businessGuide = `=== 出力ガイド ===
あなたは日本市場参入を専門とするホームショッピング・マーケティングリサーチアナリストです。
上記のコンテキストを根拠として、商品の市場性を多面的に分析してください。

ALL text values MUST be Japanese. Product names, URLs, numeric values may keep original form.

=== TV通販チャネル適合度 評価基準 ===
各チャネルのfit_scoreは4項目 (各0-25点) の合計で算出:
1. demographic_match (0-25): 商品ターゲット層とチャネル視聴者層の重なり (検索結果から視聴者データを引用 / データなし最大15点)
2. category_track_record (0-25): 類似カテゴリ商品の販売実績 (similar_products_on_channelに実商品名 / 実績データなし最大10点)
3. price_point_fit (0-25): 商品価格帯とチャネル平均価格帯の適合 (楽天/Amazon/競合データから根拠 / データなし最大15点)
4. presentation_format_fit (0-25): TV実演向き度合い (商品特性に基づく客観評価 / データなし最大15点)

CRITICAL RULES:
- evidence_sources は上記 Web Search Results に実在するURLのみ
- 検索データが全くないチャネルは fit_score 合計を 55 点以下に
- reason は「〇〇によると...」の形式でソースを引用
- similar_products_on_channel は検索で確認できた実在商品のみ

=== 件数ガイド ===
- competitor_analysis: 3件 (exact)
- distribution_channels: 6-10件 (TV通販の高 fit_score チャネル + 2-4 EC/その他)
  - fit_score = scoring_breakdown 4 項目の合計 (max 100)
  - evidence_sources: 各チャネル最大 2 件
- pricing_strategy.channel_pricing: 2-4 件
- marketing_strategy: 3-5 件 (efficiency_score 降順)
- live_commerce: 3 platforms / talking_points 5 / engagement_tips 3
- influencers: 3-5 件 / content_ideas: 3-5 件
- broadcast_scripts は日本語、JSON 1 行に収まる長さに

すべての必須フィールドを必ず明示生成してください。`;

	const basePrompt = `${contextSections.join("\n")}\n\n${businessGuide}`;

	return await callGeminiWithRetry(
		async (attempt, override) => {
			const prompt = override ? `${basePrompt}\n\n${override}` : basePrompt;
			const result = await model.generateContent(prompt);
			const text = result.response.text().trim();
			return { result: parseResearchOutput(text), responseText: text };
		},
		{
			maxAttempts: 3,
			baseDelayMs: 1000,
			promptForAttempt: (_attempt, kind) => buildSynthesizeAttemptOverride(kind),
		},
	);
}

function buildSynthesizeAttemptOverride(kind: GeminiErrorKind | undefined): string | null {
	if (!kind) return null;
	switch (kind) {
		case "parse_failed":
			return "前回の応答は不正なJSONでした。コードフェンスや前後の説明文を一切付けず、単一のJSONオブジェクトのみ返してください。";
		case "schema_validation_failed":
			return "前回の応答はスキーマ違反でした。すべての required フィールドを明示的に出力し、列挙値や数値範囲を厳守してください。";
		case "extract_empty":
			return "前回の応答は空でした。すべての required フィールドを必ず明示的に生成してください。空文字列禁止。";
		case "rate_limited":
		case "server_error":
		case "unknown":
		default:
			return null;
	}
}
```

Also add to the imports at the top of `lib/gemini.ts`:
```ts
import { callGeminiWithRetry } from "@/lib/gemini/retry";
import { researchOutputSchema } from "@/lib/gemini/research-schema";
import { parseResearchOutput } from "@/lib/gemini/parse-research-output";
import type { GeminiErrorKind } from "@/lib/gemini/errors";
```

- [ ] **Step 3: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add lib/gemini.ts
git commit -m "feat(synthesize): adopt responseSchema + callGeminiWithRetry + reordered prompt

Context (search results / broadcast / channel ref) now precedes business
guide. responseSchema enforces field types. parse_failed / schema_validation_failed
/ extract_empty trigger attempt-2 prompt augmentation."
```

---

## Task 6: Refactor `extractProductInfo` to accept files array

**Files:**
- Modify: `lib/gemini.ts:209-242`

- [ ] **Step 1: Replace function signature + body**

Replace the existing `extractProductInfo` (lib/gemini.ts:209-242) with:

```ts
export interface ExtractFile {
	base64: string;
	mimeType: string;
	fileName: string;
}

export async function extractProductInfo(
	files: ExtractFile[],
): Promise<ProductInfo> {
	if (files.length === 0) {
		throw new Error("extractProductInfo called with empty files array");
	}
	const model = genAI.getGenerativeModel({ model: GEMINI_FLASH });

	const fileList = files.map((f, i) => `${i + 1}. ${f.fileName} (${f.mimeType})`).join("\n");

	const prompt = `あなたはホームショッピングチャネル向けの商品アナリストです。添付ファイルを解析し、商品情報をすべて抽出してください。

複数のファイルが添付されている場合、すべて同一商品の異なる面 (表面/裏面/パッケージ/詳細写真/カタログPDF 等) として総合的に判断してください。複数の異なる商品が混在する場合は、最も主要な1つに絞ってください。

出力 JSON のすべての値は日本語で記述してください。商品名/カテゴリ/特徴/対象市場/価格帯すべて日本語のみ。

JSONオブジェクトを返してください (フィールド):
- name: 商品名 (string)
- description: 詳細な商品説明 (string)
- features: 主な商品特徴 (string の配列)
- category: 商品カテゴリ (string)
- price_range: 言及されていれば価格帯 (string, optional)
- target_market: 言及されていればターゲット市場 (string, optional)

添付ファイル一覧:
${fileList}

JSONオブジェクトのみ返してください。コードフェンス・前後の説明文は禁止。`;

	const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
		{ text: prompt },
	];
	for (const f of files) {
		parts.push({ inlineData: { mimeType: f.mimeType, data: f.base64 } });
	}

	return await callGeminiWithRetry(
		async (_attempt, override) => {
			const effectiveParts = override
				? [{ text: `${prompt}\n\n${override}` }, ...parts.slice(1)]
				: parts;
			const result = await model.generateContent(effectiveParts);
			const text = result.response.text().trim();
			return {
				result: parseJsonFromModelText<ProductInfo>(text, "product extraction"),
				responseText: text,
			};
		},
		{
			maxAttempts: 3,
			baseDelayMs: 1000,
			promptForAttempt: (_attempt, kind) => {
				if (!kind) return null;
				if (kind === "parse_failed") {
					return "前回の応答は不正なJSONでした。コードフェンスや前後の説明文を一切付けず、単一のJSONオブジェクトのみ返してください。";
				}
				if (kind === "extract_empty") {
					return "前回の応答は空でした。必須キー (name, description, features, category) をすべて明示的に出力してください。";
				}
				return null;
			},
		},
	);
}
```

- [ ] **Step 2: Verify all callers of `extractProductInfo`**

Run the Grep tool with pattern `extractProductInfo` to find all callers. Each must now pass an array.

Existing callers (expect at minimum):
- `app/api/analyze/route.ts:28` — currently passes 3 individual args. Will be updated in Task 7.
- `lib/discovery/enrich/...` or similar — wraps single URL fetch.

For any unupdated caller that breaks TS, wrap the args temporarily: `extractProductInfo([{ base64: fileBase64, mimeType, fileName }])`. The `/api/analyze` route is updated properly in Task 7; other callers (single-file paths) get the 1-element-array wrap inline.

- [ ] **Step 3: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors. All callers compile.

- [ ] **Step 4: Commit**

```bash
git add lib/gemini.ts $(any caller files modified to compile)
git commit -m "feat(extract): accept files array + JA-output + retry helper

Single-file callers wrap as 1-element array. Prompt now in Japanese with
explicit multi-file aggregation rule and output-language rule."
```

---

## Task 7: `/api/analyze` body shape (files[]) + size guards

**Files:**
- Modify: `app/api/analyze/route.ts`

- [ ] **Step 1: Read current `/api/analyze/route.ts`**

Current body parse: `const { productId, fileBase64, mimeType, fileName } = await request.json();` and `extractProductInfo(fileBase64, mimeType, fileName)`.

- [ ] **Step 2: Update body parsing + caller**

Replace the body parse + extract section with:

```ts
	type AnalyzeFile = { base64: string; mimeType: string; fileName: string };
	const body = await request.json() as {
		productId: string;
		files?: AnalyzeFile[];
		fileBase64?: string;
		mimeType?: string;
		fileName?: string;
	};
	const { productId } = body;

	let files: AnalyzeFile[];
	if (Array.isArray(body.files) && body.files.length > 0) {
		files = body.files;
	} else if (body.fileBase64 && body.mimeType && body.fileName) {
		files = [{ base64: body.fileBase64, mimeType: body.mimeType, fileName: body.fileName }];
	} else {
		await supabase
			.from("products")
			.update({ status: "failed", error_reason: "no_files" })
			.eq("id", productId);
		return NextResponse.json({ error: "no files supplied" }, { status: 400 });
	}

	const MAX_SINGLE_FILE_MB = 15;
	const MAX_TOTAL_PAYLOAD_MB = 20;
	const sizeOf = (b64: string): number => Math.ceil(b64.length * 0.75); // approx decoded bytes
	for (const f of files) {
		if (sizeOf(f.base64) > MAX_SINGLE_FILE_MB * 1024 * 1024) {
			await supabase
				.from("products")
				.update({ status: "failed", error_reason: "file_too_large" })
				.eq("id", productId);
			return NextResponse.json({ error: `file '${f.fileName}' exceeds ${MAX_SINGLE_FILE_MB}MB` }, { status: 400 });
		}
	}
	let totalBytes = files.reduce((s, f) => s + sizeOf(f.base64), 0);
	if (totalBytes > MAX_TOTAL_PAYLOAD_MB * 1024 * 1024) {
		// Drop trailing files (largest-last assumption acceptable; primary is files[0]).
		files = [...files].sort((a, b) => sizeOf(b.base64) - sizeOf(a.base64));
		const kept: AnalyzeFile[] = [];
		let sum = 0;
		for (const f of files) {
			if (sum + sizeOf(f.base64) > MAX_TOTAL_PAYLOAD_MB * 1024 * 1024) continue;
			kept.push(f);
			sum += sizeOf(f.base64);
		}
		files = kept;
		console.warn(`[${productId}] truncated to ${files.length} files (total ~${(sum / 1e6).toFixed(1)}MB)`);
	}
```

Then update the `extractProductInfo` call:
```ts
		const productInfo = await extractProductInfo(files);
```

(Remove the previous 3-arg call.)

- [ ] **Step 3: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/analyze/route.ts
git commit -m "feat(analyze): accept files[] body + size guards + no_files mark

Legacy { fileBase64, mimeType, fileName } body wrapped as 1-element array.
> 15MB single / > 20MB total triggers 400 + error_reason. Total overflow
trims smallest-first to fit under 20MB."
```

---

## Task 8: `/api/upload` passes all files

**Files:**
- Modify: `app/api/upload/route.ts:170-187` (the `/api/analyze` trigger)

- [ ] **Step 1: Replace the analyze trigger**

The current code base64-encodes only the primary file. Replace with:

```ts
    // Trigger async analysis with all files
    const baseUrl = request.nextUrl.origin;
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      console.warn('[upload] CRON_SECRET not set; async analyze trigger may be rejected');
    }

    const filesBody = uploadedFiles.map((f) => ({
      base64: Buffer.from(f.fileBytes).toString('base64'),
      mimeType: f.mimeType,
      fileName: f.fileName,
    }));

    fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: buildAnalyzeTriggerHeaders(cronSecret),
      body: JSON.stringify({
        productId: product.id,
        files: filesBody,
        locale,
      }),
    }).catch(console.error);
```

- [ ] **Step 2: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/upload/route.ts
git commit -m "feat(upload): forward all files to /api/analyze

Previously only files[0] reached extract; rest were stored but never
analysed."
```

---

## Task 9: Refactor `analyzeExpansionStrategy` to use retry helper

**Files:**
- Modify: `lib/gemini.ts:545-616`

- [ ] **Step 1: Replace the function body**

The current body builds prompt then does `model.generateContent(prompt)` + raw regex extract. Replace the final block (currently lines 610-615) with:

```ts
	return await callGeminiWithRetry(
		async (_attempt, override) => {
			const effective = override ? `${prompt}\n\n${override}` : prompt;
			const result = await model.generateContent(effective);
			const text = result.response.text().trim();
			return {
				result: parseJsonFromModelText<ExpansionAnalysisResult>(text, "expansion analysis"),
				responseText: text,
			};
		},
		{
			maxAttempts: 3,
			baseDelayMs: 1000,
			promptForAttempt: (_attempt, kind) => {
				if (!kind) return null;
				if (kind === "parse_failed") {
					return "前回の応答は不正なJSONでした。コードフェンスや前後の説明文を一切付けず、単一のJSONオブジェクトのみ返してください。";
				}
				if (kind === "extract_empty") {
					return "前回の応答は空でした。すべてのフィールドを明示的に出力してください。";
				}
				return null;
			},
		},
	);
}
```

- [ ] **Step 2: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add lib/gemini.ts
git commit -m "feat(expansion-strategy): adopt callGeminiWithRetry + parseJsonFromModelText

Replaces 1-shot + regex extractor with the shared retry helper and the
balanced-brace parser."
```

---

## Task 10: `loadBroadcastContext` non-swallow + `synthesize-product` integration

**Files:**
- Modify: `lib/research/competitor-context.ts:161-164`
- Modify: `lib/research/synthesize-product.ts` (loadBroadcastContext call site)

- [ ] **Step 1: Read both files**

`competitor-context.ts:161-164` currently:
```ts
	} catch (err) {
		console.warn("[competitor-context] query failed:", err);
		return null;
	}
```

`synthesize-product.ts` calls `loadBroadcastContext(productInfo.category)` and uses the result unconditionally with `formatBroadcastContextPrompt`.

- [ ] **Step 2: Add an exported error type to `competitor-context.ts`**

Replace the catch at lines 161-164 with:
```ts
	} catch (err) {
		throw new BroadcastContextLoadError(
			err instanceof Error ? err.message : String(err),
			err,
		);
	}
```

Add near the top of `competitor-context.ts` (after imports):
```ts
export class BroadcastContextLoadError extends Error {
	constructor(message: string, public readonly cause?: unknown) {
		super(message);
		this.name = "BroadcastContextLoadError";
	}
}
```

- [ ] **Step 3: Update `synthesize-product.ts` to handle the error**

Find the existing block that calls `loadBroadcastContext` (search for `loadBroadcastContext(`). Wrap it:

```ts
		let broadcastContext: Awaited<ReturnType<typeof loadBroadcastContext>> = null;
		try {
			broadcastContext = await loadBroadcastContext(productInfo.category);
		} catch (err) {
			console.warn(`[${productId}] broadcast context load failed:`, err);
			const msg = err instanceof Error ? err.message.slice(0, 300) : "unknown";
			// soft-mark; status stays 'analyzing'. markProductStatus("completed", null) later clears it.
			await sb.from("products")
				.update({ error_reason: `context_load_failed: ${msg}` })
				.eq("id", productId);
			broadcastContext = null;
		}
		const broadcastContextPrompt = formatBroadcastContextPrompt(broadcastContext);
```

- [ ] **Step 4: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 5: Run Phase 1 + Phase 2 smokes to confirm no regression**

```bash
npm run test:research-data-model
npm run test:research-stuck-detector
```
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/research/competitor-context.ts lib/research/synthesize-product.ts
git commit -m "fix(research): surface broadcast context load failure via error_reason

Drops the silent catch. synthesize-product now soft-marks
'context_load_failed: ...' and proceeds without context. Success path
clears error_reason to null."
```

---

## Task 11: `synthesize-product.ts` surfaces `GeminiCallError` kind

**Files:**
- Modify: `lib/research/synthesize-product.ts` (catch block)

- [ ] **Step 1: Read the current catch**

After Phase 2, the catch block writes `synthesis_failed: <message>`. We now want to preserve `GeminiCallError.kind` as the prefix.

- [ ] **Step 2: Update the catch**

Replace:
```ts
	} catch (error) {
		console.error(`[${productId}] Synthesis failed:`, error);
		const reason = error instanceof Error
			? `synthesis_failed: ${error.message.slice(0, 500)}`
			: "synthesis_failed: unknown";
		try {
			await markProductStatus(sb, productId, "failed", reason);
		} catch (statusError) {
			console.error(`[${productId}] Failed to mark synthesis failure:`, statusError);
		}
		throw new ProductResearchSynthesisError(500, "Synthesis failed", error);
	}
```

with:
```ts
	} catch (error) {
		console.error(`[${productId}] Synthesis failed:`, error);
		let reason: string;
		if (error instanceof GeminiCallError) {
			// "kind: summary after N attempts" 形式 (errors.ts の Error.message が直接適切)
			reason = error.message.slice(0, 500);
		} else if (error instanceof Error) {
			reason = `synthesis_failed: ${error.message.slice(0, 500)}`;
		} else {
			reason = "synthesis_failed: unknown";
		}
		try {
			await markProductStatus(sb, productId, "failed", reason);
		} catch (statusError) {
			console.error(`[${productId}] Failed to mark synthesis failure:`, statusError);
		}
		throw new ProductResearchSynthesisError(500, "Synthesis failed", error);
	}
```

And add to imports at the top:
```ts
import { GeminiCallError } from "@/lib/gemini/errors";
```

- [ ] **Step 3: TS check + smoke**

```bash
npx tsc --noEmit
npm run test:research-data-model
```
Expected: 0 errors + PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/research/synthesize-product.ts
git commit -m "feat(research): preserve GeminiCallError kind in error_reason

When synthesize throws GeminiCallError, error_reason becomes
'<kind>: <summary> after N attempts' instead of opaque synthesis_failed."
```

---

## Task 12: `analyze` route catch surfaces `GeminiCallError` kind (extract path)

**Files:**
- Modify: `app/api/analyze/route.ts` (the existing catch block from Phase 2)

- [ ] **Step 1: Update extract catch**

Phase 2 introduced:
```ts
	} catch (error) {
		console.error(`[${productId}] Extraction failed:`, error);
		const reason = error instanceof Error
			? `extract_failed: ${error.message.slice(0, 500)}`
			: "extract_failed: unknown";
		await supabase
			.from("products")
			.update({ status: "failed", error_reason: reason })
			.eq("id", productId);
		return NextResponse.json({ error: "Analysis failed" }, { status: 500 });
	}
```

Replace with:
```ts
	} catch (error) {
		console.error(`[${productId}] Extraction failed:`, error);
		let reason: string;
		if (error instanceof GeminiCallError) {
			reason = error.message.slice(0, 500);
		} else if (error instanceof Error) {
			reason = `extract_failed: ${error.message.slice(0, 500)}`;
		} else {
			reason = "extract_failed: unknown";
		}
		await supabase
			.from("products")
			.update({ status: "failed", error_reason: reason })
			.eq("id", productId);
		return NextResponse.json({ error: "Analysis failed" }, { status: 500 });
	}
```

Add to imports:
```ts
import { GeminiCallError } from "@/lib/gemini/errors";
```

- [ ] **Step 2: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/analyze/route.ts
git commit -m "feat(analyze): preserve GeminiCallError kind on extract failure"
```

---

## Task 13: `error-reason-explain` helper + unit smoke

**Files:**
- Create: `lib/research/error-reason-explain.ts`
- Create: `scripts/test-error-reason-explain.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing unit**

`scripts/test-error-reason-explain.ts`:
```ts
/**
 * 単位テスト: explainErrorReason の kind マッピングカバレッジ。
 * 実行: npm run test:error-reason-explain
 */
import { explainErrorReason, ERROR_REASON_LABELS_JA, ERROR_REASON_LABELS_KO } from "../lib/research/error-reason-explain";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function main(): void {
  const kinds = [
    "safety_blocked", "rate_limited", "server_error", "parse_failed",
    "schema_validation_failed", "extract_empty", "context_load_failed",
    "cron_secret_missing", "trigger_not_invoked", "analysis_timeout",
    "extract_failed", "synthesis_failed", "file_too_large", "no_files", "unknown",
  ];

  for (const kind of kinds) {
    assert(typeof ERROR_REASON_LABELS_JA[kind] === "string", `JA label missing for ${kind}`);
    assert(typeof ERROR_REASON_LABELS_KO[kind] === "string", `KO label missing for ${kind}`);
  }

  // explainErrorReason with prefix
  assert(explainErrorReason("safety_blocked: HATE_SPEECH at attempt 1", "ja") !== ERROR_REASON_LABELS_JA.unknown,
    "safety_blocked prefix → specific message");
  assert(explainErrorReason("synthesis_failed: Bad gateway", "ja") !== ERROR_REASON_LABELS_JA.unknown,
    "synthesis_failed prefix → specific message");

  // null → unknown
  assert(explainErrorReason(null, "ja") === ERROR_REASON_LABELS_JA.unknown,
    "null reason → unknown label JA");
  assert(explainErrorReason(null, "ko") === ERROR_REASON_LABELS_KO.unknown,
    "null reason → unknown label KO");

  // unmatched kind → unknown
  assert(explainErrorReason("totally_new_kind: blah", "ja") === ERROR_REASON_LABELS_JA.unknown,
    "unmatched prefix → unknown");

  console.log("[ok] error-reason-explain 全15 kind + null + unknown 通過");
}

main();
```

- [ ] **Step 2: Run failing test**

```bash
npm run test:error-reason-explain
```
Expected: FAIL.

- [ ] **Step 3: Wire up npm script**

Add to `package.json`:
```json
"test:error-reason-explain": "tsx scripts/test-error-reason-explain.ts"
```

- [ ] **Step 4: Implement `lib/research/error-reason-explain.ts`**

```ts
export type ErrorReasonLocale = "ja" | "ko";

export const ERROR_REASON_LABELS_JA: Record<string, string> = {
  safety_blocked: "コンテンツが安全フィルタで拒否されました。内容を見直して再アップロードしてください",
  rate_limited: "AI処理が混雑しています。数分後にもう一度お試しください",
  server_error: "AIサーバーが一時的に応答していません。再アップロードをお試しください",
  parse_failed: "AIの出力解析に失敗しました。管理者が確認します",
  schema_validation_failed: "AIの出力形式に問題がありました。管理者が確認します",
  extract_empty: "AIから空の応答が返りました。再アップロードをお試しください",
  context_load_failed: "市場データの読み込みに失敗しました。再アップロードで通常は回復します",
  cron_secret_missing: "システム設定エラー — 管理者対応中",
  trigger_not_invoked: "処理が開始されませんでした。再アップロードしてください",
  analysis_timeout: "分析がタイムアウトしました。再アップロードしてください",
  extract_failed: "ファイル解析に失敗しました。ファイル形式をご確認ください (PDF/PPTX/DOCX/画像)",
  synthesis_failed: "市場調査の生成に失敗しました。再アップロードをお試しください",
  file_too_large: "ファイルサイズが上限 (15MB) を超えています",
  no_files: "ファイルが添付されていません",
  unknown: "原因不明 — 管理者にお問い合わせください",
};

export const ERROR_REASON_LABELS_KO: Record<string, string> = {
  safety_blocked: "콘텐츠가 안전 필터에 의해 거부되었습니다. 내용을 수정 후 다시 업로드해 주세요",
  rate_limited: "AI 처리가 혼잡합니다. 몇 분 후 다시 시도해 주세요",
  server_error: "AI 서버가 일시적으로 응답하지 않습니다. 다시 업로드해 주세요",
  parse_failed: "AI 출력 파싱에 실패했습니다. 관리자가 확인 중입니다",
  schema_validation_failed: "AI 출력 형식에 문제가 있었습니다. 관리자가 확인 중입니다",
  extract_empty: "AI 가 빈 응답을 반환했습니다. 다시 업로드해 주세요",
  context_load_failed: "시장 데이터 로딩에 실패했습니다. 재업로드로 보통 회복됩니다",
  cron_secret_missing: "시스템 설정 오류 — 관리자 대응 중",
  trigger_not_invoked: "처리가 시작되지 않았습니다. 다시 업로드해 주세요",
  analysis_timeout: "분석이 타임아웃되었습니다. 다시 업로드해 주세요",
  extract_failed: "파일 해석에 실패했습니다. 파일 형식을 확인해 주세요 (PDF/PPTX/DOCX/이미지)",
  synthesis_failed: "시장 조사 생성에 실패했습니다. 다시 업로드해 주세요",
  file_too_large: "파일 사이즈가 상한 (15MB) 을 초과했습니다",
  no_files: "파일이 첨부되지 않았습니다",
  unknown: "원인 불명 — 관리자에게 문의해 주세요",
};

export function explainErrorReason(
  reason: string | null,
  locale: ErrorReasonLocale = "ja",
): string {
  const table = locale === "ko" ? ERROR_REASON_LABELS_KO : ERROR_REASON_LABELS_JA;
  if (!reason) return table.unknown;
  const kind = reason.split(":")[0].trim();
  return table[kind] ?? table.unknown;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm run test:error-reason-explain
```
Expected: `[ok] error-reason-explain 全15 kind + null + unknown 通過`.

- [ ] **Step 6: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add lib/research/error-reason-explain.ts scripts/test-error-reason-explain.ts package.json
git commit -m "feat(research): explainErrorReason helper (JA/KO) + 15-kind unit"
```

---

## Task 14: `ProductList` 12-minute polling cap

**Files:**
- Modify: `components/ProductList.tsx:36-45`

- [ ] **Step 1: Replace the polling effect**

Find lines 36-45 (the "Auto-refresh if any products are analyzing" effect). Replace with:

```tsx
  // Auto-refresh while any product is still in pending/analyzing within the 12-min cap.
  // 12 min = stuck-detector 10-min threshold + 2-min clock-drift buffer.
  const POLL_CAP_MIN = 12;
  useEffect(() => {
    const stillPollable = products.some((p) => {
      if (p.status !== 'pending' && p.status !== 'analyzing') return false;
      const ageMin = (Date.now() - new Date(p.created_at).getTime()) / 60000;
      return ageMin < POLL_CAP_MIN;
    });
    if (!stillPollable) return;

    const interval = setInterval(fetchProducts, 5000);
    return () => clearInterval(interval);
  }, [products, fetchProducts]);
```

- [ ] **Step 2: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add components/ProductList.tsx
git commit -m "feat(ui): cap polling at 12 minutes per product

Previously polling ran forever while any product stayed in analyzing.
12-min cap aligns with the stuck-detector 10-min threshold + 2-min buffer."
```

---

## Task 15: `ProductCard` elapsed-time + failure message

**Files:**
- Modify: `components/ProductCard.tsx`

- [ ] **Step 1: Add `useEffect` + state for elapsed-time + failure message**

Replace the entire `ProductCard` component body (after the `statusConfig` constant) with:

```tsx
function elapsedMinutes(createdAt: string): number {
	return Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000));
}

export default function ProductCard({ product }: ProductCardProps) {
	const locale = useLocale();
	const t = useTranslations("home");
	const config =
		statusConfig[product.status as keyof typeof statusConfig] ||
		statusConfig.pending;
	const Icon = config.icon;

	const [elapsed, setElapsed] = useState(() => elapsedMinutes(product.created_at));
	useEffect(() => {
		if (product.status !== "analyzing" && product.status !== "pending") return;
		const id = setInterval(() => setElapsed(elapsedMinutes(product.created_at)), 30000);
		return () => clearInterval(id);
	}, [product.status, product.created_at]);

	const isStale = elapsed >= 5 && elapsed < 12;
	const stuckHinted = elapsed >= 12;

	return (
		<Card className="hover:shadow-md transition-shadow duration-200 border border-border">
			<CardContent className="p-5">
				<div className="flex items-start justify-between gap-3">
					<div className="flex items-start gap-3 flex-1 min-w-0">
						<div className="w-10 h-10 bg-blue-600/10 rounded-lg flex items-center justify-center flex-shrink-0">
							<FileText size={20} className="text-blue-600" />
						</div>
						<div className="flex-1 min-w-0">
							<h3 className="font-semibold text-foreground truncate">
								{product.name}
							</h3>
							{product.description && (
								<p className="text-sm text-muted-foreground mt-1 line-clamp-2">
									{product.description}
								</p>
							)}
							<p className="text-xs text-muted-foreground mt-1">
								{new Date(product.created_at).toLocaleDateString()}
							</p>
						</div>
					</div>

					<div className="flex items-center gap-2 flex-shrink-0">
						<span
							className={`flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full ${config.color}`}
						>
							<Icon
								size={12}
								className={
									product.status === "analyzing" ? "animate-spin" : ""
								}
							/>
							{t(`status.${config.label}`)}
						</span>
					</div>
				</div>

				{/* Analyzing state — progress bar + elapsed message */}
				{product.status === "analyzing" && (
					<div className="mt-4 pt-4 border-t border-border">
						<div className="h-1.5 bg-muted rounded-full overflow-hidden">
							<div className={`h-full rounded-full animate-pulse w-2/3 ${stuckHinted ? "bg-amber-500" : isStale ? "bg-amber-400" : "bg-blue-500"}`} />
						</div>
						<p className={`text-xs mt-2 text-center ${isStale ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>
							{elapsed < 1
								? t("analyzingDefault")
								: t("analyzingWithElapsed", { minutes: elapsed })}
						</p>
						{isStale && (
							<p className="text-[10px] text-muted-foreground text-center mt-1">
								{t("analyzingWarning")}
							</p>
						)}
						{stuckHinted && (
							<p className="text-[10px] text-amber-700 dark:text-amber-300 text-center mt-1">
								{t("analyzingStuck")}
							</p>
						)}
					</div>
				)}

				{product.status === "failed" && (
					<div className="mt-4 pt-4 border-t border-border">
						<p className="text-xs text-red-700 dark:text-red-300">
							{explainErrorReason(product.error_reason, locale === "ko" ? "ko" : "ja")}
						</p>
						<Link
							href={localePath(locale, "/")}
							className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
						>
							{t("reuploadLink")}
							<ArrowRight size={12} />
						</Link>
					</div>
				)}

				{product.status === "completed" && (
					<div className="mt-4 pt-4 border-t border-border">
						<Link
							href={localePath(locale, `/products/${product.id}`)}
							className="flex items-center justify-center gap-2 w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors"
						>
							{t("viewReport")}
							<ArrowRight size={14} />
						</Link>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
```

Add at top of file:
```tsx
import { useEffect, useState } from "react";
import { explainErrorReason } from "@/lib/research/error-reason-explain";
```

- [ ] **Step 2: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add components/ProductCard.tsx
git commit -m "feat(ui): elapsed-time badge + failure message + reupload link

Analyzing cards show '分析中... (N分経過)', amber tint after 5min, '停滞検出中'
hint after 12min. Failed cards show kind-mapped JA/KO message + reupload link."
```

---

## Task 16: i18n keys for new UI strings

**Files:**
- Modify: `messages/ja.json`
- Modify: `messages/ko.json`

- [ ] **Step 1: Add JA keys**

In `messages/ja.json`, find the `"home"` section. Add the new keys (preserve existing keys):

```json
{
  "home": {
    "...existing keys...": "...",
    "analyzingDefault": "分析中...",
    "analyzingWithElapsed": "分析中... ({minutes}分経過)",
    "analyzingWarning": "通常2-3分で完了します",
    "analyzingStuck": "停滞検出中",
    "reuploadLink": "再アップロード"
  }
}
```

- [ ] **Step 2: Add KO keys**

In `messages/ko.json`, mirror in Korean:

```json
{
  "home": {
    "...existing keys...": "...",
    "analyzingDefault": "분석 중...",
    "analyzingWithElapsed": "분석 중... ({minutes}분 경과)",
    "analyzingWarning": "보통 2-3분 안에 완료됩니다",
    "analyzingStuck": "정체 감지 중",
    "reuploadLink": "다시 업로드"
  }
}
```

- [ ] **Step 3: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors (i18n keys are runtime-only, but verifying nothing else broke).

- [ ] **Step 4: Commit**

```bash
git add messages/ja.json messages/ko.json
git commit -m "i18n: add elapsed/warning/stuck/reupload keys for ProductCard"
```

---

## Task 17: Admin UI kind-prefix label map

**Files:**
- Modify: `app/[locale]/(admin)/admin/research-pipeline/page.tsx`

- [ ] **Step 1: Add label map + replace plain error_reason rendering**

The current page renders `{p.error_reason ?? "理由不明"}` for failed cards. Update to use a kind-based label:

Add near the top of the file (after imports):
```tsx
const ERROR_REASON_LABELS: Record<string, string> = {
	safety_blocked: "セーフティブロック",
	rate_limited: "レート制限",
	server_error: "サーバーエラー",
	parse_failed: "JSON解析失敗",
	schema_validation_failed: "スキーマ検証失敗",
	extract_empty: "空応答",
	context_load_failed: "コンテキスト読込失敗",
	cron_secret_missing: "CRON_SECRET未設定",
	trigger_not_invoked: "トリガー未起動",
	analysis_timeout: "分析タイムアウト",
	extract_failed: "抽出失敗",
	synthesis_failed: "合成失敗",
	file_too_large: "ファイルサイズ超過",
	no_files: "ファイル未添付",
	unknown: "原因不明",
};

function labelOf(reason: string | null): string {
	if (!reason) return "理由不明";
	const kind = reason.split(":")[0].trim();
	return ERROR_REASON_LABELS[kind] ?? kind;
}
```

In the failed-section list rendering, replace:
```tsx
                    {p.error_reason ?? "理由不明"} · 失敗時刻: {p.updated_at.slice(11, 16)}
```

with:
```tsx
                    {labelOf(p.error_reason)} · {p.error_reason ?? "理由不明"} · 失敗時刻: {p.updated_at.slice(11, 16)}
```

- [ ] **Step 2: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add "app/[locale]/(admin)/admin/research-pipeline/page.tsx"
git commit -m "feat(admin): kind-prefix label for error_reason on pipeline cards

Card now shows '<short JP label> · <full reason>' so operators can scan
by kind without reading the full message."
```

---

## Task 18: Final verification

**Files:** none

- [ ] **Step 1: TS + lint**

```bash
npx tsc --noEmit
npm run lint
```
Expected: 0 errors. Existing pre-existing lint warnings carry over.

- [ ] **Step 2: All Phase 1-3 smokes**

```bash
npm run test:research-data-model
npm run test:research-retry-stage
npm run test:research-stuck-detector
npm run test:gemini-classify-error
npm run test:gemini-retry
npm run test:research-schema-shape
npm run test:error-reason-explain
```
Expected: all 7 PASS.

- [ ] **Step 3: Manual end-to-end (dev)**

Run `npm run dev`. In a browser logged in as admin:

1. Home page upload tab — drop a PDF + 2 photos in the same upload. Verify the upload completes and product card appears with "分析中... (0分経過)".
2. Wait ~5s. The card updates to show elapsed minutes (initially 0, then 1, …).
3. Open `/admin/research-pipeline` in another tab. The product is in the analyzing list during the run; when synthesis finishes, it disappears from the admin page and the user-side card shows "viewReport" button.
4. Simulate failure: temporarily corrupt the GEMINI_API_KEY in `.env.local` and re-run. Card should eventually flip to failed with a JA message.

(Cannot automate without UI test infra — report what was observed.)

- [ ] **Step 4: Inspect git log**

```bash
git log --oneline 3dccf1c..HEAD
```
Expected: ~18 commits since `3dccf1c`, one per task with a `feat()` / `fix()` / `i18n` prefix.

- [ ] **Step 5: Inspect uncommitted state**

```bash
git status
```
Expected: `nothing to commit, working tree clean`.

- [ ] **Step 6: No commit needed.** Verification only.

---

## Out of scope (deferred to Phase 4+)

- Storage bucket public→authenticated migration, `/api/analyze` internal-only enforcement.
- SSE/Realtime replacement of polling.
- Pro model fallback (explicitly excluded by user).
- Strategy UI failure surfacing (expansion-strategy retry adopted, but UI changes are out of scope).
- User-side manual retry button (operator-only retry kept as Phase 2 boundary).
- Prompt safety tuning to reduce `safety_blocked` rate.

## Risks (carried over from spec §11)

- `responseSchema` may be rejected by Gemini for deeply nested unions. Task 3's smoke catches static structural issues; runtime rejection falls into `schema_validation_failed` and retries.
- Multi-file 25MB inline limit at Gemini: Task 7 caps at 15MB single / 20MB total before request.
- Polling cap vs server cron drift: user data is safe even if client stops polling early.
- `safety_blocked` is non-retried; users see a clear message but cannot recover without changing input.
- `error_reason` is a free-text prefix, not a DB enum. New kinds must be added to two label maps (admin + user) and the classifier.

## Self-review

**Spec coverage walk (against `2026-05-26-research-output-quality-design.md`):**
- §3.1 body shape → Task 7 ✓
- §3.2 extractProductInfo signature → Task 6 ✓
- §3.3 prompt → Task 6 ✓
- §3.4 size guards → Task 7 ✓
- §3.5 single-file callers wrap → Task 6 Step 2 ✓
- §4.1 schema file → Task 3 ✓
- §4.2 generationConfig.responseSchema → Task 5 ✓
- §4.3 prompt order → Task 5 ✓
- §4.4 sanitization → Task 4 ✓
- §4.5 parse fallback → Task 4 (relies on parseJsonFromModelText for fallback; if needed, the catch in retry helper classifies)
- §5.1 errors.ts → Task 1 ✓
- §5.2 retry.ts → Task 2 ✓
- §5.3 attempt-2 prompt augmentation → Tasks 5, 6, 9 ✓
- §5.4 callGeminiWithRetry applied to synth/extract/expansion → Tasks 5, 6, 9 ✓
- §5.5 synthesize-product catch → Task 11 ✓
- §5.6 admin UI label map → Task 17 ✓
- §6.1 polling cap → Task 14 ✓
- §6.2 elapsed badge → Task 15 ✓
- §6.3 explainErrorReason → Tasks 13, 15 ✓
- §6.4 i18n keys → Task 16 ✓
- §7.1 broadcast context throw → Task 10 ✓
- §7.2 analyzeExpansionStrategy retry → Task 9 ✓
- §8 no migration → no task needed ✓
- §9 smokes → Tasks 1, 2, 3, 13 + final verification in Task 18 ✓
- §10-§13 risks/non-goals/deferred → captured in plan footer ✓

**Placeholder scan:** no TBD / TODO / "similar to" / unbacked steps. Each step shows the exact code.

**Type consistency:**
- `GeminiErrorKind`, `GeminiCallError`, `classifyGeminiError`, `callGeminiWithRetry`, `RetryOptions`, `InvokerResult`, `ExtractFile`, `researchOutputSchema`, `parseResearchOutput`, `BroadcastContextLoadError`, `explainErrorReason`, `ERROR_REASON_LABELS_JA`, `ERROR_REASON_LABELS_KO` all spelled identically across tasks where they appear.
- `extractProductInfo(files: ExtractFile[])` signature consistent between Task 6 definition and Task 7 caller.
- `analyze` body `{ productId, files: AnalyzeFile[] }` matches between Tasks 7 (consumer) and 8 (producer).

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-26-research-output-quality.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task with two-stage review, fast iteration. Same pattern as Phase 1 + 2.
2. **Inline Execution** — execute all 18 tasks in this session with checkpoint pauses.

Which approach?
