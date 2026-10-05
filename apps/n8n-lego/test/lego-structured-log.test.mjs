import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ERROR_CODES, ERROR_CONTRACT_VERSION } from '../src/lego/errors.mjs';
import { createTelemetryContext, TELEMETRY_SEVERITIES } from '../src/lego/telemetry-envelope.mjs';
import {
  STRUCTURED_LOG_CONTRACT, LOG_LIMITS, LOG_ERROR_CLASSES, LOG_ERROR_TAXONOMY,
  classifyLogError, createStructuredLog, serializeStructuredLog,
} from '../src/lego/structured-log.mjs';
const context = createTelemetryContext({ workflowId: 'wf-1', executionId: 'exec-1', correlationId: 'request-1' });
const spec = { timestamp: 1720000000000, severity: 'INFO', component: 'execution', operation: 'execute', outcome: 'completed', diagnosticRef: 'diag-1' };
const create = (changes = {}) => createStructuredLog({ ...spec, ...changes }, context);

test('P9.2 structured fixture carries mandatory semantic identity and shared context', () => {
  const log = create({ attributes: { itemCount: 3, durationMs: 10 } });
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/p9/structured-log.json', import.meta.url)));
  assert.deepEqual(log, fixture);
  assert.equal(log.envelope.context, context);
  assert.equal(log.envelope.signalType, 'LOG');
  assert.ok(Object.isFrozen(log)); assert.ok(Object.isFrozen(log.attributes));
  assert.equal(STRUCTURED_LOG_CONTRACT.version, '1.0.0');
  assert.equal(STRUCTURED_LOG_CONTRACT.owner, 'agent-6');
  assert.equal(serializeStructuredLog(log), JSON.stringify(fixture));
});

test('P9.2 severity vocabulary is exactly the P9.1/#101 vocabulary', () => {
  assert.deepEqual([...TELEMETRY_SEVERITIES], ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']);
  for (const severity of TELEMETRY_SEVERITIES) assert.equal(create({ severity }).envelope.severity, severity);
  for (const severity of ['info', 'NOTICE', null, {}, 3, undefined]) assert.equal(create({ severity }), null);
});

test('P9.2 versioned taxonomy covers the existing error registry without new codes or retry semantics', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/p9/error-taxonomy.json', import.meta.url)));
  assert.deepEqual(LOG_ERROR_TAXONOMY, fixture);
  assert.equal(LOG_ERROR_TAXONOMY.sourceContractVersion, ERROR_CONTRACT_VERSION);
  assert.equal(LOG_ERROR_TAXONOMY.entries.length, ERROR_CODES.length);
  for (const entry of ERROR_CODES) {
    const classified = classifyLogError(entry.code);
    assert.ok(LOG_ERROR_CLASSES.includes(classified.errorClass));
    assert.equal(classified.retryable, entry.retryable ?? null);
    const log = create({ severity: 'ERROR', outcome: 'failed', errorCode: entry.code });
    assert.equal(log.envelope.errorCode, entry.code);
    assert.equal(log.envelope.errorClass, classified.errorClass);
  }
  assert.equal(classifyLogError('execution.timeout').errorClass, 'TIMEOUT');
  assert.equal(classifyLogError('storage.unavailable').errorClass, 'UNAVAILABLE');
  assert.equal(classifyLogError('auth.forbidden').errorClass, 'AUTHORIZATION');
  assert.equal(classifyLogError('unknown.error'), null);
});

test('P9.2 malformed errors fail soft; supplied classes/exception objects never override taxonomy', () => {
  for (const errorCode of ['unknown', '', null, 5, {}, new Error('secret')]) assert.equal(create({ errorCode }), null);
  assert.equal(create({ errorClass: 'INVENTED' }), null);
  assert.equal(create({ error: new Error('private') }), null);
  assert.equal(create({ stack: 'private' }), null);
});

test('P9.2 all free text is redacted before any record or codec can retain it', () => {
  const secret = 'arbitrary-credential-fixture';
  const log = create({ severity: 'ERROR', outcome: 'failed', errorCode: 'execution.failed', message: secret });
  assert.equal(log.redactionCount, 1);
  assert.equal(Object.hasOwn(log, 'message'), false);
  assert.equal(Object.hasOwn(log.envelope, 'message'), false);
  assert.ok(!serializeStructuredLog(log).includes(secret));
  assert.ok(!JSON.stringify(log).includes(secret));
  assert.equal(create({ message: 'x'.repeat(LOG_LIMITS.messageInputChars + 1) }), null);
  assert.equal(create({ message: { password: secret } }), null);
});

test('P9.2 numeric/boolean attributes only; secret and unknown attributes are discarded without access', () => {
  let accesses = 0;
  const attributes = { durationMs: 12, attempt: 2, itemCount: 10, byteCount: 100, statusCode: 500, cacheHit: false, authorization: 'SENSITIVE_FIXTURE' };
  Object.defineProperty(attributes, 'password', { enumerable: true, get() { accesses++; throw Error('secret'); } });
  const log = create({ attributes });
  assert.ok(log);
  assert.equal(log.redactionCount, 2);
  assert.equal(accesses, 0);
  assert.deepEqual(Object.keys(log.attributes), ['durationMs', 'attempt', 'itemCount', 'byteCount', 'statusCode', 'cacheHit']);
  assert.doesNotMatch(serializeStructuredLog(log), /password|authorization|SENSITIVE_FIXTURE/);
  assert.equal(create({ attributes: { durationMs: 'secret' } }), null);
  assert.equal(create({ attributes: { cacheHit: 'secret' } }), null);
  assert.equal(create({ attributes: { durationMs: new Uint8Array(100) } }), null);
  assert.equal(create({ payload: new Uint8Array(100) }), null);
});

test('P9.2 bounded attributes and malformed values reject without payload copying', () => {
  assert.equal(create({ attributes: Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['unknown'+i, i])) }), null);
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(create({ attributes: { byteCount: value } }), null);
  for (const statusCode of [99, 600]) assert.equal(create({ attributes: { statusCode } }), null);
  for (const attributes of [null, [], new Date(), { [Symbol('hidden')]: 'secret' }]) assert.equal(create({ attributes }), null);
  assert.equal(create({ attributes: Object.defineProperty({}, 'durationMs', { get() { throw Error('secret'); }, enumerable:true }) }), null);
  assert.equal(create({ attributes: new Proxy({}, { ownKeys() { throw Error('secret'); } }) }), null);
});

test('P9.2 message cannot replace operation/component/outcome/severity/timestamp identity', () => {
  for (const key of ['operation', 'component', 'outcome', 'severity', 'timestamp']) {
    const input = { ...spec, message: 'something happened' }; delete input[key];
    assert.equal(createStructuredLog(input, context), null, key);
  }
  assert.equal(createStructuredLog(spec, {}), null);
  for (const key of ['password', 'authorization', 'credentials', 'body']) assert.equal(create({ [key]: 'secret' }), null);
});

test('P9.2 canonical serialization is bounded and only accepts admitted logs', () => {
  const full = create({ component:'x'.repeat(128), operation:'x'.repeat(128), outcome:'x'.repeat(128), artifactRef:'x'.repeat(128), diagnosticRef:'x'.repeat(128), attributes:{ durationMs:Number.MAX_SAFE_INTEGER, byteCount:Number.MAX_SAFE_INTEGER } });
  assert.ok(Buffer.byteLength(serializeStructuredLog(full)) < LOG_LIMITS.wireBytes);
  assert.equal(serializeStructuredLog(JSON.parse(JSON.stringify(full))), null);
  assert.equal(serializeStructuredLog(null), null);
  assert.equal(serializeStructuredLog(create({ attributes:{ durationMs:12,itemCount:3 } })), serializeStructuredLog(create({ attributes:{ itemCount:3,durationMs:12 } })));
});

test('P9.2 creation invokes no serialization, clock, I/O or sink callback', () => {
  const stringify = JSON.stringify, now = Date.now;
  try {
    JSON.stringify = () => { throw Error('encoding on producer'); };
    Date.now = () => { throw Error('clock on producer'); };
    assert.ok(create());
  } finally { JSON.stringify = stringify; Date.now = now; }
  const source = readFileSync(new URL('../src/lego/structured-log.mjs', import.meta.url),'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|setTimeout|setInterval|writeFile|console\.(?:log|error))\s*\(/);
});

test('P9.2 published schema and locked row describe the admitted representation', () => {
  const schema = JSON.parse(readFileSync(new URL('../../../docs/architecture/p9/structured-log.schema.json', import.meta.url)));
  assert.equal(schema.properties.contractVersion.const, STRUCTURED_LOG_CONTRACT.version);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.envelope.allOf[1].required, ['severity', 'operation', 'outcome']);
  assert.equal(schema.properties.attributes.additionalProperties, false);
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter(row => row.id === STRUCTURED_LOG_CONTRACT.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, STRUCTURED_LOG_CONTRACT.version);
  assert.equal(rows[0].owner, 'agent-6');
  assert.equal(classifyLogError('x'.repeat(100000)), null);
});
