export type DataFlowStage = "source" | "dataset" | "outcome";
export type DataFlowStatus = "current" | "planned";

export interface DataFlowNodeDefinition {
	id: string;
	stage: DataFlowStage;
	status: DataFlowStatus;
	fieldKeys: readonly string[];
}

export interface DataFlowLinkDefinition {
	source: string;
	target: string;
	value: number;
	status: DataFlowStatus;
}

export const DATA_FLOW_NODES = [
	{
		id: "sourceProductOffer",
		stage: "source",
		status: "current",
		fieldKeys: ["productName", "price", "offer"],
	},
	{
		id: "sourceBroadcastSchedule",
		stage: "source",
		status: "current",
		fieldKeys: ["airDate", "airTime", "program"],
	},
	{
		id: "sourceMediaArchive",
		stage: "source",
		status: "current",
		fieldKeys: ["video", "audio", "broadcastTimestamp"],
	},
	{
		id: "sourceChannelCategory",
		stage: "source",
		status: "current",
		fieldKeys: ["channel", "category", "sourceUrl"],
	},
	{
		id: "datasetProductMaster",
		stage: "dataset",
		status: "current",
		fieldKeys: ["canonicalProduct", "brand", "categoryMapping", "sourceEvidence"],
	},
	{
		id: "datasetOfferHistory",
		stage: "dataset",
		status: "current",
		fieldKeys: ["observedPrice", "discount", "benefit", "observedAt"],
	},
	{
		id: "datasetBroadcastSignals",
		stage: "dataset",
		status: "current",
		fieldKeys: ["airingFrequency", "timeSlot", "categoryPresence", "channelMix"],
	},
	{
		id: "datasetSceneIndex",
		stage: "dataset",
		status: "planned",
		fieldKeys: ["sceneType", "demoMoment", "productCloseup", "timestamp"],
	},
	{
		id: "datasetSellingLanguage",
		stage: "dataset",
		status: "current",
		fieldKeys: ["sellingPoint", "objectionHandling", "hostPhrase", "proofCue"],
	},
	{
		id: "outcomeDiscovery",
		stage: "outcome",
		status: "current",
		fieldKeys: ["candidateRanking", "trendSignal", "tvFitReason"],
	},
	{
		id: "outcomeSourcingPriority",
		stage: "outcome",
		status: "current",
		fieldKeys: ["priority", "categoryOpportunity", "reviewReason"],
	},
	{
		id: "outcomeResearch",
		stage: "outcome",
		status: "current",
		fieldKeys: ["marketContext", "comparisonEvidence", "offerSummary"],
	},
	{
		id: "outcomeEvidenceScript",
		stage: "outcome",
		status: "current",
		fieldKeys: ["productFact", "scriptSection", "claimEvidence"],
	},
	{
		id: "outcomeCompetitiveScript",
		stage: "outcome",
		status: "current",
		fieldKeys: ["competitorStructurePattern", "sellingPointSequence", "phrasePattern"],
	},
	{
		id: "outcomeDemoPlan",
		stage: "outcome",
		status: "planned",
		fieldKeys: ["demoOrder", "cameraCue", "hostAction"],
	},
] as const satisfies readonly DataFlowNodeDefinition[];

export type DataFlowNodeId = (typeof DATA_FLOW_NODES)[number]["id"];

export const DATA_FLOW_LINKS = [
	{ source: "sourceProductOffer", target: "datasetProductMaster", value: 4, status: "current" },
	{ source: "sourceProductOffer", target: "datasetOfferHistory", value: 3, status: "current" },
	{ source: "sourceBroadcastSchedule", target: "datasetBroadcastSignals", value: 4, status: "current" },
	{ source: "sourceBroadcastSchedule", target: "datasetSceneIndex", value: 1, status: "planned" },
	{ source: "sourceMediaArchive", target: "datasetSceneIndex", value: 4, status: "planned" },
	{ source: "sourceMediaArchive", target: "datasetSellingLanguage", value: 4, status: "current" },
	{ source: "sourceChannelCategory", target: "datasetProductMaster", value: 2, status: "current" },
	{ source: "sourceChannelCategory", target: "datasetBroadcastSignals", value: 2, status: "current" },
	{ source: "datasetProductMaster", target: "outcomeDiscovery", value: 3, status: "current" },
	{ source: "datasetProductMaster", target: "outcomeSourcingPriority", value: 2, status: "current" },
	{ source: "datasetProductMaster", target: "outcomeResearch", value: 2, status: "current" },
	{ source: "datasetProductMaster", target: "outcomeEvidenceScript", value: 2, status: "current" },
	{ source: "datasetOfferHistory", target: "outcomeDiscovery", value: 2, status: "current" },
	{ source: "datasetOfferHistory", target: "outcomeSourcingPriority", value: 2, status: "current" },
	{ source: "datasetOfferHistory", target: "outcomeResearch", value: 2, status: "current" },
	{ source: "datasetOfferHistory", target: "outcomeEvidenceScript", value: 1, status: "current" },
	{ source: "datasetBroadcastSignals", target: "outcomeDiscovery", value: 3, status: "current" },
	{ source: "datasetBroadcastSignals", target: "outcomeSourcingPriority", value: 3, status: "current" },
	{ source: "datasetBroadcastSignals", target: "outcomeResearch", value: 2, status: "current" },
	{ source: "datasetSceneIndex", target: "outcomeCompetitiveScript", value: 3, status: "planned" },
	{ source: "datasetSceneIndex", target: "outcomeDemoPlan", value: 2, status: "planned" },
	{ source: "datasetSellingLanguage", target: "outcomeCompetitiveScript", value: 3, status: "current" },
	{ source: "datasetSellingLanguage", target: "outcomeDemoPlan", value: 2, status: "planned" },
] as const satisfies readonly DataFlowLinkDefinition[];

export function getConnectedNodeIds(nodeId: string): { upstream: string[]; downstream: string[] } {
	return {
		upstream: DATA_FLOW_LINKS.filter((link) => link.target === nodeId).map((link) => link.source),
		downstream: DATA_FLOW_LINKS.filter((link) => link.source === nodeId).map((link) => link.target),
	};
}

export function buildSankeyData(): {
	nodes: DataFlowNodeDefinition[];
	links: Array<{ source: number; target: number; value: number; status: DataFlowStatus }>;
} {
	const nodeIndexes = new Map(DATA_FLOW_NODES.map((node, index) => [node.id, index]));

	return {
		nodes: DATA_FLOW_NODES.map((node) => ({ ...node, fieldKeys: [...node.fieldKeys] })),
		links: DATA_FLOW_LINKS.map((link) => ({
			source: nodeIndexes.get(link.source) ?? -1,
			target: nodeIndexes.get(link.target) ?? -1,
			value: link.value,
			status: link.status,
		})),
	};
}
