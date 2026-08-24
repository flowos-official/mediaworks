import assert from "node:assert/strict";
import {
	DATA_FLOW_LINKS,
	DATA_FLOW_NODES,
	buildSankeyData,
	getConnectedNodeIds,
} from "../lib/pipeline/data-intelligence-graph";

const stageCounts = { source: 0, dataset: 0, outcome: 0 };
for (const node of DATA_FLOW_NODES) stageCounts[node.stage] += 1;
assert.equal(stageCounts.source, 4, "the graph should expose four collection sources");
assert.equal(stageCounts.dataset, 5, "the graph should explain five generated datasets");
assert.equal(stageCounts.outcome, 6, "the graph should explain six present/future outcomes");

assert.deepEqual(
	Object.fromEntries(DATA_FLOW_NODES.map((node) => [node.id, `${node.stage}:${node.status}`])),
	{
		sourceProductOffer: "source:current",
		sourceBroadcastSchedule: "source:current",
		sourceMediaArchive: "source:current",
		sourceChannelCategory: "source:current",
		datasetProductMaster: "dataset:current",
		datasetOfferHistory: "dataset:current",
		datasetBroadcastSignals: "dataset:current",
		datasetSceneIndex: "dataset:planned",
		datasetSellingLanguage: "dataset:current",
		outcomeDiscovery: "outcome:current",
		outcomeSourcingPriority: "outcome:current",
		outcomeResearch: "outcome:current",
		outcomeEvidenceScript: "outcome:current",
		outcomeCompetitiveScript: "outcome:current",
		outcomeDemoPlan: "outcome:planned",
	},
	"the approved current/planned boundary should not drift",
);

const nodeById = new Map(DATA_FLOW_NODES.map((node) => [node.id, node]));
for (const link of DATA_FLOW_LINKS) {
	assert.ok(link.value > 0, `${link.source} → ${link.target} should use a positive conceptual weight`);
	const source = nodeById.get(link.source);
	const target = nodeById.get(link.target);
	assert.ok(source, `link source ${link.source} should exist`);
	assert.ok(target, `link target ${link.target} should exist`);
	assert.ok(
		(source.stage === "source" && target.stage === "dataset") ||
			(source.stage === "dataset" && target.stage === "outcome"),
		`${link.source} → ${link.target} should advance exactly one stage`,
	);
	if (link.status === "current") {
		assert.equal(source.status, "current", `current link source ${source.id} should be current`);
		assert.equal(target.status, "current", `current link target ${target.id} should be current`);
	}
	if (source.status === "planned") {
		assert.equal(link.status, "planned", `planned dataset ${source.id} must not emit a current link`);
	}
}

for (const node of DATA_FLOW_NODES) {
	assert.ok(node.fieldKeys.length >= 2, `${node.id} should explain at least two example fields`);
	if (node.stage !== "dataset") continue;
	const connected = getConnectedNodeIds(node.id);
	assert.ok(connected.upstream.length > 0, `${node.id} should have an upstream source`);
	assert.ok(connected.downstream.length > 0, `${node.id} should have a downstream outcome`);
}

assert.deepEqual(getConnectedNodeIds("datasetProductMaster"), {
	upstream: ["sourceProductOffer", "sourceChannelCategory"],
	downstream: ["outcomeDiscovery", "outcomeSourcingPriority", "outcomeResearch", "outcomeEvidenceScript"],
});

const sankey = buildSankeyData();
assert.equal(sankey.nodes[0]?.id, "sourceProductOffer");
assert.deepEqual(sankey.links[0], { source: 0, target: 4, value: 4, status: "current" });
assert.deepEqual(sankey.links.at(-1), { source: 8, target: 14, value: 2, status: "planned" });

console.log("PASS: data intelligence graph model");
