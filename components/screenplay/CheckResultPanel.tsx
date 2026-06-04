"use client";
import { useState } from "react";
import { Loader2, ShieldAlert, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { ScriptCheckResult, Finding, Severity } from "@/lib/screenplay/compliance/types";

interface CheckWithMeta extends ScriptCheckResult {
	created_at?: string;
}

interface Props {
	screenplayId: string;
	initialCheck: CheckWithMeta | null;
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

export function CheckResultPanel({ screenplayId, initialCheck }: Props) {
	const [check, setCheck] = useState<CheckWithMeta | null>(initialCheck);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	async function recheck() {
		setBusy(true);
		setErr(null);
		try {
			const res = await fetch(`/api/screenplays/${screenplayId}/check`, { method: "POST" });
			const j = await res.json() as { check?: CheckWithMeta; error?: string };
			if (!res.ok) throw new Error(j.error ?? "再チェックに失敗しました");
			setCheck(j.check ?? null);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
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
							<h3 className="text-sm font-semibold text-foreground">試験結果</h3>
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

				{check ? (
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
