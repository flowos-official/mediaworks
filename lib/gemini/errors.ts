export type GeminiErrorKind =
	| "authentication_failed"
  | "safety_blocked"
  | "rate_limited"
  | "server_error"
  | "parse_failed"
  | "schema_validation_failed"
  | "extract_empty"
  | "unknown";

export class GeminiCallError extends Error {
  constructor(
    public readonly kind: GeminiErrorKind,
    public readonly attempts: number,
    public readonly summary: string,
    public readonly lastError: unknown,
  ) {
    super(`${kind}: ${summary}`);
    this.name = "GeminiCallError";
  }
}

function pickStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function pickResponse(
  err: unknown,
):
  | {
      promptFeedback?: { blockReason?: string };
      candidates?: Array<{ finishReason?: string }>;
    }
  | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const response = (err as { response?: unknown }).response;
  return typeof response === "object" && response !== null
    ? (response as {
        promptFeedback?: { blockReason?: string };
        candidates?: Array<{ finishReason?: string }>;
      })
    : undefined;
}

export function classifyGeminiError(err: unknown): GeminiErrorKind {
  // Some callers wrap a GenerativeAI response object inside an error-shaped throw.
  const response = pickResponse(err);
  if (response?.candidates?.[0]?.finishReason === "SAFETY") return "safety_blocked";
  if (response?.promptFeedback?.blockReason) return "safety_blocked";

  const status = pickStatus(err);
  if (status === 429) return "rate_limited";
  if (typeof status === "number" && status >= 500 && status < 600) return "server_error";

  const message = err instanceof Error ? err.message : String(err ?? "");

  if (
	status === 401 ||
	status === 403 ||
	/API_KEY_INVALID|API key not valid|invalid api key|permission_denied/i.test(message)
  ) {
	return "authentication_failed";
  }

  if (/empty model response/i.test(message)) return "extract_empty";
  if (err instanceof SyntaxError) return "parse_failed";
  if (/failed to parse json|invalid json|unexpected token/i.test(message)) return "parse_failed";
  if (/response did not match schema|missing required field|schema validation/i.test(message)) return "schema_validation_failed";
  if (/rate limit|quota/i.test(message)) return "rate_limited";
  if (/network|timeout|fetch failed/i.test(message)) return "server_error";

  return "unknown";
}

/** Safe, actionable Japanese text for UI/workflow progress. Never includes keys. */
export function geminiUserFacingMessage(err: unknown): string | null {
	const kind = err instanceof GeminiCallError ? err.kind : classifyGeminiError(err);
	switch (kind) {
		case "authentication_failed":
			return "AI接続設定が無効です。管理者が GEMINI_API_KEY を更新してから、もう一度実行してください。";
		case "rate_limited":
			return "AIサービスの利用上限に達しました。しばらく待ってから、もう一度実行してください。";
		case "server_error":
			return "AIサービスに一時的な障害が発生しています。時間をおいて再実行してください。";
		case "safety_blocked":
			return "入力内容がAIサービスの安全基準で停止されました。表現を調整して再実行してください。";
		default:
			return null;
	}
}
