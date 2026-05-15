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
  "山内": "MC (驚き役)",
  "小島": "MC (共感役)",
  "お客様": "お客様",
};

const CUE_TAGS = new Set(["テロップ", "カメラ", "BGM", "SE", "インサート", "小道具"]);
const SPEAKER_TAGS = new Set(["N", "高橋", "山内", "小島", "お客様"]);

function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimEnd();
    if (!trimmed.trim()) { i++; continue; }

    // Heading
    const h = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      blocks.push({ kind: "heading", level: h[1].length as 1 | 2 | 3, text: h[2] });
      i++;
      continue;
    }

    // HR
    if (/^---+$/.test(trimmed.trim())) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    // Tag like [テロップ] or [N]
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
        // skip blank lines
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
      // Unrecognized bracket tag — fall through to paragraph
    }

    // Table: | a | b | followed by | --- | line
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

    // Bullets
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

const cueClasses: Record<string, string> = {
  "テロップ": "border-l-4 border-zinc-900 bg-zinc-50",
  "カメラ": "border-l-4 border-zinc-700 bg-zinc-50",
  "BGM": "border-l-4 border-zinc-500 bg-zinc-50",
  "SE": "border-l-4 border-zinc-500 bg-zinc-50",
  "インサート": "border-l-4 border-zinc-700 bg-zinc-50",
  "小道具": "border-l-4 border-zinc-400 bg-zinc-50",
};

export function ScreenplayMarkdown({ markdown }: { markdown: string }) {
  const blocks = parseMarkdown(markdown);
  return (
    <article className="max-w-none text-zinc-900">
      {blocks.map((b, idx) => {
        if (b.kind === "heading") {
          if (b.level === 1) return <h1 key={idx} className="text-3xl font-black tracking-tight mb-4 mt-0">{b.text}</h1>;
          if (b.level === 2) return <h2 key={idx} className="text-xl font-bold border-b border-zinc-900 pb-2 mt-10 mb-4">{b.text}</h2>;
          return <h3 key={idx} className="text-base font-bold border-l-4 border-zinc-900 pl-2 mt-6 mb-2">{b.text}</h3>;
        }
        if (b.kind === "hr") return <hr key={idx} className="my-8 border-zinc-300" />;
        if (b.kind === "cue") {
          const cls = cueClasses[b.tag] ?? "border-l-4 border-zinc-300 bg-zinc-50";
          return (
            <div key={idx} className={`${cls} px-3 py-2 my-3 text-sm`}>
              <div className="font-bold tracking-wide text-xs uppercase mb-1">[{b.tag}]</div>
              {b.lines.map((l, li) => <div key={li} className="text-zinc-700 whitespace-pre-wrap">{l}</div>)}
            </div>
          );
        }
        if (b.kind === "speaker") {
          return (
            <div key={idx} className="grid grid-cols-[160px_1fr] gap-3 py-2 border-b border-dotted border-zinc-200">
              <div className="text-sm font-bold">
                {b.role}
                <div className="text-[10px] font-light text-zinc-500">{ROLE_LABELS[b.role] ?? ""}</div>
              </div>
              <div>
                {b.delivery && <div className="text-[11px] font-light text-zinc-500 mb-1">({b.delivery})</div>}
                <p className="text-[15px] leading-[1.85] whitespace-pre-wrap">{b.jp}</p>
                {b.en && <p className="text-[11px] text-zinc-400 mt-1">({b.en})</p>}
              </div>
            </div>
          );
        }
        if (b.kind === "list") {
          return (
            <ul key={idx} className="my-3 pl-0 list-none">
              {b.items.map((it, ii) => <li key={ii} className="text-sm py-0.5">{it}</li>)}
            </ul>
          );
        }
        if (b.kind === "table") {
          const [head, ...body] = b.rows;
          return (
            <table key={idx} className="w-full border-collapse my-4 text-sm">
              <thead>
                <tr>{head?.map((c, ci) => <th key={ci} className="border border-zinc-200 px-3 py-2 bg-zinc-50 text-left font-bold">{c}</th>)}</tr>
              </thead>
              <tbody>
                {body.map((row, ri) => (
                  <tr key={ri}>{row.map((c, ci) => <td key={ci} className="border border-zinc-200 px-3 py-2 align-top">{c}</td>)}</tr>
                ))}
              </tbody>
            </table>
          );
        }
        return <p key={idx} className="text-[15px] leading-[1.85] my-2">{b.text}</p>;
      })}
    </article>
  );
}
