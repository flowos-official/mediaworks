/**
 * Unit test: buildUserPrompt injects complianceBlock in both modes. Reads
 * style-bible from disk (cwd = repo root); no DB / no network.
 * Run: npm run test:screenplay-prompt
 */
import assert from "node:assert";
import { buildUserPrompt } from "../lib/screenplay/prompt";
import type { GenerateInput } from "../lib/screenplay/types";

const brief = { name: "テスト商品", description: "説明文" };
const BLOCK = "## コンプライアンス遵守ルール（生成時に厳守）\n### 禁止表現（使用しない）\n- [yakkiho] シミが消える（効能逸脱）";

(async () => {
  const initial = await buildUserPrompt({ mode: "initial", productBrief: brief, complianceBlock: BLOCK });
  assert.ok(initial.includes("必須遵守"), "initial: 必須遵守 marker present");
  assert.ok(initial.includes("コンプライアンス遵守ルール"), "initial: block injected");

  const refine = await buildUserPrompt({
    mode: "refine", productBrief: brief, feedback: "もっと明るく",
    previousMarkdown: "# 旧台本\n## 本編\n[N] こんにちは。",
    complianceBlock: BLOCK,
  } as GenerateInput);
  assert.ok(refine.includes("必須遵守"), "refine: 必須遵守 marker present");
  assert.ok(refine.includes("コンプライアンス遵守ルール"), "refine: block injected");

  const without = await buildUserPrompt({ mode: "initial", productBrief: brief });
  assert.ok(!without.includes("必須遵守"), "no marker when block absent");

  console.log("[test:screenplay-prompt] PASS");
})();
