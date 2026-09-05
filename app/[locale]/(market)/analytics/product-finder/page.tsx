import { redirect } from "next/navigation";
import { getTranslations, getLocale } from "next-intl/server";
import { requireUser } from "@/lib/auth/require-user";
import { localePath } from "@/lib/i18n/locale-path";
import { ProductFinderClient } from "@/components/product-finder/ProductFinderClient";

export const dynamic = "force-dynamic";

export default async function ProductFinderPage() {
	const locale = await getLocale();
	// A Page must redirect rather than return auth.error: that value is a
	// NextResponse, which Next.js's Page build check rejects.
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) redirect(localePath(locale, "/login"));

	const t = await getTranslations("productFinder");

	return (
		<main className="mx-auto w-full max-w-4xl space-y-4 p-4">
			<header className="space-y-1">
				<h1 className="text-xl font-semibold">{t("title")}</h1>
				<p className="text-sm text-muted-foreground">{t("subtitle")}</p>
			</header>
			<ProductFinderClient />
		</main>
	);
}
