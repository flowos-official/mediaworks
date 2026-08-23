import { ArrowRight, Database, GitFork, RadioTower, Sparkles } from "lucide-react";
import { getTranslations } from "next-intl/server";
import type { CSSProperties } from "react";
import { Badge } from "@/components/ui/badge";
import {
	DataFlowSankey,
	type DataFlowSankeyCopy,
	type LocalizedDataFlowNode,
} from "@/components/pipeline/DataFlowSankey";
import { buildSankeyData } from "@/lib/pipeline/data-intelligence-graph";

interface NodeCopy {
	title: string;
	description: string;
	fields: string[];
}

export async function DataIntelligenceFlow() {
	const t = await getTranslations("pipeline.vision");
	const graph = buildSankeyData();
	const nodes: LocalizedDataFlowNode[] = graph.nodes.map((node) => {
		const nodeCopy = t.raw(`nodes.${node.id}`) as NodeCopy;
		return {
			id: node.id,
			stage: node.stage,
			status: node.status,
			name: nodeCopy.title,
			description: nodeCopy.description,
			fields: [...nodeCopy.fields],
		};
	});
	const copy: DataFlowSankeyCopy = {
		stageLabels: {
			source: t("stages.source"),
			dataset: t("stages.dataset"),
			outcome: t("stages.outcome"),
		},
		statusLabels: {
			current: t("status.current"),
			planned: t("status.planned"),
		},
		conceptWeight: t("conceptWeight"),
		scrollHint: t("scrollHint"),
		selectHint: t("selectHint"),
		fieldsTitle: t("inspector.fieldsTitle"),
		upstreamTitle: t("inspector.upstreamTitle"),
		downstreamTitle: t("inspector.downstreamTitle"),
		noUpstream: t("inspector.noUpstream"),
		noDownstream: t("inspector.noDownstream"),
		diagramTitle: t("diagramTitle"),
		diagramA11y: t("diagramA11y"),
	};

	return (
		<article
			className="mw-panel overflow-hidden"
			aria-labelledby="data-intelligence-flow-title"
			style={{ "--data-flow-current": "#059669", "--data-flow-planned": "#64748b" } as CSSProperties}
		>
			<header className="relative overflow-hidden border-b border-border bg-primary/[0.035] px-4 py-5 sm:px-5 lg:px-6">
				<div className="pointer-events-none absolute -right-16 -top-20 size-52 rounded-full bg-primary/10 blur-3xl" aria-hidden="true" />
				<div className="relative flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
					<div className="max-w-3xl">
						<div className="flex flex-wrap items-center gap-2">
							<div className="mw-kicker">{t("kicker")}</div>
							<Badge variant="outline" className="border-primary/25 bg-primary/10 text-primary">
								<Sparkles data-icon="inline-start" />
								{t("previewBadge")}
							</Badge>
						</div>
						<h2 id="data-intelligence-flow-title" className="mt-2 text-lg font-bold tracking-[-0.025em] text-foreground sm:text-xl">
							{t("title")}
						</h2>
						<p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground sm:text-sm">{t("description")}</p>
					</div>
					<div className="flex shrink-0 flex-wrap gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
						<span className="inline-flex items-center gap-1.5">
							<span className="h-0.5 w-5 rounded-full" style={{ backgroundColor: "var(--data-flow-current)" }} aria-hidden="true" />
							{t("legendCurrent")}
						</span>
						<span className="inline-flex items-center gap-1.5">
							<span className="w-5 border-t-2 border-dashed" style={{ borderColor: "var(--data-flow-planned)" }} aria-hidden="true" />
							{t("legendPlanned")}
						</span>
					</div>
				</div>
			</header>

			<DataFlowSankey nodes={nodes} links={graph.links} copy={copy} />

			<footer className="grid items-center gap-2 border-t border-border bg-card px-4 py-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:px-6">
				<div className="flex items-center justify-center gap-2 text-xs font-semibold text-foreground">
					<RadioTower size={15} className="text-primary" aria-hidden="true" />
					{t("footer.collect")}
				</div>
				<ArrowRight size={14} className="mx-auto hidden text-primary/60 sm:block" aria-hidden="true" />
				<div className="flex items-center justify-center gap-2 text-xs font-semibold text-foreground">
					<Database size={15} className="text-primary" aria-hidden="true" />
					{t("footer.dataset")}
				</div>
				<GitFork size={14} className="mx-auto hidden text-primary/60 sm:block" aria-hidden="true" />
				<div className="flex items-center justify-center gap-2 text-xs font-semibold text-foreground">
					<Sparkles size={15} className="text-primary" aria-hidden="true" />
					{t("footer.outcome")}
				</div>
			</footer>
		</article>
	);
}
