# Screenplay Word (.docx) Export — Design

**Status**: Approved brainstorm, ready for implementation plan
**Date**: 2026-06-02
**Scope**: Add a true Word (`.docx`) download to the screenplay viewer, alongside the existing `.md` download. Operator feedback: the generated script downloads as `.md`; they want it downloadable in Word / other programs.

---

## 1. Goal

`components/screenplay/ScreenplayViewer.tsx:44` currently offers only a `.md` blob download (and clipboard copy). Add a 「Word」button that produces a real OOXML `.docx` that opens cleanly in Word, Google Docs, and Pages — preserving the screenplay's structure (headings, scene breaks, cue boxes, speaker lines, lists, tables).

Decisions from brainstorm:
- **Target: the screenplay system only** (the 25-min `ScreenplayViewer` that has the `.md` button). NOT the research-report 3-variant `broadcast_scripts` (separate feature; copy/PDF only — out of scope).
- **Format: true `.docx`** via the `docx` library (not `.doc`-HTML or `.rtf`).
- **Client-side** generation — no API route, mirroring the existing `downloadMd()`.

## 2. Non-Goals

- No `.docx` for the research-report broadcast scripts.
- No server-side rendering / no new API route.
- No PDF changes (`PdfDownload.tsx` stays as-is).
- No round-trip import (`.docx` → screenplay). Export only.

## 3. Current State (verified)

- `screenplay_versions.markdown` holds a single markdown string.
- `components/screenplay/markdown-renderer.tsx` contains a **hand-rolled screenplay parser** `parseMarkdown(md): Block[]` producing a typed block model:
  `heading(level 1|2|3)` · `hr` (場面転換 scene break) · `cue(tag, lines)` (tags: テロップ/カメラ/BGM/SE/インサート/小道具) · `speaker(role, delivery?, jp, en?)` (roles: N/高橋/山内/小島/お客様) · `list(items)` · `table(rows)` · `para(text)`.
  Constants `ROLE_LABELS`, `CUE_TAGS`, `SPEAKER_TAGS` live in the same file.
- `markdown-renderer.tsx` is a Server Component (imports React). `ScreenplayViewer.tsx` is `"use client"`.
- No `docx`/`mammoth`/`officegen` dependency exists.

## 4. Design

### 4.1 Extract the parser into a shared, framework-agnostic module

New `lib/screenplay/parse-markdown.ts` (pure TS, no React import):
- Move `Block` union type, `parseMarkdown()`, and the `ROLE_LABELS` / `CUE_TAGS` / `SPEAKER_TAGS` constants here.
- `markdown-renderer.tsx` imports `Block` + `parseMarkdown` from the new module (keeps its own JSX/style maps). **No behavior change to rendering** — pure refactor so renderer and docx exporter share one parser and can never drift.
- No `import "server-only"` (per CLAUDE.md tsx-smoke rule), so a smoke test can import it directly.

### 4.2 docx builder

New `lib/screenplay/screenplay-docx.ts`:

```ts
export async function buildScreenplayDocx(markdown: string, title: string): Promise<Blob>
```

Parse with `parseMarkdown`, map each block to `docx` elements, package with `Packer.toBlob`:

| Block | docx mapping |
|---|---|
| heading L1 | `HeadingLevel.HEADING_1` + a small "完成版 台本" caption paragraph above |
| heading L2 | `HeadingLevel.HEADING_2` |
| heading L3 | `HeadingLevel.HEADING_3` |
| hr | centered paragraph `— 場面転換 —` (or a bottom-bordered empty paragraph) |
| cue | bordered/shaded single-cell table (or a paragraph with a light shading) — bold `［tag］` run, then each line as a run/paragraph |
| speaker | **borderless 2-column table row**: left cell = bold role label (+ `ROLE_LABELS[role]` small gray), right cell = delivery (italic, parenthesized) + JP dialogue + EN (italic, smaller) |
| list | numbered list paragraphs (`numbering`) — matches the on-screen 01/02 numbering |
| table | `docx` `Table` with a shaded header row |
| para | normal paragraph |

Use a Japanese-safe default font (e.g. `Yu Gothic` / `MS PGothic` set on `Document` styles) so Word renders JP text correctly.

### 4.3 UI wiring

`ScreenplayViewer.tsx` — add a 「Word」button beside the `.md` button (line ~104), reusing the existing download idiom:

```ts
async function downloadDocx() {
  const blob = await buildScreenplayDocx(markdown, title);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeName(title)}${versionLabel ? `-${versionLabel}` : ""}.docx`;
  a.click();
  URL.revokeObjectURL(url);
}
```

Reuse the existing filename sanitization (`replace(/[^\p{L}\p{N}]+/gu, "-").slice(0,60)`). Show a brief spinner/disabled state while building (docx packing is async).

### 4.4 Dependency

Add `docx` (^9.x) to `package.json` dependencies. It runs in the browser and produces a Blob via `Packer.toBlob`.

## 5. Tests

`scripts/test-screenplay-docx.ts` (`npm run test:screenplay-docx`), Node-side:
- Feed a fixture markdown exercising every block kind (heading L1-3, hr, each cue tag, speaker with/without delivery and EN, list, table, para).
- Call a Node-friendly builder path (`Packer.toBuffer`) and assert: non-empty buffer, starts with the ZIP magic bytes `PK`, and unzips to contain `word/document.xml` (use existing `adm-zip` dependency to verify).
- Unit-assert the parser extraction produced identical `Block[]` output for a sample before/after the move (guard the refactor).

## 6. Edge Cases & Failure Modes

| Scenario | Behavior |
|---|---|
| Empty / whitespace markdown | Produces a minimal valid docx with just the title; no throw. |
| Unknown cue tag / speaker role | Parser already routes unknowns to `para`; docx renders as a normal paragraph. |
| Very long script | Client-side packing handles it; show disabled state during build to avoid double-click. |
| Malformed table row | Parser tolerates ragged rows (existing behavior); docx Table uses the row cells as-is. |
| JP font missing on the opening machine | Word substitutes a CJK font; text remains correct (font is a hint, not embedded). |

## 7. Success Criteria

- `npm run test:screenplay-docx` passes (valid OOXML, contains `word/document.xml`).
- Clicking 「Word」downloads a `.docx` that opens in Word/Google Docs/Pages with headings, speaker columns, cue boxes, lists, and tables intact, JP text correct.
- The `.md` button and rendered view are unchanged (pure parser extraction verified by the before/after block test).

## 8. Out-of-Scope Future Work

- `.docx` export for the research-report 3-variant scripts.
- PDF export parity for the screenplay (currently only the research report has PDF).
- Style-bible-driven docx theming (cover page, header/footer with product name).
