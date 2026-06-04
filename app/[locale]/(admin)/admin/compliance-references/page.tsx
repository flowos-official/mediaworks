import { redirect } from "next/navigation";
import { getServerClient } from "@/lib/supabase/server";
import { localePath } from "@/lib/i18n/locale-path";
import ComplianceReferencesTable from "./ComplianceReferencesTable";
import type { ComplianceReference } from "@/lib/screenplay/compliance/types";

export const dynamic = "force-dynamic";

export default async function ComplianceReferencesPage(props: { params: Promise<{ locale: string }> }) {
	const { locale } = await props.params;
	const sb = await getServerClient();
	const { data: { user } } = await sb.auth.getUser();
	if (!user) redirect(localePath(locale, "/login"));
	const { data: profile } = await sb.from("profiles").select("role").eq("id", user.id).maybeSingle();
	if (profile?.role !== "admin") redirect(localePath(locale));

	const { data: references } = await sb
		.from("compliance_references")
		.select("id,law,category_scope,topic,body,keywords,citation,source_url,active")
		.order("law", { ascending: true })
		.order("topic", { ascending: true });

	return <ComplianceReferencesTable initial={(references ?? []) as ComplianceReference[]} />;
}
