export type GeminiErrorKind =
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

  if (/empty model response/i.test(message)) return "extract_empty";
  if (err instanceof SyntaxError) return "parse_failed";
  if (/failed to parse json|invalid json|unexpected token/i.test(message)) return "parse_failed";
  if (/schema|missing required field/i.test(message)) return "schema_validation_failed";
  if (/rate limit|quota/i.test(message)) return "rate_limited";
  if (/timeout|fetch failed/i.test(message)) return "server_error";

  return "unknown";
}
