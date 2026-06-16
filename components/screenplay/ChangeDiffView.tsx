"use client";
import { useEffect, useMemo, useState } from "react";
import { Loader2, Lightbulb } from "lucide-react";
import { computeLineDiff } from "@/lib/screenplay/diff";
import type { HunkReason } from "@/lib/screenplay/types";

interface Props {
	baseMarkdown: string;
	markdown: string;
	screenplayId: string;
	versionId: string;
}

export function ChangeDiffView({ baseMarkdown, markdown, screenplayId, versionId }: Props) {
	const hunks = useMemo(() => computeLineDiff(baseMarkdown, markdown), [baseMarkdown, markdown]);
	const [reasons, setReasons] = useState<Record<number, string>>({});
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (hunks.length === 0) return;
		let cancelled = false;
		// eslint-disable-next-line react-hooks/set-state-in-effect -- loading flag set synchronously before async fetch
		setLoading(true);
		fetch(`/api/screenplays/${screenplayId}/versions/${versionId}/changes`, { cache: "no-store" })
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
			.then((j: { rationale?: HunkReason[] }) => {
				if (cancelled) return;
				const m: Record<number, string> = {};
				for (const x of j.rationale ?? []) m[x.index] = x.reason;
				setReasons(m);
			})
			.catch(() => { /* diff still renders; reasons just stay empty */ })
			.finally(() => { if (!cancelled) setLoading(false); });
		return () => { cancelled = true; };
	}, [screenplayId, versionId, hunks.length]);

	if (hunks.length === 0) {
		return <p className="text-sm text-muted-foreground py-10 text-center">直前バージョンとの違いはありません。</p>;
	}

	return (
		<div className="space-y-5">
			{hunks.map((h) => (
				<div key={h.index} className="rounded-lg border border-border overflow-hidden">
					<div className="px-3 py-2 bg-muted/50 border-b border-border flex items-center gap-2 text-xs">
						<Lightbulb size={13} className="text-amber-500 shrink-0" />
						{reasons[h.index] ? (
							<span className="text-foreground">{reasons[h.index]}</span>
						) : loading ? (
							<span className="inline-flex items-center gap-1 text-muted-foreground">
								<Loader2 size={11} className="animate-spin" />
								理由を生成中…
							</span>
						) : (
							<span className="text-muted-foreground">文体・表現の調整</span>
						)}
					</div>
					<pre className="text-xs leading-relaxed overflow-x-auto p-3 m-0 font-mono whitespace-pre-wrap">
						{h.lines.map((l, i) => (
							<div
								key={i}
								className={
									l.type === "added"
										? "bg-green-600/10 text-green-800 dark:text-green-200"
										: l.type === "removed"
										? "bg-red-600/10 text-red-800 dark:text-red-200 line-through"
										: "text-muted-foreground"
								}
							>
								<span className="select-none opacity-60 mr-2">
									{l.type === "added" ? "＋" : l.type === "removed" ? "－" : "　"}
								</span>
								{l.text || " "}
							</div>
						))}
					</pre>
				</div>
			))}
		</div>
	);
}
