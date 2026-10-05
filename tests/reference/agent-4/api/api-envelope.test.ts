/**
 * API LEGO — reference tests (n8n 2.9.4 internal REST + public API envelopes)
 *  - golden consistency (api.golden.json, baseline-before.json)
 *  - optional live replay (N8N_URL)
 * Run: node --test tests/reference/agent-4/api/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { golden, here, LIVE, live, liveLogin, stripStack } from '../helpers.ts';

const g = golden('api');
const c = g.cases;
const baseline = JSON.parse(readFileSync(resolve(here, 'live', 'baseline-before.json'), 'utf8'));

test('API golden: health endpoints and unauthenticated envelope', () => {
	assert.deepEqual(c.healthz.expected, { status: 200, body: { status: 'ok' } });
	assert.deepEqual(c.readiness.expected, { status: 200, body: { status: 'ok' } });
	// unauthenticated is NOT the {code,message} envelope
	assert.deepEqual(c.unauthenticated.expected, { status: 401, body: { status: 'error', message: 'Unauthorized' } });
});

test('API golden: success envelope {data} for objects, booleans and null', () => {
	assert.deepEqual(c.me.expected.envelope, ['data']);
	assert.equal(c.me.expected.role, 'global:owner');
	assert.deepEqual(c.workflowCreateEmpty.expected.envelope, ['data']);
	assert.deepEqual(c.workflowCreateEmpty.expected.dataKeys, ['active', 'activeVersion', 'activeVersionId', 'checksum', 'connections', 'createdAt', 'description', 'homeProject', 'id', 'isArchived', 'meta', 'name', 'nodes', 'parentFolder', 'pinData', 'scopes', 'settings', 'sharedWithProjects', 'staticData', 'tags', 'triggerCount', 'updatedAt', 'usedCredentials', 'versionCounter', 'versionId']);
	const cred = golden('credentials');
	assert.deepEqual(cred.cases.delete.expected.body, { data: true });
	const trig = golden('trigger-scheduler');
	assert.deepEqual(trig.cases.activationErrorNone.expected.body, { data: null });
});

test('API golden: known errors use {code,message[,hint][,meta]}; unknown errors use code 0', () => {
	assert.deepEqual(c.loginWrongPassword.expected, { status: 401, body: { code: 401, message: 'Wrong username or password. Do you have caps lock on?' } });
	assert.deepEqual(c.ownerSetupTwice.expected, { status: 400, body: { code: 400, message: 'Instance owner already setup' } });
	assert.deepEqual(c.workflowNotFound.expected, { status: 404, body: { code: 404, message: 'Could not load the workflow - you can only access workflows owned by you' } });
	assert.deepEqual(c.workflowActivateWithoutTrigger.expected, { status: 400, body: { code: 400, message: 'Workflow cannot be activated because it has no trigger node. At least one trigger, webhook, or polling node is required.', meta: { validationError: true } } });
	assert.deepEqual(c.executionNotANumber.expected, { status: 400, body: { code: 400, message: 'Execution ID is not a number' } });
	assert.deepEqual(c.workflowDelete.expected, { status: 400, body: { code: 400, message: 'Workflow must be archived before it can be deleted.' } });
	const cred = golden('credentials');
	assert.deepEqual(cred.cases.createInvalidType.expected, { status: 500, body: { code: 0, message: 'Unrecognized credential type: noSuchCredentialType' } });
	const wh = golden('webhook');
	assert.equal(wh.cases.secondActivationSamePath.expected.body.code, 409);
});

test('API golden: zod validation errors are 400 with the raw first issue (no envelope)', () => {
	assert.deepEqual(c.loginValidationError.expected, { status: 400, body: { code: 'invalid_type', expected: 'string', received: 'undefined', path: ['emailOrLdapLoginId'], message: 'Required' } });
	assert.deepEqual(c.workflowCreateValidation.expected, { status: 400, body: { code: 'too_small', minimum: 1, type: 'string', inclusive: true, exact: false, message: 'Workflow name is required', path: ['name'] } });
	assert.deepEqual(c.workflowCreateNodesNotArray.expected, { status: 400, body: { code: 'custom', message: 'Nodes must be an array', fatal: true, path: ['nodes'] } });
	assert.deepEqual(c.workflowCreateMissingBody.expected, { status: 400, body: { code: 'invalid_type', expected: 'string', received: 'undefined', path: ['name'], message: 'Required' } });
});

test('API golden: not-found semantics differ per resource (workflow 404, execution 200 {}, unknown route SPA 404 html)', () => {
	assert.equal(c.workflowNotFound.expected.status, 404);
	assert.deepEqual(c.executionNotFound.expected, { status: 200, body: {} });
	assert.equal(c.unknownRestRouteFallsThroughToSpa.expected.status, 404);
	assert.equal(c.unknownRestRouteFallsThroughToSpa.expected.isHtml, true);
	assert.match(c.unknownRestRouteFallsThroughToSpa.expected.contentType, /^text\/html/);
});

test('API golden: public API v1 auth errors', () => {
	assert.deepEqual(c.publicApiNoKey.expected, { status: 401, body: { message: "'X-N8N-API-KEY' header required" } });
	assert.deepEqual(c.publicApiBadKey.expected, { status: 401, body: { message: 'unauthorized' } });
});

test('API golden: baseline smoke steps (settings public vs authenticated, owner setup, manual run)', () => {
	assert.equal(baseline.steps.healthz.status, 200);
	assert.equal(baseline.steps.settingsAuthenticated.versionCli, '2.9.4');
	assert.equal(baseline.steps.me.role, 'global:owner');
	assert.equal(stripStack(baseline.steps.ownerSetup.body).message, 'Instance owner already setup'); // recorded on a re-run (owner existed)
	assert.deepEqual(baseline.steps.manualRun.bodyKeys, ['executionId']);
	assert.equal(baseline.summary.passed, 11);
	assert.equal(baseline.summary.total, 11);
});

test('API live: valid / invalid / not found / validation error / success', { skip: LIVE ? false : 'N8N_URL not set' }, async () => {
	assert.deepEqual((await live('GET', '/healthz', undefined, { noAuth: true })).json, { status: 'ok' });
	assert.deepEqual((await live('GET', '/rest/workflows', undefined, { noAuth: true })).json, { status: 'error', message: 'Unauthorized' });
	const badLogin = await live('POST', '/rest/login', {}, { noAuth: true });
	assert.equal(badLogin.status, 400);
	assert.equal(badLogin.json.code, 'invalid_type');
	await liveLogin();
	const nf = await live('GET', '/rest/workflows/does-not-exist');
	assert.equal(nf.status, 404);
	assert.deepEqual(stripStack(nf.json), { code: 404, message: 'Could not load the workflow - you can only access workflows owned by you' });
	const val = await live('POST', '/rest/workflows', { name: '', nodes: [], connections: {} });
	assert.equal(val.status, 400);
	assert.equal(val.json.message, 'Workflow name is required');
	const ok = await live('POST', '/rest/workflows', { name: `Agent4 api live ${Date.now()}`, nodes: [], connections: {} });
	assert.equal(ok.status, 200);
	assert.deepEqual(Object.keys(ok.json), ['data']);
	const spa = await live('GET', '/rest/this-does-not-exist');
	assert.equal(spa.status, 404);
	assert.match(spa.headers.get('content-type') ?? '', /text\/html/);
	const pub = await live('GET', '/api/v1/workflows', undefined, { noAuth: true });
	assert.deepEqual(pub.json, { message: "'X-N8N-API-KEY' header required" });
	await live('POST', `/rest/workflows/${ok.json.data.id}/archive`, {});
	await live('DELETE', `/rest/workflows/${ok.json.data.id}`);
});
