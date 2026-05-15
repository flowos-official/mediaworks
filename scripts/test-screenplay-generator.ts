import { generateScreenplay } from "@/lib/screenplay/generator";
import { writeFile } from "node:fs/promises";

async function main() {
  console.log("[1/2] Generating initial screenplay…");
  const initial = await generateScreenplay({
    mode: "initial",
    productBrief: {
      name: "テスト商品X",
      category: "ヘルスケア",
      description: "1枚のレンズで手元から少し先まで見える老眼鏡。+1.0〜+2.5度数対応。重さ約20g、βチタンテンプル。",
      price: { listJpy: 14800, saleJpy: 9800, shippingJpy: 950 },
      guarantee: "1年保証",
    },
  });
  console.log(`initial: ${initial.markdown.length} chars`);
  await writeFile("/tmp/screenplay-test-v1.md", initial.markdown, "utf-8");

  console.log("[2/2] Generating refined screenplay (with feedback)…");
  const refined = await generateScreenplay({
    mode: "refine",
    productBrief: {
      name: "テスト商品X",
      category: "ヘルスケア",
      description: "1枚のレンズで手元から少し先まで見える老眼鏡。+1.0〜+2.5度数対応。重さ約20g、βチタンテンプル。",
      price: { listJpy: 14800, saleJpy: 9800, shippingJpy: 950 },
      guarantee: "1年保証",
    },
    feedback: "実演デモを最後の方に移動してください。お客様の声を3人に増やしてください。",
    previousMarkdown: initial.markdown,
  });
  console.log(`refined: ${refined.markdown.length} chars`);
  await writeFile("/tmp/screenplay-test-v2.md", refined.markdown, "utf-8");
  console.log("Saved /tmp/screenplay-test-v1.md and v2.md");
}

main().catch((e) => { console.error(e); process.exit(1); });
