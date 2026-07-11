"use client";
import { useTranslations } from "next-intl";

export type StatusFilter = "all" | "uncategorized" | "sourced" | "interested" | "rejected";
export type SortKey = "score" | "price";

export function DiscoveryFilters({
	status,
	onStatusChange,
	sort,
	onSortChange,
}: {
	status: StatusFilter;
	onStatusChange: (next: StatusFilter) => void;
	sort: SortKey;
	onSortChange: (next: SortKey) => void;
}) {
	const t = useTranslations("discovery");

	const statusOptions: Array<{ value: StatusFilter; label: string }> = [
		{ value: "all", label: t("filterAll") },
		{ value: "uncategorized", label: t("filterUncategorized") },
		{ value: "sourced", label: t("filterSourced") },
		{ value: "interested", label: t("filterInterested") },
		{ value: "rejected", label: t("filterRejected") },
	];

	return (
		<div className="mw-toolbar mb-4">
			<div className="mw-scrollbar flex gap-1 overflow-x-auto">
				{statusOptions.map((opt) => (
					<button
						type="button"
						key={opt.value}
						onClick={() => onStatusChange(opt.value)}
						className={`min-h-8 shrink-0 rounded-lg border px-3 text-xs font-medium transition-colors ${
							status === opt.value
								? "border-primary bg-primary text-primary-foreground"
								: "bg-card text-foreground border-border hover:bg-muted"
						}`}
					>
						{opt.label}
					</button>
				))}
			</div>

			<div className="sm:ml-auto">
				<select
					aria-label={t("sortByScore")}
					value={sort}
					onChange={(e) => onSortChange(e.target.value as SortKey)}
					className="h-9 rounded-lg border border-border bg-background px-3 text-xs"
				>
					<option value="score">{t("sortByScore")}</option>
					<option value="price">{t("sortByPrice")}</option>
				</select>
			</div>
		</div>
	);
}
