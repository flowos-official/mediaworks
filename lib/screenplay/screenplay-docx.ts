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
	// Always include a document-title paragraph so the title text is searchable
	children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: title })] }));
	for (const b of blocks) children.push(...blockToElements(b));
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
