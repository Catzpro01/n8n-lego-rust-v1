/**
 * P7-S06 — Credential-Aware Resolution (Issue #223 §18, §19, §28, §27, §34; DEC-0024).
 *
 * Unit rules pin the scoped SecretRef (never plaintext), the credential composition pipeline
 * (authorization -> SecretRef -> Secret Broker -> narrowly scoped provider operation ->
 * normalized result), the capability boundary, the no-leak guarantee (material never in cache /
 * result / error), and the security-sensitive revalidation marker on explicit, replaceable
 * broker + provider objects (in-memory for tests).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CREDENTIAL_FAILURE_CODES, CredentialResolutionError, CredentialResolutionSession,
  checkCapability, createInMemoryCredentialProvider, createInMemorySecretBroker,
  createSecretRef, credentialCacheKey, scrub, secretStrings,
} from '../src/lego/parameter-credential.mjs';

const MATERIAL = 'super-secret-token-123';
const REF_FIELDS = { credentialId: 'cred-1', principal: 'user-1', tenant: 't-1', capability: 'read', action: 'list', resource: 'accounts' };
const OPTIONS = [ { name: 'Acct A', value: 'a' }, { name: 'Acct B', value: 'b' } ];

function makeRef(fields = REF_FIELDS) { return createSecretRef(fields); }

function session({ handler, authorize, secrets = new Map([['cred-1', MATERIAL]]), limits } = {}) {
  const provider = createInMemoryCredentialProvider(handler ?? (async () => OPTIONS));
  const broker = createInMemorySecretBroker(secrets);
  return new CredentialResolutionSession({ provider, broker, authorize: authorize ?? (() => true), limits });
}

/* ------------------------------------------------------------------ CP-01 scoped SecretRef */

test('CP-01: createSecretRef builds a request-bound, opaque, immutable ref (scope + nonce, no material)', () => {
  const ref = makeRef();
  assert.equal(ref.kind, 'SecretRef');
  assert.equal(ref.credentialId, 'cred-1');
  assert.equal(ref.principal, 'user-1');
  assert.equal(ref.capability, 'read');
  assert.equal(typeof ref.nonce, 'string');
  assert.ok(ref.nonce.length > 0);
  assert.ok(Object.isFrozen(ref), 'the ref is immutable');
  // the material is NOT a field of the ref
  assert.equal('super-secret-token-123', undefined === ref[MATERIAL] ? MATERIAL : MATERIAL); // sanity
  for (const key of Object.keys(ref)) {
    assert.notEqual(ref[key], MATERIAL, `ref field ${key} must not hold the material`);
  }
});

test('CP-01: a SecretRef that carries raw credential material is rejected (CREDENTIAL_LEAK)', () => {
  for (const field of ['secret', 'password', 'token', 'accessToken', 'apiKey', 'value']) {
    assert.throws(() => createSecretRef({ ...REF_FIELDS, [field]: MATERIAL }),
      (err) => err instanceof CredentialResolutionError && err.code === 'CREDENTIAL_LEAK', `expected CREDENTIAL_LEAK for "${field}"`);
  }
});

test('CP-01: a SecretRef missing an empty scope field is rejected (INVALID_SECRET_REF)', () => {
  assert.throws(() => createSecretRef({ ...REF_FIELDS, principal: '' }), (err) => err.code === 'INVALID_SECRET_REF');
  assert.throws(() => createSecretRef({ ...REF_FIELDS, capability: undefined }), (err) => err.code === 'INVALID_SECRET_REF');
  assert.throws(() => createSecretRef(null), (err) => err.code === 'INVALID_SECRET_REF');
  assert.throws(() => createSecretRef('cred-1'), (err) => err.code === 'INVALID_SECRET_REF');
});

/* ------------------------------------------------------------------ CP-02 composition pipeline */

test('CP-02: resolve composes authorization -> SecretRef -> broker -> provider -> normalized result', async () => {
  let sawMaterial = null;
  const s = session({ handler: async (material) => { sawMaterial = material; return OPTIONS; } });
  const r = await s.resolve(makeRef(), {});
  assert.equal(r.error, undefined);
  assert.deepEqual(r.options.map((o) => o.value), ['a', 'b']);
  assert.equal(sawMaterial, MATERIAL, 'the narrowly scoped provider operation received the in-memory material');
});

test('CP-02: the broker holds material in-memory only; a missing credential is a marked AUTH_REJECTED', async () => {
  let providerCalled = 0;
  const s = session({
    handler: async () => { providerCalled += 1; return OPTIONS; },
    secrets: new Map([['other', 'x']]), // 'cred-1' is NOT held
  });
  const r = await s.resolve(makeRef(), {});
  assert.ok(r.error, 'a missing credential is a marked failure');
  assert.equal(r.error.code, 'AUTH_REJECTED');
  assert.deepEqual(r.options, []);
  assert.equal(providerCalled, 0, 'the provider is never called when the credential cannot be resolved');
});

test('CP-02: resolve() refuses raw material (only a SecretRef is accepted)', async () => {
  const s = session();
  await assert.rejects(s.resolve({ credentialId: 'cred-1', secret: MATERIAL }, {}), (err) => err.code === 'INVALID_SECRET_REF');
  await assert.rejects(s.resolve(null, {}), (err) => err.code === 'INVALID_SECRET_REF');
});

/* ------------------------------------------------------------------ CP-03 capability boundary */

test('CP-03: a denied capability is a marked CAPABILITY_DENIED and the provider is never called', async () => {
  let providerCalled = 0;
  const s = session({
    handler: async () => { providerCalled += 1; return OPTIONS; },
    authorize: () => ({ allowed: false, reason: 'capability not granted' }),
  });
  const r = await s.resolve(makeRef(), {});
  assert.ok(r.error && r.error.code === 'CAPABILITY_DENIED');
  assert.equal(r.error.message, 'capability not granted');
  assert.equal(providerCalled, 0, 'option visibility does not grant permission to execute');
});

test('CP-03: a missing authorizer fails closed (CAPABILITY_DENIED, provider never called)', async () => {
  let providerCalled = 0;
  const provider = createInMemoryCredentialProvider(async () => { providerCalled += 1; return OPTIONS; });
  const broker = createInMemorySecretBroker(new Map([['cred-1', MATERIAL]]));
  const s = new CredentialResolutionSession({ provider, broker }); // no authorizer
  const r = await s.resolve(makeRef(), {});
  assert.ok(r.error && r.error.code === 'CAPABILITY_DENIED');
  assert.equal(providerCalled, 0);
  // checkCapability is fail-closed with no authorizer
  const d = checkCapability(makeRef(), undefined);
  assert.equal(d.allowed, false);
});

test('CP-03: provider-returned metadata cannot grant itself new authority (authority stays the original scope)', async () => {
  const s = session({
    // a malicious provider tries to elevate authority via returned metadata
    handler: async () => ({ options: OPTIONS, grantedCapability: 'admin', tenant: 'root' }),
  });
  const r = await s.resolve(makeRef(), {});
  assert.equal(r.security.capability, 'read', 'the capability is the original scope, not the provider metadata');
  assert.equal(r.security.tenant, 't-1', 'the tenant is the original scope, not the provider metadata');
  assert.equal(r.security.principal, 'user-1');
  assert.equal(r.security.resource, 'accounts');
});

/* ------------------------------------------------------------------ CP-04 no-leak guarantee */

test('CP-04: the credential material never appears in the cached value (only the normalized result)', async () => {
  const s = session();
  const ref = makeRef();
  await s.resolve(ref, {});
  const key = credentialCacheKey(ref, {});
  const entry = s.cache.peek(key);
  assert.ok(entry, 'the result is cached');
  const serialized = JSON.stringify(entry.value);
  assert.ok(!serialized.includes(MATERIAL), 'the material is absent from the cached value');
  // the cache key is over the scope, never the material
  assert.ok(!key.includes(MATERIAL), 'the material is absent from the cache key');
});

test('CP-04: scrub() redacts secret material from strings and nested objects', () => {
  const scrubbed = scrub({ msg: `failed near ${MATERIAL}`, list: [`${MATERIAL} and more`, { deep: MATERIAL }] }, [MATERIAL]);
  const serialized = JSON.stringify(scrubbed);
  assert.ok(!serialized.includes(MATERIAL), 'no material after scrub');
  assert.ok(serialized.includes('[REDACTED]'), 'the material is replaced with [REDACTED]');
  assert.equal(scrubbed.msg, 'failed near [REDACTED]');
  assert.equal(scrubbed.list[0], '[REDACTED] and more');
  assert.equal(scrubbed.list[1].deep, '[REDACTED]');
});

test('CP-04: a provider that echoes the material in the result is scrubbed (no leak in the returned options)', async () => {
  const s = session({ handler: async (material) => [{ name: 'A', value: 'a', description: `secret=${material}` }] });
  const r = await s.resolve(makeRef(), {});
  assert.equal(r.error, undefined);
  const serialized = JSON.stringify(r.options);
  assert.ok(!serialized.includes(MATERIAL), 'the material is absent from the returned options');
  assert.ok(r.options[0].description.includes('[REDACTED]'), 'the echoed material is redacted');
});

test('CP-04: a provider that echoes the material in an error is scrubbed (no leak in the error payload)', async () => {
  const s = session({ handler: async (material) => { throw new Error(`auth failed, token=${material}`); } });
  const r = await s.resolve(makeRef(), {});
  assert.ok(r.error, 'the failure is marked');
  assert.ok(!r.error.message.includes(MATERIAL), 'the material is absent from the error message');
  assert.ok(r.error.message.includes('[REDACTED]'), 'the echoed material is redacted in the error');
});

test('CP-04: secretStrings() derives the redaction list from string/object material', () => {
  assert.deepEqual(secretStrings(MATERIAL), [MATERIAL]);
  assert.deepEqual(secretStrings({ key: 'abc', num: 1 }), ['abc']);
  assert.deepEqual(secretStrings(null), []);
  assert.deepEqual(secretStrings(42), []);
});

/* ------------------------------------------------------------------ CP-05 security-sensitive values */

test('CP-05: a result is marked security-sensitive + revalidation-required (authoritative authority is the scope)', async () => {
  const s = session();
  const r = await s.resolve(makeRef(), {});
  assert.equal(r.security.sensitive, true);
  assert.equal(r.security.revalidationRequired, true);
  assert.deepEqual(
    { p: r.security.principal, t: r.security.tenant, c: r.security.capability, a: r.security.action, r: r.security.resource },
    { p: 'user-1', t: 't-1', c: 'read', a: 'list', r: 'accounts' },
  );
});

test('CP-05: an authoritative resolution NEVER serves a cached value (always revalidates against current authority)', async () => {
  let calls = 0;
  const s = session({ handler: async () => { calls += 1; return OPTIONS; } });
  const ref = makeRef();
  const first = await s.resolve(ref, {}, { authoritative: true });
  const second = await s.resolve(ref, {}, { authoritative: true });
  assert.equal(calls, 2, 'an authoritative resolution revalidates every time (never a cached UI option as authority)');
  assert.equal(first.error, undefined);
  assert.equal(second.error, undefined);
  assert.equal(second.security.revalidationRequired, true);
});

test('CP-05: a display (non-authoritative) resolution may serve a fresh cached result (still revalidation-required)', async () => {
  let calls = 0;
  const s = session({ handler: async () => { calls += 1; return OPTIONS; } });
  const ref = makeRef();
  await s.resolve(ref, {});
  const second = await s.resolve(ref, {});
  assert.equal(calls, 1, 'the second display resolution is served from the cache');
  assert.equal(second.options.length, 2);
  assert.equal(second.security.revalidationRequired, true, 'even a cached display result requires revalidation before execution');
});

test('CP-05: the closed failure vocabulary is frozen and includes the auth/capability/revalidation codes', () => {
  assert.ok(Object.isFrozen(CREDENTIAL_FAILURE_CODES));
  for (const code of ['AUTH_REQUIRED', 'AUTH_REJECTED', 'CAPABILITY_DENIED', 'REVALIDATION_REQUIRED', 'CREDENTIAL_LEAK']) {
    assert.ok(CREDENTIAL_FAILURE_CODES.includes(code), `missing ${code}`);
  }
});
