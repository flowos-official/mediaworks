"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AlertTriangle, CheckCircle2, CircleDashed, RefreshCw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RecommendationFlowStatus } from "@/lib/recommendation/flow-evidence";
import {
	buildRecommendationFlowStatusView,
	getRecommendationFlowStatusUiText,
} from "@/lib/recommendation/flow-status-view";
import type { FlowCheckStatus } from "@/lib/recommendation/flow-readiness";

type LoadState =
	| { status: "loading"; data: null; error: null }
	| { status: "ready"; data: RecommendationFlowStatus; error: null }
	| { status: "error"; data: null; error: string };

const BADGE_CLASS: Record<FlowCheckStatus, string> = {
	pass: "bg-emerald-600/10 text-emerald-700 dark:text-emerald-300 border-emerald-600/30",
	warn: "bg-amber-600/10 text-amber-700 dark:text-amber-300 border-amber-600/30",
	fail: "bg-red-600/10 text-red-700 dark:text-red-300 border-red-600/30",
};

const ICON_CLASS: Record<FlowCheckStatus, string> = {
	pass: "text-emerald-600",
	warn: "text-amber-600",
	fail: "text-red-600",
};

function StatusIcon({ status }: { status: FlowCheckStatus }) {
	if (status === "pass") return <CheckCircle2 size={16} className={ICON_CLASS.pass} />;
	if (status === "warn") return <AlertTriangle size={16} className={ICON_CLASS.warn} />;
	return <XCircle size={16} className={ICON_CLASS.fail} />;
}

async function fetchStatus(): Promise<RecommendationFlowStatus> {
	const res = await fetch("/api/recommendation-flow/status", { cache: "no-store" });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(
			typeof data?.message === "string"
				? data.message
				: typeof data?.error === "string"
					? data.error
					: `HTTP ${res.status}`,
		);
	}
	return data as RecommendationFlowStatus;
}

export function RecommendationFlowStatusPanel() {
	const { locale } = useParams<{ locale?: string }>();
	const [state, setState] = useState<LoadState>({ status: "loading", data: null, error: null });
	const [refreshKey, setRefreshKey] = useState(0);

	useEffect(() => {
		let cancelled = false;
		fetchStatus()
			.then((data) => {
				if (!cancelled) setState({ status: "ready", data, error: null });
			})
			.catch((err) => {
				if (!cancelled) {
					setState({
						status: "error",
						data: null,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			});
		return () => {
			cancelled = true;
		};
	}, [refreshKey]);

	const view = state.status === "ready" ? buildRecommendationFlowStatusView(state.data, locale) : null;
	const uiText = getRecommendationFlowStatusUiText(locale);

	function handleRefresh() {
		setState({ status: "loading", data: null, error: null });
		setRefreshKey((value) => value + 1);
	}

	return (
		<div className="space-y-4">
			<div className="flex flex-col gap-3 border border-border bg-card px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<div className="flex items-center gap-2">
						{state.status === "loading" ? (
							<CircleDashed size={18} className="animate-spin text-muted-foreground" />
						) : view?.tone === "ready" ? (
							<CheckCircle2 size={18} className="text-emerald-600" />
						) : (
							<AlertTriangle size={18} className="text-amber-600" />
						)}
						<h2 className="text-lg font-semibold text-foreground">
							{state.status === "loading"
								? uiText.loadingHeadline
								: state.status === "error"
									? uiText.unavailableHeadline
									: view?.headline}
						</h2>
					</div>
					<p className="mt-1 text-sm text-muted-foreground">
						{state.status === "loading"
							? uiText.loadingSummary
							: state.status === "error"
								? state.error
								: view?.summary}
					</p>
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={handleRefresh}
					disabled={state.status === "loading"}
				>
					<RefreshCw size={14} />
					{uiText.refresh}
				</Button>
			</div>

			{state.status === "ready" && view && (
				<>
					<div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-6">
						{view.cards.map((card) => (
							<Card key={card.key} size="sm" className="rounded-lg">
								<CardHeader className="pb-0">
									<CardTitle className="flex items-center justify-between gap-2 text-sm">
										<span className="truncate">{card.title}</span>
										<StatusIcon status={card.status} />
									</CardTitle>
								</CardHeader>
								<CardContent>
									<div className="text-2xl font-semibold tabular-nums">{card.metric}</div>
									<div className="mt-1 text-xs text-muted-foreground">{card.description}</div>
								</CardContent>
							</Card>
						))}
					</div>

					<div className="overflow-hidden rounded-lg border border-border">
						<div className="border-b border-border bg-muted/50 px-4 py-2 text-sm font-semibold">
							{uiText.strictChecks}
						</div>
						<div className="divide-y divide-border">
							{view.checks.map((check) => (
								<div key={check.key} className="flex items-start gap-3 px-4 py-3">
									<StatusIcon status={check.status} />
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-center gap-2">
											<span className="text-sm font-medium text-foreground">{check.title}</span>
											<Badge variant="outline" className={BADGE_CLASS[check.status]}>
												{check.statusLabel}
											</Badge>
											{check.required && (
												<Badge variant="outline" className="text-[10px] text-muted-foreground">
													{uiText.required}
												</Badge>
											)}
										</div>
										<p className="mt-1 text-sm text-muted-foreground">{check.message}</p>
									</div>
								</div>
							))}
						</div>
					</div>
				</>
			)}
		</div>
	);
}
