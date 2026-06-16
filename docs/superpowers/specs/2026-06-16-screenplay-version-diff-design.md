# 設計: 台本バージョン変更点レビュー (diff + 理由)

- **Date**: 2026-06-16
- **Status**: Design approved — pending implementation plan
- **Author**: brainstorming session (user + Claude)
- **Builds on**: the screenplay (台本) subsystem — `screenplay_versions` (markdown / feedback / base_version_id), the refine loop, and the compliance check (`screenplay_version_checks`). Related: `2026-06-16-screenplay-draft-import-design.md`.

## 1. Context & Goal

After importing a draft and refining it (改稿), the operator gets a new full version (v2, v3, …) but **no view of what actually changed between versions or why**. The version timeline records the 改稿 *instruction* (`feedback`) per version, and the viewer shows one version at a time (⌘←/→), but there is no line-level diff and no per-change rationale. The operator's words: 「어디가 어떻게 왜 바뀌었는지를 봐야 제대로 검토가 되지」.

**Goal**: for any version that was refined from another (i.e. has a `base_version_id`), let the operator see, in the workspace:
- **어디 / 어떻게 (where / how)** — an exact, mechanical diff between the version and its **parent** — the version it was refined from, identified by `base_version_id`.
- **왜 (why)** — a short AI-authored reason attached to each changed region, grounded in that refine's instruction and the parent's compliance findings.

### Decided in brainstorming
- **Production model**: computed diff is the ground truth for *where/how*; AI **explains** the computed hunks (it does not self-report changes) for *why*. This keeps "what changed" always accurate and confines the AI to explanation, minimizing hallucination.
- **Comparison scope**: a version vs its **parent (`base_version_id`)** — "what changed in *this* refine." NOT `version_number − 1`. The refine UX lets the operator refine from any selected version (`ScreenplayWorkspace` passes the *selected* version as the refine base; the workflow sets `version_number = max+1` but stores `base_version_id` = whatever was refined from), so version-number order is not the parent chain. Comparing against the true parent matches both the data model and the operator's intent. Not arbitrary version pairs.
- **Caching**: the AI rationale is cached per version in a new `change_notes jsonb` column on `screenplay_versions`, but **only on success** and **validated by a cache key** (see §3) so a transient failure or a changed input is never served stale.

## 2. Non-Goals

- Arbitrary two-version comparison (e.g. v1 ↔ v3 picked by hand). Parent-only.
- Forcing a linear version history. The branchy `base_version_id` model is kept as-is; we compare against the recorded parent.
- Side-by-side two-pane diff. Inline (single-column) diff to match the existing viewer; revisit if needed.
- Auto-applying the 試験 suggested rewrites, or any content mutation. This is read-only review.
- A diff for v1 itself — v1 has no `base_version_id` (initial generation or faithful import), so there is nothing to compare; the toggle is hidden for v1.
- Word/PDF export of the diff. Export stays per-version as today.

## 3. Architecture & Data Flow

```
ScreenplayWorkspace (has all versions in memory)
  selected version v with v.base_version_id != null
  → finds parent = versions.find(x => x.id === v.base_version_id)
  → passes baseMarkdown (parent.markdown) + version ids to ScreenplayViewer
    (toggle hidden if base_version_id is null OR parent not in the loaded list)

ScreenplayViewer
  「変更点」 toggle (shown only when baseMarkdown is present)
  ON:
    - computeLineDiff(baseMarkdown, markdown)  [lib/screenplay/diff.ts — runs in the browser, instant]
      → renders inline: added lines (green), removed lines (red str..through), context dimmed
    - fetch GET /api/screenplays/{id}/versions/{versionId}/changes  → { rationale: HunkReason[] }
      → attaches 💡 理由 to each changed hunk (loading state while fetching; diff shows immediately)
  OFF: existing 完成版 rendering (ScreenplayMarkdown)

GET /api/screenplays/{id}/versions/{versionId}/changes  (requireUser member|admin)
  - load version v (markdown, base_version_id, feedback, change_notes) WHERE screenplay_id = {id}
  - 404 if not found, or base_version_id is null
  - load parent = base_version_id row, REQUIRING parent.screenplay_id = {id}  (reject cross-screenplay base → 404)
  - load parent's latest check row id + findings (for grounding)
  - compute currentKey = { diffVersion, promptVersion, model, baseVersionId, baseCheckId, hunkCount }
  - if change_notes?.ok === true AND change_notes.key deep-equals currentKey → return cached
  - else: diff = computeLineDiff(parent.markdown, v.markdown)   [same lib/screenplay/diff.ts]
          rationale = explainChanges(diff, feedback, findings)   [change-rationale.ts — Gemini]
          on success → persist change_notes = { ok:true, key:currentKey, rationale, computedAt }; return it
          on failure → do NOT persist (leave change_notes as-is); return { rationale: [] } this call (retries next time)
```
`diffVersion`/`promptVersion` are constants bumped when the diff algorithm or the rationale prompt changes; together with `model`, `baseVersionId`, `baseCheckId`, and `hunkCount` they form the cache key so a stale cache (algorithm/prompt/model change, a re-run check, or a different base) is recomputed rather than served.

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

### Shared types in `lib/screenplay/types.ts`
- `DiffLine`, `DiffHunk` (from diff), `HunkReason`, and `ChangeNotes` (the cached jsonb shape) live in `types.ts` so the **client** can import the types it renders (`HunkReason`) WITHOUT transitively importing the Gemini rationale module. The client imports `diff.ts` (pure) + these types only; it never imports `change-rationale.ts`.

### `lib/screenplay/change-rationale.ts` (Gemini)
- `explainChanges(hunks, feedback, findings): Promise<HunkReason[]>` where `HunkReason = { index: number; reason: string }`.
- One Gemini call (`GEMINI_FLASH`, `responseMimeType: application/json`, `maxOutputTokens` sized for short reasons). System instruction: "You are given the EXACT diff hunks (already computed). For each hunk index, write a one-line Japanese reason it changed. Ground reasons in the provided 改稿 instruction and the listed compliance findings. If a change is not explained by either, label it 文体・表現の調整 — do NOT invent a compliance reason." Input: the numbered hunks (removed/added text) + the `feedback` + a compact list of the parent's findings (quote + axis + severity).
- **On any failure (Gemini error or JSON parse) it throws** (it does NOT return `[]` masquerading as success), so the route can distinguish failure from a genuinely empty result and avoid caching a failure (see §3).
- **`server-only` is intentionally omitted**, matching the repo convention for Gemini modules that have a `tsx` smoke test (`lib/screenplay/import/normalize.ts`, `extract/from-pdf.ts`, … all omit it — `server-only` throws under `tsx`). The server boundary is enforced structurally instead: this module is imported ONLY by the route (never by a client component, since the client uses the endpoint + the shared types above), and it reads the non-public `GEMINI_API_KEY`.

### `GET /api/screenplays/[id]/versions/[versionId]/changes`
- `requireUser(["member","admin"])`, `auth.error` on failure; `getServiceClient` for reads (matches sibling screenplay routes).
- Validates UUIDs; loads `versionId` **`WHERE screenplay_id = id`**; 404 if missing or `base_version_id` is null.
- Loads the parent via `base_version_id` **and requires `parent.screenplay_id === id`** → 404 on a cross-screenplay base (defends the diff against bad `base_version_id` data; see the refine hardening below).
- Returns **rationale only** — `{ rationale: HunkReason[], model, computedAt }`. The client computes the diff itself for rendering; the server computes the same diff (shared `diff.ts`) solely to feed/index the model, and `HunkReason.index` aligns with the client's hunk ordinals because both call the identical `computeLineDiff`.
- Cache: validated by key (§3) and **success-only** — a cache hit requires `change_notes.ok === true` and a matching key; a transient model/parse failure is never persisted, so it retries next view.
- `maxDuration` modest (e.g. 60). Masks raw provider errors (like the import route); on model failure the route still returns `{ rationale: [] }` so the **client still renders the diff** (理由 simply absent).

### Refine base-version hardening (`app/api/screenplays/[id]/refine/route.ts`)
- The refine route currently accepts an arbitrary `baseVersionId` UUID without confirming it belongs to `[id]` (`refine/route.ts:38`), and the workflow loads its markdown by id alone. Add a `.eq("screenplay_id", id)` guard so a version from another screenplay can never become a base. This keeps the `base_version_id` chain — which this feature's diff relies on — sound at the source. (Small, targeted; the diff endpoint's parent check above is the defense-in-depth counterpart.)

### DB — migration `2026-06-16_screenplay_version_change_notes.sql`
- `ALTER TABLE screenplay_versions ADD COLUMN change_notes jsonb;` (nullable, default null). Stores `{ ok, key, rationale, computedAt }` (only when `ok`). No RLS change needed (table already gated; reads via service client in the route). **Applied manually** (repo has no `db:push`); ship a skip-guarded live check.

### UI — `ScreenplayViewer` + a small `ChangeDiffView`
- `ScreenplayViewer` gains optional props `baseMarkdown?: string`, `screenplayId`, `versionId`. When `baseMarkdown` is set (v2+), render a 「変更点」 toggle next to the version label.
- `ChangeDiffView` (new component): given `baseMarkdown` + `markdown`, computes the diff client-side and renders inline (added/removed/context) with each hunk's `💡 理由` (fetched from the endpoint; spinner until loaded; if rationale empty, show diff only).
- `ScreenplayWorkspace` passes `baseMarkdown` = the markdown of the version whose `id === selected.base_version_id` (looked up from its in-memory `versions` array; null if no `base_version_id` or the parent isn't loaded → toggle hidden).

## 5. Trust & Safety
- The diff is deterministic and computed identically on client and server (shared module) → "what changed" is always exact and never AI-fabricated.
- The AI only annotates *why*, grounded in the stored instruction + findings; unexplained changes are honestly labeled stylistic, not given invented legal reasons.
- Failures are never cached: a transient Gemini/parse error returns `{ rationale: [] }` for that call and leaves `change_notes` null, so it retries on the next view (never frozen as "理由 없음"). The diff (어디/어떻게) renders regardless. The check/refine paths are untouched.
- Cross-screenplay `base_version_id` is rejected at both the diff endpoint and the refine route, so the comparison is always within one screenplay.

## 6. Testing
- `lib/screenplay/diff.ts` unit tests (added / removed / changed / no-change / multi-hunk; stable hunk indices) — DB-free, offline.
- `change-rationale` parse unit (canned Gemini JSON: valid, missing index, extra index) + assert it **throws** on bad JSON (not returns `[]`) + `--env-file` live smoke (two real versions → reasons).
- Endpoint: tsc + a skip-guarded live test exercising cache miss → hit and key-mismatch → recompute. Migration presence checked via `npm run test:migrations`.
- Viewer toggle: tsc + build + production manual walkthrough (open a refined version, toggle 変更点, confirm diff + 理由).

## 7. File summary
New: `lib/screenplay/diff.ts`, `lib/screenplay/change-rationale.ts`, `app/api/screenplays/[id]/versions/[versionId]/changes/route.ts`, `components/screenplay/ChangeDiffView.tsx`, `supabase/migrations/2026-06-16_screenplay_version_change_notes.sql`, `scripts/test-screenplay-diff.ts`.
Modified: `components/screenplay/ScreenplayViewer.tsx` (toggle + props), `components/screenplay/ScreenplayWorkspace.tsx` (pass parent markdown/ids), `lib/screenplay/types.ts` (add `DiffLine`/`DiffHunk`/`HunkReason`/`ChangeNotes`; `change_notes` on `ScreenplayVersionRow`), `app/api/screenplays/[id]/refine/route.ts` (base-version `screenplay_id` guard), `package.json` (add `diff`).

## 8. Decisions log
- diff = ground truth for where/how; AI explains why only. [user]
- compare a version against its **parent (`base_version_id`)**, not `version_number − 1` (matches the branchy refine data model + the operator's "this refine's changes" intent). [user intent, clarified in review]
- cache rationale in `screenplay_versions.change_notes jsonb`, **success-only + key-validated** (manual migration). [user + review]
- `change-rationale.ts` omits `server-only` (repo `tsx`-smoke convention); client never imports it (shared types in `types.ts`). [review]
- harden refine + diff endpoint against cross-screenplay `base_version_id`. [review]
- inline single-column diff (not side-by-side); toggle hidden when no parent.
- `diff` (jsdiff) for line diffing; shared client/server module.
