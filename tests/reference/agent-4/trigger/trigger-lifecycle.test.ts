/**
 * Trigger LEGO — reference tests (n8n 2.9.4)
 * Drives the real `ActiveWorkflows` + `TriggersAndPollers` classes from
 * n8n-core with stub infrastructure. Golden format: INPUT / EXPECTED OUTPUT /
 * ERROR / SIDE EFFECT in each test title/body.
 *
 * Run:  node --test tests/reference/agent-4/trigger/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRuntime, n8nRequire, fakeLogger, fakeErrorReporter, fakeTracing, fakeWorkflow, golden, LIVE, live, liveLogin } from '../helpers.ts';

const skipUnit = { skip: hasRuntime ? false : 'N8N_RUNTIME (n8n 2.9.4 node_modules) not available' };

function makeSystem() {
	const { ActiveWorkflows } = n8nRequire('n8n-core/dist/execution-engine/active-workflows');
	const { TriggersAndPollers } = n8nRequire('n8n-core/dist/execution-engine/triggers-and-pollers');
	const { ScheduledTaskManager } = n8nRequire('n8n-core/dist/execution-engine/scheduled-task-manager');
	const instanceSettings = { isLeader: true, instanceRole: 'leader' };
	const errorReporter = fakeErrorReporter();
	const stm = new ScheduledTaskManager(instanceSettings, fakeLogger(), { activeInterval: 0 }, errorReporter);
	const aw = new ActiveWorkflows(fakeLogger(), stm, new TriggersAndPollers(), errorReporter, fakeTracing());
	return { aw, stm, instanceSettings, errorReporter };
}

/** Node type whose trigger() records lifecycle events and exposes emit. */
function makeTriggerNodeType(events: string[], opts: { failActivate?: boolean; failClose?: boolean } = {}) {
	let ctx: any;
	return {
		nodeType: {
			description: { name: 'agent4.fakeTrigger', group: ['trigger'] },
			async trigger(this: any) {
				ctx = this;
				events.push('trigger:register');
				if (opts.failActivate) throw new Error('boom on activate');
				return {
					closeFunction: async () => {
						events.push('trigger:close');
						if (opts.failClose) throw new Error('boom on close');
					},
				};
			},
		},
		emit: (data: any) => ctx.emit(data),
	};
}

const nodeTypesFor = (nodeType: any) => ({ getByNameAndVersion: () => nodeType });
const triggerFns = (emitted: any[]) => () => ({ emit: (d: any) => emitted.push(d), emitError() {} });

test('Trigger: register → activate → execute → deactivate (in-process, real ActiveWorkflows)', skipUnit, async () => {
	const { aw } = makeSystem();
	const events: string[] = [];
	const emitted: any[] = [];
	const { nodeType, emit } = makeTriggerNodeType(events);
	const node = { id: 'n1', name: 'Fake Trigger', type: 'agent4.fakeTrigger', typeVersion: 1 };
	const wf = fakeWorkflow({ id: 'wf-trigger-1', triggerNodes: [node], nodeTypes: nodeTypesFor(nodeType) });

	// INPUT: add(workflowId, workflow, additionalData, 'trigger', 'activate', getTriggerFunctions, getPollFunctions)
	await aw.add(wf.id, wf, {}, 'trigger', 'activate', triggerFns(emitted), () => ({}));
	// EXPECTED OUTPUT: workflow becomes active, one trigger response stored
	assert.equal(aw.isActive(wf.id), true);
	assert.deepEqual(aw.allActiveWorkflows(), [wf.id]);
	assert.equal(aw.get(wf.id).triggerResponses.length, 1);
	assert.deepEqual(events, ['trigger:register']);

	// EXECUTE: the node emits → data reaches the injected emit (WorkflowRunner.run in production)
	emit([[{ json: { fired: true } }]]);
	assert.deepEqual(emitted, [[[{ json: { fired: true } }]]]);

	// DEACTIVATE: remove → closeFunction called, entry deleted
	assert.equal(await aw.remove(wf.id), true);
	assert.equal(aw.isActive(wf.id), false);
	assert.deepEqual(events, ['trigger:register', 'trigger:close']);
	// SIDE EFFECT: second remove is a no-op returning false (warn only)
	assert.equal(await aw.remove(wf.id), false);
});

test('Trigger: activation failure → WorkflowActivationError with node, workflow not registered', skipUnit, async () => {
	const { aw } = makeSystem();
	const events: string[] = [];
	const { nodeType } = makeTriggerNodeType(events, { failActivate: true });
	const node = { id: 'n1', name: 'Broken Trigger', type: 'agent4.fakeTrigger', typeVersion: 1 };
	const wf = fakeWorkflow({ id: 'wf-trigger-broken', triggerNodes: [node], nodeTypes: nodeTypesFor(nodeType) });
	// ERROR: message wraps cause; error.node === trigger node
	await assert.rejects(
		() => aw.add(wf.id, wf, {}, 'trigger', 'activate', triggerFns([]), () => ({})),
		(e: any) => {
			assert.equal(e.constructor.name, 'WorkflowActivationError');
			assert.equal(e.message, 'There was a problem activating the workflow: "boom on activate"');
			assert.equal(e.node, node);
			// source fact (ExecutionBaseError): an Error cause is NOT retained on `.cause`; it is folded into the message
			assert.equal(e.cause, undefined);
			return true;
		},
	);
	assert.equal(aw.isActive(wf.id), false);
});

test('Trigger: node without trigger() → ApplicationError "Node type does not have a trigger function defined"', skipUnit, async () => {
	const { aw } = makeSystem();
	const node = { id: 'n1', name: 'Not A Trigger', type: 'agent4.plain', typeVersion: 1 };
	const wf = fakeWorkflow({ id: 'wf-no-trigger-fn', triggerNodes: [node], nodeTypes: nodeTypesFor({ description: {} }) });
	await assert.rejects(
		() => aw.add(wf.id, wf, {}, 'trigger', 'activate', triggerFns([]), () => ({})),
		(e: any) => e.message === 'There was a problem activating the workflow: "Node type does not have a trigger function defined"',
	);
});

test('Trigger: closeFunction throwing a plain Error → WorkflowDeactivationError; TriggerCloseError is swallowed', skipUnit, async () => {
	const { aw, errorReporter } = makeSystem();
	const events: string[] = [];
	const { nodeType } = makeTriggerNodeType(events, { failClose: true });
	const node = { id: 'n1', name: 'T', type: 'agent4.fakeTrigger', typeVersion: 1 };
	const wf = fakeWorkflow({ id: 'wf-close-fail', triggerNodes: [node], nodeTypes: nodeTypesFor(nodeType) });
	await aw.add(wf.id, wf, {}, 'trigger', 'activate', triggerFns([]), () => ({}));
	await assert.rejects(
		() => aw.remove(wf.id),
		(e: any) => e.constructor.name === 'WorkflowDeactivationError' && e.message === 'Failed to deactivate trigger of workflow ID "wf-close-fail": "boom on close"',
	);

	// TriggerCloseError path: logged + reported, removal continues
	const { TriggerCloseError } = n8nRequire('n8n-workflow');
	const nt2 = {
		description: {},
		async trigger() {
			return { closeFunction: async () => { throw new TriggerCloseError(node, { cause: new Error('x'), level: 'warning' }); } };
		},
	};
	const wf2 = fakeWorkflow({ id: 'wf-close-soft', triggerNodes: [node], nodeTypes: nodeTypesFor(nt2) });
	await aw.add(wf2.id, wf2, {}, 'trigger', 'activate', triggerFns([]), () => ({}));
	assert.equal(await aw.remove(wf2.id), true);
	assert.equal(aw.isActive(wf2.id), false);
	assert.equal(errorReporter.calls.length, 1);
});

test('Trigger: manual activation wraps emit into manualTriggerResponse promise', skipUnit, async () => {
	const { aw } = makeSystem();
	const events: string[] = [];
	const { nodeType, emit } = makeTriggerNodeType(events);
	const node = { id: 'n1', name: 'T', type: 'agent4.fakeTrigger', typeVersion: 1 };
	const wf = fakeWorkflow({ id: 'wf-manual', triggerNodes: [node], nodeTypes: nodeTypesFor(nodeType) });
	const hooks = { addHandler() {} };
	await aw.add(wf.id, wf, { hooks }, 'manual', 'manual', () => ({}), () => ({}));
	const resp = aw.get(wf.id).triggerResponses[0];
	assert.ok(resp.manualTriggerResponse instanceof Promise);
	emit([[{ json: { manual: true } }]]);
	assert.deepEqual(await resp.manualTriggerResponse, [[{ json: { manual: true } }]]);
	await aw.remove(wf.id);
});

test('Trigger: poll node registers cron; sub-minute interval rejected; deregistered on remove', skipUnit, async () => {
	const { aw, stm } = makeSystem();
	const pollCalls: boolean[] = [];
	const pollNodeType = { description: {}, async poll() { pollCalls.push(true); return null; } };
	const node = { id: 'p1', name: 'Poller', type: 'agent4.poll', typeVersion: 1 };
	const wf = fakeWorkflow({ id: 'wf-poll', pollNodes: [node], nodeTypes: nodeTypesFor(pollNodeType) });
	const pollFns = (pollTimes: any) => () => ({ getNodeParameter: () => pollTimes, __emit() {}, emit() {}, emitError() {} });

	// INPUT: pollTimes everyHour → EXPECTED: one cron for the workflow, initial testing poll executed
	await aw.add(wf.id, wf, {}, 'trigger', 'activate', () => ({}), pollFns({ item: [{ mode: 'everyHour', hour: 0, minute: 5 }] }));
	assert.equal(stm.cronsByWorkflow.get(wf.id)?.size, 1);
	assert.equal(pollCalls.length, 1);
	assert.equal(await aw.remove(wf.id), true);
	assert.equal(stm.cronsByWorkflow.has(wf.id), false);

	// ERROR: expression with '*' in seconds field
	const wf2 = fakeWorkflow({ id: 'wf-poll-fast', pollNodes: [node], nodeTypes: nodeTypesFor(pollNodeType) });
	await assert.rejects(
		() => aw.add(wf2.id, wf2, {}, 'trigger', 'activate', () => ({}), pollFns({ item: [{ mode: 'custom', cronExpression: '* * * * * *' }] })),
		(e: any) => e.message === 'There was a problem activating the workflow: "The polling interval is too short. It has to be at least a minute."',
	);
	assert.equal(aw.isActive(wf2.id), false);
	stm.deregisterAllCrons();
});

// ---------------- golden consistency (offline) ----------------
test('Trigger golden: activate/deactivate lifecycle recorded against live 2.9.4', () => {
	const g = golden('trigger-scheduler');
	assert.deepEqual(g.cases.activate.expected, { status: 200, active: true, activeVersionIdSet: true, triggerCount: 1 });
	assert.equal(g.cases.activeWorkflowsList.expected.containsId, true);
	assert.deepEqual(g.cases.scheduledExecution.expected, { recorded: true, mode: 'trigger', status: 'success' }); // summary rows carry no `finished`
	assert.deepEqual(g.cases.deactivate.expected, { status: 200, active: false, activeVersionId: null });
	assert.equal(g.cases.activeWorkflowsAfterDeactivate.expected.containsId, false);
	assert.deepEqual(g.cases.activationErrorNone.expected, { status: 200, body: { data: null } });
});

// ---------------- live replay (optional) ----------------
test('Trigger live: workflow without trigger cannot be activated (400, meta.validationError)', { skip: LIVE ? false : 'N8N_URL not set' }, async () => {
	await liveLogin();
	const created = await live('POST', '/rest/workflows', { name: `Agent4 no-trigger ${Date.now()}`, nodes: [], connections: {} });
	assert.equal(created.status, 200);
	const act = await live('POST', `/rest/workflows/${created.json.data.id}/activate`, { versionId: created.json.data.versionId });
	assert.equal(act.status, 400);
	assert.equal(act.json.message, 'Workflow cannot be activated because it has no trigger node. At least one trigger, webhook, or polling node is required.');
	assert.deepEqual(act.json.meta, { validationError: true });
	await live('POST', `/rest/workflows/${created.json.data.id}/archive`, {});
	await live('DELETE', `/rest/workflows/${created.json.data.id}`);
});
