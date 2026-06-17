"use client";
import { useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CheckResultPanel } from "./CheckResultPanel";
import type { CheckWithMeta } from "./CheckResultPanel";
import { ChangeDiffView } from "./ChangeDiffView";
import { FeedbackForm } from "./FeedbackForm";
import type { ScreenplayVersionRow } from "@/lib/screenplay/types";
export type ReviewTab = "check" | "diff" | "refine";

interface Props {
	screenplayId: string;
	version: ScreenplayVersionRow;
	baseMarkdown?: string;
	initialCheck: CheckWithMeta | null;
	initialCheckVersionId: string | null;
	isGenerating: boolean;
	activeTab: ReviewTab;
	onTabChange: (t: ReviewTab) => void;
	onRefineStart: (runId: string) => void;
}

export function ReviewPanel({
	screenplayId, version, baseMarkdown, initialCheck, initialCheckVersionId,
	isGenerating, activeTab, onTabChange, onRefineStart,
}: Props) {
	const [findingCount, setFindingCount] = useState<number | null>(null);
	const canDiff = !!(baseMarkdown && version.base_version_id);

	function handleCheckChange(c: CheckWithMeta | null) {
		setFindingCount(c ? c.legal.length + c.facts.length + c.quality.length : null);
	}

	return (
		<Tabs value={activeTab} onValueChange={(v) => onTabChange(v as ReviewTab)} className="gap-3">
			<TabsList className="w-full sticky top-0 z-10">
				<TabsTrigger value="check">
					試験結果{findingCount != null && findingCount > 0 ? ` (${findingCount})` : ""}
				</TabsTrigger>
				<TabsTrigger value="diff">変更点</TabsTrigger>
				<TabsTrigger value="refine">改稿</TabsTrigger>
			</TabsList>

			<TabsContent value="check" keepMounted>
				<CheckResultPanel
					screenplayId={screenplayId}
					versionId={version.id}
					initialCheck={initialCheck}
					initialCheckVersionId={initialCheckVersionId}
					onCheckChange={handleCheckChange}
				/>
			</TabsContent>

			<TabsContent value="diff">
				{canDiff ? (
					<ChangeDiffView
						baseMarkdown={baseMarkdown!}
						markdown={version.markdown}
						screenplayId={screenplayId}
						versionId={version.id}
					/>
				) : (
					<div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
						初稿のため比較対象がありません。
					</div>
				)}
			</TabsContent>

			<TabsContent value="refine">
				<FeedbackForm
					screenplayId={screenplayId}
					baseVersionId={version.id}
					disabled={isGenerating}
					onStart={onRefineStart}
				/>
			</TabsContent>
		</Tabs>
	);
}
