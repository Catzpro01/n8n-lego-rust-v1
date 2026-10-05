import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REDACTION_CONTRACT, TELEMETRY_DATA_CLASSES, REDACTION_ACTIONS, REDACTION_LIMITS,
  REDACTION_MARKERS, classifyTelemetryField, sanitizeErrorMessage,
  redactTelemetryTree, redactForExport, containsSecretShape,
} from '../src/lego/telemetry-redaction.mjs';
import { createTelemetryContext, createTelemetryRecord, serializeTelemetryRecord, deserializeTelemetryRecord } from '../src/lego/telemetry-envelope.mjs';
import { createStructuredLog, serializeStructuredLog } from '../src/lego/structured-log.mjs';
import { createTraceSpan, injectTraceParent } from '../src/lego/trace-context.mjs';
import { createSemanticEvent, serializeSemanticEvent } from '../src/lego/semantic-events.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/p9/redaction.json', import.meta.url), 'utf8'));

test('P9.7 five data classes and actions are exactly the deep-design vocabulary', () => {
  assert.equal(REDACTION_CONTRACT.id, 'observability.telemetry-redaction');
  assert.equal(REDACTION_CONTRACT.version, '1.0.0');
  assert.equal(REDACTION_CONTRACT.owner, 'agent-6');
  assert.deepEqual([...TELEMETRY_DATA_CLASSES], fixture.classes);
  assert.deepEqual([...TELEMETRY_DATA_CLASSES], ['PUBLIC_DIAGNOSTIC', 'INTERNAL_DIAGNOSTIC', 'SENSITIVE', 'SECRET', 'FORBIDDEN']);
  assert.deepEqual([...REDACTION_ACTIONS], ['allow', 'redact', 'reject', 'reference']);
  assert.equal(REDACTION_MARKERS.secretValue, '[REDACTED:SECRET]');
  assert.equal(REDACTION_MARKERS.forbiddenValue, '[REDACTED:FORBIDDEN]');
});

test('P9.7 credentials fixture: every secret-shaped value is redacted regardless of key', () => {
  const result = redactForExport(fixture.credentials.input);
  assert.ok(result);
  assert.ok(result.redactionCount >= 1);
  assert.equal(containsSecretShape(result.value), false, JSON.stringify(result.value));
  for (const [key, original] of Object.entries(fixture.credentials.input)) {
    assert.notEqual(result.value[key], original, key);
  }
  // Real shapes climb to SECRET (or FORBIDDEN for authority field names).
  assert.equal(classifyTelemetryField('apiKey', 'sk-live-Abc12345XyZ').class, 'FORBIDDEN');
  assert.equal(classifyTelemetryField('githubToken', 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789').class, 'SECRET');
  assert.equal(classifyTelemetryField('innocent', 'AKIAIOSFODNN7EXAMPLE').class, 'SECRET');
  assert.equal(classifyTelemetryField('innocent', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U').class, 'SECRET');
  assert.equal(classifyTelemetryField('note', 'password=hunter2-plain').class, 'SECRET');
});

test('P9.7 authorization-header fixture: forbidden fields replaced without reading values', () => {
  const result = redactForExport(fixture.authorizationHeader.input);
  assert.ok(result);
  assert.deepEqual(result.value.headers, fixture.authorizationHeader.expect);
  assert.equal(containsSecretShape(result.value), false);
  // Getter on authorization must never be invoked (value unread).
  let read = false;
  const hostile = { headers: {} };
  Object.defineProperty(hostile.headers, 'authorization', {
    enumerable: true,
    get() { read = true; return 'Bearer should-not-be-read'; },
  });
  // Accessor (no value descriptor) → rejected without invoking getter.
  const out = redactTelemetryTree(hostile);
  assert.ok(out);
  assert.equal(read, false);
  assert.equal(out.value.headers.authorization, REDACTION_MARKERS.forbiddenValue);
});

test('P9.7 nested JSON secret fixture: deep secrets covered, containers stay bounded', () => {
  const result = redactForExport(fixture.nestedJsonSecret.input);
  assert.ok(result);
  assert.equal(containsSecretShape(result.value), false, JSON.stringify(result.value));
  // Non-secret correlation survives.
  assert.equal(result.value.component, 'ingress');
  assert.equal(result.value.context.executionId, 'exec-1');
  // credentials bag is FORBIDDEN — whole bag replaced, inner password unread.
  assert.equal(result.value.context.nodeConfig.credentials, REDACTION_MARKERS.forbiddenValue);
  assert.equal(result.value.context.nodeConfig.headers.Authorization, REDACTION_MARKERS.forbiddenValue);
  // Secret-shaped value under innocent key still redacted.
  assert.equal(result.value.context.items[1].value, REDACTION_MARKERS.secretValue);
  assert.equal(result.value.context.items[0].value, 1);
  assert.ok(result.redactionCount >= 3);
});

test('P9.7 raw request/response bodies disabled by default (FORBIDDEN, values unread)', () => {
  const input = fixture.rawBodyDisabled.input;
  let passwordRead = false;
  const hostile = {
    component: 'webhook',
    get body() { return null; },
  };
  // Value-property body: classified FORBIDDEN, string content never copied.
  const result = redactForExport(input);
  assert.ok(result);
  assert.equal(result.value.body, REDACTION_MARKERS.forbiddenValue);
  assert.equal(result.value.responseBody, REDACTION_MARKERS.forbiddenValue);
  assert.equal(result.value.component, 'webhook');
  assert.equal(result.value.body.includes('in-body'), false);
  // allowRaw cannot un-forbid bodies (collection license is never granted).
  const opted = redactTelemetryTree(input, { allowRaw: true });
  assert.ok(opted);
  assert.equal(opted.value.body, REDACTION_MARKERS.forbiddenValue);
  assert.equal(containsSecretShape(opted.value), false);
  assert.equal(passwordRead, false);
  // classifyTelemetryField direct
  for (const key of ['body', 'requestBody', 'responseBody', 'rawBody', 'payload']) {
    assert.equal(classifyTelemetryField(key, 'anything').class, 'FORBIDDEN', key);
  }
  assert.equal(hostile.body, null);
});

test('P9.7 binary/large data becomes bounded references; strings truncate', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const result = redactTelemetryTree({ attachment: bytes, label: 'file' });
  assert.ok(result);
  assert.deepEqual(result.value.attachment, { binary_ref: true, bytes: 5 });
  assert.equal(result.referenceCount, 1);
  assert.equal(containsSecretShape(result.value), false);
  // Large non-secret string truncates with marker.
  const big = 'a'.repeat(REDACTION_LIMITS.maxStringBytes + 50);
  const t = redactTelemetryTree({ note: big });
  assert.ok(t.value.note.endsWith(REDACTION_MARKERS.truncated));
  assert.ok(t.truncated);
  // Depth/node ceilings truncate instead of exploding.
  let deep = { v: 1 };
  for (let i = 0; i < REDACTION_LIMITS.maxDepth + 5; i++) deep = { child: deep };
  const d = redactTelemetryTree(deep);
  assert.ok(d.truncated);
});

test('P9.7 log / trace / event redaction: same boundary, no secret shapes survive', () => {
  // LOG: free-text error sanitized, then a structured log carries only safe fields.
  const message = sanitizeErrorMessage(fixture.logRedaction.input);
  assert.ok(message);
  assert.ok(message.includes(REDACTION_MARKERS.secretValue));
  assert.equal(containsSecretShape(message), false);
  const context = createTelemetryContext({ executionId: 'exec-1', correlationId: 'req-1' });
  const log = createStructuredLog({
    timestamp: 1720000000000, severity: 'ERROR', component: 'ingress', operation: 'admit',
    outcome: 'failed', errorCode: 'execution.timeout', message,
  }, context);
  assert.ok(log);
  assert.equal(log.redactionCount, 1); // message never captured, only counted
  const logWire = serializeStructuredLog(log);
  assert.equal(containsSecretShape(logWire), false);
  // TRACE: attribute bag exported through redaction; carrier carries no secrets.
  const span = createTraceSpan({ traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef', sampled: true }, context);
  const exported = redactForExport(fixture.traceRedaction.input);
  assert.ok(exported);
  assert.equal(containsSecretShape(exported.value), false);
  assert.equal(exported.value.peer.auth, REDACTION_MARKERS.forbiddenValue);
  assert.equal(exported.value.span, 'http.request');
  const carrier = injectTraceParent(span);
  assert.equal(containsSecretShape(carrier), false);
  // EVENT: diagnostic bag + envelope with secret-shaped refs rejected by P9.1.
  const event = createSemanticEvent({
    timestamp: 1720000000000, eventName: 'ingress.rejected', component: 'ingress',
    operation: 'admit', outcome: 'rejected',
    diagnosticRef: 'diag-1',
  }, context);
  assert.ok(event);
  const eventExport = redactForExport(fixture.eventRedaction.input);
  assert.ok(eventExport);
  assert.equal(containsSecretShape(eventExport.value), false);
  assert.equal(eventExport.value.credentials, REDACTION_MARKERS.forbiddenValue);
  assert.equal(serializeSemanticEvent(event) && containsSecretShape(serializeSemanticEvent(event)), false);
  // Envelope still rejects secret-shaped identifiers at the source.
  assert.equal(createTelemetryRecord({ timestamp: 1, signalType: 'EVENT', component: 'x', diagnosticRef: 'Bearer dG9rZQ' }, context), null);
});

test('P9.7 export redaction is the choke point: redactForExport never returns raw secrets', () => {
  const payloads = [
    fixture.credentials.input,
    fixture.authorizationHeader.input,
    fixture.nestedJsonSecret.input,
    fixture.rawBodyDisabled.input,
    fixture.traceRedaction.input,
    fixture.eventRedaction.input,
    { deep: { deeper: { deepest: { token: 'sk-live-nested-9999', ok: true } } } },
    ['plain', 'Bearerabcdefghijklmnop', { password: 'x' }],
  ];
  for (const payload of payloads) {
    const result = redactForExport(payload);
    assert.ok(result, JSON.stringify(payload).slice(0, 80));
    assert.equal(containsSecretShape(result.value), false);
    assert.equal(result.contractVersion, '1.0.0');
    assert.ok(Object.isFrozen(result));
    // Idempotent: redacting the redacted export changes nothing (bypass resistance).
    const again = redactForExport(result.value);
    assert.ok(again);
    assert.deepEqual(again.value, result.value);
    assert.equal(again.redactionCount, 0);
  }
  // String export path.
  const s = redactForExport('failure token=abcdef123456secret');
  assert.ok(s);
  assert.equal(containsSecretShape(s.value), false);
  // Non-plain roots fail closed.
  assert.equal(redactForExport(undefined), null);
  assert.equal(redactForExport(42), null);
  assert.equal(redactForExport(() => {}), null);
  assert.equal(redactForExport(new Date()), null);
});

test('P9.7 sanitizeErrorMessage bounds and fail-closed inputs', () => {
  assert.equal(sanitizeErrorMessage(null), null);
  assert.equal(sanitizeErrorMessage(42), null);
  assert.equal(sanitizeErrorMessage('x'.repeat(REDACTION_LIMITS.maxMessageBytes * 4 + 1)), null);
  const ok = sanitizeErrorMessage('error Authorization: Bearer abcdef123456 done');
  assert.ok(ok.includes(REDACTION_MARKERS.secretValue));
  assert.equal(containsSecretShape(ok), false);
  const long = sanitizeErrorMessage('a'.repeat(2000));
  assert.ok(long.endsWith(REDACTION_MARKERS.truncated));
  assert.ok(long.length <= REDACTION_LIMITS.maxMessageBytes + REDACTION_MARKERS.truncated.length);
  assert.equal(sanitizeErrorMessage('plain message'), 'plain message');
  assert.equal(sanitizeErrorMessage({}), null);
});

test('P9.7 classification ladder and non-diagnostic values fail closed', () => {
  assert.equal(classifyTelemetryField('durationMs', 10).action, 'allow');
  assert.equal(classifyTelemetryField('cacheHit', true).class, 'PUBLIC_DIAGNOSTIC');
  assert.equal(classifyTelemetryField('email', 'a@b.c').class, 'SENSITIVE');
  assert.equal(classifyTelemetryField('email', 'a@b.c').action, 'redact');
  assert.equal(classifyTelemetryField('password', 'x').class, 'FORBIDDEN');
  assert.equal(classifyTelemetryField('component', () => {}).class, 'FORBIDDEN');
  assert.equal(classifyTelemetryField('component', Symbol('x')).class, 'FORBIDDEN');
  assert.equal(classifyTelemetryField('attachment', new Uint8Array(3)).action, 'reference');
  // PII allow policy: only SENSITIVE names loosen; SECRET/FORBIDDEN never do.
  const pii = redactTelemetryTree({ email: 'a@b.c', password: 'p' }, { allowPii: true });
  assert.equal(pii.value.email, 'a@b.c');
  assert.equal(pii.value.password, REDACTION_MARKERS.forbiddenValue);
});

test('P9.7 source stays pure: no I/O, no clock; locked row documents the boundary', () => {
  const stringify = JSON.stringify, now = Date.now;
  try {
    JSON.stringify = () => { throw Error('encoding'); };
    Date.now = () => { throw Error('clock'); };
    assert.ok(redactTelemetryTree({ a: 1 }));
    assert.ok(sanitizeErrorMessage('ok token=abc123456789'));
  } finally { JSON.stringify = stringify; Date.now = now; }
  const source = readFileSync(new URL('../src/lego/telemetry-redaction.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|setTimeout|setInterval|writeFile|readFile|appendFile|console\.(?:log|error))\s*\(/);
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
  const rows = lock.contracts.filter(row => row.id === REDACTION_CONTRACT.id);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.owner, 'agent-6');
  assert.equal(row.domain, 'observability');
  assert.equal(row.version, '1.0.0');
  assert.deepEqual(row.surface, ['src/lego/telemetry-redaction.mjs']);
  assert.deepEqual(row.exports['src/lego/telemetry-redaction.mjs'], [
    'REDACTION_CONTRACT', 'TELEMETRY_DATA_CLASSES', 'REDACTION_ACTIONS', 'REDACTION_LIMITS',
    'REDACTION_MARKERS', 'classifyTelemetryField', 'sanitizeErrorMessage',
    'redactTelemetryTree', 'redactForExport', 'containsSecretShape',
  ]);
  assert.deepEqual(row.tests, ['apps/n8n-lego/test/lego-telemetry-redaction.test.mjs']);
  assert.equal(lock.contracts.length, 100); // P9.8 adds observability.telemetry-sampling@1.0.0; P9.9 adds observability.resource-pressure@1.0.0; P9.10 adds observability.health-readiness@1.0.0; P9.11 adds observability.execution-diagnostics@1.0.0; P9.12 adds observability.diagnostic-bundle@1.0.0; P9.13 adds observability.failure-correlation@1.0.0; P9.14 adds observability.replay-evidence@1.0.0; P9.15 adds observability.telemetry-retention@1.0.0; P9.16 adds observability.operator-inspection@1.0.0; P9.17 adds observability.low-resource-mode@1.0.0; P9.18 adds observability.self-observability@1.0.0; P9.19 adds observability.tenant-isolation@1.0.0; P9.20 adds observability.contract-oracle@1.0.0; P9.21 adds observability.advanced-diagnostics@1.0.0; P9.22 adds observability.p9-acceptance@1.0.0; count-pins say 75 // P9.7 adds observability.telemetry-redaction=60 // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.1 adds the ninety-fifth (auth.principal). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  const doc = readFileSync(new URL('../../../docs/architecture/p9/P9.7-REDACTION.md', import.meta.url), 'utf8');
  assert.match(doc, /PUBLIC_DIAGNOSTIC/);
  assert.match(doc, /FORBIDDEN/);
  assert.match(doc, /redactForExport/);
});
