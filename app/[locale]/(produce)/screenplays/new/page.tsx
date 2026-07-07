import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ChevronLeft, Clapperboard } from "lucide-react";
import { ScreenplayNewTabs } from "@/components/screenplay/ScreenplayNewTabs";
import { localePath } from "@/lib/i18n/locale-path";

export default async function NewScreenplayPage({ params }: { params: Promise<{ locale: string }> }) {
	const { locale } = await params;
	const t = await getTranslations("screenplay.new");
	return (
		<main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
			<Link
				href={localePath(locale, "/screenplays")}
				className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors mb-8"
			>
				<ChevronLeft size={14} />
				{t("back")}
			</Link>

			<header className="mb-10 relative">
				<div className="flex items-start gap-4">
					<div className="hidden sm:flex w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 items-center justify-center shadow-sm shadow-blue-200/60 ring-1 ring-blue-100">
						<Clapperboard size={20} className="text-white" />
					</div>
					<div className="flex-1 min-w-0">
						<div className="text-[11px] font-semibold tracking-[0.18em] uppercase text-blue-600/80 mb-1">
							Screenplay Studio
						</div>
						<h1 className="text-[2rem] leading-tight font-bold text-foreground tracking-tight">
							{t("title")}
						</h1>
						<p className="text-sm text-muted-foreground mt-2 max-w-2xl leading-relaxed">
							{t("subtitle")}
						</p>
					</div>
				</div>
			</header>

			<ScreenplayNewTabs locale={locale} />
		</main>
	);
}
