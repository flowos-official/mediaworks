/**
 * Unit test for the pure screenplay section splitter/splicer. No DB / no network.
 * Run: npm run test:screenplay-sections
 */
import assert from "node:assert";
import { splitSections, spliceSection } from "../lib/screenplay/sections";

const MD = [
  "# 商品 — 台本",
  "",
  "## メタ情報",
  "- 商品名: X",
  "",
  "## 本編",
  "",
  "### ■アバン",
  "[N] (明るく)",
  "セリフA",
  "",
  "### ■スタジオ①",
  "セリフB",
  "",
].join("\n");

// round-trip invariant: concatenating every section's verbatim text === source
const secs = splitSections(MD);
assert.strictEqual(secs.map((s) => s.text).join(""), MD, "round-trip invariant");

// prologue is the text before the first heading (here the H1 title line)
assert.strictEqual(secs[0].level, 0, "first section is the level-0 prologue");
assert.ok(secs[0].text.includes("# 商品 — 台本"), "prologue holds H1 title");

// boundaries detected at ## and ###
const headings = secs.map((s) => s.heading);
assert.ok(headings.includes("## メタ情報"), "## boundary");
assert.ok(headings.includes("### ■アバン"), "### boundary");
assert.ok(headings.includes("### ■スタジオ①"), "second ### boundary");

// splice replaces ONLY the target section, others verbatim
const aban = secs.find((s) => s.heading === "### ■アバン");
assert.ok(aban, "found ■アバン");
const out = spliceSection(MD, aban, "### ■アバン\nセリフA-修正\n\n");
assert.ok(out.includes("セリフA-修正"), "new text present");
assert.ok(out.includes("セリフB"), "sibling section untouched");
assert.ok(out.includes("## メタ情報"), "earlier section untouched");
assert.ok(!/セリフA\n/.test(out), "old line replaced");

// empty input does not throw and round-trips
assert.strictEqual(splitSections("").map((s) => s.text).join(""), "", "empty round-trip");

console.log("[test:screenplay-sections] PASS");
