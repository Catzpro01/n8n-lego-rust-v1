/**
 * P7-S07 — Plugin/Provider Runtime Boundary (Issue #223 §17, §19, §22, §32-33, §35-36; DEC-0024).
 *
 * Unit rules pin the provider registration/declaration boundary (identity/version/capabilities/
 * locality/trust class/budgets, vendor fields excluded), the provider-backed schema fragment
 * (versioned/size-bounded/capability-scoped/cacheable; no security override), community node
 * compatibility (accept canonical n8n, preserve supported fields, reject only invalid/unsafe,
 * diagnostics, fallbacks), the storage boundary (bounded derived state only), and bounded
 * observability (closed event set, no secret material).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDER_TRUST_CLASSES, PROVIDER_REQUIRED_FIELDS, PROVIDER_LIMITS, SUPPORTED_NODE_FIELDS,
  OBSERVABILITY_EVENTS, BOUNDARY_FAILURE_CODES, ProviderBoundaryError,
  registerProvider, validateProviderSchemaFragment, compileCommunityNodeDeclaration,
  assertBoundedDerivedState, createObservabilitySink,
} from '../src/lego/parameter-provider-boundary.mjs';

const VALID_DECL = {
  id: 'my-provider', version: '1.2.3',
  capabilities: ['read:projects', 'read:accounts'],
  locality: 'remote', trustClass: 'remote',
  budgets: { maxConcurrency: 4, timeoutMs: 3000 },
};

/* ------------------------------------------------------------------ CP-01 provider registration */

test('CP-01: registerProvider normalizes a valid declaration to a frozen canonical descriptor', () => {
  const d = registerProvider(VALID_DECL);
  assert.equal(d.kind, 'ProviderDescriptor');
  assert.equal(d.id, 'my-provider');
  assert.equal(d.version, '1.2.3');
  assert.equal(d.trustClass, 'remote');
  assert.deepEqual(d.capabilities, ['read:accounts', 'read:projects'], 'capabilities are normalized (sorted)');
  assert.ok(Object.isFrozen(d), 'the descriptor is immutable');
  assert.ok(Object.isFrozen(d.budgets));
  assert.deepEqual(Object.keys(VALID_DECL).length, 6);
});

test('CP-01: a declaration missing a required field is rejected (PROVIDER_DECLARATION_INVALID)', () => {
  for (const field of PROVIDER_REQUIRED_FIELDS) {
    const decl = { ...VALID_DECL };
    delete decl[field];
    assert.throws(() => registerProvider(decl), (err) =>
      err instanceof ProviderBoundaryError && err.code === 'PROVIDER_DECLARATION_INVALID' && err.details.field === field, `expected missing "${field}" to be rejected`);
  }
});

test('CP-01: vendor-specific business-model fields are EXCLUDED from the public contract', () => {
  const d = registerProvider({ ...VALID_DECL, vendorInternal: { billing: 'x' }, proprietaryModel: 42 });
  const serialized = JSON.stringify(d);
  assert.ok(!serialized.includes('vendorInternal'), 'vendor fields are excluded');
  assert.ok(!serialized.includes('proprietaryModel'), 'vendor fields are excluded');
  assert.deepEqual(Object.keys(d).sort(), ['budgets', 'capabilities', 'id', 'kind', 'locality', 'trustClass', 'version']);
});

test('CP-01: an invalid trust class is rejected (admission is P6, but the class must be declared valid)', () => {
  assert.throws(() => registerProvider({ ...VALID_DECL, trustClass: 'untrusted-rogue' }),
    (err) => err.code === 'PROVIDER_DECLARATION_INVALID');
  assert.ok(Object.values(PROVIDER_TRUST_CLASSES).includes('remote'));
});

/* ------------------------------------------------------------------ CP-02 provider-backed schema */

const BASE = { schema: { resource: { type: 'string', required: true } } };

test('CP-02: a valid provider schema fragment is accepted (versioned, bounded, capability-scoped, cacheable)', () => {
  const fragment = { version: '2.0.0', capability: 'read:accounts', cacheable: true, schema: { account: { type: 'string' } } };
  const result = validateProviderSchemaFragment(BASE, fragment);
  assert.equal(result.kind, 'ProviderSchemaFragment');
  assert.equal(result.version, '2.0.0');
  assert.equal(result.capability, 'read:accounts');
  assert.equal(result.baseAuthoritative, true, 'the base schema is always authoritative');
  assert.ok(Object.isFrozen(result));
});

test('CP-02: a fragment that overrides a canonical/security field is rejected (SCHEMA_FRAGMENT_SECURITY_OVERRIDE)', () => {
  for (const field of ['security', 'authorization', 'credentials', 'canonical', 'policy']) {
    const fragment = { version: '1', capability: 'c', cacheable: true, schema: { a: 1 }, [field]: { override: true } };
    assert.throws(() => validateProviderSchemaFragment(BASE, fragment), (err) =>
      err.code === 'SCHEMA_FRAGMENT_SECURITY_OVERRIDE', `expected "${field}" override to be rejected`);
  }
});

test('CP-02: a fragment that is not versioned / capability-scoped / cacheable / bounded is rejected', () => {
  const good = { version: '1', capability: 'c', cacheable: true, schema: { a: 1 } };
  assert.throws(() => validateProviderSchemaFragment(BASE, { ...good, version: '' }), (err) => err.code === 'SCHEMA_FRAGMENT_INVALID');
  assert.throws(() => validateProviderSchemaFragment(BASE, { ...good, capability: '' }), (err) => err.code === 'SCHEMA_FRAGMENT_INVALID');
  assert.throws(() => validateProviderSchemaFragment(BASE, { ...good, cacheable: false }), (err) => err.code === 'SCHEMA_FRAGMENT_INVALID');
  assert.throws(() => validateProviderSchemaFragment(BASE, { ...good, schema: {} }), (err) => err.code === 'SCHEMA_FRAGMENT_INVALID');
  const huge = { ...good, schema: { big: 'x'.repeat(PROVIDER_LIMITS.maxFragmentBytes + 1) } };
  assert.throws(() => validateProviderSchemaFragment(BASE, huge), (err) => err.code === 'SCHEMA_FRAGMENT_INVALID');
});

/* ------------------------------------------------------------------ CP-03 community node compatibility */

test('CP-03: a canonical n8n node declaration compiles, preserving supported fields', () => {
  const decl = { name: 'My Node', type: 'n8n-nodes-base.http', typeVersion: 4.2, position: [0, 0], parameters: { url: 'x' }, credentials: { http: 1 }, notes: 'hi' };
  const { ok, plan, diagnostics, fallbacks } = compileCommunityNodeDeclaration(decl);
  assert.equal(ok, true);
  assert.equal(plan.name, 'My Node');
  assert.equal(plan.type, 'n8n-nodes-base.http', 'supported fields are preserved');
  assert.equal(plan.typeVersion, 4.2);
  assert.deepEqual(plan.parameters, { url: 'x' });
  assert.equal(diagnostics.length, 0, 'no diagnostics for a fully supported declaration');
  assert.equal(fallbacks.length, 0, 'no fallbacks needed');
});

test('CP-03: unsupported fields become compatibility diagnostics (warnings), not rejections', () => {
  const { ok, plan, diagnostics } = compileCommunityNodeDeclaration({ name: 'N', customField: 123 });
  assert.equal(ok, true, 'unsupported fields are not a rejection');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'UNSUPPORTED_FIELD');
  assert.equal(diagnostics[0].field, 'customField');
  assert.deepEqual(plan._metadata.customField, 123, 'the field is preserved as opaque metadata');
});

test('CP-03: a truly invalid node declaration (non-object / missing name) is rejected', () => {
  assert.throws(() => compileCommunityNodeDeclaration('not an object'), (err) => err.code === 'NODE_DECLARATION_INVALID');
  assert.throws(() => compileCommunityNodeDeclaration({ type: 'x' }), (err) => err.code === 'NODE_DECLARATION_INVALID');
  assert.throws(() => compileCommunityNodeDeclaration({ name: '   ' }), (err) => err.code === 'NODE_DECLARATION_INVALID');
});

test('CP-03: a fallback is used ONLY where upstream semantics require it (type / parameters / typeVersion)', () => {
  const { plan, fallbacks } = compileCommunityNodeDeclaration({ name: 'Bare Node' });
  assert.equal(plan.type, 'Bare Node', 'missing type falls back to the node name');
  assert.deepEqual(plan.parameters, {}, 'missing parameters fall back to an empty set');
  assert.equal(plan.typeVersion, 1, 'missing version falls back to 1');
  assert.equal(fallbacks.length, 3);
  for (const f of fallbacks) assert.ok(f.reason, 'each fallback has a reason');
});

/* ------------------------------------------------------------------ CP-04 storage boundary */

test('CP-04: bounded derived state is allowed (P7 owns only bounded derived/cache state)', () => {
  const derived = { options: [{ name: 'A', value: 'a' }], digest: 'abc', plan: { x: 1 } };
  const result = assertBoundedDerivedState(derived);
  assert.equal(result.allowed, true);
  assert.ok(result.bytes > 0);
});

test('CP-04: canonical workflow / durable / unbounded state is rejected (P7 does not become P8)', () => {
  for (const marker of ['workflows', 'connections', 'durable', 'persistent']) {
    assert.throws(() => assertBoundedDerivedState({ [marker]: [] }), (err) =>
      err.code === 'STORAGE_BOUNDARY_VIOLATION', `expected "${marker}" to be rejected`);
  }
  const unbounded = { data: 'x'.repeat(PROVIDER_LIMITS.maxDerivedStateBytes + 1) };
  assert.throws(() => assertBoundedDerivedState(unbounded), (err) => err.code === 'STORAGE_BOUNDARY_VIOLATION');
  assert.throws(() => assertBoundedDerivedState(null), (err) => err.code === 'STORAGE_BOUNDARY_VIOLATION');
});

/* ------------------------------------------------------------------ CP-05 bounded observability */

test('CP-05: the observability sink emits the closed P9 event set', () => {
  const sink = createObservabilitySink();
  for (const name of Object.values(OBSERVABILITY_EVENTS)) {
    const event = sink.emit(name, { param: 'x' });
    assert.equal(event.name, name);
  }
  assert.equal(sink.size(), Object.keys(OBSERVABILITY_EVENTS).length);
  assert.ok(Object.isFrozen(OBSERVABILITY_EVENTS));
});

test('CP-05: an unknown event or non-object payload is rejected (EVENT_INVALID); a valid call does not throw', () => {
  const sink = createObservabilitySink();
  assert.throws(() => sink.emit('parameter.rogue.event', {}), (err) => err.code === 'EVENT_INVALID');
  assert.throws(() => sink.emit('parameter.resolve.started', 'not an object'), (err) => err.code === 'EVENT_INVALID');
  assert.doesNotThrow(() => sink.emit('parameter.resolve.started', { a: 1 }), 'a valid call does not throw');
});

test('CP-05: secret material is never emitted (payloads are scrubbed)', () => {
  const SECRET = 'top-secret-credential';
  const sink = createObservabilitySink([SECRET]);
  const event = sink.emit('parameter.resolve.failed', { error: `auth failed token=${SECRET}`, param: { apikey: SECRET } });
  const serialized = JSON.stringify(event.payload);
  assert.ok(!serialized.includes(SECRET), 'no secret material in the emitted payload');
  assert.ok(serialized.includes('[REDACTED]'), 'the secret is redacted');
});

test('CP-05: the sink is bounded (max events retained) and the closed set is frozen', () => {
  const sink = createObservabilitySink([], { maxEventsPerSink: 3 });
  for (let i = 0; i < 10; i++) sink.emit('parameter.cache.hit', { i });
  assert.equal(sink.size(), 3, 'the sink is bounded');
  assert.ok(BOUNDARY_FAILURE_CODES.includes('EVENT_INVALID'));
  assert.ok(SUPPORTED_NODE_FIELDS.includes('name') && SUPPORTED_NODE_FIELDS.includes('parameters'));
});
