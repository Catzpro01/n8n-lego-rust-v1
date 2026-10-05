/**
 * Shared helpers for Agent 4 reference tests.
 *
 * Runtime modes
 *  - N8N_RUNTIME=<dir containing node_modules/n8n>  → unit tests drive the real
 *    n8n 2.9.4 classes (ActiveWorkflows, ScheduledTaskManager, Cipher, Credentials…).
 *  - N8N_URL=http://host:5678 (+ N8N_OWNER_EMAIL / N8N_OWNER_PASS) → live replays.
 *  Without either, the offline golden-consistency tests still run.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const goldenDir = resolve(here, 'golden');

export function golden<T = any>(name: string): T {
	return JSON.parse(readFileSync(resolve(goldenDir, `${name}.golden.json`), 'utf8')) as T;
}

export const RUNTIME = process.env.N8N_RUNTIME ?? '/home/user/n8n-runtime';
export const hasRuntime = existsSync(resolve(RUNTIME, 'node_modules', 'n8n-core', 'package.json'));

let _req: NodeRequire | undefined;
export function n8nRequire<T = any>(mod: string): T {
	_req ??= createRequire(resolve(RUNTIME, 'package.json'));
	return _req(mod) as T;
}

/** Minimal stand-ins for DI-injected infrastructure (no network, no db). */
export const fakeLogger = () => {
	const l: any = { debug() {}, info() {}, warn() {}, error() {} };
	l.scoped = () => l;
	return l;
};
export const fakeErrorReporter = () => {
	const calls: any[] = [];
	return { calls, error: (...a: any[]) => calls.push(a), warn() {}, info() {} };
};
export const fakeTracing = () => ({
	startSpan: async (_o: any, fn: (span: any) => any) => await fn({ setStatus() {}, setAttributes() {} }),
	pickWorkflowAttributes: () => ({}),
	pickNodeAttributes: () => ({}),
});

/** A stub `Workflow` exposing what ActiveWorkflows reads. */
export function fakeWorkflow(opts: { id: string; triggerNodes?: any[]; pollNodes?: any[]; nodeTypes: any; timezone?: string; name?: string }) {
	return {
		id: opts.id,
		name: opts.name ?? opts.id,
		timezone: opts.timezone ?? 'UTC',
		nodeTypes: opts.nodeTypes,
		getTriggerNodes: () => opts.triggerNodes ?? [],
		getPollNodes: () => opts.pollNodes ?? [],
	};
}

// ---------------- live helpers ----------------
export const LIVE = process.env.N8N_URL?.replace(/\/$/, '');
const EMAIL = process.env.N8N_OWNER_EMAIL ?? 'agent4@example.com';
const PASS = process.env.N8N_OWNER_PASS ?? 'Agent4Smoke!2026';
let cookie = '';

export async function live(method: string, path: string, body?: unknown, opts: { noAuth?: boolean; headers?: Record<string, string> } = {}) {
	if (!LIVE) throw new Error('N8N_URL not set');
	const headers: Record<string, string> = { ...(opts.headers ?? {}) };
	if (body !== undefined) headers['content-type'] = 'application/json';
	if (cookie && !opts.noAuth) headers.cookie = cookie;
	const res = await fetch(LIVE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
	const sc = res.headers.get('set-cookie');
	if (sc?.includes('n8n-auth=')) cookie = sc.split(';')[0];
	const text = await res.text();
	let json: any;
	try {
		json = JSON.parse(text);
	} catch {}
	return { status: res.status, json, text, headers: res.headers };
}

export async function liveLogin() {
	const l = await live('POST', '/rest/login', { emailOrLdapLoginId: EMAIL, password: PASS }, { noAuth: true });
	if (l.status !== 200) throw new Error(`login failed: ${l.status} ${l.text}`);
}

export const stripStack = (b: any) => {
	if (b && typeof b === 'object' && 'stacktrace' in b) {
		const { stacktrace, ...rest } = b;
		return rest;
	}
	return b;
};
