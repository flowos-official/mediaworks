import { filterAliases } from "@/lib/strategy/alias-blocklist";

const r1 = filterAliases(
  ["ナイフ", "キッチン用品", "包丁", "1", "knife"],
  ["キッチン用品"]
);
if (!r1.kept.includes("ナイフ")) throw new Error("kept should include ナイフ");
if (!r1.kept.includes("包丁")) throw new Error("kept should include 包丁");
if (!r1.kept.includes("knife")) throw new Error("kept should include knife");
if (r1.kept.includes("キッチン用品")) throw new Error("blocklist should drop キッチン用品");
if (r1.kept.includes("1")) throw new Error("length < 2 should be dropped");
if (r1.dropped.length !== 2) throw new Error(`expected 2 dropped, got ${r1.dropped.length}`);

console.log("✓ alias-blocklist tests pass");
