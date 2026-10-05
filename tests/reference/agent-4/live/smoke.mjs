#!/usr/bin/env node
/**
 * Agent 4 — 11-point live smoke test against a running n8n 2.9.4 reference.
 *
 * Usage:
 *   N8N_URL=http://127.0.0.1:5678 node tests/reference/agent-4/live/smoke.mjs [--record out.json]
 *
 * Environment:
 *   N8N_URL          base url (default http://127.0.0.1:5678)
 *   N8N_OWNER_EMAIL  owner e-mail (default agent4@example.com)
 *   N8N_OWNER_PASS   owner password (default Agent4Smoke!2026) — throw-away, sandbox only
 *   N8N_SQLITE_PATH  optional path to database.sqlite; when set, step 11 also
 *                    verifies the execution row directly in the DB (via node:sqlite
 *                    when available, otherwise via the REST API only).
 *
 * The script is idempotent: it re-uses the owner/workflows if they exist.
 * It exits 0 only on 11/11 PASS.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http_ from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.N8N_URL ?? 'http://127.0.0.1:5678').replace(/\/$/, '');
const EMAIL = process.env.N8N_OWNER_EMAIL ?? 'agent4@example.com';
const PASS = process.env.N8N_OWNER_PASS ?? 'Agent4Smoke!2026';
const recordIdx = process.argv.indexOf('--record');
const RECORD = recordIdx !== -1 ? process.argv[recordIdx + 1] : undefined;

const results = [];
const golden = { reference: 'n8n 2.9.4', baseUrl: BASE, recordedAt: new Date().toISOString(), steps: {} };
let cookie = '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * n8n serialises IRunExecutionData with `flatted` (not JSON). `GET /rest/executions/:id`
 * returns `data` as a flatted string. Faithful port of flatted.parse (ISC, Andrea Giammarchi):
 * the payload is a JSON array; every string inside an object/array is an index into that array,
 * and literal strings are stored as separate array entries.
 */
function flattedParse(text) {
	const Primitive = String;
	const input = JSON.parse(text, (_, v) => (typeof v === 'string' ? new Primitive(v) : v)).map((v) =>
		v instanceof Primitive ? Primitive(v) : v,
	);
	const revive = (output, parsed) => {
		const lazy = [];
		for (const k of Object.keys(output)) {
			const value = output[k];
			if (value instanceof Primitive) {
				const tmp = input[value];
				if (typeof tmp === 'object' && tmp !== null && !parsed.has(tmp)) {
					parsed.add(tmp);
					lazy.push([k, tmp]);
				} else output[k] = tmp;
			}
		}
		for (const [k, tmp] of lazy) output[k] = revive(tmp, parsed);
		return output;
	};
	const value = input[0];
	return typeof value === 'object' && value ? revive(value, new Set()) : value;
}
function executionData(exec) {
	if (!exec) return undefined;
	return typeof exec.data === 'string' ? flattedParse(exec.data) : exec.data;
}

async function http(method, path, body, opts = {}) {
	const headers = { ...(opts.headers ?? {}) };
	if (body !== undefined && !(body instanceof Buffer)) headers['content-type'] = 'application/json';
	if (cookie && !opts.noAuth) headers.cookie = cookie;
	const res = await fetch(BASE + path, {
		method,
		headers,
		body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
		redirect: 'manual',
	});
	const setCookie = res.headers.get('set-cookie');
	if (setCookie && setCookie.includes('n8n-auth=')) cookie = setCookie.split(';')[0];
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text, json };
}

function rawRequest(method, path) {
	return new Promise((resolvePromise) => {
		const u = new URL(BASE + path);
		const req = http_.request({ method, host: u.hostname, port: u.port, path: u.pathname }, (res) => {
			let text = '';
			res.on('data', (c) => (text += c));
			res.on('end', () => {
				let json;
				try { json = JSON.parse(text); } catch {}
				resolvePromise({ status: res.statusCode, body: json ?? text });
			});
		});
		req.on('error', (e) => resolvePromise({ status: 0, body: String(e) }));
		req.end();
	});
}

function step(no, name, pass, evidence) {
	results.push({ no, name, pass, evidence });
	console.log(`${pass ? '[PASS]' : '[FAIL]'} ${String(no).padStart(2)}/11 ${name} — ${evidence}`);
}

function loadWorkflow(file) {
	return JSON.parse(readFileSync(resolve(__dirname, 'workflows', file), 'utf8'));
}

async function findWorkflowByName(name) {
	// GET /rest/workflows is `raw` → body is {count, data:[...]} (no {data} envelope) when a filter is used
	const r = await http('GET', `/rest/workflows?filter=${encodeURIComponent(JSON.stringify({ name }))}`);
	const list = r.json?.data?.data ?? r.json?.data ?? [];
	return (Array.isArray(list) ? list : []).find((w) => w.name === name);
}

async function ensureWorkflow(file) {
	const def = loadWorkflow(file);
	const existing = await findWorkflowByName(def.name);
	if (existing) {
		const full = await http('GET', `/rest/workflows/${existing.id}`);
		if (def.id) {
			const dup = await http('POST', '/rest/workflows', def);
			golden.steps.workflowCreateDuplicateId = { status: dup.status, code: dup.json?.code, message: dup.json?.message };
		}
		return { created: false, workflow: full.json.data, createResponse: undefined };
	}
	const r = await http('POST', '/rest/workflows', def);
	if (r.status !== 200) throw new Error(`create ${def.name} failed: ${r.status} ${r.text}`);
	return { created: true, workflow: r.json.data, createResponse: r.json };
}

async function waitForExecution(executionId, tries = 40) {
	for (let i = 0; i < tries; i++) {
		const r = await http('GET', `/rest/executions/${executionId}`);
		if (r.json?.data && !['new', 'running', 'waiting'].includes(r.json.data.status)) return r.json.data;
		await sleep(250);
	}
	throw new Error(`execution ${executionId} did not finish`);
}

async function latestExecutionFor(workflowId) {
	const r = await http('GET', `/rest/executions?filter=${encodeURIComponent(JSON.stringify({ workflowId }))}&limit=1`);
	return r.json?.data?.results?.[0];
}

async function main() {
	// 1. n8n starts
	{
		const r = await http('GET', '/healthz', undefined, { noAuth: true });
		const ready = await http('GET', '/healthz/readiness', undefined, { noAuth: true });
		golden.steps.healthz = { status: r.status, body: r.json };
		golden.steps.readiness = { status: ready.status, body: ready.json };
		step(1, 'n8n starts', r.status === 200 && r.json?.status === 'ok' && ready.status === 200, `GET /healthz ${r.status} ${r.text} ; readiness ${ready.status}`);
	}

	// 2. editor opens
	{
		const r = await http('GET', '/', undefined, { noAuth: true });
		const settings = await http('GET', '/rest/settings', undefined, { noAuth: true });
		golden.steps.settings = {
			status: settings.status,
			keys: Object.keys(settings.json?.data ?? {}).sort(),
			versionCli: settings.json?.data?.versionCli,
			endpointWebhook: settings.json?.data?.endpointWebhook,
			endpointWebhookTest: settings.json?.data?.endpointWebhookTest,
		};
		step(2, 'editor opens', r.status === 200 && /<div id="app">|n8n/.test(r.text) && settings.status === 200 && settings.json?.data?.settingsMode === 'public', `GET / ${r.status} html=${r.text.length}B ; GET /rest/settings (unauthenticated) ${settings.status} settingsMode=${settings.json?.data?.settingsMode}`);
	}

	// 3. login / owner works
	{
		const setup = await http(
			'POST',
			'/rest/owner/setup',
			{ email: EMAIL, firstName: 'Agent', lastName: 'Four', password: PASS },
			{ noAuth: true },
		);
		golden.steps.ownerSetup = { status: setup.status, body: setup.status === 200 ? { role: setup.json?.data?.role, isOwner: setup.json?.data?.isOwner } : setup.json };
		let ok = setup.status === 200 && (setup.json?.data?.role === 'global:owner' || setup.json?.data?.isOwner === true);
		if (!ok) {
			// already set up → login
			cookie = '';
			const login = await http('POST', '/rest/login', { emailOrLdapLoginId: EMAIL, password: PASS }, { noAuth: true });
			golden.steps.login = { status: login.status, role: login.json?.data?.role };
			ok = login.status === 200 && !!cookie;
		}
		const me = await http('GET', '/rest/login');
		golden.steps.me = { status: me.status, role: me.json?.data?.role };
		const authSettings = await http('GET', '/rest/settings');
		golden.steps.settingsAuthenticated = { status: authSettings.status, settingsMode: authSettings.json?.data?.settingsMode, versionCli: authSettings.json?.data?.versionCli, endpointWebhook: authSettings.json?.data?.endpointWebhook, endpointWebhookTest: authSettings.json?.data?.endpointWebhookTest };
		if (authSettings.json?.data?.versionCli !== '2.9.4') throw new Error(`reference is not 2.9.4 but ${authSettings.json?.data?.versionCli}`);
		step(3, 'login/owner works', ok && me.status === 200 && me.json?.data?.email === EMAIL, `owner/setup ${setup.status} ; GET /rest/login ${me.status} role=${me.json?.data?.role}`);
	}

	// 4. workflow create
	let oneNode;
	{
		const res = await ensureWorkflow('02-one-node.json');
		oneNode = res.workflow;
		if (res.createResponse) {
			golden.steps.workflowCreate = {
				status: 200,
				envelopeKeys: Object.keys(res.createResponse),
				dataKeys: Object.keys(res.createResponse.data).sort(),
				active: res.createResponse.data.active,
				activeVersionId: res.createResponse.data.activeVersionId,
				versionIdIsUuid: /^[0-9a-f-]{36}$/.test(res.createResponse.data.versionId),
				idLength: res.createResponse.data.id.length,
			};
		}
		step(4, 'workflow create', !!oneNode?.id && oneNode.active === false, `id=${oneNode?.id} created=${res.created} active=${oneNode?.active}`);
	}

	// 5. workflow save (update via PATCH)
	{
		const before = oneNode.versionId;
		// (a) settings-only save: n8n keeps versionId (WorkflowService.update → saveNewVersion=false)
		const same = await http('PATCH', `/rest/workflows/${oneNode.id}`, {
			name: oneNode.name,
			settings: { ...(oneNode.settings ?? {}), executionOrder: 'v1' },
			versionId: oneNode.versionId,
		});
		// (b) node change save: versionId is replaced with a new uuid and a workflow_history row is written
		const movedNodes = oneNode.nodes.map((n) => ({ ...n, position: [n.position[0] + 20, n.position[1]] }));
		const r = await http('PATCH', `/rest/workflows/${oneNode.id}`, {
			name: oneNode.name,
			nodes: movedNodes,
			connections: oneNode.connections,
			versionId: oneNode.versionId,
		});
		const history = await http('GET', `/rest/workflow-history/workflow/${oneNode.id}?take=20`);
		golden.steps.workflowSave = {
			settingsOnly: { status: same.status, versionChanged: same.json?.data?.versionId !== before },
			nodesChanged: { status: r.status, versionChanged: r.json?.data?.versionId !== before },
			historyCount: history.json?.data?.length,
		};
		step(5, 'workflow save', same.status === 200 && same.json?.data?.versionId === before && r.status === 200 && r.json?.data?.versionId && r.json.data.versionId !== before, `PATCH(settings) ${same.status} versionId kept ; PATCH(nodes) ${r.status} versionId ${before} → ${r.json?.data?.versionId} ; history rows=${history.json?.data?.length}`);
		if (r.status === 200) oneNode = r.json.data;
	}

	// 6. workflow load
	{
		const r = await http('GET', `/rest/workflows/${oneNode.id}`);
		const nf = await http('GET', '/rest/workflows/does-not-exist-404');
		golden.steps.workflowLoad = { status: r.status, nodes: r.json?.data?.nodes?.length };
		golden.steps.workflowNotFound = { status: nf.status, body: nf.json };
		step(6, 'workflow load', r.status === 200 && r.json.data.id === oneNode.id && r.json.data.nodes.length === 1 && nf.status === 404, `GET ${r.status} nodes=${r.json?.data?.nodes?.length} ; unknown id → ${nf.status} "${nf.json?.message}"`);
	}

	// 7. manual execution (one node)  — POST /rest/workflows/:id/run
	{
		const r = await http('POST', `/rest/workflows/${oneNode.id}/run`, {
			workflowData: oneNode,
			startNodes: [],
			triggerToStartFrom: undefined,
		});
		const execId = r.json?.data?.executionId;
		let exec;
		if (execId) exec = await waitForExecution(execId);
		golden.steps.manualRun = { status: r.status, bodyKeys: Object.keys(r.json?.data ?? {}), executionStatus: exec?.status, mode: exec?.mode };
		step(7, 'manual execution', r.status === 200 && !!execId && exec?.status === 'success' && exec?.mode === 'manual', `POST /run ${r.status} executionId=${execId} status=${exec?.status} mode=${exec?.mode}`);
	}

	// 8. one-node execution result (Manual Trigger output = one empty item)
	{
		const exec = await latestExecutionFor(oneNode.id);
		const full = exec ? await http('GET', `/rest/executions/${exec.id}`) : undefined;
		const parsed = executionData(full?.json?.data);
		const runData = parsed?.resultData?.runData;
		const triggerNode = Object.keys(runData ?? {})[0];
		const triggerRun = runData?.[triggerNode]?.[0];
		const out = triggerRun?.data?.main?.[0];
		golden.steps.oneNode = { dataIsFlattedString: typeof full?.json?.data?.data === 'string', runDataNodes: Object.keys(runData ?? {}), output: out, lastNodeExecuted: parsed?.resultData?.lastNodeExecuted };
		step(8, 'one-node execution', Array.isArray(out) && out.length === 1 && JSON.stringify(out[0].json) === '{}', `runData nodes=${JSON.stringify(Object.keys(runData ?? {}))} output=${JSON.stringify(out)}`);
	}

	// 9. linear execution (Manual Trigger → Code)
	{
		const res = await ensureWorkflow('03-linear.json');
		const wf = res.workflow;
		const r = await http('POST', `/rest/workflows/${wf.id}/run`, { workflowData: wf, startNodes: [] });
		const execId = r.json?.data?.executionId;
		const exec = execId ? await waitForExecution(execId) : undefined;
		const full = exec ? await http('GET', `/rest/executions/${execId}`) : undefined;
		const parsed = executionData(full?.json?.data);
		const runData = parsed?.resultData?.runData;
		const codeOut = runData?.Code?.[0]?.data?.main?.[0];
		golden.steps.linear = { executionStatus: exec?.status, runDataNodes: Object.keys(runData ?? {}), codeOutput: codeOut, lastNodeExecuted: parsed?.resultData?.lastNodeExecuted, source: runData?.Code?.[0]?.source };
		step(9, 'linear execution', exec?.status === 'success' && codeOut?.[0]?.json?.status === 'ok' && codeOut?.[0]?.json?.count === 42, `status=${exec?.status} Code output=${JSON.stringify(codeOut?.map((i) => i.json))}`);
	}

	// 10. webhook execution (production URL, activated workflow)
	let webhookExecId;
	{
		const res = await ensureWorkflow('04-webhook.json');
		let wf = res.workflow;
		if (!wf.activeVersionId) {
			const act = await http('POST', `/rest/workflows/${wf.id}/activate`, { versionId: wf.versionId });
			golden.steps.activate = { status: act.status, activeVersionId: act.json?.data?.activeVersionId, active: act.json?.data?.active };
			if (act.status !== 200) throw new Error(`activate failed ${act.status} ${act.text}`);
			wf = act.json.data;
		}
		const body = { test: 'agent4', n: 1 };
		const r = await http('POST', '/webhook/smoke-test', body, { noAuth: true, headers: { 'x-agent': '4' } });
		const get = await http('GET', '/webhook/smoke-test', undefined, { noAuth: true });
		const nf = await http('POST', '/webhook/no-such-path', {}, { noAuth: true });
		// unsupported verb: WebhookRequestHandler → sendErrorResponse(new Error('The method X is not supported.')) → 500 code 0
		const bad = await rawRequest('PROPFIND', '/webhook/smoke-test');
		golden.steps.webhook = {
			post: { status: r.status, body: r.json, contentType: r.headers['content-type'] },
			getWrongMethod: { status: get.status, body: get.json },
			notFound: { status: nf.status, body: nf.json },
			unsupportedMethod: bad,
		};
		await sleep(500);
		const exec = await latestExecutionFor(wf.id);
		webhookExecId = exec?.id;
		step(
			10,
			'webhook execution',
			r.status === 200 && r.json?.smoke_test === 'PASS' && r.json?.verified === true && r.json?.received?.body?.test === 'agent4' && r.json?.received?.executionMode === 'production' && get.status === 404 && nf.status === 404 && bad.status === 500 && bad.body?.code === 0,
			`POST /webhook/smoke-test ${r.status} ${JSON.stringify(r.json && { smoke_test: r.json.smoke_test, verified: r.json.verified })} ; GET → ${get.status} ; unknown → ${nf.status} ; PROPFIND → ${bad.status}`,
		);
	}

	// 11. execution recorded
	{
		const exec = webhookExecId ? await http('GET', `/rest/executions/${webhookExecId}`) : undefined;
		const d = exec?.json?.data;
		const parsed = executionData(d);
		golden.steps.executionRecorded = { status: exec?.status, responseKeys: Object.keys(d ?? {}).sort(), executionStatus: d?.status, mode: d?.mode, finished: d?.finished, hasStartedAt: !!d?.startedAt, hasStoppedAt: !!d?.stoppedAt, workflowId: d?.workflowId, lastNodeExecuted: parsed?.resultData?.lastNodeExecuted, workflowDataKeys: Object.keys(d?.workflowData ?? {}).sort() };
		let dbEvidence = 'REST';
		if (process.env.N8N_SQLITE_PATH) {
			try {
				const { DatabaseSync } = await import('node:sqlite');
				const db = new DatabaseSync(process.env.N8N_SQLITE_PATH, { readOnly: true });
				const row = db.prepare('SELECT id, status, mode, finished, workflowId FROM execution_entity ORDER BY CAST(id AS INTEGER) DESC LIMIT 1').get();
				const data = db.prepare('SELECT executionId, length(data) AS len, workflowVersionId FROM execution_data WHERE executionId = ?').get(row.id);
				golden.steps.executionRecorded.db = { row, data };
				dbEvidence = `sqlite execution_entity id=${row.id} status=${row.status} mode=${row.mode} ; execution_data len=${data?.len}`;
				db.close();
			} catch (e) {
				dbEvidence = `sqlite check skipped (${e.message.split('\n')[0]})`;
			}
		}
		step(11, 'execution recorded', exec?.status === 200 && d?.status === 'success' && d?.mode === 'webhook' && d?.finished === true && parsed?.resultData?.lastNodeExecuted === 'Code', `GET /rest/executions/${webhookExecId} status=${d?.status} mode=${d?.mode} finished=${d?.finished} ; ${dbEvidence}`);
	}

	const passed = results.filter((r) => r.pass).length;
	console.log('-------------------------------------------------------');
	console.log(`SMOKE RESULT: ${passed}/11 PASS`);
	if (RECORD) {
		golden.summary = { passed, total: 11, results };
		writeFileSync(RECORD, JSON.stringify(golden, null, 2) + '\n');
		console.log(`recorded → ${RECORD}`);
	}
	process.exit(passed === 11 ? 0 : 1);
}

main().catch((e) => {
	console.error('[FATAL]', e);
	console.log('SMOKE RESULT: FAILED (fatal)');
	process.exit(2);
});
