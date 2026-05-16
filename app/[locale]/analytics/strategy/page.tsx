import { redirect } from "next/navigation";
import { localePath } from "@/lib/i18n/locale-path";

export default async function StrategyIndexPage({
	params,
}: {
	params: Promise<{ locale: string }>;
}) {
	const { locale } = await params;
	redirect(localePath(locale, "/analytics/strategy/expansion"));
}
