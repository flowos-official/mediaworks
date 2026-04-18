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
		<div className="flex flex-wrap items-center gap-2 mb-4">
			<div className="flex gap-1">
				{statusOptions.map((opt) => (
					<button
						key={opt.value}
						onClick={() => onStatusChange(opt.value)}
						className={`px-3 py-1 text-xs rounded-full border transition-colors ${
							status === opt.value
								? "bg-blue-600 text-white border-blue-600"
								: "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"
						}`}
					>
						{opt.label}
					</button>
				))}
			</div>

			<div className="ml-auto">
				<select
					value={sort}
					onChange={(e) => onSortChange(e.target.value as SortKey)}
					className="px-3 py-1 text-xs border border-gray-200 rounded bg-white"
				>
					<option value="score">{t("sortByScore")}</option>
					<option value="price">{t("sortByPrice")}</option>
				</select>
			</div>
		</div>
	);
}
