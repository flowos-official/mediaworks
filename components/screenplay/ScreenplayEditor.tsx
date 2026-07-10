"use client";

import { Save, X, ShieldCheck } from "lucide-react";

interface Props {
	value: string;
	onChange: (value: string) => void;
	onSave: () => void;
	onCancel: () => void;
	busy: boolean;
	error: string | null;
}

export function ScreenplayEditor({ value, onChange, onSave, onCancel, busy, error }: Props) {
	return (
		<section className="overflow-hidden rounded-xl border border-blue-500/40 bg-[#f3f6fa] text-slate-950 shadow-sm dark:bg-[#eef2f7] dark:text-slate-950">
			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-300/80 bg-white/75 px-4 py-3">
				<div>
					<div className="text-sm font-semibold">本文を直接編集</div>
					<div className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-600">
						<ShieldCheck size={11} /> 保存すると新しい稿になり、放送レビューは未チェックに戻ります
					</div>
				</div>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={onCancel}
						disabled={busy}
						className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
					>
						<X size={13} /> 取消
					</button>
					<button
						type="button"
						onClick={onSave}
						disabled={busy || value.trim().length < 100}
						className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
					>
						<Save size={13} /> {busy ? "保存中…" : "新しい稿として保存"}
					</button>
				</div>
			</div>
			<textarea
				value={value}
				onChange={(event) => onChange(event.target.value)}
				spellCheck={false}
				aria-label="台本Markdownを編集"
				className="min-h-[calc(100vh-15rem)] w-full resize-none bg-transparent px-5 py-5 font-mono text-[13px] leading-7 text-slate-900 outline-none"
			/>
			<div className="flex items-center justify-between gap-3 border-t border-slate-300/80 bg-white/75 px-4 py-2 text-[11px] text-slate-600">
				<span>{error ? <span className="text-red-700">{error}</span> : "Markdown構造を保持したまま編集してください"}</span>
				<span className="font-mono tabular-nums">{value.length.toLocaleString()} chars</span>
			</div>
		</section>
	);
}

