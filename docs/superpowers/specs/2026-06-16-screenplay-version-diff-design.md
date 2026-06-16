# 設計: 台本バージョン変更点レビュー (diff + 理由)

- **Date**: 2026-06-16
- **Status**: Design approved — pending implementation plan
- **Author**: brainstorming session (user + Claude)
- **Builds on**: the screenplay (台本) subsystem — `screenplay_versions` (markdown / feedback / base_version_id), the refine loop, and the compliance check (`screenplay_version_checks`). Related: `2026-06-16-screenplay-draft-import-design.md`.

## 1. Context & Goal

After importing a draft and refining it (改稿), the operator gets a new full version (v2, v3, …) but **no view of what actually changed between versions or why**. The version timeline records the 改稿 *instruction* (`feedback`) per version, and the viewer shows one version at a time (⌘←/→), but there is no line-level diff and no per-change rationale. The operator's words: 「어디가 어떻게 왜 바뀌었는지를 봐야 제대로 검토가 되지」.

**Goal**: for any version that was refined from a previous one (v2+), let the operator see, in the workspace:
- **어디 / 어떻게 (where / how)** — an exact, mechanical diff between the version and its immediate predecessor (`base_version_id`).
- **왜 (why)** — a short AI-authored reason attached to each changed region, grounded in that refine's instruction and the predecessor's compliance findings.

### Decided in brainstorming
- **Production model**: computed diff is the ground truth for *where/how*; AI **explains** the computed hunks (it does not self-report changes) for *why*. This keeps "what changed" always accurate and confines the AI to explanation, minimizing hallucination.
- **Comparison scope**: immediate predecessor only (v_{n-1} → v_n) — "what changed in this refine." Not arbitrary version pairs.
- **Caching**: the AI rationale is computed once per version and cached (new `change_notes jsonb` column on `screenplay_versions`). The base is fixed (`base_version_id`), so a version's diff/rationale is stable.

## 2. Non-Goals

- Arbitrary two-version comparison (v1 ↔ v3). Predecessor-only for v1.
- Side-by-side two-pane diff. Inline (single-column) diff to match the existing viewer; revisit if needed.
- Auto-applying the 試験 suggested rewrites, or any content mutation. This is read-only review.
- A diff for v1 itself — v1 has no `base_version_id` (initial generation or faithful import), so there is nothing to compare; the toggle is hidden for v1.
- Word/PDF export of the diff. Export stays per-version as today.

## 3. Architecture & Data Flow

```
ScreenplayWorkspace (has all versions in memory)
  selected version v_n (n≥2, has base_version_id = v_{n-1}.id)
  → passes baseMarkdown (v_{n-1}.markdown) + version ids to ScreenplayViewer

ScreenplayViewer
  「変更点」 toggle (shown only when baseMarkdown is present)
  ON:
    - computeLineDiff(baseMarkdown, markdown)  [lib/screenplay/diff.ts — runs in the browser, instant]
      → renders inline: added lines (green), removed lines (red str..through), context dimmed
    - fetch GET /api/screenplays/{id}/versions/{versionId}/changes  → { rationale: HunkReason[] }
      → attaches 💡 理由 to each changed hunk (loading state while fetching; diff shows immediately)
  OFF: existing 完成版 rendering (ScreenplayMarkdown)

GET /api/screenplays/{id}/versions/{versionId}/changes  (requireUser member|admin)
  - load version v_n (markdown, base_version_id, feedback, change_notes)
  - if change_notes cached → return it
  - else: load base v_{n-1}.markdown; load v_{n-1}'s latest check findings (optional grounding)
    → computeLineDiff(base, v_n)            [same lib/screenplay/diff.ts — server side]
    → explainChanges(diff, feedback, findings)  [lib/screenplay/change-rationale.ts — Gemini]
    → persist result to v_n.change_notes (cache); return it
  - 404 if version has no base_version_id (v1) or not found
```

`lib/screenplay/diff.ts` is the single shared diff implementation, imported by both the client renderer and the server endpoint, so the hunks the AI explains are exactly the hunks the user sees.

## 4. Components (all additive to the screenplay subsystem)

### `lib/screenplay/diff.ts` (pure, DB-free, no `server-only`)
- Wraps **`diff`** (jsdiff) `diffLines` to compare two markdown strings.
- Exports `computeLineDiff(base: string, next: string): DiffHunk[]`.
- A `DiffHunk` groups one contiguous changed region with small surrounding context:
  ```ts
  interface DiffLine { type: "context" | "added" | "removed"; text: string }
  interface DiffHunk { index: number; lines: DiffLine[] }   // index = stable hunk ordinal
  ```
- Unchanged-only input → `[]` (no hunks). Deterministic; fully unit-testable.

### `lib/screenplay/change-rationale.ts` (Gemini; no `server-only`)
- `explainChanges(hunks, feedback, findings): Promise<HunkReason[]>` where `HunkReason = { index: number; reason: string }`.
- One Gemini call (`GEMINI_FLASH`, `responseMimeType: application/json`, `maxOutputTokens` sized for short reasons). System instruction: "You are given the EXACT diff hunks (already computed). For each hunk index, write a one-line Japanese reason it changed. Ground reasons in the provided 改稿 instruction and the listed compliance findings. If a change is not explained by either, label it 文体・表現の調整 — do NOT invent a compliance reason." Input: the numbered hunks (removed/added text) + the `feedback` + a compact list of the predecessor's findings (quote + axis + severity).
- Returns `[]` (or all reasons = "") gracefully on parse failure; the endpoint still returns the diff.

### `GET /api/screenplays/[id]/versions/[versionId]/changes`
- `requireUser(["member","admin"])`, `auth.error` on failure; `getServiceClient` for reads (matches sibling screenplay routes).
- Validates UUIDs; loads `versionId` (must belong to `[id]`); 404 if missing or `base_version_id` is null.
- Returns **rationale only** — `{ rationale: HunkReason[], model, computedAt }`. The client computes the diff itself for rendering; the server computes the same diff (shared `diff.ts`) solely to feed/index the model, and `HunkReason.index` aligns with the client's hunk ordinals because both call the identical `computeLineDiff`. (Returning the hunks too would be redundant.)
- Cache hit (`change_notes` non-null) → return it immediately. Else compute diff + rationale, persist `change_notes` (jsonb: `{ rationale: HunkReason[], model, computedAt }`), return it.
- `maxDuration` modest (e.g. 60). Masks raw provider errors (like the import route); diff-only fallback (empty `rationale`) if the model errors.

### DB — migration `2026-06-16_screenplay_version_change_notes.sql`
- `ALTER TABLE screenplay_versions ADD COLUMN change_notes jsonb;` (nullable). No RLS change needed (table already gated; reads via service client in the route). **Applied manually** (repo has no `db:push`); ship a skip-guarded live check.

### UI — `ScreenplayViewer` + a small `ChangeDiffView`
- `ScreenplayViewer` gains optional props `baseMarkdown?: string`, `screenplayId`, `versionId`. When `baseMarkdown` is set (v2+), render a 「変更点」 toggle next to the version label.
- `ChangeDiffView` (new component): given `baseMarkdown` + `markdown`, computes the diff client-side and renders inline (added/removed/context) with each hunk's `💡 理由` (fetched from the endpoint; spinner until loaded; if rationale empty, show diff only).
- `ScreenplayWorkspace` passes `baseMarkdown` = the markdown of the version whose `id === selected.base_version_id` (looked up from its in-memory `versions` array; null if not found → toggle hidden).

## 5. Trust & Safety
- The diff is deterministic and computed identically on client and server (shared module) → "what changed" is always exact and never AI-fabricated.
- The AI only annotates *why*, grounded in the stored instruction + findings; unexplained changes are honestly labeled stylistic, not given invented legal reasons.
- Graceful degradation: rationale failure (Gemini error/parse) → the diff (어디/어떻게) still renders; 理由 simply absent. The check/refine paths are untouched.

## 6. Testing
- `lib/screenplay/diff.ts` unit tests (added / removed / changed / no-change / multi-hunk) — DB-free, offline.
- `change-rationale` parse unit (canned Gemini JSON: valid, missing, extra indices) + `--env-file` live smoke (two real versions → reasons).
- Endpoint: covered by tsc + a skip-guarded live test that exercises cache miss → hit. Migration presence checked via `npm run test:migrations`.
- Viewer toggle: tsc + build + production manual walkthrough (open a v2, toggle 変更点, confirm diff + 理由).

## 7. File summary
New: `lib/screenplay/diff.ts`, `lib/screenplay/change-rationale.ts`, `app/api/screenplays/[id]/versions/[versionId]/changes/route.ts`, `components/screenplay/ChangeDiffView.tsx`, `supabase/migrations/2026-06-16_screenplay_version_change_notes.sql`, `scripts/test-screenplay-diff.ts`.
Modified: `components/screenplay/ScreenplayViewer.tsx` (toggle + props), `components/screenplay/ScreenplayWorkspace.tsx` (pass baseMarkdown/ids), `lib/screenplay/types.ts` (ScreenplayVersionRow gains `base_version_id` already present; add `change_notes` typing), `package.json` (add `diff`).

## 8. Decisions log
- diff = ground truth for where/how; AI explains why only. [user]
- predecessor-only comparison (v_{n-1} → v_n). [user]
- cache rationale in `screenplay_versions.change_notes jsonb` (manual migration). [user]
- inline single-column diff (not side-by-side); toggle hidden for v1.
- `diff` (jsdiff) for line diffing; shared client/server module.
