"use client";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ComplianceReference, ReferenceLaw } from "@/lib/screenplay/compliance/types";

const LAWS: ReferenceLaw[] = ["yakkiho", "keihyo", "kenzo", "other"];

type Draft = {
	id: string | null;
	law: ReferenceLaw;
	category_scope: string;
	topic: string;
	body: string;
	keywords: string;
	citation: string;
	source_url: string;
	active: boolean;
};

function emptyDraft(): Draft {
	return { id: null, law: "yakkiho", category_scope: "", topic: "", body: "", keywords: "", citation: "", source_url: "", active: true };
}
function toDraft(r: ComplianceReference): Draft {
	return {
		id: r.id, law: r.law, category_scope: (r.category_scope ?? []).join(", "),
		topic: r.topic, body: r.body, keywords: (r.keywords ?? []).join(", "),
		citation: r.citation, source_url: r.source_url, active: r.active,
	};
}

export default function ComplianceReferencesTable({ initial }: { initial: ComplianceReference[] }) {
	const t = useTranslations("admin.complianceReferences");
	const [rows, setRows] = useState<ComplianceReference[]>(initial);
	const [busy, setBusy] = useState<string | null>(null);
	const [filterLaw, setFilterLaw] = useState<"" | ReferenceLaw>("");
	const [search, setSearch] = useState("");
	const [draft, setDraft] = useState<Draft | null>(null);
	const [modalErr, setModalErr] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const visible = useMemo(() => {
		const q = search.trim();
		return rows.filter((r) => {
			if (filterLaw && r.law !== filterLaw) return false;
			if (q && !(r.topic.includes(q) || r.body.includes(q) || r.citation.includes(q))) return false;
			return true;
		});
	}, [rows, filterLaw, search]);

	function openCreate() { setModalErr(null); setDraft(emptyDraft()); }
	function openEdit(r: ComplianceReference) { setModalErr(null); setDraft(toDraft(r)); }
	function closeModal() { if (!saving) { setDraft(null); setModalErr(null); } }

	async function save() {
		if (!draft) return;
		if (!draft.topic.trim() || !draft.body.trim()) { setModalErr(t("err.required")); return; }
		setSaving(true); setModalErr(null);
		const payload = {
			law: draft.law, category_scope: draft.category_scope, topic: draft.topic.trim(),
			body: draft.body.trim(), keywords: draft.keywords, citation: draft.citation,
			source_url: draft.source_url.trim(), active: draft.active,
		};
		const isEdit = !!draft.id;
		const res = await fetch(isEdit ? `/api/admin/compliance-references/${draft.id}` : "/api/admin/compliance-references", {
			method: isEdit ? "PATCH" : "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		setSaving(false);
		if (!res.ok) {
			const j = await res.json().catch(() => ({}));
			if (res.status === 409) setModalErr(t("err.duplicate"));
			else setModalErr((j as { error?: string }).error ?? t("err.generic"));
			return;
		}
		const { reference } = (await res.json()) as { reference: ComplianceReference };
		setRows((prev) => (isEdit ? prev.map((x) => (x.id === reference.id ? reference : x)) : [...prev, reference]));
		setDraft(null);
	}

	async function toggleActive(r: ComplianceReference) {
		setBusy(r.id);
		const res = await fetch(`/api/admin/compliance-references/${r.id}`, {
			method: "PATCH", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ active: !r.active }),
		});
		setBusy(null);
		if (res.ok) { const { reference } = (await res.json()) as { reference: ComplianceReference }; setRows((prev) => prev.map((x) => (x.id === reference.id ? reference : x))); }
		else { const j = await res.json().catch(() => ({})); alert((j as { error?: string }).error ?? t("err.generic")); }
	}

	// No delete: references are evidence for past results (Codex #3). Deactivate
	// via the active toggle instead.

	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-lg font-bold">{t("title")}</h2>
				<p className="text-xs text-muted-foreground mt-1">{t("subtitle")}</p>
			</div>
			<div className="flex flex-wrap items-center gap-2 justify-between">
				<div className="flex flex-wrap items-center gap-2">
					<select value={filterLaw} onChange={(e) => setFilterLaw(e.target.value as "" | ReferenceLaw)} className="border rounded px-2 py-1.5 text-sm">
						<option value="">{t("filterAllLaws")}</option>
						{LAWS.map((l) => <option key={l} value={l}>{t(`laws.${l}`)}</option>)}
					</select>
					<input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("searchPlaceholder")} className="border rounded px-3 py-1.5 text-sm w-56" />
					<span className="text-xs text-muted-foreground">{t("count", { n: visible.length })}</span>
				</div>
				<Button onClick={openCreate}>{t("addButton")}</Button>
			</div>
			<div className="border rounded overflow-x-auto">
				<table className="w-full border-collapse text-sm">
					<thead className="bg-muted">
						<tr className="border-b text-foreground">
							<th className="text-left p-2 font-medium">{t("col.law")}</th>
							<th className="text-left p-2 font-medium">{t("col.category")}</th>
							<th className="text-left p-2 font-medium">{t("col.topic")}</th>
							<th className="text-left p-2 font-medium">{t("col.source")}</th>
							<th className="text-left p-2 font-medium">{t("col.active")}</th>
							<th className="text-right p-2 font-medium">{t("col.actions")}</th>
						</tr>
					</thead>
					<tbody>
						{visible.map((r) => (
							<tr key={r.id} className={`border-b hover:bg-muted/50 ${r.active ? "" : "opacity-50"}`}>
								<td className="p-2 whitespace-nowrap">{t(`laws.${r.law}`)}</td>
								<td className="p-2 text-xs text-muted-foreground">{r.category_scope.length ? r.category_scope.join(", ") : t("allCategories")}</td>
								<td className="p-2 max-w-[22rem]"><div className="font-medium">{r.topic}</div><div className="text-xs text-muted-foreground line-clamp-2">{r.body}</div></td>
								<td className="p-2 text-xs">{r.source_url ? <a href={r.source_url} target="_blank" rel="noreferrer" className="underline">{r.citation || t("col.source")}</a> : <span className="text-muted-foreground">{r.citation || "—"}</span>}</td>
								<td className="p-2"><button onClick={() => toggleActive(r)} disabled={busy === r.id} className="text-xs underline-offset-2 hover:underline disabled:opacity-50">{r.active ? t("activeYes") : t("activeNo")}</button></td>
								<td className="p-2 text-right whitespace-nowrap">
									<Button variant="outline" size="sm" onClick={() => openEdit(r)} disabled={busy === r.id}>{t("edit")}</Button>
								</td>
							</tr>
						))}
						{visible.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-muted-foreground text-sm">{t("empty")}</td></tr>}
					</tbody>
				</table>
			</div>

			{draft && (
				<div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
					<Card className="w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
						<h3 className="font-bold text-lg">{draft.id ? t("form.editHeading") : t("form.createHeading")}</h3>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
							<label className="block"><span className="text-xs text-foreground">{t("form.law")}</span>
								<select value={draft.law} onChange={(e) => setDraft({ ...draft, law: e.target.value as ReferenceLaw })} className="mt-1 w-full border rounded px-2 py-2">
									{LAWS.map((l) => <option key={l} value={l}>{t(`laws.${l}`)}</option>)}
								</select>
							</label>
							<label className="block"><span className="text-xs text-foreground">{t("form.category")}</span>
								<input type="text" value={draft.category_scope} onChange={(e) => setDraft({ ...draft, category_scope: e.target.value })} placeholder={t("form.categoryPlaceholder")} className="mt-1 w-full border rounded px-3 py-2 text-sm" />
							</label>
						</div>
						<label className="block"><span className="text-xs text-foreground">{t("form.topic")}</span>
							<input type="text" value={draft.topic} onChange={(e) => setDraft({ ...draft, topic: e.target.value })} className="mt-1 w-full border rounded px-3 py-2 text-sm" />
						</label>
						<label className="block"><span className="text-xs text-foreground">{t("form.body")}</span>
							<textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={4} className="mt-1 w-full border rounded px-3 py-2 text-sm" />
						</label>
						<label className="block"><span className="text-xs text-foreground">{t("form.keywords")}</span>
							<input type="text" value={draft.keywords} onChange={(e) => setDraft({ ...draft, keywords: e.target.value })} placeholder={t("form.keywordsPlaceholder")} className="mt-1 w-full border rounded px-3 py-2 text-sm" />
						</label>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
							<label className="block"><span className="text-xs text-foreground">{t("form.citation")}</span>
								<input type="text" value={draft.citation} onChange={(e) => setDraft({ ...draft, citation: e.target.value })} className="mt-1 w-full border rounded px-3 py-2 text-sm" />
							</label>
							<label className="block"><span className="text-xs text-foreground">{t("form.sourceUrl")}</span>
								<input type="url" value={draft.source_url} onChange={(e) => setDraft({ ...draft, source_url: e.target.value })} className="mt-1 w-full border rounded px-3 py-2 text-sm" />
							</label>
						</div>
						<label className="flex items-center gap-2 text-sm">
							<input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> {t("form.active")}
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
