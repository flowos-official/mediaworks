"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BookOpenText, FileText, ListTree, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { summarizeReadiness } from "@/lib/screenplay/readiness";
import type { ProductBrief, ScreenplayRow, ScreenplayVersionRow } from "@/lib/screenplay/types";
import type { ScriptCheckResult } from "@/lib/screenplay/compliance/types";
import { GenerationProgress } from "./GenerationProgress";
import { ScreenplayHeaderBar } from "./ScreenplayHeaderBar";
import { ScreenplayViewer } from "./ScreenplayViewer";
import { ScreenplayEditor } from "./ScreenplayEditor";
import { ScreenplayNavigator } from "./ScreenplayNavigator";
import { ReviewPanel, type ReviewTab } from "./ReviewPanel";
import type { CheckWithMeta } from "./CheckResultPanel";
import type { ExistingProductOption } from "./ScreenplayProductPicker";

interface Props {
	initialScreenplay: ScreenplayRow;
	initialVersions: ScreenplayVersionRow[];
	latestCheck?: (ScriptCheckResult & { created_at?: string; lexicon_version?: string; is_auto?: boolean }) | null;
	initialCheckVersionId?: string | null;
	availableProducts?: ExistingProductOption[];
}

type MobilePane = "navigator" | "script" | "review";

function pad(value: number, width: number): string {
	return value.toString().padStart(width, "0");
}

function findFlexibleQuoteRange(markdown: string, quote: string): [number, number] | null {
	const exactStart = markdown.indexOf(quote);
	if (exactStart >= 0) return [exactStart, exactStart + quote.length];

	const ignored = new Set(["●", "○", "■", "#", "*", "_", ">"]);
	const normalize = (value: string, withMap: boolean) => {
		let text = "";
		const map: number[] = [];
		for (let index = 0; index < value.length; index++) {
			const character = value[index];
			if (/\s/u.test(character) || ignored.has(character)) continue;
			text += character;
			if (withMap) map.push(index);
		}
		return { text, map };
	};
	const source = normalize(markdown, true);
	const target = normalize(quote, false).text;
	if (!target) return null;
	const normalizedStart = source.text.indexOf(target);
	if (normalizedStart < 0) return null;
	const start = source.map[normalizedStart];
	const end = source.map[normalizedStart + target.length - 1];
	return start === undefined || end === undefined ? null : [start, end + 1];
}

export function ScreenplayWorkspace({
	initialScreenplay,
	initialVersions,
	latestCheck,
	initialCheckVersionId = null,
	availableProducts = [],
}: Props) {
	const router = useRouter();
	const search = useSearchParams();
	const [screenplay, setScreenplay] = useState(initialScreenplay);
	const [versions, setVersions] = useState(initialVersions);
	const [selectedId, setSelectedId] = useState<string | null>(
		initialScreenplay.current_version_id ?? initialVersions[initialVersions.length - 1]?.id ?? null,
	);
	const initialRun =
		search.get("run") ??
		(initialScreenplay.status === "generating" && initialScreenplay.last_run_id
			? initialScreenplay.last_run_id
			: null);
	const [runId, setRunId] = useState<string | null>(initialRun);
	const [runVariant, setRunVariant] = useState<"generate" | "import">(
		search.get("kind") === "import" && initialRun ? "import" : "generate",
	);
	const [activeReviewTab, setActiveReviewTab] = useState<ReviewTab>("check");
	const [activeCheck, setActiveCheck] = useState<CheckWithMeta | null>(
		initialScreenplay.current_version_id === initialCheckVersionId ? latestCheck ?? null : null,
	);
	const [editing, setEditing] = useState(false);
	const [draftMarkdown, setDraftMarkdown] = useState("");
	const [saveBusy, setSaveBusy] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [mobilePane, setMobilePane] = useState<MobilePane>("script");

	useEffect(() => {
		if (runId || initialScreenplay.status !== "generating") return;
		let stopped = false;
		void (async () => {
			for (let attempt = 0; attempt < 5 && !stopped; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 1500));
				const response = await fetch(`/api/screenplays/${initialScreenplay.id}`, { cache: "no-store" });
				if (!response.ok) continue;
				const payload = (await response.json()) as { screenplay: ScreenplayRow; versions: ScreenplayVersionRow[] };
				setScreenplay(payload.screenplay);
				if (payload.screenplay.last_run_id && payload.screenplay.status === "generating") {
					setRunId(payload.screenplay.last_run_id);
					return;
				}
				if (payload.screenplay.status === "ready" || payload.screenplay.status === "failed") {
					setVersions(payload.versions);
					setSelectedId(payload.screenplay.current_version_id ?? payload.versions.at(-1)?.id ?? null);
					return;
				}
			}
		})();
		return () => {
			stopped = true;
		};
	}, [runId, initialScreenplay.id, initialScreenplay.status]);

	async function refreshDetail(newSelectedId?: string): Promise<{
		screenplay: ScreenplayRow;
		versions: ScreenplayVersionRow[];
	} | null> {
		const response = await fetch(`/api/screenplays/${initialScreenplay.id}`, { cache: "no-store" });
		if (!response.ok) return null;
		const payload = (await response.json()) as { screenplay: ScreenplayRow; versions: ScreenplayVersionRow[] };
		setScreenplay(payload.screenplay);
		setVersions(payload.versions);
		setSelectedId(
			newSelectedId ?? payload.screenplay.current_version_id ?? payload.versions.at(-1)?.id ?? null,
		);
		return payload;
	}

	async function handleComplete(versionId: string) {
		setRunId(null);
		const payload = await refreshDetail(versionId);
		const version = payload?.versions.find((item) => item.id === versionId);
		setActiveCheck(null);
		setActiveReviewTab(version?.base_version_id ? "diff" : "check");
		setEditing(false);
		const params = new URLSearchParams(search);
		params.delete("run");
		params.delete("kind");
		router.replace(params.size > 0 ? `?${params.toString()}` : "?");
	}

	function handleRefineStart(newRunId: string) {
		setRunVariant("generate");
		setRunId(newRunId);
		setEditing(false);
	}

	const selectedIndex = versions.findIndex((version) => version.id === selectedId);
	const selected = selectedIndex >= 0 ? versions[selectedIndex] : null;
	const previous = selectedIndex > 0 ? versions[selectedIndex - 1] : null;
	const next = selectedIndex >= 0 && selectedIndex < versions.length - 1 ? versions[selectedIndex + 1] : null;
	const isGenerating = Boolean(runId);
	const readiness = summarizeReadiness(screenplay.status, activeCheck);
	const selectVersion = useCallback((versionId: string) => {
		setEditing(false);
		setSaveError(null);
		setSelectedId(versionId);
	}, []);

	const goPrevious = useCallback(() => {
		if (previous) selectVersion(previous.id);
	}, [previous, selectVersion]);
	const goNext = useCallback(() => {
		if (next) selectVersion(next.id);
	}, [next, selectVersion]);

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			const target = event.target as HTMLElement | null;
			const tag = target?.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
			if (!(event.metaKey || event.ctrlKey)) return;
			if (event.key === "ArrowLeft") {
				event.preventDefault();
				goPrevious();
			} else if (event.key === "ArrowRight") {
				event.preventDefault();
				goNext();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [goNext, goPrevious]);

	const scriptRef = useRef<HTMLElement>(null);
	const jumpToLine = useCallback((line: number) => {
		setMobilePane("script");
		requestAnimationFrame(() => {
			const root = scriptRef.current;
			if (!root) return;
			const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-md-line]"));
			let best: HTMLElement | null = null;
			for (const node of nodes) {
				const currentLine = Number(node.dataset.mdLine);
				if (Number.isNaN(currentLine)) continue;
				if (currentLine <= line) best = node;
				else break;
			}
			const target = best ?? nodes[0];
			if (!target) return;
			target.scrollIntoView({ behavior: "smooth", block: "center" });
			target.animate(
				[
					{ backgroundColor: "rgba(220,38,38,0.16)", outline: "2px solid rgba(220,38,38,0.35)" },
					{ backgroundColor: "transparent", outline: "2px solid transparent" },
				],
				{ duration: 1600, easing: "ease-out" },
			);
		});
	}, []);

	const jumpToQuote = useCallback(
		(quote: string) => {
			if (!selected) return;
			const range = findFlexibleQuoteRange(selected.markdown, quote);
			const position = range?.[0] ?? 0;
			const line = selected.markdown.slice(0, position).split(/\r?\n/).length - 1;
			jumpToLine(line);
		},
		[jumpToLine, selected],
	);

	function startEditing(markdown?: string, notice?: string) {
		if (!selected) return;
		setMobilePane("script");
		setDraftMarkdown(markdown ?? selected.markdown);
		setSaveError(notice ?? null);
		setEditing(true);
	}

	function applySuggestedRewrite(quote: string, rewrite: string) {
		if (!selected) return;
		const range = findFlexibleQuoteRange(selected.markdown, quote);
		if (!range) {
			startEditing(
				selected.markdown,
				"指摘箇所を一意に特定できませんでした。右の修正案を確認し、本文へ手動で反映してください。",
			);
			return;
		}
		const [start, end] = range;
		const updated =
			selected.markdown.slice(0, start) +
			rewrite +
			selected.markdown.slice(end);
		startEditing(updated);
		requestAnimationFrame(() => scriptRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
	}

	async function saveManualVersion() {
		if (!selected) return;
		setSaveBusy(true);
		setSaveError(null);
		try {
			const response = await fetch(`/api/screenplays/${screenplay.id}/versions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					markdown: draftMarkdown,
					baseVersionId: selected.id,
					feedback: "本文を直接編集",
				}),
			});
			const payload = (await response.json()) as { versionId?: string; error?: string };
			if (!response.ok || !payload.versionId) {
				throw new Error(payload.error ?? "保存できませんでした");
			}
			await refreshDetail(payload.versionId);
			setActiveCheck(null);
			setActiveReviewTab("check");
			setEditing(false);
		} catch (cause) {
			setSaveError(cause instanceof Error ? cause.message : "保存できませんでした");
		} finally {
			setSaveBusy(false);
		}
	}

	function handleProductLinked(productId: string, brief: ProductBrief) {
		setScreenplay((current) => ({
			...current,
			product_id: productId,
			product_info_snapshot: brief,
		}));
		setActiveCheck(null);
		setActiveReviewTab("check");
	}

	return (
		<div>
			{selected && (
				<ScreenplayHeaderBar
					markdown={selected.markdown}
					title={screenplay.title}
					versionLabel={`第 ${selected.version_number} 稿`}
					createdAt={selected.created_at}
					hasPrev={Boolean(previous)}
					hasNext={Boolean(next)}
					onPrev={goPrevious}
					onNext={goNext}
					prevLabel={previous ? `v${pad(previous.version_number, 2)}` : undefined}
					nextLabel={next ? `v${pad(next.version_number, 2)}` : undefined}
					readiness={readiness}
					onEdit={() => (editing ? setEditing(false) : startEditing())}
					editing={editing}
				/>
			)}

			<div className="sticky top-16 z-20 mb-3 grid grid-cols-3 gap-1 rounded-xl border border-border bg-background/95 p-1 shadow-sm backdrop-blur lg:hidden">
				{([
					{ id: "navigator" as const, label: "構成・根拠", icon: ListTree },
					{ id: "script" as const, label: "台本", icon: BookOpenText },
					{ id: "review" as const, label: `考査${readiness.total ? ` ${readiness.total}` : ""}`, icon: ShieldCheck },
				]).map((item) => {
					const Icon = item.icon;
					const active = mobilePane === item.id;
					return (
						<button
							key={item.id}
							type="button"
							onClick={() => setMobilePane(item.id)}
							className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium transition ${active ? "bg-blue-600 text-white shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
						>
							<Icon size={13} /> {item.label}
						</button>
					);
				})}
			</div>

			<div className="grid grid-cols-1 gap-4 lg:grid-cols-[210px_minmax(0,1fr)_minmax(360px,410px)] xl:grid-cols-[225px_minmax(0,1fr)_minmax(390px,430px)]">
				<aside className={`${mobilePane === "navigator" ? "block" : "hidden"} self-start lg:sticky lg:top-[9.75rem] lg:block lg:max-h-[calc(100vh-10.5rem)] lg:overflow-y-auto`}>
					{selected && (
						<ScreenplayNavigator
							screenplayId={screenplay.id}
							markdown={selected.markdown}
							brief={screenplay.product_info_snapshot}
							productId={screenplay.product_id}
							products={availableProducts}
							versions={versions}
							selectedId={selectedId}
							check={activeCheck}
							onSelectVersion={selectVersion}
							onJumpToLine={jumpToLine}
							onProductLinked={handleProductLinked}
						/>
					)}
				</aside>

				<section ref={scriptRef} className={`${mobilePane === "script" ? "block" : "hidden"} min-w-0 self-start lg:sticky lg:top-[9.75rem] lg:block lg:max-h-[calc(100vh-10.5rem)] lg:overflow-y-auto`}>
					{isGenerating && runId && (
						<div className="mb-4">
							<GenerationProgress
								runId={runId}
								onComplete={(versionId) => void handleComplete(versionId)}
								variant={runVariant}
							/>
						</div>
					)}
					{selected ? (
						editing ? (
							<ScreenplayEditor
								value={draftMarkdown}
								onChange={setDraftMarkdown}
								onSave={() => void saveManualVersion()}
								onCancel={() => setEditing(false)}
								busy={saveBusy}
								error={saveError}
							/>
						) : (
							<ScreenplayViewer markdown={selected.markdown} />
						)
					) : !isGenerating ? (
						<Card className="border-dashed border-border">
							<CardContent className="flex flex-col items-center justify-center py-16 text-center">
								<FileText size={24} className="mb-3 text-muted-foreground" />
								<p className="text-sm font-medium text-foreground">まだ台本がありません</p>
							</CardContent>
						</Card>
					) : null}
				</section>

				<aside className={`${mobilePane === "review" ? "block" : "hidden"} min-h-0 self-start lg:sticky lg:top-[9.75rem] lg:block lg:max-h-[calc(100vh-10.5rem)] lg:overflow-y-auto`}>
					{selected ? (
						<ReviewPanel
							key={`${selected.id}-${screenplay.product_id ?? "unlinked"}`}
							screenplayId={screenplay.id}
							version={selected}
							versions={versions}
							initialCheck={screenplay.product_id === initialScreenplay.product_id ? latestCheck ?? null : null}
							initialCheckVersionId={screenplay.product_id === initialScreenplay.product_id ? initialCheckVersionId : null}
							isGenerating={isGenerating}
							activeTab={activeReviewTab}
							onTabChange={setActiveReviewTab}
							onRefineStart={handleRefineStart}
							onJumpToLine={jumpToLine}
							onCheckChange={setActiveCheck}
							onJumpToQuote={jumpToQuote}
							onApplyRewrite={applySuggestedRewrite}
						/>
					) : (
						<Card className="border-border">
							<CardContent className="p-5 text-center text-xs text-muted-foreground">
								台本ができると放送レビューが表示されます
							</CardContent>
						</Card>
					)}
				</aside>
			</div>
		</div>
	);
}
