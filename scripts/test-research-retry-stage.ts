/**
 * 単位テスト: determineRetryStage の分岐ロジック。
 * 実行: npm run test:research-retry-stage
 */
import { determineRetryStage } from "../lib/research/retry-stage";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function main(): void {
  // 1) description が NULL → extract から再開
  assert(
    determineRetryStage({ description: null }) === "extract",
    "description=null は extract を返すべき",
  );

  // 2) description が空文字 → extract から再開 (Gemini が "" を返す事故ケース対策)
  assert(
    determineRetryStage({ description: "" }) === "extract",
    "description='' も extract 扱い",
  );

  // 3) description が空白のみ → extract (trim 後の判定)
  assert(
    determineRetryStage({ description: "   " }) === "extract",
    "description=whitespace のみは extract 扱い",
  );

  // 4) 正常な description あり → synthesize から
  assert(
    determineRetryStage({ description: "実在する商品説明" }) === "synthesize",
    "description あり は synthesize を返すべき",
  );

  console.log("[ok] determineRetryStage 全4ケース通過");
}

main();
