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
	"テロップ": { bg: "bg-blue-50/60", ring: "border-blue-200", text: "text-blue-900" },
	"カメラ": { bg: "bg-gray-50", ring: "border-gray-200", text: "text-gray-900" },
	"BGM": { bg: "bg-purple-50/60", ring: "border-purple-200", text: "text-purple-900" },
	"SE": { bg: "bg-orange-50/60", ring: "border-orange-200", text: "text-orange-900" },
	"インサート": { bg: "bg-cyan-50/60", ring: "border-cyan-200", text: "text-cyan-900" },
	"小道具": { bg: "bg-amber-50/60", ring: "border-amber-200", text: "text-amber-900" },
};

const ROLE_STYLES: Record<string, string> = {
	N: "bg-gray-100 text-gray-900",
	"高橋": "bg-blue-100 text-blue-900",
	"山内": "bg-green-100 text-green-900",
	"小島": "bg-pink-100 text-pink-900",
	"お客様": "bg-amber-100 text-amber-900",
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
		<article className="text-gray-900 leading-[1.85]">
			{blocks.map((b, idx) => {
				if (b.kind === "heading") {
					if (b.level === 1) {
						return (
							<header key={idx} className="mb-10 pb-6 border-b border-gray-200">
								<div className="text-xs font-medium text-blue-700 bg-blue-50 inline-block px-2 py-0.5 rounded-full mb-3">
									完成版 台本
								</div>
								<h1 className="text-3xl font-bold tracking-tight text-gray-900 leading-tight">
									{b.text}
								</h1>
							</header>
						);
					}
					if (b.level === 2) {
						return (
							<h2 key={idx} className="mt-12 mb-4 text-xs font-semibold tracking-wide text-gray-500 uppercase border-b border-gray-100 pb-2">
								<span className="text-gray-900 normal-case text-lg font-bold">{b.text}</span>
							</h2>
						);
					}
					return (
						<h3 key={idx} className="mt-10 mb-4 text-lg font-bold text-gray-900 flex items-center gap-2">
							<span className="w-1 h-5 bg-blue-600 rounded-full" aria-hidden />
							{b.text}
						</h3>
					);
				}

				if (b.kind === "hr") {
					return (
						<div key={idx} className="my-10 flex items-center gap-3">
							<div className="h-px flex-1 bg-gray-200" />
							<span className="text-[10px] tracking-widest uppercase text-gray-400">場面転換</span>
							<div className="h-px flex-1 bg-gray-200" />
						</div>
					);
				}

				if (b.kind === "cue") {
					const style = CUE_STYLES[b.tag] ?? { bg: "bg-gray-50", ring: "border-gray-200", text: "text-gray-900" };
					return (
						<div key={idx} className={`my-4 rounded-xl border ${style.ring} ${style.bg} px-4 py-3`}>
							<div className={`text-[11px] font-bold tracking-wide ${style.text} mb-1.5`}>
								［{b.tag}］
							</div>
							{b.lines.map((l, li) => (
								<div key={li} className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{l}</div>
							))}
						</div>
					);
				}

				if (b.kind === "speaker") {
					const roleCls = ROLE_STYLES[b.role] ?? "bg-gray-100 text-gray-900";
					return (
						<div key={idx} className="my-5 grid grid-cols-[120px_1fr] gap-4 py-2 border-b border-dashed border-gray-100">
							<div>
								<span className={`inline-flex items-center text-xs font-bold px-2 py-1 rounded-md ${roleCls}`}>
									{b.role}
								</span>
								<div className="text-[10px] text-gray-400 mt-1">{ROLE_LABELS[b.role] ?? ""}</div>
							</div>
							<div>
								{b.delivery && (
									<div className="text-xs italic text-gray-500 mb-1.5">（{b.delivery}）</div>
								)}
								<p className="text-[15px] leading-[1.9] whitespace-pre-wrap text-gray-900">{b.jp}</p>
								{b.en && (
									<p className="text-[11px] text-gray-400 mt-1.5 pl-3 border-l-2 border-gray-200 italic">
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
								<li key={ii} className="text-[13.5px] leading-[1.7] grid grid-cols-[20px_1fr] gap-1 text-gray-700">
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
						<div key={idx} className="my-6 border border-gray-200 rounded-xl overflow-hidden">
							<table className="w-full border-collapse text-sm">
								{head && (
									<thead className="bg-gray-50">
										<tr>
											{head.map((c, ci) => (
												<th
													key={ci}
													className="px-3 py-2.5 text-left text-xs font-semibold text-gray-700 border-b border-gray-200"
												>
													{c}
												</th>
											))}
										</tr>
									</thead>
								)}
								<tbody>
									{body.map((row, ri) => (
										<tr key={ri} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/50">
											{row.map((c, ci) => (
												<td key={ci} className="px-3 py-2.5 align-top text-gray-800 leading-relaxed">
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
					<p key={idx} className="text-[14.5px] leading-[1.9] my-3 text-gray-700">
						{b.text}
					</p>
				);
			})}
		</article>
	);
}
