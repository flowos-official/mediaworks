/**
 * The one Gemini call the structure plan makes.
 *
 * Kept out of structure-plan.ts so the planning and validation logic stays
 * importable by a tsx unit test with no key and no network.
 *
 * `screenplay_structure` is its own stage rather than borrowing
 * `screenplay_generation`: a stage is the unit of cost attribution, and
 * charging a planning call to the drafting stage would make the drafting
 * stage's per-script cost wrong in both directions when one of them changes.
 * Usage is recorded before any post-response throw, for the reason
 * lib/gemini-usage.ts documents — a MAX_TOKENS truncation bills for the whole
 * allowance and returns nothing.
 */
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { modelForStage } from "@/lib/gemini-models";
import { recordGeminiUsage, toUsageRecord } from "@/lib/gemini-usage";
import type { StructurePlanGenerator } from "./structure-plan";

const TIMEOUT_MS = 60_000;

export function geminiStructurePlanGenerator(subject?: string): StructurePlanGenerator {
	return async (prompt: string): Promise<string> => {
		const apiKey = process.env.GEMINI_API_KEY;
		if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
		const model = modelForStage("screenplay_structure");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error(`Gemini timeout ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
		try {
			const response = await new GoogleGenAI({ apiKey }).models.generateContent({
				model,
				contents: prompt,
				config: {
					responseMimeType: "application/json",
					thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
					abortSignal: controller.signal,
				},
			});
			await recordGeminiUsage(
				toUsageRecord({
					stage: "screenplay_structure",
					model,
					usage: response.usageMetadata,
					succeeded: true,
					...(subject ? { subject } : {}),
				}),
			);
			return response.text ?? "";
		} catch (error) {
			await recordGeminiUsage(
				toUsageRecord({
					stage: "screenplay_structure",
					model,
					usage: undefined,
					succeeded: false,
					errorCode: error instanceof Error ? error.name : "unknown",
					...(subject ? { subject } : {}),
				}),
			);
			throw error;
		} finally {
			clearTimeout(timer);
		}
	};
}
