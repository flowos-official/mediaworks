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
  "山内": "MC・驚き役",
  "小島": "MC・共感役",
  "お客様": "お客様",
};

const ROLE_LATIN: Record<string, string> = {
  N: "Narrator",
  "高橋": "Takahashi",
  "山内": "Yamauchi",
  "小島": "Kojima",
  "お客様": "Customer",
};

const CUE_TAGS = new Set(["テロップ", "カメラ", "BGM", "SE", "インサート", "小道具"]);
const SPEAKER_TAGS = new Set(["N", "高橋", "山内", "小島", "お客様"]);

const CUE_LATIN: Record<string, string> = {
  "テロップ": "Telop",
  "カメラ": "Camera",
  "BGM": "BGM",
  "SE": "SFX",
  "インサート": "Insert",
  "小道具": "Prop",
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

  // count beats for serial numbers in the gutter
  let beatNo = 0;
  let actNo = 0;

  return (
    <article className="[font-family:var(--font-jp)] text-stone-900 leading-[1.85]">
      {blocks.map((b, idx) => {
        if (b.kind === "heading") {
          if (b.level === 1) {
            return (
              <header key={idx} className="mb-12 pb-8 border-b-4 border-double border-stone-900">
                <div className="font-mono text-[10px] tracking-[0.35em] uppercase text-stone-500 mb-3">
                  Working Script · Final Draft
                </div>
                <h1 className="text-[42px] leading-[1.05] font-black tracking-tight">
                  {b.text}
                </h1>
              </header>
            );
          }
          if (b.level === 2) {
            const isAct = /本編|構成|メタ情報|価格|オファー|スタイル/.test(b.text);
            if (isAct) actNo = 0;
            return (
              <h2
                key={idx}
                className="mt-16 mb-6 font-mono text-[10px] tracking-[0.4em] uppercase text-stone-500 border-b border-stone-300 pb-3"
              >
                <span className="text-stone-900">{b.text}</span>
              </h2>
            );
          }
          // level 3 — act / scene markers
          actNo += 1;
          return (
            <div key={idx} className="mt-14 mb-5 grid grid-cols-[80px_1fr] gap-6 items-baseline">
              <div className="font-mono text-[10px] tracking-[0.3em] uppercase text-stone-500 tabular-nums pt-1">
                Act {actNo.toString().padStart(2, "0")}
              </div>
              <h3 className="text-[22px] font-black leading-tight tracking-tight border-b border-stone-900 pb-2">
                {b.text}
              </h3>
            </div>
          );
        }

        if (b.kind === "hr") {
          return (
            <div key={idx} className="my-12 flex items-center gap-4">
              <div className="h-px flex-1 bg-stone-300" />
              <div className="font-mono text-[9px] tracking-[0.4em] uppercase text-stone-400">cut</div>
              <div className="h-px flex-1 bg-stone-300" />
            </div>
          );
        }

        if (b.kind === "cue") {
          const latin = CUE_LATIN[b.tag] ?? b.tag;
          return (
            <div key={idx} className="my-5 grid grid-cols-[80px_1fr] gap-6">
              <div className="select-none pt-1">
                <div className="font-mono text-[9px] tracking-[0.3em] uppercase text-stone-900 leading-tight">
                  {latin}
                </div>
                <div className="font-mono text-[9px] tracking-[0.15em] uppercase text-stone-400 leading-tight mt-0.5">
                  {b.tag}
                </div>
              </div>
              <div className="border-l border-stone-300 pl-5 text-[13px] leading-[1.8] text-stone-700">
                {b.lines.map((l, li) => (
                  <div key={li} className="whitespace-pre-wrap">{l}</div>
                ))}
              </div>
            </div>
          );
        }

        if (b.kind === "speaker") {
          beatNo += 1;
          const latin = ROLE_LATIN[b.role] ?? b.role;
          const subtitle = ROLE_LABELS[b.role];
          return (
            <div key={idx} className="my-6 grid grid-cols-[80px_1fr] gap-6">
              <div className="select-none pt-1">
                <div className="font-mono text-[9px] tracking-[0.25em] text-stone-400 tabular-nums mb-1">
                  {beatNo.toString().padStart(3, "0")}
                </div>
                <div className="text-[13px] font-bold leading-tight tracking-wide">{b.role}</div>
                <div className="font-mono text-[9px] tracking-[0.15em] uppercase text-stone-400 mt-1 leading-tight">
                  {latin}
                </div>
                {subtitle && (
                  <div className="text-[10px] text-stone-500 mt-1 leading-tight">{subtitle}</div>
                )}
              </div>
              <div>
                {b.delivery && (
                  <div className="text-[11px] italic text-stone-500 mb-1.5 leading-relaxed">
                    ({b.delivery})
                  </div>
                )}
                <p className="text-[15.5px] leading-[1.95] whitespace-pre-wrap font-medium">
                  {b.jp}
                </p>
                {b.en && (
                  <p className="text-[11px] text-stone-400 mt-2 leading-relaxed pl-3 border-l border-stone-200">
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
                <li key={ii} className="text-[13.5px] leading-[1.7] grid grid-cols-[20px_1fr] gap-1 text-stone-700">
                  <span className="font-mono text-stone-400 tabular-nums">{(ii + 1).toString().padStart(2, "0")}</span>
                  <span>{it}</span>
                </li>
              ))}
            </ul>
          );
        }

        if (b.kind === "table") {
          const [head, ...body] = b.rows;
          return (
            <div key={idx} className="my-8 border-t-2 border-stone-900 border-b border-stone-900">
              <table className="w-full border-collapse text-[13px]">
                {head && (
                  <thead>
                    <tr className="border-b border-stone-900">
                      {head.map((c, ci) => (
                        <th
                          key={ci}
                          className="px-3 py-2.5 text-left font-mono text-[10px] tracking-[0.2em] uppercase font-bold text-stone-700"
                        >
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                )}
                <tbody>
                  {body.map((row, ri) => (
                    <tr key={ri} className="border-b border-stone-200 last:border-b-0">
                      {row.map((c, ci) => (
                        <td key={ci} className="px-3 py-3 align-top leading-relaxed text-stone-800">
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
          <p key={idx} className="text-[14.5px] leading-[1.95] my-3 text-stone-700">
            {b.text}
          </p>
        );
      })}
    </article>
  );
}
