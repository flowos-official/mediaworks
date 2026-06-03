# Screenplay Check Tool (試験ツール) — Design

**Status**: Approved brainstorm, ready for implementation plan
**Date**: 2026-06-02
**Scope**: A "check tool" that runs alongside screenplay creation, evaluating each script version on three axes — (a) 薬機法・景品表示法 legal compliance, (b) fact/number accuracy, (c) script quality/structure — and surfacing the results in the screenplay workspace with cited rules and suggested rewrites. Largest of the four operator-feedback items; new feature.

---

## 1. Goal

Operator feedback: "Can the script be checked at the same time as it's written? And what Japan-provided data is needed for that?"

Deliver a per-version check producing a structured report:
- **(a) Legal** — flag 薬機法 (cosmetics/quasi-drugs/health-foods/medical-devices) prohibited expressions and 景品表示法 / 健康増進法 issues (優良誤認, 有利誤認, unsubstantiated No.1 / 最高 / 業界初 claims).
- **(b) Fact** — flag numeric/factual claims (price, %, 成分量, "売上No.1") not backed by the product's own source of truth.
- **(c) Quality** — flag structural/style gaps (missing opening/demo/offer/CTA, time-budget imbalance, role imbalance, telop coverage) against the style bible.

Decisions from brainstorm:
- **Legal data strategy: hybrid** — a curated NG-expression lexicon (deterministic, high-precision) + LLM judgment (context/paraphrase). Initial lexicon seeded from public Japanese regulatory sources; admin-editable thereafter.
- **Run timing: automatic on generate/refine + on-demand re-check.**

## 2. The Japanese Reference Data Needed (operator's explicit question)

| Axis | Data | Source |
|---|---|---|
| Legal | 薬機法 NG-expression list per category (化粧品 / 医薬部外品 / 健康食品 / 医療機器 / 一般) | 東京都「化粧品等の適正な広告のために」, 消費者庁 措置命令 examples, 厚労省 通知 |
| Legal | 化粧品 56効能 whitelist (allowed expressions — suppresses false positives) | 日本化粧品工業連合会 / 厚労省 56効能リスト |
| Legal | 景品表示法 guidance: 優良誤認・有利誤認 examples, **No.1表示 substantiation requirement**, 「業界初/最高」rules | 消費者庁 景表法 運用基準, No.1表示 実態調査 |
| Legal | 健康増進法 誇大表示 standard (health foods) | 消費者庁 |
| Fact | The product's own source of truth — `screenplays.product_info_snapshot`, `research_results`, `discovered_products.c_package` | internal (no external data) |
| Quality | `lib/screenplay/style-bible.json` + structural rules | internal |

The legal data ships as a **seed lexicon** loaded into the `compliance_rules` table (starter set from the public sources above), expanded operationally. External live web fact-verification is **out of scope** for v1.

## 3. Current State (verified)

- Generation: `app/api/screenplays/route.ts` → `lib/workflows/screenplay.workflow.ts` (`loadPreviousMarkdownStep → generateStep → persistStep`) → `screenplay_versions` (append-only, `version_number`++ , `base_version_id` chain).
- Refine: `app/api/screenplays/[id]/refine/route.ts` — CAS guard (`status != generating`), re-runs the workflow with director `feedback`.
- **Script is read-only** in the UI — revision is always AI `refine`, never direct text edit. So "check as you type" does not fit; **check at generate/refine + on-demand** is the correct model.
- Workspace `components/screenplay/ScreenplayWorkspace.tsx`: 3 columns — `VersionTimeline | ScreenplayViewer (read-only) | FeedbackForm`.
- `screenplays.product_info_snapshot` (JSONB) preserves the brief at creation → fact-check source without re-joining.
- Reusable AI-review pattern: `lib/competitor-fit/analyze.ts` — structured-JSON scoring with model fallback + timeout guards. The check result mirrors its shape.
- Models in `lib/gemini-models.ts`; generator uses `GEMINI_PRO_FALLBACK` + `ThinkingLevel.HIGH` (slow). The checker should use **Flash** with its own timeout.
- Auth: screenplay routes are `requireUser(['member','admin'])`; `viewer` is not allowed (`lib/auth/route-permissions.ts`).

## 4. Design

### 4.1 Data model (2 migrations)

**`compliance_rules`** — the NG-expression lexicon (Group B RLS: read member|admin, write admin):

| column | type | note |
|---|---|---|
| id | uuid pk | |
| law | text | `'yakkihō' \| 'keihyō' \| 'kenzō'` (薬機法/景表法/健康増進法) |
| category_scope | text[] | e.g. `{化粧品,医薬部外品}`; empty = all categories |
| pattern | text | literal phrase or regex (a `is_regex bool` flag) |
| allowed | bool | true = whitelist (e.g. a 56効能 phrase); suppresses a flag |
| severity | text | `'high' \| 'med' \| 'low'` |
| reason | text | why it violates (shown to operator) |
| safe_rewrite | text | suggested compliant phrasing |
| citation | text | which law/guideline article |
| active | bool | soft-disable without delete |
| created_at / updated_at | timestamptz | |

Seeded by a migration from a committed JSON starter set (`lib/screenplay/compliance/seed-rules.ja.json`). Admin-edit UI deferred to phase 2 (v1 = table + seed; admins edit via SQL until then).

**`screenplay_version_checks`** — append-only results (Group B RLS):

| column | type | note |
|---|---|---|
| id | uuid pk | |
| version_id | uuid fk → screenplay_versions | |
| overall_score | int | 0-100 |
| result | jsonb | `{ legal: Finding[], facts: Finding[], quality: Finding[] }` |
| lexicon_version | text | hash/timestamp of the rule set used (reproducibility) |
| is_auto | bool | true = emitted by the workflow; false = on-demand |
| created_by | uuid null | null for auto |
| created_at | timestamptz | |

`Finding = { severity, quote, location?, citedRule?, reason, suggestedRewrite? }`.

### 4.2 Checker module `lib/screenplay/compliance/check.ts`

`checkScreenplay(markdown, productBrief, rules): Promise<ScriptCheckResult>` — mirrors `competitor-fit/analyze.ts`:

1. **Deterministic pass** (`lexicon-match.ts`): scope `rules` to the product category, match each `pattern` (literal/regex) against the markdown; record exact location (block index / line) and severity. `allowed=true` matches in the same span suppress a violation (56効能 whitelist). High precision, no LLM cost.
2. **LLM pass** (Gemini **Flash**, structured output, own timeout): input = markdown + `product_info_snapshot` + the scoped rule set (as context) + the 56効能 whitelist. Output JSON:
   - contextual legal violations (paraphrases / 優良誤認 / 有利誤認 the lexicon can't catch literally),
   - fact flags (claims with numbers/superlatives not supported by the brief),
   - quality notes (structure/style-bible gaps).
3. **Merge** deterministic + LLM findings (dedup by quote+law), compute `overall_score`, return `ScriptCheckResult`.

Reuse the model-fallback + retry idiom from `analyze.ts`. The pass is purely read-only over inputs (no row mutation inside the checker).

### 4.3 Execution paths

- **Automatic**: add a `checkStep` after `persistStep` in `screenplay.workflow.ts`. It reads the just-persisted version's markdown + the screenplay's `product_info_snapshot`, loads active `compliance_rules`, runs `checkScreenplay`, inserts a `screenplay_version_checks` row (`is_auto=true`). Failure is non-fatal — the version still completes; the check row is simply absent and re-runnable on demand (log the error, don't fail the generation).
- **On-demand**: `POST /api/screenplays/:id/check` (`requireUser(['member','admin'])`, `auth.sb` so RLS applies). Re-checks the current version, appends a new result row (`is_auto=false`, `created_by=auth.uid()`). No CAS needed (append-only, idempotent-ish); guard against trivial double-submit client-side.

### 4.4 UI — workspace check surface

`ScreenplayWorkspace` right column gains a 「試験 結果」tab/panel above (or toggled with) `FeedbackForm`:
- Header: overall score + counts per axis.
- Three grouped sections (法規 / ファクト / 品質). Each finding card: severity badge, the quoted offending text, cited rule/law, `reason`, and `suggestedRewrite`.
- 「再チェック」button → `POST /api/screenplays/:id/check`.
- The latest check for the displayed version is loaded server-side in the page (`getServerClient`), or fetched client-side on tab open.
- *Nice-to-have (note, not v1-blocking):* a "この修正をフィードバックに送る" action that drops a finding's `suggestedRewrite` into `FeedbackForm` to trigger a refine. *Nice-to-have:* inline highlight of the offending span in `ScreenplayViewer` by text match.

### 4.5 Reads / auth

- `GET /api/screenplays/:id/check` (or fold the latest check into the existing page fetch) — member|admin.
- `screenplay_version_checks` + `compliance_rules` get Group B RLS policies. `viewer` stays excluded (matches screenplay routes).

## 5. Tests

- `npm run test:compliance-lexicon` (unit, no DB): deterministic matcher — known NG phrase hits with correct location/severity; category scoping (a 化粧品-only rule does not fire on a 健康食品 brief); `allowed` 56効能 phrase suppresses a would-be flag; regex vs literal patterns.
- `npm run test:screenplay-check` (integration, live DB + Gemini): run `checkScreenplay` on a fixture markdown containing seeded violations + an unsupported numeric claim + a missing-CTA structure; assert `result` has ≥1 finding in each relevant axis and a sane `overall_score`. Tolerate LLM nondeterminism by asserting on the deterministic-pass findings strictly and the LLM-pass findings loosely (presence/shape, not exact text).
- Seed-data sanity: a script asserting the JSON seed loads into `compliance_rules` and every row has `law`, `pattern`, `severity`, `reason`.

## 6. Edge Cases & Failure Modes

| Scenario | Behavior |
|---|---|
| Gemini Flash timeout/error during auto check | Non-fatal: version completes, no check row; operator can 再チェック. Logged. |
| Product category unknown in brief | Checker applies only category-agnostic rules (`category_scope` empty) + LLM pass; logs the gap. |
| Lexicon empty (pre-seed) | Deterministic pass yields nothing; LLM pass still runs. Check still produces a result. |
| Re-check after rules edited | New row with the new `lexicon_version`; history preserved (append-only). |
| Long script exceeds model context | Chunk by section headings for the LLM pass (deterministic pass is whole-doc, cheap). |
| False positive on a literal NG phrase used in a compliant context | LLM pass can down-rank; operator judgment final — findings are advisory, never block generation. |

## 7. Success Criteria

- Generating/refining a screenplay auto-produces a `screenplay_version_checks` row; the workspace shows the 試験 結果 panel with the three axes populated.
- A script containing a known 薬機法 NG phrase (e.g. a non-56効能 cosmetic efficacy claim) is flagged with the cited law and a `safe_rewrite`.
- A numeric claim absent from `product_info_snapshot` is flagged as a fact issue.
- A script missing a CTA/offer section is flagged as a quality issue.
- 再チェック re-runs and appends a fresh result.
- `test:compliance-lexicon` passes strictly; `test:screenplay-check` passes on structure.

## 8. Out-of-Scope Future Work

- Admin UI to manage `compliance_rules` (v1 is table + JSON seed + SQL edit).
- Live external fact verification (Rakuten/Brave) for claims like "楽天1位".
- Inline highlight of offending spans in the viewer; one-click finding→refine handoff.
- `viewer`-readable check results.
- Per-axis configurable severity thresholds / blocking gates (v1 is advisory only).
- Localizing the panel (JP UI; KR labels) consistent with the rest of the produce surface.
