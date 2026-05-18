"use client";

import { useCallback, useState } from "react";
import {
	Sparkles,
	Loader2,
	RefreshCw,
	AlertTriangle,
	Tv,
	ShoppingBag,
	Radio,
	Ban,
	CheckCircle2,
} from "lucide-react";

interface SlotInput {
	channel: string;
	productName: string;
	category: string | null;
	priceText: string | null;
	airDate: string;
	startTime: string | null;
	description?: string | null;
	sourceUrl?: string | null;
}

interface Analysis {
	fitScore: number;
	summary: string;
	recommendedTiming: string;
	recommendedChannel: "tv" | "ec" | "live" | "tv+ec" | "skip";
	differentiation: string[];
	risks: string[];
	confidence: "low" | "medium" | "high";
}

interface FetchResult {
	cached: boolean;
	analysis: Analysis;
	generatedAt: string;
}

const CHANNEL_LABEL: Record<Analysis["recommendedChannel"], { label: string; icon: typeof Tv; cls: string }> = {
	tv: { label: "TV通販", icon: Tv, cls: "bg-violet-100 text-violet-700" },
	ec: { label: "EC", icon: ShoppingBag, cls: "bg-blue-100 text-blue-700" },
	live: { label: "ライブ", icon: Radio, cls: "bg-rose-100 text-rose-700" },
	"tv+ec": { label: "TV+EC", icon: Tv, cls: "bg-emerald-100 text-emerald-700" },
	skip: { label: "見送り", icon: Ban, cls: "bg-gray-200 text-gray-600" },
};

function scoreColor(s: number): string {
	if (s >= 80) return "bg-emerald-500 text-white";
	if (s >= 60) return "bg-blue-500 text-white";
	if (s >= 40) return "bg-amber-400 text-amber-900";
	return "bg-rose-400 text-white";
}

export function CompetitorFitPanel({ slot }: { slot: SlotInput }) {
	const [state, setState] = useState<
		| { kind: "idle" }
		| { kind: "loading" }
		| { kind: "ok"; data: FetchResult }
		| { kind: "error"; message: string }
	>({ kind: "idle" });

	const run = useCallback(
		async (refresh = false) => {
			setState({ kind: "loading" });
			try {
				const res = await fetch("/api/broadcasts/analyze-fit", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ...slot, refresh }),
				});
				const body = await res.json();
				if (!res.ok) {
					setState({ kind: "error", message: body.error ?? `HTTP ${res.status}` });
					return;
				}
				setState({ kind: "ok", data: body as FetchResult });
			} catch (err) {
				setState({
					kind: "error",
					message: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[slot],
	);

	if (state.kind === "idle") {
		return (
			<button
				type="button"
				onClick={() => run(false)}
				className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200"
			>
				<Sparkles size={11} />
				自社販売適合度を分析
			</button>
		);
	}

	if (state.kind === "loading") {
		return (
			<div className="inline-flex items-center gap-1 text-[11px] text-gray-500 px-2 py-1">
				<Loader2 size={11} className="animate-spin" />
				AIが分析中… (約30-60秒)
			</div>
		);
	}

	if (state.kind === "error") {
		return (
			<div className="mt-2 p-2 rounded-md bg-rose-50 border border-rose-200 text-[11px] text-rose-700 flex items-start gap-1.5">
				<AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
				<div className="flex-1">
					<div>{state.message}</div>
					<button
						type="button"
						onClick={() => run(false)}
						className="mt-1 underline hover:no-underline"
					>
						再試行
					</button>
				</div>
			</div>
		);
	}

	const a = state.data.analysis;
	const ch = CHANNEL_LABEL[a.recommendedChannel];
	const ChIcon = ch.icon;

	return (
		<div className="mt-2 p-3 rounded-md bg-indigo-50/50 border border-indigo-200 text-xs space-y-2">
			<div className="flex items-center justify-between gap-2 flex-wrap">
				<div className="flex items-center gap-2">
					<span
						className={`inline-flex items-center justify-center w-9 h-9 rounded-full font-bold text-sm ${scoreColor(a.fitScore)}`}
						title="自社販売適合度 (0-100)"
					>
						{a.fitScore}
					</span>
					<span
						className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium ${ch.cls}`}
					>
						<ChIcon size={11} />
						{ch.label}
					</span>
					<span className="text-[10px] text-gray-500">確信度: {a.confidence}</span>
					{state.data.cached && (
						<span className="text-[10px] text-gray-400">(cached)</span>
					)}
				</div>
				<button
					type="button"
					onClick={() => run(true)}
					className="inline-flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-800"
					title="再分析 (キャッシュを無視)"
				>
					<RefreshCw size={10} />
					再分析
				</button>
			</div>

			<p className="text-gray-800 leading-snug">{a.summary}</p>

			<div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
				<div className="bg-white rounded p-2 border border-indigo-100">
					<div className="text-[10px] font-semibold text-indigo-700 mb-1 flex items-center gap-1">
						<CheckCircle2 size={10} /> 推奨販売時期
					</div>
					<div className="text-[11px] text-gray-700 leading-snug">
						{a.recommendedTiming}
					</div>
				</div>
				<div className="bg-white rounded p-2 border border-indigo-100">
					<div className="text-[10px] font-semibold text-indigo-700 mb-1">
						差別化ポイント
					</div>
					<ul className="space-y-0.5">
						{a.differentiation.map((d, i) => (
							<li key={i} className="text-[11px] text-gray-700 leading-snug">
								• {d}
							</li>
						))}
					</ul>
				</div>
			</div>

			{a.risks.length > 0 && (
				<div className="bg-rose-50/60 rounded p-2 border border-rose-100">
					<div className="text-[10px] font-semibold text-rose-700 mb-1 flex items-center gap-1">
						<AlertTriangle size={10} /> リスク
					</div>
					<ul className="space-y-0.5">
						{a.risks.map((r, i) => (
							<li key={i} className="text-[11px] text-gray-700 leading-snug">
								• {r}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
