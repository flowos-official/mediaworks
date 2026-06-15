import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

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
	model: string;
	provider: string;
	published_by: string;
	published_at: string;
}

interface SkillVersionCountRow {
	skill_id: string;
	count: number;
}

const CATEGORY_COLOR: Record<string, string> = {
	analysis: "bg-blue-600/15 text-blue-700 dark:text-blue-300",
	curation: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-300",
	planning: "bg-violet-600/15 text-violet-700 dark:text-violet-300",
	enrichment: "bg-amber-600/15 text-amber-700 dark:text-amber-300",
	generation: "bg-pink-600/15 text-pink-700 dark:text-pink-300",
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

function formatDate(iso: string): string {
	const d = new Date(iso);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function loadData(): Promise<{
	skills: SkillRow[];
	versionsBySkill: Map<string, SkillVersionRow>;
	versionCountBySkill: Map<string, number>;
}> {
	const sb = getServiceClient();

	const [{ data: skills }, { data: versions }] = await Promise.all([
		sb.from("skills").select("*").order("slug"),
		sb.from("skill_versions").select("*"),
	]);

	const versionsBySkill = new Map<string, SkillVersionRow>();
	const versionCountBySkill = new Map<string, number>();

	for (const v of (versions ?? []) as SkillVersionRow[]) {
		versionCountBySkill.set(v.skill_id, (versionCountBySkill.get(v.skill_id) ?? 0) + 1);
	}

	const activeIds = new Set(
		(skills ?? []).map((s) => (s as SkillRow).active_version_id).filter((id): id is string => !!id),
	);
	for (const v of (versions ?? []) as SkillVersionRow[]) {
		if (activeIds.has(v.id)) versionsBySkill.set(v.skill_id, v);
	}

	return {
		skills: (skills ?? []) as SkillRow[],
		versionsBySkill,
		versionCountBySkill,
	};
}

export default async function RegistryListPage() {
	const t = await getTranslations("admin.registry");
	const { skills, versionsBySkill, versionCountBySkill } = await loadData();

	const totalSkills = skills.length;
	const activeCount = skills.filter((s) => s.active_version_id != null).length;
	const categoryCounts = skills.reduce<Record<string, number>>((acc, s) => {
		const k = s.category ?? "uncategorized";
		acc[k] = (acc[k] ?? 0) + 1;
		return acc;
	}, {});

	return (
		<>
			<header className="mb-6">
				<h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					{t.rich("subtitle", {
						code: (chunks) => <code className="rounded bg-muted px-1 text-[11px]">{chunks}</code>,
					})}
				</p>
			</header>

			<section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
				<KPI label={t("totalSkills")} value={totalSkills} />
				<KPI label={t("activeVersions")} value={activeCount} />
				<KPI
					label={t("categories")}
					value={Object.keys(categoryCounts).length}
					sub={Object.entries(categoryCounts)
						.map(([k, n]) => `${k}:${n}`)
						.join(" · ")}
				/>
				<KPI
					label={t("totalVersionsPublished")}
					value={Array.from(versionCountBySkill.values()).reduce((a, b) => a + b, 0)}
				/>
			</section>

			<Card>
				<CardHeader className="pb-2">
					<CardTitle className="text-sm font-semibold">{t("skillsHeading")}</CardTitle>
				</CardHeader>
				<CardContent className="overflow-x-auto p-0">
					<table className="w-full text-sm">
						<thead className="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
							<tr>
								<th className="px-4 py-2 text-left">{t("col.slug")}</th>
								<th className="px-4 py-2 text-left">{t("col.displayName")}</th>
								<th className="px-4 py-2 text-left">{t("col.category")}</th>
								<th className="px-4 py-2 text-left">{t("col.activeVersion")}</th>
								<th className="px-4 py-2 text-left">{t("col.model")}</th>
								<th className="px-4 py-2 text-right">{t("col.versions")}</th>
								<th className="px-4 py-2 text-right">{t("col.published")}</th>
							</tr>
						</thead>
						<tbody>
							{skills.map((s) => {
								const active = s.active_version_id ? versionsBySkill.get(s.id) : undefined;
								const versionCount = versionCountBySkill.get(s.id) ?? 0;
								return (
									<tr key={s.id} className="border-t border-border hover:bg-muted">
										<td className="px-4 py-2 font-mono text-[12px] text-blue-700 dark:text-blue-300">
											<Link href={`/admin/registry/${s.slug}`}>{s.slug}</Link>
										</td>
										<td className="px-4 py-2 text-foreground">{s.display_name}</td>
										<td className="px-4 py-2">{categoryBadge(s.category)}</td>
										<td className="px-4 py-2">
											{active ? (
												<span className="inline-flex items-center gap-1.5">
													<Badge className="bg-green-600/15 text-[10px] text-green-700 dark:text-green-300">{active.version_label}</Badge>
													<span className="font-mono text-[10px] text-muted-foreground">{shortSha(active.git_sha)}</span>
												</span>
											) : (
												<span className="text-[11px] text-muted-foreground">{t("noneActive")}</span>
											)}
										</td>
										<td className="px-4 py-2 font-mono text-[11px] text-muted-foreground">
											{active ? (
												<>
													{active.model}{" "}
													<span className="text-muted-foreground">· {active.provider}</span>
												</>
											) : (
												<span className="text-muted-foreground">—</span>
											)}
										</td>
										<td className="px-4 py-2 text-right font-mono text-[11px] text-muted-foreground">{versionCount}</td>
										<td className="px-4 py-2 text-right font-mono text-[11px] text-muted-foreground">
											{active ? formatDate(active.published_at) : "—"}
										</td>
									</tr>
								);
							})}
							{skills.length === 0 && (
								<tr>
									<td colSpan={7} className="px-4 py-12 text-center text-sm text-muted-foreground">
										{t.rich("emptyState", {
											code: (chunks) => <code className="rounded bg-muted px-1 text-[11px]">{chunks}</code>,
										})}
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</CardContent>
			</Card>
		</>
	);
}

function KPI({ label, value, sub }: { label: string; value: number; sub?: string }) {
	return (
		<Card>
			<CardContent className="p-3">
				<div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
				<div className="mt-1 text-xl font-semibold text-foreground">{value}</div>
				{sub && <div className="mt-0.5 text-[10px] text-muted-foreground">{sub}</div>}
			</CardContent>
		</Card>
	);
}
