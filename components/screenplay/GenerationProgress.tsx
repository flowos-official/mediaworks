// components/screenplay/GenerationProgress.tsx
"use client";

import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, AlertTriangle, Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { ProgressEvent } from "@/lib/screenplay/types";

interface Props {
	runId: string;
	onComplete: (versionId: string, versionNumber: number) => void;
}

export function GenerationProgress({ runId, onComplete }: Props) {
	const [events, setEvents] = useState<ProgressEvent[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [doneAt, setDoneAt] = useState<{ versionId: string; versionNumber: number } | null>(null);
	const [startedAt] = useState<number>(() => Date.now());
	const [now, setNow] = useState<number>(() => Date.now());

	useEffect(() => {
		if (doneAt || error) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [doneAt, error]);

	useEffect(() => {
		const controller = new AbortController();
		let cancelled = false;

		async function consume() {
			try {
				const res = await fetch(`/api/screenplays/run/${runId}/stream`, { signal: controller.signal });
				if (!res.body) throw new Error("ストリームが利用できません");
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buf = "";
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					const lines = buf.split("\n");
					buf = lines.pop() ?? "";
					for (const line of lines) {
						const t = line.trim();
						if (!t) continue;
						try {
							const ev = JSON.parse(t) as ProgressEvent;
							if (cancelled) return;
							setEvents((prev) => [...prev, ev]);
							if (ev.type === "done") {
								setDoneAt({ versionId: ev.versionId, versionNumber: ev.versionNumber });
								onComplete(ev.versionId, ev.versionNumber);
							} else if (ev.type === "error") {
								setError(ev.message);
							}
						} catch {
							// ignore
						}
					}
				}
			} catch (err) {
				if (controller.signal.aborted) return;
				const msg = err instanceof Error ? err.message : String(err);
				try {
					for (let i = 0; i < 60 && !cancelled; i++) {
						await new Promise((r) => setTimeout(r, 5000));
						const sr = await fetch(`/api/screenplays/run/${runId}/status`);
						if (!sr.ok) continue;
						const sj = (await sr.json()) as { status: string; returnValue?: { versionId: string; versionNumber: number } };
						if (sj.status === "completed" && sj.returnValue) {
							setDoneAt({ versionId: sj.returnValue.versionId, versionNumber: sj.returnValue.versionNumber });
							onComplete(sj.returnValue.versionId, sj.returnValue.versionNumber);
							return;
						}
						if (sj.status === "failed") {
							setError("生成に失敗しました");
							return;
						}
					}
					setError(`接続が切れました: ${msg}`);
				} catch (fallbackErr) {
					setError(`接続エラー: ${msg} / ${String(fallbackErr)}`);
				}
			}
		}

		void consume();
		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [runId, onComplete]);

	const lastChunk = [...events].reverse().find((e) => e.type === "chunk") as { type: "chunk"; chars: number } | undefined;
	const elapsedSec = Math.floor((now - startedAt) / 1000);
	const min = Math.floor(elapsedSec / 60).toString().padStart(2, "0");
	const sec = (elapsedSec % 60).toString().padStart(2, "0");
	const chars = lastChunk?.chars ?? 0;
	const pctTarget = error ? 0 : doneAt ? 100 : Math.min(95, Math.floor((chars / 45000) * 100));

	return (
		<Card className="border-gray-200">
			<CardContent className="p-5">
				<div className="flex items-start gap-3">
					<div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
						error ? "bg-red-50" : doneAt ? "bg-green-50" : "bg-blue-50"
					}`}>
						{error ? (
							<AlertTriangle size={18} className="text-red-600" />
						) : doneAt ? (
							<CheckCircle2 size={18} className="text-green-600" />
						) : (
							<Sparkles size={18} className="text-blue-600 animate-pulse" />
						)}
					</div>
					<div className="flex-1 min-w-0">
						<div className="flex items-center justify-between gap-3">
							<h3 className="text-sm font-semibold text-gray-900">
								{error ? "生成に失敗しました" : doneAt ? `第 ${doneAt.versionNumber} 稿を生成しました` : "台本を生成中"}
							</h3>
							{!error && !doneAt && (
								<span className="text-xs text-gray-500 tabular-nums">
									{min}:{sec}
								</span>
							)}
						</div>
						<p className="text-xs text-gray-500 mt-0.5">
							{error
								? error
								: doneAt
								? "改稿フィードバックを送信すると、引き続き磨き込めます。"
								: "テレ東スタイルの台本を執筆中です。深く考えながら執筆するため、約2〜6分かかります。ページを閉じても処理は継続します。"}
						</p>

						{!error && !doneAt && (
							<div className="mt-3">
								<div className="flex items-center justify-between text-[11px] text-gray-500 mb-1.5">
									<span>{chars > 0 ? `${chars.toLocaleString()} 文字を受信` : "接続中..."}</span>
									<span className="tabular-nums">{pctTarget}%</span>
								</div>
								<div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
									<div
										className="h-full bg-blue-500 rounded-full transition-[width] duration-700 ease-out"
										style={{ width: `${Math.max(pctTarget, 5)}%` }}
									/>
								</div>
							</div>
						)}
					</div>
					{!error && !doneAt && (
						<Loader2 size={16} className="animate-spin text-blue-600 flex-shrink-0" />
					)}
				</div>
			</CardContent>
		</Card>
	);
}
