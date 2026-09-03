/**
 * Attribute every Gemini call to the stage that made it.
 *
 * Without this, a bill can only be explained by inference from row counts, and
 * a call that consumed tokens and then failed leaves no trace at all — a
 * MAX_TOKENS truncation bills for the full output allowance and returns
 * nothing, so counting outputs undercounts spend exactly where it is worst.
 *
 * Recording is best-effort in the strongest sense: it never throws, never
 * blocks, and a failure to record is logged and dropped. Telemetry about cost
 * must not be able to cost you the work.
 *
 * NO `import "server-only"` — imported by tsx smoke scripts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { getServiceClient } from "@/lib/supabase";
import type { GeminiStage } from "@/lib/gemini-models";

/** The shape `@google/genai` returns; every field is optional in practice. */
export interface GeminiUsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	thoughtsTokenCount?: number;
	cachedContentTokenCount?: number;
	totalTokenCount?: number;
}

export interface GeminiUsageRecord {
	stage: GeminiStage | string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	thinkingTokens: number;
	cachedTokens: number;
	succeeded: boolean;
	errorCode?: string;
	subject?: string;
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

export function toUsageRecord(input: {
	stage: GeminiStage | string;
	model: string;
	usage: GeminiUsageMetadata | undefined;
	succeeded?: boolean;
	errorCode?: string;
	subject?: string;
}): GeminiUsageRecord | null {
	if (!input.usage) return null;
	return {
		stage: input.stage,
		model: input.model,
		inputTokens: finite(input.usage.promptTokenCount),
		outputTokens: finite(input.usage.candidatesTokenCount),
		// Thinking is billed at the output rate and never appears in the text, so
		// it is the part a response-size estimate silently misses.
		thinkingTokens: finite(input.usage.thoughtsTokenCount),
		cachedTokens: finite(input.usage.cachedContentTokenCount),
		succeeded: input.succeeded ?? true,
		...(input.errorCode ? { errorCode: input.errorCode } : {}),
		...(input.subject ? { subject: input.subject } : {}),
	};
}

/** A greppable line, so a run can still be priced from stdout alone. */
export function formatUsageLine(record: GeminiUsageRecord): string {
	return `[gemini-usage] ${JSON.stringify(record)}`;
}

/**
 * Persist one call's usage. Fire-and-forget by design: callers should not await
 * this on a hot path, and must never let it reject into their own error
 * handling.
 */
export async function recordGeminiUsage(
	record: GeminiUsageRecord | null,
	client?: SupabaseClient,
): Promise<void> {
	if (!record) return;
	console.log(formatUsageLine(record));
	try {
		const sb = client ?? getServiceClient();
		const { error } = await sb.from("gemini_usage").insert({
			stage: record.stage,
			model: record.model,
			input_tokens: record.inputTokens,
			output_tokens: record.outputTokens,
			thinking_tokens: record.thinkingTokens,
			cached_tokens: record.cachedTokens,
			succeeded: record.succeeded,
			error_code: record.errorCode ?? null,
			subject: record.subject ?? null,
		});
		if (error) throw new Error(error.message);
	} catch (err) {
		// The log line above is the fallback record; losing the row is acceptable,
		// losing the caller's work to a telemetry write is not.
		console.warn("[gemini-usage] persist failed:", err instanceof Error ? err.message : String(err));
	}
}

/** Published rates per 1M tokens, checked 2026-09-03. Thinking bills as output. */
export const GEMINI_PRICES: Record<string, { input: number; output: number }> = {
	"gemini-3.7-flash": { input: 0.75, output: 3.75 },
	"gemini-3.5-flash": { input: 1.5, output: 9.0 },
	"gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
	"gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
	"gemini-3.1-pro-preview": { input: 1.25, output: 10.0 },
};

export function priceUsage(record: {
	model: string;
	inputTokens: number;
	outputTokens: number;
	thinkingTokens: number;
}): number | null {
	const price = GEMINI_PRICES[record.model];
	if (!price) return null;
	return (
		(record.inputTokens / 1e6) * price.input +
		((record.outputTokens + record.thinkingTokens) / 1e6) * price.output
	);
}
