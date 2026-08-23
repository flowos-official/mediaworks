"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import { Check, CircleDashed, Database, Info, MoveHorizontal } from "lucide-react";
import {
	ResponsiveContainer,
	Sankey,
	type SankeyLinkProps,
	type SankeyNodeProps,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import type { DataFlowStage, DataFlowStatus } from "@/lib/pipeline/data-intelligence-graph";

export interface LocalizedDataFlowNode {
	id: string;
	stage: DataFlowStage;
	status: DataFlowStatus;
	name: string;
	description: string;
	fields: string[];
}

export interface LocalizedDataFlowLink {
	source: number;
	target: number;
	value: number;
	status: DataFlowStatus;
}

export interface DataFlowSankeyCopy {
	stageLabels: Record<DataFlowStage, string>;
	statusLabels: Record<DataFlowStatus, string>;
	conceptWeight: string;
	scrollHint: string;
	selectHint: string;
	fieldsTitle: string;
	upstreamTitle: string;
	downstreamTitle: string;
	noUpstream: string;
	noDownstream: string;
	diagramTitle: string;
	diagramA11y: string;
}

interface DataFlowSankeyProps {
	nodes: LocalizedDataFlowNode[];
	links: LocalizedDataFlowLink[];
	copy: DataFlowSankeyCopy;
}

type ChartNodePayload = SankeyNodeProps["payload"] & LocalizedDataFlowNode;
type ChartLinkPayload = SankeyLinkProps["payload"] & { status: DataFlowStatus };

const STAGE_COLORS: Record<DataFlowStage, string> = {
	source: "var(--chart-1)",
	dataset: "var(--chart-4)",
	outcome: "var(--chart-2)",
};

function StatusBadge({ status, label }: { status: DataFlowStatus; label: string }) {
	const Icon = status === "current" ? Check : CircleDashed;

	return (
		<Badge
			variant="outline"
			className={status === "current"
				? "border-emerald-600/25 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300"
				: "border-dashed border-muted-foreground/35 bg-muted/70 text-muted-foreground"}
		>
			<Icon data-icon="inline-start" />
			{label}
		</Badge>
	);
}

function FlowNode({
	x,
	y,
	width,
	height,
	payload,
	selected,
	stageLabel,
	statusLabel,
	onNodeSelect,
}: SankeyNodeProps & {
	selected: boolean;
	stageLabel: string;
	statusLabel: string;
	onNodeSelect: (id: string) => void;
}) {
	const node = payload as ChartNodePayload;
	const stageColor = STAGE_COLORS[node.stage];
	const planned = node.status === "planned";
	const label = `${node.name}, ${stageLabel}, ${statusLabel}`;

	const handleKeyDown = (event: KeyboardEvent<SVGGElement>) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		onNodeSelect(node.id);
	};

	return (
		<g
			role="button"
			tabIndex={0}
			aria-label={label}
			aria-pressed={selected}
			className="cursor-pointer outline-none"
			onClick={() => onNodeSelect(node.id)}
			onFocus={() => onNodeSelect(node.id)}
			onKeyDown={handleKeyDown}
		>
			{selected && (
				<rect
					x={x - 3}
					y={y - 3}
					width={width + 6}
					height={height + 6}
					rx={15}
					fill="none"
					stroke="var(--ring)"
					strokeWidth={3}
					aria-hidden="true"
				/>
			)}
			<rect
				x={x}
				y={y}
				width={width}
				height={height}
				rx={12}
				fill={planned ? "var(--card)" : stageColor}
				stroke={stageColor}
				strokeWidth={planned ? 2 : 1}
				strokeDasharray={planned ? "6 4" : undefined}
			/>
			<circle
				cx={x + width - 12}
				cy={y + 12}
				r={4}
				fill={planned ? "var(--card)" : "#fff"}
				stroke={planned ? stageColor : "rgba(255,255,255,0.45)"}
				strokeWidth={planned ? 2 : 1}
				aria-hidden="true"
			/>
			<foreignObject x={x + 8} y={y + 4} width={Math.max(0, width - 26)} height={Math.max(0, height - 8)}>
				<div
					className="flex size-full items-center text-[11px] font-bold leading-[1.25] tracking-[-0.02em]"
					style={{ color: planned ? "var(--foreground)" : "white" }}
				>
					<span className="line-clamp-2">{node.name}</span>
				</div>
			</foreignObject>
		</g>
	);
}

function FlowLink({
	sourceX,
	targetX,
	sourceY,
	targetY,
	sourceControlX,
	targetControlX,
	linkWidth,
	payload,
}: SankeyLinkProps) {
	const planned = (payload as ChartLinkPayload).status === "planned";
	const path = `M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`;

	return (
		<path
			d={path}
			fill="none"
			stroke={planned ? "var(--data-flow-planned)" : "var(--data-flow-current)"}
			strokeWidth={Math.max(linkWidth, 2)}
			strokeOpacity={planned ? 0.32 : 0.24}
			strokeDasharray={planned ? "8 7" : undefined}
			strokeLinecap="round"
		/>
	);
}

export function DataFlowSankey({ nodes, links, copy }: DataFlowSankeyProps) {
	const [selectedId, setSelectedId] = useState("datasetProductMaster");
	const selectedNode = nodes.find((node) => node.id === selectedId) ?? nodes[0];

	const connections = useMemo(() => {
		if (!selectedNode) return { upstream: [], downstream: [] };
		const selectedIndex = nodes.findIndex((node) => node.id === selectedNode.id);
		return {
			upstream: links
				.filter((link) => link.target === selectedIndex)
				.map((link) => nodes[link.source])
				.filter((node): node is LocalizedDataFlowNode => Boolean(node)),
			downstream: links
				.filter((link) => link.source === selectedIndex)
				.map((link) => nodes[link.target])
				.filter((node): node is LocalizedDataFlowNode => Boolean(node)),
		};
	}, [links, nodes, selectedNode]);

	if (!selectedNode) return null;

	return (
		<div className="bg-muted/[0.12]">
			<div className="border-b border-border px-4 py-3 sm:px-6">
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
					<p className="flex items-start gap-2 text-[11px] leading-5 text-muted-foreground sm:text-xs">
						<Info size={14} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
						{copy.conceptWeight}
					</p>
					<p className="text-[11px] font-medium text-muted-foreground">{copy.selectHint}</p>
				</div>
			</div>

			<section aria-labelledby="data-flow-diagram-title" className="relative overflow-hidden border-b border-border">
				<h3 id="data-flow-diagram-title" className="sr-only">{copy.diagramTitle}</h3>
				<p className="sr-only">{copy.diagramA11y}</p>
				<div className="overflow-x-auto overscroll-x-contain">
					<div className="min-w-[980px]">
						<div className="grid grid-cols-3 border-b border-border/70 bg-card/65 px-6 py-2.5 text-center font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
							<span>01 · {copy.stageLabels.source}</span>
							<span>02 · {copy.stageLabels.dataset}</span>
							<span>03 · {copy.stageLabels.outcome}</span>
						</div>
						<div className="h-[620px] bg-[radial-gradient(circle_at_center,color-mix(in_oklab,var(--primary)_7%,transparent),transparent_58%)]">
							<ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 1, height: 1 }}>
								<Sankey
								data={{ nodes, links }}
								nodeWidth={148}
								nodePadding={16}
								linkCurvature={0.54}
								iterations={48}
								margin={{ top: 22, right: 28, bottom: 22, left: 28 }}
								sort={false}
								node={(props) => {
									const node = props.payload as ChartNodePayload;
									return (
										<FlowNode
											{...props}
											selected={node.id === selectedNode.id}
											stageLabel={copy.stageLabels[node.stage]}
											statusLabel={copy.statusLabels[node.status]}
											onNodeSelect={setSelectedId}
										/>
									);
								}}
								link={(props) => <FlowLink {...props} />}
								/>
							</ResponsiveContainer>
						</div>
					</div>
				</div>
				<div className="flex items-center justify-center gap-2 border-t border-border/70 bg-card/65 px-4 py-2 text-[11px] text-muted-foreground xl:hidden">
					<MoveHorizontal size={14} aria-hidden="true" />
					{copy.scrollHint}
				</div>
			</section>

			<section className="grid gap-4 bg-card px-4 py-5 lg:grid-cols-[1.1fr_0.9fr_1fr] lg:px-6" aria-live="polite">
				<div>
					<div className="flex flex-wrap items-center gap-2">
						<span className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
							<Database size={17} aria-hidden="true" />
						</span>
						<Badge variant="outline" className="border-border bg-muted/60 text-muted-foreground">
							{copy.stageLabels[selectedNode.stage]}
						</Badge>
						<StatusBadge status={selectedNode.status} label={copy.statusLabels[selectedNode.status]} />
					</div>
					<h3 className="mt-3 text-base font-bold tracking-[-0.02em] text-foreground">{selectedNode.name}</h3>
					<p className="mt-1.5 text-xs leading-5 text-muted-foreground">{selectedNode.description}</p>
				</div>

				<div className="rounded-2xl border border-border bg-muted/35 p-4">
					<h4 className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{copy.fieldsTitle}</h4>
					<div className="mt-3 flex flex-wrap gap-2">
						{selectedNode.fields.map((field) => (
							<span key={field} className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-foreground shadow-sm">
								{field}
							</span>
						))}
					</div>
				</div>

				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
					<ConnectionList title={copy.upstreamTitle} nodes={connections.upstream} emptyLabel={copy.noUpstream} />
					<ConnectionList title={copy.downstreamTitle} nodes={connections.downstream} emptyLabel={copy.noDownstream} />
				</div>
			</section>
		</div>
	);
}

function ConnectionList({
	title,
	nodes,
	emptyLabel,
}: {
	title: string;
	nodes: LocalizedDataFlowNode[];
	emptyLabel: string;
}) {
	return (
		<div className="rounded-2xl border border-border p-3.5">
			<h4 className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{title}</h4>
			{nodes.length > 0 ? (
				<ul className="mt-2.5 space-y-2">
					{nodes.map((node) => (
						<li key={node.id} className="flex items-start gap-2 text-[11px] font-medium leading-4 text-foreground">
							<span className="mt-1 size-1.5 shrink-0 rounded-full" style={{ background: STAGE_COLORS[node.stage] }} aria-hidden="true" />
							{node.name}
						</li>
					))}
				</ul>
			) : (
				<p className="mt-2.5 text-[11px] leading-4 text-muted-foreground">{emptyLabel}</p>
			)}
		</div>
	);
}
