"use client";

/**
 * The five axes, each showing where its number came from.
 *
 * An axis renders its STATUS as prominently as its value. A bar at 60% built
 * from airing counts and one built from our own cost book look identical as
 * bars, and letting them look identical is how a proxy quietly becomes a fact
 * in someone's decision. An unknown axis shows no bar at all — a zero-length
 * bar reads as "measured, and low".
 */
import { useTranslations } from "next-intl";
import type { ScoreAxis } from "@/lib/product-finder/types";

const CLASS_STYLE: Record<string, string> = {
	measured: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
	proxy: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
	unknown: "bg-muted text-muted-foreground",
};

export function EvidenceList({ axes }: { axes: ScoreAxis[] }) {
	const t = useTranslations("productFinder");

	return (
		<ul className="space-y-2">
			{axes.map((axis) => {
				const known = axis.status !== "unknown" && axis.normalized !== null;
				return (
					<li key={axis.key} className="flex items-center gap-3 text-sm">
						<span className="w-24 shrink-0 text-muted-foreground">{t(`axis.${axis.key}`)}</span>
						<span
							className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${
								CLASS_STYLE[axis.status] ?? CLASS_STYLE.unknown
							}`}
						>
							{axis.status === "measured"
								? t("class.verified")
								: axis.status === "proxy"
									? t("class.proxy")
									: t("axis.unknown")}
						</span>
						<span className="flex-1">
							{known ? (
								<span className="block h-1.5 w-full overflow-hidden rounded-full bg-muted">
									<span
										className="block h-full rounded-full bg-foreground/70"
										style={{ width: `${Math.round(axis.normalized! * 100)}%` }}
									/>
								</span>
							) : (
								// Deliberately a dash, not an empty bar: nothing was measured,
								// which is not the same as measuring zero.
								<span className="text-xs text-muted-foreground">—</span>
							)}
						</span>
						<span className="w-10 shrink-0 text-right tabular-nums text-xs text-muted-foreground">
							{known ? `${Math.round(axis.normalized! * 100)}` : "—"}
						</span>
					</li>
				);
			})}
		</ul>
	);
}
