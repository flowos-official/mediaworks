/**
 * 単位テスト: classifyGeminiError の 9 ケース / 7 分岐検証。
 * 実行: npm run test:gemini-classify-error
 */
import { classifyGeminiError, geminiUserFacingMessage } from "../lib/gemini/errors";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function main(): void {
  // 1) safety: candidates[0].finishReason === 'SAFETY'
  const safetyFinish = { response: { candidates: [{ finishReason: "SAFETY" }] } };
  assert(classifyGeminiError(safetyFinish) === "safety_blocked", "candidates[0].finishReason=SAFETY → safety_blocked");

  // 2) safety: promptFeedback.blockReason
  const safetyPrompt = { response: { promptFeedback: { blockReason: "HATE_SPEECH" } } };
  assert(classifyGeminiError(safetyPrompt) === "safety_blocked", "promptFeedback.blockReason → safety_blocked");

  // 3) rate-limited: status 429
  const rate = Object.assign(new Error("rate limit exceeded"), { status: 429 });
  assert(classifyGeminiError(rate) === "rate_limited", "status=429 → rate_limited");

  // 4) server error: status 5xx
  const serverErr = Object.assign(new Error("upstream"), { status: 503 });
  assert(classifyGeminiError(serverErr) === "server_error", "status=503 → server_error");

  // 5) extract_empty: explicit empty text marker
  const emptyErr = new Error("empty model response");
  assert(classifyGeminiError(emptyErr) === "extract_empty", "empty model response → extract_empty");

  // 6) parse_failed: SyntaxError style
  const parseErr = new SyntaxError("Unexpected token } in JSON at position 14");
  assert(classifyGeminiError(parseErr) === "parse_failed", "SyntaxError → parse_failed");

  // 7) parse_failed: "Failed to parse JSON" message
  const parseErr2 = new Error("Failed to parse JSON from research synthesis: ...");
  assert(classifyGeminiError(parseErr2) === "parse_failed", "Failed to parse JSON message → parse_failed");

  // 8) schema_validation_failed: message mentions schema
  const schemaErr = new Error("response did not match schema: missing required field korea_market_fit");
  assert(classifyGeminiError(schemaErr) === "schema_validation_failed", "schema mention → schema_validation_failed");

  // 9) unknown: fallback
  const random = new Error("unexpected condition encountered");
  assert(classifyGeminiError(random) === "unknown", "unknown fallback");

  const invalidKey = Object.assign(new Error("API key not valid: API_KEY_INVALID"), { status: 400 });
  assert(classifyGeminiError(invalidKey) === "authentication_failed", "invalid API key → authentication_failed");
  const userMessage = geminiUserFacingMessage(invalidKey);
  assert(userMessage?.includes("GEMINI_API_KEY"), "invalid API key → actionable user message");
  assert(!userMessage?.includes("API_KEY_INVALID"), "user message does not expose raw provider detail");

  console.log("[ok] classifyGeminiError 全11ケース通過");
}

main();
