// lib/screenplay/sections.ts
// Pure screenplay-section splitter/splicer. No DB / no "server-only" — importable
// from tsx smoke scripts. Splits markdown on top-level (##) and act-level (###)
// headings, preserving every character so split→join === original (round-trip
// invariant). Used by the targeted remediation engine to regenerate only the
// affected act and splice it back, leaving clean sections byte-for-byte intact.

export interface Section {
  /** The heading line without its trailing newline, or "" for the prologue. */
  heading: string;
  /** 2 = `## `, 3 = `### `, 0 = prologue (text before the first heading). */
  level: 2 | 3 | 0;
  /** Verbatim slice INCLUDING the heading line and everything up to the next
   *  boundary (trailing blank lines included). */
  text: string;
  /** Char offset of this section's start in the source markdown. */
  start: number;
  /** Char offset (exclusive) of this section's end. */
  end: number;
}

const BOUNDARY = /^(#{2,3})\s+.*$/;

export function splitSections(md: string): Section[] {
  // Split keeping the newline terminator on each element (lookbehind).
  const lines = md.split(/(?<=\n)/);
  const sections: Section[] = [];
  let cur: { heading: string; level: 2 | 3 | 0; start: number; buf: string } | null = null;
  let offset = 0;

  const flush = (endOffset: number) => {
    if (cur) sections.push({ heading: cur.heading, level: cur.level, text: cur.buf, start: cur.start, end: endOffset });
  };

  for (const line of lines) {
    const bare = line.replace(/\r?\n$/, "");
    const m = bare.match(BOUNDARY);
    if (m) {
      flush(offset);
      const level = (m[1].length === 2 ? 2 : 3) as 2 | 3;
      cur = { heading: bare, level, start: offset, buf: line };
    } else if (cur) {
      cur.buf += line;
    } else {
      cur = { heading: "", level: 0, start: offset, buf: line };
    }
    offset += line.length;
  }
  flush(offset);
  return sections;
}

export function spliceSection(md: string, section: Section, newText: string): string {
  return md.slice(0, section.start) + newText + md.slice(section.end);
}
