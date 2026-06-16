// lib/screenplay/diff.ts
// Pure line-level diff → hunks. Shared by the client renderer (ChangeDiffView)
// and the server rationale endpoint, so hunk ordinals align on both sides.
// No "server-only" — importable from the browser and tsx smoke scripts.
import { diffLines } from "diff";
import type { DiffLine, DiffHunk } from "./types";

// Bump when the hunking algorithm changes (part of the change_notes cache key).
export const DIFF_VERSION = 1;

const CONTEXT = 3;

export function computeLineDiff(base: string, next: string): DiffHunk[] {
  const parts = diffLines(base ?? "", next ?? "");
  const flat: DiffLine[] = [];
  for (const p of parts) {
    const type: DiffLine["type"] = p.added ? "added" : p.removed ? "removed" : "context";
    const lines = p.value.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // drop trailing newline artifact
    for (const text of lines) flat.push({ type, text });
  }

  const changed: number[] = [];
  for (let i = 0; i < flat.length; i++) if (flat[i].type !== "context") changed.push(i);
  if (changed.length === 0) return [];

  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < changed.length) {
    const start = changed[i];
    let j = i;
    let end = start;
    // merge changes separated by <= 2*CONTEXT context lines into one hunk
    while (j + 1 < changed.length && changed[j + 1] - changed[j] <= 2 * CONTEXT) {
      j++;
      end = changed[j];
    }
    const from = Math.max(0, start - CONTEXT);
    const to = Math.min(flat.length - 1, end + CONTEXT);
    hunks.push({ index: hunks.length, lines: flat.slice(from, to + 1) });
    i = j + 1;
  }
  return hunks;
}
