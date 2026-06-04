# 考査ツール v2 — 検索・根拠グラウンディング Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 台本考査チェックに「参照コーパス（構造的検索）」と「実時間Web検索によるfact検証」を加え、findingに実出典URLを付ける。

**Architecture:** 新テーブル `compliance_references`（埋め込みなしの構造的コーパス）+ 既存 `lib/brave.ts` でのfact検索を `checkScreenplay` のパイプラインに統合。決定論パス（lexicon）は常時、コーパス取得 + fact検索 + LLM判定はbest-effort。自動（workflow checkStep）と手動（POST）の両方でフル実行。

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (Postgres + RLS), `@google/genai` (Gemini), Brave Search (`lib/brave.ts`), tsx + node:assert tests.

Spec: `docs/superpowers/specs/2026-06-04-screenplay-check-grounding-design.md`

---

## File Structure

- Create `supabase/migrations/2026-06-04_compliance_references.sql` — table + RLS.
- Create `supabase/migrations/2026-06-04_compliance_references_seed.sql` — self-built seed corpus.
- Modify `lib/screenplay/compliance/types.ts` — `ComplianceReference`, `FindingSource`, `Finding.references`, `source` enum.
- Create `lib/screenplay/compliance/reference-retrieval.ts` — `selectReferences` (pure).
- Create `lib/screenplay/compliance/fact-search.ts` — `extractFactClaims` (pure) + `searchFactEvidence` (Brave I/O).
- Modify `lib/screenplay/compliance/check.ts` — `loadActiveReferences`, pipeline integration, prompt, `coerceFinding`.
- Modify `app/api/screenplays/[id]/check/route.ts` — load + pass references; `lexicon_version`.
- Modify `lib/workflows/screenplay.workflow.ts` — `checkStep` loads + passes references.
- Create `app/api/admin/compliance-references/route.ts` + `[id]/route.ts` — admin CRUD.
- Create `app/[locale]/(admin)/admin/compliance-references/page.tsx` + `ComplianceReferencesTable.tsx`.
- Create `lib/screenplay/compliance/reference-input.ts` — pure validator for references.
- Modify `lib/nav/groups.ts`, `messages/ja.json`, `messages/ko.json` — nav + i18n.
- Create tests: `scripts/test-compliance-reference-retrieval.ts`, `scripts/test-compliance-fact-extract.ts`, `scripts/test-compliance-reference-input.ts`.
- Modify `package.json` — test scripts.

---

## Task 1: `compliance_references` table + types

**Files:**
- Create: `supabase/migrations/2026-06-04_compliance_references.sql`
- Modify: `lib/screenplay/compliance/types.ts`

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/2026-06-04_compliance_references.sql`:

```sql
-- 2026-06-04: compliance_references — grounding corpus for the screenplay check
-- tool. Distinct from compliance_rules (deterministic NG/allowed patterns): these
-- are authoritative reference snippets injected into the LLM judge as 根拠資料.
-- Group B RLS: read member|admin, write admin only.

BEGIN;

CREATE TABLE IF NOT EXISTS compliance_references (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  law            text NOT NULL CHECK (law IN ('yakkiho','keihyo','kenzo','other')),
  category_scope text[] NOT NULL DEFAULT '{}',
  topic          text NOT NULL,
  body           text NOT NULL,
  keywords       text[] NOT NULL DEFAULT '{}',
  citation       text NOT NULL DEFAULT '',
  source_url     text NOT NULL DEFAULT '',
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (law, topic)
);

CREATE INDEX IF NOT EXISTS compliance_references_active_idx
  ON compliance_references (active) WHERE active;

ALTER TABLE compliance_references ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "compliance_references_read"      ON compliance_references;
DROP POLICY IF EXISTS "compliance_references_admin_all" ON compliance_references;

CREATE POLICY "compliance_references_read" ON compliance_references
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member','admin'));

CREATE POLICY "compliance_references_admin_all" ON compliance_references
  FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

COMMIT;
```

- [ ] **Step 2: Add types to `lib/screenplay/compliance/types.ts`**

Append (do not remove existing exports):

```ts
export type ReferenceLaw = ComplianceLaw | "other";

export interface ComplianceReference {
	id: string;
	law: ReferenceLaw;
	category_scope: string[]; // empty = all categories
	topic: string;
	body: string;
	keywords: string[];
	citation: string;
	source_url: string;
	active: boolean;
}

export interface FindingSource {
	title: string;
	url: string;
}
```

Then modify the existing `Finding` interface: change the `source` field and add `references`:

```ts
export interface Finding {
	axis: FindingAxis;
	severity: Severity;
	quote: string;
	reason: string;
	citedRule: string;
	suggestedRewrite: string;
	source: "lexicon" | "llm" | "corpus";
	references?: FindingSource[];
}
```

- [ ] **Step 3: Type-check**

Run: `node --max-old-space-size=6144 ./node_modules/typescript/bin/tsc --noEmit`
Expected: EXIT 0 (no usages broke — `references` is optional, `"corpus"` is additive).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-06-04_compliance_references.sql lib/screenplay/compliance/types.ts
git commit -m "feat(compliance): compliance_references table + grounding types"
```

---

## Task 2: Reference retrieval module (pure) + test

**Files:**
- Create: `lib/screenplay/compliance/reference-retrieval.ts`
- Create: `scripts/test-compliance-reference-retrieval.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-compliance-reference-retrieval.ts`:

```ts
/**
 * Unit test for structured reference retrieval. No DB / no network.
 * Run: npm run test:compliance-reference-retrieval
 */
import assert from "node:assert";
import { selectReferences } from "../lib/screenplay/compliance/reference-retrieval";
import type { ComplianceReference } from "../lib/screenplay/compliance/types";

let passed = 0;
function check(label: string, cond: boolean) {
	assert.ok(cond, `FAILED: ${label}`);
	passed++;
}

function ref(over: Partial<ComplianceReference>): ComplianceReference {
	return {
		id: "x", law: "yakkiho", category_scope: [], topic: "t", body: "b",
		keywords: [], citation: "c", source_url: "u", active: true, ...over,
	};
}

const REFS: ComplianceReference[] = [
	ref({ topic: "化粧品56効能", category_scope: ["化粧品"], keywords: ["シミ", "うるおい", "効能"] }),
	ref({ topic: "No.1表示の根拠", law: "keihyo", category_scope: [], keywords: ["No.1", "業界初", "根拠"] }),
	ref({ topic: "健康食品の効能", category_scope: ["健康食品"], keywords: ["免疫", "治る"] }),
	ref({ topic: "無キーワード", category_scope: ["化粧品"], keywords: [] }),
];

// 1. category filter: 健康食品 ref excluded for 化粧品 script
let out = selectReferences("このクリームはシミに効くと評判、業界初の技術。", "化粧品", REFS, 8);
check("includes in-scope keyword-hit ref", out.some((r) => r.topic === "化粧品56効能"));
check("includes empty-scope keihyo ref (業界初 hit)", out.some((r) => r.topic === "No.1表示の根拠"));
check("excludes out-of-scope 健康食品 ref", !out.some((r) => r.topic === "健康食品の効能"));
check("excludes zero-keyword-hit ref", !out.some((r) => r.topic === "無キーワード"));

// 2. ordering: more keyword hits first
out = selectReferences("シミ うるおい 効能 No.1", "化粧品", REFS, 8);
check("higher keyword-overlap ranks first", out[0].topic === "化粧品56効能");

// 3. top-K cap
const many = Array.from({ length: 20 }, (_, i) => ref({ topic: `t${i}`, category_scope: [], keywords: ["x"] }));
out = selectReferences("x", null, many, 8);
check("respects top-K=8", out.length === 8);

// 4. null category: only empty-scope refs eligible
out = selectReferences("業界初", null, REFS, 8);
check("null category keeps empty-scope ref", out.some((r) => r.topic === "No.1表示の根拠"));
check("null category drops category-scoped ref", !out.some((r) => r.topic === "化粧品56効能"));

// 5. determinism: same input → same output
const a = selectReferences("シミ No.1", "化粧品", REFS, 8).map((r) => r.topic).join(",");
const b = selectReferences("シミ No.1", "化粧品", REFS, 8).map((r) => r.topic).join(",");
check("deterministic", a === b);

console.log(`[test:compliance-reference-retrieval] ${passed} assertions passed`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-compliance-reference-retrieval.ts`
Expected: FAIL — `Cannot find module '../lib/screenplay/compliance/reference-retrieval'`.

- [ ] **Step 3: Write the implementation**

Create `lib/screenplay/compliance/reference-retrieval.ts`:

```ts
import type { ComplianceReference } from "./types";

/**
 * Structured (no-embedding) retrieval. Filters references to the product
 * category (empty scope = all), scores each by the count of its keywords that
 * occur as substrings in the script text, and returns the top-K (score > 0).
 * Japanese is not whitespace-tokenised, so we use substring occurrence, not
 * token overlap. Stable: ties broken by topic ascending → deterministic.
 */
export function selectReferences(
	scriptText: string,
	category: string | null,
	refs: ComplianceReference[],
	k = 8,
): ComplianceReference[] {
	const inScope = refs.filter(
		(r) =>
			r.active &&
			(r.category_scope.length === 0 ||
				(category !== null && r.category_scope.includes(category))),
	);
	const scored = inScope.map((r) => {
		const score = r.keywords.reduce(
			(s, kw) => s + (kw && scriptText.includes(kw) ? 1 : 0),
			0,
		);
		return { r, score };
	});
	scored.sort((a, b) => b.score - a.score || a.r.topic.localeCompare(b.r.topic));
	return scored.filter((x) => x.score > 0).slice(0, k).map((x) => x.r);
}
```

- [ ] **Step 4: Add the npm script**

In `package.json` scripts, after the `test:compliance-rule-input` line, add:

```json
    "test:compliance-reference-retrieval": "tsx scripts/test-compliance-reference-retrieval.ts",
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:compliance-reference-retrieval`
Expected: `[test:compliance-reference-retrieval] 11 assertions passed`.

- [ ] **Step 6: Commit**

```bash
git add lib/screenplay/compliance/reference-retrieval.ts scripts/test-compliance-reference-retrieval.ts package.json
git commit -m "feat(compliance): structured reference retrieval + test"
```

---

## Task 3: Fact-search module (claim extraction + Brave) + test

**Files:**
- Create: `lib/screenplay/compliance/fact-search.ts`
- Create: `scripts/test-compliance-fact-extract.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-compliance-fact-extract.ts`:

```ts
/**
 * Unit test for fact-claim extraction heuristic. No DB / no network.
 * Run: npm run test:compliance-fact-extract
 */
import assert from "node:assert";
import { extractFactClaims } from "../lib/screenplay/compliance/fact-search";

let passed = 0;
function check(label: string, cond: boolean) {
	assert.ok(cond, `FAILED: ${label}`);
	passed++;
}

const SCRIPT = [
	"こんにちは、本日の商品をご紹介します。",          // no number/superlative → skip
	"なんと売上No.1の実績があります。",                 // superlative
	"通常価格9,800円のところ、本日は5,980円。",         // number+円
	"愛用者の98%が満足と回答しました。",                // number+%
	"気持ちのいい肌ざわりです。",                       // skip
	"業界初の新技術を採用。",                           // superlative
].join("\n");

const claims = extractFactClaims(SCRIPT, 5);
check("picks the No.1 claim", claims.some((c) => c.includes("No.1")));
check("picks the price claim", claims.some((c) => c.includes("9,800円") || c.includes("5,980円")));
check("picks the percentage claim", claims.some((c) => c.includes("98%")));
check("picks the 業界初 claim", claims.some((c) => c.includes("業界初")));
check("skips the plain greeting", !claims.some((c) => c.includes("こんにちは")));
check("skips the plain 肌ざわり line", !claims.some((c) => c.includes("肌ざわり")));
check("respects maxClaims cap", extractFactClaims(SCRIPT, 2).length === 2);
check("dedupes / returns array", Array.isArray(claims));

console.log(`[test:compliance-fact-extract] ${passed} assertions passed`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-compliance-fact-extract.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `lib/screenplay/compliance/fact-search.ts`:

```ts
import { braveSearchItems, type BraveWebResult } from "@/lib/brave";

const SUPERLATIVES = [
	"No.1", "No1", "ナンバーワン", "業界初", "日本一", "世界初", "世界一",
	"最高", "最強", "最安", "最大", "唯一", "100%", "完全", "絶対", "必ず",
];

// number followed by a unit that signals a factual claim
const NUMBER_UNIT = /\d[\d,]*\s*(%|％|円|倍|名|人|個|位|kg|g|ml|cm|mm|時間|分|日|週間|ヶ月|年)/;

/**
 * Heuristic extraction of checkable factual claims. Splits the script into
 * sentences and keeps those containing a number+unit or a superlative/No.1
 * expression. No LLM call. Returns up to maxClaims unique sentences.
 */
export function extractFactClaims(scriptText: string, maxClaims = 5): string[] {
	const sentences = scriptText
		.split(/[\n。！!？?]/)
		.map((s) => s.trim())
		.filter(Boolean);
	const picked: string[] = [];
	const seen = new Set<string>();
	for (const s of sentences) {
		const hasNumber = NUMBER_UNIT.test(s);
		const hasSuper = SUPERLATIVES.some((k) => s.includes(k));
		if (!hasNumber && !hasSuper) continue;
		const key = s.slice(0, 40);
		if (seen.has(key)) continue;
		seen.add(key);
		picked.push(s);
		if (picked.length >= maxClaims) break;
	}
	return picked;
}

export interface FactEvidence {
	claim: string;
	results: BraveWebResult[];
}

/**
 * Run a bounded Brave web search per claim. Best-effort: a failed query yields
 * an empty result set (never throws). Caller bounds count via maxQueries.
 */
export async function searchFactEvidence(
	claims: string[],
	maxQueries: number,
): Promise<FactEvidence[]> {
	const limited = claims.slice(0, Math.max(0, maxQueries));
	const settled = await Promise.allSettled(
		limited.map(async (claim) => ({
			claim,
			results: await braveSearchItems(claim, 5),
		})),
	);
	return settled
		.filter((r): r is PromiseFulfilledResult<FactEvidence> => r.status === "fulfilled")
		.map((r) => r.value);
}
```

- [ ] **Step 4: Add the npm script**

In `package.json`, after the `test:compliance-reference-retrieval` line, add:

```json
    "test:compliance-fact-extract": "tsx scripts/test-compliance-fact-extract.ts",
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:compliance-fact-extract`
Expected: `[test:compliance-fact-extract] 8 assertions passed`.

- [ ] **Step 6: Commit**

```bash
git add lib/screenplay/compliance/fact-search.ts scripts/test-compliance-fact-extract.ts package.json
git commit -m "feat(compliance): fact-claim extraction + Brave evidence search"
```

---

## Task 4: Integrate grounding into `check.ts`

**Files:**
- Modify: `lib/screenplay/compliance/check.ts`

- [ ] **Step 1: Add imports + reference loader**

At the top of `lib/screenplay/compliance/check.ts`, add to the existing imports:

```ts
import { selectReferences } from "./reference-retrieval";
import { extractFactClaims, searchFactEvidence, type FactEvidence } from "./fact-search";
import type { ComplianceReference } from "./types";
```

After the existing `loadActiveRules` function, add:

```ts
export async function loadActiveReferences(): Promise<ComplianceReference[]> {
	const sb = getServiceClient();
	const { data, error } = await sb
		.from("compliance_references")
		.select("id,law,category_scope,topic,body,keywords,citation,source_url,active")
		.eq("active", true);
	if (error) {
		console.warn("[compliance] loadActiveReferences failed:", error.message);
		return [];
	}
	return (data ?? []) as ComplianceReference[];
}

const FACT_SEARCH_ENABLED = process.env.CHECK_FACT_SEARCH_ENABLED !== "false";
const FACT_MAX_QUERIES = Number(process.env.CHECK_FACT_MAX_QUERIES ?? "5") || 5;
const REFERENCE_TOP_K = Number(process.env.CHECK_REFERENCE_TOP_K ?? "8") || 8;
```

- [ ] **Step 2: Extend `coerceFinding` to capture references**

Replace the existing `coerceFinding` function with:

```ts
function coerceFinding(raw: unknown, axis: Finding["axis"]): Finding | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const quote = String(r.quote ?? "").trim();
	if (!quote) return null;
	const sev = SEVS.includes(r.severity as Severity) ? (r.severity as Severity) : "med";
	let references: Finding["references"];
	if (Array.isArray(r.references)) {
		references = r.references
			.map((x) => {
				const o = (x ?? {}) as Record<string, unknown>;
				const url = String(o.url ?? "").trim();
				if (!url) return null;
				return { title: String(o.title ?? "").slice(0, 200), url: url.slice(0, 500) };
			})
			.filter(Boolean)
			.slice(0, 5) as Finding["references"];
	}
	return {
		axis,
		severity: sev,
		quote: quote.slice(0, 300),
		reason: String(r.reason ?? "").slice(0, 400),
		citedRule: String(r.citedRule ?? "").slice(0, 200),
		suggestedRewrite: String(r.suggestedRewrite ?? "").slice(0, 400),
		source: "llm",
		...(references && references.length ? { references } : {}),
	};
}
```

- [ ] **Step 3: Extend `buildPrompt` to inject references + search evidence**

Replace the `buildPrompt` signature and body. Find the existing `function buildPrompt(markdown, brief, rules)` and replace with:

```ts
function buildPrompt(
	markdown: string,
	brief: ProductBrief,
	rules: ComplianceRule[],
	references: ComplianceReference[],
	evidence: FactEvidence[],
): string {
	const ngList = rules.filter((r) => !r.allowed).slice(0, 60).map((r) => `- [${r.law}] ${r.pattern} (${r.reason})`).join("\n");
	const okList = rules.filter((r) => r.allowed).slice(0, 30).map((r) => `- ${r.pattern}`).join("\n");
	const refBlock = references.length
		? references.map((r) => `- 【${r.topic}】${r.body}（出典: ${r.citation || r.law}${r.source_url ? ` ${r.source_url}` : ""}）`).join("\n")
		: "(なし)";
	const evidenceBlock = evidence.length
		? evidence.map((e) => {
				const hits = e.results.slice(0, 3).map((x) => `    ・${x.title} — ${x.description} (${x.url})`).join("\n");
				return `- 主張: ${e.claim}\n${hits || "    ・(検索結果なし)"}`;
		  }).join("\n")
		: "(検索なし)";
	return `あなたは日本のテレビ通販の考査担当者です。以下の放送台本を3観点で点検し、純粋なJSONのみで出力してください（markdown装飾なし）。

【商品情報（事実の根拠）】
- 商品名: ${brief.name}
- カテゴリ: ${brief.category ?? "(不明)"}
- 説明: ${brief.description}
- 価格: ${brief.price ? JSON.stringify(brief.price) : "(不明)"}
- 特典: ${(brief.bonuses ?? []).join(" / ") || "(なし)"}

【法規NG表現（参考・カテゴリ該当時）】
${ngList || "(なし)"}
【許容表現（これらは違反にしない）】
${okList || "(なし)"}

【根拠資料（法規・カテゴリ基準。判定の根拠として用い、該当時は references に source_url を引用）】
${refBlock}

【事実確認用の検索結果（fact観点の裏付け。数値・No.1・効能・価格の真偽確認に使い、引用URLを references に入れる）】
${evidenceBlock}

【点検観点】
1. legal: 薬機法・景表法・健康増進法の違反疑い（上記NGの言い換え・優良誤認・No.1/最上級の根拠欠如等）。根拠資料があれば references に出典を付す。
2. facts: 台本中の数値・断定のうち、商品情報または検索結果で裏付けられないもの。裏付け/反証に使ったURLを references に入れる。
3. quality: 構成の欠落（オープニング/実演/オファー/CTAのいずれか不足、時間配分の偏り、訴求の重複）。

【台本】
${markdown.slice(0, 12000)}

【出力JSON】
{
  "legal":   [{"severity":"high|med|low","quote":"該当箇所","reason":"理由","citedRule":"根拠法/ガイド","suggestedRewrite":"修正案","references":[{"title":"","url":""}]}],
  "facts":   [{"severity":"...","quote":"...","reason":"...","citedRule":"","suggestedRewrite":"...","references":[{"title":"","url":""}]}],
  "quality": [{"severity":"...","quote":"...","reason":"...","citedRule":"","suggestedRewrite":"","references":[]}]
}`;
}
```

- [ ] **Step 4: Rewrite `checkScreenplay` to accept references + run grounding**

Replace the existing `checkScreenplay` function with:

```ts
export async function checkScreenplay(
	markdown: string,
	brief: ProductBrief,
	rules: ComplianceRule[],
	references: ComplianceReference[] = [],
): Promise<ScriptCheckResult> {
	// Deterministic pass (always, even if everything else fails).
	const lexFindings = matchLexicon(markdown, rules, brief.category ?? null);

	// Structured corpus retrieval (pure, cheap).
	let selectedRefs: ComplianceReference[] = [];
	try {
		selectedRefs = selectReferences(markdown, brief.category ?? null, references, REFERENCE_TOP_K);
	} catch (err) {
		console.warn("[compliance] reference retrieval failed:", err instanceof Error ? err.message : String(err));
	}

	// Fact-axis live web search (best-effort, bounded).
	let evidence: FactEvidence[] = [];
	if (FACT_SEARCH_ENABLED) {
		try {
			const claims = extractFactClaims(markdown, FACT_MAX_QUERIES);
			evidence = await searchFactEvidence(claims, FACT_MAX_QUERIES);
		} catch (err) {
			console.warn("[compliance] fact search failed:", err instanceof Error ? err.message : String(err));
		}
	}

	// LLM pass (best-effort).
	let llmLegal: Finding[] = [], llmFacts: Finding[] = [], llmQuality: Finding[] = [];
	try {
		const raw = parseJSON<Record<string, unknown[]>>(await callGemini(buildPrompt(markdown, brief, rules, selectedRefs, evidence)));
		llmLegal = (raw.legal ?? []).map((r) => coerceFinding(r, "legal")).filter(Boolean) as Finding[];
		llmFacts = (raw.facts ?? []).map((r) => coerceFinding(r, "facts")).filter(Boolean) as Finding[];
		llmQuality = (raw.quality ?? []).map((r) => coerceFinding(r, "quality")).filter(Boolean) as Finding[];
	} catch (err) {
		console.warn("[compliance] LLM pass failed (deterministic findings only):", err instanceof Error ? err.message : String(err));
	}

	const legal = dedupe([...lexFindings, ...llmLegal]);
	const facts = dedupe(llmFacts);
	const quality = dedupe(llmQuality);
	return { overallScore: score(legal, facts, quality), legal, facts, quality };
}
```

- [ ] **Step 5: Type-check**

Run: `node --max-old-space-size=6144 ./node_modules/typescript/bin/tsc --noEmit`
Expected: EXIT 0. (Existing callers pass 3 args; `references` defaults to `[]` so they still compile — they are updated in Task 5.)

- [ ] **Step 6: Commit**

```bash
git add lib/screenplay/compliance/check.ts
git commit -m "feat(compliance): inject reference corpus + fact search into check pipeline"
```

---

## Task 5: Wire callers to load + pass references

**Files:**
- Modify: `app/api/screenplays/[id]/check/route.ts`
- Modify: `lib/workflows/screenplay.workflow.ts`

- [ ] **Step 1: Update the POST route**

In `app/api/screenplays/[id]/check/route.ts`, change the import line:

```ts
import { loadActiveRules, loadActiveReferences, checkScreenplay } from "@/lib/screenplay/compliance/check";
```

Then replace the `const rules = ...; const result = ...;` block in `POST` with:

```ts
	const [rules, references] = await Promise.all([loadActiveRules(), loadActiveReferences()]);
	const result = await checkScreenplay(ver.markdown as string, sp.product_info_snapshot as ProductBrief, rules, references);
```

And change the insert's `lexicon_version` value to:

```ts
				lexicon_version: `rules:${rules.length} refs:${references.length}`,
```

- [ ] **Step 2: Update the workflow `checkStep`**

In `lib/workflows/screenplay.workflow.ts`, change the import:

```ts
import { loadActiveRules, loadActiveReferences, checkScreenplay } from "@/lib/screenplay/compliance/check";
```

In `checkStep`, replace the `const rules = ...; const result = ...;` lines inside the `try` with:

```ts
    const [rules, references] = await Promise.all([loadActiveRules(), loadActiveReferences()]);
    const result = await checkScreenplay(markdown, productBrief, rules, references);
```

And update the `lexicon_version` field in that insert to:

```ts
      lexicon_version: `rules:${rules.length} refs:${references.length}`,
```

- [ ] **Step 3: Type-check**

Run: `node --max-old-space-size=6144 ./node_modules/typescript/bin/tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 4: Commit**

```bash
git add "app/api/screenplays/[id]/check/route.ts" lib/workflows/screenplay.workflow.ts
git commit -m "feat(compliance): load + pass reference corpus in both check triggers"
```

---

## Task 6: Self-built seed corpus

**Files:**
- Create: `supabase/migrations/2026-06-04_compliance_references_seed.sql`

This task assembles the reference corpus from **public** Japanese regulatory sources. The agent MUST verify each `source_url` resolves before including it (use WebFetch). **Do not fabricate URLs.** If a URL cannot be confirmed, set `source_url` to `''` and keep only the `citation` text — never invent a link.

- [ ] **Step 1: Research + verify the source URLs**

For each source below, run a web search and fetch to confirm the canonical public page exists, and capture its URL:
- 厚生労働省「化粧品の効能の範囲」（56効能の通知）
- 東京都保健医療局「化粧品等の適正広告ガイドライン」
- 消費者庁「景品表示法」（No.1表示に関する実態調査報告書 / 打消し表示 / 不当な価格表示〔二重価格〕についての景品表示法上の考え方）
- 消費者庁「健康増進法」（食品として販売に供する物に関して行う健康保持増進効果等に関する虚偽誇大広告）

Record the confirmed URLs to paste into `source_url` below.

- [ ] **Step 2: Write the seed migration**

Create `supabase/migrations/2026-06-04_compliance_references_seed.sql`. Use this exact structure; fill each `<VERIFIED_URL_*>` with the URL confirmed in Step 1 (or `''` if unconfirmable). The `body`/`topic`/`keywords`/`citation` values below are the content to insert as-is:

```sql
-- 2026-06-04: compliance_references seed — grounding corpus from PUBLIC JP
-- regulatory sources. Reviewer aid, NOT legal authority. All source_url values
-- were verified to resolve at authoring time. Idempotent via ON CONFLICT (law, topic).

BEGIN;

INSERT INTO compliance_references (law, category_scope, topic, body, keywords, citation, source_url) VALUES
  ('yakkiho', '{化粧品,医薬部外品}', '化粧品の効能の範囲（56効能）',
   '化粧品が標榜できる効能効果は、厚生労働省通知で定められた56項目の範囲に限られる。これを超える効能（治療・予防・身体機能の改善等）は標榜できない。「乾燥による小じわを目立たなくする」は効能評価試験を行った場合に限り可。',
   '{56効能,化粧品,効能,小じわ,うるおい,肌,標榜}',
   '厚生労働省「化粧品の効能の範囲」', '<VERIFIED_URL_KOSEI_56>'),
  ('yakkiho', '{化粧品,医薬部外品}', '化粧品等の適正広告ガイドライン',
   '化粧品の広告では、医薬品的な効能効果（治癒・改善・予防・細胞活性化・若返り等）、安全性の保証表現、最大級表現を標榜できない。メーキャップ効果（物理的効果）は事実の範囲で可。',
   '{広告,化粧品,医薬品的,効能効果,メーキャップ,安全性,最大級}',
   '東京都「化粧品等の適正広告ガイドライン」', '<VERIFIED_URL_TOKYO_COSME>'),
  ('keihyo', '{}', 'No.1表示の根拠要件',
   'No.1・第1位等の表示は、客観的な調査に基づき、調査範囲・出典・時点を明示する必要がある。根拠のないNo.1表示は優良誤認のおそれ。',
   '{No.1,ナンバーワン,第1位,調査,根拠,出典,優良誤認}',
   '消費者庁「No.1表示に関する実態調査報告書」', '<VERIFIED_URL_CAA_NO1>'),
  ('keihyo', '{}', '打消し表示の考え方',
   '強調表示に対する例外・限定（打消し表示）は、消費者が認識できる文字サイズ・配置・タイミングで明瞭に表示する必要がある。読めない打消し表示は不当表示のおそれ。',
   '{打消し表示,強調表示,個人差,注釈,例外}',
   '消費者庁「打消し表示に関する実態調査報告書」', '<VERIFIED_URL_CAA_DISCLAIMER>'),
  ('keihyo', '{}', '不当な価格表示（二重価格）',
   '「通常価格」等との比較（二重価格表示）は、比較対照価格が最近相当期間にわたり実際に販売された価格である等の根拠が必要。根拠のない比較は有利誤認のおそれ。',
   '{二重価格,通常価格,割引,比較,有利誤認,価格表示}',
   '消費者庁「不当な価格表示についての景品表示法上の考え方」', '<VERIFIED_URL_CAA_PRICE>'),
  ('kenzo', '{健康食品,食品}', '健康増進法の誇大表示',
   '食品について、健康保持増進効果等を著しく事実に相違して、または著しく人を誤認させる広告は禁止。痩身・疾病治癒・身体機能の著しい改善等の標榜は誇大表示のおそれ。',
   '{健康増進法,誇大表示,健康保持増進,痩身,健康食品,効果}',
   '消費者庁「健康増進法に基づく虚偽誇大広告等の禁止」', '<VERIFIED_URL_CAA_KENZO>')
ON CONFLICT (law, topic) DO NOTHING;

COMMIT;
```

- [ ] **Step 3: Validate SQL parses (psql-free check via app)**

There is no local psql. Confirm the file has balanced `BEGIN;`/`COMMIT;`, every row has 8 column values, and no `<VERIFIED_URL_*>` placeholder remains (all replaced with a real URL or `''`).

Run: `grep -c "VERIFIED_URL" supabase/migrations/2026-06-04_compliance_references_seed.sql`
Expected: `0`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-06-04_compliance_references_seed.sql
git commit -m "feat(compliance): seed reference corpus from public JP regulatory sources"
```

> NOTE: like other migrations in this repo, this is applied manually (no CLI). After merge, apply it + the Task 1 table migration in Supabase.

---

## Task 7: Reference input validator + test

**Files:**
- Create: `lib/screenplay/compliance/reference-input.ts`
- Create: `scripts/test-compliance-reference-input.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-compliance-reference-input.ts`:

```ts
/**
 * Unit test for compliance_references input normalization. No DB / no network.
 * Run: npm run test:compliance-reference-input
 */
import assert from "node:assert";
import { normalizeReference } from "../lib/screenplay/compliance/reference-input";

let passed = 0;
function check(label: string, cond: boolean) {
	assert.ok(cond, `FAILED: ${label}`);
	passed++;
}

// 1. valid create
let r = normalizeReference({ law: "keihyo", topic: "No.1", body: "...", category_scope: "化粧品, 健康食品", keywords: "No.1, 根拠", source_url: "https://example.go.jp/x" }, false);
check("valid create ok", r.ok);
if (r.ok) {
	check("category split", Array.isArray(r.value.category_scope) && (r.value.category_scope as string[]).length === 2);
	check("keywords split", Array.isArray(r.value.keywords) && (r.value.keywords as string[]).length === 2);
	check("default active true", r.value.active === true);
}

// 2. invalid law
r = normalizeReference({ law: "nope", topic: "t", body: "b" }, false);
check("invalid law rejected", !r.ok);

// 3. missing topic rejected on create
r = normalizeReference({ law: "other", topic: "  ", body: "b" }, false);
check("empty topic rejected", !r.ok);

// 4. missing body rejected on create
r = normalizeReference({ law: "other", topic: "t", body: "" }, false);
check("empty body rejected", !r.ok);

// 5. invalid source_url rejected (must be http(s) or empty)
r = normalizeReference({ law: "other", topic: "t", body: "b", source_url: "javascript:alert(1)" }, false);
check("non-http url rejected", !r.ok);

// 6. empty source_url allowed
r = normalizeReference({ law: "other", topic: "t", body: "b", source_url: "" }, false);
check("empty url allowed", r.ok);

// 7. partial update only emits provided keys
r = normalizeReference({ active: false }, true);
check("partial emits only active", r.ok && Object.keys(r.value).length === 1 && r.value.active === false);

console.log(`[test:compliance-reference-input] ${passed} assertions passed`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-compliance-reference-input.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `lib/screenplay/compliance/reference-input.ts`:

```ts
// Pure validation/normalization for compliance_references create/update payloads.
// No server-only / Next imports so it can be unit-tested via tsx.

import type { ReferenceLaw } from "./types";

export const REFERENCE_LAWS: ReferenceLaw[] = ["yakkiho", "keihyo", "kenzo", "other"];

export interface ReferenceInput {
	law?: string;
	category_scope?: unknown;
	topic?: string;
	body?: string;
	keywords?: unknown;
	citation?: string;
	source_url?: string;
	active?: boolean;
}

export type NormalizeResult =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; error: string };

function toArray(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
	if (typeof raw === "string") return raw.split(",").map((s) => s.trim()).filter(Boolean);
	return [];
}

function validUrl(u: string): boolean {
	if (u === "") return true;
	return /^https?:\/\//i.test(u) && u.length <= 500;
}

export function normalizeReference(input: unknown, partial = false): NormalizeResult {
	const body: ReferenceInput = (input && typeof input === "object" ? input : {}) as ReferenceInput;
	const out: Record<string, unknown> = {};

	if (body.law !== undefined || !partial) {
		if (!REFERENCE_LAWS.includes(body.law as ReferenceLaw)) return { ok: false, error: "invalid law" };
		out.law = body.law;
	}
	if (body.topic !== undefined || !partial) {
		const t = (body.topic ?? "").trim();
		if (!t) return { ok: false, error: "topic is required" };
		out.topic = t.slice(0, 200);
	}
	if (body.body !== undefined || !partial) {
		const b = (body.body ?? "").trim();
		if (!b) return { ok: false, error: "body is required" };
		out.body = b.slice(0, 4000);
	}
	if (body.category_scope !== undefined || !partial) out.category_scope = toArray(body.category_scope);
	if (body.keywords !== undefined || !partial) out.keywords = toArray(body.keywords);
	if (body.citation !== undefined || !partial) out.citation = (body.citation ?? "").slice(0, 300);
	if (body.source_url !== undefined || !partial) {
		const u = (body.source_url ?? "").trim();
		if (!validUrl(u)) return { ok: false, error: "source_url must be http(s) or empty" };
		out.source_url = u;
	}
	if (body.active !== undefined) out.active = !!body.active;
	else if (!partial) out.active = true;

	return { ok: true, value: out };
}
```

- [ ] **Step 4: Add the npm script**

In `package.json`, after `test:compliance-fact-extract`, add:

```json
    "test:compliance-reference-input": "tsx scripts/test-compliance-reference-input.ts",
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:compliance-reference-input`
Expected: `[test:compliance-reference-input] 9 assertions passed`.

- [ ] **Step 6: Commit**

```bash
git add lib/screenplay/compliance/reference-input.ts scripts/test-compliance-reference-input.ts package.json
git commit -m "feat(compliance): reference input validator + test"
```

---

## Task 8: Admin API for references

**Files:**
- Create: `app/api/admin/compliance-references/route.ts`
- Create: `app/api/admin/compliance-references/[id]/route.ts`

- [ ] **Step 1: Write the collection route**

Create `app/api/admin/compliance-references/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { normalizeReference } from "@/lib/screenplay/compliance/reference-input";

export const maxDuration = 30;

const COLUMNS =
	"id,law,category_scope,topic,body,keywords,citation,source_url,active,created_at,updated_at";

export async function GET() {
	const auth = await requireUser(["admin"]);
	if ("error" in auth) return auth.error;
	const { data, error } = await auth.sb
		.from("compliance_references")
		.select(COLUMNS)
		.order("law", { ascending: true })
		.order("topic", { ascending: true });
	if (error) return NextResponse.json({ error: error.message }, { status: 500 });
	return NextResponse.json({ references: data ?? [] });
}

export async function POST(req: NextRequest) {
	const auth = await requireUser(["admin"]);
	if ("error" in auth) return auth.error;
	let body: unknown;
	try { body = await req.json(); }
	catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
	const norm = normalizeReference(body, false);
	if (!norm.ok) return NextResponse.json({ error: norm.error }, { status: 400 });
	const { data, error } = await auth.sb
		.from("compliance_references")
		.insert(norm.value)
		.select(COLUMNS)
		.single();
	if (error) {
		if (error.code === "23505") return NextResponse.json({ error: "duplicate (law, topic)" }, { status: 409 });
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
	return NextResponse.json({ reference: data }, { status: 201 });
}
```

- [ ] **Step 2: Write the item route**

Create `app/api/admin/compliance-references/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { normalizeReference } from "@/lib/screenplay/compliance/reference-input";

export const maxDuration = 30;

const COLUMNS =
	"id,law,category_scope,topic,body,keywords,citation,source_url,active,created_at,updated_at";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	const auth = await requireUser(["admin"]);
	if ("error" in auth) return auth.error;
	const { id } = await ctx.params;
	if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
	let body: unknown;
	try { body = await req.json(); }
	catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
	const norm = normalizeReference(body, true);
	if (!norm.ok) return NextResponse.json({ error: norm.error }, { status: 400 });
	if (Object.keys(norm.value).length === 0) return NextResponse.json({ error: "no fields to update" }, { status: 400 });
	norm.value.updated_at = new Date().toISOString();
	const { data, error } = await auth.sb
		.from("compliance_references")
		.update(norm.value)
		.eq("id", id)
		.select(COLUMNS)
		.maybeSingle();
	if (error) {
		if (error.code === "23505") return NextResponse.json({ error: "duplicate (law, topic)" }, { status: 409 });
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
	if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
	return NextResponse.json({ reference: data });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	const auth = await requireUser(["admin"]);
	if ("error" in auth) return auth.error;
	const { id } = await ctx.params;
	if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
	const { error } = await auth.sb.from("compliance_references").delete().eq("id", id);
	if (error) return NextResponse.json({ error: error.message }, { status: 500 });
	return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Type-check + lint**

Run: `node --max-old-space-size=6144 ./node_modules/typescript/bin/tsc --noEmit`
Then: `npx eslint "app/api/admin/compliance-references/route.ts" "app/api/admin/compliance-references/[id]/route.ts" "lib/screenplay/compliance/reference-input.ts"`
Expected: both EXIT 0.

- [ ] **Step 4: Commit**

```bash
git add "app/api/admin/compliance-references/route.ts" "app/api/admin/compliance-references/[id]/route.ts"
git commit -m "feat(compliance): admin API for compliance_references"
```

---

## Task 9: Admin UI page for references + nav + i18n

**Files:**
- Create: `app/[locale]/(admin)/admin/compliance-references/page.tsx`
- Create: `app/[locale]/(admin)/admin/compliance-references/ComplianceReferencesTable.tsx`
- Modify: `lib/nav/groups.ts`, `messages/ja.json`, `messages/ko.json`

- [ ] **Step 1: Create the server page**

Create `app/[locale]/(admin)/admin/compliance-references/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { getServerClient } from "@/lib/supabase/server";
import { localePath } from "@/lib/i18n/locale-path";
import ComplianceReferencesTable from "./ComplianceReferencesTable";
import type { ComplianceReference } from "@/lib/screenplay/compliance/types";

export const dynamic = "force-dynamic";

export default async function ComplianceReferencesPage(props: { params: Promise<{ locale: string }> }) {
	const { locale } = await props.params;
	const sb = await getServerClient();
	const { data: { user } } = await sb.auth.getUser();
	if (!user) redirect(localePath(locale, "/login"));
	const { data: profile } = await sb.from("profiles").select("role").eq("id", user.id).maybeSingle();
	if (profile?.role !== "admin") redirect(localePath(locale));

	const { data: references } = await sb
		.from("compliance_references")
		.select("id,law,category_scope,topic,body,keywords,citation,source_url,active")
		.order("law", { ascending: true })
		.order("topic", { ascending: true });

	return <ComplianceReferencesTable initial={(references ?? []) as ComplianceReference[]} />;
}
```

- [ ] **Step 2: Create the client table**

Create `app/[locale]/(admin)/admin/compliance-references/ComplianceReferencesTable.tsx`:

```tsx
"use client";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { ComplianceReference, ReferenceLaw } from "@/lib/screenplay/compliance/types";

const LAWS: ReferenceLaw[] = ["yakkiho", "keihyo", "kenzo", "other"];

type Draft = {
	id: string | null;
	law: ReferenceLaw;
	category_scope: string;
	topic: string;
	body: string;
	keywords: string;
	citation: string;
	source_url: string;
	active: boolean;
};

function emptyDraft(): Draft {
	return { id: null, law: "yakkiho", category_scope: "", topic: "", body: "", keywords: "", citation: "", source_url: "", active: true };
}
function toDraft(r: ComplianceReference): Draft {
	return {
		id: r.id, law: r.law, category_scope: (r.category_scope ?? []).join(", "),
		topic: r.topic, body: r.body, keywords: (r.keywords ?? []).join(", "),
		citation: r.citation, source_url: r.source_url, active: r.active,
	};
}

export default function ComplianceReferencesTable({ initial }: { initial: ComplianceReference[] }) {
	const t = useTranslations("admin.complianceReferences");
	const [rows, setRows] = useState<ComplianceReference[]>(initial);
	const [busy, setBusy] = useState<string | null>(null);
	const [filterLaw, setFilterLaw] = useState<"" | ReferenceLaw>("");
	const [search, setSearch] = useState("");
	const [draft, setDraft] = useState<Draft | null>(null);
	const [modalErr, setModalErr] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const visible = useMemo(() => {
		const q = search.trim();
		return rows.filter((r) => {
			if (filterLaw && r.law !== filterLaw) return false;
			if (q && !(r.topic.includes(q) || r.body.includes(q) || r.citation.includes(q))) return false;
			return true;
		});
	}, [rows, filterLaw, search]);

	function openCreate() { setModalErr(null); setDraft(emptyDraft()); }
	function openEdit(r: ComplianceReference) { setModalErr(null); setDraft(toDraft(r)); }
	function closeModal() { if (!saving) { setDraft(null); setModalErr(null); } }

	async function save() {
		if (!draft) return;
		if (!draft.topic.trim() || !draft.body.trim()) { setModalErr(t("err.required")); return; }
		setSaving(true); setModalErr(null);
		const payload = {
			law: draft.law, category_scope: draft.category_scope, topic: draft.topic.trim(),
			body: draft.body.trim(), keywords: draft.keywords, citation: draft.citation,
			source_url: draft.source_url.trim(), active: draft.active,
		};
		const isEdit = !!draft.id;
		const res = await fetch(isEdit ? `/api/admin/compliance-references/${draft.id}` : "/api/admin/compliance-references", {
			method: isEdit ? "PATCH" : "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		setSaving(false);
		if (!res.ok) {
			const j = await res.json().catch(() => ({}));
			if (res.status === 409) setModalErr(t("err.duplicate"));
			else setModalErr((j as { error?: string }).error ?? t("err.generic"));
			return;
		}
		const { reference } = (await res.json()) as { reference: ComplianceReference };
		setRows((prev) => (isEdit ? prev.map((x) => (x.id === reference.id ? reference : x)) : [...prev, reference]));
		setDraft(null);
	}

	async function toggleActive(r: ComplianceReference) {
		setBusy(r.id);
		const res = await fetch(`/api/admin/compliance-references/${r.id}`, {
			method: "PATCH", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ active: !r.active }),
		});
		setBusy(null);
		if (res.ok) { const { reference } = (await res.json()) as { reference: ComplianceReference }; setRows((prev) => prev.map((x) => (x.id === reference.id ? reference : x))); }
		else { const j = await res.json().catch(() => ({})); alert((j as { error?: string }).error ?? t("err.generic")); }
	}

	async function remove(r: ComplianceReference) {
		if (!confirm(t("confirmDelete"))) return;
		setBusy(r.id);
		const res = await fetch(`/api/admin/compliance-references/${r.id}`, { method: "DELETE" });
		setBusy(null);
		if (res.ok) setRows((prev) => prev.filter((x) => x.id !== r.id));
		else { const j = await res.json().catch(() => ({})); alert((j as { error?: string }).error ?? t("err.generic")); }
	}

	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-lg font-bold">{t("title")}</h2>
				<p className="text-xs text-muted-foreground mt-1">{t("subtitle")}</p>
			</div>
			<div className="flex flex-wrap items-center gap-2 justify-between">
				<div className="flex flex-wrap items-center gap-2">
					<select value={filterLaw} onChange={(e) => setFilterLaw(e.target.value as "" | ReferenceLaw)} className="border rounded px-2 py-1.5 text-sm">
						<option value="">{t("filterAllLaws")}</option>
						{LAWS.map((l) => <option key={l} value={l}>{t(`laws.${l}`)}</option>)}
					</select>
					<input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("searchPlaceholder")} className="border rounded px-3 py-1.5 text-sm w-56" />
					<span className="text-xs text-muted-foreground">{t("count", { n: visible.length })}</span>
				</div>
				<Button onClick={openCreate}>{t("addButton")}</Button>
			</div>
			<div className="border rounded overflow-x-auto">
				<table className="w-full border-collapse text-sm">
					<thead className="bg-muted">
						<tr className="border-b text-foreground">
							<th className="text-left p-2 font-medium">{t("col.law")}</th>
							<th className="text-left p-2 font-medium">{t("col.category")}</th>
							<th className="text-left p-2 font-medium">{t("col.topic")}</th>
							<th className="text-left p-2 font-medium">{t("col.source")}</th>
							<th className="text-left p-2 font-medium">{t("col.active")}</th>
							<th className="text-right p-2 font-medium">{t("col.actions")}</th>
						</tr>
					</thead>
					<tbody>
						{visible.map((r) => (
							<tr key={r.id} className={`border-b hover:bg-muted/50 ${r.active ? "" : "opacity-50"}`}>
								<td className="p-2 whitespace-nowrap">{t(`laws.${r.law}`)}</td>
								<td className="p-2 text-xs text-muted-foreground">{r.category_scope.length ? r.category_scope.join(", ") : t("allCategories")}</td>
								<td className="p-2 max-w-[22rem]"><div className="font-medium">{r.topic}</div><div className="text-xs text-muted-foreground line-clamp-2">{r.body}</div></td>
								<td className="p-2 text-xs">{r.source_url ? <a href={r.source_url} target="_blank" rel="noreferrer" className="underline">{r.citation || t("col.source")}</a> : <span className="text-muted-foreground">{r.citation || "—"}</span>}</td>
								<td className="p-2"><button onClick={() => toggleActive(r)} disabled={busy === r.id} className="text-xs underline-offset-2 hover:underline disabled:opacity-50">{r.active ? t("activeYes") : t("activeNo")}</button></td>
								<td className="p-2 text-right whitespace-nowrap">
									<Button variant="outline" size="sm" onClick={() => openEdit(r)} disabled={busy === r.id} className="mr-1">{t("edit")}</Button>
									<Button variant="outline" size="sm" onClick={() => remove(r)} disabled={busy === r.id}>{t("delete")}</Button>
								</td>
							</tr>
						))}
						{visible.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-muted-foreground text-sm">{t("empty")}</td></tr>}
					</tbody>
				</table>
			</div>

			{draft && (
				<div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
					<Card className="w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
						<h3 className="font-bold text-lg">{draft.id ? t("form.editHeading") : t("form.createHeading")}</h3>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
							<label className="block"><span className="text-xs">{t("form.law")}</span>
								<select value={draft.law} onChange={(e) => setDraft({ ...draft, law: e.target.value as ReferenceLaw })} className="mt-1 w-full border rounded px-2 py-2">
									{LAWS.map((l) => <option key={l} value={l}>{t(`laws.${l}`)}</option>)}
								</select>
							</label>
							<label className="block"><span className="text-xs">{t("form.category")}</span>
								<input type="text" value={draft.category_scope} onChange={(e) => setDraft({ ...draft, category_scope: e.target.value })} placeholder={t("form.categoryPlaceholder")} className="mt-1 w-full border rounded px-3 py-2 text-sm" />
							</label>
						</div>
						<label className="block"><span className="text-xs">{t("form.topic")}</span>
							<input type="text" value={draft.topic} onChange={(e) => setDraft({ ...draft, topic: e.target.value })} className="mt-1 w-full border rounded px-3 py-2 text-sm" />
						</label>
						<label className="block"><span className="text-xs">{t("form.body")}</span>
							<textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={4} className="mt-1 w-full border rounded px-3 py-2 text-sm" />
						</label>
						<label className="block"><span className="text-xs">{t("form.keywords")}</span>
							<input type="text" value={draft.keywords} onChange={(e) => setDraft({ ...draft, keywords: e.target.value })} placeholder={t("form.keywordsPlaceholder")} className="mt-1 w-full border rounded px-3 py-2 text-sm" />
						</label>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
							<label className="block"><span className="text-xs">{t("form.citation")}</span>
								<input type="text" value={draft.citation} onChange={(e) => setDraft({ ...draft, citation: e.target.value })} className="mt-1 w-full border rounded px-3 py-2 text-sm" />
							</label>
							<label className="block"><span className="text-xs">{t("form.sourceUrl")}</span>
								<input type="url" value={draft.source_url} onChange={(e) => setDraft({ ...draft, source_url: e.target.value })} className="mt-1 w-full border rounded px-3 py-2 text-sm" />
							</label>
						</div>
						<label className="flex items-center gap-2 text-sm">
							<input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> {t("form.active")}
						</label>
						{modalErr && <p className="text-sm text-red-600">{modalErr}</p>}
						<div className="flex justify-end gap-2 pt-2">
							<Button variant="outline" onClick={closeModal} disabled={saving}>{t("form.cancel")}</Button>
							<Button onClick={save} disabled={saving}>{saving ? t("form.saving") : t("form.submit")}</Button>
						</div>
					</Card>
				</div>
			)}
		</div>
	);
}
```

> NOTE: `Badge` import is intentionally present for parity with the rules table even if unused; if eslint flags it as unused, remove the `Badge` import line.

- [ ] **Step 3: Add nav entry in `lib/nav/groups.ts`**

In the `admin` group, add `'/admin/compliance-references'` to `pathPrefixes`, and add this member right after the `complianceRules` member:

```ts
      { labelKey: 'nav.admin.complianceReferences', href: '/admin/compliance-references' },
```

- [ ] **Step 4: Add i18n keys (ja + ko)**

In `messages/ja.json`, add to `nav.admin` after `"complianceRules"`:

```json
      "complianceReferences": "考査参照資料",
```

And add an `admin.complianceReferences` block (place it right after the `admin.complianceRules` block):

```json
    "complianceReferences": {
      "title": "考査 参照資料（根拠コーパス）",
      "subtitle": "考査チェックがfact/法規判定の根拠として参照する出典付き資料。ここでの変更は次回チェックから反映されます。",
      "addButton": "+ 資料追加",
      "searchPlaceholder": "トピック・本文・出典で検索",
      "filterAllLaws": "すべての法令",
      "count": "{n}件",
      "allCategories": "全カテゴリ",
      "activeYes": "有効",
      "activeNo": "無効",
      "edit": "編集",
      "delete": "削除",
      "confirmDelete": "この資料を削除しますか?",
      "empty": "該当する資料がありません。",
      "laws": { "yakkiho": "薬機法", "keihyo": "景表法", "kenzo": "健康増進法", "other": "その他" },
      "col": { "law": "法令", "category": "カテゴリ", "topic": "トピック・本文", "source": "出典", "active": "状態", "actions": "操作" },
      "form": {
        "createHeading": "資料追加", "editHeading": "資料編集", "law": "法令",
        "category": "対象カテゴリ", "categoryPlaceholder": "化粧品, 健康食品",
        "topic": "トピック", "body": "本文（根拠スニペット）",
        "keywords": "検索キーワード", "keywordsPlaceholder": "No.1, 根拠, 出典",
        "citation": "出典名", "sourceUrl": "出典URL", "active": "有効",
        "submit": "保存", "saving": "保存中...", "cancel": "キャンセル"
      },
      "err": { "required": "トピックと本文は必須です。", "duplicate": "同じ法令・トピックの資料が既に存在します。", "generic": "保存に失敗しました。" }
    },
```

In `messages/ko.json`, add to `nav.admin` after `"complianceRules"` (note: complianceRules ko key must already exist from PR #93; if missing, add it too):

```json
      "complianceReferences": "심의 참조자료",
```

And add the `admin.complianceReferences` block after `admin.complianceRules`:

```json
    "complianceReferences": {
      "title": "심의 참조자료 (근거 코퍼스)",
      "subtitle": "考査 체크가 fact·법규 판정의 근거로 참조하는 출처 포함 자료. 여기서 변경하면 다음 체크부터 반영됩니다.",
      "addButton": "+ 자료 추가",
      "searchPlaceholder": "토픽·본문·출처로 검색",
      "filterAllLaws": "전체 법령",
      "count": "{n}건",
      "allCategories": "전체 카테고리",
      "activeYes": "유효",
      "activeNo": "비활성",
      "edit": "편집",
      "delete": "삭제",
      "confirmDelete": "이 자료를 삭제할까요?",
      "empty": "해당하는 자료가 없습니다.",
      "laws": { "yakkiho": "薬機法", "keihyo": "景表法", "kenzo": "健康増進法", "other": "기타" },
      "col": { "law": "법령", "category": "카테고리", "topic": "토픽·본문", "source": "출처", "active": "상태", "actions": "작업" },
      "form": {
        "createHeading": "자료 추가", "editHeading": "자료 편집", "law": "법령",
        "category": "대상 카테고리", "categoryPlaceholder": "化粧品, 健康食品",
        "topic": "토픽", "body": "본문 (근거 스니펫)",
        "keywords": "검색 키워드", "keywordsPlaceholder": "No.1, 근거, 출처",
        "citation": "출처명", "sourceUrl": "출처 URL", "active": "유효",
        "submit": "저장", "saving": "저장 중...", "cancel": "취소"
      },
      "err": { "required": "토픽과 본문은 필수입니다.", "duplicate": "같은 법령·토픽의 자료가 이미 존재합니다.", "generic": "저장에 실패했습니다." }
    },
```

- [ ] **Step 5: Validate JSON + type-check + lint**

Run: `node -e "JSON.parse(require('fs').readFileSync('messages/ja.json','utf8')); JSON.parse(require('fs').readFileSync('messages/ko.json','utf8')); console.log('JSON OK')"`
Then: `node --max-old-space-size=6144 ./node_modules/typescript/bin/tsc --noEmit`
Then: `npx eslint "app/[locale]/(admin)/admin/compliance-references/page.tsx" "app/[locale]/(admin)/admin/compliance-references/ComplianceReferencesTable.tsx"`
Expected: all clean. (If eslint flags an unused `Badge` import, delete that import line and re-run.)

- [ ] **Step 6: Commit**

```bash
git add "app/[locale]/(admin)/admin/compliance-references" lib/nav/groups.ts messages/ja.json messages/ko.json
git commit -m "feat(compliance): admin UI for reference corpus + nav + i18n"
```

---

## Task 10: Display sources in the check result panel

**Files:**
- Modify: `components/screenplay/CheckResultPanel.tsx`

- [ ] **Step 1: Read the current panel**

Run: `sed -n '1,200p' components/screenplay/CheckResultPanel.tsx`
Locate where each finding renders `reason` / `suggestedRewrite` (per-axis finding card).

- [ ] **Step 2: Render `references` links**

In the finding card render (where `finding.suggestedRewrite` is shown), add directly below it:

```tsx
{finding.references && finding.references.length > 0 && (
	<div className="mt-1 flex flex-wrap gap-2">
		{finding.references.map((ref, i) => (
			<a
				key={i}
				href={ref.url}
				target="_blank"
				rel="noreferrer"
				className="text-xs text-blue-600 dark:text-blue-400 underline underline-offset-2 break-all"
			>
				{ref.title || ref.url}
			</a>
		))}
	</div>
)}
```

If the panel's finding type is a local interface, ensure it includes `references?: { title: string; url: string }[]` (mirror `FindingSource`). If it imports `Finding`/`ScriptCheckResult` from `@/lib/screenplay/compliance/types`, no type change is needed.

- [ ] **Step 3: Type-check + lint**

Run: `node --max-old-space-size=6144 ./node_modules/typescript/bin/tsc --noEmit`
Then: `npx eslint components/screenplay/CheckResultPanel.tsx`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add components/screenplay/CheckResultPanel.tsx
git commit -m "feat(compliance): show finding source URLs in check result panel"
```

---

## Task 11: Full verification sweep

- [ ] **Step 1: Run all compliance + regression tests**

Run:
```bash
npm run test:compliance-reference-retrieval
npm run test:compliance-fact-extract
npm run test:compliance-reference-input
npm run test:compliance-lexicon
npm run test:compliance-rule-input
```
Expected: all "N assertions passed", no failures.

- [ ] **Step 2: Type-check + lint the whole change set**

Run: `node --max-old-space-size=6144 ./node_modules/typescript/bin/tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 3: Live integration smoke (requires `.env.local` + applied migrations)**

This requires the Task 1 table + Task 6 seed applied in Supabase. If not yet applied, skip and note it.
Create a temporary script that calls `loadActiveReferences()` + `checkScreenplay(sampleMarkdown, sampleBrief, rules, refs)` and asserts the result has `legal/facts/quality` arrays and that at least one finding carries a `references` URL when the sample contains a No.1 claim. Delete the script after running.

- [ ] **Step 4: Final commit (if any cleanup)**

```bash
git add -A
git commit -m "test(compliance): verification sweep for grounding v2" --allow-empty
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** §3 table → Task 1; §4 corpus → Task 6; §5 retrieval → Task 2; §6 fact search → Task 3; §7 engine → Task 4; §8 Finding schema → Task 1+4; §9 triggers → Task 5; §10 admin UI → Tasks 8-9; §11 env knobs → Task 4; §12 tests → Tasks 2,3,7,11; §13 apply notes → Task 6 note.
- **Type consistency:** `ComplianceReference`, `ReferenceLaw`, `FindingSource`, `selectReferences`, `extractFactClaims`, `searchFactEvidence`, `FactEvidence`, `loadActiveReferences`, `normalizeReference` are defined once and referenced consistently. `checkScreenplay` gains a 4th param defaulting to `[]` (back-compat for Task 4 before Task 5 wires callers).
- **No fabricated data:** Task 6 explicitly forbids inventing `source_url`s and requires live verification.
- **Apply gating:** migrations applied manually (repo convention); Task 11 live smoke is skip-guarded on applied migrations.
