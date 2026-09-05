import { redirect } from "next/navigation";
import { getTranslations, getLocale } from "next-intl/server";
import { requireUser } from "@/lib/auth/require-user";
import { localePath } from "@/lib/i18n/locale-path";
import { DataManagementClient } from "@/components/intelligence-imports/DataManagementClient";
import type { ImportBatchRow } from "@/components/intelligence-imports/ImportBatchHistory";

export const dynamic = "force-dynamic";

export default async function DataManagementPage() {
	const locale = await getLocale();
	// member|admin only. A viewer may see import COVERAGE on the readiness
	// dashboard, but not file names, not upload controls, and not the contents
	// of somebody's cost book.
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) redirect(localePath(locale, "/login"));

	const t = await getTranslations("imports");

	// Read as the signed-in user so RLS decides which batches they see. History
	// is secondary to the upload flow: a failing query degrades the panel rather
	// than taking the page down.
	const { data: batches, error } = await auth.sb
		.from("import_batches")
		.select("id, file_name, file_sha256, status, row_counts, created_at, updated_at")
		.order("created_at", { ascending: false })
		.limit(50);
	if (error) console.warn("[data-management] batch history unavailable:", error.message);

	return (
		<main className="mx-auto w-full max-w-5xl space-y-4 p-4">
			<header className="space-y-1">
				<h1 className="text-xl font-semibold">{t("title")}</h1>
				<p className="text-sm text-muted-foreground">{t("subtitle")}</p>
			</header>
			<DataManagementClient initialBatches={(batches ?? []) as ImportBatchRow[]} />
		</main>
	);
}
