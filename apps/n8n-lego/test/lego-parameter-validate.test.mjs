/**
 * P7-S03 — Local Validation & Normalization (Issue #223 §20-21, §27, §29-30; DEC-0024).
 *
 * Unit rules pin the normalization semantics, the compact validation vocabulary,
 * the closed failure vocabulary, the immutable execution snapshot, and the
 * negative/security + determinism properties on small hand-written definitions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { compileParameterPlan } from '../src/lego/parameter-plan.mjs';
import {
  FAILURE_CODES, LOCAL_FAILURE_CODES, SNAPSHOT_FORMAT, SNAPSHOT_FORMAT_VERSION,
  VALIDATION_FORMAT_VERSION, buildExecutionSnapshot, isExpression, normalizeValue,
  reconstructSnapshot, validateParameters, validateValue,
} from '../src/lego/parameter-validate.mjs';

const node = (properties, extra = {}) => ({ name: 'test.node', version: [1], properties, ...extra });
const param = (plan, path) => plan.parameters.find((p) => p.path === path && p.valueSlot);

/* ------------------------------------------------------------------ CP-01 normalization */

test('normalize: scalars pass through unchanged (no observable behavior change)', () => {
  assert.deepEqual(normalizeValue('string', '  hi '), { canonical: '  hi ', changed: false });
  assert.deepEqual(normalizeValue('string', ''), { canonical: '', changed: false });
  assert.deepEqual(normalizeValue('number', 42), { canonical: 42, changed: false });
  assert.deepEqual(normalizeValue('number', -0.5), { canonical: -0.5, changed: false });
  assert.deepEqual(normalizeValue('boolean', true), { canonical: true, changed: false });
  assert.deepEqual(normalizeValue('boolean', false), { canonical: false, changed: false });
  assert.deepEqual(normalizeValue('dateTime', '2026-01-01T00:00:00Z'), { canonical: '2026-01-01T00:00:00Z', changed: false });
  assert.deepEqual(normalizeValue('dateTime', 1700000000000), { canonical: 1700000000000, changed: false });
  assert.deepEqual(normalizeValue('color', '#ff0000'), { canonical: '#ff0000', changed: false });
});

test('normalize: the only two safe canonicalizations (numeric string -> number, true/false -> boolean)', () => {
  assert.deepEqual(normalizeValue('number', '42'), { canonical: 42, changed: true });
  assert.deepEqual(normalizeValue('number', '  3.5  '), { canonical: 3.5, changed: true });
  assert.deepEqual(normalizeValue('number', '-7'), { canonical: -7, changed: true });
  assert.deepEqual(normalizeValue('number', '1e3'), { canonical: 1000, changed: true });
  assert.deepEqual(normalizeValue('boolean', 'true'), { canonical: true, changed: true });
  assert.deepEqual(normalizeValue('boolean', 'false'), { canonical: false, changed: true });
});

test('normalize: non-canonical strings are NOT coerced (no heuristic normalization)', () => {
  assert.deepEqual(normalizeValue('number', '42.5.5'), { canonical: '42.5.5', changed: false });
  assert.deepEqual(normalizeValue('number', '0x10'), { canonical: '0x10', changed: false });
  assert.deepEqual(normalizeValue('number', ''), { canonical: '', changed: false });
  assert.deepEqual(normalizeValue('number', 'abc'), { canonical: 'abc', changed: false });
  assert.deepEqual(normalizeValue('boolean', 'yes'), { canonical: 'yes', changed: false });
  assert.deepEqual(normalizeValue('boolean', '1'), { canonical: '1', changed: false });
  assert.deepEqual(normalizeValue('string', '42'), { canonical: '42', changed: false });
});

test('normalize: null/undefined pass through; unknown types pass through', () => {
  assert.deepEqual(normalizeValue('number', null), { canonical: null, changed: false });
  assert.deepEqual(normalizeValue('string', undefined), { canonical: undefined, changed: false });
  assert.deepEqual(normalizeValue('json', { a: 1 }), { canonical: { a: 1 }, changed: false });
  assert.deepEqual(normalizeValue('collection', { a: 1 }), { canonical: { a: 1 }, changed: false });
});

/* ------------------------------------------------------------------ CP-02 validation vocabulary */

test('validate: type rules per n8n type (structured SCHEMA_INVALID with expected/actual)', () => {
  const plan = compileParameterPlan(node([
    { name: 's', type: 'string' },
    { name: 'n', type: 'number' },
    { name: 'b', type: 'boolean' },
    { name: 'tags', type: 'multiOptions', options: [{ name: 'x', value: 'x' }] },
    { name: 'c', type: 'collection', options: [{ name: 'f', type: 'string' }] },
    { name: 'rl', type: 'resourceLocator' },
  ]));
  const cases = [
    [param(plan, 's'), 42, 'number'],
    [param(plan, 'n'), 'abc', 'string'],
    [param(plan, 'b'), 'maybe', 'string'],
    [param(plan, 'tags'), 'x', 'string'],
    [param(plan, 'tags'), ['x', 1], 'array'],
    [param(plan, 'c'), 'notanobject', 'string'],
    [param(plan, 'rl'), 'notanobject', 'string'],
  ];
  for (const [p, value, actual] of cases) {
    const { issues } = validateValue(p, value);
    assert.equal(issues.length, 1, `${p.path} should produce one issue`);
    assert.equal(issues[0].code, FAILURE_CODES.SCHEMA_INVALID);
    assert.equal(issues[0].rule, 'type');
    assert.equal(issues[0].expected, p.type);
    assert.equal(issues[0].actual, actual);
    assert.equal(issues[0].path, p.path);
  }
});

test('validate: a type error is terminal for the slot (no misleading follow-on rules)', () => {
  const plan = compileParameterPlan(node([
    { name: 'n', type: 'number', typeOptions: { minValue: 1, maxValue: 10, maxLength: 3, regex: '^\\d+$' } },
  ]));
  const { issues } = validateValue(param(plan, 'n'), 'abc');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'type');
});

test('validate: required rule', () => {
  const plan = compileParameterPlan(node([
    { name: 's', type: 'string', required: true },
    { name: 'opt', type: 'string' },
  ]));
  assert.equal(validateValue(param(plan, 's'), undefined).issues.length, 1);
  assert.equal(validateValue(param(plan, 's'), '').issues[0].rule, 'required');
  assert.equal(validateValue(param(plan, 's'), 'x').issues.length, 0);
  assert.equal(validateValue(param(plan, 'opt'), undefined).issues.length, 0);
});

test('validate: min/max on numbers', () => {
  const plan = compileParameterPlan(node([
    { name: 'n', type: 'number', typeOptions: { minValue: 1, maxValue: 10 } },
  ]));
  const p = param(plan, 'n');
  assert.equal(validateValue(p, 5).issues.length, 0);
  assert.equal(validateValue(p, 0).issues[0].rule, 'minValue');
  assert.equal(validateValue(p, 11).issues[0].rule, 'maxValue');
  assert.equal(validateValue(p, '7').issues.length, 0, 'numeric string normalizes then validates');
});

test('validate: length, regex, email on strings', () => {
  const plan = compileParameterPlan(node([
    { name: 's', type: 'string', typeOptions: { maxLength: 5 } },
    { name: 'r', type: 'string', typeOptions: { regex: '^[a-z]+$' } },
    { name: 'e', type: 'string', typeOptions: { email: true } },
  ]));
  assert.equal(validateValue(param(plan, 's'), 'abc').issues.length, 0);
  assert.equal(validateValue(param(plan, 's'), 'abcdef').issues[0].rule, 'maxLength');
  assert.equal(validateValue(param(plan, 'r'), 'abc').issues.length, 0);
  assert.equal(validateValue(param(plan, 'r'), 'ABC').issues[0].rule, 'regex');
  assert.equal(validateValue(param(plan, 'e'), 'a@b.com').issues.length, 0);
  assert.equal(validateValue(param(plan, 'e'), 'not-an-email').issues[0].rule, 'email');
});

test('validate: malformed declared regex is DEPENDENCY_INVALID (not a silent pass)', () => {
  const plan = compileParameterPlan(node([
    { name: 'r', type: 'string', typeOptions: { regex: '([' } },
  ]));
  const { issues } = validateValue(param(plan, 'r'), 'anything');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, FAILURE_CODES.DEPENDENCY_INVALID);
  assert.equal(issues[0].rule, 'regex');
});

test('validate: enum (choices) for single and multi options', () => {
  const plan = compileParameterPlan(node([
    { name: 'o', type: 'options', options: [{ name: 'A', value: 'a' }, { name: 'B', value: 'b' }] },
    { name: 'm', type: 'multiOptions', options: [{ name: 'x', value: 'x' }, { name: 'y', value: 'y' }] },
  ]));
  assert.equal(validateValue(param(plan, 'o'), 'a').issues.length, 0);
  assert.equal(validateValue(param(plan, 'o'), 'z').issues[0].rule, 'enum');
  assert.equal(validateValue(param(plan, 'm'), ['x', 'y']).issues.length, 0);
  const bad = validateValue(param(plan, 'm'), ['x', 'q']).issues;
  assert.equal(bad.length, 1);
  assert.equal(bad[0].rule, 'enum');
  assert.match(bad[0].message, /q/);
});

test('validate: minRequiredFields on a collection', () => {
  const plan = compileParameterPlan(node([
    { name: 'c', type: 'collection', typeOptions: { minRequiredFields: 2 }, options: [
      { name: 'a', type: 'string' }, { name: 'b', type: 'string' }, { name: 'd', type: 'string' },
    ] },
  ]));
  assert.equal(validateValue(param(plan, 'c'), { a: '1', b: '2' }).issues.length, 0);
  const { issues } = validateValue(param(plan, 'c'), { a: '1' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'minRequiredFields');
});

test('validate: ignoreValidationDuringExecution skips rule checks but keeps the value', () => {
  const plan = compileParameterPlan(node([
    { name: 'n', type: 'number', typeOptions: { maxValue: 10 }, ignoreValidationDuringExecution: true },
  ]));
  const { canonical, issues } = validateValue(param(plan, 'n'), 99);
  assert.equal(issues.length, 0);
  assert.equal(canonical, 99);
});

test('validate: structured issues never carry the offending value as secret material', () => {
  const plan = compileParameterPlan(node([
    { name: 'secret', type: 'string', typeOptions: { password: true, maxLength: 8 } },
  ]));
  const longSecret = 'hunter2-super-secret-value';
  const { issues } = validateValue(param(plan, 'secret'), longSecret);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'maxLength');
  const serialized = JSON.stringify(issues);
  assert.ok(!serialized.includes(longSecret), 'issue must not embed the raw secret value');
  assert.equal(issues[0].path, 'secret');
});

/* ------------------------------------------------------------------ CP-03 failure vocabulary */

test('failure: the closed vocabulary is complete and the local codes are the only two this stage emits', () => {
  assert.deepEqual(Object.keys(FAILURE_CODES).length, 11);
  for (const value of Object.values(FAILURE_CODES)) assert.equal(typeof value, 'string');
  assert.deepEqual(LOCAL_FAILURE_CODES, ['SCHEMA_INVALID', 'DEPENDENCY_INVALID']);
  assert.ok(Object.isFrozen(FAILURE_CODES));
});

test('failure: a validation failure is never a fake empty success', () => {
  const plan = compileParameterPlan(node([
    { name: 'n', type: 'number', typeOptions: { maxValue: 10 } },
    { name: 's', type: 'string', required: true },
  ]));
  const result = validateParameters(plan, { n: 99, s: '' });
  assert.equal(result.valid, false);
  assert.ok(result.issues.length >= 2);
  // The actual values are preserved (not blanked into an empty success).
  assert.equal(result.normalized.n, 99);
  assert.equal(result.normalized.s, '');
});

test('failure: local stage only ever emits local codes', () => {
  const plan = compileParameterPlan(node([
    { name: 'n', type: 'number' },
    { name: 's', type: 'string', typeOptions: { regex: '([' } },
    { name: 'o', type: 'options', options: [{ name: 'A', value: 'a' }] },
  ]));
  const result = validateParameters(plan, { n: 'x', s: 'y', o: 'z' });
  for (const issue of result.issues) {
    assert.ok(LOCAL_FAILURE_CODES.includes(issue.code), `unexpected non-local code ${issue.code}`);
  }
});

/* ------------------------------------------------------------------ full walk */

test('validateParameters: normalizes nested values and collects every issue', () => {
  const plan = compileParameterPlan(node([
    { name: 'resource', type: 'options', options: [{ name: 'A', value: 'a' }] },
    { name: 'count', type: 'number', typeOptions: { minValue: 1, maxValue: 10 } },
    { name: 'label', type: 'string', typeOptions: { maxLength: 5 }, required: true },
    { name: 'opts', type: 'collection', options: [{ name: 'timeout', type: 'number' }, { name: 'name', type: 'string' }] },
  ]));
  const result = validateParameters(plan, { resource: 'a', count: '7', label: 'hello', opts: { timeout: '30', name: 'n' } });
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.normalized.count, 7);
  assert.equal(result.normalized.opts.timeout, 30);
  assert.deepEqual([...result.changed].sort(), ['count', 'opts.timeout']);
});

test('validateParameters: multiple issues across slots are all reported', () => {
  const plan = compileParameterPlan(node([
    { name: 'o', type: 'options', options: [{ name: 'A', value: 'a' }] },
    { name: 'n', type: 'number', typeOptions: { maxValue: 10 } },
    { name: 's', type: 'string', required: true },
  ]));
  const result = validateParameters(plan, { o: 'z', n: 99, s: '' });
  const rules = result.issues.map((i) => i.rule).sort();
  assert.deepEqual(rules, ['enum', 'maxValue', 'required']);
});

test('validateParameters: absent slots produce no issue unless required; no crash on null/undefined values', () => {
  const plan = compileParameterPlan(node([
    { name: 's', type: 'string', required: true },
    { name: 'opt', type: 'string' },
  ]));
  assert.equal(validateParameters(plan, {}).issues.length, 1);
  assert.equal(validateParameters(plan, null).issues.length, 1);
  assert.equal(validateParameters(plan, undefined).issues.length, 1);
  assert.equal(validateParameters(plan, { s: 'present', opt: undefined }).issues.length, 0, 'an explicitly-undefined non-required slot produces no issue');
});

test('validateParameters: expression references are detected and left unresolved (not evaluated)', () => {
  const plan = compileParameterPlan(node([
    { name: 'a', type: 'string' },
    { name: 'b', type: 'string' },
  ]));
  assert.ok(isExpression('=expr'));
  assert.ok(!isExpression('expr'));
  assert.ok(!isExpression(''));
  const result = validateParameters(plan, { a: '=${x}', b: 'plain' });
  assert.deepEqual(result.unresolvedExpressions, ['a']);
  assert.equal(result.normalized.a, '=${x}');
});

/* ------------------------------------------------------------------ CP-04 execution snapshot */

test('snapshot: carries the §29 fields and is compact + immutable (deep-frozen)', () => {
  const plan = compileParameterPlan(node([
    { name: 'n', type: 'number' },
    { name: 's', type: 'string' },
  ]));
  const snapshot = buildExecutionSnapshot(plan, { n: '5', s: '=${x}' }, { createdAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(snapshot.format, SNAPSHOT_FORMAT);
  assert.equal(snapshot.formatVersion, SNAPSHOT_FORMAT_VERSION);
  assert.equal(snapshot.schemaVersion, plan.schemaVersion);
  assert.equal(snapshot.nodeType, plan.nodeType);
  assert.equal(snapshot.typeVersion, plan.typeVersion);
  assert.equal(snapshot.planFingerprint, plan.planFingerprint);
  assert.equal(snapshot.definitionFingerprint, plan.definitionFingerprint);
  assert.equal(snapshot.validationStatus, 'valid');
  assert.equal(snapshot.issueCount, 0);
  assert.equal(typeof snapshot.dependencyDigest, 'string');
  assert.equal(snapshot.dependencyDigest.length, 64);
  assert.deepEqual(snapshot.unresolvedExpressions, ['s']);
  assert.equal(snapshot.values.n, 5, 'value normalized in the snapshot');
  assert.equal(snapshot.createdAt, '2026-01-01T00:00:00.000Z');
  assert.ok(Object.isFrozen(snapshot), 'snapshot is frozen');
  assert.ok(Object.isFrozen(snapshot.values), 'snapshot.values is frozen');
  assert.throws(() => { snapshot.values.n = 99; });
});

test('snapshot: invalid values are reflected in validationStatus/issueCount', () => {
  const plan = compileParameterPlan(node([
    { name: 'n', type: 'number', typeOptions: { maxValue: 10 } },
  ]));
  const snapshot = buildExecutionSnapshot(plan, { n: 99 });
  assert.equal(snapshot.validationStatus, 'invalid');
  assert.equal(snapshot.issueCount, 1);
});

test('snapshot: dependency digest is deterministic over the normalized values', () => {
  const plan = compileParameterPlan(node([
    { name: 'n', type: 'number' },
    { name: 's', type: 'string' },
  ]));
  const a = buildExecutionSnapshot(plan, { n: '5', s: 'x' }, { createdAt: '2026-01-01T00:00:00.000Z' });
  const b = buildExecutionSnapshot(plan, { n: 5, s: 'x' }, { createdAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(a.dependencyDigest, b.dependencyDigest, 'same normalized values -> same digest');
  const c = buildExecutionSnapshot(plan, { n: 6, s: 'x' }, { createdAt: '2026-01-01T00:00:00.000Z' });
  assert.notEqual(a.dependencyDigest, c.dependencyDigest, 'different values -> different digest');
});

test('snapshot: §30 derived + reconstructible (byte-identical re-derivation, canonical untouched)', () => {
  const plan = compileParameterPlan(node([
    { name: 'c', type: 'collection', options: [{ name: 'f', type: 'number' }] },
  ]));
  const values = { c: { f: '1' } };
  const options = { createdAt: '2026-01-01T00:00:00.000Z' };
  const first = buildExecutionSnapshot(plan, values, options);
  const second = reconstructSnapshot(plan, values, options);
  assert.equal(JSON.stringify(first), JSON.stringify(second), 're-derivation is byte-identical');
  assert.notEqual(values.c.f, 1, 'the canonical input is NOT rewritten by the derived snapshot');
  assert.equal(typeof values.c.f, 'string');
  // The plan (canonical definition) is untouched.
  assert.equal(Object.isFrozen(plan), true);
});

/* ------------------------------------------------------------------ CP-05 negative / security / determinism */

test('determinism: validateParameters is idempotent and pure (input never mutated or frozen)', () => {
  const plan = compileParameterPlan(node([
    { name: 'c', type: 'collection', options: [{ name: 'f', type: 'number' }] },
    { name: 'n', type: 'number' },
  ]));
  const values = { c: { f: '1' }, n: '2' };
  const before = JSON.stringify(values);
  const first = validateParameters(plan, values);
  const second = validateParameters(plan, values);
  assert.equal(JSON.stringify(first.normalized), JSON.stringify(second.normalized));
  assert.equal(first.dependencyDigest, second.dependencyDigest);
  assert.equal(JSON.stringify(values), before, 'input not mutated');
  assert.ok(!Object.isFrozen(values) && !Object.isFrozen(values.c), 'input not frozen');
  buildExecutionSnapshot(plan, values);
  assert.equal(JSON.stringify(values), before, 'input still not mutated after a snapshot');
});

test('negative: oversized / many normalizations are bounded (no unbounded growth)', () => {
  const properties = [];
  for (let i = 0; i < 3000; i += 1) properties.push({ name: `f${i}`, type: 'number' });
  const plan = compileParameterPlan(node(properties));
  const values = {};
  for (let i = 0; i < 3000; i += 1) values[`f${i}`] = String(i);
  const result = validateParameters(plan, values);
  assert.equal(result.valid, true);
  assert.equal(result.normalized.f0, 0);
  assert.equal(result.normalized.f2999, 2999);
  // `changed` is bounded so a huge form cannot balloon the telemetry surface.
  assert.ok(result.changed.length <= 4096);
});

test('negative: deeply nested missing containers fail safely (no throw, no false success)', () => {
  const plan = compileParameterPlan(node([
    { name: 'c', type: 'collection', options: [{ name: 'f', type: 'string', required: true }] },
  ]));
  // The collection itself is present but its required child is missing.
  const result = validateParameters(plan, { c: {} });
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].path, 'c.f');
  assert.equal(result.issues[0].rule, 'required');
});

test('security: sensitive (password) values are validated by shape only and never echoed', () => {
  const plan = compileParameterPlan(node([
    { name: 'password', type: 'string', typeOptions: { password: true, maxLength: 8 } },
  ]));
  const longSecret = 'a-very-long-secret-value-that-exceeds-eight';
  const { issues } = validateValue(param(plan, 'password'), longSecret);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'maxLength');
  assert.ok(!JSON.stringify(issues).includes(longSecret), 'secret value must not appear in issues');
  assert.ok(plan.sensitiveParameters.includes(param(plan, 'password').id), 'parameter is registered sensitive');
});

test('format: the module exports stable, versioned format constants', () => {
  assert.equal(VALIDATION_FORMAT_VERSION, 1);
  assert.equal(SNAPSHOT_FORMAT, 'n8n-lego.execution-snapshot');
});
