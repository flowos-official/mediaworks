# Screenplay Check Tool (試験ツール) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-version screenplay "check" producing a structured report across three axes — 薬機法/景品表示法 legal compliance, fact/number accuracy, and quality/structure — surfaced in the workspace with cited rules and suggested rewrites; run automatically on generate/refine and on demand.

**Architecture:** A hybrid checker (deterministic lexicon matcher + Gemini Flash judgment) mirroring `lib/competitor-fit/analyze.ts`. Two new tables: `compliance_rules` (admin-editable NG-expression lexicon, seeded) and `screenplay_version_checks` (append-only results). A non-fatal `checkStep` in the screenplay workflow auto-runs it; `POST /api/screenplays/:id/check` re-runs on demand. The workspace gains a 試験結果 panel.

**Tech Stack:** TypeScript, Next.js (App Router + Workflow DevKit), Supabase (Postgres + RLS), `@google/genai` (Gemini Flash), `tsx` + `node:assert`.

**Spec:** `docs/superpowers/specs/2026-06-02-screenplay-check-tool-design.md` (lands on `main` via PR #89; this branch does not require the file — the plan is self-contained).

---

## Phasing

- **Phase 1 (Tasks 1-4)** — backend core: migrations + seed lexicon + deterministic matcher + checker module. Independently testable; the deterministic matcher has strict unit tests.
- **Phase 2 (Tasks 5-6)** — wiring: workflow `checkStep` (auto) + `POST /api/screenplays/:id/check` (on-demand).
- **Phase 3 (Tasks 7-8)** — UI: workspace 試験結果 panel + 再チェック; final verification.

**Migration application:** the two `.sql` files are authored + committed here. They must be applied to the Supabase DB by the team's normal process before the live integration tests (Tasks 4/6) pass. The pure unit tests (Task 3) run without a DB. If the implementer cannot apply migrations, it should create the files, run the unit tests, and report which live tests are pending DB application — NOT fake them.

---

## File Structure

- `supabase/migrations/2026-06-03_compliance_rules.sql` — **create**: `compliance_rules` table + RLS (read member|admin, write admin) + seed INSERTs.
- `supabase/migrations/2026-06-03_screenplay_version_checks.sql` — **create**: `screenplay_version_checks` table + RLS (member|admin read/insert; append-only).
- `lib/screenplay/compliance/types.ts` — **create**: `ComplianceRule`, `Finding`, `ScriptCheckResult`.
- `lib/screenplay/compliance/lexicon-match.ts` — **create**: pure deterministic matcher.
- `lib/screenplay/compliance/check.ts` — **create**: `loadActiveRules`, `checkScreenplay` (deterministic + LLM + merge).
- `lib/workflows/screenplay.workflow.ts` — **modify**: add non-fatal `checkStep` after `persistStep`.
- `app/api/screenplays/[id]/check/route.ts` — **create**: on-demand re-check (POST) + latest read (GET).
- `components/screenplay/CheckResultPanel.tsx` — **create**: the 試験結果 panel.
- `components/screenplay/ScreenplayWorkspace.tsx` — **modify**: render the panel + pass the latest check.
- `app/[locale]/(produce)/screenplays/[id]/page.tsx` — **modify**: fetch the latest check for the current version.
- `scripts/test-compliance-lexicon.ts` — **create**: deterministic matcher unit test.
- `scripts/test-screenplay-check.ts` — **create**: live integration test (DB + Gemini).
- `package.json` — **modify**: add `test:compliance-lexicon`, `test:screenplay-check`.

---

## Task 1: Migration — `compliance_rules` + seed

**Files:**
- Create: `supabase/migrations/2026-06-03_compliance_rules.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/2026-06-03_compliance_rules.sql`:

```sql
-- 2026-06-03: compliance_rules — NG-expression lexicon for the screenplay
-- check tool (薬機法 / 景品表示法 / 健康増進法). Group B RLS: read member|admin,
-- write admin only. Seeded with a public-source starter set; admins extend it.

BEGIN;

CREATE TABLE IF NOT EXISTS compliance_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  law            text NOT NULL CHECK (law IN ('yakkiho','keihyo','kenzo')),
  category_scope text[] NOT NULL DEFAULT '{}',     -- empty = all product categories
  pattern        text NOT NULL,                    -- literal phrase or regex
  is_regex       boolean NOT NULL DEFAULT false,
  allowed        boolean NOT NULL DEFAULT false,    -- true = whitelist (e.g. 56効能), suppresses a flag
  severity       text NOT NULL DEFAULT 'med' CHECK (severity IN ('high','med','low')),
  reason         text NOT NULL DEFAULT '',
  safe_rewrite   text NOT NULL DEFAULT '',
  citation       text NOT NULL DEFAULT '',
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (law, pattern)
);

CREATE INDEX IF NOT EXISTS compliance_rules_active_idx ON compliance_rules (active) WHERE active;

ALTER TABLE compliance_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "compliance_rules_read"      ON compliance_rules;
DROP POLICY IF EXISTS "compliance_rules_admin_all" ON compliance_rules;

CREATE POLICY "compliance_rules_read" ON compliance_rules
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member','admin'));

CREATE POLICY "compliance_rules_admin_all" ON compliance_rules
  FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

-- Starter seed (public sources: 東京都 化粧品等適正広告ガイド / 消費者庁 景表法運用基準 /
-- 厚労省 化粧品56効能). Idempotent via ON CONFLICT (law,pattern).
INSERT INTO compliance_rules (law, category_scope, pattern, is_regex, allowed, severity, reason, safe_rewrite, citation) VALUES
  ('yakkiho', '{化粧品,医薬部外品}', 'シミが消える',      false, false, 'high', '化粧品で「シミが消える」は治療的効果の標榜にあたり不可。', 'メーキャップ効果でシミを目立たなくする', '薬機法/東京都広告ガイド'),
  ('yakkiho', '{化粧品}',            'シワが消える',      false, false, 'high', '化粧品でシワが「消える」は不可。56効能の範囲外。',        '乾燥による小じわを目立たなくする（効能評価試験済み）', '化粧品56効能'),
  ('yakkiho', '{化粧品}',            'アンチエイジング',  false, false, 'med',  '老化防止の標榜は不可。',                                  'エイジングケア（年齢に応じたお手入れ）',               '東京都広告ガイド'),
  ('yakkiho', '{健康食品}',          '治る',              false, false, 'high', '健康食品で疾病の治癒を標榜することは不可。',              '健康維持をサポート',                                   '薬機法/健康増進法'),
  ('yakkiho', '{健康食品}',          '効く',              false, false, 'med',  '健康食品で効果効能の断定は不可。',                        '健康的な毎日を応援',                                   '薬機法'),
  ('yakkiho', '{医療機器,健康食品}', '血圧を下げる',      false, false, 'high', '医薬品的効能効果の標榜は不可。',                          '（承認範囲内の表現に限定）',                           '薬機法'),
  ('yakkiho', '{化粧品}',            '乾燥による小じわを目立たなくする', false, true,  'low',  '56効能の範囲内（効能評価試験済みが前提）。許容表現。',     '',                                                     '化粧品56効能'),
  ('yakkiho', '{化粧品}',            '肌にうるおいを与える', false, true,  'low',  '56効能の範囲内。許容表現。',                              '',                                                     '化粧品56効能'),
  ('keihyo',  '{}',                  '業界初',            false, false, 'med',  'No.1/初表示は客観的根拠（調査出典・時点）が必要。',        '当社調べ（2026年5月時点）等の出典を明記',              '景表法 No.1表示ガイド'),
  ('keihyo',  '{}',                  '日本一',            false, false, 'med',  '最上級表示は客観的根拠が必要。優良誤認のおそれ。',        '出典・調査範囲を明記、または表現を削除',               '景表法 優良誤認'),
  ('keihyo',  '{}',                  '完全',              false, false, 'low',  '「完全」等の断定は優良誤認のおそれ。',                    '効果には個人差があります 等の打消し表示を併記',         '景表法'),
  ('keihyo',  '{}',                  '永久',              false, false, 'med',  '「永久」効果の標榜は優良誤認のおそれ。',                  '長期間（条件を明記）',                                 '景表法'),
  ('kenzo',   '{健康食品}',          '痩せる',            false, false, 'high', '健康増進法の誇大表示。痩身効果の標榜は不可。',            '（標榜不可。体験談も不可）',                           '健康増進法 誇大表示')
ON CONFLICT (law, pattern) DO NOTHING;

COMMIT;
```

- [ ] **Step 2: Apply the migration to the DB**

Apply via the team's normal Supabase process (e.g. paste into the SQL editor, or `supabase db push` if configured). Verify: `npm run test:migrations` lists the new migration as applied, OR query `select count(*) from compliance_rules;` returns ≥ 13.

If you cannot apply it in this environment, note it and continue — Task 3 (unit tests) does not need the DB; Tasks 4/6 (live) will be pending application.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-06-03_compliance_rules.sql
git commit -m "feat(compliance): compliance_rules table + RLS + seed lexicon"
```

---

## Task 2: Migration — `screenplay_version_checks`

**Files:**
- Create: `supabase/migrations/2026-06-03_screenplay_version_checks.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/2026-06-03_screenplay_version_checks.sql`:

```sql
-- 2026-06-03: screenplay_version_checks — append-only results of the screenplay
-- check tool, one+ per screenplay_versions row. Group B RLS (member|admin read +
-- insert; no update/delete — immutable audit of each check run).

BEGIN;

CREATE TABLE IF NOT EXISTS screenplay_version_checks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id      uuid NOT NULL REFERENCES screenplay_versions(id) ON DELETE CASCADE,
  overall_score   int  NOT NULL DEFAULT 0 CHECK (overall_score BETWEEN 0 AND 100),
  result          jsonb NOT NULL,           -- { legal: Finding[], facts: Finding[], quality: Finding[] }
  lexicon_version text NOT NULL DEFAULT '',
  is_auto         boolean NOT NULL DEFAULT false,
  created_by      uuid,                      -- null for cron/auto
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS svc_version_created_idx
  ON screenplay_version_checks (version_id, created_at DESC);

ALTER TABLE screenplay_version_checks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "svc_member_read"   ON screenplay_version_checks;
DROP POLICY IF EXISTS "svc_member_insert" ON screenplay_version_checks;

CREATE POLICY "svc_member_read" ON screenplay_version_checks
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member','admin'));

CREATE POLICY "svc_member_insert" ON screenplay_version_checks
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_role() IN ('member','admin'));

COMMIT;
```

- [ ] **Step 2: Apply + verify** (same process as Task 1). Verify `select count(*) from screenplay_version_checks;` runs (0 rows OK).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-06-03_screenplay_version_checks.sql
git commit -m "feat(compliance): screenplay_version_checks append-only table + RLS"
```

---

## Task 3: Deterministic lexicon matcher (test-first)

**Files:**
- Create: `lib/screenplay/compliance/types.ts`
- Create: `lib/screenplay/compliance/lexicon-match.ts`
- Create: `scripts/test-compliance-lexicon.ts`
- Modify: `package.json`

- [ ] **Step 1: Define types**

Create `lib/screenplay/compliance/types.ts`:

```ts
export type ComplianceLaw = "yakkiho" | "keihyo" | "kenzo";
export type Severity = "high" | "med" | "low";

export interface ComplianceRule {
	id: string;
	law: ComplianceLaw;
	category_scope: string[]; // empty = all categories
	pattern: string;
	is_regex: boolean;
	allowed: boolean;         // true = whitelist phrase; suppresses a flag
	severity: Severity;
	reason: string;
	safe_rewrite: string;
	citation: string;
	active: boolean;
}

export type FindingAxis = "legal" | "facts" | "quality";

export interface Finding {
	axis: FindingAxis;
	severity: Severity;
	quote: string;           // the offending text from the script
	reason: string;
	citedRule: string;       // law/citation (legal) or "" otherwise
	suggestedRewrite: string;
	source: "lexicon" | "llm";
}

export interface ScriptCheckResult {
	overallScore: number;    // 0..100
	legal: Finding[];
	facts: Finding[];
	quality: Finding[];
}
```

- [ ] **Step 2: Write the failing test**

Create `scripts/test-compliance-lexicon.ts`:

```ts
/**
 * Unit test for the deterministic compliance lexicon matcher. No DB / no LLM.
 * Run: npm run test:compliance-lexicon
 */
import assert from "node:assert";
import { matchLexicon } from "../lib/screenplay/compliance/lexicon-match";
import type { ComplianceRule } from "../lib/screenplay/compliance/types";

let passed = 0;
function check(label: string, cond: boolean) {
	assert.ok(cond, `FAILED: ${label}`);
	passed++;
}

function rule(over: Partial<ComplianceRule>): ComplianceRule {
	return {
		id: "x", law: "yakkiho", category_scope: [], pattern: "", is_regex: false,
		allowed: false, severity: "med", reason: "r", safe_rewrite: "fix", citation: "c",
		active: true, ...over,
	};
}

const RULES: ComplianceRule[] = [
	rule({ pattern: "シミが消える", category_scope: ["化粧品"], severity: "high" }),
	rule({ pattern: "アンチエイジング", category_scope: ["化粧品"] }),
	rule({ pattern: "業界初", law: "keihyo", category_scope: [] }),
	rule({ pattern: "乾燥による小じわを目立たなくする", category_scope: ["化粧品"], allowed: true }),
];

// 1. literal hit, category in scope
let f = matchLexicon("このクリームはシミが消えると評判です。", RULES, "化粧品");
check("hits シミが消える for 化粧品", f.some((x) => x.quote.includes("シミが消える") && x.severity === "high"));

// 2. category NOT in scope → 化粧品-scoped rule does not fire
f = matchLexicon("シミが消える", RULES, "健康食品");
check("does not fire 化粧品 rule for 健康食品", !f.some((x) => x.quote.includes("シミが消える")));

// 3. empty-scope rule (keihyo) fires regardless of category
f = matchLexicon("業界初の技術！", RULES, "家電");
check("empty-scope keihyo rule fires for any category", f.some((x) => x.quote.includes("業界初")));

// 4. allowed (whitelist) phrase never produces a finding
f = matchLexicon("乾燥による小じわを目立たなくする（効能評価試験済み）", RULES, "化粧品");
check("allowed/whitelist phrase is not flagged", f.length === 0);

// 5. all lexicon findings are axis=legal, source=lexicon
f = matchLexicon("シミが消える、業界初。", RULES, "化粧品");
check("lexicon findings are legal+lexicon", f.length >= 2 && f.every((x) => x.axis === "legal" && x.source === "lexicon"));

console.log(`[test:compliance-lexicon] ${passed} assertions passed`);
```

- [ ] **Step 3: Add the npm script**

In `package.json`, after `"test:selections"`, add:

```json
    "test:compliance-lexicon": "tsx scripts/test-compliance-lexicon.ts",
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm run test:compliance-lexicon`
Expected: FAIL — `lexicon-match` module not found.

- [ ] **Step 5: Implement the matcher**

Create `lib/screenplay/compliance/lexicon-match.ts`:

```ts
import type { ComplianceRule, Finding } from "./types";

/** True if a rule applies to the given product category (empty scope = all). */
function inScope(rule: ComplianceRule, category: string | null): boolean {
	if (rule.category_scope.length === 0) return true;
	if (!category) return false; // scoped rule + unknown category → do not fire
	return rule.category_scope.includes(category);
}

function matches(rule: ComplianceRule, text: string): boolean {
	if (rule.is_regex) {
		try {
			return new RegExp(rule.pattern, "u").test(text);
		} catch {
			return false; // a malformed regex rule never throws the whole check
		}
	}
	return text.includes(rule.pattern);
}

/**
 * Deterministic pass: flag every active, in-scope, non-`allowed` rule whose
 * pattern appears in the markdown. `allowed` rules are whitelist phrases — if
 * one matches, suppress any flag whose quote is contained within the allowed
 * match span (e.g. "小じわを目立たなくする" must not trip a "消える"-style rule).
 */
export function matchLexicon(
	markdown: string,
	rules: ComplianceRule[],
	category: string | null,
): Finding[] {
	const active = rules.filter((r) => r.active && inScope(r, category));
	const allowedHits = active
		.filter((r) => r.allowed && matches(r, markdown))
		.map((r) => r.pattern);

	const findings: Finding[] = [];
	for (const r of active) {
		if (r.allowed) continue;
		if (!matches(r, markdown)) continue;
		// Suppress when the offending pattern is wholly inside an allowed phrase.
		if (allowedHits.some((a) => a.includes(r.pattern))) continue;
		findings.push({
			axis: "legal",
			severity: r.severity,
			quote: r.pattern,
			reason: r.reason,
			citedRule: r.citation || r.law,
			suggestedRewrite: r.safe_rewrite,
			source: "lexicon",
		});
	}
	return findings;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test:compliance-lexicon`
Expected: PASS — `[test:compliance-lexicon] 5 assertions passed`

- [ ] **Step 7: Typecheck + commit**

Run: `npx tsc --noEmit` (no new errors), then:

```bash
git add lib/screenplay/compliance/types.ts lib/screenplay/compliance/lexicon-match.ts scripts/test-compliance-lexicon.ts package.json
git commit -m "feat(compliance): deterministic NG-expression lexicon matcher"
```

---

## Task 4: Checker module (deterministic + LLM)

**Files:**
- Create: `lib/screenplay/compliance/check.ts`
- Modify: `scripts/test-screenplay-check.ts` (created here)
- Modify: `package.json`

- [ ] **Step 1: Implement the checker**

Create `lib/screenplay/compliance/check.ts`. Mirror `lib/competitor-fit/analyze.ts` for the Gemini call/retry/parse. Do NOT add `import "server-only"` (so the smoke test can import it); rely on `getServiceClient`.

```ts
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { GEMINI_MODELS_WITH_FALLBACK } from "@/lib/gemini-models";
import { getServiceClient } from "@/lib/supabase";
import type { ProductBrief } from "@/lib/screenplay/types";
import { matchLexicon } from "./lexicon-match";
import type { ComplianceRule, Finding, ScriptCheckResult, Severity } from "./types";

let _genAI: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
	if (!_genAI) _genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
	return _genAI;
}

export async function loadActiveRules(): Promise<ComplianceRule[]> {
	const sb = getServiceClient();
	const { data, error } = await sb
		.from("compliance_rules")
		.select("id,law,category_scope,pattern,is_regex,allowed,severity,reason,safe_rewrite,citation,active")
		.eq("active", true);
	if (error) {
		console.warn("[compliance] loadActiveRules failed:", error.message);
		return [];
	}
	return (data ?? []) as ComplianceRule[];
}

function isRetryable(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const m = err.message;
	return ["503","429","500","502","504","overloaded","UNAVAILABLE","timeout","aborted","ECONNRESET","ETIMEDOUT"].some((s) => m.includes(s));
}
function isUnavailable(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return ["404","Not Found","no longer available"].some((s) => err.message.includes(s));
}

async function callOnce(model: string, prompt: string): Promise<string> {
	const HARD = 60_000, FIRST = 30_000;
	const controller = new AbortController();
	const hard = setTimeout(() => controller.abort(new Error(`Gemini hard timeout ${HARD}ms`)), HARD);
	let first: ReturnType<typeof setTimeout> | null = setTimeout(() => controller.abort(new Error(`Gemini first-chunk timeout ${FIRST}ms`)), FIRST);
	try {
		const stream = await getGenAI().models.generateContentStream({
			model,
			contents: prompt,
			config: { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL }, abortSignal: controller.signal },
		});
		let text = "";
		for await (const chunk of stream) {
			if (first) { clearTimeout(first); first = null; }
			text += chunk.text ?? "";
		}
		return text.trim();
	} finally {
		clearTimeout(hard);
		if (first) clearTimeout(first);
	}
}

async function callGemini(prompt: string): Promise<string> {
	let lastErr: unknown = null;
	for (const model of GEMINI_MODELS_WITH_FALLBACK) {
		let dead = false;
		for (let attempt = 0; attempt < 2; attempt++) {
			try { return await callOnce(model, prompt); }
			catch (err) {
				lastErr = err;
				if (isUnavailable(err)) { dead = true; break; }
				if (!isRetryable(err)) throw err;
				await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
			}
		}
		if (dead) continue;
	}
	throw lastErr instanceof Error ? lastErr : new Error("All Gemini models failed");
}

function parseJSON<T>(raw: string): T {
	let c = raw.trim();
	const fence = c.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	if (fence) c = fence[1].trim();
	const start = c.indexOf("{");
	if (start === -1) throw new Error("No JSON object found");
	// balanced-brace scan
	let depth = 0, inStr = false, esc = false, end = -1;
	for (let i = start; i < c.length; i++) {
		const ch = c[i];
		if (esc) { esc = false; continue; }
		if (ch === "\\") { esc = true; continue; }
		if (ch === '"') { inStr = !inStr; continue; }
		if (inStr) continue;
		if (ch === "{") depth++;
		else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
	}
	if (end === -1) throw new Error("Unbalanced JSON");
	return JSON.parse(c.slice(start, end + 1)) as T;
}

const SEVS: Severity[] = ["high", "med", "low"];
function coerceFinding(raw: unknown, axis: Finding["axis"]): Finding | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const quote = String(r.quote ?? "").trim();
	if (!quote) return null;
	const sev = SEVS.includes(r.severity as Severity) ? (r.severity as Severity) : "med";
	return {
		axis,
		severity: sev,
		quote: quote.slice(0, 300),
		reason: String(r.reason ?? "").slice(0, 400),
		citedRule: String(r.citedRule ?? "").slice(0, 200),
		suggestedRewrite: String(r.suggestedRewrite ?? "").slice(0, 400),
		source: "llm",
	};
}

function buildPrompt(markdown: string, brief: ProductBrief, rules: ComplianceRule[]): string {
	const ngList = rules.filter((r) => !r.allowed).slice(0, 60).map((r) => `- [${r.law}] ${r.pattern} (${r.reason})`).join("\n");
	const okList = rules.filter((r) => r.allowed).slice(0, 30).map((r) => `- ${r.pattern}`).join("\n");
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

【点検観点】
1. legal: 薬機法・景表法・健康増進法の違反疑い（上記NGの言い換え・優良誤認・No.1/最上級の根拠欠如等）。
2. facts: 台本中の数値・断定（価格・割合・「売上No.1」等）のうち、上記商品情報で裏付けられないもの。
3. quality: 構成の欠落（オープニング/実演/オファー/CTAのいずれか不足、時間配分の偏り、訴求の重複）。

【台本】
${markdown.slice(0, 12000)}

【出力JSON】
{
  "legal":   [{"severity":"high|med|low","quote":"該当箇所","reason":"理由","citedRule":"根拠法/ガイド","suggestedRewrite":"修正案"}],
  "facts":   [{"severity":"...","quote":"...","reason":"...","citedRule":"","suggestedRewrite":"..."}],
  "quality": [{"severity":"...","quote":"...","reason":"...","citedRule":"","suggestedRewrite":"..."}]
}`;
}

function dedupe(findings: Finding[]): Finding[] {
	const seen = new Set<string>();
	const out: Finding[] = [];
	for (const f of findings) {
		const key = `${f.axis}|${f.quote}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(f);
	}
	return out;
}

function score(legal: Finding[], facts: Finding[], quality: Finding[]): number {
	const weight = (f: Finding) => (f.severity === "high" ? 15 : f.severity === "med" ? 7 : 3);
	const penalty = [...legal, ...facts, ...quality].reduce((s, f) => s + weight(f), 0);
	return Math.max(0, 100 - penalty);
}

export async function checkScreenplay(
	markdown: string,
	brief: ProductBrief,
	rules: ComplianceRule[],
): Promise<ScriptCheckResult> {
	// Deterministic pass (always, even if LLM fails).
	const lexFindings = matchLexicon(markdown, rules, brief.category ?? null);

	// LLM pass (best-effort).
	let llmLegal: Finding[] = [], llmFacts: Finding[] = [], llmQuality: Finding[] = [];
	try {
		const raw = parseJSON<Record<string, unknown[]>>(await callGemini(buildPrompt(markdown, brief, rules)));
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

- [ ] **Step 2: Write the live integration test**

Create `scripts/test-screenplay-check.ts`:

```ts
/**
 * Live integration: checkScreenplay against seeded rules + Gemini.
 * Requires .env.local + the compliance_rules migration applied.
 * Run: npm run test:screenplay-check
 */
import assert from "node:assert";
import { loadActiveRules, checkScreenplay } from "../lib/screenplay/compliance/check";
import type { ProductBrief } from "../lib/screenplay/types";

async function main() {
	const rules = await loadActiveRules();
	if (rules.length === 0) {
		console.log("[test:screenplay-check] SKIPPED — compliance_rules empty (migration not applied?)");
		return;
	}
	const brief: ProductBrief = {
		name: "モイスチャークリーム",
		category: "化粧品",
		description: "保湿クリーム。希望小売価格3,000円。",
	};
	const markdown = [
		"# モイスチャークリーム 台本",
		"## オープニング",
		"[N] このクリームならシミが消える、まさにアンチエイジングの決定版！",
		"業界初の技術を採用。今だけ500円！",
	].join("\n");

	const result = await checkScreenplay(markdown, brief, rules);
	console.log("[test:screenplay-check]", JSON.stringify(result, null, 2));

	// Deterministic legal findings MUST be present (strict).
	assert.ok(result.legal.some((f) => f.quote.includes("シミが消える")), "expected シミが消える legal flag");
	assert.ok(result.legal.some((f) => f.source === "lexicon"), "expected a lexicon-sourced legal flag");
	// Score reduced from 100 by the findings.
	assert.ok(result.overallScore < 100, "expected overallScore < 100");
	// Shape sanity (LLM axes are loose — presence/shape only).
	assert.ok(Array.isArray(result.facts) && Array.isArray(result.quality), "facts/quality arrays present");
	console.log("[test:screenplay-check] PASS");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Add the npm script**

In `package.json`, after `"test:compliance-lexicon"`, add:

```json
    "test:screenplay-check": "tsx --env-file=.env.local scripts/test-screenplay-check.ts",
```

- [ ] **Step 4: Run tests**

Run: `npx tsc --noEmit` (no new errors), then `npm run test:screenplay-check`.
Expected: PASS — strict lexicon assertions hold; or SKIPPED if the migration is not applied. NOT a FAIL on the deterministic assertions (those don't depend on the LLM).

- [ ] **Step 5: Commit**

```bash
git add lib/screenplay/compliance/check.ts scripts/test-screenplay-check.ts package.json
git commit -m "feat(compliance): hybrid checkScreenplay (lexicon + Gemini Flash)"
```

---

## Task 5: Auto-check workflow step

**Files:**
- Modify: `lib/workflows/screenplay.workflow.ts`

- [ ] **Step 1: Add a non-fatal `checkStep`**

In `lib/workflows/screenplay.workflow.ts`, add imports at the top:

```ts
import { loadActiveRules, checkScreenplay } from "@/lib/screenplay/compliance/check";
```

Add a step function after `persistStep` (before `markFailedStep`):

```ts
async function checkStep(
  versionId: string,
  markdown: string,
  productBrief: ProductBrief,
): Promise<void> {
  "use step";
  // Non-fatal: a failed check must NEVER fail the generation. The version is
  // already persisted; the operator can 再チェック on demand.
  try {
    const rules = await loadActiveRules();
    const result = await checkScreenplay(markdown, productBrief, rules);
    const supabase = getServiceClient();
    await supabase.from("screenplay_version_checks").insert({
      version_id: versionId,
      overall_score: result.overallScore,
      result,
      lexicon_version: `rules:${rules.length}`,
      is_auto: true,
      created_by: null,
    });
  } catch (err) {
    console.warn("[checkStep] auto-check failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}
```

In `screenplayWorkflow`, after the `persistStep` call and before `emitProgressStep({ type: "done", ... })`, add:

```ts
    await checkStep(persisted.versionId, gen.markdown, input.productBrief);
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit` (no new errors), then:

```bash
git add lib/workflows/screenplay.workflow.ts
git commit -m "feat(compliance): auto-run check after each screenplay version"
```

---

## Task 6: On-demand check API

**Files:**
- Create: `app/api/screenplays/[id]/check/route.ts`

- [ ] **Step 1: Implement the route**

Create `app/api/screenplays/[id]/check/route.ts` (mirrors the refine route's auth + UUID guard; uses `getServiceClient` like the sibling screenplay routes):

```ts
import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { loadActiveRules, checkScreenplay } from "@/lib/screenplay/compliance/check";
import type { ProductBrief } from "@/lib/screenplay/types";

export const maxDuration = 90;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST: re-check the screenplay's current version on demand.
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const { id } = await params;
	if (!UUID_RE.test(id)) return Response.json({ error: "invalid id" }, { status: 404 });

	const supabase = getServiceClient();
	const { data: sp, error: spErr } = await supabase
		.from("screenplays")
		.select("id, product_info_snapshot, current_version_id")
		.eq("id", id)
		.single();
	if (spErr || !sp || !sp.current_version_id) {
		return Response.json({ error: "screenplay or current version not found" }, { status: 404 });
	}

	const { data: ver, error: verErr } = await supabase
		.from("screenplay_versions")
		.select("id, markdown")
		.eq("id", sp.current_version_id)
		.single();
	if (verErr || !ver) return Response.json({ error: "version not found" }, { status: 404 });

	const rules = await loadActiveRules();
	const result = await checkScreenplay(ver.markdown as string, sp.product_info_snapshot as ProductBrief, rules);

	const { data: inserted, error: insErr } = await supabase
		.from("screenplay_version_checks")
		.insert({
			version_id: ver.id,
			overall_score: result.overallScore,
			result,
			lexicon_version: `rules:${rules.length}`,
			is_auto: false,
			created_by: auth.user.id,
		})
		.select("id, created_at")
		.single();
	if (insErr) return Response.json({ error: insErr.message }, { status: 500 });

	return Response.json({ check: { id: inserted.id, created_at: inserted.created_at, ...result } });
}
```

NOTE: confirm the shape of `requireUser`'s success return for the user id — the refine route uses `auth` after `if ("error" in auth)`. Read `lib/auth/require-user.ts` to confirm whether it is `auth.user.id` or `auth.userId`, and use the correct one.

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit`. Then:

```bash
git add app/api/screenplays/[id]/check/route.ts
git commit -m "feat(compliance): POST /api/screenplays/:id/check on-demand re-check"
```

---

## Task 7: Workspace 試験結果 panel

**Files:**
- Create: `components/screenplay/CheckResultPanel.tsx`
- Modify: `components/screenplay/ScreenplayWorkspace.tsx`
- Modify: `app/[locale]/(produce)/screenplays/[id]/page.tsx`

- [ ] **Step 1: Read the integration points**

Read `components/screenplay/ScreenplayWorkspace.tsx` (3-column layout, right column = FeedbackForm) and `app/[locale]/(produce)/screenplays/[id]/page.tsx` (server fetch of screenplay + versions). Identify: how the current version id is known, and where the right column renders.

- [ ] **Step 2: Create the panel component**

Create `components/screenplay/CheckResultPanel.tsx` (client component). Props: `screenplayId: string`, `initialCheck: ScriptCheckResult & { created_at?: string } | null`. Renders overall score + three grouped sections (法規 / ファクト / 品質), each finding as a card (severity badge, quoted text, reason, citedRule, suggestedRewrite). A 「再チェック」button POSTs to `/api/screenplays/${screenplayId}/check` and replaces the displayed result with the response, with a busy state. Use the existing card/badge styling idioms from the repo (match `FeedbackForm.tsx`). Keep labels Japanese (法規/ファクト/品質, 再チェック, 試験結果, スコア).

- [ ] **Step 3: Fetch the latest check on the page**

In `app/[locale]/(produce)/screenplays/[id]/page.tsx`, after the existing screenplay+versions fetch, query the latest `screenplay_version_checks` row for the current version:

```ts
let latestCheck = null;
if (screenplay.current_version_id) {
  const { data } = await sb
    .from("screenplay_version_checks")
    .select("overall_score, result, created_at")
    .eq("version_id", screenplay.current_version_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (data) latestCheck = { ...(data.result as object), created_at: data.created_at };
}
```

Pass `latestCheck` + `screenplay.id` into `ScreenplayWorkspace`.

- [ ] **Step 4: Render the panel in the workspace**

In `ScreenplayWorkspace.tsx`, add the `screenplayId` + `latestCheck` props and render `<CheckResultPanel ... />` in the right column above (or as a toggle alongside) `FeedbackForm`. Follow the existing column markup.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`. Then:

```bash
git add components/screenplay/CheckResultPanel.tsx components/screenplay/ScreenplayWorkspace.tsx "app/[locale]/(produce)/screenplays/[id]/page.tsx"
git commit -m "feat(compliance): 試験結果 panel in screenplay workspace"
```

---

## Task 8: Full verification

- [ ] **Step 1: Unit test** — `npm run test:compliance-lexicon` → 5 assertions PASS.
- [ ] **Step 2: Live test** — `npm run test:screenplay-check` → PASS (or SKIPPED if migration unapplied; never FAIL on deterministic assertions).
- [ ] **Step 3: Typecheck + lint** — `npx tsc --noEmit` clean; `npm run lint` no new issues.
- [ ] **Step 4: Manual (if DB applied + dev server)** — generate/refine a screenplay → a `screenplay_version_checks` row appears; the workspace shows the 試験結果 panel; 再チェック appends a new result.

---

## Self-Review

**Spec coverage:**
- §2 Japanese data needed → seed lexicon in Task 1 (薬機法 NG, 56効能 allowed, 景表法, 健康増進法). ✅
- §4.1 two tables + RLS (compliance_rules read member/admin write admin; screenplay_version_checks append-only member/admin) → Tasks 1-2. ✅
- §4.2 checker: deterministic pass (category-scoped, allowed-suppression) + LLM pass (Flash, structured) + merge + score → Tasks 3-4. ✅
- §4.3 execution: auto workflow step (non-fatal) + on-demand POST route → Tasks 5-6. ✅
- §4.4 UI 試験結果 panel + 再チェック → Task 7. ✅
- §4.5 reads/auth: routes member|admin; tables Group B; viewer excluded → Tasks 1,2,6. ✅
- §5 tests: lexicon unit (strict) + integration (loose on LLM) + seed sanity → Tasks 3-4 (seed sanity is the `rules.length===0` skip guard in Task 4). ✅

**Placeholder scan:** Task 7 Steps 2/4 describe the panel/markup rather than full JSX — this is deliberate: the exact markup must match the existing `ScreenplayWorkspace`/`FeedbackForm` styling, which the implementer reads in Step 1. The data contract (props, the POST call, the three axes) is fully specified. All backend tasks (1-6) have complete code. Acceptable for a UI task in an existing design system.

**Type consistency:** `ComplianceRule`/`Finding`/`ScriptCheckResult` defined in Task 3 `types.ts`; used by `lexicon-match.ts` (Task 3), `check.ts` (Task 4), the workflow (Task 5), the route (Task 6), and the panel (Task 7). `checkScreenplay(markdown, brief, rules)` + `loadActiveRules()` signatures consistent across Tasks 4-6. `result` JSONB shape = `{legal,facts,quality}` consistent in the migration comment (Task 2), checker (Task 4), and panel (Task 7). ✅

**Open verification (implementer must confirm):**
- `requireUser` success shape — `auth.user.id` vs `auth.userId` (Task 6 Step 1 note). Read `lib/auth/require-user.ts`.
- `public.current_user_role()` exists (used by the existing `2026-05-26_screenplays_rls.sql`, so it does). ✅
- Migration application path in this environment (Tasks 1-2 Step 2) — if unavailable, unit tests still pass; live tests skip.

**Decomposition / risk:** The checker (`lexicon-match.ts` pure + `check.ts` LLM) is isolated and independently tested. The auto-check is non-fatal so it can never break generation. The LLM pass degrades gracefully to deterministic-only. The biggest external dependency is migration application — explicitly surfaced, with unit tests that don't need it.
```
