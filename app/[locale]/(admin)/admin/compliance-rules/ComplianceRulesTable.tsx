"use client";
import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useDialogBehavior } from "@/components/ui/use-dialog-behavior";
import type { ComplianceRule, ComplianceLaw, Severity } from "@/lib/screenplay/compliance/types";

const LAWS: ComplianceLaw[] = ["yakkiho", "keihyo", "kenzo", "shokuhin", "tokushoho"];
const SEVS: Severity[] = ["high", "med", "low"];
const PAGE_SIZE = 25;

type Draft = {
	id: string | null;
	law: ComplianceLaw;
	category_scope: string; // comma-separated in the form
	pattern: string;
	is_regex: boolean;
	allowed: boolean;
	severity: Severity;
	reason: string;
	safe_rewrite: string;
	citation: string;
	active: boolean;
};

function emptyDraft(): Draft {
	return {
		id: null, law: "yakkiho", category_scope: "", pattern: "", is_regex: false,
		allowed: false, severity: "med", reason: "", safe_rewrite: "", citation: "", active: true,
	};
}

function toDraft(r: ComplianceRule): Draft {
	return {
		id: r.id, law: r.law, category_scope: (r.category_scope ?? []).join(", "),
		pattern: r.pattern, is_regex: r.is_regex, allowed: r.allowed, severity: r.severity,
		reason: r.reason, safe_rewrite: r.safe_rewrite, citation: r.citation, active: r.active,
	};
}

const SEV_BADGE: Record<Severity, string> = {
	high: "bg-red-100 text-red-800 border-red-200 dark:bg-red-500/15 dark:text-red-200 dark:border-red-500/30",
	med: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30",
	low: "bg-muted text-muted-foreground border-border",
};

export default function ComplianceRulesTable({ initial }: { initial: ComplianceRule[] }) {
	const t = useTranslations("admin.complianceRules");
	const [rows, setRows] = useState<ComplianceRule[]>(initial);
	const [busy, setBusy] = useState<string | null>(null);
	const [filterLaw, setFilterLaw] = useState<"" | ComplianceLaw>("");
	const [search, setSearch] = useState("");
	const [page, setPage] = useState(0);
	const [tableError, setTableError] = useState<string | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [modalErr, setModalErr] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const dialogRef = useRef<HTMLDivElement>(null);
	useDialogBehavior(!!draft, () => { if (!saving) { setDraft(null); setModalErr(null); } }, dialogRef, { closeOnEscape: !saving });

	const visible = useMemo(() => {
		const q = search.trim();
		return rows.filter((r) => {
			if (filterLaw && r.law !== filterLaw) return false;
			if (q && !(r.pattern.includes(q) || r.reason.includes(q) || r.citation.includes(q))) return false;
			return true;
		});
	}, [rows, filterLaw, search]);
	const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
	const safePage = Math.min(page, pageCount - 1);
	const pagedVisible = visible.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

	function openCreate() { setModalErr(null); setDraft(emptyDraft()); }
	function openEdit(r: ComplianceRule) { setModalErr(null); setDraft(toDraft(r)); }
	function closeModal() { if (!saving) { setDraft(null); setModalErr(null); } }

	async function save() {
		if (!draft) return;
		if (!draft.pattern.trim()) { setModalErr(t("err.patternRequired")); return; }
		setSaving(true);
		setModalErr(null);
		const payload = {
			law: draft.law,
			category_scope: draft.category_scope,
			pattern: draft.pattern.trim(),
			is_regex: draft.is_regex,
			allowed: draft.allowed,
			severity: draft.severity,
			reason: draft.reason,
			safe_rewrite: draft.safe_rewrite,
			citation: draft.citation,
			active: draft.active,
		};
		const isEdit = !!draft.id;
		try {
			const response = await fetch(isEdit ? `/api/admin/compliance-rules/${draft.id}` : "/api/admin/compliance-rules", {
				method: isEdit ? "PATCH" : "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			if (!response.ok) {
				const json = await response.json().catch(() => ({}));
				if (response.status === 409) setModalErr(t("err.duplicate"));
				else if (response.status === 400) setModalErr((json as { error?: string }).error ?? t("err.validation"));
				else setModalErr((json as { error?: string }).error ?? t("err.generic"));
				return;
			}
			const { rule } = (await response.json()) as { rule: ComplianceRule };
			setRows((prev) => (isEdit ? prev.map((x) => (x.id === rule.id ? rule : x)) : [...prev, rule]));
			setDraft(null);
		} catch {
			setModalErr(t("err.generic"));
		} finally {
			setSaving(false);
		}
	}

	async function toggleActive(r: ComplianceRule) {
		setBusy(r.id);
		setTableError(null);
		try {
			const res = await fetch(`/api/admin/compliance-rules/${r.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ active: !r.active }),
			});
			if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? t("err.generic"));
			const { rule } = (await res.json()) as { rule: ComplianceRule };
			setRows((prev) => prev.map((x) => (x.id === rule.id ? rule : x)));
		} catch (error) {
			setTableError(error instanceof Error && error.message !== "Failed to fetch" ? error.message : t("err.generic"));
		} finally {
			setBusy(null);
		}
	}

	async function remove(r: ComplianceRule) {
		if (!confirm(t("confirmDelete"))) return;
		setBusy(r.id);
		setTableError(null);
		try {
			const res = await fetch(`/api/admin/compliance-rules/${r.id}`, { method: "DELETE" });
			if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? t("err.generic"));
			setRows((prev) => prev.filter((x) => x.id !== r.id));
		} catch (error) {
			setTableError(error instanceof Error && error.message !== "Failed to fetch" ? error.message : t("err.generic"));
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="space-y-4">
			<div className="mw-panel px-4 py-4 sm:px-5">
				<div className="mw-kicker mb-1">Broadcast compliance lexicon</div>
				<h2 className="text-lg font-bold tracking-[-0.015em]">{t("title")}</h2>
				<p className="mt-1 text-xs text-muted-foreground">{t("subtitle")}</p>
			</div>

			<div className="mw-toolbar">
				<div className="flex flex-wrap items-center gap-2">
					<select
						aria-label={t("filterAllLaws")}
						value={filterLaw}
						onChange={(e) => { setFilterLaw(e.target.value as "" | ComplianceLaw); setPage(0); }}
						className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
					>
						<option value="">{t("filterAllLaws")}</option>
						{LAWS.map((l) => <option key={l} value={l}>{t(`laws.${l}`)}</option>)}
					</select>
					<input
						aria-label={t("searchPlaceholder")}
						type="text" value={search}
						onChange={(e) => { setSearch(e.target.value); setPage(0); }}
						placeholder={t("searchPlaceholder")}
						className="h-9 w-64 max-w-full rounded-lg border border-border bg-background px-3 text-sm"
					/>
					<span className="text-xs text-muted-foreground">{t("count", { n: visible.length })}</span>
				</div>
				<Button onClick={openCreate}>{t("addButton")}</Button>
			</div>
			{tableError && (
				<div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:text-red-300">
					<span>{tableError}</span>
					<button type="button" onClick={() => setTableError(null)} className="font-medium underline">OK</button>
				</div>
			)}

			<div className="mw-table-shell overflow-x-auto">
				<table className="w-full min-w-[1080px] text-sm">
					<thead className="bg-muted">
						<tr className="border-b text-foreground">
							<th className="text-left p-2 font-medium">{t("col.law")}</th>
							<th className="text-left p-2 font-medium">{t("col.category")}</th>
							<th className="text-left p-2 font-medium">{t("col.pattern")}</th>
							<th className="text-left p-2 font-medium">{t("col.type")}</th>
							<th className="text-left p-2 font-medium">{t("col.severity")}</th>
							<th className="text-left p-2 font-medium">{t("col.reason")}</th>
							<th className="text-left p-2 font-medium">{t("col.active")}</th>
							<th className="text-right p-2 font-medium">{t("col.actions")}</th>
						</tr>
					</thead>
					<tbody>
						{pagedVisible.map((r) => (
							<tr key={r.id} className={`border-b hover:bg-muted/50 ${r.active ? "" : "opacity-50"}`}>
								<td className="p-2 whitespace-nowrap">{t(`laws.${r.law}`)}</td>
								<td className="p-2 text-xs text-muted-foreground">
									{r.category_scope.length ? r.category_scope.join(", ") : t("allCategories")}
								</td>
								<td className="p-2 font-mono text-xs max-w-[18rem] break-all">
									{r.pattern}
									{r.is_regex && <Badge className="ml-1 bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-500/15 dark:text-sky-200">regex</Badge>}
								</td>
								<td className="p-2">
									{r.allowed
										? <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-200">{t("typeAllowed")}</Badge>
										: <Badge className="bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-500/15 dark:text-rose-200">{t("typeNg")}</Badge>}
								</td>
								<td className="p-2">
									<Badge className={SEV_BADGE[r.severity]}>{t(`sev.${r.severity}`)}</Badge>
								</td>
								<td className="p-2 text-xs max-w-[20rem]">{r.reason}</td>
								<td className="p-2">
									<button
										type="button"
										onClick={() => toggleActive(r)}
										disabled={busy === r.id}
										className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md px-2 text-xs underline-offset-2 hover:bg-muted hover:underline disabled:opacity-50"
									>
										{r.active ? t("activeYes") : t("activeNo")}
									</button>
								</td>
								<td className="p-2 text-right whitespace-nowrap">
									<Button variant="outline" size="sm" onClick={() => openEdit(r)} disabled={busy === r.id} className="mr-1">{t("edit")}</Button>
									<Button variant="outline" size="sm" onClick={() => remove(r)} disabled={busy === r.id}>{t("delete")}</Button>
								</td>
							</tr>
						))}
						{visible.length === 0 && (
							<tr><td colSpan={8} className="p-8 text-center text-muted-foreground text-sm">{t("empty")}</td></tr>
						)}
					</tbody>
				</table>
			</div>
			{visible.length > PAGE_SIZE && (
				<div className="mw-toolbar py-2.5">
					<span className="text-xs text-muted-foreground">{safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, visible.length)} / {visible.length}</span>
					<div className="flex items-center gap-1.5">
						<button type="button" disabled={safePage === 0} onClick={() => setPage((current) => Math.max(0, current - 1))} className="min-h-9 rounded-lg border border-border px-3 text-xs font-medium hover:bg-muted disabled:opacity-35">{t("pagination.prev")}</button>
						<span className="min-w-16 text-center font-mono text-xs text-muted-foreground">{safePage + 1} / {pageCount}</span>
						<button type="button" disabled={safePage >= pageCount - 1} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))} className="min-h-9 rounded-lg border border-border px-3 text-xs font-medium hover:bg-muted disabled:opacity-35">{t("pagination.next")}</button>
					</div>
				</div>
			)}

			{draft && (
				<div
					className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
					onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
				>
					<Card ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="compliance-rule-dialog-title" tabIndex={-1} className="max-h-[90dvh] w-full max-w-2xl space-y-4 overflow-y-auto p-5 sm:p-6">
						<h3 id="compliance-rule-dialog-title" className="font-bold text-lg">{draft.id ? t("form.editHeading") : t("form.createHeading")}</h3>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
							<label className="block">
								<span className="text-xs text-foreground">{t("form.law")}</span>
								<select value={draft.law} onChange={(e) => setDraft({ ...draft, law: e.target.value as ComplianceLaw })} className="mt-1 w-full border rounded px-2 py-2">
									{LAWS.map((l) => <option key={l} value={l}>{t(`laws.${l}`)}</option>)}
								</select>
							</label>
							<label className="block">
								<span className="text-xs text-foreground">{t("form.severity")}</span>
								<select value={draft.severity} onChange={(e) => setDraft({ ...draft, severity: e.target.value as Severity })} className="mt-1 w-full border rounded px-2 py-2">
									{SEVS.map((s) => <option key={s} value={s}>{t(`sev.${s}`)}</option>)}
								</select>
							</label>
						</div>
						<label className="block">
							<span className="text-xs text-foreground">{t("form.category")}</span>
							<input type="text" value={draft.category_scope} onChange={(e) => setDraft({ ...draft, category_scope: e.target.value })} placeholder={t("form.categoryPlaceholder")} className="mt-1 w-full border rounded px-3 py-2 text-sm" />
							<span className="text-[11px] text-muted-foreground">{t("form.categoryHint")}</span>
						</label>
						<label className="block">
							<span className="text-xs text-foreground">{t("form.pattern")}</span>
							<input type="text" value={draft.pattern} onChange={(e) => setDraft({ ...draft, pattern: e.target.value })} className="mt-1 w-full border rounded px-3 py-2 font-mono text-sm" />
						</label>
						<div className="flex flex-wrap gap-4">
							<label className="flex items-center gap-2 text-sm">
								<input type="checkbox" checked={draft.is_regex} onChange={(e) => setDraft({ ...draft, is_regex: e.target.checked })} />
								{t("form.isRegex")}
							</label>
							<label className="flex items-center gap-2 text-sm">
								<input type="checkbox" checked={draft.allowed} onChange={(e) => setDraft({ ...draft, allowed: e.target.checked })} />
								{t("form.allowed")}
							</label>
							<label className="flex items-center gap-2 text-sm">
								<input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
								{t("form.active")}
							</label>
						</div>
						<label className="block">
							<span className="text-xs text-foreground">{t("form.reason")}</span>
							<textarea value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} rows={2} className="mt-1 w-full border rounded px-3 py-2 text-sm" />
						</label>
						<label className="block">
							<span className="text-xs text-foreground">{t("form.rewrite")}</span>
							<textarea value={draft.safe_rewrite} onChange={(e) => setDraft({ ...draft, safe_rewrite: e.target.value })} rows={2} className="mt-1 w-full border rounded px-3 py-2 text-sm" />
						</label>
						<label className="block">
							<span className="text-xs text-foreground">{t("form.citation")}</span>
							<input type="text" value={draft.citation} onChange={(e) => setDraft({ ...draft, citation: e.target.value })} className="mt-1 w-full border rounded px-3 py-2 text-sm" />
						</label>
						{modalErr && <p className="text-sm text-red-600">{modalErr}</p>}
						<div className="flex justify-end gap-2 pt-2">
							<Button variant="outline" onClick={closeModal} disabled={saving}>{t("form.cancel")}</Button>
							<Button onClick={save} disabled={saving}>{saving ? t("form.saving") : t("form.submit")}</Button>
						</div>
					</Card>
				</div>
			)}
		</div>
	);
}
