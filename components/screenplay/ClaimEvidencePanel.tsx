"use client";

/**
 * Every factual statement in the script, and what backs it.
 *
 * needs_review is listed FIRST and counted at the top. The panel exists so an
 * operator can find the ungrounded claim before broadcast, and a list sorted
 * by line number buries it among thirty checked ones.
 */
import { useTranslations } from "next-intl";
import type { ScreenplayClaimLinkRow } from "@/lib/screenplay/types";

const STATUS_TONE: Record<ScreenplayClaimLinkRow["status"], string> = {
	supported: "bg-emerald-600/10 text-emerald-700 dark:text-emerald-300",
	source_claim: "bg-amber-600/10 text-amber-700 dark:text-amber-300",
	needs_review: "bg-red-600/10 text-red-700 dark:text-red-300",
};

const STATUS_ORDER: Record<ScreenplayClaimLinkRow["status"], number> = {
	needs_review: 0,
	source_claim: 1,
	supported: 2,
};

export function ClaimEvidencePanel({
	claimLinks,
	hasContext,
	onJumpToLine,
}: {
	claimLinks: ScreenplayClaimLinkRow[];
	hasContext: boolean;
	onJumpToLine: (line: number) => void;
}) {
	const t = useTranslations("screenplay.claims");

	// A version generated before grounding existed has no links, and that is
	// not the same fact as "every claim checked out".
	if (claimLinks.length === 0) {
		return (
			<p className="rounded-lg border border-dashed border-border px-3 py-4 text-[11px] leading-relaxed text-muted-foreground">
				{hasContext ? t("none") : t("unavailable")}
			</p>
		);
	}

	const sorted = [...claimLinks].sort(
		(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.line_start - b.line_start,
	);
	const needsReview = claimLinks.filter((c) => c.status === "needs_review").length;

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between px-1">
				<span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
					{t("title")}
				</span>
				<span
					className={`font-mono text-[10px] ${needsReview > 0 ? "text-red-600" : "text-muted-foreground"}`}
				>
					{t("needsReviewCount", { count: needsReview })}
				</span>
			</div>
			<ul className="space-y-1.5">
				{sorted.map((claim) => (
					<li key={claim.id}>
						<button
							type="button"
							onClick={() => onJumpToLine(claim.line_start)}
							className="w-full rounded-lg border border-border bg-background p-2.5 text-left transition hover:bg-blue-600/[0.07]"
						>
							<div className="flex items-center justify-between gap-2">
								<span className="font-mono text-[10px] tabular-nums text-blue-600">
									L{claim.line_start}
									{claim.line_end !== claim.line_start ? `–${claim.line_end}` : ""}
								</span>
								<span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_TONE[claim.status]}`}>
									{t(`status.${claim.status}`)}
								</span>
							</div>
							<p className="mt-1 line-clamp-2 text-[11px] leading-snug text-foreground">
								{claim.claim_text}
							</p>
							<p className="mt-1 text-[10px] leading-snug text-muted-foreground">{claim.reason}</p>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}
