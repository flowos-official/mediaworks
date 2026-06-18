"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { FileText } from "lucide-react";
import { GenerationProgress } from "./GenerationProgress";
import { VersionTimeline } from "./VersionTimeline";
import { ScreenplayHeaderBar } from "./ScreenplayHeaderBar";
import { ScreenplayViewer } from "./ScreenplayViewer";
import { ReviewPanel, type ReviewTab } from "./ReviewPanel";
import type { ScreenplayRow, ScreenplayVersionRow } from "@/lib/screenplay/types";
import type { ScriptCheckResult } from "@/lib/screenplay/compliance/types";

interface Props {
	initialScreenplay: ScreenplayRow;
	initialVersions: ScreenplayVersionRow[];
	latestCheck?: (ScriptCheckResult & { created_at?: string; lexicon_version?: string }) | null;
	initialCheckVersionId?: string | null;
}

function pad(n: number, w: number): string {
	return n.toString().padStart(w, "0");
}

export function ScreenplayWorkspace({ initialScreenplay, initialVersions, latestCheck, initialCheckVersionId = null }: Props) {
	const router = useRouter();
	const search = useSearchParams();
	const [versions, setVersions] = useState(initialVersions);
	const [selectedId, setSelectedId] = useState<string | null>(
		initialScreenplay.current_version_id ?? initialVersions[initialVersions.length - 1]?.id ?? null,
	);
	// Refresh-safe: if the URL has no ?run= but the screenplay is currently
	// generating, reattach to the stored last_run_id so the user sees progress
	// even after a page reload.
	const initialRun =
		search.get("run") ??
		(initialScreenplay.status === "generating" && initialScreenplay.last_run_id
			? initialScreenplay.last_run_id
			: null);
	const [runId, setRunId] = useState<string | null>(initialRun);
	// Captured into state (not read from the URL each render): a later refine from
	// the same page must NOT inherit the persistent ?kind=import.
	const [runVariant, setRunVariant] = useState<"generate" | "import">(
		search.get("kind") === "import" && initialRun ? "import" : "generate",
	);
	const [activeReviewTab, setActiveReviewTab] = useState<ReviewTab>("check");

	// Belt-and-suspenders: if mounting with no runId but screenplay is still
	// generating, poll the screenplay row briefly to pick up the run as it
	// becomes available (race between create POST and detail page nav).
	useEffect(() => {
		if (runId || initialScreenplay.status !== "generating") return;
		let stop = false;
		(async () => {
			for (let i = 0; i < 5 && !stop; i++) {
				await new Promise((r) => setTimeout(r, 1500));
				const res = await fetch(`/api/screenplays/${initialScreenplay.id}`, { cache: "no-store" });
				if (!res.ok) continue;
				const j = (await res.json()) as { screenplay: ScreenplayRow; versions: ScreenplayVersionRow[] };
				if (j.screenplay.last_run_id && j.screenplay.status === "generating") {
					setRunId(j.screenplay.last_run_id);
					return;
				}
				if (j.screenplay.status === "ready" || j.screenplay.status === "failed") {
					setVersions(j.versions);
					setSelectedId(j.screenplay.current_version_id ?? j.versions[j.versions.length - 1]?.id ?? null);
					return;
				}
			}
		})();
		return () => { stop = true; };
	}, [runId, initialScreenplay.id, initialScreenplay.status]);

	async function refreshListReturning(newSelectedId?: string): Promise<ScreenplayVersionRow[]> {
		const res = await fetch(`/api/screenplays/${initialScreenplay.id}`, { cache: "no-store" });
		if (!res.ok) return versions;
		const j = (await res.json()) as { screenplay: ScreenplayRow; versions: ScreenplayVersionRow[] };
		setVersions(j.versions);
		setSelectedId(newSelectedId ?? j.screenplay.current_version_id ?? j.versions[j.versions.length - 1]?.id ?? null);
		return j.versions;
	}

	async function handleComplete(versionId: string) {
		setRunId(null);
		const list = await refreshListReturning(versionId);
		const v = list.find((x) => x.id === versionId);
		setActiveReviewTab(v?.base_version_id ? "diff" : "check");
		const params = new URLSearchParams(search);
		params.delete("run");
		params.delete("kind");
		router.replace(`?${params.toString()}`);
	}

	function handleRefineStart(newRunId: string) {
		setRunVariant("generate");
		setRunId(newRunId);
	}

	const sorted = versions;
	const selectedIndex = sorted.findIndex((v) => v.id === selectedId);
	const selected = selectedIndex >= 0 ? sorted[selectedIndex] : null;
	const prev = selectedIndex > 0 ? sorted[selectedIndex - 1] : null;
	const next = selectedIndex < sorted.length - 1 && selectedIndex >= 0 ? sorted[selectedIndex + 1] : null;
	const isGenerating = !!runId;

	const goPrev = useCallback(() => {
		if (prev) setSelectedId(prev.id);
	}, [prev]);
	const goNext = useCallback(() => {
		if (next) setSelectedId(next.id);
	}, [next]);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			const t = e.target as HTMLElement | null;
			const tag = t?.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
			if (!(e.metaKey || e.ctrlKey)) return;
			if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); }
			else if (e.key === "ArrowRight") { e.preventDefault(); goNext(); }
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [goPrev, goNext]);

	// Hunk → script jump: scroll the left pane to the block whose source line
	// best matches the hunk's start, then flash it. Blocks carry data-md-line
	// (0-based source line, set by the markdown renderer).
	const scriptRef = useRef<HTMLElement>(null);
	const jumpToLine = useCallback((line: number) => {
		const root = scriptRef.current;
		if (!root) return;
		const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-md-line]"));
		if (nodes.length === 0) return;
		let best: HTMLElement | null = null;
		for (const n of nodes) {
			const l = Number(n.dataset.mdLine);
			if (Number.isNaN(l)) continue;
			if (l <= line) best = n;
			else break;
		}
		const target = best ?? nodes[0];
		target.scrollIntoView({ behavior: "smooth", block: "center" });
		target.animate(
			[{ backgroundColor: "rgba(37,99,235,0.16)" }, { backgroundColor: "transparent" }],
			{ duration: 1400, easing: "ease-out" },
		);
	}, []);

	return (
		<div>
			{selected && (
				<ScreenplayHeaderBar
					markdown={selected.markdown}
					title={initialScreenplay.title}
					versionLabel={`第 ${selected.version_number} 稿`}
					createdAt={selected.created_at}
					hasPrev={!!prev}
					hasNext={!!next}
					onPrev={goPrev}
					onNext={goNext}
					prevLabel={prev ? `v${pad(prev.version_number, 2)}` : undefined}
					nextLabel={next ? `v${pad(next.version_number, 2)}` : undefined}
				/>
			)}

			{/* HISTORY — lg/sm dropdown (hidden at xl), sits above the grid */}
			{versions.length > 1 && (
				<div className="xl:hidden mb-4">
					<label htmlFor="screenplay-version-select" className="text-[11px] font-medium text-muted-foreground mr-2">改稿履歴</label>
					<select
						id="screenplay-version-select"
						value={selectedId ?? ""}
						onChange={(e) => setSelectedId(e.target.value)}
						className="text-sm border border-border rounded-lg px-2 py-1.5 bg-card"
					>
						{versions.map((v) => (
							<option key={v.id} value={v.id}>第 {v.version_number} 稿{v.feedback ? ` — ${v.feedback.slice(0, 24)}` : ""}</option>
						))}
					</select>
				</div>
			)}

			<div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(360px,420px)] xl:grid-cols-[220px_minmax(0,1fr)_minmax(380px,440px)] gap-6">
				{/* HISTORY — xl rail */}
				<aside className="hidden xl:block xl:sticky xl:top-[7rem] self-start xl:max-h-[calc(100vh-8rem)] xl:overflow-y-auto">
					<Card className="border-border">
						<CardContent className="p-4">
							<div className="flex items-center justify-between mb-3">
								<h2 className="text-sm font-semibold text-foreground">改稿履歴</h2>
								<span className="text-[11px] text-muted-foreground">{versions.length}件</span>
							</div>
							{versions.length > 0 ? (
								<VersionTimeline
									versions={versions.map((v) => ({ id: v.id, version_number: v.version_number, feedback: v.feedback, created_at: v.created_at }))}
									selectedId={selectedId}
									onSelect={setSelectedId}
								/>
							) : (
								<p className="text-xs text-muted-foreground py-4 text-center">まだ稿がありません</p>
							)}
							<div className="text-[11px] text-muted-foreground mt-4 pt-3 border-t border-border leading-relaxed">⌘← / ⌘→ で版を移動できます</div>
						</CardContent>
					</Card>
				</aside>

				{/* CENTER — SCRIPT */}
				<section ref={scriptRef} className="min-w-0 lg:sticky lg:top-[7rem] self-start lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto min-h-0">
					{isGenerating && runId && (
						<div className="mb-4">
							<GenerationProgress runId={runId} onComplete={(versionId) => handleComplete(versionId)} variant={runVariant} />
						</div>
					)}
					{selected ? (
						<ScreenplayViewer markdown={selected.markdown} />
					) : !isGenerating ? (
						<Card className="border-border border-dashed">
							<CardContent className="py-16 flex flex-col items-center justify-center text-center">
								<div className="w-14 h-14 bg-muted rounded-full flex items-center justify-center mb-3">
									<FileText size={24} className="text-muted-foreground" />
								</div>
								<p className="text-sm text-foreground font-medium">まだ台本がありません</p>
								<p className="text-xs text-muted-foreground mt-1">右側のフォームから最初の台本を生成してください。</p>
							</CardContent>
						</Card>
					) : null}
				</section>

				{/* RIGHT — REVIEW PANEL */}
				<aside className="lg:sticky lg:top-[7rem] self-start lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto min-h-0">
					{selected ? (
						<ReviewPanel
							screenplayId={initialScreenplay.id}
							version={selected}
							versions={versions}
							initialCheck={latestCheck ?? null}
							initialCheckVersionId={initialCheckVersionId}
							isGenerating={isGenerating}
							activeTab={activeReviewTab}
							onTabChange={setActiveReviewTab}
							onRefineStart={handleRefineStart}
							onJumpToLine={jumpToLine}
						/>
					) : (
						<Card className="border-border">
							<CardContent className="p-5 text-center text-xs text-muted-foreground">最初の台本ができたら、ここで改稿できます。</CardContent>
						</Card>
					)}
				</aside>
			</div>
		</div>
	);
}
