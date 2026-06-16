# 設計: Word 대본 초안 임포트 (Screenplay Draft Import)

- **Date**: 2026-06-16
- **Status**: Design approved — pending implementation plan
- **Author**: brainstorming session (user + Claude)
- **Related**: `2026-06-02-screenplay-docx-export-design.md` (the export side of this round-trip), `2026-06-04-screenplay-check-grounding-design.md` (the compliance check this reuses)

## 1. Context & Goal

The screenplay (台本) subsystem today supports exactly one entry path: upload **product material** (PDF / Excel / image / URL) → Gemini extracts a `ProductBrief` → a Workflow run generates a full script from scratch (canonical tagged Markdown) → auto-check + auto-remediate → version 1. From there the operator refines (改稿) and re-checks (試験) any number of times. A DOCX **export** exists (`lib/screenplay/screenplay-docx.ts`), but there is **no import path** — a script written or edited outside the app cannot be brought back in.

**Goal**: let an operator upload an existing **draft script** as a Word `.docx`, bring it into the system as version 1, and then use the existing refine + check loop to improve it and review the 試験結果.

This is a script-import flow, distinct from the existing product-material→brief extraction. The draft format varies (sometimes a lightly-edited export from this app, sometimes freeform Word), so we rely on **AI normalization** rather than a mechanical reverse-parser.

### Core contract (decided in brainstorming)

> **The draft the user uploads is the source of truth.** Import normalizes *structure only* and preserves the writer's wording. It does **not** auto-rewrite for compliance. High-severity legal findings are surfaced in red in the 試験結果; the operator fixes them deliberately via 改稿. This is an intentional difference from the generation path, where `AUTO_REMEDIATE` rewrites high-severity violations automatically.

## 2. Non-Goals

- Importing **product material** in Word form to seed a brief (a different fork the user explicitly did not choose).
- Legacy `.doc` (OLE2 binary) support — explicit `415` with guidance to re-save as `.docx`.
- Lossless export↔import round-trip guarantee. We validate fidelity with a fixture (§7) but do not promise byte-exact reconstruction.
- Quality improvement at import time (no rewrite, no auto-remediate). Improvement happens later via the existing refine loop.
- Schema changes. We reuse `screenplays`, `screenplay_versions`, `screenplay_version_checks` as-is.

## 3. User Flow

1. `/screenplays/new` shows a top-level segmented switch:
   - **「商品資料から生成」** — existing flow (`ScreenplayCreateForm`), unchanged.
   - **「台本ドラフトを取り込む」** — new flow (`ScreenplayImportForm`).
2. Import flow:
   1. Upload one `.docx` (≤25 MB).
   2. Server extracts text (mammoth) and runs a single Gemini **normalize** call → `{ markdown, brief }`.
   3. Review screen: an editable `ProductBriefEditor` (derived brief) + a collapsible **read-only preview** of the normalized script (existing `markdown-renderer`).
   4. 「この台本で開始」 → `POST /api/screenplays` with `{ productBrief, importedMarkdown }`.
   5. Redirect to `/screenplays/{id}?run={runId}&kind=import`. The workspace shows an **import-specific** progress card (取り込み中 / 試験中), then v1 + the baseline 試験結果.
3. From the workspace, refine (改稿) and re-check (再チェック) work exactly as today.

## 4. Architecture Overview

```
.docx upload
  → POST /api/screenplays/import        (multipart; member|admin; maxDuration 120)
      → magic-byte + extension guard (.docx only; .doc → 415)
      → mammoth: docx → text (or HTML; see §6)
      → normalizeDraft(): Gemini 1 call → { markdown, brief }   [lib/screenplay/import/]
      → returns { markdown, brief, source }  (for client review)

operator reviews/edits brief (+ previews markdown)

  → POST /api/screenplays  { productBrief, importedMarkdown }
      → validateImportedMarkdown()      (NEW server-side guard; §5/§8)
      → insert screenplays row (status 'generating', product_id null)
      → start screenplayWorkflow({ mode: 'import', productBrief, importedMarkdown })

screenplayWorkflow (mode 'import' branch; §9)
      → importStep:   markdown = input.importedMarkdown   (NO generateScreenplay call)
      → checkOnlyStep: single checkScreenplay (corpus-only, factSearch=false), AUTO_REMEDIATE skipped
      → persistStep:  insert v1, set current_version_id, status 'ready'
      → persistCheckStep(..., autoRemediateEnabled = false)   (§ fix 2)
      → emit done
```

Nothing in the refine / check / export / viewer paths changes.

## 5. Review fixes incorporated (the 6 required + recommendations)

This section is the authoritative list of how the reviewer's required changes are reflected below. Each is expanded in the referenced section.

1. **Explicit `import` workflow branch** — `GenerationMode` gains `"import"`; the workflow must **not** fall through to `generateStep`/`remediateLoopStep`. See §9.
2. **Per-run remediation metadata** — `persistCheckStep` takes an explicit `autoRemediateEnabled` arg instead of reading global `AUTO_REMEDIATE`; import passes `false` so the saved `result.remediation.enabled` is honest. See §9.
3. **Separate import format contract** — the normalizer must NOT reuse the generation `SYSTEM_INSTRUCTION` (prompt.ts:42 forces the full アバン/スタジオ①–④/CTA①/VTR/CTA②/価格 skeleton). A dedicated `IMPORT_SYSTEM_INSTRUCTION` shares only the **tag/書式 rules** and explicitly forbids inventing absent sections. See §6.
4. **mammoth fidelity gate** — our export renders speaker blocks as borderless 2-column tables (screenplay-docx.ts:29). A round-trip fixture test decides whether `extractRawText` suffices or we must use `convertToHtml`. See §6/§7.
5. **Server-side `importedMarkdown` validation** — `POST /api/screenplays` currently validates only `productBrief` (route.ts:27). Add `validateImportedMarkdown` (trimmed non-empty, ≤60k, minimal structure). See §8.
6. **Shared `ProductBriefEditor`** — extract brief hydrate/price-parse/field rendering out of `ScreenplayCreateForm` (:163) into a reusable component used by both forms. See §10.

Recommendations also adopted:
- **`GenerationProgress` import variant** — copy + indeterminate step display for import runs (no chunk-percent). See §10.
- **Magic-byte + extension `.docx` detection** — reuse `lib/upload/magic-bytes.ts::checkMagicBytes`; `.doc` → 415. See §8.
- **Dedicated `parseImportJson`** — separate schema validator for the nested `{ markdown, brief }` shape; delegates brief-field parsing to a shared core extracted from `parseBriefJson`. See §6/§8.

## 6. Normalization (`lib/screenplay/import/`)

New module directory, mirroring `lib/screenplay/extract/`. **No `import "server-only"`** (must be importable from a `tsx` smoke script — CLAUDE.md rule).

Files:
- `lib/screenplay/import/from-docx.ts` — `extractDocxText(buffer): Promise<string>`. Uses **mammoth** (`mammoth.extractRawText` by default; `convertToHtml` if the §7 fixture shows degraded speaker recovery). Returns plain text (or sanitized HTML). Throws a clear error if mammoth cannot parse (corrupt / not a real docx).
- `lib/screenplay/import/normalize-prompt.ts` — `IMPORT_SYSTEM_INSTRUCTION` + `parseImportJson(text): { markdown: string; brief: ProductBrief }`.
- `lib/screenplay/import/normalize.ts` — `normalizeDraft(rawText, fileName): Promise<{ markdown; brief }>`. One Gemini call (`@google/generative-ai`, `GEMINI_FLASH`, `responseMimeType: application/json`), same shape as `from-pdf.ts`.
- `lib/screenplay/import/index.ts` — re-exports.

### `IMPORT_SYSTEM_INSTRUCTION` (format contract — fix 3)

Shares with generation **only** the tag/書式 vocabulary so the parser/renderer/checker keep working:
- Speaker tags: **exactly** `[N]` `[高橋]` `[山内]` `[小島]` `[お客様]` — with the `[役名] （演出メモ）` + 本文 block format. These are the **only** tags the shared parser recognizes as speaker blocks (`lib/screenplay/parse-markdown.ts:23`); any other bracket tag falls through to a plain paragraph.
- Cue tags: `[テロップ]` `[カメラ]` `[BGM]` `[SE]` `[インサート]` `[小道具]`.
- Scene breaks: `---`. Headings: `#`/`##`/`###`.

Explicit divergences from generation:
- **MUST NOT invent sections.** Preserve only the acts/sections present in the source draft. Never add CTA / VTR / 価格＆オファー / メタ情報 / スタイルノート blocks that the writer did not include. This is the direct fix for the prompt.ts:42 "all sections forced" conflict.
- **MUST preserve wording.** Restructure/re-tag only. Do not summarize, expand, rewrite for quality, or fix compliance. Map **every** speaker onto one of the 5 parser-supported tags above. When a draft speaker doesn't map cleanly (a named expert, a named customer), assign the closest role and **preserve the original name in the （）delivery note** (e.g. `[お客様] （片岡さん）`). Never emit a custom `[名前]` or `[XX先生]` tag — the parser doesn't recognize it and it would render as a plain paragraph (review round 2, P1).
- **Do NOT translate or strip the source language.** The generation system bans English; import does not — faithfulness wins. (Any resulting quality issues surface in the check, not at import.)
- Output is strict JSON only: `{ "markdown": string, "brief": { ...ProductBrief } }`. No prose, no code fences.

`brief` sub-object follows the existing `ProductBrief` extraction rules (name required; description = a concise JP summary derived from the script; price/category/bonuses/guarantee/notes optional, no fabrication).

### `parseImportJson` (recommendation)

A **separate** validator (not `parseBriefJson` reuse) because the top-level shape is `{ markdown, brief }`:
- Validate `markdown`: string, trimmed non-empty. If it exceeds 60k, **throw** (do NOT slice) — faithful import must never silently drop content (review round 2, P1). The server re-validates in §8.
- Validate `brief`: delegate to a shared `parseBriefObject(obj)` core extracted from the current `parseBriefJson` (which today regex-matches a top-level JSON object from raw text). The refactor: `parseBriefJson(text)` keeps its signature and internally calls `parseBriefObject(matchedObj)`; `parseImportJson` calls `parseBriefObject(obj.brief)` directly. No behavior change for existing callers.

## 7. DOCX fidelity gate (fix 4)

Our DOCX export (`screenplay-docx.ts`) writes each speaker line as a **borderless 2-column table** (role | dialogue) and cues as `［tag］` (full-width brackets) paragraphs. A naive text extraction can merge table cells and drop the role↔dialogue boundary, which would corrupt `[N]`/`[高橋]` recovery.

Decision gate, implemented as a test (§8 `test:screenplay-import`):
1. Build a `.docx` from a known canonical Markdown via `buildScreenplayDocxBuffer`.
2. Run `extractDocxText` on it.
3. Assert the extracted text still carries enough structure for the normalizer (role labels and cue tags survive as distinguishable tokens).
4. **If `extractRawText` degrades recovery**, switch `from-docx.ts` to `mammoth.convertToHtml` and feed sanitized HTML to the normalizer — HTML preserves `<table>`/`<tr>`/`<td>` boundaries, and Gemini parses HTML reliably. The `IMPORT_SYSTEM_INSTRUCTION` is written to accept either plain text or HTML input.

The normalizer is the safety net for arbitrary freeform drafts regardless; this gate specifically protects the our-export round-trip case.

## 8. API surface

### NEW `POST /api/screenplays/import`
- `requireUser(["member","admin"])`. `maxDuration = 120`.
- multipart/form-data only; field `file`.
- Guards: size ≤ 25 MB; **extension `.docx`** AND `checkMagicBytes(buffer, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")` → must be `match` (ZIP/OOXML). OLE2 (`.doc`) detected → `415` with message 「.docx 形式で保存し直してください（旧 .doc は非対応）」. **`checkMagicBytes` treats any ZIP as a match for an OOXML-declared mime, so additionally open the buffer with `AdmZip` and require a `word/document.xml` entry — a renamed `.xlsx`/arbitrary `.zip` otherwise slips through to a mammoth 500. Missing entry / unreadable zip → `415` (review round 2, P2).**
- Flow: `extractDocxText` → `normalizeDraft` → `200 { markdown, brief, source: { kind: "docx", fileName, size } }`.
- Errors: 400 (no/empty file), 413 (too large), 415 (wrong type), 500 (mammoth/Gemini failure, message surfaced like the extract route).

### MODIFIED `POST /api/screenplays`
- Accept optional `importedMarkdown: string` alongside `productBrief`.
- When `importedMarkdown` present:
  - Run `validateImportedMarkdown(importedMarkdown)` (NEW; fix 5): trim; reject empty; reject > 60k chars; **minimal-structure** check — require at least one of: a Markdown heading (`^#{1,3}\s`), a recognized speaker/cue tag (`^\[...\]`), or ≥ N (e.g. 8) non-empty lines. Reject obvious garbage (e.g., a single blank-ish blob). On failure → `400` with a specific message.
  - `productBrief` still validated by the existing `resolveBrief` (name + description required, caps). The brief here is the operator-reviewed derived brief.
  - Insert `screenplays` row (`status: 'generating'`, `product_id: null`, `title: brief.name`, `product_info_snapshot: brief`).
  - `start(screenplayWorkflow, [{ screenplayId, mode: 'import', productBrief, importedMarkdown }])`.
  - Same `last_run_id` update + failure handling as the initial path.
- When `importedMarkdown` absent: existing behavior, untouched.

## 9. Workflow `import` branch (fixes 1 + 2)

`lib/screenplay/types.ts`: `GenerationMode = "initial" | "refine" | "import"`. `ScreenplayWorkflowInput` gains `importedMarkdown?: string`.

`lib/workflows/screenplay.workflow.ts` — add an explicit branch; do **not** reuse `generateStep`/`remediateLoopStep` for import:

```
if (input.mode === "import") {
  if (!input.importedMarkdown) throw new FatalError("import mode requires importedMarkdown");
  await emitProgressStep({ type: "step", name: "import", status: "started" });
  const markdown = input.importedMarkdown;
  await emitProgressStep({ type: "step", name: "import", status: "completed" });

  const { rules, references } = await loadComplianceStep();
  // check-only: corpus-only (factSearch=false), NO remediate loop (faithful import).
  await emitProgressStep({ type: "step", name: "check", status: "started" });
  const check = await safeCheck(markdown, input.productBrief, rules, references);
  await emitProgressStep({ type: "step", name: "check", status: "completed" });

  const persisted = await persistStep(
    input.screenplayId, markdown, /*feedback*/ "Word ドラフト取り込み",
    /*baseVersionId*/ undefined, /*model*/ "imported", /*thinkingLevel*/ "none",
  );
  await persistCheckStep(persisted.versionId, check, /*trail*/ [], rules.length, references.length,
    /*autoRemediateEnabled*/ false);
  await emitProgressStep({ type: "done", screenplayId: input.screenplayId, ...persisted });
  return { screenplayId: input.screenplayId, ...persisted };
}
// else: existing initial/refine path (unchanged)
```

`persistCheckStep` signature change (fix 2): add `autoRemediateEnabled: boolean`; build `result.remediation = { enabled: autoRemediateEnabled, iterations: trail, finalHigh: countHigh(check) }`. The existing generate/refine path passes the module-level `AUTO_REMEDIATE`; import passes `false`. This stops the UI from showing "auto-remediate enabled" on a run where it never executed.

Notes:
- `persistStep` already sets `status: 'ready'` and `current_version_id`; reused as-is. v1 carries `model: "imported"` (audit) and `feedback: "Word ドラフト取り込み"` so the 改稿履歴 timeline (which renders `feedback`) shows the import origin.
- Auto-check stays **corpus-only** (no web fact search) like the generate path — unreleased copy never leaves the boundary. The operator can run manual 再チェック (`POST /check`, `factSearch: true`) for full grounding.
- `safeCheck` is non-fatal; if the check fails, v1 still persists (consistent with generation).

## 10. UI

### `/screenplays/new`
- Add a top-level segmented switch above the existing content: 「商品資料から生成」 (renders `ScreenplayCreateForm`) vs 「台本ドラフトを取り込む」 (renders new `ScreenplayImportForm`). Keeps each component focused; avoids bloating the 767-line create form.

### NEW `components/screenplay/ScreenplayImportForm.tsx`
- Step 1 — upload: single `.docx` dropzone (accept `.docx` + the OOXML wordprocessing mime), 25 MB hint, "Word(.docx) のみ・旧 .doc 非対応" note. Calls `POST /api/screenplays/import`.
- Step 2 — review: `<ProductBriefEditor>` (shared) + a collapsible read-only normalized-script preview using the existing `markdown-renderer`. 「この台本で開始」 posts `{ productBrief, importedMarkdown }` to `POST /api/screenplays`, then routes to `/screenplays/{id}?run={runId}&kind=import`.

### NEW `components/screenplay/ProductBriefEditor.tsx` (fix 6)
- Extract from `ScreenplayCreateForm` (:163+): brief hydration, price string↔number parsing (`parsePrice`/`priceToString`), bonuses textarea handling, and the 基本情報/価格/特典・補足 field rendering. Props: `brief`, `onChange` (or controlled field setters), and the bonuses/price local-string adapters. `ScreenplayCreateForm` is refactored to consume it (its existing submit/extract logic stays put). This is a targeted refactor of code we're modifying, not drive-by.

### `GenerationProgress` import variant (recommendation)
- Add a `variant?: "generate" | "import"` prop (default `"generate"`). `ScreenplayWorkspace` reads `?kind=import` from the URL and passes `variant="import"`.
- `import` variant: no chunk-percent bar (import emits no `chunk` events). Instead render step status from the `step` events (`import` → 「取り込み中…」, `check` → 「試験中…」) and on `done` show 「取り込みが完了しました」. Generate variant unchanged.
- `ScreenplayWorkspace` passes the variant through; everything else (run reattach, refresh) is unchanged.

## 11. Dependencies

- Add **`mammoth`** (`dependencies`). Pure-JS, Node-runtime safe, de-facto standard for `.docx`→text/HTML; handles our export's tables far better than raw-XML stripping. Commit the lockfile (security checklist). `@types` ship with mammoth.
- No other new deps. `docx` (export), `adm-zip`, `lib/upload/magic-bytes.ts` already present.

## 12. Security & Auth

- Both endpoints `requireUser(["member","admin"])`; use the existing client patterns (`getServiceClient` for the workflow start path, matching the current screenplay routes).
- File guards: size cap, magic-byte verification, `.docx`-only. Reject `.doc` and any non-OOXML-ZIP payload.
- Uploaded bytes are processed in-memory and discarded; **not** persisted to storage (we keep only the normalized markdown + derived brief). This minimizes retention of operator drafts.
- Normalize call is corpus-free; the auto-check is corpus-only (no egress of draft text to web search) — consistent with the existing generate path's privacy stance. Manual 再チェック (factSearch) remains an explicit operator action.

## 13. Testing

New script `test:screenplay-import` (mirror `test:screenplay-extract`):
- **DB-free unit**: `parseImportJson` against canned Gemini JSON (valid; missing markdown; oversized markdown; missing brief.name) — assert shape + caps + error messages.
- **DB-free unit**: `validateImportedMarkdown` (empty, whitespace, > 60k, no-structure garbage, valid).
- **Round-trip fidelity gate (§7)**: `buildScreenplayDocxBuffer(knownMarkdown)` → `extractDocxText` → assert speaker/cue tokens survive. This drives the `extractRawText` vs `convertToHtml` decision.
- **Live smoke** (`--env-file=.env.local`, skip-guarded if no key): run `normalizeDraft` on a fixture draft (one freeform, one our-export round-trip) and assert it returns canonical-tagged markdown + a brief with a name, and that it did **not** invent a CTA/価格 section absent from the source.

Existing `test:screenplay-*` and `stress:screenplays` must still pass (no regression in initial/refine).

## 14. File-by-file change list

New:
- `lib/screenplay/import/from-docx.ts`
- `lib/screenplay/import/normalize-prompt.ts`
- `lib/screenplay/import/normalize.ts`
- `lib/screenplay/import/index.ts`
- `app/api/screenplays/import/route.ts`
- `components/screenplay/ScreenplayImportForm.tsx`
- `components/screenplay/ProductBriefEditor.tsx`
- `scripts/test-screenplay-import.ts`

Modified:
- `lib/screenplay/types.ts` — `GenerationMode += "import"`; `ScreenplayWorkflowInput.importedMarkdown?`.
- `lib/workflows/screenplay.workflow.ts` — `import` branch; `persistCheckStep(autoRemediateEnabled)`.
- `lib/screenplay/extract/brief-prompt.ts` — extract `parseBriefObject` core (no behavior change to `parseBriefJson`).
- `app/api/screenplays/route.ts` — accept + validate `importedMarkdown`; start workflow in `import` mode.
- `app/[locale]/(produce)/screenplays/new/page.tsx` — top-level mode switch.
- `components/screenplay/ScreenplayCreateForm.tsx` — consume `ProductBriefEditor`.
- `components/screenplay/ScreenplayWorkspace.tsx` — read `?kind=import`, pass `variant`.
- `components/screenplay/GenerationProgress.tsx` — `variant` prop + import copy/step display.
- `package.json` / lockfile — add `mammoth`.

## 15. Decisions log

- Import draft = script (not product material). [user]
- Format varies → AI normalization; no mechanical reverse-parser. [user]
- Faithful import + explicit refine (Approach 1); auto-remediate **off** for import. [user, reaffirmed in review]
- `.docx` only; `.doc` → 415. mammoth for extraction.
- No schema change; reuse existing tables; `model="imported"` marks v1.
- Drafts not persisted to storage (privacy/retention).
