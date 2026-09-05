"use client";

/**
 * One ranked product, with its evidence and the operator's decision.
 *
 * Unknown profitability is printed as 判断資料不足 / 판단 자료 부족 rather than
 * as ¥0 or a blank. A blank invites the reader to supply their own guess; a
 * zero states a measurement nobody made.
 *
 * The screenplay affordance posts the canonical product id and the stored
 * brief to /api/screenplays and navigates to the new screenplay. It is a
 * deliberate click, never automatic: a recommendation being produced is not a
 * decision to build a broadcast around it, and generating one per ranked item
 * would spend a model call on every row nobody looked at.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { ProductFinderItem } from "@/lib/product-finder/types";
import { EvidenceList } from "./EvidenceList";

export type DecisionValue = "interested" | "excluded";

export function ProductFinderResultCard({
	item,
	runId,
	onDecision,
}: {
	item: ProductFinderItem;
	runId: string;
	onDecision?: (itemId: string, decision: DecisionValue) => void;
}) {
	const t = useTranslations("productFinder");
	const router = useRouter();
	const locale = useLocale();
	const [decision, setDecision] = useState<DecisionValue | null>(null);
	const [pending, setPending] = useState(false);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function createScreenplay() {
		setCreating(true);
		setError(null);
		try {
			const res = await fetch("/api/screenplays", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					canonicalProductId: item.canonicalProductId,
					productBrief: {
						name: item.name,
						description: item.name,
						...(item.category ? { category: item.category } : {}),
					},
				}),
			});
			const payload = (await res.json()) as { id?: string; error?: string };
			if (!res.ok || !payload.id) throw new Error(payload.error ?? String(res.status));
			// Locale-prefixed: proxy.ts rewrites an unprefixed path, and landing on
			// the default locale would silently switch the operator's language.
			router.push(`/${locale}/screenplays/${payload.id}`);
		} catch {
			setError(t("actions.screenplayFailed"));
			setCreating(false);
		}
	}

	async function record(value: DecisionValue) {
		let reason: string | undefined;
		if (value === "excluded") {
			// Exclusion asks for a reason: an unexplained exclusion is invisible
			// to the next person looking at the same product.
			const entered = window.prompt(t("actions.excludeReason"));
			if (entered === null) return;
			reason = entered.trim() || undefined;
		}
		setPending(true);
		setError(null);
		try {
			const res = await fetch(
				`/api/product-finder/runs/${runId}/items/${item.id}/decision`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ decision: value, ...(reason ? { reason } : {}) }),
				},
			);
			if (!res.ok) throw new Error(String(res.status));
			setDecision(value);
			onDecision?.(item.id, value);
		} catch {
			setError(t("actions.failed"));
		} finally {
			setPending(false);
		}
	}

	return (
		<article className="rounded-lg border bg-card p-4 space-y-3">
			<header className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-xs text-muted-foreground">{t("result.rank", { rank: item.rank })}</p>
					<h3 className="truncate font-medium">{item.name}</h3>
					{item.category ? (
						<p className="text-xs text-muted-foreground">{item.category}</p>
					) : null}
				</div>
				<div className="shrink-0 text-right">
					<p className="text-xs text-muted-foreground">{t("result.opportunity")}</p>
					<p className="text-lg font-semibold tabular-nums">
						{Math.round(item.opportunityIndex * 100)}
					</p>
				</div>
			</header>

			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
				<span className="text-muted-foreground">{t("result.profit")}:</span>
				{item.expectedContributionProfitJpy === null ? (
					<span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
						{t("result.profitUnknown")}
					</span>
				) : (
					<span className="tabular-nums font-medium">
						¥{item.expectedContributionProfitJpy.toLocaleString("ja-JP")}
					</span>
				)}
				<span className="text-muted-foreground">{t("result.confidence")}:</span>
				<span>{t(`confidenceLevel.${item.confidence.level}`)}</span>
				<span className="text-xs text-muted-foreground">
					{t("result.coverage", { percent: Math.round(item.confidence.coverage * 100) })}
				</span>
			</div>

			<EvidenceList axes={item.axes} />

			{item.reasons.length > 0 ? (
				<section>
					<h4 className="text-xs font-medium text-muted-foreground">{t("result.reasons")}</h4>
					<ul className="list-disc pl-4 text-sm">
						{item.reasons.map((reason) => (
							<li key={reason}>{reason}</li>
						))}
					</ul>
				</section>
			) : null}

			{item.risks.length > 0 ? (
				<section>
					<h4 className="text-xs font-medium text-muted-foreground">{t("result.risks")}</h4>
					<ul className="list-disc pl-4 text-sm text-amber-700 dark:text-amber-300">
						{item.risks.map((risk) => (
							<li key={risk}>{risk}</li>
						))}
					</ul>
				</section>
			) : null}

			{item.missingData.length > 0 ? (
				<section>
					<h4 className="text-xs font-medium text-muted-foreground">{t("result.missing")}</h4>
					<ul className="list-disc pl-4 text-sm text-muted-foreground">
						{item.missingData.map((missing) => (
							<li key={missing}>{missing}</li>
						))}
					</ul>
				</section>
			) : null}

			<footer className="flex flex-wrap items-center gap-2 pt-1">
				<button
					type="button"
					disabled={pending}
					onClick={() => record("interested")}
					className={`rounded border px-2.5 py-1 text-sm ${
						decision === "interested" ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950" : ""
					}`}
				>
					{t("actions.interested")}
				</button>
				<button
					type="button"
					disabled={pending}
					onClick={() => record("excluded")}
					className={`rounded border px-2.5 py-1 text-sm ${
						decision === "excluded" ? "border-red-500 bg-red-50 dark:bg-red-950" : ""
					}`}
				>
					{t("actions.excluded")}
				</button>
				<button
					type="button"
					disabled={creating}
					onClick={() => void createScreenplay()}
					className="rounded border px-2.5 py-1 text-sm disabled:opacity-50"
				>
					{creating ? t("actions.screenplayPending") : t("actions.screenplay")}
				</button>
				{error ? <span className="text-xs text-red-600">{error}</span> : null}
			</footer>
		</article>
	);
}
