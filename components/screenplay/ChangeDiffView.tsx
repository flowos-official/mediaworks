"use client";
import { useEffect, useMemo, useState } from "react";
import { Loader2, Lightbulb, CornerUpLeft } from "lucide-react";
import { computeLineDiff } from "@/lib/screenplay/diff";
import type { HunkReason } from "@/lib/screenplay/types";

interface VersionLite {
	id: string;
	version_number: number;
	markdown: string;
}

interface Props {
	versions: VersionLite[];
	currentVersionId: string;
	currentMarkdown: string;
	/** The version this draft was refined FROM (base_version_id) — the only base
	 *  the server has AI rationale for. null on the very first draft. */
	canonicalBaseId: string | null;
	screenplayId: string;
	/** Jump the rendered script (left pane) to a 0-based source line. */
	onJumpToLine?: (line: number) => void;
}

// Display-only markdown noise reduction. The diff is still COMPUTED on the raw
// markdown (so hunk ordinals stay aligned with the server-side AI rationale);
// here we only strip the syntax that turns prose into noise when rendering each
// line — headings, bold, list bullets, blockquotes, table pipes, hr.
function stripInline(t: string): string {
	return t
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/__(.+?)__/g, "$1")
		.replace(/`([^`]+)`/g, "$1");
}
function cleanForDisplay(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed === "") return "";
	if (/^[-*_]{3,}$/.test(trimmed)) return "—"; // horizontal rule
	if (trimmed.startsWith("|") && trimmed.includes("|")) {
		const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
		if (/^[\s:|-]+$/.test(inner)) return ""; // table separator row
		return inner
			.split("|")
			.map((c) => stripInline(c.trim()))
			.filter(Boolean)
			.join("　/　");
	}
	let t = raw.replace(/^\s*#{1,6}\s+/, ""); // heading marker
	t = t.replace(/^\s*>\s?/, ""); // blockquote
	t = t.replace(/^(\s*)([-*+●○※]|\d+\.)\s+/, "$1・"); // list marker → bullet
	return stripInline(t);
}

export function ChangeDiffView({
	versions,
	currentVersionId,
	currentMarkdown,
	canonicalBaseId,
	screenplayId,
	onJumpToLine,
}: Props) {
	const candidates = useMemo(
		() =>
			versions
				.filter((v) => v.id !== currentVersionId)
				.sort((a, b) => a.version_number - b.version_number),
		[versions, currentVersionId],
	);

	// Default comparison base: the 改稿元 if it's a real version, else the nearest
	// earlier 稿, else any other 稿. (Component is keyed by version id upstream, so
	// this useState initializer re-runs with the right default on every switch.)
	const defaultBaseId = useMemo(() => {
		if (canonicalBaseId && candidates.some((c) => c.id === canonicalBaseId)) return canonicalBaseId;
		const cur = versions.find((v) => v.id === currentVersionId);
		const lower = cur ? candidates.filter((c) => c.version_number < cur.version_number) : candidates;
		if (lower.length) return lower[lower.length - 1].id;
		return candidates.length ? candidates[candidates.length - 1].id : null;
	}, [candidates, canonicalBaseId, versions, currentVersionId]);

	const [baseId, setBaseId] = useState<string | null>(defaultBaseId);
	const effectiveBaseId = baseId ?? defaultBaseId;
	const isCanonical = effectiveBaseId != null && effectiveBaseId === canonicalBaseId;

	const baseMarkdown = useMemo(
		() => versions.find((v) => v.id === effectiveBaseId)?.markdown ?? "",
		[versions, effectiveBaseId],
	);
	const hunks = useMemo(
		() => computeLineDiff(baseMarkdown, currentMarkdown),
		[baseMarkdown, currentMarkdown],
	);

	const [reasons, setReasons] = useState<Record<number, string>>({});
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		// Reset synchronously before the async fetch so a previous base's reasons
		// never render against this comparison's hunks (indices are positional).
		// eslint-disable-next-line react-hooks/set-state-in-effect -- intentional synchronous reset
		setReasons({});
		// AI rationale exists only for the canonical (改稿元) comparison — the server
		// computes it against base_version_id. Skip the fetch for any other base.
		if (!isCanonical || hunks.length === 0) {
			setLoading(false);
			return;
		}
		let cancelled = false;
		setLoading(true);
		fetch(`/api/screenplays/${screenplayId}/versions/${currentVersionId}/changes`, { cache: "no-store" })
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
			.then((j: { rationale?: HunkReason[] }) => {
				if (cancelled) return;
				const m: Record<number, string> = {};
				for (const x of j.rationale ?? []) m[x.index] = x.reason;
				setReasons(m);
			})
			.catch(() => {
				/* diff still renders; reasons just stay empty */
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [screenplayId, currentVersionId, effectiveBaseId, isCanonical, hunks.length]);

	const labelOf = (id: string | null) => {
		const v = versions.find((x) => x.id === id);
		return v ? `第 ${v.version_number} 稿` : "—";
	};

	if (candidates.length === 0 || effectiveBaseId == null) {
		return <p className="text-sm text-muted-foreground py-10 text-center">比較できる他のバージョンがありません。</p>;
	}

	return (
		<div className="space-y-4">
			{/* 比較元 selector — makes the comparison target explicit (replaces the
			    ambiguous "直前バージョン" wording for branched histories). */}
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<label htmlFor="diff-base" className="text-muted-foreground shrink-0">比較元</label>
				<select
					id="diff-base"
					value={effectiveBaseId}
					onChange={(e) => setBaseId(e.target.value)}
					className="border border-border rounded-lg px-2 py-1 bg-card text-foreground"
				>
					{candidates.map((c) => (
						<option key={c.id} value={c.id}>
							第 {c.version_number} 稿{c.id === canonicalBaseId ? "（改稿元）" : ""}
						</option>
					))}
				</select>
				<span className="text-muted-foreground whitespace-nowrap">→ {labelOf(currentVersionId)}</span>
			</div>

			{!isCanonical && (
				<p className="text-[11px] text-muted-foreground bg-muted/50 border border-border rounded-lg px-3 py-2">
					改稿元以外との比較です。AIによる変更理由は表示されません。
				</p>
			)}

			{hunks.length === 0 ? (
				<p className="text-sm text-muted-foreground py-10 text-center">{labelOf(effectiveBaseId)} との差分はありません。</p>
			) : (
				<div className="space-y-5">
					{hunks.map((h) => (
						<div key={h.index} className="rounded-lg border border-border overflow-hidden">
							<div className="px-3 py-2 bg-muted/50 border-b border-border flex items-center gap-2 text-xs">
								{isCanonical ? (
									reasons[h.index] ? (
										<>
											<Lightbulb size={13} className="text-amber-500 shrink-0" />
											<span className="text-foreground">{reasons[h.index]}</span>
										</>
									) : loading ? (
										<span className="inline-flex items-center gap-1 text-muted-foreground">
											<Loader2 size={11} className="animate-spin" />
											理由を生成中…
										</span>
									) : (
										<>
											<Lightbulb size={13} className="text-amber-500 shrink-0" />
											<span className="text-muted-foreground">文体・表現の調整</span>
										</>
									)
								) : (
									<span className="text-muted-foreground">変更箇所 {h.index + 1}</span>
								)}
								{onJumpToLine && typeof h.newStart === "number" && (
									<button
										type="button"
										onClick={() => onJumpToLine(h.newStart!)}
										title="台本の該当箇所へ移動"
										className="ml-auto inline-flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 hover:underline shrink-0"
									>
										<CornerUpLeft size={11} /> 本文へ
									</button>
								)}
							</div>
							<pre className="text-xs leading-relaxed overflow-x-auto p-3 m-0 font-mono whitespace-pre-wrap">
								{h.lines.map((l, i) => {
									const display = cleanForDisplay(l.text);
									return (
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
											{display || " "}
										</div>
									);
								})}
							</pre>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
