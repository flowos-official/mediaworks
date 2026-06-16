"use client";
import { useState } from "react";
import { Sparkles, FileUp } from "lucide-react";
import { ScreenplayCreateForm } from "./ScreenplayCreateForm";
import { ScreenplayImportForm } from "./ScreenplayImportForm";

type Tab = "generate" | "import";

export function ScreenplayNewTabs({ locale }: { locale: string }) {
	const [tab, setTab] = useState<Tab>("generate");
	const tabs: { id: Tab; label: string; sub: string; icon: typeof Sparkles }[] = [
		{ id: "generate", label: "商品資料から生成", sub: "PDF / Excel / 画像 / URL", icon: Sparkles },
		{ id: "import", label: "台本ドラフトを取り込む", sub: "Word (.docx)", icon: FileUp },
	];
	return (
		<div className="space-y-7">
			<div className="grid grid-cols-1 md:grid-cols-2 gap-3" role="tablist" aria-label="作成方法">
				{tabs.map((t) => {
					const Icon = t.icon;
					const active = tab === t.id;
					return (
						<button
							key={t.id}
							role="tab"
							aria-selected={active}
							onClick={() => setTab(t.id)}
							className={[
								"group text-left rounded-2xl border p-5 transition-all",
								active ? "border-blue-500 bg-blue-600/10 ring-4 ring-blue-500/10 shadow-sm" : "border-border bg-card hover:bg-muted",
							].join(" ")}
						>
							<div className="flex items-start gap-3">
								<div className={["w-10 h-10 rounded-xl flex items-center justify-center shrink-0", active ? "bg-blue-600 text-white" : "bg-muted text-muted-foreground"].join(" ")}>
									<Icon size={18} />
								</div>
								<div className="min-w-0">
									<div className="text-sm font-semibold text-foreground">{t.label}</div>
									<div className="text-xs text-muted-foreground mt-1">{t.sub}</div>
								</div>
							</div>
						</button>
					);
				})}
			</div>

			{tab === "generate" ? <ScreenplayCreateForm locale={locale} /> : <ScreenplayImportForm locale={locale} />}
		</div>
	);
}
