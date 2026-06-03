# Screenplay Word (.docx) Export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 「Word」download button to the screenplay viewer that produces a real OOXML `.docx` mirroring the script's structure (headings, scene breaks, cue boxes, speaker lines, lists, tables).

**Architecture:** Extract the existing hand-rolled screenplay parser into a pure, framework-free module so the renderer and a new docx builder share one `Block[]` model. Build the `.docx` client-side with the `docx` library (`Packer.toBlob`), triggered beside the existing `.md` download. A Node-side `Packer.toBuffer` path backs the test.

**Tech Stack:** TypeScript, React (client component), `docx` (^9), `adm-zip` (already a dep, for the test), `tsx` + `node:assert`.

**Spec:** `docs/superpowers/specs/2026-06-02-screenplay-docx-export-design.md` (lands on `main` via PR #89; this branch does not require the file — the plan is self-contained).

---

## Background (verified current state)

- `components/screenplay/ScreenplayViewer.tsx` ("use client") has `downloadMd()` (line ~44): `new Blob([markdown], {type:"text/markdown"})` → `<a download>`. A 「.md」button is at line ~104.
- `components/screenplay/markdown-renderer.tsx` (Server Component, imports React) holds:
  - `type Block` union: `heading{level:1|2|3,text}` | `hr` | `cue{tag,lines}` | `speaker{role,delivery?,jp,en?}` | `list{items}` | `table{rows}` | `para{text}`.
  - `const ROLE_LABELS`, `const CUE_TAGS = new Set([...])`, `const SPEAKER_TAGS = new Set([...])`.
  - `function parseMarkdown(md: string): Block[]`.
  - `export function ScreenplayMarkdown({markdown})` — the React renderer.
- No `docx`/`mammoth`/`officegen` dependency exists. `adm-zip` IS a dependency.

---

## File Structure

- `lib/screenplay/parse-markdown.ts` — **create**: `Block` type, `ROLE_LABELS`, `CUE_TAGS`, `SPEAKER_TAGS`, `parseMarkdown()`. Pure, no React, no `server-only`.
- `components/screenplay/markdown-renderer.tsx` — **modify**: import `Block`/`parseMarkdown` from the new module; delete the in-file copies; keep `ScreenplayMarkdown`.
- `lib/screenplay/screenplay-docx.ts` — **create**: `buildScreenplayDocx(markdown,title): Promise<Blob>` + `buildScreenplayDocxBuffer(markdown,title): Promise<Buffer>` (shared internal `buildScreenplayDoc`).
- `components/screenplay/ScreenplayViewer.tsx` — **modify**: add `downloadDocx()` + a 「Word」button.
- `scripts/test-screenplay-docx.ts` — **create**.
- `package.json` — **modify**: add `docx` dependency + `test:screenplay-docx` script.

---

## Task 1: Extract the parser into a pure module

**Files:**
- Create: `lib/screenplay/parse-markdown.ts`
- Create: `scripts/test-screenplay-docx.ts`
- Modify: `components/screenplay/markdown-renderer.tsx`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-screenplay-docx.ts`:

```ts
/**
 * Tests for screenplay parser extraction + .docx export.
 * Run: npm run test:screenplay-docx
 */
import assert from "node:assert";
import { parseMarkdown } from "../lib/screenplay/parse-markdown";

let passed = 0;
function check(label: string, cond: boolean) {
	assert.ok(cond, `FAILED: ${label}`);
	passed++;
}

const FIXTURE = [
	"# 完成版台本タイトル",
	"",
	"## オープニング",
	"",
	"[テロップ] 今だけ限定価格",
	"",
	"[N] (明るく)",
	"こんにちは、今日ご紹介するのはこちら。",
	"(Hello, here is today's product.)",
	"",
	"### デモ",
	"",
	"- ポイント1",
	"- ポイント2",
	"",
	"| 項目 | 値 |",
	"| --- | --- |",
	"| 価格 | 9,800円 |",
	"",
	"---",
	"",
	"ふつうの段落テキスト。",
].join("\n");

const blocks = parseMarkdown(FIXTURE);
const kinds = blocks.map((b) => b.kind);
check("parses a heading-1", blocks.some((b) => b.kind === "heading" && b.level === 1 && b.text.includes("タイトル")));
check("parses a cue", blocks.some((b) => b.kind === "cue" && b.tag === "テロップ"));
check("parses a speaker with jp+en", blocks.some((b) => b.kind === "speaker" && b.role === "N" && !!b.en));
check("parses a list", blocks.some((b) => b.kind === "list" && b.items.length === 2));
check("parses a table", blocks.some((b) => b.kind === "table"));
check("parses an hr", kinds.includes("hr"));
check("parses a para", blocks.some((b) => b.kind === "para"));

console.log(`[test:screenplay-docx] ${passed} assertions passed`);
```

- [ ] **Step 2: Add the npm script**

In `package.json`, after `"e2e:screenplay"`, add:

```json
    "test:screenplay-docx": "tsx scripts/test-screenplay-docx.ts",
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:screenplay-docx`
Expected: FAIL — `lib/screenplay/parse-markdown` not found.

- [ ] **Step 4: Create the pure parser module**

Create `lib/screenplay/parse-markdown.ts` by moving the type + constants + `parseMarkdown` out of `markdown-renderer.tsx` VERBATIM (no logic change). Read the current `parseMarkdown` from `components/screenplay/markdown-renderer.tsx` and copy it exactly. The module shape:

```ts
// lib/screenplay/parse-markdown.ts
// Pure screenplay-markdown parser shared by the React renderer and the .docx
// exporter. No React, no "server-only" — importable from tsx smoke scripts.

export type Block =
	| { kind: "heading"; level: 1 | 2 | 3; text: string }
	| { kind: "hr" }
	| { kind: "cue"; tag: string; lines: string[] }
	| { kind: "speaker"; role: string; delivery?: string; jp: string; en?: string }
	| { kind: "list"; items: string[] }
	| { kind: "table"; rows: string[][] }
	| { kind: "para"; text: string };

export const ROLE_LABELS: Record<string, string> = {
	N: "ナレーター",
	"高橋": "商品アドバイザー",
	"山内": "MC（驚き役）",
	"小島": "MC（共感役）",
	"お客様": "お客様",
};

export const CUE_TAGS = new Set(["テロップ", "カメラ", "BGM", "SE", "インサート", "小道具"]);
export const SPEAKER_TAGS = new Set(["N", "高橋", "山内", "小島", "お客様"]);

export function parseMarkdown(md: string): Block[] {
	// ↓↓↓ COPY THE BODY VERBATIM from markdown-renderer.tsx's parseMarkdown ↓↓↓
	// (the full while-loop that builds and returns Block[])
}
```

IMPORTANT: copy the `parseMarkdown` body exactly as it exists today — do not rewrite it.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:screenplay-docx`
Expected: PASS — `[test:screenplay-docx] 7 assertions passed`

- [ ] **Step 6: Rewire the renderer to import from the module**

In `components/screenplay/markdown-renderer.tsx`:
(a) Add at the top (after the React import):

```ts
import { type Block, ROLE_LABELS, CUE_TAGS, SPEAKER_TAGS, parseMarkdown } from "@/lib/screenplay/parse-markdown";
```

(b) DELETE the now-duplicated in-file declarations: the `type Block = ...` union, `const ROLE_LABELS`, `const CUE_TAGS`, `const SPEAKER_TAGS`, and the entire `function parseMarkdown(...)`. KEEP `CUE_STYLES`, `ROLE_STYLES`, and the `ScreenplayMarkdown` component unchanged (they reference the now-imported names).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors. (Redeclaration errors mean an in-file copy was not deleted.)

- [ ] **Step 8: Commit**

```bash
git add lib/screenplay/parse-markdown.ts components/screenplay/markdown-renderer.tsx scripts/test-screenplay-docx.ts package.json
git commit -m "refactor(screenplay): extract parseMarkdown to shared pure module"
```

---

## Task 2: docx builder

**Files:**
- Modify: `package.json` (add `docx` dependency)
- Create: `lib/screenplay/screenplay-docx.ts`
- Modify: `scripts/test-screenplay-docx.ts`

- [ ] **Step 1: Add the docx dependency**

Run: `npm install docx@^9`
Expected: `docx` appears under `dependencies` in `package.json`; lockfile updated.

- [ ] **Step 2: Add a failing test for the builder**

Append to `scripts/test-screenplay-docx.ts` (before the final `console.log`):

```ts
// --- docx builder produces valid OOXML ---
import AdmZip from "adm-zip";
import { buildScreenplayDocxBuffer } from "../lib/screenplay/screenplay-docx";

const buf = await buildScreenplayDocxBuffer(FIXTURE, "テスト台本");
check("docx buffer non-empty", buf.length > 0);
check("docx starts with ZIP magic (PK)", buf[0] === 0x50 && buf[1] === 0x4b);
const zip = new AdmZip(buf);
const docXml = zip.getEntry("word/document.xml");
check("docx contains word/document.xml", docXml !== null);
const xml = docXml ? zip.readAsText(docXml) : "";
check("document.xml carries the title text", xml.includes("テスト台本"));
check("document.xml carries a cue tag", xml.includes("テロップ"));
```

NOTE: the test file uses top-level `await`, so it must run as an ES module. `tsx` supports top-level await. If `tsx` complains, wrap the docx assertions in an `async function main(){...}; await main();` — but try top-level await first.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:screenplay-docx`
Expected: FAIL — `lib/screenplay/screenplay-docx` / `buildScreenplayDocxBuffer` not found.

- [ ] **Step 4: Implement the docx builder**

Create `lib/screenplay/screenplay-docx.ts`. Map each `Block` to docx elements. The two public entry points share one `buildScreenplayDoc`:

```ts
import {
	Document,
	Packer,
	Paragraph,
	TextRun,
	HeadingLevel,
	AlignmentType,
	Table,
	TableRow,
	TableCell,
	WidthType,
	BorderStyle,
} from "docx";
import { type Block, ROLE_LABELS, parseMarkdown } from "./parse-markdown";

const JP_FONT = "Yu Gothic";

function noBorders() {
	const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" } as const;
	return { top: none, bottom: none, left: none, right: none };
}

function headingLevel(level: 1 | 2 | 3) {
	if (level === 1) return HeadingLevel.HEADING_1;
	if (level === 2) return HeadingLevel.HEADING_2;
	return HeadingLevel.HEADING_3;
}

function speakerTable(b: Extract<Block, { kind: "speaker" }>): Table {
	const right: Paragraph[] = [];
	if (b.delivery) {
		right.push(new Paragraph({ children: [new TextRun({ text: `（${b.delivery}）`, italics: true, color: "777777" })] }));
	}
	right.push(new Paragraph({ children: [new TextRun({ text: b.jp })] }));
	if (b.en) {
		right.push(new Paragraph({ children: [new TextRun({ text: b.en, italics: true, color: "777777", size: 18 })] }));
	}
	const label = ROLE_LABELS[b.role] ?? "";
	return new Table({
		width: { size: 100, type: WidthType.PERCENTAGE },
		borders: noBorders(),
		rows: [
			new TableRow({
				children: [
					new TableCell({
						width: { size: 20, type: WidthType.PERCENTAGE },
						borders: noBorders(),
						children: [
							new Paragraph({ children: [new TextRun({ text: b.role, bold: true })] }),
							...(label ? [new Paragraph({ children: [new TextRun({ text: label, size: 16, color: "777777" })] })] : []),
						],
					}),
					new TableCell({
						width: { size: 80, type: WidthType.PERCENTAGE },
						borders: noBorders(),
						children: right,
					}),
				],
			}),
		],
	});
}

function dataTable(b: Extract<Block, { kind: "table" }>): Table {
	const [head, ...body] = b.rows;
	const rows: TableRow[] = [];
	if (head) {
		rows.push(new TableRow({
			tableHeader: true,
			children: head.map((c) => new TableCell({
				shading: { fill: "F0F0F0" },
				children: [new Paragraph({ children: [new TextRun({ text: c, bold: true })] })],
			})),
		}));
	}
	for (const row of body) {
		rows.push(new TableRow({
			children: row.map((c) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: c })] })] })),
		}));
	}
	return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}

function blockToElements(b: Block): Array<Paragraph | Table> {
	switch (b.kind) {
		case "heading": {
			const out: Array<Paragraph | Table> = [];
			if (b.level === 1) {
				out.push(new Paragraph({ children: [new TextRun({ text: "完成版 台本", color: "2563EB", size: 18 })] }));
			}
			out.push(new Paragraph({ heading: headingLevel(b.level), children: [new TextRun({ text: b.text })] }));
			return out;
		}
		case "hr":
			return [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "— 場面転換 —", color: "999999" })] })];
		case "cue": {
			const children = [new TextRun({ text: `［${b.tag}］ `, bold: true, color: "2563EB" })];
			if (b.lines.length) children.push(new TextRun({ text: b.lines.join(" / ") }));
			return [new Paragraph({ children })];
		}
		case "speaker":
			return [speakerTable(b)];
		case "list":
			return b.items.map((it) => new Paragraph({ text: it, bullet: { level: 0 } }));
		case "table":
			return [dataTable(b)];
		case "para":
			return [new Paragraph({ children: [new TextRun({ text: b.text })] })];
	}
}

function buildScreenplayDoc(markdown: string, title: string): Document {
	const blocks = parseMarkdown(markdown);
	const children: Array<Paragraph | Table> = [];
	for (const b of blocks) children.push(...blockToElements(b));
	if (children.length === 0) {
		children.push(new Paragraph({ children: [new TextRun({ text: title })] }));
	}
	return new Document({
		styles: { default: { document: { run: { font: JP_FONT } } } },
		sections: [{ children }],
	});
}

/** Browser-side: returns a Blob suitable for download. */
export async function buildScreenplayDocx(markdown: string, title: string): Promise<Blob> {
	return Packer.toBlob(buildScreenplayDoc(markdown, title));
}

/** Node-side (tests): returns a Buffer. */
export async function buildScreenplayDocxBuffer(markdown: string, title: string): Promise<Buffer> {
	return Packer.toBuffer(buildScreenplayDoc(markdown, title));
}
```

NOTE TO IMPLEMENTER: the docx v9 API names above are the contract target, but if a specific constructor option name differs in the installed version, adjust it to make the Step-5 test pass (valid zip + `word/document.xml` + title/cue text present). The test is the source of truth — do NOT weaken the test to fit broken code.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:screenplay-docx`
Expected: PASS — `[test:screenplay-docx] 13 assertions passed`

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json lib/screenplay/screenplay-docx.ts scripts/test-screenplay-docx.ts
git commit -m "feat(screenplay): build .docx from screenplay markdown via docx lib"
```

---

## Task 3: Word download button in the viewer

**Files:**
- Modify: `components/screenplay/ScreenplayViewer.tsx`

- [ ] **Step 1: Import the builder**

In `components/screenplay/ScreenplayViewer.tsx`, add at the top (with the other imports):

```ts
import { buildScreenplayDocx } from "@/lib/screenplay/screenplay-docx";
```

Also extend the `lucide-react` import to include `FileText` (the Word-button icon) — change the existing `import { Copy, Download, Check, ChevronLeft, ChevronRight } from "lucide-react";` to add `FileText`.

- [ ] **Step 2: Add the download handler + busy state**

Inside the component, after the existing `const [copied, setCopied] = useState(false);` add:

```ts
	const [docxBusy, setDocxBusy] = useState(false);
```

After the `downloadMd()` function, add:

```ts
	async function downloadDocx() {
		setDocxBusy(true);
		try {
			const blob = await buildScreenplayDocx(markdown, title);
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60)}${versionLabel ? `-${versionLabel}` : ""}.docx`;
			a.click();
			URL.revokeObjectURL(url);
		} finally {
			setDocxBusy(false);
		}
	}
```

- [ ] **Step 3: Add the Word button**

In the toolbar's right-hand button group (next to the existing `.md` button at ~line 104-111), add a 「Word」button immediately after the `.md` button's closing `</button>`:

```tsx
					<button
						type="button"
						onClick={downloadDocx}
						disabled={docxBusy}
						className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					>
						<FileText size={12} />
						{docxBusy ? "生成中…" : "Word"}
					</button>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add components/screenplay/ScreenplayViewer.tsx
git commit -m "feat(screenplay): add Word(.docx) download button to viewer"
```

---

## Task 4: Full verification

- [ ] **Step 1: Run the test**

Run: `npm run test:screenplay-docx`
Expected: PASS — 13 assertions passed.

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit` then `npm run lint`
Expected: no new errors in touched files.

- [ ] **Step 3: Build sanity (optional but recommended — docx is a new client dep)**

Run: `npm run build`
Expected: build succeeds; `docx` bundles into the client chunk for the screenplay route without error. If the build is too slow/heavy for the environment, skip and note it.

---

## Self-Review

**Spec coverage:**
- §4.1 extract parser to shared pure module → Task 1. ✅
- §4.2 docx builder mapping every block kind (heading/hr/cue/speaker-2col-table/list/table/para) + JP font → Task 2. ✅
- §4.3 UI wiring (Word button beside .md, busy state, filename sanitization reused) → Task 3. ✅
- §4.4 add `docx` dependency → Task 2 Step 1. ✅
- §5 test (every block kind in fixture; valid OOXML via adm-zip; contains `word/document.xml`; before/after parser behavior) → Task 1 + Task 2. ✅ (The "before/after identical block output" guard is realized as a behavior test on the extracted parser — the body is copied verbatim in Task 1 Step 4, and the fixture exercises all block kinds.)

**Placeholder scan:** The only non-literal is Task 1 Step 4's "copy parseMarkdown body verbatim" — this is intentional (the source is the current `markdown-renderer.tsx`, which the implementer reads). All other steps show complete code. ✅

**Type consistency:** `Block` union + `ROLE_LABELS`/`CUE_TAGS`/`SPEAKER_TAGS` + `parseMarkdown` exported from `parse-markdown.ts` and imported by both the renderer (Task 1) and the docx builder (Task 2). `buildScreenplayDocx(markdown,title): Promise<Blob>` (browser, Task 3) and `buildScreenplayDocxBuffer(markdown,title): Promise<Buffer>` (node, Task 2 test) share `buildScreenplayDoc`. Consistent. ✅

**Decomposition:** `parse-markdown.ts` (pure parser) and `screenplay-docx.ts` (pure builder) are small, single-responsibility, framework-free, and independently testable. The renderer shrinks. ✅

**Risk note:** `docx` is a new client-side dependency added to the screenplay route bundle. Task 4 Step 3 (build) catches any bundling/SSR issue. The builder is only invoked from a client `onClick`, so it never runs during SSR.
