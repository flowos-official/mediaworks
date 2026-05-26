/**
 * 単位テスト: callGeminiWithRetry の retry 数 / backoff / no-retry kind 判定。
 * 実行: npm run test:gemini-retry
 */
import { callGeminiWithRetry } from "../lib/gemini/retry";
import { GeminiCallError } from "../lib/gemini/errors";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function main(): Promise<void> {
  // Case 1: 成功は 1 回目で返る
  {
    let calls = 0;
    const result = await callGeminiWithRetry(async () => {
      calls += 1;
      return { result: "ok", responseText: "ok" };
    });
    assert(result === "ok", "result should be 'ok'");
    assert(calls === 1, "should call once on immediate success");
  }

  // Case 2: 1 回目失敗 (server_error)、2 回目成功 → 2 回呼ばれる
  {
    let calls = 0;
    const result = await callGeminiWithRetry(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("upstream"), { status: 503 });
      return { result: "ok2", responseText: "ok2" };
    }, { baseDelayMs: 1 });
    assert(result === "ok2", "result should be 'ok2'");
    assert(calls === 2, `should call twice, got ${calls}`);
  }

  // Case 3: safety_blocked は retry しない
  {
    let calls = 0;
    let thrown: unknown;
    try {
      await callGeminiWithRetry(async () => {
        calls += 1;
        throw { response: { candidates: [{ finishReason: "SAFETY" }] } };
      }, { baseDelayMs: 1 });
    } catch (err) {
      thrown = err;
    }
    assert(thrown instanceof GeminiCallError, "should throw GeminiCallError");
    assert((thrown as GeminiCallError).kind === "safety_blocked", "kind should be safety_blocked");
    assert(calls === 1, `safety_blocked: should call once, got ${calls}`);
  }

  // Case 4: 全 attempt 失敗 → GeminiCallError with attempts = max
  {
    let calls = 0;
    let thrown: unknown;
    try {
      await callGeminiWithRetry(async () => {
        calls += 1;
        throw new SyntaxError("Unexpected token } at position 5");
      }, { baseDelayMs: 1, maxAttempts: 3 });
    } catch (err) {
      thrown = err;
    }
    assert(thrown instanceof GeminiCallError, "should throw GeminiCallError after exhaust");
    assert((thrown as GeminiCallError).kind === "parse_failed", `kind should be parse_failed (got ${(thrown as GeminiCallError).kind})`);
    assert((thrown as GeminiCallError).attempts === 3, `attempts should be 3, got ${(thrown as GeminiCallError).attempts}`);
    assert(calls === 3, `should call 3 times, got ${calls}`);
  }

  // Case 5: responseText が空文字 → extract_empty で再分類、retry 適用
  {
    let calls = 0;
    const result = await callGeminiWithRetry(async () => {
      calls += 1;
      if (calls === 1) return { result: null as unknown as string, responseText: "" };
      return { result: "ok3", responseText: "ok3" };
    }, { baseDelayMs: 1 });
    assert(result === "ok3", `result should be 'ok3', got ${result}`);
    assert(calls === 2, `should call twice on empty-then-success, got ${calls}`);
  }

  // Case 6: promptForAttempt が attempt 番号と前回 kind を受け取る
  {
    const seen: Array<{ attempt: number; kind: string | undefined }> = [];
    let calls = 0;
    try {
      await callGeminiWithRetry(async () => {
        calls += 1;
        throw Object.assign(new Error("upstream"), { status: 503 });
      }, {
        baseDelayMs: 1,
        maxAttempts: 2,
        promptForAttempt: (attempt, kind) => {
          seen.push({ attempt, kind });
          return null;
        },
      });
    } catch {
      // expected
    }
    assert(seen.length === 2, `promptForAttempt should be called 2 times, got ${seen.length}`);
    assert(seen[0].attempt === 1 && seen[0].kind === undefined, "first call: attempt=1, kind=undefined");
    assert(seen[1].attempt === 2 && seen[1].kind === "server_error", `second call: attempt=2 kind=server_error, got ${seen[1].kind}`);
  }

  console.log("[ok] callGeminiWithRetry 全6ケース通過");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
