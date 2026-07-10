"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { CheckResultPanel } from "./CheckResultPanel";
import type { CheckWithMeta } from "./CheckResultPanel";
import { ChangeDiffView } from "./ChangeDiffView";
import { RevisionPlanPanel } from "./RevisionPlanPanel";
import type { ScreenplayVersionRow } from "@/lib/screenplay/types";
export type ReviewTab = "check" | "diff" | "refine";

interface Props {
	screenplayId: string;
	version: ScreenplayVersionRow;
	versions: ScreenplayVersionRow[];
	initialCheck: CheckWithMeta | null;
	initialCheckVersionId: string | null;
	isGenerating: boolean;
	activeTab: ReviewTab;
	onTabChange: (t: ReviewTab) => void;
	onRefineStart: (runId: string) => void;
	onJumpToLine?: (line: number) => void;
	onCheckChange?: (check: CheckWithMeta | null) => void;
	onJumpToQuote?: (quote: string) => void;
	onApplyRewrite?: (quote: string, rewrite: string) => void;
}

export function ReviewPanel({
	screenplayId, version, versions, initialCheck, initialCheckVersionId,
	isGenerating, activeTab, onTabChange, onRefineStart, onJumpToLine,
	onCheckChange, onJumpToQuote, onApplyRewrite,
}: Props) {
	const t = useTranslations("screenplay");
	const [findingCount, setFindingCount] = useState<number | null>(() =>
		initialCheck
			? initialCheck.legal.length + initialCheck.facts.length + initialCheck.quality.length
			: null,
	);
	// At least one OTHER version exists → there is something to diff against
	// (the base it was refined from, or any earlier 稿 the operator picks).
	const canDiff = versions.some((v) => v.id !== version.id);

	function handleCheckChange(c: CheckWithMeta | null) {
		setFindingCount(c ? c.legal.length + c.facts.length + c.quality.length : null);
		onCheckChange?.(c);
	}
	const tabs: { id: ReviewTab; label: string }[] = [
		{ id: "check", label: `放送レビュー${findingCount != null && findingCount > 0 ? ` (${findingCount})` : ""}` },
		{ id: "diff", label: "変更内容" },
		{ id: "refine", label: "変更を依頼" },
	];

	return (
		<div className="flex flex-col gap-3">
			<div role="tablist" aria-label="台本レビュー" className="sticky top-0 z-10 grid h-8 w-full grid-cols-3 items-center rounded-lg bg-muted p-[3px] text-muted-foreground">
				{tabs.map((tab) => (
					<button
						key={tab.id}
						type="button"
						role="tab"
						aria-selected={activeTab === tab.id}
						onClick={() => onTabChange(tab.id)}
						className={`h-full rounded-md border border-transparent px-1.5 text-xs font-medium whitespace-nowrap transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${activeTab === tab.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
					>
						{tab.label}
					</button>
				))}
			</div>

			<div role="tabpanel" hidden={activeTab !== "check"}>
				<CheckResultPanel
					screenplayId={screenplayId}
					versionId={version.id}
					versionLabel={`第 ${version.version_number} 稿`}
					initialCheck={initialCheck}
					initialCheckVersionId={initialCheckVersionId}
					onCheckChange={handleCheckChange}
					onJumpToQuote={onJumpToQuote}
					onApplyRewrite={onApplyRewrite}
				/>
			</div>

			{activeTab === "diff" && <div role="tabpanel">
				{canDiff ? (
					<ChangeDiffView
						key={version.id}
						versions={versions.map((v) => ({ id: v.id, version_number: v.version_number, markdown: v.markdown }))}
						currentVersionId={version.id}
						currentMarkdown={version.markdown}
						canonicalBaseId={version.base_version_id}
						screenplayId={screenplayId}
						onJumpToLine={onJumpToLine}
					/>
				) : (
					<div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
						{t("review.noDiffFirstDraft")}
					</div>
				)}
			</div>}

			{activeTab === "refine" && <div role="tabpanel">
				<RevisionPlanPanel
					screenplayId={screenplayId}
					versionId={version.id}
					markdown={version.markdown}
					disabled={isGenerating}
					onRefineStart={onRefineStart}
				/>
			</div>}
		</div>
	);
}
