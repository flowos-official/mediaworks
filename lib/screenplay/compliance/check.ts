import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { GEMINI_MODELS_WITH_FALLBACK } from "@/lib/gemini-models";
import { getServiceClient } from "@/lib/supabase";
import type { ProductBrief } from "@/lib/screenplay/types";
import { matchLexicon } from "./lexicon-match";
import type { ComplianceRule, Finding, ScriptCheckResult, Severity } from "./types";

let _genAI: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
	if (!_genAI) _genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
	return _genAI;
}

export async function loadActiveRules(): Promise<ComplianceRule[]> {
	const sb = getServiceClient();
	const { data, error } = await sb
		.from("compliance_rules")
		.select("id,law,category_scope,pattern,is_regex,allowed,severity,reason,safe_rewrite,citation,active")
		.eq("active", true);
	if (error) {
		console.warn("[compliance] loadActiveRules failed:", error.message);
		return [];
	}
	return (data ?? []) as ComplianceRule[];
}

function isRetryable(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const m = err.message;
	return ["503","429","500","502","504","overloaded","UNAVAILABLE","timeout","aborted","ECONNRESET","ETIMEDOUT"].some((s) => m.includes(s));
}
function isUnavailable(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return ["404","Not Found","no longer available"].some((s) => err.message.includes(s));
}

async function callOnce(model: string, prompt: string): Promise<string> {
	const HARD = 60_000, FIRST = 30_000;
	const controller = new AbortController();
	const hard = setTimeout(() => controller.abort(new Error(`Gemini hard timeout ${HARD}ms`)), HARD);
	let first: ReturnType<typeof setTimeout> | null = setTimeout(() => controller.abort(new Error(`Gemini first-chunk timeout ${FIRST}ms`)), FIRST);
	try {
		const stream = await getGenAI().models.generateContentStream({
			model,
			contents: prompt,
			config: { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL }, abortSignal: controller.signal },
		});
		let text = "";
		for await (const chunk of stream) {
			if (first) { clearTimeout(first); first = null; }
			text += chunk.text ?? "";
		}
		return text.trim();
	} finally {
		clearTimeout(hard);
		if (first) clearTimeout(first);
	}
}

async function callGemini(prompt: string): Promise<string> {
	let lastErr: unknown = null;
	for (const model of GEMINI_MODELS_WITH_FALLBACK) {
		let dead = false;
		for (let attempt = 0; attempt < 2; attempt++) {
			try { return await callOnce(model, prompt); }
			catch (err) {
				lastErr = err;
				if (isUnavailable(err)) { dead = true; break; }
				if (!isRetryable(err)) throw err;
				await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
			}
		}
		if (dead) continue;
	}
	throw lastErr instanceof Error ? lastErr : new Error("All Gemini models failed");
}

function parseJSON<T>(raw: string): T {
	let c = raw.trim();
	const fence = c.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	if (fence) c = fence[1].trim();
	const start = c.indexOf("{");
	if (start === -1) throw new Error("No JSON object found");
	// balanced-brace scan
	let depth = 0, inStr = false, esc = false, end = -1;
	for (let i = start; i < c.length; i++) {
		const ch = c[i];
		if (esc) { esc = false; continue; }
		if (ch === "\\") { esc = true; continue; }
		if (ch === '"') { inStr = !inStr; continue; }
		if (inStr) continue;
		if (ch === "{") depth++;
		else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
	}
	if (end === -1) throw new Error("Unbalanced JSON");
	return JSON.parse(c.slice(start, end + 1)) as T;
}

const SEVS: Severity[] = ["high", "med", "low"];
function coerceFinding(raw: unknown, axis: Finding["axis"]): Finding | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const quote = String(r.quote ?? "").trim();
	if (!quote) return null;
	const sev = SEVS.includes(r.severity as Severity) ? (r.severity as Severity) : "med";
	return {
		axis,
		severity: sev,
		quote: quote.slice(0, 300),
		reason: String(r.reason ?? "").slice(0, 400),
		citedRule: String(r.citedRule ?? "").slice(0, 200),
		suggestedRewrite: String(r.suggestedRewrite ?? "").slice(0, 400),
		source: "llm",
	};
}

function buildPrompt(markdown: string, brief: ProductBrief, rules: ComplianceRule[]): string {
	const ngList = rules.filter((r) => !r.allowed).slice(0, 60).map((r) => `- [${r.law}] ${r.pattern} (${r.reason})`).join("\n");
	const okList = rules.filter((r) => r.allowed).slice(0, 30).map((r) => `- ${r.pattern}`).join("\n");
	return `あなたは日本のテレビ通販の考査担当者です。以下の放送台本を3観点で点検し、純粋なJSONのみで出力してください（markdown装飾なし）。

【商品情報（事実の根拠）】
- 商品名: ${brief.name}
- カテゴリ: ${brief.category ?? "(不明)"}
- 説明: ${brief.description}
- 価格: ${brief.price ? JSON.stringify(brief.price) : "(不明)"}
- 特典: ${(brief.bonuses ?? []).join(" / ") || "(なし)"}

【法規NG表現（参考・カテゴリ該当時）】
${ngList || "(なし)"}
【許容表現（これらは違反にしない）】
${okList || "(なし)"}

【点検観点】
1. legal: 薬機法・景表法・健康増進法の違反疑い（上記NGの言い換え・優良誤認・No.1/最上級の根拠欠如等）。
2. facts: 台本中の数値・断定（価格・割合・「売上No.1」等）のうち、上記商品情報で裏付けられないもの。
3. quality: 構成の欠落（オープニング/実演/オファー/CTAのいずれか不足、時間配分の偏り、訴求の重複）。

【台本】
${markdown.slice(0, 12000)}

【出力JSON】
{
  "legal":   [{"severity":"high|med|low","quote":"該当箇所","reason":"理由","citedRule":"根拠法/ガイド","suggestedRewrite":"修正案"}],
  "facts":   [{"severity":"...","quote":"...","reason":"...","citedRule":"","suggestedRewrite":"..."}],
  "quality": [{"severity":"...","quote":"...","reason":"...","citedRule":"","suggestedRewrite":"..."}]
}`;
}

function dedupe(findings: Finding[]): Finding[] {
	const seen = new Set<string>();
	const out: Finding[] = [];
	for (const f of findings) {
		const key = `${f.axis}|${f.quote}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(f);
	}
	return out;
}

function score(legal: Finding[], facts: Finding[], quality: Finding[]): number {
	const weight = (f: Finding) => (f.severity === "high" ? 15 : f.severity === "med" ? 7 : 3);
	const penalty = [...legal, ...facts, ...quality].reduce((s, f) => s + weight(f), 0);
	return Math.max(0, 100 - penalty);
}

export async function checkScreenplay(
	markdown: string,
	brief: ProductBrief,
	rules: ComplianceRule[],
): Promise<ScriptCheckResult> {
	// Deterministic pass (always, even if LLM fails).
	const lexFindings = matchLexicon(markdown, rules, brief.category ?? null);

	// LLM pass (best-effort).
	let llmLegal: Finding[] = [], llmFacts: Finding[] = [], llmQuality: Finding[] = [];
	try {
		const raw = parseJSON<Record<string, unknown[]>>(await callGemini(buildPrompt(markdown, brief, rules)));
		llmLegal = (raw.legal ?? []).map((r) => coerceFinding(r, "legal")).filter(Boolean) as Finding[];
		llmFacts = (raw.facts ?? []).map((r) => coerceFinding(r, "facts")).filter(Boolean) as Finding[];
		llmQuality = (raw.quality ?? []).map((r) => coerceFinding(r, "quality")).filter(Boolean) as Finding[];
	} catch (err) {
		console.warn("[compliance] LLM pass failed (deterministic findings only):", err instanceof Error ? err.message : String(err));
	}

	const legal = dedupe([...lexFindings, ...llmLegal]);
	const facts = dedupe(llmFacts);
	const quality = dedupe(llmQuality);
	return { overallScore: score(legal, facts, quality), legal, facts, quality };
}
