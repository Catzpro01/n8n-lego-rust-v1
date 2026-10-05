/**
 * Webhook LEGO — reference tests (n8n 2.9.4)
 *  - route matching with the real `WebhookService` + `WebhookEntity` over an in-memory repository
 *  - golden HTTP behaviour recorded from the live instance (webhook.golden.json, baseline-before.json)
 *  - optional live replay (N8N_URL)
 * Run: node --test tests/reference/agent-4/webhook/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasRuntime, n8nRequire, fakeLogger, golden, here, LIVE, live, liveLogin, stripStack } from '../helpers.ts';

const skipUnit = { skip: hasRuntime ? false : 'N8N_RUNTIME not available' };

/** In-memory stand-in for WebhookRepository (PK = method + webhookPath, like the DB). */
function memRepo() {
	const { WebhookEntity } = n8nRequire('@n8n/db/dist/entities/webhook-entity');
	const rows: any[] = [];
	const matches = (row: any, where: any) => Object.entries(where).every(([k, v]) => row[k] === v);
	const create = (data: any) => Object.assign(new WebhookEntity(), data);
	return {
		rows,
		create,
		async find(opts?: any) {
			return rows.filter((r) => (opts?.where ? matches(r, opts.where) : true));
		},
		async findBy(where: any) {
			return rows.filter((r) => matches(r, where));
		},
		async findOneBy(where: any) {
			return rows.find((r) => matches(r, where)) ?? null;
		},
		async upsert(entity: any) {
			const i = rows.findIndex((r) => r.method === entity.method && r.webhookPath === entity.webhookPath);
			if (i >= 0) rows[i] = create({ ...entity });
			else rows.push(create({ ...entity }));
		},
		async remove(entities: any[]) {
			for (const e of entities) {
				const i = rows.findIndex((r) => r.method === e.method && r.webhookPath === e.webhookPath);
				if (i >= 0) rows.splice(i, 1);
			}
		},
		async getStaticWebhooks() {
			return rows.filter((r) => !r.isDynamic);
		},
	};
}
const noCache = { get: async () => undefined, set: async () => {}, setMany: async () => {}, deleteMany: async () => {} };

function service() {
	const { WebhookService } = n8nRequire('n8n/dist/webhooks/webhook.service');
	const repo = memRepo();
	return { svc: new WebhookService(fakeLogger(), repo, noCache, {}), repo };
}

test('Webhook: register static route → resolves by (method, path); wrong method / unknown path → null', skipUnit, async () => {
	const { svc, repo } = service();
	const wh = repo.create({ workflowId: 'wf-a', webhookPath: 'smoke-test', method: 'POST', node: 'Webhook' });
	// INPUT: storeWebhook
	await svc.storeWebhook(wh);
	// EXPECTED OUTPUT
	const hit = await svc.findWebhook('POST', 'smoke-test');
	assert.equal(hit?.workflowId, 'wf-a');
	assert.equal(hit.display(), 'POST smoke-test');
	assert.equal(await svc.findWebhook('GET', 'smoke-test'), null);
	assert.equal(await svc.findWebhook('POST', 'no-such-path'), null);
	assert.deepEqual(await svc.getWebhookMethods('smoke-test'), ['POST']);
	assert.deepEqual(await svc.getWebhookMethods('no-such-path'), []);
	// SIDE EFFECT: PK upsert — same (method,path) is replaced, not duplicated
	await svc.storeWebhook(repo.create({ workflowId: 'wf-b', webhookPath: 'smoke-test', method: 'POST', node: 'Webhook' }));
	assert.equal(repo.rows.length, 1);
	assert.equal((await svc.findWebhook('POST', 'smoke-test')).workflowId, 'wf-b');
	// DEREGISTER
	await svc.deleteWorkflowWebhooks('wf-b');
	assert.equal(await svc.findWebhook('POST', 'smoke-test'), null);
});

test('Webhook: dynamic route (:param) matched by webhookId + pathLength, most static segments wins', skipUnit, async () => {
	const { svc, repo } = service();
	const id = '11111111-1111-4111-8111-111111111111';
	await svc.storeWebhook(repo.create({ workflowId: 'wf-d', webhookPath: 'users/:id', method: 'GET', node: 'W1', webhookId: id, pathLength: 2 }));
	await svc.storeWebhook(repo.create({ workflowId: 'wf-e', webhookPath: ':a/:b', method: 'GET', node: 'W2', webhookId: id, pathLength: 2 }));
	assert.equal(svc.isDynamicPath('users/:id'), true);
	assert.equal(svc.isDynamicPath('users'), false);
	assert.equal(svc.isDynamicPath(':'), false);
	const hit = await svc.findWebhook('GET', `${id}/users/42`);
	assert.equal(hit.workflowId, 'wf-d', 'static segment "users" outranks fully dynamic ":a/:b"');
	const fallback = await svc.findWebhook('GET', `${id}/x/y`);
	assert.equal(fallback.workflowId, 'wf-e');
	assert.equal(await svc.findWebhook('GET', `${id}/users`), null, 'pathLength mismatch');
	assert.equal(await svc.findWebhook('POST', `${id}/users/42`), null, 'method mismatch');
	assert.equal(hit.uniquePath, `${id}/users/:id`);
	assert.equal(hit.cacheKey, `webhook:GET-${id}/users/:id`);
});

// ---------------- golden (offline) ----------------
const webhookGolden = golden('webhook');
const baseline = JSON.parse(readFileSync(resolve(here, 'live', 'baseline-before.json'), 'utf8'));

test('Webhook golden: POST executes, response is last node json, input shape is {headers,params,query,body,webhookUrl,executionMode}', () => {
	const post = baseline.steps.webhook.post;
	assert.equal(post.status, 200);
	assert.equal(post.contentType, 'application/json; charset=utf-8');
	assert.equal(post.body.smoke_test, 'PASS');
	assert.equal(post.body.verified, true);
	assert.deepEqual(Object.keys(post.body.received), ['headers', 'params', 'query', 'body', 'webhookUrl', 'executionMode']);
	assert.deepEqual(post.body.received.body, { test: 'agent4', n: 1 });
	assert.equal(post.body.received.executionMode, 'production');
	assert.equal(post.body.received.headers['x-agent'], '4');
});

test('Webhook golden: invalid route / wrong method / unsupported method errors', () => {
	const w = baseline.steps.webhook;
	assert.equal(w.getWrongMethod.status, 404);
	assert.equal(w.getWrongMethod.body.message, 'This webhook is not registered for GET requests. Did you mean to make a POST request?');
	assert.equal(w.notFound.status, 404);
	assert.equal(w.notFound.body.message, 'The requested webhook "POST no-such-path" is not registered.');
	assert.match(w.notFound.body.hint, /^The workflow must be active for a production URL/);
	assert.equal(webhookGolden.cases.testUrlNotListening.expected.status, 404);
	assert.equal(webhookGolden.cases.testUrlNotListening.expected.body.message, 'The requested webhook "agent4-conflict" is not registered.');
	assert.match(webhookGolden.cases.testUrlNotListening.expected.body.hint, /^Click the 'Execute workflow' button/);
});

test('Webhook golden: default onReceived response, CORS preflight, path conflict 409, 404 after deactivate', () => {
	const c = webhookGolden.cases;
	assert.deepEqual(c.callDefaultResponse.expected, { status: 200, body: { message: 'Workflow was started' } });
	assert.equal(c.corsPreflight.expected.status, 204);
	assert.equal(c.corsPreflight.expected.allowMethods, 'OPTIONS, POST');
	assert.equal(c.corsPreflight.expected.allowOrigin, 'http://example.test');
	assert.equal(c.corsPreflight.expected.maxAge, '300');
	assert.equal(c.firstActivation.expected.status, 200);
	assert.equal(c.secondActivationSamePath.expected.status, 409);
	assert.equal(c.secondActivationSamePath.expected.body.message, 'There is a conflict with one of the webhooks.');
	assert.equal(c.afterDeactivate.expected.status, 404);
	assert.equal(c.afterDeactivate.expected.body.message, 'The requested webhook "POST agent4-conflict" is not registered.');
});

test('Webhook golden: execution side effect recorded (mode webhook, status success)', () => {
	const e = baseline.steps.executionRecorded;
	assert.equal(e.mode, 'webhook');
	assert.equal(e.executionStatus, 'success');
	assert.equal(e.finished, true);
	assert.equal(e.lastNodeExecuted, 'Code');
});

// ---------------- live replay ----------------
test('Webhook live: GET/POST/invalid route/unsupported method against running SMOKETEST001TEST', { skip: LIVE ? false : 'N8N_URL not set' }, async () => {
	const post = await live('POST', '/webhook/smoke-test', { test: 'agent4', n: 1 }, { noAuth: true, headers: { 'x-agent': '4' } });
	assert.equal(post.status, 200);
	assert.equal(post.json.smoke_test, 'PASS');
	assert.equal(post.json.received.executionMode, 'production');
	const get = await live('GET', '/webhook/smoke-test', undefined, { noAuth: true });
	assert.equal(get.status, 404);
	assert.equal(stripStack(get.json).message, 'This webhook is not registered for GET requests. Did you mean to make a POST request?');
	const nf = await live('POST', '/webhook/no-such-path', {}, { noAuth: true });
	assert.equal(nf.status, 404);
	assert.equal(stripStack(nf.json).message, 'The requested webhook "POST no-such-path" is not registered.');
	const test = await live('POST', '/webhook-test/smoke-test', {}, { noAuth: true });
	assert.equal(test.status, 404);
	await liveLogin();
});
