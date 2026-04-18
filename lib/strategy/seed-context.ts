/**
 * Seed product context — loads a discovered product's B+C package and
 * formats it for Gemini prompt injection.
 * Ref: spec §3.
 */

import { getServiceClient } from "@/lib/supabase";

export interface SeedContext {
	id: string;
	name: string;
	priceJpy: number | null;
	category: string | null;
	reviewCount: number | null;
	reviewAvg: number | null;
	sellerName: string | null;
	productUrl: string;
	tvFitScore: number;
	tvFitReason: string | null;
	context: "home_shopping" | "live_commerce";
	broadcastTag: "broadcast_confirmed" | "broadcast_likely" | "unknown" | null;

	enriched?: {
		manufacturer: {
			name: string | null;
			official_site: string | null;
			address: string | null;
			contact_hints: string[];
			confidence: "high" | "medium" | "low";
		};
		wholesale: {
			estimated_cost_jpy: number | null;
			estimated_margin_rate: number | null;
			method: string;
			confidence: "high" | "medium" | "low";
		};
		moqHint: string | null;
		tvScriptDraft: string;
		snsTrend: { signal_strength: string; sources: string[] };
	};
}

/**
 * Load a seed product from discovered_products. Parses c_package if
 * enrichment is completed.
 */
export async function loadSeedContext(
	seedProductId: string,
): Promise<SeedContext | null> {
	const sb = getServiceClient();
	const { data, error } = await sb
		.from("discovered_products")
		.select(
			"id, name, price_jpy, category, review_count, review_avg, seller_name, product_url, tv_fit_score, tv_fit_reason, context, broadcast_tag, c_package, enrichment_status",
		)
		.eq("id", seedProductId)
		.maybeSingle();

	if (error || !data) {
		console.warn(
			`[seed-context] load failed for ${seedProductId}:`,
			error?.message ?? "not found",
		);
		return null;
	}

	const row = data as Record<string, unknown>;
	const base: SeedContext = {
		id: String(row.id),
		name: String(row.name),
		priceJpy: row.price_jpy as number | null,
		category: row.category as string | null,
		reviewCount: row.review_count as number | null,
		reviewAvg: row.review_avg as number | null,
		sellerName: row.seller_name as string | null,
		productUrl: String(row.product_url),
		tvFitScore: Number(row.tv_fit_score ?? 0),
		tvFitReason: row.tv_fit_reason as string | null,
		context: row.context as SeedContext["context"],
		broadcastTag: row.broadcast_tag as SeedContext["broadcastTag"],
	};

	if (row.enrichment_status === "completed" && row.c_package) {
		try {
			const pkg = row.c_package as Record<string, unknown>;
			base.enriched = {
				manufacturer: pkg.manufacturer as NonNullable<SeedContext["enriched"]>["manufacturer"],
				wholesale:
					pkg.wholesale_estimate as NonNullable<SeedContext["enriched"]>["wholesale"],
				moqHint: (pkg.moq_hint as string | null) ?? null,
				tvScriptDraft: String(pkg.tv_script_draft ?? ""),
				snsTrend: pkg.sns_trend as NonNullable<SeedContext["enriched"]>["snsTrend"],
			};
		} catch (err) {
			console.warn(
				`[seed-context] c_package parse failed for ${seedProductId}:`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	return base;
}

/**
 * Format a SeedContext into Japanese markdown for Gemini prompt injection.
 * If passed null, returns empty string.
 */
export function formatSeedPromptSection(seed: SeedContext | null): string {
	if (!seed) return "";

	const contextLabel =
		seed.context === "home_shopping" ? "ホームショッピング" : "ライブコマース";
	const broadcastLabel =
		seed.broadcastTag === "broadcast_confirmed"
			? "放送確認済み"
			: seed.broadcastTag === "broadcast_likely"
			? "放送の可能性あり"
			: "情報なし";

	const basics = [
		`- 商品名: ${seed.name}`,
		`- 価格: ${seed.priceJpy ? `¥${seed.priceJpy.toLocaleString()}` : "不明"}`,
		`- Rakuten評価: ${seed.reviewAvg ? `★${seed.reviewAvg} (${seed.reviewCount ?? 0}件)` : "レビューなし"}`,
		`- 販売者: ${seed.sellerName ?? "不明"}`,
		`- カテゴリ: ${seed.category ?? "未分類"}`,
		`- TVフィットスコア: ${seed.tvFitScore}/100`,
		`- TVフィット理由: ${seed.tvFitReason ?? "なし"}`,
		`- 競合放送状況: ${broadcastLabel}`,
		`- 対象チャネル: ${contextLabel}`,
		`- 商品URL: ${seed.productUrl}`,
	].join("\n");

	let enrichedSection = "\n【深掘り情報】\n- 未実行 — 製造元・卸値・TVスクリプト等のデータなし";
	if (seed.enriched) {
		const m = seed.enriched.manufacturer;
		const w = seed.enriched.wholesale;
		const s = seed.enriched.snsTrend;
		const mfg = m.name ? `${m.name} (信頼度:${m.confidence})` : "不明";
		const ws =
			w.estimated_cost_jpy !== null
				? `¥${w.estimated_cost_jpy.toLocaleString()} (マージン${Math.round((w.estimated_margin_rate ?? 0) * 100)}%, 方法:${w.method}, 信頼度:${w.confidence})`
				: "推定不可";
		const script = seed.enriched.tvScriptDraft
			? seed.enriched.tvScriptDraft.slice(0, 400)
			: "なし";
		enrichedSection = `\n【深掘り情報】\n- 製造元: ${mfg}\n- 公式サイト: ${m.official_site ?? "なし"}\n- 住所: ${m.address ?? "不明"}\n- 連絡先ヒント: ${m.contact_hints.length > 0 ? m.contact_hints.join(", ") : "なし"}\n- 卸値推定: ${ws}\n- MOQ情報: ${seed.enriched.moqHint ?? "なし"}\n- 既存TVスクリプト案:\n  ${script}\n- SNSトレンド: ${s.signal_strength}${s.sources.length > 0 ? ` (${s.sources.join(", ")})` : ""}`;
	}

	return `\n【新商品候補データ — 分析対象】\n${basics}\n${enrichedSection}\n\n【分析ガイダンス】\n各スキルは上記の「新商品候補データ」を中心に具体的な戦略を生成してください。\nproduct_summaries (既存MediaWorks実績) は「過去のカテゴリ成功パターン」の参考材料として使用してください。\n`;
}
