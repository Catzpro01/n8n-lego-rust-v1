import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTelemetryContext, TELEMETRY_SIGNALS } from '../src/lego/telemetry-envelope.mjs';
import {
  SEMANTIC_EVENT_CONTRACT, EVENT_SCHEMA_VERSION, EVENT_LIMITS, EVENT_ATTRIBUTE_FIELDS,
  EVENT_VOCABULARY, EVENT_DOMAINS, EVENT_ORDER_POLICIES, EVENT_ORDER_DECISIONS,
  classifyEventVersion, createSemanticEvent, serializeSemanticEvent,
  deserializeSemanticEvent, createEventOrderGate,
} from '../src/lego/semantic-events.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/p9/semantic-events.json', import.meta.url), 'utf8'));
const context = createTelemetryContext(fixture.context);
const baseSpec = { timestamp: 1720000000000, eventName: 'execution.started', component: 'execution', operation: 'execute', outcome: 'started' };
const create = (changes = {}) => createSemanticEvent({ ...baseSpec, ...changes }, context);

test('P9.5 published vocabulary table, owner and exact schema versions match the fixture', () => {
  assert.equal(SEMANTIC_EVENT_CONTRACT.id, 'observability.semantic-event');
  assert.equal(SEMANTIC_EVENT_CONTRACT.version, '1.0.0');
  assert.equal(SEMANTIC_EVENT_CONTRACT.owner, 'agent-6');
  assert.equal(EVENT_SCHEMA_VERSION, '1.0.0');
  assert.deepEqual([...EVENT_VOCABULARY], fixture.vocabulary);
  assert.ok(EVENT_VOCABULARY.length >= 20);
  assert.deepEqual([...EVENT_DOMAINS], ['execution', 'checkpoint', 'trigger', 'ingress', 'node', 'registry', 'runtime']);
  for (const entry of EVENT_VOCABULARY) {
    assert.equal(entry.schemaVersion, '1.0.0');
    assert.ok(Object.isFrozen(entry));
  }
  assert.ok(Object.isFrozen(EVENT_VOCABULARY));
});

test('P9.5 classifyEventVersion fails closed on unknown names and unsupported versions', () => {
  assert.equal(classifyEventVersion('execution.started', '1.0.0'), 'supported');
  assert.equal(classifyEventVersion('execution.started', '1.1.0'), 'unsupported_version');
  assert.equal(classifyEventVersion('execution.started', '0.9.0'), 'unsupported_version');
  assert.equal(classifyEventVersion('execution.started', 1), 'unsupported_version');
  assert.equal(classifyEventVersion('execution.exploded', '1.0.0'), 'unknown_event');
  assert.equal(classifyEventVersion('', '1.0.0'), 'unknown_event');
  assert.equal(classifyEventVersion(null, '1.0.0'), 'unknown_event');
  assert.equal(classifyEventVersion('x'.repeat(EVENT_LIMITS.eventNameBytes + 1), '1.0.0'), 'unknown_event');
  assert.equal(create({ eventName: 'execution.exploded' }), null);
  assert.equal(create({ schemaVersion: '9.9.9' }), null);
  assert.equal(create({ schemaVersion: 1 }), null);
});

test('P9.5 lifecycle fixture covers required P3/P4/P6 boundary transitions with shared correlation', () => {
  const seen = new Set();
  for (const step of [...fixture.lifecycle, ...fixture.failureLifecycle]) {
    const event = createSemanticEvent({ ...step.spec, eventName: step.eventName }, context);
    assert.ok(event, `step ${step.step} ${step.eventName}`);
    assert.equal(event.eventName, step.eventName);
    assert.equal(event.envelope.signalType, 'EVENT');
    assert.equal(event.envelope.context, context);
    assert.equal(event.envelope.context.executionId, 'exec-1');
    seen.add(event.eventName);
  }
  // Every published vocabulary name must appear in the lifecycle fixtures.
  for (const entry of EVENT_VOCABULARY) assert.ok(seen.has(entry.name), entry.name);
  assert.ok(TELEMETRY_SIGNALS.includes('EVENT'));
});

test('P9.5 canonical fixture round-trips byte-identically with deterministic attribute order', () => {
  const event = create(fixture.canonical.spec);
  assert.ok(event);
  assert.equal(event.redactionCount, 0);
  const wire = serializeSemanticEvent(event);
  assert.equal(typeof wire, 'string');
  const decoded = deserializeSemanticEvent(wire);
  assert.ok(decoded);
  assert.equal(serializeSemanticEvent(decoded), wire);
  assert.deepEqual(decoded, event);
  assert.equal(decoded.redactionCount, 0);
  // Key order of attributes never changes wire identity (allowlist order).
  const reordered = createSemanticEvent({
    ...fixture.canonical.spec,
    attributes: { cacheHit: false, itemCount: 3, durationMs: 10 },
  }, context);
  assert.equal(serializeSemanticEvent(reordered), wire);
  assert.deepEqual(reordered.attributes, event.attributes);
  // Rebuild from parsed-but-forged object rejects (brand required).
  assert.equal(serializeSemanticEvent(JSON.parse(JSON.stringify(event))), null);
  assert.equal(serializeSemanticEvent(null), null);
});

test('P9.5 version compatibility fixture: unknown contract/event/schema versions all reject safely', () => {
  for (const item of fixture.versionCompatibility) {
    assert.equal(deserializeSemanticEvent(item.wire), null, item.case);
    assert.equal(item.expect, 'rejected');
  }
  // Missing/extra wire fields and non-canonical encodings reject.
  const wire = serializeSemanticEvent(create());
  assert.equal(deserializeSemanticEvent(wire.replace('"eventName"', '"eventNameX"')), null);
  assert.equal(deserializeSemanticEvent(wire.slice(0, -1) + ',"redactionCount":0}'), null);
  assert.equal(deserializeSemanticEvent(wire + ' '), null);
  assert.equal(deserializeSemanticEvent(''), null);
  assert.equal(deserializeSemanticEvent(null), null);
  assert.equal(deserializeSemanticEvent('x'.repeat(EVENT_LIMITS.wireBytes + 1)), null);
  assert.equal(deserializeSemanticEvent('\n' + wire), null);
});

test('P9.5 size bound: max-occupancy event stays under wireBytes; oversize rejects', () => {
  const max = 'x'.repeat(128);
  const full = create({
    timestamp: Number.MAX_SAFE_INTEGER, severity: 'FATAL', environment: max, operation: max,
    outcome: max, errorCode: max, errorClass: max, artifactRef: max, diagnosticRef: max,
    sequence: Number.MAX_SAFE_INTEGER,
    attributes: { durationMs: Number.MAX_SAFE_INTEGER, byteCount: Number.MAX_SAFE_INTEGER, itemCount: Number.MAX_SAFE_INTEGER, attempt: Number.MAX_SAFE_INTEGER, statusCode: 599, cacheHit: true },
  });
  assert.ok(full);
  const wire = serializeSemanticEvent(full);
  assert.ok(wire);
  assert.ok(Buffer.byteLength(wire) <= EVENT_LIMITS.wireBytes);
  assert.ok(deserializeSemanticEvent(wire));
  // Sequence/value ceilings are structural.
  assert.equal(create({ sequence: -1 }), null);
  assert.equal(create({ sequence: 1.5 }), null);
  assert.equal(create({ sequence: Number.MAX_SAFE_INTEGER + 1 }), null);
});

test('P9.5 bounded attributes redact unknown names without reading values; oversize bag rejects', () => {
  const event = create({ attributes: { durationMs: 5, password: 'never', injected: 1 } });
  assert.ok(event);
  assert.equal(event.attributes.password, undefined);
  assert.equal(event.attributes.injected, undefined);
  assert.equal(event.attributes.durationMs, 5);
  assert.equal(event.redactionCount, 2);
  assert.deepEqual([...EVENT_ATTRIBUTE_FIELDS], ['durationMs', 'attempt', 'itemCount', 'byteCount', 'statusCode', 'cacheHit']);
  const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['unknown' + i, i]));
  assert.equal(create({ attributes: nine }), null);
  // Known-name wrong types reject the whole event (fail closed, no partial bag).
  assert.equal(create({ attributes: { durationMs: 'secret' } }), null);
  assert.equal(create({ attributes: { cacheHit: 'secret' } }), null);
  assert.equal(create({ attributes: { statusCode: 99 } }), null);
  assert.equal(create({ attributes: { byteCount: -1 } }), null);
  assert.equal(create({ attributes: new Proxy({}, { ownKeys() { throw Error('secret'); } }) }), null);
  assert.equal(create({ attributes: Object.defineProperty({}, 'durationMs', { get() { throw Error('secret'); }, enumerable: true }) }), null);
});

test('P9.5 no payload/message/unknown top-level fields can enter an event', () => {
  for (const key of ['password', 'credentials', 'payload', 'body', 'message', 'stack', 'headers', 'secret', '__proto__', 'invented']) {
    assert.equal(create({ [key]: 'SENSITIVE' }), null, key);
  }
  // Envelope identity fields remain mandatory through the P9.1 record rules.
  assert.equal(createSemanticEvent({ ...baseSpec, component: undefined }, context), null);
  assert.equal(createSemanticEvent(baseSpec, {}), null);
  assert.equal(createSemanticEvent(null, context), null);
  assert.equal(createSemanticEvent('execution.started', context), null);
});

test('P9.5 creation invokes no serialization, clock or I/O; source stays offline', () => {
  const stringify = JSON.stringify, now = Date.now;
  try {
    JSON.stringify = () => { throw Error('encoding on producer'); };
    Date.now = () => { throw Error('clock on producer'); };
    assert.ok(create());
  } finally { JSON.stringify = stringify; Date.now = now; }
  const source = readFileSync(new URL('../src/lego/semantic-events.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|setTimeout|setInterval|writeFile|readFile|console\.(?:log|error))\s*\(/);
});

test('P9.5 monotonic order gate: duplicate and out-of-order are explicit distinct decisions', () => {
  const gate = createEventOrderGate({ maxKeys: 4, policy: 'monotonic' });
  assert.ok(gate);
  assert.equal(gate.policy, 'monotonic');
  for (const item of fixture.orderPolicy.monotonic) {
    assert.equal(gate.observe('exec-1', item.sequence), item.expect, String(item.sequence));
  }
  const stats = gate.stats();
  assert.equal(stats.accepted, 3);
  assert.equal(stats.duplicate, 1);
  assert.equal(stats.out_of_order, 1);
  assert.equal(stats.maxKeys, 4);
  // Invalid key/sequence rejected without mutating state.
  assert.equal(gate.observe('', 9), 'rejected');
  assert.equal(gate.observe('exec-1', -1), 'rejected');
  assert.equal(gate.observe('x'.repeat(EVENT_LIMITS.orderKeyBytes + 1), 9), 'rejected');
  // Capacity: new keys beyond budget answer capacity, existing keys still work.
  assert.equal(gate.observe('a', 0), 'accepted');
  assert.equal(gate.observe('b', 0), 'accepted');
  assert.equal(gate.observe('c', 0), 'accepted');
  assert.equal(gate.observe('d', 0), 'capacity');
  assert.equal(gate.observe('exec-1', 6), 'accepted');
  assert.equal(gate.stats().capacity, 1);
  assert.equal(gate.stats().keys, 4);
});

test('P9.5 unordered policy admits any sequence; invalid gates/configs fail closed', () => {
  const gate = createEventOrderGate({ maxKeys: 2, policy: 'unordered' });
  assert.ok(gate);
  for (const item of fixture.orderPolicy.unordered) {
    assert.equal(gate.observe('k', item.sequence), item.expect);
  }
  assert.equal(createEventOrderGate({ maxKeys: 0 }), null);
  assert.equal(createEventOrderGate({ maxKeys: EVENT_LIMITS.orderKeys + 1 }), null);
  assert.equal(createEventOrderGate({ maxKeys: 1.5 }), null);
  assert.equal(createEventOrderGate({ maxKeys: 1, policy: 'strict' }), null);
  assert.equal(createEventOrderGate(null), null);
  assert.equal(createEventOrderGate({ maxKeys: 1, extra: true }), null);
  // Default policy is monotonic.
  assert.equal(createEventOrderGate({ maxKeys: 1 }).policy, 'monotonic');
  assert.deepEqual([...EVENT_ORDER_POLICIES], ['monotonic', 'unordered']);
  assert.deepEqual([...EVENT_ORDER_DECISIONS], ['accepted', 'duplicate', 'out_of_order', 'capacity', 'rejected']);
});

test('P9.5 events are frozen, share context by reference, and admit every published name', () => {
  for (const entry of EVENT_VOCABULARY) {
    const event = createSemanticEvent({
      timestamp: 1720000000000, eventName: entry.name, component: entry.domain === 'execution' ? 'execution' : entry.domain,
      operation: 'observe', outcome: 'accepted',
    }, context);
    assert.ok(event, entry.name);
    assert.ok(Object.isFrozen(event));
    assert.equal(event.envelope.context, context);
    assert.equal(event.schemaVersion, '1.0.0');
    assert.equal(event.contractVersion, '1.0.0');
    assert.ok(Object.isFrozen(event.attributes));
    const wire = serializeSemanticEvent(event);
    assert.ok(wire, entry.name);
    assert.ok(deserializeSemanticEvent(wire), entry.name);
  }
});

test('P9.5 schema document and locked row describe the admitted representation', () => {
  const schema = JSON.parse(readFileSync(new URL('../../../docs/architecture/p9/semantic-event.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.properties.contractVersion.const, SEMANTIC_EVENT_CONTRACT.version);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.eventName.enum.length, EVENT_VOCABULARY.length);
  assert.deepEqual(schema.properties.eventName.enum, EVENT_VOCABULARY.map(entry => entry.name));
  assert.equal(schema.properties.schemaVersion.const, EVENT_SCHEMA_VERSION);
  assert.equal(schema.properties.attributes.additionalProperties, false);
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
  const rows = lock.contracts.filter(row => row.id === SEMANTIC_EVENT_CONTRACT.id);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.owner, 'agent-6');
  assert.equal(row.domain, 'observability');
  assert.equal(row.version, '1.0.0');
  assert.deepEqual(row.surface, ['src/lego/semantic-events.mjs']);
  assert.deepEqual(row.exports['src/lego/semantic-events.mjs'], [
    'SEMANTIC_EVENT_CONTRACT', 'EVENT_SCHEMA_VERSION', 'EVENT_LIMITS', 'EVENT_ATTRIBUTE_FIELDS',
    'EVENT_VOCABULARY', 'EVENT_DOMAINS', 'EVENT_ORDER_POLICIES', 'EVENT_ORDER_DECISIONS',
    'classifyEventVersion', 'createSemanticEvent', 'serializeSemanticEvent',
    'deserializeSemanticEvent', 'createEventOrderGate',
  ]);
  assert.deepEqual(row.tests, ['apps/n8n-lego/test/lego-semantic-events.test.mjs']);
  assert.equal(lock.contracts.length, 100); // P9.7 adds observability.telemetry-redaction@1.0.0; P9.6 adds observability.telemetry-buffer@1.0.0; P9.8 adds observability.telemetry-sampling@1.0.0; P9.9 adds observability.resource-pressure@1.0.0; P9.10 adds observability.health-readiness@1.0.0; P9.11 adds observability.execution-diagnostics@1.0.0; P9.12 adds observability.diagnostic-bundle@1.0.0; P9.13 adds observability.failure-correlation@1.0.0; P9.14 adds observability.replay-evidence@1.0.0; P9.15 adds observability.telemetry-retention@1.0.0; P9.16 adds observability.operator-inspection@1.0.0; P9.17 adds observability.low-resource-mode@1.0.0; P9.18 adds observability.self-observability@1.0.0; P9.19 adds observability.tenant-isolation@1.0.0; P9.20 adds observability.contract-oracle@1.0.0; P9.21 adds observability.advanced-diagnostics@1.0.0; P9.22 adds observability.p9-acceptance@1.0.0; count-pins say 75 // P9.13 adds observability.failure-correlation@1.0.0; P9.13 adds observability.failure-correlation@1.0.0; P9.14 adds observability.replay-evidence@1.0.0; P9.15 adds observability.telemetry-retention@1.0.0; P9.16 adds observability.operator-inspection@1.0.0; P9.17 adds observability.low-resource-mode@1.0.0; P9.18 adds observability.self-observability@1.0.0; P9.19 adds observability.tenant-isolation@1.0.0; P9.20 adds observability.contract-oracle@1.0.0; P9.21 adds observability.advanced-diagnostics@1.0.0; P9.22 adds observability.p9-acceptance@1.0.0; count-pins say 75 // P9.5 adds observability.semantic-event=58 // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.1 adds the ninety-fifth (auth.principal). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
});
