/**
 * Persistence LEGO — reference tests (n8n 2.9.4)
 *  - flatted wire format for execution_data.data (real `flatted` from the runtime)
 *  - execution status vocabulary/transition golden
 *  - workflow save/load rules recorded live (baseline-before.json)
 *  - optional live replay incl. direct SQLite inspection (N8N_URL + N8N_SQLITE_PATH)
 * Run: node --test tests/reference/agent-4/persistence/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasRuntime, n8nRequire, golden, here, LIVE, live, liveLogin, stripStack } from '../helpers.ts';

const skipUnit = { skip: hasRuntime ? false : 'N8N_RUNTIME not available' };
const baseline = JSON.parse(readFileSync(resolve(here, 'live', 'baseline-before.json'), 'utf8'));
const g = golden('execution-status');

test('Persistence: execution run data is stored as flatted (not JSON) and round-trips shared references', skipUnit, () => {
	const flatted = n8nRequire('flatted');
	const item = { json: { a: 1 } };
	const runData = {
		startData: {},
		resultData: { runData: { Trigger: [{ data: { main: [[item]] } }], Code: [{ data: { main: [[item]] }, source: [{ previousNode: 'Trigger' }] }] }, lastNodeExecuted: 'Code' },
		executionData: { contextData: {}, nodeExecutionStack: [], waitingExecution: {}, waitingExecutionSource: {} },
	};
	// INPUT: IRunExecutionData → EXPECTED OUTPUT: flatted string (JSON array of nodes, index refs)
	const wire: string = flatted.stringify(runData);
	assert.equal(wire[0], '[');
	const outer = JSON.parse(wire);
	assert.ok(Array.isArray(outer), 'flatted top level is an array of nodes');
	assert.equal(typeof outer[0].resultData, 'string', 'nested objects are referenced by stringified index');
	assert.notDeepEqual(JSON.parse(wire), runData, 'plain JSON.parse does NOT yield the run data');
	const back = flatted.parse(wire);
	assert.deepEqual(back, runData);
	assert.equal(back.resultData.runData.Trigger[0].data.main[0][0], back.resultData.runData.Code[0].data.main[0][0], 'shared object identity preserved');
	// ERROR: corrupt payload
	assert.throws(() => flatted.parse('{"not":"flatted"}'));
});

test('Persistence golden: execution status vocabulary and transitions', () => {
	assert.deepEqual(g.statusVocabulary, ['new', 'running', 'success', 'error', 'crashed', 'canceled', 'waiting', 'unknown']);
	const byInput = Object.fromEntries(g.transitions.map((t: any) => [t.input, t]));
	assert.equal(byInput['ActiveExecutions.add → ExecutionPersistence.create'].expected.status, 'new');
	assert.equal(byInput['regular mode: setRunning(id)'].expected.status, 'running');
	assert.deepEqual(byInput['workflowExecuteAfter, no error, no waitTill'].expected, { status: 'success', finished: true, stoppedAt: 'now' });
	assert.equal(byInput['workflowExecuteAfter, resultData.error set'].expected.status, 'error');
	assert.equal(byInput['workflowExecuteAfter, waitTill set'].expected.status, 'waiting');
	assert.equal(byInput['flatted.parse of corrupt execution_data.data'].error, 'CorruptedExecutionDataError');
});

test('Persistence golden: execution save/load observed live (manual, webhook, trigger modes)', () => {
	assert.deepEqual(baseline.steps.manualRun.bodyKeys, ['executionId']);
	assert.equal(baseline.steps.manualRun.executionStatus, 'success');
	assert.equal(baseline.steps.manualRun.mode, 'manual');
	assert.equal(baseline.steps.oneNode.dataIsFlattedString, true);
	assert.deepEqual(baseline.steps.oneNode.output, [{ json: {}, pairedItem: { item: 0 } }]);
	const e = baseline.steps.executionRecorded;
	assert.deepEqual(e.responseKeys, g.liveObserved.getExecutionResponseKeys);
	assert.deepEqual(e.workflowDataKeys, g.liveObserved.workflowDataSnapshotKeys);
	assert.deepEqual(e.db.row, { id: e.db.row.id, status: 'success', mode: 'webhook', finished: 1, workflowId: e.workflowId });
	assert.equal(e.db.data.len, 1782);
	assert.equal(g.liveObserved.scheduleRun.final.mode, 'trigger');
});

test('Persistence golden: workflow save/load rules (versionId bump, duplicate id, not found, archive-before-delete)', () => {
	assert.deepEqual(baseline.steps.workflowSave, { settingsOnly: { status: 200, versionChanged: false }, nodesChanged: { status: 200, versionChanged: true }, historyCount: 2 });
	assert.deepEqual(baseline.steps.workflowLoad, { status: 200, nodes: 1 });
	assert.equal(baseline.steps.workflowCreateDuplicateId.status, 400);
	assert.equal(baseline.steps.workflowCreateDuplicateId.message, 'Workflow with id wf-linear exists already.');
	assert.equal(stripStack(baseline.steps.workflowNotFound.body).message, 'Could not load the workflow - you can only access workflows owned by you');
	const api = golden('api');
	assert.equal(api.cases.workflowDuplicateName.expected.status, 200, 'no unique name constraint');
	assert.equal(api.cases.workflowDelete.expected.body.message, 'Workflow must be archived before it can be deleted.');
	assert.equal(api.cases.workflowCreateEmpty.expected.idLength, 16);
	assert.equal(api.cases.workflowCreateEmpty.expected.versionCounter, 1);
});

test('Persistence live: save → load → status, versionId semantics, SQLite rows', { skip: LIVE ? false : 'N8N_URL not set' }, async () => {
	await liveLogin();
	const nodes = [{ id: 'm1', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }];
	const created = await live('POST', '/rest/workflows', { name: `Agent4 persistence ${Date.now()}`, nodes, connections: {}, settings: { executionOrder: 'v1' } });
	assert.equal(created.status, 200);
	const w = created.json.data;
	assert.equal(w.versionCounter, 1);
	// settings-only update keeps versionId
	const u1 = await live('PATCH', `/rest/workflows/${w.id}`, { versionId: w.versionId, settings: { ...w.settings, timezone: 'UTC' } });
	assert.equal(u1.status, 200);
	assert.equal(u1.json.data.versionId, w.versionId);
	// node change bumps versionId
	const u2 = await live('PATCH', `/rest/workflows/${w.id}`, { versionId: u1.json.data.versionId, nodes: [...nodes, { id: 'c1', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: { jsCode: 'return [{json:{ok:true}}];' } }], connections: { Manual: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } } });
	assert.equal(u2.status, 200);
	assert.notEqual(u2.json.data.versionId, w.versionId);
	const loaded = await live('GET', `/rest/workflows/${w.id}`);
	assert.equal(loaded.json.data.nodes.length, 2);
	// execution save/load/status
	const run = await live('POST', `/rest/workflows/${w.id}/run`, { workflowData: loaded.json.data, startNodes: [], triggerToStartFrom: { name: 'Manual' } });
	assert.equal(run.status, 200);
	const execId = run.json.data.executionId;
	let ex: any;
	for (let i = 0; i < 30; i++) {
		ex = await live('GET', `/rest/executions/${execId}`);
		if (ex.json?.data?.status && ex.json.data.status !== 'running' && ex.json.data.status !== 'new') break;
		await new Promise((r) => setTimeout(r, 300));
	}
	assert.equal(ex.json.data.status, 'success');
	assert.equal(ex.json.data.mode, 'manual');
	assert.equal(typeof ex.json.data.data, 'string');
	const bad = await live('GET', '/rest/executions/abc');
	assert.deepEqual(stripStack(bad.json), { code: 400, message: 'Execution ID is not a number' });
	if (process.env.N8N_SQLITE_PATH) {
		const { DatabaseSync } = await import('node:sqlite');
		const db = new DatabaseSync(process.env.N8N_SQLITE_PATH, { readOnly: true });
		const row = db.prepare('select status, mode, finished from execution_entity where id = ?').get(Number(execId));
		assert.deepEqual({ ...row }, { status: 'success', mode: 'manual', finished: 1 });
		const hist: any = db.prepare('select count(*) as c from workflow_history where workflowId = ?').get(w.id);
		assert.equal(hist.c, 2);
		db.close();
	}
	await live('POST', `/rest/workflows/${w.id}/archive`, {});
	await live('DELETE', `/rest/workflows/${w.id}`);
});
