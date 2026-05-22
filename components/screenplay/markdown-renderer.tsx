// components/screenplay/markdown-renderer.tsx
// Server Component. Hand-rolled parser because the screenplay format is regular
// enough that this is more accurate than a generic markdown library.
import React from "react";

type Block =
	| { kind: "heading"; level: 1 | 2 | 3; text: string }
	| { kind: "hr" }
	| { kind: "cue"; tag: string; lines: string[] }
	| { kind: "speaker"; role: string; delivery?: string; jp: string; en?: string }
	| { kind: "list"; items: string[] }
	| { kind: "table"; rows: string[][] }
	| { kind: "para"; text: string };

const ROLE_LABELS: Record<string, string> = {
	N: "ナレーター",
	"高橋": "商品アドバイザー",
	"山内": "MC（驚き役）",
	"小島": "MC（共感役）",
	"お客様": "お客様",
};

const CUE_TAGS = new Set(["テロップ", "カメラ", "BGM", "SE", "インサート", "小道具"]);
const SPEAKER_TAGS = new Set(["N", "高橋", "山内", "小島", "お客様"]);

const CUE_STYLES: Record<string, { bg: string; ring: string; text: string }> = {
	"テロップ": { bg: "bg-blue-600/10", ring: "border-blue-200 dark:border-blue-900/40", text: "text-blue-900 dark:text-blue-100" },
	"カメラ": { bg: "bg-muted", ring: "border-border", text: "text-foreground" },
	"BGM": { bg: "bg-purple-600/10", ring: "border-purple-200 dark:border-purple-900/40", text: "text-purple-900 dark:text-purple-100" },
	"SE": { bg: "bg-orange-600/10", ring: "border-orange-200 dark:border-orange-900/40", text: "text-orange-900 dark:text-orange-100" },
	"インサート": { bg: "bg-cyan-600/10", ring: "border-cyan-200 dark:border-cyan-900/40", text: "text-cyan-900 dark:text-cyan-100" },
	"小道具": { bg: "bg-amber-600/10", ring: "border-amber-200 dark:border-amber-900/40", text: "text-amber-900 dark:text-amber-100" },
};

const ROLE_STYLES: Record<string, string> = {
	N: "bg-muted text-foreground",
	"高橋": "bg-blue-600/15 text-blue-900 dark:text-blue-100",
	"山内": "bg-green-600/15 text-green-900 dark:text-green-100",
	"小島": "bg-pink-600/15 text-pink-900 dark:text-pink-100",
	"お客様": "bg-amber-600/15 text-amber-900 dark:text-amber-100",
};

function parseMarkdown(md: string): Block[] {
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

export function ScreenplayMarkdown({ markdown }: { markdown: string }) {
	const blocks = parseMarkdown(markdown);

	return (
		<article className="text-foreground leading-[1.85]">
			{blocks.map((b, idx) => {
				if (b.kind === "heading") {
					if (b.level === 1) {
						return (
							<header key={idx} className="mb-10 pb-6 border-b border-border">
								<div className="text-xs font-medium text-blue-700 dark:text-blue-300 bg-blue-600/10 inline-block px-2 py-0.5 rounded-full mb-3">
									完成版 台本
								</div>
								<h1 className="text-3xl font-bold tracking-tight text-foreground leading-tight">
									{b.text}
								</h1>
							</header>
						);
					}
					if (b.level === 2) {
						return (
							<h2 key={idx} className="mt-12 mb-4 text-xs font-semibold tracking-wide text-muted-foreground uppercase border-b border-border pb-2">
								<span className="text-foreground normal-case text-lg font-bold">{b.text}</span>
							</h2>
						);
					}
					return (
						<h3 key={idx} className="mt-10 mb-4 text-lg font-bold text-foreground flex items-center gap-2">
							<span className="w-1 h-5 bg-blue-600 rounded-full" aria-hidden />
							{b.text}
						</h3>
					);
				}

				if (b.kind === "hr") {
					return (
						<div key={idx} className="my-10 flex items-center gap-3">
							<div className="h-px flex-1 bg-border" />
							<span className="text-[10px] tracking-widest uppercase text-muted-foreground">場面転換</span>
							<div className="h-px flex-1 bg-border" />
						</div>
					);
				}

				if (b.kind === "cue") {
					const style = CUE_STYLES[b.tag] ?? { bg: "bg-muted", ring: "border-border", text: "text-foreground" };
					return (
						<div key={idx} className={`my-4 rounded-xl border ${style.ring} ${style.bg} px-4 py-3`}>
							<div className={`text-[11px] font-bold tracking-wide ${style.text} mb-1.5`}>
								［{b.tag}］
							</div>
							{b.lines.map((l, li) => (
								<div key={li} className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{l}</div>
							))}
						</div>
					);
				}

				if (b.kind === "speaker") {
					const roleCls = ROLE_STYLES[b.role] ?? "bg-muted text-foreground";
					return (
						<div key={idx} className="my-5 grid grid-cols-[120px_1fr] gap-4 py-2 border-b border-dashed border-border">
							<div>
								<span className={`inline-flex items-center text-xs font-bold px-2 py-1 rounded-md ${roleCls}`}>
									{b.role}
								</span>
								<div className="text-[10px] text-muted-foreground mt-1">{ROLE_LABELS[b.role] ?? ""}</div>
							</div>
							<div>
								{b.delivery && (
									<div className="text-xs italic text-muted-foreground mb-1.5">（{b.delivery}）</div>
								)}
								<p className="text-[15px] leading-[1.9] whitespace-pre-wrap text-foreground">{b.jp}</p>
								{b.en && (
									<p className="text-[11px] text-muted-foreground mt-1.5 pl-3 border-l-2 border-border italic">
										{b.en}
									</p>
								)}
							</div>
						</div>
					);
				}

				if (b.kind === "list") {
					return (
						<ul key={idx} className="my-3 pl-0 list-none space-y-1">
							{b.items.map((it, ii) => (
								<li key={ii} className="text-[13.5px] leading-[1.7] grid grid-cols-[20px_1fr] gap-1 text-foreground">
									<span className="text-blue-500 tabular-nums">{(ii + 1).toString().padStart(2, "0")}</span>
									<span>{it}</span>
								</li>
							))}
						</ul>
					);
				}

				if (b.kind === "table") {
					const [head, ...body] = b.rows;
					return (
						<div key={idx} className="my-6 border border-border rounded-xl overflow-hidden">
							<table className="w-full border-collapse text-sm">
								{head && (
									<thead className="bg-muted">
										<tr>
											{head.map((c, ci) => (
												<th
													key={ci}
													className="px-3 py-2.5 text-left text-xs font-semibold text-foreground border-b border-border"
												>
													{c}
												</th>
											))}
										</tr>
									</thead>
								)}
								<tbody>
									{body.map((row, ri) => (
										<tr key={ri} className="border-b border-border last:border-b-0 hover:bg-muted/50">
											{row.map((c, ci) => (
												<td key={ci} className="px-3 py-2.5 align-top text-foreground leading-relaxed">
													{c}
												</td>
											))}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					);
				}

				return (
					<p key={idx} className="text-[14.5px] leading-[1.9] my-3 text-foreground">
						{b.text}
					</p>
				);
			})}
		</article>
	);
}
