import { redirect } from "next/navigation";

export default async function DiscoveryIndexPage({
	params,
}: {
	params: Promise<{ locale: string }>;
}) {
	const { locale } = await params;
	redirect(`/${locale}/analytics/discovery/home`);
}
