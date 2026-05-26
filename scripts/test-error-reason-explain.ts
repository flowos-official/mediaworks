/**
 * 単位テスト: explainErrorReason の kind マッピングカバレッジ。
 * 実行: npm run test:error-reason-explain
 */
import { explainErrorReason, ERROR_REASON_LABELS_JA, ERROR_REASON_LABELS_KO } from "../lib/research/error-reason-explain";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function main(): void {
  const kinds = [
    "safety_blocked", "rate_limited", "server_error", "parse_failed",
    "schema_validation_failed", "extract_empty", "context_load_failed",
    "cron_secret_missing", "trigger_not_invoked", "analysis_timeout",
    "extract_failed", "synthesis_failed", "file_too_large", "no_files", "unknown",
  ];

  for (const kind of kinds) {
    assert(typeof ERROR_REASON_LABELS_JA[kind] === "string", `JA label missing for ${kind}`);
    assert(typeof ERROR_REASON_LABELS_KO[kind] === "string", `KO label missing for ${kind}`);
  }

  // explainErrorReason with prefix
  assert(explainErrorReason("safety_blocked: HATE_SPEECH at attempt 1", "ja") !== ERROR_REASON_LABELS_JA.unknown,
    "safety_blocked prefix → specific message");
  assert(explainErrorReason("synthesis_failed: Bad gateway", "ja") !== ERROR_REASON_LABELS_JA.unknown,
    "synthesis_failed prefix → specific message");

  // null → unknown
  assert(explainErrorReason(null, "ja") === ERROR_REASON_LABELS_JA.unknown,
    "null reason → unknown label JA");
  assert(explainErrorReason(null, "ko") === ERROR_REASON_LABELS_KO.unknown,
    "null reason → unknown label KO");

  // unmatched kind → unknown
  assert(explainErrorReason("totally_new_kind: blah", "ja") === ERROR_REASON_LABELS_JA.unknown,
    "unmatched prefix → unknown");

  console.log("[ok] error-reason-explain 全15 kind + null + unknown 通過");
}

main();
