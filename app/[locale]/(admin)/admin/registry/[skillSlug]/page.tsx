import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getServiceClient } from "@/lib/supabase";
import { localePath } from "@/lib/i18n/locale-path";

export const dynamic = "force-dynamic";

interface PageProps {
	params: Promise<{ locale: string; skillSlug: string }>;
	searchParams: Promise<{ version?: string }>;
}

interface SkillRow {
	id: string;
	slug: string;
	display_name: string;
	category: string | null;
	active_version_id: string | null;
	created_at: string;
}

interface SkillVersionRow {
	id: string;
	skill_id: string;
	git_sha: string;
	version_label: string;
	prompt_template: string;
	output_schema: Record<string, unknown>;
	model: string;
	provider: string;
	generation_config: Record<string, unknown>;
	validators: unknown[];
	published_by: string;
	published_at: string;
}

const CATEGORY_COLOR: Record<string, string> = {
	analysis: "bg-blue-100 text-blue-700",
	curation: "bg-emerald-100 text-emerald-700",
	planning: "bg-violet-100 text-violet-700",
	enrichment: "bg-amber-100 text-amber-700",
	generation: "bg-pink-100 text-pink-700",
};

function categoryBadge(category: string | null) {
	if (!category) return null;
	return (
		<Badge variant="outline" className={`text-[10px] ${CATEGORY_COLOR[category] ?? ""}`}>
			{category}
		</Badge>
	);
}

function shortSha(sha: string): string {
	return sha.slice(0, 7);
}

function formatDateTime(iso: string): string {
	const d = new Date(iso);
	return d.toISOString().replace("T", " ").slice(0, 16);
}

async function loadSkill(slug: string): Promise<{
	skill: SkillRow;
	versions: SkillVersionRow[];
} | null> {
	const sb = getServiceClient();
	const { data: skill, error } = await sb.from("skills").select("*").eq("slug", slug).maybeSingle();
	if (error || !skill) return null;
	const { data: versions } = await sb
		.from("skill_versions")
		.select("*")
		.eq("skill_id", (skill as SkillRow).id)
		.order("published_at", { ascending: false });
	return {
		skill: skill as SkillRow,
		versions: (versions ?? []) as SkillVersionRow[],
	};
}

export default async function SkillDetailPage({ params, searchParams }: PageProps) {
	const { locale, skillSlug } = await params;
	const { version: versionLabelParam } = await searchParams;
	const t = await getTranslations("admin.registry");

	const data = await loadSkill(skillSlug);
	if (!data) notFound();
	const { skill, versions } = data;

	const activeVersion =
		versions.find((v) => v.id === skill.active_version_id) ?? versions[0];
	const selectedVersion =
		(versionLabelParam && versions.find((v) => v.version_label === versionLabelParam && v.id !== activeVersion?.id))
			|| activeVersion;

	return (
		<>
			<div className="mb-4 text-xs text-gray-500">
				<Link href={localePath(locale, "/admin/registry")} className="hover:text-blue-600">
					{t("backToList")}
				</Link>
			</div>

			<header className="mb-6">
				<div className="flex flex-wrap items-baseline gap-3">
					<h1 className="font-mono text-2xl font-semibold text-gray-900">{skill.slug}</h1>
					<span className="text-base text-gray-500">{skill.display_name}</span>
					{categoryBadge(skill.category)}
				</div>
				<p className="mt-1 text-[11px] text-gray-400">
					created {formatDateTime(skill.created_at)} · {versions.length} version
					{versions.length === 1 ? "" : "s"} published
				</p>
			</header>

			{/* Version timeline */}
			<Card className="mb-6">
				<CardHeader className="pb-2">
					<CardTitle className="text-sm font-semibold">Versions</CardTitle>
				</CardHeader>
				<CardContent className="overflow-x-auto p-0">
					<table className="w-full text-sm">
						<thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
							<tr>
								<th className="px-4 py-2 text-left">Version</th>
								<th className="px-4 py-2 text-left">Git SHA</th>
								<th className="px-4 py-2 text-left">Model · Provider</th>
								<th className="px-4 py-2 text-left">Published</th>
								<th className="px-4 py-2 text-left">By</th>
								<th className="px-4 py-2 text-right">Validators</th>
								<th className="px-4 py-2"></th>
							</tr>
						</thead>
						<tbody>
							{versions.map((v) => {
								const isActive = v.id === skill.active_version_id;
								const isSelected = v.id === selectedVersion?.id;
								return (
									<tr
										key={v.id}
										className={`border-t border-gray-100 ${
											isSelected ? "bg-blue-50/40" : "hover:bg-gray-50"
										}`}
									>
										<td className="px-4 py-2">
											<span className="inline-flex items-center gap-1.5">
												<span className="font-mono text-[11px]">{v.version_label}</span>
												{isActive && (
													<Badge className="bg-green-100 text-[9px] text-green-700">active</Badge>
												)}
											</span>
										</td>
										<td className="px-4 py-2 font-mono text-[10px] text-gray-500">
											{shortSha(v.git_sha)}
										</td>
										<td className="px-4 py-2 font-mono text-[11px] text-gray-700">
											{v.model}{" "}
											<span className="text-gray-400">· {v.provider}</span>
										</td>
										<td className="px-4 py-2 font-mono text-[10px] text-gray-500">
											{formatDateTime(v.published_at)}
										</td>
										<td className="px-4 py-2 font-mono text-[10px] text-gray-500">{v.published_by}</td>
										<td className="px-4 py-2 text-right text-[11px] text-gray-500">
											{Array.isArray(v.validators) ? v.validators.length : 0}
										</td>
										<td className="px-4 py-2 text-right">
											<Link
												href={localePath(locale, `/admin/registry/${skill.slug}?version=${v.version_label}`)}
												className="text-[10px] text-blue-600 hover:underline"
											>
												view ↓
											</Link>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</CardContent>
			</Card>

			{selectedVersion && (
				<>
					<div className="mb-3 text-xs text-gray-500">
						Showing <span className="font-mono">{selectedVersion.version_label}</span> ·{" "}
						{shortSha(selectedVersion.git_sha)}
					</div>

					{/* Prompt source */}
					<Card className="mb-4">
						<CardHeader className="pb-2">
							<CardTitle className="text-sm font-semibold">Prompt Source</CardTitle>
							<p className="text-[10px] text-gray-400">
								Captured via{" "}
								<code className="rounded bg-gray-100 px-1">Function.prototype.toString()</code> at
								publish time.
							</p>
						</CardHeader>
						<CardContent>
							<pre className="max-h-[480px] overflow-auto rounded bg-gray-900 p-3 font-mono text-[11px] leading-relaxed text-gray-100">
								{selectedVersion.prompt_template}
							</pre>
						</CardContent>
					</Card>

					{/* Output schema */}
					<Card className="mb-4">
						<CardHeader className="pb-2">
							<CardTitle className="text-sm font-semibold">Output Schema</CardTitle>
							<p className="text-[10px] text-gray-400">
								JSON Schema converted from the v1 Zod schema at publish time.
							</p>
						</CardHeader>
						<CardContent>
							<pre className="max-h-[360px] overflow-auto rounded bg-gray-50 p-3 font-mono text-[11px] text-gray-800">
								{JSON.stringify(selectedVersion.output_schema, null, 2)}
							</pre>
						</CardContent>
					</Card>

					{/* Generation config + validators */}
					<Card>
						<CardHeader className="pb-2">
							<CardTitle className="text-sm font-semibold">Metadata</CardTitle>
						</CardHeader>
						<CardContent>
							<dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
								<MetaPair label="Model" value={selectedVersion.model} mono />
								<MetaPair label="Provider" value={selectedVersion.provider} mono />
								<div className="md:col-span-2">
									<dt className="text-[10px] uppercase tracking-wide text-gray-500">
										Generation Config
									</dt>
									<dd className="mt-1">
										<pre className="overflow-auto rounded bg-gray-50 p-2 font-mono text-[11px] text-gray-800">
											{JSON.stringify(selectedVersion.generation_config, null, 2)}
										</pre>
									</dd>
								</div>
								<div className="md:col-span-2">
									<dt className="text-[10px] uppercase tracking-wide text-gray-500">Validators</dt>
									<dd className="mt-1">
										{Array.isArray(selectedVersion.validators) &&
										selectedVersion.validators.length > 0 ? (
											<ul className="space-y-1 text-xs">
												{selectedVersion.validators.map((v, i) => (
													<li key={i} className="font-mono text-gray-700">
														{typeof v === "string" ? v : JSON.stringify(v)}
													</li>
												))}
											</ul>
										) : (
											<p className="text-[11px] text-gray-400">
												(none — Phase A will populate deterministic post-validators)
											</p>
										)}
									</dd>
								</div>
							</dl>
						</CardContent>
					</Card>
				</>
			)}
		</>
	);
}

function MetaPair({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
	return (
		<div>
			<dt className="text-[10px] uppercase tracking-wide text-gray-500">{label}</dt>
			<dd className={`mt-0.5 text-sm text-gray-900 ${mono ? "font-mono" : ""}`}>{value}</dd>
		</div>
	);
}
