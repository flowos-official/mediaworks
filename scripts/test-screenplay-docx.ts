/**
 * Tests for screenplay parser extraction + .docx export.
 * Run: npm run test:screenplay-docx
 */
import assert from "node:assert";
import AdmZip from "adm-zip";
import { parseMarkdown } from "../lib/screenplay/parse-markdown";
import { buildScreenplayDocxBuffer } from "../lib/screenplay/screenplay-docx";

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

// --- block.line source-line capture (powers the 変更点 hunk→script jump) ---
check("heading-1 records source line 0", blocks.some((b) => b.kind === "heading" && b.level === 1 && b.line === 0));
check("speaker records its source line", blocks.some((b) => b.kind === "speaker" && b.role === "N" && b.line === 6));
check("hr records its source line", blocks.some((b) => b.kind === "hr" && b.line === 19));
check("para records its source line", blocks.some((b) => b.kind === "para" && b.line === 21));

// --- docx builder produces valid OOXML ---
async function main() {
	const buf = await buildScreenplayDocxBuffer(FIXTURE, "テスト台本");
	check("docx buffer non-empty", buf.length > 0);
	check("docx starts with ZIP magic (PK)", buf[0] === 0x50 && buf[1] === 0x4b);
	const zip = new AdmZip(buf);
	const docXml = zip.getEntry("word/document.xml");
	check("docx contains word/document.xml", docXml !== null);
	const xml = docXml ? zip.readAsText(docXml) : "";
	check("document.xml carries the markdown H1 title", xml.includes("完成版台本タイトル"));
	check("document.xml carries a cue tag", xml.includes("テロップ"));
	check("document.xml carries speaker jp text", xml.includes("こんにちは"));
	check("document.xml carries a list item", xml.includes("ポイント1"));
	check("document.xml carries a table cell", xml.includes("9,800円"));

	// Empty markdown → falls back to the title param so the doc is non-empty.
	const emptyBuf = await buildScreenplayDocxBuffer("   ", "空タイトル");
	const emptyXml = new AdmZip(emptyBuf).readAsText("word/document.xml");
	check("empty markdown falls back to title param", emptyXml.includes("空タイトル"));

	console.log(`[test:screenplay-docx] ${passed} assertions passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
