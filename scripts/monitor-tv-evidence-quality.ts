/**
 * Quality monitor for the channel-keyed tv_evidence matches added in
 * PR #64 (2026-05-21). For each recent tv_channel candidate with a
 * persisted tv_evidence, compute heuristic indicators of match quality
 * and surface suspect matches for manual review.
 *
 * Heuristics (no ground-truth labels, so these are signals not verdicts):
 *
 *  - brand_only:    All overlapping strong tokens are short Latin words
 *                   that look like brand names. Brand alone isn't enough
 *                   evidence — same brand has many product lines.
 *
 *  - generic_token: The only overlapping token across samples is a
 *                   generic category word like "ピロー", "セット", "美顔器".
 *                   Suggests samples are unrelated products sharing a
 *                   category.
 *
 *  - low_recent:    airing_count > 5 but recent_30d_count = 0. Strong
 *                   historical evidence but the product line may have
 *                   dropped off the schedule.
 *
 *  - good:          ≥2 strong distinctive tokens overlap with sample
 *                   titles (the intended channel-path behavior).
 *
 * Run periodically; output is a CSV-ish stdout report. Tuning the strict
 * matcher in lib/discovery/tv-evidence.ts uses this as feedback.
 */

import "dotenv/config";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { getServiceClient } from "@/lib/supabase";
import type { TvEvidence } from "@/lib/discovery/types";

const LOOKBACK_DAYS = Number(process.env.MONITOR_LOOKBACK_DAYS ?? 7);
const SAMPLE_LIMIT = Number(process.env.MONITOR_SAMPLE_LIMIT ?? 200);

const GENERIC_CATEGORY_TOKENS = new Set([
	"ピロー", "セット", "美顔器", "クリーム", "ジェル", "シート", "マスク",
	"スパッツ", "ベルト", "シェイカー", "ブラシ", "ピン", "ボトル", "セラム",
	"パウダー", "サプリ", "コスメ", "ケア", "シャンプー", "ヘア", "美容",
	"健康", "ダイエット", "シューズ", "コート", "アウター",
]);

interface Row {
	id: string;
	name: string;
	tv_channel_source: string | null;
	tv_evidence: TvEvidence | null;
	created_at: string;
}

function tokenize(text: string): string[] {
	return text
		.normalize("NFKC")
		.split(/[\s・\/／,、|\-【】\[\]＜＞]+/)
		.map((t) => t.trim())
		.filter((t) => t.length >= 3);
}

function isStrong(t: string): boolean {
	return t.length >= 4 || /[a-z0-9]/i.test(t);
}

function isLatinBrand(t: string): boolean {
	// Pure Latin ≤8 chars w/ no digit = likely a brand name token
	return /^[A-Za-z]+$/.test(t) && t.length <= 8;
}

function classify(row: Row): { label: string; reason: string } {
	const ev = row.tv_evidence;
	if (!ev || ev.airing_count === 0) return { label: "no_evidence", reason: "" };

	const candidateTokens = tokenize(row.name).filter(isStrong);
	if (candidateTokens.length === 0) {
		return { label: "no_strong_tokens", reason: "candidate name has no distinctive tokens" };
	}

	// For each sample title, count how many strong candidate tokens appear.
	const sampleStats = ev.samples.map((s) => {
		const titleLow = s.title.normalize("NFKC").toLowerCase();
		const hits = candidateTokens.filter((t) => titleLow.includes(t.toLowerCase()));
		return { title: s.title, hitTokens: hits };
	});

	// Union of tokens that hit in ANY sample
	const everHit = new Set<string>();
	for (const s of sampleStats) for (const t of s.hitTokens) everHit.add(t.toLowerCase());

	// Per-sample: how many also share ≥2 strong tokens (the strict-path criterion)
	const strictPassCount = sampleStats.filter((s) => s.hitTokens.length >= 2).length;

	if (strictPassCount === 0 && sampleStats.length > 0) {
		// Suspicious — evidence exists but no sample passes the strict bar
		// (i.e. the rows that earned the evidence weren't in the random sample window).
		// Inspect for brand-only / generic-only patterns.
		const everHitArr = [...everHit];
		const allLatinBrand = everHitArr.length > 0 && everHitArr.every(isLatinBrand);
		if (allLatinBrand) {
			return {
				label: "brand_only",
				reason: `overlapping tokens are brand-name-only: ${everHitArr.join(",")}`,
			};
		}
		const allGeneric = everHitArr.length > 0 && everHitArr.every((t) =>
			[...GENERIC_CATEGORY_TOKENS].some((g) => t.includes(g.toLowerCase())),
		);
		if (allGeneric) {
			return {
				label: "generic_token",
				reason: `overlapping tokens are generic-category-only: ${everHitArr.join(",")}`,
			};
		}
		return {
			label: "weak_strict_pass",
			reason: `samples don't show strict-pass token overlap (overlap=${everHitArr.join(",")})`,
		};
	}

	if (ev.airing_count > 5 && ev.recent_30d_count === 0) {
		return {
			label: "stale_strong",
			reason: `${ev.airing_count} airings but 0 in last 30 days`,
		};
	}

	return {
		label: "good",
		reason: `${strictPassCount}/${sampleStats.length} samples pass strict 2-token overlap`,
	};
}

async function main() {
	const sb = getServiceClient();
	const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

	const { data, error } = await sb
		.from("discovered_products")
		.select("id, name, tv_channel_source, tv_evidence, created_at")
		.eq("source", "tv_channel")
		.gte("created_at", since)
		.not("tv_evidence", "is", null)
		.order("created_at", { ascending: false })
		.limit(SAMPLE_LIMIT);

	if (error) {
		console.error(error.message);
		process.exit(1);
	}

	const rows = (data ?? []) as Row[];
	console.log(
		`=== tv_evidence quality monitor (last ${LOOKBACK_DAYS}d, ${rows.length} samples) ===\n`,
	);

	const buckets = new Map<string, Row[]>();
	for (const r of rows) {
		const c = classify(r);
		const bucket = buckets.get(c.label) ?? [];
		bucket.push(r);
		buckets.set(c.label, bucket);
		// Also include the reason on the row for printing
		(r as Row & { _reason?: string })._reason = c.reason;
	}

	const order = ["good", "stale_strong", "weak_strict_pass", "generic_token", "brand_only", "no_strong_tokens", "no_evidence"];
	for (const label of order) {
		const items = buckets.get(label);
		if (!items || items.length === 0) continue;
		const pct = ((items.length / rows.length) * 100).toFixed(1);
		console.log(`[${label}] ${items.length}/${rows.length} (${pct}%)`);
		for (const r of items.slice(0, 5)) {
			const ev = r.tv_evidence!;
			const reason = (r as Row & { _reason?: string })._reason ?? "";
			console.log(
				`  • "${r.name.slice(0, 55)}" — airings=${ev.airing_count} (30d=${ev.recent_30d_count})  ${reason}`,
			);
		}
		console.log();
	}

	// Hard summary
	const suspect = (buckets.get("brand_only")?.length ?? 0) +
		(buckets.get("generic_token")?.length ?? 0) +
		(buckets.get("weak_strict_pass")?.length ?? 0);
	const total = rows.length;
	if (total > 0) {
		console.log(
			`\nSUMMARY: ${suspect}/${total} suspect (${((suspect / total) * 100).toFixed(1)}%)`,
		);
		if (suspect / Math.max(1, total) > 0.3) {
			console.log("  ⚠ >30% of matches look suspect — consider tightening matchers");
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
