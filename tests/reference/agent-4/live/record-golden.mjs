#!/usr/bin/env node
/**
 * Agent 4 — records golden behaviour of the running n8n 2.9.4 reference for the
 * I/O & persistence LEGOs (API, webhook, credentials, trigger/scheduler, persistence).
 *
 * Writes:  tests/reference/agent-4/golden/*.golden.json
 * Format:  { case: { input, expected: { status, body… }, error?, sideEffect? } }
 *
 * No real secrets: the credential recorded here is a dummy HTTP header auth
 * credential created and deleted inside this script. The redacted API
 * representation is stored; plaintext never is.
 *
 * Usage: N8N_URL=http://127.0.0.1:5678 node tests/reference/agent-4/live/record-golden.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'golden');
const BASE = (process.env.N8N_URL ?? 'http://127.0.0.1:5678').replace(/\/$/, '');
const EMAIL = process.env.N8N_OWNER_EMAIL ?? 'agent4@example.com';
const PASS = process.env.N8N_OWNER_PASS ?? 'Agent4Smoke!2026';
let cookie = '';

const strip = (body) => {
	if (body && typeof body === 'object' && 'stacktrace' in body) {
		const { stacktrace, ...rest } = body;
		return rest;
	}
	return body;
};

async function http(method, path, body, { noAuth = false, headers = {} } = {}) {
	const h = { ...headers };
	if (body !== undefined) h['content-type'] = 'application/json';
	if (cookie && !noAuth) h.cookie = cookie;
	const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
	const sc = res.headers.get('set-cookie');
	if (sc?.includes('n8n-auth=')) cookie = sc.split(';')[0];
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {}
	return { status: res.status, json, text, headers: Object.fromEntries(res.headers.entries()) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = (name, data) => {
	mkdirSync(OUT, { recursive: true });
	writeFileSync(resolve(OUT, `${name}.golden.json`), JSON.stringify({ reference: 'n8n 2.9.4', recordedAt: new Date().toISOString(), ...data }, null, 2) + '\n');
	console.log(`wrote golden/${name}.golden.json`);
};

async function login() {
	const setup = await http('POST', '/rest/owner/setup', { email: EMAIL, firstName: 'Agent', lastName: 'Four', password: PASS }, { noAuth: true });
	if (setup.status !== 200) {
		cookie = '';
		const l = await http('POST', '/rest/login', { emailOrLdapLoginId: EMAIL, password: PASS }, { noAuth: true });
		if (l.status !== 200) throw new Error('login failed ' + l.text);
	}
}

async function recordApi() {
	const cases = {};
	cases.healthz = { input: 'GET /healthz', expected: await http('GET', '/healthz', undefined, { noAuth: true }).then((r) => ({ status: r.status, body: r.json })) };
	cases.readiness = { input: 'GET /healthz/readiness', expected: await http('GET', '/healthz/readiness', undefined, { noAuth: true }).then((r) => ({ status: r.status, body: r.json })) };
	cases.unauthenticated = { input: 'GET /rest/workflows (no cookie)', expected: await http('GET', '/rest/workflows', undefined, { noAuth: true }).then((r) => ({ status: r.status, body: r.json })) };
	cases.loginWrongPassword = {
		input: 'POST /rest/login {emailOrLdapLoginId, password:"wrong"}',
		expected: await http('POST', '/rest/login', { emailOrLdapLoginId: EMAIL, password: 'definitely-wrong' }, { noAuth: true }).then((r) => ({ status: r.status, body: strip(r.json) })),
	};
	cases.loginValidationError = {
		input: 'POST /rest/login {} (zod DTO failure → 400 with first zod issue, no {code,message} envelope)',
		expected: await http('POST', '/rest/login', {}, { noAuth: true }).then((r) => ({ status: r.status, body: strip(r.json) })),
	};
	cases.ownerSetupTwice = {
		input: 'POST /rest/owner/setup when owner exists',
		expected: await http('POST', '/rest/owner/setup', { email: EMAIL, firstName: 'A', lastName: 'B', password: PASS }, { noAuth: true }).then((r) => ({ status: r.status, body: strip(r.json) })),
	};
	await login();
	cases.me = { input: 'GET /rest/login (cookie)', expected: await http('GET', '/rest/login').then((r) => ({ status: r.status, envelope: Object.keys(r.json), role: r.json.data.role, userKeys: Object.keys(r.json.data).sort() })) };
	cases.workflowCreateValidation = {
		input: 'POST /rest/workflows {name:"", nodes:"x"}',
		expected: await http('POST', '/rest/workflows', { name: '', nodes: 'x', connections: {} }).then((r) => ({ status: r.status, body: strip(r.json) })),
	};
	cases.workflowCreateNodesNotArray = {
		input: 'POST /rest/workflows {name:"ok", nodes:{}, connections:{}}',
		expected: await http('POST', '/rest/workflows', { name: 'ok', nodes: {}, connections: {} }).then((r) => ({ status: r.status, body: strip(r.json) })),
	};
	cases.workflowCreateMissingBody = {
		input: 'POST /rest/workflows {}',
		expected: await http('POST', '/rest/workflows', {}).then((r) => ({ status: r.status, body: strip(r.json) })),
	};
	const created = await http('POST', '/rest/workflows', { name: `Agent4 API golden ${Date.now()}`, nodes: [], connections: {}, settings: { executionOrder: 'v1' } });
	cases.workflowCreateEmpty = {
		input: 'POST /rest/workflows {name, nodes:[], connections:{}}',
		expected: { status: created.status, envelope: Object.keys(created.json), dataKeys: Object.keys(created.json.data).sort(), active: created.json.data.active, activeVersionId: created.json.data.activeVersionId, versionCounter: created.json.data.versionCounter, triggerCount: created.json.data.triggerCount, idLength: created.json.data.id.length, scopes: created.json.data.scopes },
		sideEffect: 'workflow_entity row + shared_workflow(owner) + workflow_history row (transaction)',
	};
	const id = created.json.data.id;
	cases.workflowDuplicateName = {
		input: 'POST /rest/workflows with an existing name',
		expected: await http('POST', '/rest/workflows', { name: created.json.data.name, nodes: [], connections: {} }).then((r) => ({ status: r.status, body: strip(r.json) })),
	};
	cases.workflowGet = { input: `GET /rest/workflows/:id`, expected: await http('GET', `/rest/workflows/${id}`).then((r) => ({ status: r.status, envelope: Object.keys(r.json), id: r.json.data.id === id })) };
	cases.workflowNotFound = { input: 'GET /rest/workflows/nope', expected: await http('GET', '/rest/workflows/nope').then((r) => ({ status: r.status, body: strip(r.json) })) };
	cases.workflowActivateWithoutTrigger = {
		input: 'POST /rest/workflows/:id/activate on a workflow with no trigger node',
		expected: await http('POST', `/rest/workflows/${id}/activate`, { versionId: created.json.data.versionId }).then((r) => ({ status: r.status, body: strip(r.json) })),
	};
	cases.executionNotANumber = { input: 'GET /rest/executions/abc', expected: await http('GET', '/rest/executions/abc').then((r) => ({ status: r.status, body: strip(r.json) })) };
	cases.executionNotFound = { input: 'GET /rest/executions/999999', expected: await http('GET', '/rest/executions/999999').then((r) => ({ status: r.status, body: strip(r.json) })) };
	cases.unknownRestRouteFallsThroughToSpa = { input: 'GET /rest/this-does-not-exist', expected: await http('GET', '/rest/this-does-not-exist').then((r) => ({ status: r.status, contentType: r.headers['content-type'], isHtml: r.text.includes('<html') })) };
	cases.publicApiNoKey = { input: 'GET /api/v1/workflows (no key)', expected: await http('GET', '/api/v1/workflows', undefined, { noAuth: true }).then((r) => ({ status: r.status, body: r.json })) };
	cases.publicApiBadKey = { input: 'GET /api/v1/workflows (bad key)', expected: await http('GET', '/api/v1/workflows', undefined, { noAuth: true, headers: { 'X-N8N-API-KEY': 'nope' } }).then((r) => ({ status: r.status, body: r.json })) };
	cases.workflowDelete = { input: 'DELETE /rest/workflows/:id', expected: await http('DELETE', `/rest/workflows/${id}`).then((r) => ({ status: r.status, body: strip(r.json) })) };
	save('api', { cases });
}

async function recordCredentials() {
	await login();
	const cases = {};
	const dummy = { name: `Agent4 dummy header auth ${Date.now()}`, type: 'httpHeaderAuth', data: { name: 'X-Dummy', value: 'not-a-real-secret-0000' } };
	const created = await http('POST', '/rest/credentials', dummy);
	cases.create = {
		input: 'POST /rest/credentials {name,type:"httpHeaderAuth",data:{name,value}}',
		expected: { status: created.status, dataKeys: Object.keys(created.json?.data ?? {}).sort(), dataFieldPresent: 'data' in (created.json?.data ?? {}), type: created.json?.data?.type },
		sideEffect: 'credentials_entity.data = base64("Salted__"+salt+aes-256-cbc(...)); shared_credentials(owner)',
	};
	const id = created.json.data.id;
	cases.getWithoutData = { input: 'GET /rest/credentials/:id', expected: await http('GET', `/rest/credentials/${id}`).then((r) => ({ status: r.status, hasData: 'data' in r.json.data, keys: Object.keys(r.json.data).sort() })) };
	const withData = await http('GET', `/rest/credentials/${id}?includeData=true`);
	cases.getWithDataIsRedacted = {
		input: 'GET /rest/credentials/:id?includeData=true (owner)',
		expected: { status: withData.status, data: withData.json.data.data },
		note: 'password-typed property `value` is replaced by CREDENTIAL_BLANKING_VALUE; `name` (plain) is returned as stored',
	};
	cases.updateWithBlankedValueKeepsSecret = {
		input: 'PATCH /rest/credentials/:id with the redacted data echoed back',
		expected: await http('PATCH', `/rest/credentials/${id}`, { name: dummy.name, type: dummy.type, data: withData.json.data.data }).then((r) => ({ status: r.status, dataFieldPresent: 'data' in r.json.data })),
		sideEffect: 'CredentialsService.unredact restores the stored plaintext for blanked keys; ciphertext re-encrypted with a fresh salt',
	};
	cases.notFound = { input: 'GET /rest/credentials/does-not-exist', expected: await http('GET', '/rest/credentials/does-not-exist').then((r) => ({ status: r.status, body: strip(r.json) })) };
	cases.createInvalidType = { input: 'POST /rest/credentials {type:"noSuchType"}', expected: await http('POST', '/rest/credentials', { name: 'bad type', type: 'noSuchCredentialType', data: { a: 1 } }).then((r) => ({ status: r.status, body: strip(r.json) })) };
	cases.createNameTooShort = { input: 'POST /rest/credentials {name:"ab"}', expected: await http('POST', '/rest/credentials', { name: 'ab', type: 'httpHeaderAuth', data: { name: 'x', value: 'y' } }).then((r) => ({ status: r.status, body: strip(r.json) })) };
	cases.delete = { input: 'DELETE /rest/credentials/:id', expected: await http('DELETE', `/rest/credentials/${id}`).then((r) => ({ status: r.status, body: r.json })) };
	save('credentials', { cases, constants: { CREDENTIAL_BLANKING_VALUE: '__n8n_BLANK_VALUE_e5362baf-c777-4d57-a609-6eaf1f9e87f6', CREDENTIAL_EMPTY_VALUE: '__n8n_EMPTY_VALUE_7b1af746-3729-4c60-9b9b-e08eb29e58da' } });
}

async function recordTriggerScheduler() {
	await login();
	const cases = {};
	const name = `Agent4 schedule golden`;
	const def = {
		name,
		nodes: [
			{ id: 'sch-1', name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0], parameters: { rule: { interval: [{ field: 'seconds', secondsInterval: 30 }] } } },
			{ id: 'sch-2', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0], parameters: { jsCode: "return [{ json: { fired: true } }];" } },
		],
		connections: { 'Schedule Trigger': { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
		settings: { executionOrder: 'v1' },
	};
	let wf = await http('POST', '/rest/workflows', def);
	if (wf.status !== 200) {
		const list = await http('GET', `/rest/workflows?filter=${encodeURIComponent(JSON.stringify({ name }))}`);
		const existing = (list.json?.data?.data ?? list.json?.data ?? []).find((w) => w.name === name);
		wf = await http('GET', `/rest/workflows/${existing.id}`);
	}
	const w = wf.json.data;
	const act = await http('POST', `/rest/workflows/${w.id}/activate`, { versionId: w.versionId });
	cases.activate = {
		input: 'POST /rest/workflows/:id/activate (Schedule Trigger every 30s)',
		expected: { status: act.status, active: act.json?.data?.active, activeVersionIdSet: !!act.json?.data?.activeVersionId, triggerCount: act.json?.data?.triggerCount },
		sideEffect: 'ActiveWorkflowManager.add → ActiveWorkflows.add → ScheduleTrigger.trigger → helpers.registerCron → ScheduledTaskManager (in memory, leader only); workflow_entity.activeVersionId set; workflow_publish_history row',
	};
	const activeIds = await http('GET', '/rest/active-workflows');
	cases.activeWorkflowsList = { input: 'GET /rest/active-workflows', expected: { status: activeIds.status, containsId: (activeIds.json?.data ?? []).includes(w.id) } };
	const activateAgain = await http('POST', `/rest/workflows/${w.id}/activate`, { versionId: w.versionId });
	cases.activateAlreadyActive = { input: 'POST /activate again', expected: { status: activateAgain.status, body: strip(activateAgain.json) && { active: activateAgain.json?.data?.active } } };
	console.log('waiting ~35s for the schedule trigger to fire once…');
	let exec;
	for (let i = 0; i < 50 && !exec; i++) {
		await sleep(1000);
		const list = await http('GET', `/rest/executions?filter=${encodeURIComponent(JSON.stringify({ workflowId: w.id }))}&limit=1`);
		exec = list.json?.data?.results?.[0];
	}
	cases.scheduledExecution = {
		input: 'wait for cron tick',
		expected: exec ? { recorded: true, mode: exec.mode, status: exec.status, finished: exec.finished } : { recorded: false },
		sideEffect: 'execution_entity row with mode="trigger"',
	};
	const deact = await http('POST', `/rest/workflows/${w.id}/deactivate`, {});
	cases.deactivate = { input: 'POST /rest/workflows/:id/deactivate', expected: { status: deact.status, active: deact.json?.data?.active, activeVersionId: deact.json?.data?.activeVersionId }, sideEffect: 'ActiveWorkflowManager.remove → ActiveWorkflows.remove → deregisterCrons(workflowId); closeFunction()' };
	const deactAgain = await http('POST', `/rest/workflows/${w.id}/deactivate`, {});
	cases.deactivateAlreadyInactive = { input: 'POST /deactivate again', expected: { status: deactAgain.status, body: strip(deactAgain.json)?.message ?? { active: deactAgain.json?.data?.active } } };
	const activeAfter = await http('GET', '/rest/active-workflows');
	cases.activeWorkflowsAfterDeactivate = { input: 'GET /rest/active-workflows', expected: { containsId: (activeAfter.json?.data ?? []).includes(w.id) } };
	const errs = await http('GET', `/rest/active-workflows/error/${w.id}`);
	cases.activationErrorNone = { input: 'GET /rest/active-workflows/error/:id', expected: { status: errs.status, body: errs.json } };
	await http('DELETE', `/rest/workflows/${w.id}`);
	save('trigger-scheduler', { cases });
}

async function recordWebhookConflict() {
	await login();
	const cases = {};
	// Two workflows with the same production webhook path: second activation must fail with WebhookPathTakenError.
	const mk = (n) => ({
		name: `Agent4 webhook conflict ${n}`,
		nodes: [{ id: `wh-${n}`, name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [0, 0], webhookId: `00000000-0000-4000-8000-00000000000${n}`, parameters: { httpMethod: 'POST', path: 'agent4-conflict', options: {} } }],
		connections: {},
		settings: { executionOrder: 'v1' },
	});
	const a = await http('POST', '/rest/workflows', mk(1));
	const b = await http('POST', '/rest/workflows', mk(2));
	const actA = await http('POST', `/rest/workflows/${a.json.data.id}/activate`, { versionId: a.json.data.versionId });
	const actB = await http('POST', `/rest/workflows/${b.json.data.id}/activate`, { versionId: b.json.data.versionId });
	cases.firstActivation = { input: 'activate workflow A (POST agent4-conflict)', expected: { status: actA.status, active: actA.json?.data?.active } };
	cases.secondActivationSamePath = { input: 'activate workflow B (same method+path)', expected: { status: actB.status, body: strip(actB.json) }, error: 'WebhookPathTakenError / conflict detection', sideEffect: 'webhook_entity PK (webhookPath, method) — only one row can exist' };
	const call = await http('POST', '/webhook/agent4-conflict', { x: 1 }, { noAuth: true });
	cases.callDefaultResponse = { input: 'POST /webhook/agent4-conflict (responseMode default onReceived, no responseData)', expected: { status: call.status, body: call.json } };
	const options = await fetch(BASE + '/webhook/agent4-conflict', { method: 'OPTIONS', headers: { origin: 'http://example.test', 'access-control-request-method': 'POST' } });
	cases.corsPreflight = { input: 'OPTIONS /webhook/agent4-conflict with Origin', expected: { status: options.status, allowMethods: options.headers.get('access-control-allow-methods'), allowOrigin: options.headers.get('access-control-allow-origin'), maxAge: options.headers.get('access-control-max-age') } };
	const test = await http('POST', '/webhook-test/agent4-conflict', {}, { noAuth: true });
	cases.testUrlNotListening = { input: 'POST /webhook-test/agent4-conflict (no test registration)', expected: { status: test.status, body: strip(test.json) } };
	await http('POST', `/rest/workflows/${a.json.data.id}/deactivate`, {});
	const after = await http('POST', '/webhook/agent4-conflict', { x: 1 }, { noAuth: true });
	cases.afterDeactivate = { input: 'POST /webhook/agent4-conflict after deactivation', expected: { status: after.status, body: strip(after.json) }, sideEffect: 'webhook_entity row deleted by clearWebhooks' };
	await http('DELETE', `/rest/workflows/${a.json.data.id}`);
	await http('DELETE', `/rest/workflows/${b.json.data.id}`);
	save('webhook', { cases });
}

async function main() {
	await recordApi();
	await recordCredentials();
	await recordWebhookConflict();
	await recordTriggerScheduler();
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
