import { GeminiCallError, type GeminiErrorKind, classifyGeminiError } from "./errors";

const NO_RETRY_KINDS: ReadonlySet<GeminiErrorKind> = new Set([
  "authentication_failed",
  "safety_blocked",
]);

const BACKOFF_MULTIPLIER: Record<GeminiErrorKind, number> = {
  authentication_failed: 1.0,
  safety_blocked: 1.0,
  rate_limited: 1.5,
  server_error: 2.0,
  parse_failed: 1.5,
  schema_validation_failed: 1.5,
  extract_empty: 1.5,
  unknown: 1.5,
};

export interface InvokerResult<T> {
  result: T;
  responseText?: string;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  onAttempt?: (attempt: number, lastKind?: GeminiErrorKind) => void;
  promptForAttempt?: (attempt: number, lastKind?: GeminiErrorKind) => string | null;
}

export async function callGeminiWithRetry<T>(
  invoker: (attempt: number, promptOverride: string | null) => Promise<InvokerResult<T>>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;

  let lastKind: GeminiErrorKind | undefined;
  let lastSummary = "";
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const promptOverride = options.promptForAttempt?.(attempt, lastKind) ?? null;
    options.onAttempt?.(attempt, lastKind);

    try {
      const { result, responseText } = await invoker(attempt, promptOverride);
      if (responseText !== undefined && responseText.trim().length === 0) {
        throw new Error("empty model response");
      }
      return result;
    } catch (err) {
      lastError = err;
      lastKind = classifyGeminiError(err);
      lastSummary = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);

      if (NO_RETRY_KINDS.has(lastKind)) break;
      if (attempt >= maxAttempts) break;

      const multiplier = BACKOFF_MULTIPLIER[lastKind] ?? 1.5;
      const delay = Math.round(baseDelayMs * Math.pow(multiplier, attempt - 1));
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new GeminiCallError(
    lastKind ?? "unknown",
    maxAttempts,
    `${lastSummary} after ${maxAttempts} attempts`,
    lastError,
  );
}
