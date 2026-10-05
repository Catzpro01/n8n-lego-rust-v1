'use strict';
/**
 * Connection LEGO probes against the real n8n-workflow@2.9.1.
 * Pure functions from packages/workflow/src/common/**, graph/**, connections-diff.ts,
 * plus the Workflow methods that consume them (read-only, owned by Agent 1).
 */
const { Workflow, mapConnectionsByDestination, getParentNodes, getChildNodes, getConnectedNodes } = require('n8n-workflow');
const G = require('n8n-workflow/dist/cjs/graph/graph-utils.js');
const { compareConnections } = require('n8n-workflow/dist/cjs/connections-diff.js');
// generic node type stub: every fixture node is a plain 1-in/1-out transform node,
// except names starting with 'Trigger' which have no inputs (so getStartNode can pick them).
const generic = (name) => ({ description: { displayName: name, name, group: ['transform'], version: 1, description: '', defaults: {}, inputs: name.startsWith('Trigger') ? [] : ['main'], outputs: ['main'], properties: [] } });
const nodeTypes = { getByName: (n) => generic(n), getByNameAndVersion: (n) => generic(n), getKnownTypes: () => ({}) };

const setToArr = (v) => (v instanceof Set ? [...v] : v);
const plain = (v) => JSON.parse(JSON.stringify(v, (_, x) => (x instanceof Set ? [...x] : x instanceof Map ? Object.fromEntries(x) : x)));

function runConnectionCase(c) {
	const conn = c.connections;
	const byDest = mapConnectionsByDestination(conn);
	const adj = G.buildAdjacencyList(conn);
	const wf = c.nodes
		? new Workflow({ id: 'conn', name: 'conn', nodes: c.nodes.map((n) => ({ ...n, type: n.name })), connections: conn, active: false, nodeTypes, settings: {} })
		: null;
	const out = {};
	for (const p of c.probes) {
		let v;
		try {
			switch (p.op) {
				case 'byDestination': v = p.node ? byDest[p.node] : byDest; break;
				case 'getChildNodes': v = getChildNodes(conn, p.node, p.type, p.depth); break;
				case 'getParentNodes': v = getParentNodes(byDest, p.node, p.type, p.depth); break;
				case 'getConnectedNodes': v = getConnectedNodes(conn, p.node, p.type, p.depth); break;
				case 'adjacencyKeys': v = [...adj.keys()]; break;
				case 'getRootNodes': v = G.getRootNodes(new Set(p.graph), adj); break;
				case 'getLeafNodes': v = G.getLeafNodes(new Set(p.graph), adj); break;
				case 'getInputEdges': v = G.getInputEdges(new Set(p.graph), adj); break;
				case 'getOutputEdges': v = G.getOutputEdges(new Set(p.graph), adj); break;
				case 'hasPath': v = G.hasPath(p.start, p.end, adj); break;
				case 'parseExtractable': v = G.parseExtractableSubgraphSelection(new Set(p.graph), adj); break;
				case 'compareConnections': v = compareConnections(conn, p.next); break;
				case 'wf.getNodeConnectionIndexes': v = wf.getNodeConnectionIndexes(p.node, p.parent, p.type); break;
				case 'wf.getHighestNode': v = wf.getHighestNode(p.node); break;
				case 'wf.getStartNode': v = wf.getStartNode(p.node)?.name ?? null; break;
				case 'wf.getParentMainInputNode': v = wf.getParentMainInputNode(wf.getNode(p.node)).name; break;
				case 'wf.getParentNodesByDepth': v = wf.getParentNodesByDepth(p.node, p.depth); break;
				default: v = { harnessError: 'unknown op ' + p.op };
			}
			v = v === undefined ? { undefined: true } : plain(setToArr(v));
		} catch (e) { v = { error: e.constructor.name, message: e.message }; }
		out[p.name] = v;
	}
	return out;
}
module.exports = { runConnectionCase };
