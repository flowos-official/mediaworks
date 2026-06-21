import { redirect } from "next/navigation";
import { DiscoveryTodayClient } from "@/components/discovery/DiscoveryTodayClient";
import { getServerAuth } from "@/lib/auth/server-auth";
import { localePath } from "@/lib/i18n/locale-path";

export const dynamic = "force-dynamic";

export default async function DiscoveryLivePage({
	params,
}: {
	params: Promise<{ locale: string }>;
}) {
	const { locale } = await params;
	const auth = await getServerAuth(["member", "admin"]);
	if (!auth.ok) {
		redirect(auth.reason === "unauthorized" ? localePath(locale, "/login") : localePath(locale));
	}

	return <DiscoveryTodayClient context="live_commerce" canManualTrigger={auth.role === "admin"} />;
}
