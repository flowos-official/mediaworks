"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Database, FileUp, Files } from "lucide-react";
import { ScreenplayCreateForm } from "./ScreenplayCreateForm";
import { ScreenplayImportForm } from "./ScreenplayImportForm";
import {
	ScreenplayProductPicker,
	type ExistingProductOption,
} from "./ScreenplayProductPicker";

type Tab = "product" | "import" | "external";

export function ScreenplayNewTabs({
	locale,
	products,
}: {
	locale: string;
	products: ExistingProductOption[];
}) {
	const t = useTranslations("screenplay");
	const [tab, setTab] = useState<Tab>("product");
	const tabs: { id: Tab; label: string; sub: string; icon: typeof Database }[] = [
		{ id: "product", label: t("tabs.product"), sub: t("tabs.productSub"), icon: Database },
		{ id: "import", label: t("tabs.import"), sub: t("tabs.importSub"), icon: FileUp },
		{ id: "external", label: t("tabs.external"), sub: t("tabs.externalSub"), icon: Files },
	];
	return (
		<div className="space-y-7">
			<div className="grid grid-cols-1 gap-3 md:grid-cols-3" role="tablist" aria-label={t("a11y.createMethod")}>
				{tabs.map((t) => {
					const Icon = t.icon;
					const active = tab === t.id;
					return (
						<button
							type="button"
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

			{tab === "product" && <ScreenplayProductPicker locale={locale} products={products} />}
			{tab === "import" && <ScreenplayImportForm locale={locale} />}
			{tab === "external" && <ScreenplayCreateForm locale={locale} />}
		</div>
	);
}
