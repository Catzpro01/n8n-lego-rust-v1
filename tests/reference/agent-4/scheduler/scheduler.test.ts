/**
 * Scheduler LEGO — reference tests (n8n 2.9.4 `ScheduledTaskManager`, `toCronExpression`)
 * Run: node --test tests/reference/agent-4/scheduler/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRuntime, n8nRequire, fakeLogger, fakeErrorReporter, golden } from '../helpers.ts';

const skipUnit = { skip: hasRuntime ? false : 'N8N_RUNTIME not available' };

function stm(isLeader = true) {
	const { ScheduledTaskManager } = n8nRequire('n8n-core/dist/execution-engine/scheduled-task-manager');
	const instanceSettings = { isLeader, instanceRole: isLeader ? 'leader' : 'follower' };
	const errorReporter = fakeErrorReporter();
	return { m: new ScheduledTaskManager(instanceSettings, fakeLogger(), { activeInterval: 0 }, errorReporter), instanceSettings, errorReporter };
}
const ctx = (over: Partial<any> = {}) => ({ workflowId: 'wf-1', nodeId: 'node-1', timezone: 'UTC', expression: '* * * * * *', ...over });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Scheduler: register → executes on tick (leader) → cancel stops further ticks', skipUnit, async () => {
	const { m } = stm(true);
	let ticks = 0;
	// INPUT: every-second cron
	m.registerCron(ctx(), () => ticks++);
	assert.equal(m.cronsByWorkflow.get('wf-1').size, 1);
	// EXPECTED OUTPUT: at least one tick within ~2.2 s
	await sleep(2200);
	assert.ok(ticks >= 1, `expected ≥1 tick, got ${ticks}`);
	// CANCEL
	m.deregisterCrons('wf-1');
	assert.equal(m.cronsByWorkflow.has('wf-1'), false);
	const after = ticks;
	await sleep(1200);
	// SIDE EFFECT: no ticks after deregistration
	assert.equal(ticks, after);
});

test('Scheduler: follower registers but never fires', skipUnit, async () => {
	const { m } = stm(false);
	let ticks = 0;
	m.registerCron(ctx({ workflowId: 'wf-follower' }), () => ticks++);
	assert.equal(m.cronsByWorkflow.get('wf-follower').size, 1);
	await sleep(1500);
	assert.equal(ticks, 0);
	m.deregisterAllCrons();
});

test('Scheduler: duplicate context is skipped silently and reported once', skipUnit, () => {
	const { m, errorReporter } = stm(true);
	m.registerCron(ctx({ expression: '0 0 * * * *' }), () => {});
	m.registerCron(ctx({ expression: '0 0 * * * *' }), () => {});
	assert.equal(m.cronsByWorkflow.get('wf-1').size, 1);
	assert.equal(errorReporter.calls.length, 1);
	assert.equal(errorReporter.calls[0][0], 'Skipped registration for already registered cron');
	assert.deepEqual(errorReporter.calls[0][1].tags, { cron: 'duplicate' });
	// different nodeId → separate cron
	m.registerCron(ctx({ expression: '0 0 * * * *', nodeId: 'node-2' }), () => {});
	assert.equal(m.cronsByWorkflow.get('wf-1').size, 2);
	m.deregisterAllCrons();
});

test('Scheduler: invalid expression throws synchronously from registerCron; nothing registered', skipUnit, () => {
	const { m } = stm(true);
	assert.throws(() => m.registerCron(ctx({ expression: 'not a cron' }), () => {}));
	assert.equal(m.cronsByWorkflow.has('wf-1'), false);
});

test('Scheduler: deregister unknown workflow is a no-op; deregisterAllCrons clears everything', skipUnit, () => {
	const { m } = stm(true);
	m.deregisterCrons('nope');
	m.registerCron(ctx({ workflowId: 'a', expression: '0 0 * * * *' }), () => {});
	m.registerCron(ctx({ workflowId: 'b', expression: '0 0 * * * *' }), () => {});
	m.deregisterAllCrons();
	assert.equal(m.cronsByWorkflow.size, 0);
});

test('Scheduler: toCronExpression produces 6-field expressions; custom is passed through trimmed; seconds are random', skipUnit, () => {
	const { toCronExpression } = n8nRequire('n8n-workflow');
	assert.equal(toCronExpression({ mode: 'custom', cronExpression: '  0 * * * *  ' }), '0 * * * *');
	const hourly = toCronExpression({ mode: 'everyHour', minute: 5 });
	assert.match(hourly, /^\d{1,2} 5 \* \* \* \*$/);
	const daily = toCronExpression({ mode: 'everyDay', hour: 14, minute: 30 });
	assert.match(daily, /^\d{1,2} 30 14 \* \* \*$/);
	const weekly = toCronExpression({ mode: 'everyWeek', hour: 1, minute: 2, weekday: 3 });
	assert.match(weekly, /^\d{1,2} 2 1 \* \* 3$/);
	const monthly = toCronExpression({ mode: 'everyMonth', hour: 1, minute: 2, dayOfMonth: 15 });
	assert.match(monthly, /^\d{1,2} 2 1 15 \* \*$/);
	const everyMinute = toCronExpression({ mode: 'everyMinute' });
	assert.match(everyMinute, /^\d{1,2} \* \* \* \* \*$/);
	const everyX = toCronExpression({ mode: 'everyX', value: 10, unit: 'minutes' });
	assert.match(everyX, /^\d{1,2} \*\/10 \* \* \* \*$/);
	const everyXh = toCronExpression({ mode: 'everyX', value: 2, unit: 'hours' });
	assert.match(everyXh, /^\d{1,2} \d{1,2} \*\/2 \* \* \*$/); // minute is randomInt(60) too (source: cron.ts everyX hours)
});

test('Scheduler golden: live Schedule Trigger fired once as mode=trigger and stopped after deactivate', () => {
	const g = golden('trigger-scheduler');
	assert.equal(g.cases.activate.expected.status, 200);
	assert.equal(g.cases.scheduledExecution.expected.recorded, true);
	assert.equal(g.cases.scheduledExecution.expected.mode, 'trigger');
	assert.equal(g.cases.deactivate.expected.active, false);
});
