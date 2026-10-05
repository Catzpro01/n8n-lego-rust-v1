import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEnvelope, deriveEnvelope } from '../src/lego/envelope.mjs';
import {
  TELEMETRY_CONTRACT, TELEMETRY_LIMITS, TELEMETRY_CONTEXT_FIELDS,
  TELEMETRY_SIGNALS, TELEMETRY_SEVERITIES, createTelemetryContext,
  deriveTelemetryContext, telemetryContextFromEnvelope, createTelemetryRecord,
  serializeTelemetryRecord, deserializeTelemetryRecord,
} from '../src/lego/telemetry-envelope.mjs';

const spec = { timestamp: 1720000000000, signalType: 'EVENT', component: 'execution' };
const wire = readFileSync(new URL('./fixtures/p9/envelope.json', import.meta.url), 'utf8').trim();
const raw = JSON.parse(wire);
const context = createTelemetryContext(raw.context);
function record(changes = {}) { return createTelemetryRecord({ ...spec, ...changes }, context); }

test('P9.1 publishes owner-preserving versioned deterministic round-trip fixture', () => {
  assert.equal(TELEMETRY_CONTRACT.version, '1.0.0');
  assert.equal(TELEMETRY_CONTRACT.owner, 'agent-6');
  const decoded = deserializeTelemetryRecord(wire);
  assert.deepEqual(decoded, raw);
  assert.equal(serializeTelemetryRecord(decoded), wire);
  assert.equal(serializeTelemetryRecord(structuredClone(decoded)), null);
  const { contractVersion, context: ctx, ...fields } = raw;
  const reversed = Object.fromEntries(Object.entries(fields).reverse());
  assert.equal(serializeTelemetryRecord(createTelemetryRecord(reversed, createTelemetryContext(ctx))), wire);
});

test('P9.1 local correlation reuses immutable context, never execution payload', () => {
  const first = record();
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(context));
  assert.equal(first.context, context);
  assert.equal(record().context, context);
  assert.throws(() => { first.context.executionId = 'other'; }, TypeError);
  const child = deriveTelemetryContext(context, { nodeId: 'node-2', spanId: 'span-2', parentSpanId: 'span-1' });
  assert.equal(child.correlationId, context.correlationId);
  assert.equal(child.executionId, context.executionId);
  assert.equal(child.parentSpanId, context.spanId);
  assert.equal(context.nodeId, 'node-1');
  assert.equal(deriveTelemetryContext({}, {}), null);
  assert.equal(createTelemetryRecord(spec, raw.context), null);
});

test('P9.1 existing foundation parent-child correlation projects without actor/scope/secrets', () => {
  const parent = createEnvelope({ legoId: 'execution', operation: 'execute', requestId: 'req-1', traceId: 'trace-1', actor: { password: 'never-copy' }, scope: { tenantId: 'not-authorized' } });
  const child = deriveEnvelope(parent, { legoId: 'node-registry', operation: 'inspect', requestId: 'req-2' });
  const a = telemetryContextFromEnvelope(parent);
  const b = telemetryContextFromEnvelope(child);
  assert.equal(b.correlationId, a.correlationId);
  assert.equal(b.traceId, a.traceId);
  assert.equal(b.causationId, a.requestId);
  assert.equal(b.requestId, 'req-2');
  assert.equal(b.tenantId, undefined);
  assert.equal(Object.hasOwn(b, 'actor'), false);
});

test('P9.1 structural exclusion: raw secrets, payload, free text and unknown fields rejected', () => {
  for (const key of ['password', 'credentials', 'authorization', 'apiKey', 'secret', 'payload', 'body', 'attributes', 'message', 'stack', '__proto__', 'invented']) {
    const input = Object.assign(Object.create(null), { [key]: 'SENSITIVE_FIXTURE' });
    assert.equal(createTelemetryContext(input), null, key);
    assert.equal(record(input), null, key);
    assert.equal(deriveTelemetryContext(context, input), null, key);
    assert.equal(deserializeTelemetryRecord(JSON.stringify({ ...raw, [key]: 'SENSITIVE_FIXTURE' })), null, key);
  }
});

test('P9.1 defense in depth rejects recognizable tokens and URL/header values in every string slot', () => {
  const secrets = ['gh' + 'p_' + 'x'.repeat(36), 'github_' + 'pat_' + 'x'.repeat(30), 'sk-live-fake', 'Bearer fake', 'https://user:pass@host', 'password:fixture', 'authorization:fixture', 'eyJtest.test.test', 'AKIA' + 'A'.repeat(16)];
  for (const secret of secrets) {
    for (const field of TELEMETRY_CONTEXT_FIELDS.filter(f => f !== 'registryEpoch')) assert.equal(createTelemetryContext({ [field]: secret }, { authorizedTenantId: secret }), null, field);
    for (const field of ['component', 'environment', 'operation', 'outcome', 'errorCode', 'errorClass', 'artifactRef', 'diagnosticRef']) assert.equal(record({ [field]: secret }), null, field);
  }
});

test('P9.1 field and total byte ceilings are structural, including maximum occupancy', () => {
  const max = 'x'.repeat(TELEMETRY_LIMITS.identifierBytes);
  const fields = Object.fromEntries(TELEMETRY_CONTEXT_FIELDS.map(k => [k, k === 'registryEpoch' ? Number.MAX_SAFE_INTEGER : max]));
  const ctx = createTelemetryContext(fields, { authorizedTenantId: max });
  assert.ok(ctx);
  const all = { ...spec, timestamp: Number.MAX_SAFE_INTEGER, severity: 'FATAL' };
  for (const k of ['component', 'environment', 'operation', 'outcome', 'errorCode', 'errorClass', 'artifactRef', 'diagnosticRef']) all[k] = max;
  const full = createTelemetryRecord(all, ctx);
  const encoded = serializeTelemetryRecord(full);
  assert.ok(encoded);
  assert.ok(Buffer.byteLength(encoded) <= TELEMETRY_LIMITS.wireBytes);
  assert.deepEqual(deserializeTelemetryRecord(encoded, { authorizedTenantId: max }), full);
  assert.equal(createTelemetryContext({ workflowId: max + 'x' }), null);
  assert.equal(record({ component: max + 'x' }), null);
  assert.equal(deserializeTelemetryRecord('x'.repeat(TELEMETRY_LIMITS.wireBytes + 1)), null);
  assert.equal(createTelemetryContext({ nodeId: 'é' }), null);
});

test('P9.1 tenant context is denied by default and exact-scope on creation, derivation and decoding', () => {
  const policy = { authorizedTenantId: 'tenant-a' };
  assert.equal(createTelemetryContext({ tenantId: 'tenant-a' }), null);
  assert.equal(createTelemetryContext({ tenantId: 'tenant-b' }, policy), null);
  const ctx = createTelemetryContext({ tenantId: 'tenant-a' }, policy);
  assert.ok(ctx);
  assert.equal(deriveTelemetryContext(ctx, {}), null);
  assert.equal(deriveTelemetryContext(ctx, { tenantId: 'tenant-b' }, policy), null);
  assert.equal(deriveTelemetryContext(ctx, {}, policy).tenantId, 'tenant-a');
  const encoded = serializeTelemetryRecord(createTelemetryRecord(spec, ctx));
  assert.equal(deserializeTelemetryRecord(encoded), null);
  assert.equal(deserializeTelemetryRecord(encoded, { authorizedTenantId: 'tenant-b' }), null);
  assert.equal(deserializeTelemetryRecord(encoded, policy).context.tenantId, 'tenant-a');
});

test('P9.1 malformed, missing and incompatible versions fail closed without throwing or echoing data', () => {
  for (const version of [undefined, null, 1, '', '0.9.0', '1.0.1', '2.0.0']) assert.equal(deserializeTelemetryRecord(JSON.stringify({ ...raw, contractVersion: version })), null);
  for (const input of ['', '{', 'null', '[]', '{}', '\n' + wire, wire.replace('"1.0.0"', '"1.0.0","contractVersion":"1.0.0"')]) assert.equal(deserializeTelemetryRecord(input), null);
  for (const value of [-1, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1, '12', null]) {
    assert.equal(record({ timestamp: value }), null);
    assert.equal(createTelemetryContext({ registryEpoch: value }), null);
  }
  for (const key of ['timestamp', 'signalType', 'component', 'context']) {
    const missing = { ...raw }; delete missing[key];
    assert.equal(deserializeTelemetryRecord(JSON.stringify(missing)), null);
  }
  for (const input of [null, 1, [], new Date(), Object.create({ component: 'execution' })]) assert.equal(createTelemetryRecord(input, context), null);
  for (const value of [{}, [], null, true, () => {}, Symbol('x')]) assert.equal(createTelemetryContext({ nodeId: value }), null);
  assert.equal(record({ severity: 'VERBOSE' }), null);
  assert.equal(record({ signalType: 'unknown' }), null);
  for (const signalType of TELEMETRY_SIGNALS) assert.ok(record({ signalType }));
  for (const severity of TELEMETRY_SEVERITIES) assert.ok(record({ severity }));
});

test('P9.1 hostile getters, symbols, proxies and serialization hooks do not execute', () => {
  let calls = 0;
  const bad = Object.defineProperty({}, 'workflowId', { enumerable: true, get() { calls++; throw Error('secret'); } });
  assert.equal(createTelemetryContext(bad), null);
  assert.equal(createTelemetryContext({ [Symbol('hidden')]: 'secret' }), null);
  assert.equal(record({ toJSON() { calls++; return 'secret'; } }), null);
  const envelope = Object.defineProperty({}, 'requestId', { get() { calls++; throw Error('secret'); } });
  assert.equal(telemetryContextFromEnvelope(envelope), null);
  assert.equal(calls, 0);
  assert.equal(createTelemetryContext(new Proxy({}, { getPrototypeOf() { throw Error('secret'); } })), null);
  assert.equal(createTelemetryContext(Object.defineProperty({}, 'workflowId', { value: 'hidden' })), null);
});

test('P9.1 producer performs no serialization, clock read, payload access or sink callback', () => {
  const stringify = JSON.stringify, now = Date.now;
  try {
    JSON.stringify = () => { throw Error('hot-path serialization'); };
    Date.now = () => { throw Error('hot-path clock'); };
    assert.ok(record());
    const evilPayload = new Proxy({}, { get() { throw Error('payload read'); } });
    assert.equal(record({ payload: evilPayload }), null);
  } finally { JSON.stringify = stringify; Date.now = now; }
  const source = readFileSync(new URL('../src/lego/telemetry-envelope.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import\s/m);
  assert.doesNotMatch(source, /\b(?:fetch|setTimeout|setInterval|writeFile|readFile)\s*\(/);
});

test('P9.1 publishes exactly one new contract row without transferring domain ownership', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  assert.equal(lock.contracts.length, 100); // count-pins say 76 // count-pins say 75 // count-pins say 74 // count-pins say 73 // count-pins say 72 // count-pins say 71 // count-pins say 70 // count-pins say 69 // count-pins say 68 // count-pins say 67 // count-pins say 66 // count-pins say 65 // count-pins say 64 // count-pins say 63 // count-pins say 62 // count-pins say 61 // count-pins say 60 // count-pins say 59 // count-pins say 58 // count-pins say 57 // count-pins say 56 // count-pins say 54 // count-pins say 53 // count-pins say 52 // count-pins say 51 // count-pins say 49 // count-pins say 48 // count-pins say 47 // count-pins say 46 // count-pins say 45 // count-pins say 44 // P9.1=40 + P3 Slice K execution.optimizer=41 + P6.1 node.registry=43 // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.1 adds the ninety-fifth (auth.principal). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  const rows = lock.contracts.filter(c => c.id === TELEMETRY_CONTRACT.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, TELEMETRY_CONTRACT.version);
  assert.equal(rows[0].owner, 'agent-6');
  const manifest = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)));
  assert.equal(manifest.domains.find(d => d.id === 'observability').owner, 'agent-6');
});

test('P9.1 published structural schema agrees with complete fixture and runtime vocabulary', () => {
  const schema = JSON.parse(readFileSync(new URL('../../../docs/architecture/p9/telemetry-envelope.schema.json', import.meta.url)));
  assert.equal(schema.properties.contractVersion.const, TELEMETRY_CONTRACT.version);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.context.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties.context.properties), [...TELEMETRY_CONTEXT_FIELDS]);
  assert.deepEqual(schema.properties.signalType.enum, [...TELEMETRY_SIGNALS]);
  assert.deepEqual(schema.properties.severity.enum, [...TELEMETRY_SEVERITIES]);
  assert.equal(schema.$defs.identifier.maxLength, TELEMETRY_LIMITS.identifierBytes);
  for (const key of schema.required) assert.ok(Object.hasOwn(raw, key));
  for (const key of Object.keys(raw)) assert.ok(Object.hasOwn(schema.properties, key));
});
