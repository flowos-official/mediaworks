/**
 * Unit test: buildUserPrompt injects complianceBlock in both modes. Reads
 * style-bible from disk (cwd = repo root); no DB / no network.
 * Run: npm run test:screenplay-prompt
 */
import assert from "node:assert";
import { buildUserPrompt, __test } from "../lib/screenplay/prompt";
import type { GenerateInput } from "../lib/screenplay/types";

const brief = {
  name: "テスト商品",
  description: "確認済みの説明文",
  notes: "市場性仮説と未確認の販売案",
  customization: {
    runtimeMinutes: 12,
    targetAudience: "60代以上",
    keyMessage: "毎日の負担を軽くする",
    extraSpeakers: [{ role: "佐藤", description: "確認済みのメーカー担当者" }],
  },
};
const BLOCK = "## コンプライアンス遵守ルール（生成時に厳守）\n### 禁止表現（使用しない）\n- [yakkiho] シミが消える（効能逸脱）";

(async () => {
  const initial = await buildUserPrompt({ mode: "initial", productBrief: brief, complianceBlock: BLOCK });
  assert.ok(initial.includes("必須遵守"), "initial: 必須遵守 marker present");
  assert.ok(initial.includes("コンプライアンス遵守ルール"), "initial: block injected");
  assert.ok(initial.includes("確認済み商品情報"), "initial: confirmed facts are labeled");
  assert.ok(initial.includes("企画参考情報"), "initial: planning notes are labeled as non-facts");
  assert.ok(initial.includes("約 12 分"), "initial: requested runtime is carried into the prompt");
  assert.ok(initial.includes("[佐藤]"), "initial: approved extra speaker is carried into the prompt");
  assert.ok(initial.includes("観測資料: 1商品"), "initial: limited style evidence is disclosed");

  const safeStyle = await __test.loadStyleBible();
  assert.ok(!safeStyle.includes("レイコップ"), "style reference does not leak the observed product");
  assert.ok(!safeStyle.includes("19,800"), "style reference does not leak observed offer prices");

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
