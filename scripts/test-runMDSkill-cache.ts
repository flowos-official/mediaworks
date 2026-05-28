import { runMDSkill } from "@/lib/md-strategy";

const cachedGoal = {
	primary_objective: "test",
	target_channels: [],
	seasonal_keywords: [],
	theme_keywords: [],
	category_hints: [],
	excluded_themes: [],
	intent_tier: "broad" as const,
	channel_scope: [],
	specific_keyword: null,
};

const ctx = {
	userGoal: "テレ東マートで売れる包丁",
	parsedGoal: cachedGoal,
} as any;

async function main() {
	const before = Date.now();
	const out = await runMDSkill("goal_analysis", ctx, {});
	const ms = Date.now() - before;

	if (out !== cachedGoal) throw new Error("expected the cached object to be returned");
	if (ms > 50) throw new Error(`expected near-instant return (no Gemini call), got ${ms}ms`);

	console.log("✓ runMDSkill-cache test passes");
}

main().catch((e) => { console.error(e); process.exit(1); });
