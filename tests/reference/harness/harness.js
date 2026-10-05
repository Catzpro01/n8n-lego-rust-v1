'use strict';
/**
 * Reference harness for n8n 2.9.4 behaviour.
 *
 * It does NOT re-implement anything. It loads the real published runtime
 * (n8n-core 2.9.1 / n8n-workflow 2.9.1 — the exact versions n8n@2.9.4 pins)
 * and drives:
 *   - WorkflowExecute            (execution-data cases)
 *   - Workflow.expression        (expression cases)
 *
 * Node types used by fixtures are tiny deterministic stand-ins so the tests
 * exercise the ENGINE's data handling (pairing, source, multi-output, binary,
 * parameter resolution) rather than a particular community node.
 */
const path = require('path');
const os = require('os');
// keep the runtime from writing into the real user home
process.env.N8N_USER_FOLDER = process.env.N8N_USER_FOLDER || path.join(os.tmpdir(), 'n8n-ref-harness');
process.env.N8N_LOG_LEVEL = 'silent';

const { WorkflowExecute, normalizeItems } = require('n8n-core');
const { Workflow } = require('n8n-workflow');

function mkType(name, execute, opts = {}) {
	return {
		description: {
			displayName: name, name, group: ['transform'], version: 1, description: '',
			defaults: { name }, inputs: opts.inputs ?? ['main'], outputs: opts.outputs ?? ['main'],
			properties: opts.properties ?? [],
		},
		execute,
	};
}

const strProps = (...names) => names.map((n) => ({ displayName: n, name: n, type: 'string', default: '' }));

/** Deterministic stand-in node types. Names are prefixed `ref.` */
const registry = {
	'n8n-nodes-base.manualTrigger': mkType('manualTrigger', async function () { return [this.getInputData()]; }, { inputs: [] }),
	// returns input untouched (pairedItem already present on input items)
	'ref.passthrough': mkType('passthrough', async function () { return [this.getInputData()]; }),
	// 1:1 mapping but drops pairedItem -> engine must auto-assign
	'ref.mapNoPair': mkType('mapNoPair', async function () {
		return [this.getInputData().map((i) => ({ json: { ...i.json, seen: true } }))];
	}),
	// 1:2 explode WITHOUT pairedItem
	'ref.explodeNoPair': mkType('explodeNoPair', async function () {
		const out = []; this.getInputData().forEach((_, idx) => out.push({ json: { from: idx, part: 0 } }, { json: { from: idx, part: 1 } })); return [out];
	}),
	// 1:2 explode WITH explicit pairedItem
	'ref.explodePaired': mkType('explodePaired', async function () {
		const out = []; this.getInputData().forEach((_, idx) => out.push({ json: { from: idx, part: 0 }, pairedItem: { item: idx } }, { json: { from: idx, part: 1 }, pairedItem: { item: idx } })); return [out];
	}),
	// N:1 aggregate WITHOUT pairedItem
	'ref.aggregate': mkType('aggregate', async function () { return [[{ json: { count: this.getInputData().length } }]]; }),
	// 2 outputs: even index -> output 0, odd -> output 1
	'ref.split2': mkType('split2', async function () {
		const a = [], b = []; this.getInputData().forEach((it, i) => (i % 2 === 0 ? a : b).push({ json: it.json, pairedItem: { item: i } })); return [a, b];
	}, { outputs: ['main', 'main'] }),
	// returns zero items
	'ref.empty': mkType('empty', async function () { return [[]]; }),
	// resolves parameters `value` and `obj` per item and echoes them
	'ref.exprEcho': mkType('exprEcho', async function () {
		const items = this.getInputData(); const out = [];
		for (let i = 0; i < items.length; i++) {
			out.push({ json: { value: this.getNodeParameter('value', i, ''), obj: this.getNodeParameter('obj', i, {}) }, pairedItem: { item: i } });
		}
		return [out];
	}, { properties: strProps('value', 'obj') }),
	// creates binary data per item via helpers.prepareBinaryData
	'ref.binaryCreate': mkType('binaryCreate', async function () {
		const items = this.getInputData(); const out = [];
		for (let i = 0; i < items.length; i++) {
			const bin = await this.helpers.prepareBinaryData(Buffer.from('hello ' + i), 'f' + i + '.txt', 'text/plain');
			out.push({ json: { i }, binary: { data: bin }, pairedItem: { item: i } });
		}
		return [out];
	}),
	// reads binary back via helpers.assertBinaryData / getBinaryDataBuffer
	'ref.binaryRead': mkType('binaryRead', async function () {
		const items = this.getInputData(); const out = [];
		for (let i = 0; i < items.length; i++) {
			const meta = { ...this.helpers.assertBinaryData(i, 'data') }; delete meta.data;
			const buf = await this.helpers.getBinaryDataBuffer(i, 'data');
			out.push({ json: { meta, text: buf.toString() }, pairedItem: { item: i } });
		}
		return [out];
	}),
	'ref.normalizeItems': mkType('normalizeItems', async function () { return [normalizeItems([{ a: 1 }, { a: 2 }])]; }),
	'ref.returnJsonArray': mkType('returnJsonArray', async function () { return [this.helpers.returnJsonArray([{ a: 1 }, { json: { a: 2 } }])]; }),
};

const nodeTypes = {
	getByName: (n) => registry[n],
	getByNameAndVersion: (n) => registry[n],
	getKnownTypes: () => ({}),
};

function buildWorkflow(wfJson) {
	return new Workflow({
		id: wfJson.id ?? 'ref', name: wfJson.name ?? 'ref', nodes: wfJson.nodes, connections: wfJson.connections,
		active: false, nodeTypes, settings: { executionOrder: 'v1', ...(wfJson.settings || {}) }, pinData: wfJson.pinData,
	});
}

function additionalData(executionId) {
	return {
		credentialsHelper: {}, executeWorkflow: async () => { }, restApiUrl: '', instanceBaseUrl: '', webhookBaseUrl: '',
		webhookWaitingBaseUrl: '', webhookTestBaseUrl: '', formWaitingBaseUrl: '', userId: 'ref', variables: {},
		hooks: { runHook: async () => { } }, currentNodeExecutionIndex: 0, executionId,
	};
}

/** Run a workflow through the real WorkflowExecute. */
async function runWorkflow(wfJson, { startItems, mode = 'manual', executionId } = {}) {
	const workflow = buildWorkflow(wfJson);
	const startNode = workflow.getNode(wfJson.startNode ?? wfJson.nodes[0].name);
	const we = new WorkflowExecute(additionalData(executionId), mode);
	const triggerToStartFrom = startItems
		? { name: startNode.name, data: { startTime: 0, executionTime: 0, executionIndex: 0, source: [], data: { main: [startItems] } } }
		: undefined;
	return await we.run({ workflow, startNode, pinData: wfJson.pinData, triggerToStartFrom });
}

/** Evaluate one parameter value through the real Expression/WorkflowDataProxy. */
function evaluate(workflow, ctx, parameterValue) {
	return workflow.expression.getParameterValue(
		parameterValue, ctx.runExecutionData, ctx.runIndex ?? 0, ctx.itemIndex ?? 0, ctx.activeNodeName,
		ctx.connectionInputData ?? [], ctx.mode ?? 'manual', ctx.additionalKeys ?? {}, ctx.executeData,
	);
}

function errorToJson(e) {
	const out = { error: e.constructor.name, message: e.message };
	if (e.context) {
		for (const k of ['type', 'descriptionKey', 'nodeCause', 'parameter']) if (e.context[k] !== undefined) out[k] = e.context[k];
	}
	return out;
}

module.exports = { registry, nodeTypes, buildWorkflow, runWorkflow, evaluate, errorToJson };
