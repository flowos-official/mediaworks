/**
 * Unit test for the revision-plan engine. buildRevisionPlan + fallback are pure
 * (LLM injected as a fake). composeRefineFeedback is pure. No DB / no network.
 * Run: npm run test:screenplay-revision-plan
 */
import assert from "node:assert";
import {
	buildRevisionPlan,
	fallbackPlan,
	composeRefineFeedback,
	type RevisionPlanItem,
} from "../lib/screenplay/revision-plan";
import type { Finding, ScriptCheckResult } from "../lib/screenplay/compliance/types";
import type { ProductBrief } from "../lib/screenplay/types";

const brief: ProductBrief = { name: "テスト枕", description: "快眠まくら", category: "枕" };

const finding = (o: Partial<Finding>): Finding => ({
	axis: "legal", severity: "high", quote: "", reason: "", citedRule: "",
	suggestedRewrite: "", source: "llm", ...o,
});
const check = (legal: Finding[], facts: Finding[], quality: Finding[]): ScriptCheckResult => ({
	overallScore: 62, legal, facts, quality,
});

async function main() {
	// 1. Valid LLM JSON is used verbatim (after coercion).
	const fakeLLM: (p: string) => Promise<string> = async () =>
		JSON.stringify({ items: [
			{ axis: "legal", severity: "high", target: "業界No.1", instruction: "根拠不明のため削除" },
			{ axis: "quality", severity: "med", target: "", instruction: "実演デモを終盤へ移動" },
		] });
	const p1 = await buildRevisionPlan(
		"本日は業界No.1の枕。", brief,
		check([finding({ quote: "業界No.1", suggestedRewrite: "削除" })], [], [finding({ axis: "quality", severity: "med", reason: "CTA不足" })]),
		fakeLLM,
	);
	assert.equal(p1.items.length, 2, "p1 length");
	assert.equal(p1.items[0].axis, "legal");
	assert.equal(p1.items[1].instruction, "実演デモを終盤へ移動");

	// 2. Code-fence / prose-wrapped JSON still parses.
	const fencedLLM: (p: string) => Promise<string> = async () =>
		"ここが方針です:\n```json\n" + JSON.stringify({ items: [{ axis: "facts", severity: "low", target: "売上3億", instruction: "表現を緩和" }] }) + "\n```";
	const p2 = await buildRevisionPlan("台本", brief, check([], [finding({ axis: "facts" })], []), fencedLLM);
	assert.equal(p2.items.length, 1, "p2 length");
	assert.equal(p2.items[0].axis, "facts");

	// 3. Items with empty instruction AND empty target are dropped.
	const dirtyLLM: (p: string) => Promise<string> = async () =>
		JSON.stringify({ items: [ { axis: "legal", severity: "high", target: "", instruction: "" }, { axis: "legal", severity: "high", target: "x", instruction: "直す" } ] });
	const p3 = await buildRevisionPlan("台本 x", brief, check([finding({})], [], []), dirtyLLM);
	assert.equal(p3.items.length, 1, "p3 drops empty item");

	// 4. LLM throw → deterministic fallback from findings, NO axis prefix.
	const throwLLM: (p: string) => Promise<string> = async () => { throw new Error("boom"); };
	const p4 = await buildRevisionPlan("台本", brief, check([finding({ quote: "必ず痩せる", suggestedRewrite: "薬機法配慮で緩和" })], [], []), throwLLM);
	assert.equal(p4.items.length, 1, "p4 fallback length");
	assert.equal(p4.items[0].instruction, "薬機法配慮で緩和");
	assert.ok(!p4.items[0].instruction.startsWith("["), "fallback instruction has no axis prefix");

	// 5. LLM returns empty items → fallback; empty suggestedRewrite → reason.
	const emptyLLM: (p: string) => Promise<string> = async () => JSON.stringify({ items: [] });
	const p5 = await buildRevisionPlan("台本", brief, check([finding({ quote: "q", reason: "r" })], [], []), emptyLLM);
	assert.equal(p5.items.length, 1, "p5 fallback on empty");
	assert.equal(p5.items[0].instruction, "r");

	// 6. Zero findings → empty plan, LLM never consulted.
	const p6 = await buildRevisionPlan("台本", brief, check([], [], []), throwLLM);
	assert.equal(p6.items.length, 0, "p6 empty plan");

	// fallbackPlan direct
	const fb = fallbackPlan(check([finding({ quote: "a", suggestedRewrite: "b" })], [], []));
	assert.equal(fb.items[0].target, "a");
	assert.equal(fb.items[0].instruction, "b");

	await composeTests();

	console.log("revision-plan buildRevisionPlan/fallback: OK");
}

async function composeTests() {
	const md = "本日は業界No.1の枕をご紹介。売上3億の実績。";

	// verbatim target → 「…」→ ; non-verbatim target → instruction only
	const r1 = composeRefineFeedback(
		[
			{ axis: "legal", severity: "high", target: "業界No.1", instruction: "削除" },
			{ axis: "quality", severity: "med", target: "", instruction: "実演デモを終盤へ移動" },
		],
		"テンポを速く", md,
	);
	assert.ok(r1.feedback.includes("【考査結果に基づく修正方針】"), "r1 has plan header");
	assert.ok(r1.feedback.includes("[法規] 「業界No.1」→ 削除"), "r1 verbatim legal item");
	assert.ok(r1.feedback.includes("[構成] 実演デモを終盤へ移動"), "r1 structural item, no quote wrap");
	assert.ok(!r1.feedback.includes("「実演デモを終盤へ移動」"), "r1 structural not quote-wrapped");
	assert.ok(r1.feedback.includes("【追加のご要望】") && r1.feedback.includes("テンポを速く"), "r1 free feedback appended");
	assert.equal(r1.trimmedCount, 0, "r1 no trim");

	// non-verbatim target (absent from md) → instruction only
	const r2 = composeRefineFeedback([{ axis: "facts", severity: "low", target: "存在しない語", instruction: "緩和" }], "", md);
	assert.ok(r2.feedback.includes("[事実] 緩和"), "r2 instruction only");
	assert.ok(!r2.feedback.includes("「存在しない語」"), "r2 no quote for absent target");

	// 4000-char cap: high-severity kept, low trimmed, free feedback preserved
	const bigLow = (i: number): RevisionPlanItem => ({ axis: "quality", severity: "low", target: "", instruction: `低${i}`.padEnd(500, "あ") });
	const many: RevisionPlanItem[] = [
		...Array.from({ length: 8 }, (_, i) => bigLow(i)),
		{ axis: "legal", severity: "high", target: "", instruction: "重要削除99" },
	];
	const r3 = composeRefineFeedback(many, "自由入力メモ", md);
	assert.ok(r3.feedback.length <= 4000, "r3 within cap");
	assert.ok(r3.feedback.includes("自由入力メモ"), "r3 free feedback preserved");
	assert.ok(r3.feedback.includes("重要削除99"), "r3 high-severity item kept");
	assert.ok(r3.trimmedCount > 0, "r3 some items trimmed");

	// no items → free feedback only, no plan header
	const r4 = composeRefineFeedback([], "自由だけ", md);
	assert.equal(r4.feedback, "自由だけ", "r4 free-only");
	assert.equal(r4.includedCount, 0, "r4 no items");

	console.log("revision-plan composeRefineFeedback: OK");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
