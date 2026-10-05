#!/usr/bin/env node
/**
 * P5.8 (#221) — certification benchmark: baseline (pre-P5) vs P5.
 *
 * MEASURED, NOT ESTIMATED. Every number is produced by running code on the
 * machine that runs this script. Nothing is a target, projection or reuse of an
 * earlier run. Run with `node --expose-gc` so bytes/op are meaningful.
 *
 *   node --expose-gc tools/p5/p5-certification-benchmark.mjs micro
 *       in-process P5 primitives: p50/p95/p99 ns and heap bytes/op for session
 *       validation, SecurityContext construction, authorization (cold, warm,
 *       deny), decision-cache hit/miss under a bounded mixed workload, SecretRef
 *       issuance, broker release, API-key authentication, vault open, and
 *       bounded-structure memory when every cache/table is filled to its cap.
 *
 *   node tools/p5/p5-certification-benchmark.mjs http --baseline <pre-P5 app dir> [--rounds 2]
 *       the SAME HTTP harness against two real server processes — the pre-P5
 *       build and this build — interleaved round by round so machine drift hits
 *       both equally: login (scrypt), authenticated request, unauthenticated
 *       request, credential create and read, and 64-way concurrency with the
 *       server's resident memory read from /proc/<pid>/status.
 *
 * The pre-P5 build has no SecurityContext, decision cache, SecretRef or API-key
 * path, so those rows have NO baseline — they are reported as P5-only, never
 * compared against an invented number.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..', '..');
const CATALOG_DIR = process.env.N8N_LEGO_CATALOG_DIR ?? join(APP, 'data');
const CONFIG = { catalogDir: CATALOG_DIR };

const machine = () => ({
  node: process.version,
  arch: process.arch,
  cpus: cpus().length,
  cpuModel: cpus()[0]?.model ?? 'unknown',
  totalMemMiB: Math.round(totalmem() / 1048576),
});

function percentiles(samples) {
  const sorted = Float64Array.from(samples).sort();
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const mean = sorted.reduce((sum, x) => sum + x, 0) / sorted.length;
  return { n: sorted.length, mean: Math.round(mean), p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), p99: Math.round(at(0.99)) };
}

/* =================================================================== micro */

async function micro() {
  const { createSessionStore, createSession, validateSession } = await import('../../src/auth/security/session.mjs');
  const { createSecurityContext } = await import('../../src/auth/security/security-context.mjs');
  const { authorize, authorizeCached, createDecisionCache, CACHE_POLICY } = await import('../../src/auth/security/authorization.mjs');
  const { permissionRegistryFor } = await import('../../src/auth/security/permission-registry.mjs');
  const { createPrincipalSnapshot } = await import('../../src/auth/security/principal.mjs');
  const { createSecurityStamp } = await import('../../src/auth/security/security-stamp.mjs');
  const { createSecretRefAuthority } = await import('../../src/auth/security/secret-ref.mjs');
  const { generateApiKey } = await import('../../src/auth/security/api-key.mjs');
  const { authenticateMachineCredential } = await import('../../src/auth/api-key-routes.mjs');
  const { createCredentialVault } = await import('../../src/auth/security/credential-vault.mjs');
  const { createMemoryKeyProvider } = await import('../../src/auth/security/key-provider.mjs');
  const { createStore } = await import('../../src/store.mjs');
  const { getGlobalScopes } = await import('../../src/compat/scopes.mjs');

  const gc = globalThis.gc ?? (() => {});
  const rows = [];
  function bench(name, fn, n = 100_000) {
    for (let i = 0; i < Math.min(n, 20_000); i += 1) fn(i);
    gc();
    const samples = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const t = process.hrtime.bigint();
      fn(i);
      samples[i] = Number(process.hrtime.bigint() - t);
    }
    // bytes/op: a separate loop, heap delta without an intervening GC.
    gc();
    const before = process.memoryUsage().heapUsed;
    const m = Math.min(n, 30_000);
    for (let i = 0; i < m; i += 1) fn(i);
    const bytesPerOp = Math.max(0, (process.memoryUsage().heapUsed - before) / m);
    rows.push({ name, unit: 'ns', ...percentiles(samples), bytesPerOp: +bytesPerOp.toFixed(1) });
  }

  const registry = permissionRegistryFor(CONFIG);
  const ownerScopes = getGlobalScopes({ role: 'global:owner' }, CONFIG);
  const principal = createPrincipalSnapshot({
    principalId: 'user:u1', identityId: 'u1', tenantId: 'default', principalType: 'user',
    authMethod: 'password', authStrength: 'password', permissions: ownerScopes, principalVersion: 1,
  });
  const stamp = createSecurityStamp({ principalVersion: 1, tenantVersion: 1, policyVersion: 1, sessionVersion: 1 });

  // --- authentication
  const sessions = createSessionStore();
  const live = createSession(sessions, { userId: 'u1' });
  bench('session validate (hit)', () => validateSession(sessions, live.sessionId, { touch: false }));
  bench('session validate (unknown id)', () => validateSession(sessions, 'ffffffffffffffffffffffffffffffff'));

  const store = createStore({ storage: 'memory' });
  const ownerId = 'owner000000000001';
  const keys = [];
  let raw = '';
  for (let i = 0; i < 50; i += 1) {
    const keyId = `key${String(i).padStart(7, '0')}`;
    const minted = generateApiKey({ ownerId, keyId });
    keys.push({ id: keyId, label: 'b', scopes: ['workflow:read', 'workflow:list'], audience: 'public-api', tenantId: 'default', digest: minted.digest, hint: minted.hint, createdAt: '', updatedAt: '', expiresAt: null, lastUsedAt: new Date(Date.now() + 3_600_000).toISOString(), revokedAt: null });
    raw = minted.raw;
  }
  store.users.insert({ id: ownerId, email: 'o@bench.test', role: 'global:owner', apiKeys: keys });
  bench('API-key authenticate (50 keys on owner)', () => authenticateMachineCredential({ store, config: CONFIG, presented: raw }), 50_000);

  // --- SecurityContext
  bench('SecurityContext construction', (i) => createSecurityContext({ principal, requestId: `r${i & 1023}`, tenantVersion: 1, policyVersion: 1, sessionVersion: 1 }));

  // --- authorization
  bench('authorize ALLOW (uncached)', () => authorize({ principal, action: 'workflow:read', resourceTenantId: 'default' }, { registry }));
  bench('authorize DENY (cross-tenant)', () => authorize({ principal, action: 'workflow:read', resourceTenantId: 'tenant-b' }, { registry }));
  bench('authorize DENY (unknown permission)', () => authorize({ principal, action: 'workflow:frobnicate', resourceTenantId: 'default' }, { registry }));
  const warm = createDecisionCache();
  const hitRequest = { principal, action: 'workflow:read', resourceTenantId: 'default' };
  authorizeCached(warm, hitRequest, { currentStamp: stamp, registry });
  bench('authorizeCached warm hit', () => authorizeCached(warm, hitRequest, { currentStamp: stamp, registry }));
  const churn = createDecisionCache({ ...CACHE_POLICY, maxEntries: 4_096, evictBatch: 64 });
  bench('authorizeCached miss (distinct resources)', (i) => authorizeCached(churn, { principal, action: 'workflow:read', resourceId: `wf-${i}`, resourceTenantId: 'default' }, { currentStamp: stamp, registry }));

  // Cache hit/miss under a bounded, skewed workload: 64 principals x 40 actions x
  // 500 resources, 80% of traffic on 20% of (principal, resource) pairs.
  const mixCache = createDecisionCache();
  const actions = registry.permissions.slice(0, 40);
  const principals = Array.from({ length: 64 }, (_, k) => createPrincipalSnapshot({
    principalId: `user:m${k}`, identityId: `m${k}`, tenantId: 'default', principalType: 'user',
    authMethod: 'password', authStrength: 'password', permissions: ownerScopes, principalVersion: 1,
  }));
  let hits = 0;
  let misses = 0;
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const mixN = 200_000;
  for (let i = 0; i < mixN; i += 1) {
    const hot = rand() < 0.8;
    const p = principals[Math.floor(rand() * (hot ? 13 : 64))];
    const resource = `wf-${Math.floor(rand() * (hot ? 100 : 500))}`;
    const request = { principal: p, action: actions[Math.floor(rand() * actions.length)], resourceId: resource, resourceTenantId: 'default' };
    const decision = authorizeCached(mixCache, request, { currentStamp: stamp, registry });
    if (decision.cached) hits += 1;
    else misses += 1;
  }
  const cacheMix = {
    workload: 'large working set: 64 principals x 40 actions x 500 resources, 80% on 13 principals x 100 resources (hot set ~52k keys > cap)',
    requests: mixN, hits, misses, hitRatio: +(hits / mixN).toFixed(4), entries: mixCache.size(), maxEntries: mixCache.policy().maxEntries,
  };
  // Second regime: a working set that fits (4 principals x 10 actions x 50 resources = 2,000 keys < cap).
  const smallCache = createDecisionCache();
  let smallHits = 0;
  for (let i = 0; i < mixN; i += 1) {
    const request = { principal: principals[Math.floor(rand() * 4)], action: actions[Math.floor(rand() * 10)], resourceId: `wf-${Math.floor(rand() * 50)}`, resourceTenantId: 'default' };
    if (authorizeCached(smallCache, request, { currentStamp: stamp, registry }).cached) smallHits += 1;
  }
  const cacheMixSmall = {
    workload: 'small working set: 4 principals x 10 actions x 50 resources (2,000 keys < cap)',
    requests: mixN, hits: smallHits, misses: mixN - smallHits, hitRatio: +(smallHits / mixN).toFixed(4), entries: smallCache.size(), maxEntries: smallCache.policy().maxEntries,
  };

  // --- SecretRef issuance and broker release
  const credential = { id: 'cred1', name: 'c', type: 'httpHeaderAuth', tenantId: 'default', credentialVersion: 1, data: { value: 'x'.repeat(40) } };
  const refs = createSecretRefAuthority({ materialOf: (c) => c.data.value, registry, maxLive: 1024 });
  const mintArgs = (i) => ({ principal, credential, requestId: `req-${i}`, audience: 'httpRequest', capability: 'cap.http', permission: 'credential:read', tenantId: 'default', capabilityGrants: ['cap.http'] });
  bench('SecretRef issuance (mint + redeem, pair)', (i) => {
    const ref = refs.mint(mintArgs(i));
    refs.redeem(ref, { requestId: `req-${i}`, audience: 'httpRequest', capability: 'cap.http', credentialVersion: 1 });
  }, 50_000);
  // Release alone: pre-mint a batch (bounded by maxLive), time only redeem.
  const releaseSamples = [];
  for (let round = 0; round < 50; round += 1) {
    const batch = Array.from({ length: 1000 }, (_, k) => refs.mint(mintArgs(`b${round}-${k}`)));
    for (let k = 0; k < batch.length; k += 1) {
      const t = process.hrtime.bigint();
      refs.redeem(batch[k], { requestId: `req-b${round}-${k}`, audience: 'httpRequest', capability: 'cap.http', credentialVersion: 1 });
      releaseSamples.push(Number(process.hrtime.bigint() - t));
    }
  }
  rows.push({ name: 'broker release (redeem only)', unit: 'ns', ...percentiles(releaseSamples), bytesPerOp: null });
  const mintSamples = [];
  for (let round = 0; round < 50; round += 1) {
    const minted = [];
    for (let k = 0; k < 1000; k += 1) {
      const t = process.hrtime.bigint();
      minted.push(refs.mint(mintArgs(`m${round}-${k}`)));
      mintSamples.push(Number(process.hrtime.bigint() - t));
    }
    for (let k = 0; k < minted.length; k += 1) refs.redeem(minted[k], { requestId: `req-m${round}-${k}`, audience: 'httpRequest', capability: 'cap.http', credentialVersion: 1 });
  }
  rows.push({ name: 'SecretRef issuance (mint only)', unit: 'ns', ...percentiles(mintSamples), bytesPerOp: null });

  // --- vault open (the only place a secret is decrypted)
  const vault = createCredentialVault({ provider: createMemoryKeyProvider() });
  const sealed = vault.sealData({ id: 'c1', type: 'httpHeaderAuth', tenantId: 'default' }, { name: 'X', value: 'y'.repeat(40) });
  const record = { id: 'c1', type: 'httpHeaderAuth', tenantId: 'default', ...sealed };
  bench('vault open (AES-256-GCM, AAD-bound)', () => vault.openData(record), 50_000);

  // --- bounded concurrency memory: fill every bounded structure past its cap
  gc();
  const heap0 = process.memoryUsage().heapUsed;
  const fullSessions = createSessionStore();
  for (let i = 0; i < 50_000; i += 1) createSession(fullSessions, { userId: `u${i}` });
  gc();
  const heapSessions = process.memoryUsage().heapUsed;
  const fullCache = createDecisionCache();
  for (let i = 0; i < 100_000; i += 1) authorizeCached(fullCache, { principal, action: 'workflow:read', resourceId: `r${i}`, resourceTenantId: 'default' }, { currentStamp: stamp, registry });
  gc();
  const heapCache = process.memoryUsage().heapUsed;
  const bounded = {
    sessions: { inserted: 50_000, retained: fullSessions.size?.() ?? null, cap: fullSessions.policy().maxSessions, heapMiB: +((heapSessions - heap0) / 1048576).toFixed(2) },
    decisionCache: { inserted: 100_000, retained: fullCache.size(), cap: fullCache.policy().maxEntries, heapMiB: +((heapCache - heapSessions) / 1048576).toFixed(2) },
  };

  return { mode: 'micro', machine: machine(), gcExposed: Boolean(globalThis.gc), rows, cacheMix, cacheMixSmall, bounded };
}

/* ==================================================================== http */

const PASSWORD = 'Bench-Passw0rd-1';

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

function rssOf(pid) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const kib = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(status)?.[1] ?? NaN);
  return { rssMiB: +(kib('VmRSS') / 1024).toFixed(1), hwmMiB: +(kib('VmHWM') / 1024).toFixed(1) };
}

async function boot(appDir, userFolder, port) {
  const child = spawn(process.execPath, [join(appDir, 'bin', 'n8n-lego.mjs'), 'start', '--no-fetch'], {
    env: {
      ...process.env,
      N8N_LEGO_PORT: String(port), N8N_LEGO_HOST: '127.0.0.1', N8N_LEGO_STORAGE: 'file',
      N8N_LEGO_LOG_LEVEL: 'error', N8N_LEGO_PROTOCOL: 'http', N8N_LEGO_USER_FOLDER: userFolder,
      N8N_LEGO_CATALOG_DIR: CATALOG_DIR, N8N_LEGO_SKIP_CATALOG_FETCH: '1',
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i += 1) {
    try {
      if ((await fetch(`${base}/rest/settings`)).ok) return { child, base };
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill('SIGKILL');
  throw new Error(`${appDir} did not start`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await exited;
}

function jarClient(base) {
  const jar = {};
  return async (method, path, body) => {
    const headers = { 'content-type': 'application/json', origin: base };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    const text = await res.text();
    return { status: res.status, text };
  };
}

async function timed(n, fn) {
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const t = process.hrtime.bigint();
    await fn(i);
    samples.push(Number(process.hrtime.bigint() - t) / 1000);
  }
  return percentiles(samples);
}

/** One full measurement of one build. Same steps, same order, for both builds. */
async function measureBuild(label, appDir) {
  const userFolder = mkdtempSync(join(tmpdir(), `p58-bench-${label}-`));
  const port = await freePort();
  try {
    // 1. owner via REST, then 9 more accounts seeded offline (same scrypt hash).
    let { child, base } = await boot(appDir, userFolder, port);
    const setup = jarClient(base);
    const ownerSetup = await setup('POST', '/rest/owner/setup', { email: 'u0@bench.test', firstName: 'B', lastName: 'U', password: PASSWORD });
    if (ownerSetup.status !== 200) throw new Error(`${label}: owner setup ${ownerSetup.status} ${ownerSetup.text}`);
    await stop(child);
    const usersFile = join(userFolder, 'users.json');
    const users = JSON.parse(readFileSync(usersFile, 'utf8'));
    const list = Array.isArray(users) ? users : Object.values(users);
    const ownerRecord = list[0];
    for (let k = 1; k < 10; k += 1) list.push({ ...structuredClone(ownerRecord), id: `${ownerRecord.id.slice(0, -2)}${String(k).padStart(2, '0')}`, email: `u${k}@bench.test`, role: 'global:member' });
    writeFileSync(usersFile, JSON.stringify(Array.isArray(users) ? list : Object.fromEntries(list.map((u) => [u.id, u]))));
    ({ child, base } = await boot(appDir, userFolder, port));
    const idle = rssOf(child.pid);

    // 2. login: 10 accounts x 4 = 40 real scrypt logins (under every limiter).
    const login = await timed(40, async (i) => {
      const r = await jarClient(base)('POST', '/rest/login', { emailOrLdapLoginId: `u${i % 10}@bench.test`, password: PASSWORD });
      if (r.status !== 200) throw new Error(`${label}: login ${r.status} ${r.text}`);
    });

    const call = jarClient(base);
    await call('POST', '/rest/login', { emailOrLdapLoginId: 'u0@bench.test', password: PASSWORD });

    // 3. authenticated request (session check on the request path).
    const authed = await timed(2000, async () => {
      const r = await call('GET', '/rest/workflows');
      if (r.status !== 200) throw new Error(`${label}: authed ${r.status}`);
    });
    // 4. unauthenticated request (the 401 path).
    const anon = jarClient(base);
    const unauth = await timed(2000, async () => {
      const r = await anon('GET', '/rest/workflows');
      if (r.status !== 401) throw new Error(`${label}: unauth ${r.status}`);
    });
    // 5. credential create (P5: seal) and read (P5: redaction; metadata only).
    const ids = [];
    const credCreate = await timed(200, async (i) => {
      const r = await call('POST', '/rest/credentials', { name: `c${i}`, type: 'httpHeaderAuth', data: { name: 'X', value: `secret-${i}` } });
      if (r.status !== 200) throw new Error(`${label}: cred create ${r.status} ${r.text}`);
      ids.push(JSON.parse(r.text).data.id);
    });
    const credRead = await timed(1000, async (i) => {
      const r = await call('GET', `/rest/credentials/${ids[i % ids.length]}`);
      if (r.status !== 200) throw new Error(`${label}: cred read ${r.status}`);
    });

    // 6. bounded concurrency: 64 clients x 50 authenticated requests.
    const clients = 64;
    const perClient = 50;
    const start = process.hrtime.bigint();
    const latencies = [];
    await Promise.all(Array.from({ length: clients }, async () => {
      for (let i = 0; i < perClient; i += 1) {
        const t = process.hrtime.bigint();
        const r = await call('GET', '/rest/workflows');
        latencies.push(Number(process.hrtime.bigint() - t) / 1000);
        if (r.status !== 200) throw new Error(`${label}: concurrent ${r.status}`);
      }
    }));
    const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
    const afterLoad = rssOf(child.pid);
    await stop(child);
    return {
      label,
      unit: 'us',
      idle,
      login,
      authenticatedRequest: authed,
      unauthenticatedRequest: unauth,
      credentialCreate: credCreate,
      credentialRead: credRead,
      concurrency: { clients, requests: clients * perClient, wallMs: Math.round(wallMs), throughputRps: Math.round((clients * perClient) / (wallMs / 1000)), latency: percentiles(latencies), serverMemory: afterLoad },
    };
  } finally {
    rmSync(userFolder, { recursive: true, force: true });
  }
}

async function http(args) {
  const baselineIndex = args.indexOf('--baseline');
  if (baselineIndex === -1) throw new Error('http mode needs --baseline <pre-P5 apps/n8n-lego dir>');
  const baselineApp = resolve(args[baselineIndex + 1]);
  const roundsIndex = args.indexOf('--rounds');
  const rounds = roundsIndex === -1 ? 2 : Number(args[roundsIndex + 1]);
  const results = [];
  for (let round = 1; round <= rounds; round += 1) {
    // Interleave and alternate who goes first, so drift and warm caches hit both.
    const order = round % 2 === 1 ? [['baseline', baselineApp], ['p5', APP]] : [['p5', APP], ['baseline', baselineApp]];
    for (const [label, dir] of order) results.push({ round, ...(await measureBuild(label, dir)) });
  }
  return { mode: 'http', machine: machine(), baselineApp, p5App: APP, rounds, results };
}

/* ==================================================================== main */

const [mode, ...rest] = process.argv.slice(2);
const output = mode === 'micro' ? await micro() : mode === 'http' ? await http(rest) : null;
if (!output) {
  process.stderr.write('usage: p5-certification-benchmark.mjs micro | http --baseline <dir> [--rounds N]\n');
  process.exit(64);
}
process.stdout.write(`${JSON.stringify(output, null, 1)}\n`);
