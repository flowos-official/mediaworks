#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const localeArg = process.argv.find((a) => a.startsWith("--locale="));
const locale = localeArg ? localeArg.split("=")[1] : "jp";

const LOCALE_CONFIG = {
	jp: {
		lang: "ja",
		title: "MediaWorks 商品発掘システム 利用ガイド",
		fontFamily: '"Yu Gothic", "Hiragino Kaku Gothic ProN", "Meiryo", "Noto Sans JP", "Segoe UI", sans-serif',
		codeFontFamily: '"Consolas", "Meiryo", monospace',
	},
	ko: {
		lang: "ko",
		title: "MediaWorks 상품 발굴 시스템 이용 가이드",
		fontFamily: '"Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI", sans-serif',
		codeFontFamily: '"Consolas", "Malgun Gothic", monospace',
	},
};

const cfg = LOCALE_CONFIG[locale];
if (!cfg) {
	console.error(`Unknown locale: ${locale}. Supported: ${Object.keys(LOCALE_CONFIG).join(", ")}`);
	process.exit(1);
}

const mdPath = resolve(root, `docs/user-guide-${locale}.md`);
const outPdf = resolve(root, `docs/user-guide-${locale}.pdf`);

const md = readFileSync(mdPath, "utf8");

// Convert markdown -> HTML via marked CLI (pass file via arg to avoid stdin issues on Windows)
const mdTmpDir = mkdtempSync(join(tmpdir(), "guide-md-"));
const mdTmpFile = join(mdTmpDir, "in.md");
writeFileSync(mdTmpFile, md, "utf8");
const markedOut = spawnSync(
	process.platform === "win32" ? "npx.cmd" : "npx",
	["-y", "marked@14", "--gfm", "-i", mdTmpFile],
	{ encoding: "utf8", maxBuffer: 10 * 1024 * 1024, shell: process.platform === "win32" },
);
rmSync(mdTmpDir, { recursive: true, force: true });
if (markedOut.status !== 0) {
	console.error("marked failed:", markedOut.error ?? markedOut.stderr ?? "(no output)");
	process.exit(1);
}
const bodyHtml = markedOut.stdout;

const css = `
@page { size: A4; margin: 18mm 16mm; }
html, body {
	font-family: ${cfg.fontFamily};
	font-size: 10.5pt;
	line-height: 1.65;
	color: #1f2937;
	-webkit-print-color-adjust: exact;
	print-color-adjust: exact;
}
h1 { font-size: 22pt; border-bottom: 3px solid #2563eb; padding-bottom: 6pt; margin: 0 0 14pt; color: #111827; }
h2 { font-size: 15pt; margin-top: 22pt; border-bottom: 1px solid #e5e7eb; padding-bottom: 4pt; color: #1f2937; }
h3 { font-size: 12pt; margin-top: 14pt; color: #111827; }
h2, h3 { break-after: avoid; }
p, li { margin: 4pt 0; }
ul, ol { padding-left: 22pt; }
hr { border: 0; border-top: 1px dashed #d1d5db; margin: 18pt 0; }
code { font-family: ${cfg.codeFontFamily}; background: #f3f4f6; padding: 1pt 4pt; border-radius: 3pt; font-size: 0.92em; }
pre { background: #0f172a; color: #e2e8f0; padding: 10pt 12pt; border-radius: 6pt; overflow: auto; font-size: 9pt; line-height: 1.45; }
pre code { background: transparent; color: inherit; padding: 0; font-size: inherit; }
table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 9.5pt; break-inside: avoid; }
th, td { border: 1px solid #d1d5db; padding: 5pt 8pt; text-align: left; vertical-align: top; }
th { background: #f3f4f6; font-weight: 600; }
strong { color: #111827; }
blockquote { border-left: 3px solid #9ca3af; margin: 8pt 0; padding: 2pt 10pt; color: #4b5563; background: #f9fafb; }
img { max-width: 100%; height: auto; display: block; margin: 10pt auto; border: 1px solid #e5e7eb; border-radius: 4pt; box-shadow: 0 1px 3px rgba(0,0,0,0.08); break-inside: avoid; }
h2 + p > img:first-child, h3 + p > img:first-child { margin-top: 4pt; }
`;

const html = `<!doctype html>
<html lang="${cfg.lang}">
<head>
<meta charset="utf-8" />
<title>${cfg.title}</title>
<style>${css}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;

// Write HTML next to the markdown so relative img paths (guide-images/...) resolve.
const htmlOnly = process.argv.includes("--html-only");
const htmlPath = resolve(root, htmlOnly ? `docs/user-guide-${locale}.html` : `docs/.user-guide-${locale}.build.html`);
writeFileSync(htmlPath, html, "utf8");
console.log(`HTML written: ${htmlPath}`);

if (htmlOnly) {
	process.exit(0);
}

const fileUrl = "file:///" + htmlPath.replace(/\\/g, "/");

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
try {
	execFileSync(
		chromePath,
		[
			"--headless=new",
			"--disable-gpu",
			"--no-pdf-header-footer",
			`--print-to-pdf=${outPdf}`,
			fileUrl,
		],
		{ stdio: "inherit" },
	);
	console.log(`PDF written: ${outPdf}`);
} finally {
	rmSync(htmlPath, { force: true });
}
