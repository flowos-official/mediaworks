"use client";
import { useTranslations } from "next-intl";
import { Check, FileText } from "lucide-react";
import type { ScreenplayVersionRow } from "@/lib/screenplay/types";

interface Props {
	versions: Pick<ScreenplayVersionRow, "id" | "version_number" | "feedback" | "created_at">[];
	selectedId: string | null;
	onSelect: (id: string) => void;
}

function useRelative(): (iso: string) => string {
	const t = useTranslations("screenplay.workspace");
	return (iso: string) => {
		const time = new Date(iso).getTime();
		const diff = (Date.now() - time) / 1000;
		if (diff < 60) return t("justNow");
		if (diff < 3600) return t("minutesAgo", { n: Math.floor(diff / 60) });
		if (diff < 86400) return t("hoursAgo", { n: Math.floor(diff / 3600) });
		return t("daysAgo", { n: Math.floor(diff / 86400) });
	};
}

export function VersionTimeline({ versions, selectedId, onSelect }: Props) {
	const t = useTranslations("screenplay.workspace");
	const relative = useRelative();
	const ordered = [...versions].reverse();
	return (
		<ol className="space-y-2">
			{ordered.map((v) => {
				const active = v.id === selectedId;
				return (
					<li key={v.id}>
						<button
							type="button"
							onClick={() => onSelect(v.id)}
							className={`w-full text-left flex items-start gap-3 p-3 rounded-xl border transition-all ${
								active
									? "border-blue-400 bg-blue-600/10 ring-2 ring-blue-500/20"
									: "border-border hover:border-blue-200 hover:bg-muted"
							}`}
						>
							<div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${active ? "bg-blue-600 text-white" : "bg-blue-600/10 text-blue-600"}`}>
								{active ? <Check size={16} /> : <FileText size={16} />}
							</div>
							<div className="flex-1 min-w-0">
								<div className="flex items-baseline justify-between gap-2">
									<span className="text-sm font-semibold text-foreground">第 {v.version_number} 稿</span>
									<span className="text-[11px] text-muted-foreground">{relative(v.created_at)}</span>
								</div>
								<div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
									{v.feedback ? `「${v.feedback}」` : t("firstGeneration")}
								</div>
							</div>
						</button>
					</li>
				);
			})}
		</ol>
	);
}
