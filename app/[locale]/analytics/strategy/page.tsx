import { redirect } from "next/navigation";

export default async function StrategyIndexPage({
	params,
}: {
	params: Promise<{ locale: string }>;
}) {
	const { locale } = await params;
	redirect(`/${locale}/analytics/strategy/expansion`);
}
