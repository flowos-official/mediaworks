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
	const blocks: Block[] = [];
	const lines = md.split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trimEnd();
		if (!trimmed.trim()) { i++; continue; }

		const h = trimmed.match(/^(#{1,3})\s+(.+)$/);
		if (h) {
			blocks.push({ kind: "heading", level: h[1].length as 1 | 2 | 3, text: h[2] });
			i++;
			continue;
		}

		if (/^---+$/.test(trimmed.trim())) {
			blocks.push({ kind: "hr" });
			i++;
			continue;
		}

		const tag = trimmed.trim().match(/^\[([^\]]+)\](.*)$/);
		if (tag) {
			const inside = tag[1].trim();
			const rest = tag[2].trim();

			if (CUE_TAGS.has(inside)) {
				const body: string[] = [];
				if (rest) body.push(rest);
				i++;
				while (i < lines.length) {
					const nextTrim = lines[i].trim();
					if (!nextTrim) { i++; break; }
					if (/^#{1,3}\s/.test(nextTrim)) break;
					if (/^---+$/.test(nextTrim)) break;
					const nextTag = nextTrim.match(/^\[([^\]]+)\]/);
					if (nextTag && (CUE_TAGS.has(nextTag[1].trim()) || SPEAKER_TAGS.has(nextTag[1].trim()))) break;
					body.push(lines[i].replace(/^\s+/, ""));
					i++;
				}
				blocks.push({ kind: "cue", tag: inside, lines: body });
				continue;
			}

			if (SPEAKER_TAGS.has(inside)) {
				const deliveryMatch = rest.match(/^\((.*)\)\s*$/);
				const delivery = deliveryMatch ? deliveryMatch[1] : undefined;
				i++;
				while (i < lines.length && !lines[i].trim()) i++;
				const jp = (lines[i] ?? "").trim();
				i++;
				let en: string | undefined;
				if (i < lines.length) {
					const candidate = lines[i].trim();
					if (candidate.startsWith("(") && candidate.endsWith(")")) {
						en = candidate.slice(1, -1);
						i++;
					}
				}
				blocks.push({ kind: "speaker", role: inside, delivery, jp, en });
				continue;
			}
		}

		if (trimmed.trim().startsWith("|") && (lines[i + 1] ?? "").trim().startsWith("|") &&
			/^\|[\s:|-]+\|$/.test((lines[i + 1] ?? "").trim())) {
			const rows: string[][] = [];
			while (i < lines.length && lines[i].trim().startsWith("|")) {
				const raw = lines[i].trim();
				const inner = raw.slice(1, raw.endsWith("|") ? -1 : undefined);
				const cells = inner.split("|").map((c) => c.trim());
				if (!cells.every((c) => /^[:\-]*$/.test(c))) rows.push(cells);
				i++;
			}
			blocks.push({ kind: "table", rows });
			continue;
		}

		if (/^[\-*●○※]\s+/.test(trimmed.trim()) || /^\d+\.\s/.test(trimmed.trim())) {
			const items: string[] = [];
			while (i < lines.length && (/^[\-*●○※]\s+/.test(lines[i].trim()) || /^\d+\.\s/.test(lines[i].trim()))) {
				items.push(lines[i].trim().replace(/^[\-*●○※]\s+|^\d+\.\s+/, ""));
				i++;
			}
			blocks.push({ kind: "list", items });
			continue;
		}

		blocks.push({ kind: "para", text: trimmed });
		i++;
	}
	return blocks;
}
