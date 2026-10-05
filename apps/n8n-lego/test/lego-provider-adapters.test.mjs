/**
 * P2.25 — External Provider Integration: the first real adapters.
 *
 * The required matrix (Master Prompt §31): contract, provider configuration
 * (none/valid/invalid/unknown), model adapter, tool adapter, runtime adapter,
 * security, honest usage, and the no-provider AI Foundation. Everything runs
 * OFFLINE against deterministic injected exchanges — the suite never depends
 * on a third-party service, never holds a credential, and never fakes a pass:
 * every refusal asserts its canonical error code from errors.contract.json.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { AI_FOUNDATION, PROVIDER_KINDS, AI_TRANSPORTS } from '../src/lego/ai-foundation.mjs';
import { loadRegistry } from '../src/lego/registry.mjs';
import {
  MODEL_GATEWAY_CONTRACT,
  MODEL_GATEWAY_CONTRACT_VERSION,
  MODEL_GATEWAY_OPERATIONS,
  MODEL_GATEWAY_PERMISSIONS,
  MODEL_PROVIDER_ERROR_CODES,
  MODEL_PROVIDER_LIMITS,
  ModelProviderError,
  PROVIDER_ADAPTER_STATES,
  PROVIDER_ERROR_TRANSLATION,
  createModelProviderAdapter,
  describeProviderConfiguration,
} from '../src/lego/model-provider-adapter.mjs';
import {
  TOOL_GATEWAY_CONTRACT,
  TOOL_GATEWAY_CONTRACT_VERSION,
  TOOL_GATEWAY_OPERATIONS,
  TOOL_GATEWAY_PERMISSIONS,
  TOOL_PROVIDER_ERROR_CODES,
  TOOL_PROVIDER_LIMITS,
  ToolProviderError,
  PROVIDER_ADAPTER_STATES as TOOL_PROVIDER_ADAPTER_STATES,
  PROVIDER_ERROR_TRANSLATION as TOOL_PROVIDER_ERROR_TRANSLATION,
  createToolProviderAdapter,
  describeProviderConfiguration as describeToolProviderConfiguration,
} from '../src/lego/tool-provider-adapter.mjs';
import {
  EXTERNAL_RUNTIME_CONTRACT,
  EXTERNAL_RUNTIME_ERROR_CODES,
  EXTERNAL_RUNTIME_ERROR_TRANSLATION,
  EXTERNAL_RUNTIME_LIMITS,
  ExternalRuntimeError,
  createExternalRuntime,
} from '../src/lego/external-runtime.mjs';
import {
  ADAPTER_RUNTIME_CONTRACT,
  RUNTIME_LIFECYCLE_TRANSLATION,
  createRuntimeRegistry,
  createRuntimeAdapter,
} from '../src/lego/runtime-adapter.mjs';
import {
  createTokenUsageFoundation,
  USAGE_STATUSES,
} from '../src/lego/token-usage.mjs';

/* ------------------------------------------------------------------ helpers */

const LOCK = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
const ERRORS = JSON.parse(readFileSync(new URL('../src/lego/contracts/errors.contract.json', import.meta.url), 'utf8'));
const MODEL_SRC = readFileSync(new URL('../src/lego/model-provider-adapter.mjs', import.meta.url), 'utf8');
const TOOL_SRC = readFileSync(new URL('../src/lego/tool-provider-adapter.mjs', import.meta.url), 'utf8');
const EXTERNAL_SRC = readFileSync(new URL('../src/lego/external-runtime.mjs', import.meta.url), 'utf8');
const AI_FOUNDATION_JSON = JSON.parse(readFileSync(new URL('../src/lego/manifest/ai-foundation.json', import.meta.url), 'utf8'));

const FIXED_NOW = '2026-09-23T00:00:00.000Z';
const now = () => FIXED_NOW;
const counter = (prefix = 'id') => {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(4, '0')}`;
};

const MODEL_CONFIG = Object.freeze({
  providerId: 'prov-main',
  kind: 'model-provider',
  availability: 'available',
  transport: 'remote',
  endpoint: 'provider.example/models',
  models: Object.freeze([
    Object.freeze({ modelId: 'm-chat', availability: 'available', streaming: true, embedding: true }),
    Object.freeze({ modelId: 'm-off', availability: 'disabled' }),
    Object.freeze({ modelId: 'm-nostream', availability: 'available', streaming: false }),
  ]),
});

const TOOL_CONFIG = Object.freeze({
  providerId: 'prov-tools',
  kind: 'tool-provider',
  availability: 'available',
  transport: 'remote',
  tools: Object.freeze([
    Object.freeze({ toolId: 'search', sideEffects: 'read-only', availability: 'available', inputSchema: Object.freeze({ type: 'object' }) }),
    Object.freeze({ toolId: 'ship', sideEffects: 'destructive', availability: 'available', inputSchema: Object.freeze({}), requiresApproval: true }),
    Object.freeze({ toolId: 'retired', sideEffects: 'writes', availability: 'disabled', inputSchema: Object.freeze({}) }),
  ]),
});

const AUTH_READ_MODEL = Object.freeze({ permission: 'ai:model:read' });
const AUTH_INVOKE_MODEL = Object.freeze({ permission: 'ai:model:invoke', grantReference: 'grant/model-1' });
const AUTH_READ_TOOL = Object.freeze({ permission: 'ai:tool:read' });
const AUTH_INVOKE_TOOL = Object.freeze({ permission: 'ai:tool:invoke', grantReference: 'grant/tool-1' });

/** Exchange stub: op → response (or function returning/throwing). */
const exchangeOf = (handlers) => {
  const calls = [];
  const exchange = async (request) => {
    calls.push(request);
    const handler = handlers[request.op];
    if (handler === undefined) throw Object.assign(new Error('no handler'), { kind: 'unavailable' });
    const value = typeof handler === 'function' ? handler(request) : handler;
    return value;
  };
  exchange.calls = calls;
  return exchange;
};

const modelAdapter = (options = {}) => createModelProviderAdapter({
  config: options.config ?? MODEL_CONFIG,
  exchange: options.exchange ?? exchangeOf({
    'models.list': { models: [{ modelId: 'm-chat', availability: 'available' }, { modelId: 'm-off', availability: 'available' }, { modelId: 'ghost', availability: 'available' }] },
    'model.describe': { modelId: 'm-chat' },
    generate: { output: 'hello world', usage: { inputTokens: 11, outputTokens: 7 } },
    stream: { chunks: ['he', 'llo'], usage: { inputTokens: 5, outputTokens: 2 } },
    embed: { embeddings: [[0.1, 0.2], [0.3, 0.4]], usage: { inputTokens: 9 } },
    countTokens: { count: 4 },
  }),
  recordUsage: options.recordUsage,
  now: options.now ?? now,
  newId: options.newId ?? counter('mdl'),
});

const toolAdapter = (options = {}) => createToolProviderAdapter({
  config: options.config ?? TOOL_CONFIG,
  exchange: options.exchange ?? exchangeOf({
    'tools.list': { tools: [{ toolId: 'search' }, { toolId: 'ship' }, { toolId: 'phantom' }] },
    'tool.describe': {},
    'tool.call': { outcome: 'succeeded', result: { ok: true }, resultReference: 'res/1' },
    'resources.list': { resources: [{ resourceId: 'doc/1', description: 'readme' }] },
    'resource.read': { content: 'resource body' },
    'prompts.list': { prompts: [{ promptId: 'summarize' }] },
    'prompt.get': { content: 'Summarize…' },
  }),
  now: options.now ?? now,
  newId: options.newId ?? counter('tool'),
});

const SUPPORTS = Object.freeze({
  session: true, background: false, stream: false, cancellation: true, delegation: false,
});

const externalOf = (options = {}) => createExternalRuntime({
  runtimeId: options.runtimeId ?? 'ext-1',
  kind: 'agent-runtime',
  transport: 'remote',
  locality: 'remote',
  supports: options.supports ?? SUPPORTS,
  timeoutMs: options.timeoutMs ?? 5000,
  now: options.now ?? now,
  newId: options.newId ?? counter('ext'),
  exchange: options.exchange ?? ((request) => {
    if (request.op === 'exchange') return { outcome: 'succeeded', final: true, resultReference: 'res/x' };
    if (request.op === 'cancel') return { cancelled: true };
    throw Object.assign(new Error('down'), { kind: 'unavailable' });
  }),
});

const wireRuntime = (options = {}) => {
  const registry = createRuntimeRegistry({ now, newId: counter('reg') });
  const runtime = externalOf(options);
  registry.register(runtime.declaration(options.providerId ?? 'prov-1'));
  const adapter = createRuntimeAdapter({
    registry, runtimeId: runtime.runtimeId, runtime, now, newId: counter('adv'),
  });
  return { registry, runtime, adapter };
};

const caughtAsync = async (block) => {
  try { await block(); } catch (error) { return error; }
  throw new Error('expected a throw, got none');
};

const registry = loadRegistry({ reload: true });
const domain = () => registry.byId.get('ai-foundation');
const capability = (id) => domain().capabilities.find((entry) => entry.id === id);
const row = (id) => LOCK.contracts.find((entry) => entry.id === id);
const errorCodes = new Set(ERRORS.codes.map((entry) => entry.code));

/* ============================================================ A. CONTRACT */

test('model & tool gateway contracts are locked exactly once at the quoted versions', () => {
  assert.equal(MODEL_GATEWAY_CONTRACT.id, "ai.model-gateway");
  assert.equal(MODEL_GATEWAY_CONTRACT_VERSION, '1.0.0');
  assert.equal(MODEL_GATEWAY_CONTRACT.owner, 'manager');
  assert.equal(TOOL_GATEWAY_CONTRACT.id, "ai.tool-gateway");
  assert.equal(TOOL_GATEWAY_CONTRACT_VERSION, '1.0.0');
  assert.equal(TOOL_GATEWAY_CONTRACT.owner, 'manager');
  assert.equal(LOCK.contracts.filter((r) => r.id === 'ai.model-gateway').length, 1);
  assert.equal(LOCK.contracts.filter((r) => r.id === 'ai.tool-gateway').length, 1);
  // P9.1 envelope + P3 optimizer are merged; P9.2 structured-log adds row 42.
  assert.equal(LOCK.contracts.length, 100, 'P2.25 added rows thirty and thirty-one; P2.26 the thirty-second; P3 Slice A the thirty-third (workflow.graph); P3 Slice D the thirty-fourth (execution.frontier); P3 Slice E the thirty-fifth (execution.state-stream); P3 Slice H the thirty-sixth (workflow.dna); P3 Slice J the thirty-seventh (execution.ir); P3 Slice L the thirty-eighth (compatibility.oracle); P3 Slice M the thirty-ninth (execution.guard); P3 Slice K the forty-first (execution.optimizer) — P6.1 adds node.registry@0.1.0; P6.2 adds registry.compiler@0.1.0; P6.3 adds package.transaction@0.1.0; P6.4 adds registry.closure@0.1.0; P6.5 adds node.resolution@0.1.0; P6.6 adds runtime.lease@0.1.0; P6.7 adds node.residency@0.1.0; P6.8 adds node.capability@0.1.0; P6.9 adds node.semantics@0.1.0; P6.10 adds node.lifecycle@0.1.0; P6.11 adds node.health@0.1.0; P6.12 adds node.supply-chain@0.1.0; P6.13 adds registry.incremental@0.1.0; P6.14 adds node.worker-convergence@0.1.0; P6.15 adds node.acceptance@0.1.0; P6.16 adds registry.integrity@0.1.0; P6.17 adds node.admission@0.1.0; P6.18 adds node.sbom@0.1.0; P6.19 adds node.canary@0.1.0; P6.20 adds node.revocation@0.1.0; P6.21 adds node.io@0.1.0; P6.22 adds runtime.jit@0.1.0; P6.23 adds runtime.cancel@0.1.0; P6.24 adds runtime.pool@0.1.0; P6.25 adds node.abi@0.1.0; P6.26 adds runtime.wasm-cache@0.1.0; P6.27 adds node.provenance@0.1.0; P6.28 adds registry.freshness@0.1.0; P6.29 adds node.namespace@0.1.0; P6.30 adds registry.repair@0.1.0; P6.31 adds registry.acceptance@0.1.0; count-pins say 76; P2.27.1 adds lego.plugin-runtime@0.1.0 (seventy-sixth); P5.1 adds the ninety-fifth (auth.principal)'); // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
});

test('ai.agent-runtime stays vocabulary — the lock deliberately publishes no such row', () => {
  assert.equal(LOCK.contracts.filter((r) => r.id === 'ai.agent-runtime').length, 0,
    'the lifecycle contract is registered against (ai.agent-runtime@1.0.0) but never locked as its own row');
});

test('operation and permission vocabularies are quoted byte-for-byte from the manifests — none invented', () => {
  assert.deepEqual([...MODEL_GATEWAY_OPERATIONS],
    AI_FOUNDATION.modelGateway.operations.map((op) => op.name));
  assert.deepEqual([...TOOL_GATEWAY_OPERATIONS],
    AI_FOUNDATION.toolGateway.operations.map((op) => op.name));
  assert.deepEqual([...MODEL_GATEWAY_PERMISSIONS], ['ai:model:invoke', 'ai:model:read']);
  assert.deepEqual([...TOOL_GATEWAY_PERMISSIONS], ['ai:tool:invoke', 'ai:tool:read']);
  assert.deepEqual([...MODEL_GATEWAY_PERMISSIONS], [...capability('ai.model-gateway').permissions]);
  assert.deepEqual([...TOOL_GATEWAY_PERMISSIONS], [...capability('ai.tool-gateway').permissions]);
  assert.deepEqual(MODEL_GATEWAY_OPERATIONS.map((name) => capability('ai.model-gateway').operations.find((op) => op.name === name).permission),
    MODEL_GATEWAY_OPERATIONS.map((name) => AI_FOUNDATION.modelGateway.operations.find((op) => op.name === name).permission),
    'each operation names the same permission in registry and contract manifest');
});

test('registry, manifest and lock agree three ways on the new rows (status fields stay untouched)', () => {
  for (const [id, surface, moduleExports] of [
    ['ai.model-gateway', 'src/lego/model-provider-adapter.mjs', Object.keys({ MODEL_GATEWAY_CONTRACT: 1, MODEL_GATEWAY_CONTRACT_VERSION: 1, MODEL_GATEWAY_OPERATIONS: 1, MODEL_GATEWAY_PERMISSIONS: 1, MODEL_PROVIDER_ERROR_CODES: 1, MODEL_PROVIDER_LIMITS: 1, ModelProviderError: 1, PROVIDER_ADAPTER_STATES: 1, PROVIDER_ERROR_TRANSLATION: 1, createModelProviderAdapter: 1, describeProviderConfiguration: 1 })],
    ['ai.tool-gateway', 'src/lego/tool-provider-adapter.mjs', Object.keys({ PROVIDER_ADAPTER_STATES: 1, PROVIDER_ERROR_TRANSLATION: 1, TOOL_GATEWAY_CONTRACT: 1, TOOL_GATEWAY_CONTRACT_VERSION: 1, TOOL_GATEWAY_OPERATIONS: 1, TOOL_GATEWAY_PERMISSIONS: 1, TOOL_PROVIDER_ERROR_CODES: 1, TOOL_PROVIDER_LIMITS: 1, ToolProviderError: 1, createToolProviderAdapter: 1, describeProviderConfiguration: 1 })],
  ]) {
    const r = row(id);
    assert.equal(r.status, 'implemented', `${id} row implements the adapter surface`);
    assert.equal(r.owner, 'manager');
    assert.equal(r.domain, 'ai-foundation');
    assert.deepEqual(r.surface, [surface]);
    assert.deepEqual(r.exports[surface].slice().sort(), moduleExports.sort());
    assert.deepEqual(r.operations, [...(id === 'ai.model-gateway' ? MODEL_GATEWAY_OPERATIONS : TOOL_GATEWAY_OPERATIONS)]);
    assert.ok(r.tests.every((path) => path.endsWith('.mjs')));
    // The provider-facing CAPABILITY stays contract-only (P2.21 pattern: an adapter
    // implementation never quietly flips the capability — test 135 keeps its teeth).
    const cap = capability(id);
    assert.equal(cap.status, 'contract-only');
    assert.equal(cap.lifecycle, 'declared');
  }
  for (const cid of ['ai.agent-runtime', 'ai.application-provider']) {
    assert.equal(capability(cid).status, 'contract-only', `${cid} must never be quietly implemented`);
  }
});

test('the runtime-adapter row is a MINOR 1.1.0 with both surfaces — seam behaviour untouched', () => {
  const r = row('ai.runtime-adapter');
  assert.equal(r.version, '1.1.0');
  assert.deepEqual(r.surface, ['src/lego/runtime-adapter.mjs', 'src/lego/external-runtime.mjs']);
  assert.deepEqual(r.exports['src/lego/external-runtime.mjs'].slice().sort(), [
    'EXTERNAL_RUNTIME_CONTRACT', 'EXTERNAL_RUNTIME_ERROR_CODES', 'EXTERNAL_RUNTIME_ERROR_TRANSLATION',
    'EXTERNAL_RUNTIME_LIMITS', 'ExternalRuntimeError', 'createExternalRuntime',
  ]);
  assert.deepEqual(r.exports['src/lego/runtime-adapter.mjs'].slice().sort(), Object.keys({
    RUNTIME_ADAPTER_CONTRACT: 1, RUNTIME_ADAPTER_CONTRACT_VERSION: 1, RUNTIME_ADAPTER_FIELDS: 1,
    RUNTIME_ADAPTER_OPERATIONS: 1, RUNTIME_ADAPTER_PERMISSIONS: 1, ADAPTER_CAPABILITIES: 1,
    ADAPTER_LOCALITIES: 1, ADAPTER_EXECUTOR_KINDS: 1, ADAPTER_AGENT_MACHINE_VERSION: 1,
    ADAPTER_RUNTIME_CONTRACT: 1, ADAPTER_AVAILABILITIES: 1, RUNTIME_LIFECYCLE_TRANSLATION: 1,
    ADAPTER_LIMITS: 1, RuntimeAdapterError: 1, createRuntimeRegistry: 1, createRuntimeAdapter: 1,
    createSimulatedRuntime: 1, createAdapterHarness: 1,
  }).sort(), 'P2.21 export surface unchanged');
  for (const rel of r.surface) {
    assert.ok(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').length > 0, `${rel} exists`);
  }
});

test('every emitted error code exists in the frozen error contract — no second error family', () => {
  for (const code of [...MODEL_PROVIDER_ERROR_CODES, ...TOOL_PROVIDER_ERROR_CODES, ...EXTERNAL_RUNTIME_ERROR_CODES]) {
    assert.ok(errorCodes.has(code), `${code} must be declared in errors.contract.json 1.2.0`);
    assert.equal(MODEL_PROVIDER_ERROR_CODES.includes(code), true);
  }
  assert.ok(ERRORS.version.startsWith('1.'), 'error contract version unchanged by P2.25');
  // Error classes refuse to be constructed with an undeclared code at all.
  assert.throws(() => new ModelProviderError('lego.invented_code', 'x'), /declare it in src\/lego\/contracts\/errors.contract.json/);
  assert.throws(() => new ToolProviderError('lego.invented_code', 'x'), /declare it in src\/lego\/contracts\/errors.contract.json/);
  assert.throws(() => new ExternalRuntimeError('lego.invented_code', 'x'), /declare it in src\/lego\/contracts\/errors.contract.json/);
});

test('provider adapter states are one six-word vocabulary shared byte-for-byte by both adapters', () => {
  assert.deepEqual([...PROVIDER_ADAPTER_STATES],
    ['not-configured', 'configured', 'available', 'unavailable', 'degraded', 'disabled']);
  assert.deepEqual([...TOOL_PROVIDER_ADAPTER_STATES], [...PROVIDER_ADAPTER_STATES],
    'two modules, one vocabulary — never two dialects');
  assert.deepEqual(PROVIDER_ERROR_TRANSLATION, TOOL_PROVIDER_ERROR_TRANSLATION);
  assert.deepEqual(Object.keys(PROVIDER_ERROR_TRANSLATION).sort(),
    Object.keys(EXTERNAL_RUNTIME_ERROR_TRANSLATION).sort());
});

/* ================================================ B. PROVIDER CONFIGURATION */

test('no provider configured: the foundation stays fully valid and reports not-configured honestly', () => {
  const none = describeProviderConfiguration(null);
  assert.equal(none.configuration, 'not-configured');
  assert.equal(none.state, 'not-configured');
  assert.equal(none.providerId, null);
  assert.equal(none.reportedAs, 'capability-unavailable');
  assert.equal(none.reason, 'no inference provider configured', 'quoted from ai.foundation#zeroInstall.reportedAs');
  assert.equal(none.valid, true, 'no configured provider ≠ broken AI Foundation');
  // The foundation itself: loads, validates, lists capabilities, resolves policy.
  assert.equal(AI_FOUNDATION.status, 'contract-only');
  assert.ok(AI_FOUNDATION.modelGateway.operations.length === 6);
  assert.ok(AI_FOUNDATION.toolGateway.operations.length === 7);
  assert.match(AI_FOUNDATION.zeroInstall.rule, /VALID, fully supported/);
  assert.equal(AI_FOUNDATION.zeroInstall.state.modelProvider, 'not-configured');
  assert.equal(AI_FOUNDATION.zeroInstall.state.toolProvider, 'not-configured');
  assert.equal(AI_FOUNDATION.zeroInstall.state.agentRuntime, 'not-configured');
  const toolNone = describeToolProviderConfiguration(null);
  assert.equal(toolNone.configuration, 'not-configured');
  assert.equal(toolNone.reason, 'no tool provider configured');
  assert.equal(toolNone.valid, true);
});

test('valid configuration: status is configured (not yet available), declarations readable', async () => {
  const a = modelAdapter();
  const status = a.status();
  assert.equal(status.configuration, 'configured');
  assert.equal(status.state, 'configured', 'configured ≠ available: no exchange has succeeded yet');
  assert.equal(status.providerId, 'prov-main');
  assert.equal(status.configuredAt, FIXED_NOW, 'injected clock only');
  assert.deepEqual([...status.modelIds], ['m-chat', 'm-off', 'm-nostream']);
  assert.deepEqual(describeProviderConfiguration(a).configuration, 'configured');
  await a.modelsList({ authorization: AUTH_READ_MODEL });
  assert.equal(a.status().state, 'available', 'one successful exchange promotes to available');
  const t = toolAdapter();
  assert.equal(t.status().state, 'configured');
  await t.toolsList({ authorization: AUTH_READ_TOOL });
  assert.equal(t.status().state, 'available');
});

test('invalid configuration fails closed with lego.contract_violation — required fields, no defaults', () => {
  const base = { ...MODEL_CONFIG, models: [{ modelId: 'm1', availability: 'available' }] };
  for (const [broken, pattern] of [
    [{ ...base, providerId: undefined }, /config\.providerId is required/],
    [{ ...base, kind: undefined }, /config\.kind is required/],
    [{ ...base, transport: undefined }, /config\.transport is required/],
    [{ ...base, availability: 'maybe' }, /config\.availability must be one of/],
    [{ ...base, transport: 'carrier-pigeon' }, /config\.transport must be one of/],
    [{ ...base, kind: 'tool-provider' }, /binds exactly 'model-provider'/],
    [{ ...base, models: 'nope' }, /config\.models must be an array/],
    [{ ...base, models: [{ modelId: 'm1', availability: 'available', vendorX: 1 }] }, /unknown model metadata field/],
    [{ ...base, models: [{ modelId: 'm1', availability: 'retired' }] }, /models\[0\]\.availability/],
    ['not-an-object', /plain object/],
  ]) {
    assert.throws(
      () => createModelProviderAdapter({ config: broken, exchange: () => ({}), now, newId: counter('x') }),
      (error) => error instanceof ModelProviderError && error.code === 'lego.contract_violation' && pattern.test(error.message),
      `expected refusal for ${pattern}`,
    );
  }
  // tool side mirrors it
  assert.throws(
    () => createToolProviderAdapter({ config: { ...TOOL_CONFIG, kind: 'model-provider' }, exchange: () => ({}), now, newId: counter('x') }),
    (error) => error.code === 'lego.contract_violation' && /binds exactly 'tool-provider'/.test(error.message),
  );
  // exchange is mandatory — no baked-in transport exists
  assert.throws(() => createModelProviderAdapter({ config: MODEL_CONFIG, now, newId: counter('x') }),
    (error) => error.code === 'lego.contract_violation' && /exchange must be a function/.test(error.message));
  // injection is mandatory — no ambient clock/id anywhere
  assert.throws(() => createModelProviderAdapter({ config: MODEL_CONFIG, exchange: () => ({}) }),
    (error) => error.code === 'lego.contract_violation' && /must be injected/.test(error.message));
  assert.throws(() => createExternalRuntime({ runtimeId: 'r1', kind: 'agent-runtime', transport: 'remote', locality: 'remote', supports: SUPPORTS, exchange: () => ({}) }),
    (error) => error.code === 'lego.contract_violation' && /must be injected/.test(error.message));
});

test('unknown provider shapes fail closed — unknown kind, unknown support keys, wrong provider contract at the seam', () => {
  assert.throws(
    () => createExternalRuntime({
      runtimeId: 'r-x', kind: 'application-provider', transport: 'remote', locality: 'remote',
      supports: SUPPORTS, now, newId: counter('x'), exchange: () => ({}),
    }),
    (error) => error instanceof ExternalRuntimeError && error.code === 'lego.contract_violation' && /kind must be one of/.test(error.message),
  );
  assert.throws(
    () => createExternalRuntime({
      runtimeId: 'r-x', kind: 'agent-runtime', transport: 'remote', locality: 'remote',
      supports: { ...SUPPORTS, telepathy: true }, now, newId: counter('x'), exchange: () => ({}),
    }),
    (error) => error.code === 'lego.contract_violation' && /unknown support key/.test(error.message),
  );
  assert.throws(
    () => createExternalRuntime({
      runtimeId: 'r-x', kind: 'agent-runtime', transport: 'remote', locality: 'remote',
      supports: { session: true }, now, newId: counter('x'), exchange: () => ({}),
    }),
    (error) => error.code === 'lego.contract_violation' && /must be stated explicitly/.test(error.message),
    'supports.cancellation may be false but never silent',
  );
  // registry refuses any runtime claiming the wrong contract — including ours
  const registry = createRuntimeRegistry({ now, newId: counter('x') });
  assert.throws(() => registry.register({
    runtimeId: 'r-bad', contract: 'ai.model-gateway@1.0.0', executorKinds: ['EXTERNAL'],
    capabilities: ['session'], locality: 'remote', availability: 'available',
  }), /unsupported contract/);
  // unregistered runtime cannot be bound (explicit registration only)
  assert.throws(
    () => createRuntimeAdapter({ registry, runtimeId: 'ghost', now, newId: counter('x') }),
    /refuses to bind/,
  );
});

/* ======================================================== C. MODEL ADAPTER */

test('generate returns the canonical response shape and performs exactly one exchange', async () => {
  const exchange = exchangeOf({ generate: { output: 'hi', usage: { inputTokens: 3, outputTokens: 2 }, providerExtra: 'dropped' } });
  const a = modelAdapter({ exchange });
  const response = await a.generate({
    authorization: AUTH_INVOKE_MODEL, modelId: 'm-chat', input: 'ping', timeoutMs: 1000, requestId: 'req-1',
  });
  assert.deepEqual(Object.keys(response).sort(), ['modelId', 'output', 'provider', 'requestId', 'usage'].sort(),
    'provider extras never leak into the canonical response');
  assert.equal(response.modelId, 'm-chat');
  assert.equal(response.provider, 'prov-main');
  assert.equal(response.output, 'hi');
  assert.deepEqual(response.usage.modelInput, { status: 'reported', value: 3 });
  assert.deepEqual(response.usage.output, { status: 'reported', value: 2 });
  assert.equal(exchange.calls.length, 1);
  assert.equal(exchange.calls[0].op, 'generate');
  assert.equal(exchange.calls[0].timeoutMs, 1000, 'the explicit deadline budget travels to the edge');
  assert.equal(exchange.calls[0].requestId, 'req-1', 'provider-side idempotency identity travels too');
  assert.equal(exchange.calls[0].endpoint, 'provider.example/models');
  assert.ok(!('apiKey' in exchange.calls[0]) && !('authorization' in exchange.calls[0]),
    'no credential field exists on the wire request');
});

test('generate demands explicit shape: timeout, non-empty input, declared model — each fail closed', async () => {
  const a = modelAdapter();
  const invoke = (over = {}) => a.generate({
    authorization: AUTH_INVOKE_MODEL, modelId: 'm-chat', input: 'x', timeoutMs: 100, ...over,
  });
  assert.equal((await caughtAsync(() => invoke({ timeoutMs: undefined }))).code, 'lego.contract_violation');
  assert.equal((await caughtAsync(() => invoke({ timeoutMs: 0 }))).code, 'lego.contract_violation');
  assert.equal((await caughtAsync(() => invoke({ timeoutMs: MODEL_PROVIDER_LIMITS.maxTimeoutMs + 1 }))).code, 'lego.contract_violation');
  assert.equal((await caughtAsync(() => invoke({ input: '' }))).code, 'lego.contract_violation');
  assert.equal((await caughtAsync(() => invoke({ modelId: 'm-unknown' }))).code, 'lego.operation_unsupported',
    'unknown model → unsupported, never auto-selected');
  assert.equal((await caughtAsync(() => invoke({ modelId: 'm-off' }))).code, 'lego.operation_unsupported',
    'declared-but-disabled model refuses');
  assert.equal((await caughtAsync(() => invoke({ requestId: 'x'.repeat(MODEL_PROVIDER_LIMITS.maxRequestIdLength + 1) }))).code, 'lego.contract_violation');
  assert.equal((await caughtAsync(() => invoke({ parameters: { temp: 'not-scalar'.repeat(0), nested: { deep: 1 } } }))).code, 'lego.contract_violation');
});

test('stream finalizes once at the final envelope — chunk usage cannot exist, chunks never double-count', async () => {
  const records = [];
  const exchange = exchangeOf({ stream: { chunks: ['a', 'b', 'c'], usage: { inputTokens: 8, outputTokens: 5 } } });
  const a = modelAdapter({ exchange, recordUsage: (entry) => records.push(entry) });
  const out = await a.stream({
    authorization: AUTH_INVOKE_MODEL, modelId: 'm-chat', input: 'draw', timeoutMs: 500, requestId: 'st-1',
  });
  assert.deepEqual(out.chunks, ['a', 'b', 'c']);
  assert.equal(out.output, 'abc');
  assert.deepEqual(out.usage.modelInput, { status: 'reported', value: 8 });
  assert.deepEqual(out.usage.output, { status: 'reported', value: 5 });
  assert.equal(records.length, 2, 'reported figures only — two kinds, two records under derived identities');
  assert.deepEqual(records.map((r) => r.requestId).sort(), ['st-1-modelInput', 'st-1-output']);
  // Chunk dialect: objects (the shape real providers use to smuggle per-chunk
  // usage) are refused outright — there is no path by which chunk usage could
  // be summed with the final aggregate.
  const bad = modelAdapter({ exchange: exchangeOf({ stream: { chunks: [{ text: 'x', usage: { inputTokens: 999 } }] } }) });
  const error = await caughtAsync(() => bad.stream({
    authorization: AUTH_INVOKE_MODEL, modelId: 'm-chat', input: 'x', timeoutMs: 500,
  }));
  assert.equal(error.code, 'lego.contract_violation');
  assert.match(error.message, /chunks must be strings/);
  // Hard stream bounds — block means bounded (§27).
  const flood = modelAdapter({
    exchange: exchangeOf({ stream: { chunks: Array.from({ length: MODEL_PROVIDER_LIMITS.maxStreamChunks + 1 }, () => 'x') } }),
  });
  const bounded = await caughtAsync(() => flood.stream({
    authorization: AUTH_INVOKE_MODEL, modelId: 'm-chat', input: 'x', timeoutMs: 500,
  }));
  assert.equal(bounded.code, 'lego.backpressure');
});

test('stream declares streaming:false models as operation_unsupported', async () => {
  const a = modelAdapter();
  const error = await caughtAsync(() => a.stream({
    authorization: AUTH_INVOKE_MODEL, modelId: 'm-nostream', input: 'x', timeoutMs: 500,
  }));
  assert.equal(error.code, 'lego.operation_unsupported');
  assert.equal(error.details.reason, 'streaming-unsupported');
});

test('embed maps the batch and keeps an honest usage shape (no invented output figure)', async () => {
  const records = [];
  const a = modelAdapter({ recordUsage: (entry) => records.push(entry) });
  const out = await a.embed({
    authorization: AUTH_INVOKE_MODEL, modelId: 'm-chat', input: ['one', 'two'], timeoutMs: 500, requestId: 'em-1',
  });
  assert.deepEqual(out.embeddings, [[0.1, 0.2], [0.3, 0.4]]);
  assert.deepEqual(out.usage.modelInput, { status: 'reported', value: 9 });
  assert.deepEqual(out.usage.output, { status: 'unavailable', value: null },
    'embeddings have no output tokens — the shape stays, the figure stays null');
  assert.equal(records.length, 1, 'only the reported figure is recorded; nothing is invented');
  assert.equal(records[0].kind, 'modelInput');
  // batch bound + length mismatch
  const tooMany = Array.from({ length: MODEL_PROVIDER_LIMITS.maxEmbedBatch + 1 }, (_, i) => `t${i}`);
  const err1 = await caughtAsync(() => a.embed({ authorization: AUTH_INVOKE_MODEL, modelId: 'm-chat', input: tooMany, timeoutMs: 500 }));
  assert.equal(err1.code, 'lego.contract_violation');
  const mismatch = modelAdapter({ exchange: exchangeOf({ embed: { embeddings: [[0.1]] } }) });
  const err2 = await caughtAsync(() => mismatch.embed({ authorization: AUTH_INVOKE_MODEL, modelId: 'm-chat', input: ['a', 'b'], timeoutMs: 500 }));
  assert.equal(err2.code, 'lego.contract_violation');
  assert.match(err2.message, /length must equal/);
  const noEmbed = modelAdapter({ exchange: exchangeOf({ embed: { embeddings: [[0.1], [0.2]] } }) });
  const err3 = await caughtAsync(() => noEmbed.embed({ authorization: AUTH_INVOKE_MODEL, modelId: 'm-chat', input: ['only-one'], timeoutMs: 500 }));
  assert.equal(err3.code, 'lego.contract_violation', 'batch length mismatch still refuses');
});

test('countTokens is an idempotent read — it counts, and it never becomes a usage record', async () => {
  const records = [];
  const a = modelAdapter({ recordUsage: (entry) => records.push(entry) });
  const out = await a.countTokens({ authorization: AUTH_READ_MODEL, modelId: 'm-chat', text: 'one two' });
  assert.equal(out.count, 4);
  assert.equal(records.length, 0, 'a measurement request is not consumption — nothing recorded');
  const bad = modelAdapter({ exchange: exchangeOf({ countTokens: { count: -1 } }) });
  const error = await caughtAsync(() => bad.countTokens({ authorization: AUTH_READ_MODEL, text: 'x' }));
  assert.equal(error.code, 'lego.contract_violation');
});

test('models.list intersects provider confirmation with the declaration — ghosts and extras never appear', async () => {
  const a = modelAdapter();
  const listed = await a.modelsList({ authorization: AUTH_READ_MODEL });
  assert.deepEqual(listed.models.map((m) => m.modelId), ['m-chat', 'm-off'],
    'ghost (undeclared) dropped; declared∩confirmed only');
  const malformed = modelAdapter({ exchange: exchangeOf({ 'models.list': { models: ['nope'] } }) });
  const error = await caughtAsync(() => malformed.modelsList({ authorization: AUTH_READ_MODEL }));
  assert.equal(error.code, 'lego.contract_violation');
});

test('model.describe answers only for declared models, with canonical projection only', async () => {
  const a = modelAdapter();
  const out = await a.describe({ authorization: AUTH_READ_MODEL, modelId: 'm-chat' });
  assert.deepEqual(out.model, { modelId: 'm-chat', provider: 'prov-main', availability: 'available', streaming: true, embedding: true });
  assert.equal((await caughtAsync(() => a.describe({ authorization: AUTH_READ_MODEL, modelId: 'ghost' }))).code, 'lego.operation_unsupported');
  const wrong = modelAdapter({ exchange: exchangeOf({ 'model.describe': { modelId: 'other' } }) });
  const error = await caughtAsync(() => wrong.describe({ authorization: AUTH_READ_MODEL, modelId: 'm-chat' }));
  assert.equal(error.code, 'lego.contract_violation');
});

/* ====================================================== D. TOOL ADAPTER */

test('tools.list / tool.describe bind the declaration to provider confirmation', async () => {
  const t = toolAdapter();
  const listed = await t.toolsList({ authorization: AUTH_READ_TOOL });
  assert.deepEqual(listed.tools.map((tool) => tool.toolId), ['search', 'ship'],
    'phantom (undeclared) and disabled-but-declared… wait: declared ∩ confirmed');
  assert.equal(listed.tools[0].sideEffects, 'read-only');
  assert.equal(listed.tools[0].provider, 'prov-tools', 'provider field is adapter-filled, canonical shape');
  const described = await t.toolDescribe({ authorization: AUTH_READ_TOOL, toolId: 'search' });
  assert.equal(described.tool.toolId, 'search');
  assert.equal((await caughtAsync(() => t.toolDescribe({ authorization: AUTH_READ_TOOL, toolId: 'phantom' }))).code, 'lego.operation_unsupported');
  const retired = await caughtAsync(() => t.toolDescribe({ authorization: AUTH_READ_TOOL, toolId: 'retired' }));
  assert.equal(retired.code, 'lego.operation_unsupported');
  assert.equal(retired.details.reason, 'tool-disabled');
});

test('tool.call: one exchange, explicit approval presence, canonical outcome', async () => {
  const exchange = exchangeOf({ 'tool.call': { outcome: 'succeeded', result: { ok: true }, resultReference: 'res/9' } });
  const t = toolAdapter({ exchange });
  const out = await t.toolCall({
    authorization: AUTH_INVOKE_TOOL, toolId: 'search', input: { q: 'lego' }, timeoutMs: 250, requestId: 'tc-1',
  });
  assert.equal(out.outcome, 'succeeded');
  assert.deepEqual(out.result, { ok: true });
  assert.equal(out.replayed, false);
  assert.equal(exchange.calls.length, 1);
  assert.equal(exchange.calls[0].sideEffects, 'read-only', 'the declaration travels with the call');
  // requiresApproval enforcement — presence here, ai.approval decides the grant
  const err = await caughtAsync(() => t.toolCall({
    authorization: AUTH_INVOKE_TOOL, toolId: 'ship', input: {}, timeoutMs: 250, requestId: 'tc-2',
  }));
  assert.equal(err.code, 'lego.access_denied');
  assert.equal(err.details.reason, 'approval-reference-required');
  const ok = await t.toolCall({
    authorization: AUTH_INVOKE_TOOL, toolId: 'ship', input: {}, timeoutMs: 250, requestId: 'tc-3', approvalReference: 'apr/77',
  });
  assert.equal(ok.outcome, 'succeeded');
  const refused = await caughtAsync(() => t.toolCall({
    authorization: AUTH_INVOKE_TOOL, toolId: 'ship', input: {}, timeoutMs: 250, requestId: 'tc-4', approvalReference: '../../etc/passwd',
  }));
  assert.equal(refused.code, 'lego.contract_violation');
  assert.equal(refused.details.reason, 'not-an-opaque-reference');
});

test('tool.call retry/idempotency: replay returns the recorded outcome without a second exchange; payload reuse refused', async () => {
  const exchange = exchangeOf({ 'tool.call': { outcome: 'succeeded', result: { n: 1 }, resultReference: 'res/r' } });
  const t = toolAdapter({ exchange });
  const first = await t.toolCall({
    authorization: AUTH_INVOKE_TOOL, toolId: 'search', input: { q: 'same' }, timeoutMs: 100, requestId: 'idem-1',
  });
  assert.equal(first.replayed, false);
  assert.equal(exchange.calls.length, 1);
  const replayed = await t.toolCall({
    authorization: AUTH_INVOKE_TOOL, toolId: 'search', input: { q: 'same' }, timeoutMs: 100, requestId: 'idem-1',
  });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.outcome, 'succeeded');
  assert.equal(replayed.resultReference, 'res/r');
  assert.equal(replayed.result, null, 'the result body is never stored for replay — references only (section 23)');
  assert.equal(exchange.calls.length, 1, 'a replay never reaches the provider — no duplicate side effect');
  const reuse = await caughtAsync(() => t.toolCall({
    authorization: AUTH_INVOKE_TOOL, toolId: 'search', input: { q: 'DIFFERENT' }, timeoutMs: 100, requestId: 'idem-1',
  }));
  assert.equal(reuse.code, 'lego.contract_violation');
  assert.equal(reuse.details.reason, 'request-id-reuse');
  const noId = await caughtAsync(() => t.toolCall({
    authorization: AUTH_INVOKE_TOOL, toolId: 'search', input: {}, timeoutMs: 100,
  }));
  assert.equal(noId.code, 'lego.contract_violation');
  assert.match(noId.message, /requestId is required/);
  assert.equal(exchange.calls.length, 1, 'the refused call never reached the provider either');
});

test('tool adapter failure modes: provider down, malformed outcome, permission denial — all canonical', async () => {
  const down = toolAdapter({ exchange: () => { throw { kind: 'unavailable' }; } });
  const err1 = await caughtAsync(() => down.toolsList({ authorization: AUTH_READ_TOOL }));
  assert.equal(err1.code, 'lego.unavailable');
  assert.equal(down.status().state, 'unavailable');
  assert.equal(down.status().lastError, 'lego.unavailable');
  const timeout = toolAdapter({ exchange: () => { throw { kind: 'timeout' }; } });
  const err2 = await caughtAsync(() => timeout.toolCall({
    authorization: AUTH_INVOKE_TOOL, toolId: 'search', input: {}, timeoutMs: 5, requestId: 'to-1',
  }));
  assert.equal(err2.code, 'lego.deadline_exceeded');
  const malformed = toolAdapter({ exchange: exchangeOf({ 'tool.call': { outcome: 'vibes' } }) });
  const err3 = await caughtAsync(() => malformed.toolCall({
    authorization: AUTH_INVOKE_TOOL, toolId: 'search', input: {}, timeoutMs: 5, requestId: 'mm-1',
  }));
  assert.equal(err3.code, 'lego.contract_violation');
  const denied = await caughtAsync(() => toolAdapter().toolCall({
    authorization: { permission: 'ai:tool:read', grantReference: 'grant/1' }, toolId: 'search', input: {}, timeoutMs: 5, requestId: 'dd-1',
  }));
  assert.equal(denied.code, 'lego.access_denied');
  assert.equal(denied.details.reason, 'permission-mismatch');
  // a transport failure records NOTHING — the requestId stays reusable for an honest explicit retry
  let attempt = 0;
  const retry = toolAdapter({ exchange: async () => {
    attempt += 1;
    if (attempt === 1) throw { kind: 'unavailable' };
    return { outcome: 'succeeded', result: { ok: 1 }, resultReference: 'res/t' };
  } });
  const fail1 = await caughtAsync(() => retry.toolCall({
    authorization: AUTH_INVOKE_TOOL, toolId: 'search', input: { k: 1 }, timeoutMs: 5, requestId: 'rt-1',
  }));
  assert.equal(fail1.code, 'lego.unavailable');
  const succeed = await retry.toolCall({
    authorization: AUTH_INVOKE_TOOL, toolId: 'search', input: { k: 1 }, timeoutMs: 5, requestId: 'rt-1',
  });
  assert.equal(succeed.replayed, false, 'unrecorded failure -> the explicit retry executes (provider-side dedupe via the same requestId)');
  assert.equal(succeed.outcome, 'succeeded');
});

test('resources and prompts ops: bounded reads with canonical shapes', async () => {
  const t = toolAdapter();
  const resources = await t.resourcesList({ authorization: AUTH_READ_TOOL });
  assert.deepEqual(resources.resources, [{ resourceId: 'doc/1', description: 'readme' }]);
  const body = await t.resourceRead({ authorization: AUTH_READ_TOOL, resourceId: 'doc/1' });
  assert.equal(body.content, 'resource body');
  const prompts = await t.promptsList({ authorization: AUTH_READ_TOOL });
  assert.equal(prompts.prompts[0].promptId, 'summarize');
  const prompt = await t.promptGet({ authorization: AUTH_READ_TOOL, promptId: 'summarize' });
  assert.match(prompt.content, /Summarize/);
  assert.equal((await caughtAsync(() => t.resourceRead({ authorization: AUTH_READ_TOOL }))).code, 'lego.contract_violation');
  const badList = toolAdapter({ exchange: exchangeOf({ 'resources.list': { resources: [null] } }) });
  assert.equal((await caughtAsync(() => badList.resourcesList({ authorization: AUTH_READ_TOOL }))).code, 'lego.contract_violation');
});

test('sideEffects is required and bounded — unknown or missing effects are refused as destructive', () => {
  for (const broken of [
    { toolId: 't1', availability: 'available', inputSchema: {} },
    { toolId: 't1', sideEffects: 'maybe', availability: 'available', inputSchema: {} },
    { toolId: 't1', sideEffects: 'read-only', availability: 'available' },
    { toolId: 't1', sideEffects: 'read-only', availability: 'available', inputSchema: {}, surpriseField: 1 },
  ]) {
    assert.throws(
      () => createToolProviderAdapter({
        config: { ...TOOL_CONFIG, tools: [broken] }, exchange: () => ({}), now, newId: counter('x'),
      }),
      (error) => error instanceof ToolProviderError && error.code === 'lego.contract_violation',
      `must refuse ${JSON.stringify(broken)}`,
    );
  }
});

/* ==================================================== E. RUNTIME ADAPTER */

test('external executor selection: registered, eligible, bound through the unchanged P2.21 seam', () => {
  const { runtime, adapter } = wireRuntime();
  assert.equal(runtime.contract, EXTERNAL_RUNTIME_CONTRACT);
  assert.equal(ADAPTER_RUNTIME_CONTRACT, 'ai.agent-runtime@1.0.0');
  assert.equal(adapter.provider.supports('EXTERNAL'), true);
  assert.equal(adapter.provider.supports('SHELL'), false);
  assert.equal(adapter.eligible({ executorKind: 'EXTERNAL' }).eligible, true);
  const declaration = runtime.declaration('prov-1');
  assert.deepEqual([...declaration.executorKinds], ['EXTERNAL']);
  assert.equal(declaration.contract, 'ai.agent-runtime@1.0.0');
  assert.deepEqual([...declaration.capabilities], ['session', 'cancellation']);
  assert.equal(declaration.locality, 'remote');
  assert.equal(declaration.providerId, 'prov-1');
  // provider id is an identity, never a credential
  assert.throws(() => runtime.declaration('Bearer abcdefghijklmnopqrst'),
    (error) => error.code === 'lego.contract_violation');
});

test('lifecycle translation is the seam table byte-for-byte — no second lifecycle vocabulary', () => {
  const { runtime } = wireRuntime();
  for (const op of Object.keys(RUNTIME_LIFECYCLE_TRANSLATION)) {
    const expected = RUNTIME_LIFECYCLE_TRANSLATION[op];
    if (expected === null) {
      const error = (() => { try { runtime.translate(op); return null; } catch (e) { return e; } })();
      assert.ok(error, `${op} refuses`);
      assert.equal(error.code, 'lego.contract_violation', 'declared-unsupported refuses exactly like the seam');
      continue;
    }
    assert.deepEqual([...runtime.translate(op)], [...expected]);
  }
  const unknown = (() => { try { runtime.translate('teleport'); return null; } catch (e) { return e; } })();
  assert.equal(unknown.code, 'lego.contract_violation');
});

test('external runtime drives real pullStep: running to completed, responses normalized', () => {
  const responses = [
    { outcome: 'succeeded', final: false, resultReference: 'res/a' },
    { outcome: 'succeeded', final: true, resultReference: 'res/b' },
  ];
  const { adapter } = wireRuntime({
    exchange: (request) => {
      if (request.op === 'exchange') return responses.shift();
      if (request.op === 'cancel') return { cancelled: true };
      throw { kind: 'unavailable' };
    },
  });
  const BUDGETS = { maxSteps: 4, maxDurationMs: 600000, maxContinuationBytes: 64, maxReferences: 8 };
  let machine = adapter.manager().create({
    machineId: 'mach-x', taskId: 'task-x', agentId: 'agent-x', executorKind: 'EXTERNAL', budgets: BUDGETS, metadata: {},
  });
  machine = adapter.manager().prepare({ machineId: 'mach-x', expectedVersion: machine.version });
  machine = adapter.manager().start({ machineId: 'mach-x', expectedVersion: machine.version });
  const first = adapter.pullStep({ machineId: 'mach-x', maxAttempts: 1 });
  assert.equal(first.machine.lifecycle, 'running');
  assert.deepEqual(first.runtimeResponse, { outcome: 'succeeded', final: false });
  const second = adapter.pullStep({ machineId: 'mach-x', maxAttempts: 1 });
  assert.equal(second.machine.lifecycle, 'completed');
});

test('runtime deadline, cancellation and failure modes are bounded and idempotent', () => {
  const { runtime, adapter } = wireRuntime({
    exchange: (request) => {
      if (request.op === 'cancel') return { cancelled: true };
      throw { kind: 'timeout' };
    },
  });
  // deadline: timeout kind translates to the canonical code, no message echo
  const error = (() => { try { runtime.nextResponse({ machineId: 'm1' }); return null; } catch (e) { return e; } })();
  assert.equal(error.code, 'lego.deadline_exceeded');
  assert.ok(!/secret|Bearer/.test(error.message + JSON.stringify(error.details)));
  // cancellation idempotency through the seam: first propagates, second reports already
  const first = adapter.signalCancellation({ machineId: 'mach-c' });
  const second = adapter.signalCancellation({ machineId: 'mach-c' });
  assert.equal(first.propagated, true);
  assert.equal(first.already, false);
  assert.equal(second.already, true, 'wasCancelled was already true before the second signal');
  assert.deepEqual(runtime.cancelledMachines(), ['mach-c']);
  assert.equal(runtime.wasCancelled('mach-c'), true);
  // malformed responses fail closed
  const bad = externalOf({ exchange: () => ({ outcome: 'meh', final: true }) });
  const err2 = (() => { try { bad.nextResponse({ machineId: 'm1' }); return null; } catch (e) { return e; } })();
  assert.equal(err2.code, 'lego.contract_violation');
  const bad2 = externalOf({ exchange: () => ({ outcome: 'succeeded' }) });
  const err3 = (() => { try { bad2.nextResponse({ machineId: 'm1' }); return null; } catch (e) { return e; } })();
  assert.equal(err3.code, 'lego.contract_violation');
  assert.match(err3.message, /final must be a boolean/);
  // cancellation:false runtime: the SEAM refuses first (missing-capability) —
  // it never reaches noteCancellation, so no executor cancel can ever be issued.
  const noCancel = wireRuntime({ supports: { ...SUPPORTS, cancellation: false } });
  const signal = noCancel.adapter.signalCancellation({ machineId: 'mach-nc' });
  assert.equal(signal.propagated, false, 'the seam answers propagated:false for an undeclared capability');
  assert.equal(signal.reason, 'missing-capability');
  assert.equal(noCancel.runtime.wasCancelled('mach-nc'), false, 'noteCancellation is never reached — no bookkeeping lie');
  assert.deepEqual(noCancel.runtime.cancelledMachines(), [],
    'no executor cancel was ever issued for a runtime that declared no cancellation');
  // and the runtime itself refuses to propagate if asked directly
  const direct = noCancel.runtime.noteCancellation('mach-nc');
  assert.equal(direct.propagated, false);
  assert.equal(direct.reason, 'missing-capability');
  assert.deepEqual(noCancel.runtime.cancelledMachines(), []);
});

test('runtime exchange budget is bounded — the edge never becomes an unbounded queue', () => {
  let n = 0;
  const runtime = externalOf({
    exchange: (request) => {
      if (request.op === 'exchange') { n += 1; return { outcome: 'succeeded', final: false, resultReference: `res/${n}` }; }
      return {};
    },
  });
  for (let i = 0; i < EXTERNAL_RUNTIME_LIMITS.maxExchangeCalls; i += 1) runtime.nextResponse({ machineId: 'm1' });
  const error = (() => { try { runtime.nextResponse({ machineId: 'm1' }); return null; } catch (e) { return e; } })();
  assert.equal(error.code, 'lego.backpressure');
  assert.match(error.message, /bounded at/);
  assert.equal(runtime.stats().exchangeCalls, EXTERNAL_RUNTIME_LIMITS.maxExchangeCalls);
});

/* ========================================================= F. SECURITY */

test('credentials are never stored: config fields and config values are refused at the door', () => {
  for (const field of ['apiKey', 'token', 'credentials', 'authorization', 'headers', 'secret', 'password']) {
    assert.throws(
      () => createModelProviderAdapter({
        config: { ...MODEL_CONFIG, [field]: 'value' }, exchange: () => ({}), now, newId: counter('x'),
      }),
      (error) => error.code === 'lego.contract_violation' && error.details.reason === 'credential-field-refused',
      `config.${field} must be refused`,
    );
    assert.throws(
      () => createToolProviderAdapter({
        config: { ...TOOL_CONFIG, [field]: 'value' }, exchange: () => ({}), now, newId: counter('x'),
      }),
      (error) => error.code === 'lego.contract_violation' && error.details.reason === 'credential-field-refused',
      `tool config.${field} must be refused`,
    );
  }
  // full-form detector on values (P2.23 lesson: real shapes, never bare prefixes)
  const secretValues = [
    'sk-abcdefghijklmnopqrstuvwx',
    `ghp_${'A'.repeat(36)}`,
    `github_pat_${'B'.repeat(20)}${'C'.repeat(8)}`,
    'Bearer abcdefghijklmnopqrstuv',
    '-----BEGIN RSA PRIVATE KEY-----',
  ];
  for (const value of secretValues) {
    assert.throws(
      () => createModelProviderAdapter({
        config: { ...MODEL_CONFIG, rogueField: value },
        exchange: () => ({}), now, newId: counter('x'),
      }),
      (error) => error.code === 'lego.contract_violation',
      `secret-shaped config value must be refused: ${value.slice(0, 12)}...`,
    );
  }
  // closed shape: even a non-secret unknown field is refused (no invented config)
  assert.throws(
    () => createModelProviderAdapter({
      config: { ...MODEL_CONFIG, description: 'harmless' }, exchange: () => ({}), now, newId: counter('x'),
    }),
    (error) => error.code === 'lego.contract_violation' && /unknown configuration field/.test(error.message),
  );
});

test('provider errors never echo secrets or raw bodies — canonical code + bounded metadata only', async () => {
  const leak = 'Bearer zzzzzzzzzzzzzzzzzzzzzzzz and prompt/completion: secret answer 42';
  const a = modelAdapter({ exchange: () => { throw Object.assign(new Error(leak), { kind: 'unavailable' }); } });
  const error = await caughtAsync(() => a.modelsList({ authorization: AUTH_READ_MODEL }));
  assert.equal(error.code, 'lego.unavailable');
  const flattened = error.message + JSON.stringify(error.details);
  assert.ok(!flattened.includes('zzzzz'), 'the provider message never travels');
  assert.ok(!flattened.includes('secret answer'), 'bodies never travel');
  assert.ok(!flattened.includes('Bearer'), 'authorization shapes never travel');
  assert.deepEqual(Object.keys(error.details).sort(), ['operation', 'providerId'].sort());
  // secret-shaped error detail values are redacted defensively as well
  const direct = (() => {
    try { throw new ModelProviderError('lego.unavailable', 'x', { note: `Bearer ${'q'.repeat(30)}` }); }
    catch (e) { return e; }
  })();
  assert.equal(direct.details.note, '[redacted]');
  // no module logs to the console — observability stays boundary-level
  for (const src of [MODEL_SRC, TOOL_SRC, EXTERNAL_SRC]) {
    assert.ok(!/console\.(log|error|warn|info|debug)/.test(src), 'no credential-capable logging exists in the adapters');
    assert.ok(!/child_process|node:http|node:https|node:fs|node:crypto/.test(src),
      'no ambient I/O or crypto dependency at the adapter layer');
  }
});

test('call-time authorization names the published permission exactly — configuration never grants', async () => {
  const a = modelAdapter();
  const cases = [
    [undefined, /authorization handoff is required/],
    ['string-handoff', /authorization handoff is required/],
    [{ permission: 'ai:model:Administrator' }, /must name the published permission/],
    [{ permission: 'invoke' }, /must name the published permission/],
    [{ permission: 'ai:model:read', unexpected: 1 }, /handoff shape is closed/],
  ];
  for (const [handoff, pattern] of cases) {
    const error = await caughtAsync(() => a.generate({
      authorization: handoff, modelId: 'm-chat', input: 'x', timeoutMs: 1,
    }));
    assert.ok(error.code === 'lego.access_denied' || error.code === 'lego.contract_violation',
      `handoff ${JSON.stringify(handoff)} refused`);
    assert.match(error.message, pattern);
  }
  const noGrant = await caughtAsync(() => a.generate({
    authorization: { permission: 'ai:model:invoke' }, modelId: 'm-chat', input: 'x', timeoutMs: 1,
  }));
  assert.equal(noGrant.code, 'lego.access_denied');
  assert.equal(noGrant.details.reason, 'grant-reference-missing');
  // XA-8: no permission word beyond the published pairs appears in the adapter sources
  for (const src of [MODEL_SRC, TOOL_SRC]) {
    for (const match of src.matchAll(/'(ai:[a-z0-9:-]+)'/g)) {
      const word = match[1];
      assert.ok(
        MODEL_GATEWAY_PERMISSIONS.includes(word) || TOOL_GATEWAY_PERMISSIONS.includes(word),
        `unexpected permission word '${word}' — adapters may only quote published vocabulary`,
      );
    }
  }
});

test('disabled and degraded providers: declared state wins, disabled refuses every operation', async () => {
  const disabled = modelAdapter({ config: { ...MODEL_CONFIG, availability: 'disabled' } });
  assert.equal(disabled.status().state, 'disabled');
  for (const call of [
    () => disabled.modelsList({ authorization: AUTH_READ_MODEL }),
    () => disabled.generate({ authorization: AUTH_INVOKE_MODEL, modelId: 'm-chat', input: 'x', timeoutMs: 1 }),
    () => disabled.countTokens({ authorization: AUTH_READ_MODEL, text: 'x' }),
  ]) {
    const error = await caughtAsync(call);
    assert.equal(error.code, 'lego.dependency_disabled');
  }
  const degraded = modelAdapter({ config: { ...MODEL_CONFIG, availability: 'degraded' } });
  assert.equal(degraded.status().state, 'degraded');
  await degraded.modelsList({ authorization: AUTH_READ_MODEL });
  assert.equal(degraded.status().state, 'degraded', 'a degraded provider stays degraded even when calls succeed');
  const flaky = modelAdapter({ exchange: () => { throw { kind: 'rate-limited' }; } });
  await caughtAsync(() => flaky.modelsList({ authorization: AUTH_READ_MODEL }));
  assert.equal(flaky.status().state, 'unavailable');
  assert.equal(flaky.status().lastError, 'lego.backpressure');
});

/* =================================================== G. HONEST USAGE (P2.24) */

test('missing usage is unavailable (null), never 0 — and never recorded as a number', async () => {
  const records = [];
  const a = modelAdapter({
    exchange: exchangeOf({ generate: { output: 'quiet' } }),
    recordUsage: (entry) => records.push(entry),
  });
  const out = await a.generate({
    authorization: AUTH_INVOKE_MODEL, modelId: 'm-chat', input: 'x', timeoutMs: 1, requestId: 'u-1',
  });
  assert.deepEqual(out.usage.modelInput, { status: 'unavailable', value: null });
  assert.deepEqual(out.usage.output, { status: 'unavailable', value: null });
  assert.equal(records.length, 0, 'unavailable figures are never written into ai.token-usage');
  const partial = modelAdapter({
    exchange: exchangeOf({ generate: { output: 'x', usage: { inputTokens: 6 } } }),
  });
  const half = await partial.generate({
    authorization: AUTH_INVOKE_MODEL, modelId: 'm-chat', input: 'x', timeoutMs: 1,
  });
  assert.deepEqual(half.usage.modelInput, { status: 'reported', value: 6 });
  assert.deepEqual(half.usage.output, { status: 'unavailable', value: null });
  const malformed = modelAdapter({ exchange: exchangeOf({ generate: { output: 'x', usage: { inputTokens: '5' } } }) });
  const error = await caughtAsync(() => malformed.generate({
    authorization: AUTH_INVOKE_MODEL, modelId: 'm-chat', input: 'x', timeoutMs: 1,
  }));
  assert.equal(error.code, 'lego.contract_violation');
  assert.match(error.message, /usage\.inputTokens/);
  const zeros = modelAdapter({
    exchange: exchangeOf({ generate: { output: 'x', usage: { inputTokens: 0, outputTokens: 0 } } }),
  });
  const z = await zeros.generate({ authorization: AUTH_INVOKE_MODEL, modelId: 'm-chat', input: 'x', timeoutMs: 1 });
  assert.deepEqual(z.usage.modelInput, { status: 'reported', value: 0 }, 'an explicit reported 0 is a known figure');
});

test('usage reports into the canonical foundation with reported certainty intact and no double-count on retry', async () => {
  const usage = createTokenUsageFoundation({ now, newId: counter('usg') });
  const a = modelAdapter({
    exchange: exchangeOf({ generate: { output: 'y', usage: { inputTokens: 21, outputTokens: 2 } } }),
    recordUsage: (entry) => usage.record(entry),
  });
  await a.generate({
    authorization: AUTH_INVOKE_MODEL, modelId: 'm-chat', input: 'x', timeoutMs: 1, requestId: 'dup-1',
  });
  // honest retry: same requestId -> same derived record identities -> foundation replays, store unchanged
  await a.generate({
    authorization: AUTH_INVOKE_MODEL, modelId: 'm-chat', input: 'x', timeoutMs: 1, requestId: 'dup-1',
  });
  const all = usage.query();
  assert.equal(all.length, 2, 'a retried call never double-counts');
  for (const record of all) {
    assert.equal(record.status, 'reported', 'the adapter only ever records reported figures');
    assert.equal(record.estimator, null, 'no estimator is invented — none exists canonically');
    assert.equal(record.source, 'prov-main');
    assert.equal(record.scopeLevel, 'call');
    assert.equal(record.unit, 'tokens');
  }
  const budget = usage.budget({ scopeLevel: 'call', scopeRef: 'dup-1', kind: 'modelInput', limit: 1000 });
  assert.equal(budget.certainty, 'reported');
  assert.deepEqual([...USAGE_STATUSES], ['reported', 'estimated', 'unavailable']);
});

test('the adapter never estimates: no canonical estimator is selected anywhere in the module', () => {
  assert.ok(!/estimator\s*:\s*'(?!null)/.test(MODEL_SRC), 'no estimator string is ever minted');
  assert.ok(!/status\s*:\s*'estimated'/.test(MODEL_SRC), "the adapter never claims 'estimated'");
  assert.ok(/status: 'reported'/.test(MODEL_SRC), 'reported is the only positive claim it can make');
  assert.ok(/status: 'unavailable'/.test(MODEL_SRC), 'unavailable remains the honest null path');
});

/* ============================================ H. NO-PROVIDER FOUNDATION */

test('AI Foundation with provider = none: load, validate, list, resolve, describe — zero adapters involved', () => {
  assert.ok(AI_FOUNDATION.modelGateway.operations.length > 0);
  assert.ok(AI_FOUNDATION.toolGateway.operations.length > 0);
  assert.ok(AI_FOUNDATION.zeroInstall.rule.includes('not an error'));
  assert.deepEqual(describeProviderConfiguration(null), Object.freeze({
    configuration: 'not-configured',
    state: 'not-configured',
    providerId: null,
    lastError: null,
    reportedAs: 'capability-unavailable',
    reason: 'no inference provider configured',
    valid: true,
  }));
  assert.equal(AI_FOUNDATION.zeroInstall.reportedAs, "capability-unavailable with reason 'no inference provider configured'");
  // no fake paths exist: the adapters cannot even be constructed without explicit config
  for (const factory of [createModelProviderAdapter, createToolProviderAdapter]) {
    assert.throws(() => factory({ exchange: () => ({}), now, newId: counter('x') }),
      (error) => error.code === 'lego.contract_violation');
  }
  // provider kinds remain the published five (no sixth collapsed 'ai.provider' contract)
  assert.deepEqual([...PROVIDER_KINDS],
    ['model-provider', 'tool-provider', 'application-provider', 'agent-runtime', 'simulation-runtime']);
  assert.deepEqual([...AI_TRANSPORTS], ['in-process', 'worker', 'remote', 'mcp']);
  assert.equal(AI_FOUNDATION_JSON.vendorRule.includes('examples'), true);
});
