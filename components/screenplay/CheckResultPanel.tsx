"use client";
import { useState, useEffect, useRef } from "react";
import { Loader2, ShieldAlert, RefreshCw, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { ScriptCheckResult, Finding, Severity } from "@/lib/screenplay/compliance/types";

export interface CheckWithMeta extends ScriptCheckResult {
	created_at?: string;
	lexicon_version?: string;
}

interface Props {
	screenplayId: string;
	versionId: string;
	/** Which draft this result belongs to, e.g. "第 3 稿" — shown as a chip so a
	 *  fast version switch can't make the result look like it's for another 稿. */
	versionLabel?: string;
	initialCheck: CheckWithMeta | null;
	initialCheckVersionId: string | null;
	onCheckChange?: (check: CheckWithMeta | null) => void;
}

const SEVERITY_CLS: Record<Severity, string> = {
	high: "bg-red-600/10 border-red-200 dark:border-red-900/40 text-red-700 dark:text-red-300",
	med: "bg-yellow-600/10 border-yellow-200 dark:border-yellow-900/40 text-yellow-700 dark:text-yellow-300",
	low: "bg-blue-600/10 border-blue-200 dark:border-blue-900/40 text-blue-700 dark:text-blue-300",
};
const SEVERITY_BADGE: Record<Severity, string> = {
	high: "bg-red-600/15 text-red-700 dark:text-red-300",
	med: "bg-yellow-600/15 text-yellow-700 dark:text-yellow-300",
	low: "bg-blue-600/15 text-blue-700 dark:text-blue-300",
};
const SEVERITY_LABEL: Record<Severity, string> = {
	high: "高",
	med: "中",
	low: "低",
};

function FindingCard({ f }: { f: Finding }) {
	return (
		<div className={`rounded-lg border p-3 text-xs space-y-1 ${SEVERITY_CLS[f.severity]}`}>
			<div className="flex items-start gap-2">
				<span className={`inline-flex items-center shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${SEVERITY_BADGE[f.severity]}`}>
					{SEVERITY_LABEL[f.severity]}
				</span>
				<span className="font-medium text-foreground break-all">{f.quote}</span>
			</div>
			{f.reason && <p className="text-muted-foreground pl-7">{f.reason}</p>}
			{f.citedRule && (
				<p className="pl-7 text-[10px] text-muted-foreground">根拠: {f.citedRule}</p>
			)}
			{f.suggestedRewrite && (
				<p className="pl-7 text-foreground/80">
					<span className="font-medium">修正案: </span>{f.suggestedRewrite}
				</p>
			)}
			{f.references && f.references.length > 0 && (
				<div className="mt-1 pl-7 flex flex-wrap gap-2">
					{f.references.map((ref, i) => (
						<a
							key={i}
							href={ref.url}
							target="_blank"
							rel="noreferrer"
							className="text-xs text-blue-600 dark:text-blue-400 underline underline-offset-2 break-all"
						>
							{ref.title || ref.url}
						</a>
					))}
				</div>
			)}
		</div>
	);
}

function AxisSection({ label, findings }: { label: string; findings: Finding[] }) {
	if (findings.length === 0) return null;
	return (
		<div className="mt-3">
			<div className="text-[11px] font-semibold text-muted-foreground mb-1.5">{label}</div>
			<div className="space-y-2">
				{findings.map((f, i) => <FindingCard key={i} f={f} />)}
			</div>
		</div>
	);
}

function scoreColor(score: number): string {
	if (score >= 80) return "text-green-600 dark:text-green-400";
	if (score >= 60) return "text-yellow-600 dark:text-yellow-400";
	return "text-red-600 dark:text-red-400";
}

/** Reproducibility metadata — the version stamp, grounding corpus snapshot, and
 *  auto-remediation trace persisted with each check. Collapsed by default. */
function ReproducibilityInfo({ check }: { check: CheckWithMeta }) {
	const [open, setOpen] = useState(false);
	const g = check.grounding;
	const r = check.remediation;
	if (!check.lexicon_version && !g && !r?.enabled) return null;

	return (
		<div className="mt-4 border-t border-border pt-3">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
			>
				<ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
				再現性情報
			</button>
			{open && (
				<div className="mt-2 space-y-2 text-[10px] text-muted-foreground">
					{check.lexicon_version && (
						<div>
							<span className="font-medium text-foreground/70">バージョン: </span>
							<span className="break-all">{check.lexicon_version}</span>
						</div>
					)}
					{g && (
						<div className="space-y-1">
							<div>
								<span className="font-medium text-foreground/70">グラウンディング: </span>
								参照{g.referenceIds?.length ?? 0}件 / コーパスhash{" "}
								{g.corpusHash ? g.corpusHash.slice(0, 12) : "—"} / ファクト検索{" "}
								{g.factSearch ? "あり" : "なし"}
							</div>
							{(g.searchDomains ?? []).length > 0 && (
								<div className="break-all">検索ドメイン: {g.searchDomains.join(", ")}</div>
							)}
							{(g.referencesSnapshot ?? []).length > 0 && (
								<ul className="list-disc pl-4 space-y-0.5">
									{g.referencesSnapshot.map((ref) => (
										<li key={ref.id} className="break-all">
											[{ref.law}] {ref.topic}
											{ref.citation ? ` — ${ref.citation}` : ""}
										</li>
									))}
								</ul>
							)}
						</div>
					)}
					{r?.enabled && (
						<div className="space-y-1">
							<div>
								<span className="font-medium text-foreground/70">自動修正: </span>
								{r.iterations.length}回 / 残り高リスク {r.finalHigh}件
							</div>
							{r.iterations.length > 0 && (
								<ul className="list-disc pl-4 space-y-0.5">
									{r.iterations.map((it) => (
										<li key={it.iter}>
											iter{it.iter}: {it.scoreBefore}→{it.scoreAfter} (決定論{it.tier1} / 再生成
											{it.sections} / 未特定{it.unlocatable})
										</li>
									))}
								</ul>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

export function CheckResultPanel({ screenplayId, versionId, versionLabel, initialCheck, initialCheckVersionId, onCheckChange }: Props) {
	const seeded = versionId === initialCheckVersionId;
	const [check, setCheck] = useState<CheckWithMeta | null>(seeded ? initialCheck : null);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	// Tracks the currently-selected version so async responses (GET and the
	// manual POST) can be dropped if the user switched versions mid-flight.
	const versionRef = useRef(versionId);
	useEffect(() => { versionRef.current = versionId; }, [versionId]);

	// Seed the SSR initialCheck ONLY on the first render and only for the
	// initially-selected version. Returning to that version later (e.g. after a
	// manual re-check) fetches fresh, so a stale SSR snapshot never wins.
	const firstRunRef = useRef(true);

	useEffect(() => {
		let cancelled = false;
		const isFirst = firstRunRef.current;
		firstRunRef.current = false;

		if (isFirst && versionId === initialCheckVersionId) {
			setLoading(false);
			setCheck(initialCheck);
			setErr(null);
			onCheckChange?.(initialCheck);
			return;
		}

		setLoading(true);
		setErr(null);
		setCheck(null);
		onCheckChange?.(null);
		(async () => {
			try {
				const res = await fetch(`/api/screenplays/${screenplayId}/versions/${versionId}/check`, { cache: "no-store" });
				const j = (await res.json()) as { check?: CheckWithMeta | null; error?: string };
				if (!res.ok) throw new Error(j.error ?? "試験結果の取得に失敗しました");
				if (cancelled) return;
				setCheck(j.check ?? null);
				onCheckChange?.(j.check ?? null);
			} catch (e) {
				if (cancelled) return;
				setCheck(null);
				onCheckChange?.(null);
				setErr(e instanceof Error ? e.message : String(e));
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => { cancelled = true; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [versionId]);

	async function recheck() {
		const requestVersionId = versionId;
		setBusy(true);
		setErr(null);
		try {
			const res = await fetch(`/api/screenplays/${screenplayId}/versions/${versionId}/check`, { method: "POST" });
			const j = await res.json() as { check?: CheckWithMeta; error?: string };
			if (!res.ok) throw new Error(j.error ?? "再チェックに失敗しました");
			// Drop the result if the user switched versions while the POST was in flight.
			if (requestVersionId === versionRef.current) {
				setCheck(j.check ?? null);
				onCheckChange?.(j.check ?? null);
			}
		} catch (e) {
			if (requestVersionId === versionRef.current) {
				setErr(e instanceof Error ? e.message : String(e));
			}
		} finally {
			setBusy(false);
		}
	}

	const totalFindings = check ? check.legal.length + check.facts.length + check.quality.length : 0;

	return (
		<Card className="border-border mt-4">
			<CardContent className="p-5">
				<div className="flex items-center justify-between mb-3">
					<div className="flex items-center gap-2">
						<div className="w-8 h-8 bg-yellow-600/10 rounded-lg flex items-center justify-center">
							<ShieldAlert size={16} className="text-yellow-600" />
						</div>
						<div>
							<div className="flex items-center gap-2">
								<h3 className="text-sm font-semibold text-foreground">試験結果</h3>
								{versionLabel && (
									<span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground whitespace-nowrap">
										{versionLabel}
									</span>
								)}
							</div>
							<p className="text-[11px] text-muted-foreground">薬機法・景表法・品質チェック</p>
						</div>
					</div>
					<button
						type="button"
						onClick={recheck}
						disabled={busy}
						className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 border border-border rounded-lg hover:border-blue-200 hover:bg-blue-600/10 text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
						{busy ? "確認中..." : "再チェック"}
					</button>
				</div>

				{err && (
					<div className="mb-3 p-2.5 bg-red-600/10 border border-red-200 dark:border-red-900/40 rounded-lg text-xs text-red-700 dark:text-red-300">
						{err}
					</div>
				)}

				{loading ? (
					<p className="text-xs text-muted-foreground py-3 text-center flex items-center justify-center gap-2">
						<Loader2 size={12} className="animate-spin" /> 試験結果を読み込み中…
					</p>
				) : check ? (
					<>
						<div className="flex items-baseline gap-2 mb-1">
							<span className={`text-2xl font-bold ${scoreColor(check.overallScore)}`}>
								{check.overallScore}
							</span>
							<span className="text-xs text-muted-foreground">/ 100 スコア</span>
							{totalFindings > 0 && (
								<span className="ml-auto text-[11px] text-muted-foreground">{totalFindings}件の指摘</span>
							)}
						</div>
						{check.created_at && (
							<p className="text-[10px] text-muted-foreground mb-2">
								{new Date(check.created_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
							</p>
						)}
						{totalFindings === 0 && (
							<p className="text-xs text-muted-foreground py-2 text-center">指摘なし</p>
						)}
						<AxisSection label="法規" findings={check.legal} />
						<AxisSection label="ファクト" findings={check.facts} />
						<AxisSection label="品質" findings={check.quality} />
						<ReproducibilityInfo check={check} />
					</>
				) : (
					<p className="text-xs text-muted-foreground py-3 text-center">
						「再チェック」で試験を実行してください。
					</p>
				)}
			</CardContent>
		</Card>
	);
}
