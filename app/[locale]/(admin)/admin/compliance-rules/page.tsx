import { redirect } from "next/navigation";
import { getServerClient } from "@/lib/supabase/server";
import { localePath } from "@/lib/i18n/locale-path";
import ComplianceRulesTable from "./ComplianceRulesTable";
import type { ComplianceRule } from "@/lib/screenplay/compliance/types";

export const dynamic = "force-dynamic";

export default async function ComplianceRulesPage(props: { params: Promise<{ locale: string }> }) {
	const { locale } = await props.params;
	const sb = await getServerClient();
	const { data: { user } } = await sb.auth.getUser();
	if (!user) redirect(localePath(locale, "/login"));
	const { data: profile } = await sb.from("profiles").select("role").eq("id", user.id).maybeSingle();
	if (profile?.role !== "admin") redirect(localePath(locale));

	const { data: rules } = await sb
		.from("compliance_rules")
		.select("id,law,category_scope,pattern,is_regex,allowed,severity,reason,safe_rewrite,citation,active")
		.order("law", { ascending: true })
		.order("allowed", { ascending: true })
		.order("created_at", { ascending: true });

	return <ComplianceRulesTable initial={(rules ?? []) as ComplianceRule[]} />;
}
