import { z } from "zod";

// Free-text script output. No structured fields — the LLM returns a
// numbered-section Japanese script body (300字 cap, 30-second target).
export const outputSchema = z.string();

export type TvScriptOutput = z.infer<typeof outputSchema>;
