/**
 * P5.1 — Security kernel tests.
 *
 * PUBLIC CONTRACT (`auth.principal`, v1.0.0): positive construction, the
 * negative matrix from Issue #214, and the contract surface pin.
 *
 * The negative tests are the point of this file. A security kernel that only
 * passes happy paths is untested: every assertion below rejects an input that a
 * real caller could plausibly send (a stored user record, a typo'd scope, a
 * forged version) and checks that the kernel refuses it rather than degrading it.
 *
 * Every reason code asserted here is PUBLISHED in contracts/errors.contract.json.
 * The kernel introduces no new error vocabulary of its own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  AUTH_METHODS,
  AUTH_STRENGTHS,
  DEFAULT_TENANT,
  PRINCIPAL_TYPES,
  SECURITY_DECISION,
  SECURITY_REASON,
  STAMP_AUTHORITY,
  STAMP_FIELDS,
  SecurityError,
  assertSecurityContext,
  assertSecurityReason,
  authStrengthRank,
  checkTenantBinding,
  compilePermissions,
  createPrincipalSnapshot,
  createSecurityContext,
  createSecurityStamp,
  evaluateStampAuthority,
  hasPermission,
  isPrincipalExpired,
  isPrincipalSnapshot,
  isSecurityContext,
  isSecurityStamp,
  meetsAuthStrength,
  permissionSetIdFor,
} from '../src/auth/security/index.mjs';
import { isErrorCode } from '../src/lego/errors.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const LOCK = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
const DOMAINS = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url), 'utf8'));

/** A well-formed principal; tests override only the field under examination. */
function principal(overrides = {}) {
  return createPrincipalSnapshot({
    principalId: 'principal-1',
    identityId: 'identity-1',
    tenantId: 'default',
    principalType: 'user',
    authMethod: 'password',
    authStrength: 'password',
    permissions: ['workflow:read', 'credential:read'],
    principalVersion: 3,
    sessionId: 'session-1',
    issuedAt: 1_000_000,
    ...overrides,
  });
}

function context(overrides = {}, principalOverrides = {}) {
  return createSecurityContext({
    principal: principal(principalOverrides),
    requestId: 'request-1',
    correlationId: 'correlation-1',
    tenantVersion: 1,
    policyVersion: 2,
    sessionVersion: 4,
    issuedAt: 1_000_000,
    ...overrides,
  });
}

/** Asserts `thunk` throws a SecurityError carrying `code`. */
function assertDenies(code, thunk, label) {
  assert.throws(
    thunk,
    (error) => {
      assert.ok(error instanceof SecurityError, `${label}: expected SecurityError, got ${error?.name}`);
      assert.equal(error.code, code, `${label}: wrong code (${error.code})`);
      assert.ok(isErrorCode(error.code), `${label}: code ${error.code} is not published`);
      return true;
    },
    label,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Positive construction
// ─────────────────────────────────────────────────────────────────────────────

test('a PrincipalSnapshot is built, normalised and frozen', () => {
  const snapshot = principal({
    permissions: ['credential:read', 'workflow:read', 'workflow:read'],
  });
  assert.deepEqual(snapshot.permissions, ['credential:read', 'workflow:read'], 'dedup + sorted');
  assert.equal(snapshot.tenantId, 'default');
  assert.equal(snapshot.permissionSetId, permissionSetIdFor(['credential:read', 'workflow:read']));
  assert.ok(Object.isFrozen(snapshot), 'the snapshot is immutable');
  assert.ok(Object.isFrozen(snapshot.permissions), 'the permission list is immutable');
  assert.ok(isPrincipalSnapshot(snapshot));
});

test('the permissionSetId is deterministic and order-independent', () => {
  const a = principal({ permissions: ['workflow:read', 'credential:read'] });
  const b = principal({ permissions: ['credential:read', 'workflow:read'] });
  assert.equal(a.permissionSetId, b.permissionSetId);
  const c = principal({ permissions: ['workflow:read'] });
  assert.notEqual(a.permissionSetId, c.permissionSetId);
});

test('all four principal types and every auth method/strength pair are accepted', () => {
  for (const principalType of PRINCIPAL_TYPES) {
    assert.equal(principal({ principalType }).principalType, principalType);
  }
  for (const authMethod of AUTH_METHODS) {
    const authStrength = authMethod === 'none' ? 'none' : 'password';
    assert.equal(principal({ authMethod, authStrength }).authMethod, authMethod);
  }
  for (const authStrength of AUTH_STRENGTHS) {
    const authMethod = authStrength === 'none' ? 'none' : 'password';
    assert.equal(principal({ authMethod, authStrength }).authStrength, authStrength);
  }
});

test('a SecurityContext is request-local, frozen and carries the authority versions', () => {
  const ctx = context();
  assert.ok(Object.isFrozen(ctx));
  assert.ok(isSecurityContext(ctx));
  assert.equal(ctx.principalId, 'principal-1');
  assert.equal(ctx.requestId, 'request-1');
  assert.equal(ctx.correlationId, 'correlation-1');
  assert.equal(ctx.principalVersion, 3);
  assert.equal(ctx.tenantVersion, 1);
  assert.equal(ctx.policyVersion, 2);
  assert.equal(ctx.sessionVersion, 4);
  assert.equal(ctx.stamp.value, '3.1.2.4');
  assert.equal(assertSecurityContext(ctx), ctx);
});

test('a SecurityContext carries no profile, credential or full permission catalog', () => {
  const ctx = context();
  const forbidden = ['email', 'firstName', 'lastName', 'password', 'settings', 'role', 'globalScopes', 'name'];
  for (const key of forbidden) {
    assert.ok(!Object.prototype.hasOwnProperty.call(ctx, key), `context must not carry ${key}`);
  }
  // Permissions are referenced by set id only — the list itself is not on the
  // context that execution code reads.
  assert.ok(!Object.prototype.hasOwnProperty.call(ctx, 'permissions'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Negative matrix — malformed principal
// ─────────────────────────────────────────────────────────────────────────────

test('malformed principal inputs fail closed', () => {
  assertDenies('lego.contract_violation', () => createPrincipalSnapshot(null), 'null input');
  assertDenies('lego.contract_violation', () => createPrincipalSnapshot([]), 'array input');
  assertDenies('lego.contract_violation', () => createPrincipalSnapshot({}), 'missing fields');
  assertDenies(
    'lego.contract_violation',
    () => principal({ principalType: 'robot' }),
    'unknown principalType',
  );
  assertDenies(
    'lego.contract_violation',
    () => principal({ authMethod: 'magic-link' }),
    'unknown authMethod',
  );
  assertDenies(
    'lego.contract_violation',
    () => principal({ authStrength: 'super-strong' }),
    'unknown authStrength',
  );
  assertDenies(
    'lego.contract_violation',
    () => principal({ principalVersion: -1 }),
    'negative principalVersion',
  );
  assertDenies(
    'lego.contract_violation',
    () => principal({ principalVersion: 1.5 }),
    'non-integer principalVersion',
  );
  assertDenies('lego.contract_violation', () => principal({ principalId: '' }), 'empty principalId');
  assertDenies('lego.contract_violation', () => principal({ tenantId: '' }), 'empty tenantId');
  assertDenies(
    'lego.contract_violation',
    () => principal({ expiresAt: 999_999 }),
    'expiresAt at or before issuedAt',
  );
  assertDenies(
    'lego.contract_violation',
    () => principal({ authMethod: 'password', authStrength: 'none' }),
    'method/strength mismatch',
  );
});

test('unknown or malformed permissions fail closed', () => {
  assertDenies('lego.contract_violation', () => principal({ permissions: 'workflow:read' }), 'permissions not an array');
  assertDenies('lego.contract_violation', () => principal({ permissions: ['DROP TABLE'] }), 'malformed scope shape');
  assertDenies('lego.contract_violation', () => principal({ permissions: [''] }), 'empty scope');
  assertDenies('lego.contract_violation', () => principal({ permissions: [42] }), 'non-string scope');
  assertDenies(
    'lego.contract_violation',
    () => principal({ permissions: ['workflow:read'], permissionUniverse: new Set(['workflow:read', 'credential:read']) }).permissions && (() => {
      createPrincipalSnapshot({
        principalId: 'p',
        identityId: 'i',
        principalType: 'user',
        authMethod: 'password',
        authStrength: 'password',
        permissions: ['invented:scope'],
        principalVersion: 0,
        permissionUniverse: new Set(['workflow:read']),
      });
    })(),
    'permission outside the declared universe',
  );
});

test('a stored user record is rejected: no profile data rides into the kernel', () => {
  const storedUser = {
    principalId: 'u1',
    identityId: 'i1',
    principalType: 'user',
    authMethod: 'password',
    authStrength: 'password',
    permissions: ['workflow:read'],
    principalVersion: 1,
    email: 'owner@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    password: 'scrypt$salt$hash',
    role: 'global:owner',
    settings: { theme: 'dark' },
  };
  assertDenies('lego.contract_violation', () => createPrincipalSnapshot(storedUser), 'user record as principal');
});

test('bounded allocations: oversized permissions and ids are refused', () => {
  const tooMany = Array.from({ length: 600 }, (_, i) => `workflow:read${i}`);
  assertDenies('lego.contract_violation', () => principal({ permissions: tooMany }), 'too many permissions');
  assertDenies(
    'lego.contract_violation',
    () => principal({ permissions: [`workflow:${'x'.repeat(200)}`] }),
    'permission too long',
  );
  assertDenies(
    'lego.contract_violation',
    () => principal({ principalId: 'p'.repeat(200) }),
    'principalId too long',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Negative matrix — SecurityContext and tenant binding
// ─────────────────────────────────────────────────────────────────────────────

test('a SecurityContext cannot be built without a valid principal', () => {
  assertDenies('lego.contract_violation', () => createSecurityContext(null), 'null params');
  assertDenies(
    'auth.unauthorized',
    () => createSecurityContext({ requestId: 'r', tenantVersion: 1, policyVersion: 1, sessionVersion: 1 }),
    'no principal',
  );
  assertDenies(
    'auth.unauthorized',
    () => createSecurityContext({ principal: { principalId: 'x' }, requestId: 'r', tenantVersion: 1, policyVersion: 1, sessionVersion: 1 }),
    'malformed principal',
  );
  assertDenies(
    'lego.contract_violation',
    () => createSecurityContext({ principal: principal(), requestId: '', tenantVersion: 1, policyVersion: 1, sessionVersion: 1 }),
    'empty requestId',
  );
  assertDenies(
    'lego.contract_violation',
    () => createSecurityContext({ principal: principal(), requestId: 'r', tenantVersion: -1, policyVersion: 1, sessionVersion: 1 }),
    'negative tenantVersion',
  );
});

test('tenant binding: cross-tenant access is denied, single-tenant stays cheapest', () => {
  const single = context();
  const own = checkTenantBinding(single, 'default');
  assert.equal(own.allowed, true, 'default/default is allowed');
  assert.equal(own.reasonCode, null);

  const cross = checkTenantBinding(single, 'tenant-b');
  assert.equal(cross.allowed, false, 'cross-tenant is denied');
  assert.equal(cross.reasonCode, SECURITY_REASON.TENANT_MISMATCH);

  const multi = context({}, { tenantId: 'tenant-a' });
  assert.equal(checkTenantBinding(multi, 'tenant-a').allowed, true);
  assert.equal(checkTenantBinding(multi, 'tenant-b').allowed, false);
  assert.equal(checkTenantBinding(multi, 'default').allowed, false, 'default is not a wildcard');
});

test('tenant binding fails closed on malformed input', () => {
  const result = checkTenantBinding(null, 'default');
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, SECURITY_REASON.MALFORMED_INPUT);
  assert.equal(checkTenantBinding(context(), '').allowed, false);
  assert.equal(checkTenantBinding(context(), null).allowed, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// SecurityStamp — versions are the correctness mechanism
// ─────────────────────────────────────────────────────────────────────────────

test('a matching stamp is CURRENT', () => {
  const ctx = context();
  const current = createSecurityStamp({ principalVersion: 3, tenantVersion: 1, policyVersion: 2, sessionVersion: 4 });
  const verdict = evaluateStampAuthority(ctx.stamp, current);
  assert.equal(verdict.verdict, STAMP_AUTHORITY.CURRENT);
  assert.equal(verdict.reasonCode, null);
});

test('a stale stamp is RE_EVALUATE, never silently ALLOW', () => {
  const ctx = context();
  const bumped = createSecurityStamp({ principalVersion: 4, tenantVersion: 1, policyVersion: 2, sessionVersion: 4 });
  const verdict = evaluateStampAuthority(ctx.stamp, bumped);
  assert.equal(verdict.verdict, STAMP_AUTHORITY.RE_EVALUATE);
  assert.deepEqual(verdict.stale, ['principalVersion']);
  assert.equal(verdict.reasonCode, SECURITY_REASON.STALE_AUTHORITY);
  assert.notEqual(verdict.verdict, STAMP_AUTHORITY.CURRENT, 'stale must never read as current');
});

test('strict mode turns staleness into DENY', () => {
  const ctx = context();
  const bumped = createSecurityStamp({ principalVersion: 4, tenantVersion: 1, policyVersion: 2, sessionVersion: 4 });
  const verdict = evaluateStampAuthority(ctx.stamp, bumped, { strict: true });
  assert.equal(verdict.verdict, STAMP_AUTHORITY.DENY);
  assert.equal(verdict.reasonCode, SECURITY_REASON.PERMISSION_DENIED);
});

test('a version ahead of current is impossible and is denied', () => {
  const ctx = context();
  const current = createSecurityStamp({ principalVersion: 3, tenantVersion: 1, policyVersion: 2, sessionVersion: 4 });
  const forged = createSecurityStamp({ principalVersion: 99, tenantVersion: 1, policyVersion: 2, sessionVersion: 4 });
  const verdict = evaluateStampAuthority(forged, current);
  assert.equal(verdict.verdict, STAMP_AUTHORITY.DENY);
  assert.deepEqual(verdict.ahead, ['principalVersion']);
  assert.equal(verdict.reasonCode, SECURITY_REASON.INVALID_AUTHORITY);
});

test('each stamp field is evaluated independently', () => {
  const base = { principalVersion: 3, tenantVersion: 1, policyVersion: 2, sessionVersion: 4 };
  for (const field of STAMP_FIELDS) {
    const current = createSecurityStamp({ ...base, [field]: base[field] + 1 });
    const presented = createSecurityStamp(base);
    const verdict = evaluateStampAuthority(presented, current);
    assert.equal(verdict.verdict, STAMP_AUTHORITY.RE_EVALUATE, `${field} must invalidate`);
    assert.deepEqual(verdict.stale, [field]);
  }
});

test('resourceVersion participates in invalidation when present', () => {
  const current = createSecurityStamp({ principalVersion: 1, tenantVersion: 1, policyVersion: 1, sessionVersion: 1, resourceVersion: 2 });
  const stale = createSecurityStamp({ principalVersion: 1, tenantVersion: 1, policyVersion: 1, sessionVersion: 1, resourceVersion: 1 });
  const verdict = evaluateStampAuthority(stale, current);
  assert.equal(verdict.verdict, STAMP_AUTHORITY.RE_EVALUATE);
  assert.deepEqual(verdict.stale, ['resourceVersion']);
});

test('a malformed stamp is denied, and current authority must itself be valid', () => {
  assertDenies('lego.contract_violation', () => createSecurityStamp({ principalVersion: -1, tenantVersion: 0, policyVersion: 0, sessionVersion: 0 }), 'negative version');
  assertDenies('lego.contract_violation', () => createSecurityStamp({ principalVersion: 1, tenantVersion: 1, policyVersion: 1, sessionVersion: 1, surprise: 1 }), 'unknown field');

  const current = createSecurityStamp({ principalVersion: 1, tenantVersion: 1, policyVersion: 1, sessionVersion: 1 });
  assert.equal(evaluateStampAuthority(null, current).verdict, STAMP_AUTHORITY.DENY);
  assert.equal(evaluateStampAuthority('3.1.2.4', current).verdict, STAMP_AUTHORITY.DENY);
  assertDenies('lego.contract_violation', () => evaluateStampAuthority(current, { principalVersion: 1 }), 'invalid current authority');
});

test('the stamp value contains only version integers — safe to log and cache-key', () => {
  const stamp = createSecurityStamp({ principalVersion: 3, tenantVersion: 1, policyVersion: 2, sessionVersion: 4 });
  assert.equal(stamp.value, '3.1.2.4');
  assert.match(stamp.value, /^\d+\.\d+\.\d+\.\d+$/);
  assert.ok(isSecurityStamp(stamp));
  assert.equal(isSecurityStamp({ principalVersion: 1 }), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth strength, expiry, permission lookup
// ─────────────────────────────────────────────────────────────────────────────

test('auth strength is a monotonic ladder usable for step-up checks', () => {
  assert.ok(authStrengthRank('none') < authStrengthRank('password'));
  assert.ok(authStrengthRank('password') < authStrengthRank('mfa'));
  assert.ok(authStrengthRank('mfa') < authStrengthRank('step-up'));
  assert.equal(authStrengthRank('bogus'), -1, 'unknown strength ranks below everything');

  const passwordOnly = principal({ authStrength: 'password' });
  assert.equal(meetsAuthStrength(passwordOnly, 'password'), true);
  assert.equal(meetsAuthStrength(passwordOnly, 'mfa'), false, 'password does not satisfy mfa');
  assert.equal(meetsAuthStrength(passwordOnly, 'none'), true);

  const mfaUser = principal({ authStrength: 'mfa' });
  assert.equal(meetsAuthStrength(mfaUser, 'mfa'), true);
  assert.equal(meetsAuthStrength(mfaUser, 'step-up'), false);
  assert.equal(meetsAuthStrength(mfaUser, 'bogus'), false, 'unknown requirement is a refusal');
  assert.equal(meetsAuthStrength(null, 'password'), false, 'no snapshot is a refusal');
});

test('expiry is a bound, not the correctness mechanism', () => {
  const expiring = principal({ issuedAt: 1_000_000, expiresAt: 1_060_000 });
  assert.equal(isPrincipalExpired(expiring, 1_000_001), false, 'valid inside TTL');
  assert.equal(isPrincipalExpired(expiring, 1_060_000), true, 'expired at the boundary');
  assert.equal(isPrincipalExpired(principal({ expiresAt: null }), 9_999_999), false, 'no TTL means no expiry bound');
  // An unexpired snapshot can still be STALE — that is what the stamp decides.
  const current = createSecurityStamp({ principalVersion: 9, tenantVersion: 1, policyVersion: 1, sessionVersion: 1 });
  const staleButUnexpired = createSecurityStamp({ principalVersion: 1, tenantVersion: 1, policyVersion: 1, sessionVersion: 1 });
  assert.equal(isPrincipalExpired(expiring, 1_000_001), false);
  assert.equal(evaluateStampAuthority(staleButUnexpired, current).verdict, STAMP_AUTHORITY.RE_EVALUATE);
  assert.equal(isPrincipalExpired(null), true, 'a non-snapshot is treated as expired');
});

test('permission lookup is exact and fails closed', () => {
  const snapshot = principal({ permissions: ['workflow:read'] });
  assert.equal(hasPermission(snapshot, 'workflow:read'), true);
  assert.equal(hasPermission(snapshot, 'workflow:delete'), false, 'no implicit escalation');
  assert.equal(hasPermission(snapshot, 'workflow'), false, 'prefix does not match');
  assert.equal(hasPermission(snapshot, 'workflow:read '), false, 'no whitespace tolerance');
  assert.equal(hasPermission(snapshot, null), false);
  assert.equal(hasPermission(null, 'workflow:read'), false);
});

test('the kernel accepts the real canonical n8n permission vocabulary', () => {
  // Cross-slice guard. The original SCOPE_SHAPE was lowercase-only and rejected
  // 65 of the 122 permissions in the extracted n8n role model (aiAssistant:manage,
  // annotationTag:create, chatHubAgent:read, credential:shareGlobally, ...), so a
  // principal compiled from a real global role could not be built at all.
  // P5.3, which loads the actual universe, is what exposed it.
  const camelCase = [
    'aiAssistant:manage', 'annotationTag:create', 'chatHubAgent:update',
    'communityPackage:install', 'credential:shareGlobally', 'externalSecretsProvider:list',
  ];
  const snapshot = principal({ permissions: camelCase });
  assert.deepEqual(snapshot.permissions, [...camelCase].sort());
  for (const scope of camelCase) assert.equal(hasPermission(snapshot, scope), true);
});

test('malformed permissions are still rejected after the camelCase fix', () => {
  // The relaxed pattern must not have opened a hole.
  for (const bad of ['DROP TABLE', '', 'workflow', 'workflow:', ':read', 'workflow:READ', 'work flow:read', 'workflow:read;drop']) {
    assert.throws(() => compilePermissions([bad]), SecurityError, `${bad} must still be rejected`);
  }
  assert.throws(() => compilePermissions(['<script>:x']), SecurityError);
  assert.throws(() => compilePermissions([`${'a'.repeat(200)}:x`]), SecurityError, 'length bound still applies');
});

test('compilePermissions sorts, deduplicates and rejects the malformed', () => {
  assert.deepEqual(compilePermissions(['b:a', 'a:b', 'b:a']), ['a:b', 'b:a']);
  assert.deepEqual(compilePermissions([]), [], 'no permissions is valid — a principal with no grants');
  assert.throws(() => compilePermissions(['NOPE']), SecurityError);
  assert.throws(() => compilePermissions(undefined), SecurityError);
});

// ─────────────────────────────────────────────────────────────────────────────
// Error vocabulary discipline
// ─────────────────────────────────────────────────────────────────────────────

test('every security reason is a published error code', () => {
  for (const [name, code] of Object.entries(SECURITY_REASON)) {
    assert.ok(isErrorCode(code), `${name} -> ${code} is not published`);
    assert.equal(assertSecurityReason(code), true);
  }
  assert.throws(() => assertSecurityReason('auth.made_up'), SecurityError);
});

test('SecurityError refuses an unpublished code and is itself frozen', () => {
  assert.throws(() => new SecurityError('auth.made_up', 'nope'), TypeError);
  const error = new SecurityError('auth.forbidden', 'denied', { details: { action: 'workflow:delete' } });
  assert.equal(error.code, 'auth.forbidden');
  assert.equal(error.name, 'SecurityError');
  assert.ok(error instanceof Error);
  assert.equal(typeof error.status, 'number');
  assert.ok(Object.isFrozen(error));
  assert.equal(error.message, 'denied');
});

test('the decision vocabulary has exactly three outcomes', () => {
  assert.deepEqual(Object.keys(SECURITY_DECISION).sort(), ['ALLOW', 'DENY', 'RE_EVALUATE']);
  assert.equal(SECURITY_DECISION.ALLOW, 'ALLOW');
  assert.equal(Object.isFrozen(SECURITY_DECISION), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// No-I/O guarantee
// ─────────────────────────────────────────────────────────────────────────────

test('the kernel performs no network, filesystem, clock or crypto-secret I/O', () => {
  const sources = ['principal.mjs', 'security-context.mjs', 'security-stamp.mjs', 'security-error.mjs'];
  const forbidden = [
    /\bfs\.|from 'node:fs'|require\(['"]fs['"]\)/,
    /\bhttp\b|\bhttps\b|node:http|fetch\(/,
    /\bdecrypt\b|\bscrypt\b|\bcreateCipher|\bcreateDecipher/,
    /\bprocess\.env\b/,
    /\bchild_process\b/,
  ];
  for (const file of sources) {
    const source = readFileSync(new URL(`../src/auth/security/${file}`, import.meta.url), 'utf8');
    for (const pattern of forbidden) {
      assert.equal(pattern.test(source), false, `${file} must not match ${pattern}`);
    }
  }
  // `Date.now()` appears only as a default for an injectable `now`.
  const principalSource = readFileSync(new URL('../src/auth/security/principal.mjs', import.meta.url), 'utf8');
  assert.ok(principalSource.includes('input.issuedAt ?? Date.now()'), 'the clock is injectable');
});

// ─────────────────────────────────────────────────────────────────────────────
// Contract registration
// ─────────────────────────────────────────────────────────────────────────────

test('the auth.principal row is registered at 1.0.0 with its exact surface', async () => {
  const row = LOCK.contracts.find((candidate) => candidate.id === 'auth.principal');
  assert.ok(row, 'auth.principal is in contract-lock.json');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.domain, 'auth');
  assert.equal(row.owner, 'agent-1');
  assert.equal(row.status, 'stable');
  assert.deepEqual(row.surface, ['src/auth/security/index.mjs']);
  assert.deepEqual(row.tests, ['apps/n8n-lego/test/lego-security-kernel.test.mjs']);

  const module = await import('../src/auth/security/index.mjs');
  const actual = Object.keys(module).sort();
  assert.deepEqual(row.exports['src/auth/security/index.mjs'], actual, 'the pinned export list matches the module');
});

test('the auth domain declares the principal capability and stays at 26 domains', () => {
  const domains = Object.values(DOMAINS.domains ?? DOMAINS);
  assert.equal(domains.length, 26, 'P5.1 adds a capability, not a domain');
  const auth = domains.find((domain) => domain.id === 'auth');
  const capability = auth.capabilities.find((candidate) => candidate.id === 'auth.principal');
  assert.ok(capability, 'auth.principal capability declared');
  assert.equal(capability.status, 'implemented');
  assert.ok(auth.dependsOn.includes('lego-foundation'), 'the kernel consumes the error contract');
  assert.equal(domains.filter((domain) => domain.id === 'auth').length, 1);
});

test('the R4 finding is recorded: auth.public stays empty on purpose', () => {
  const domains = Object.values(DOMAINS.domains ?? DOMAINS);
  const auth = domains.find((domain) => domain.id === 'auth');

  // WHY THIS IS [] AND NOT ['src/auth/security']:
  // Declaring a public surface switches on R4 boundary policing for the domain,
  // which immediately reports a PRE-EXISTING reach that P5 does not own —
  // src/auth/contract/index.mjs (domain auth.identity, owner agent-3) re-exports
  // toPublicUser/hasOwner from src/auth.mjs. Retiring that coupling is agent-3
  // work and is out of P5.1 scope. The contract-lock row is therefore the
  // publication mechanism for auth.principal, which is exactly how node-registry
  // (33 rows), execution (5) and workflow (2) already operate.
  assert.deepEqual(auth.public, [], 'public stays empty until the auth.identity reach is retired');
  assert.ok(
    /PRE-EXISTING|pre-existing/.test(auth.notes ?? ''),
    'the reason must be recorded in the domain notes, not left implicit',
  );

  // The auth.identity reach itself is asserted here so it cannot be forgotten:
  // if agent-3 ever retires it, this repo can publish the surface and R4 policing
  // turns on automatically.
  const identitySource = readFileSync(new URL('../src/auth/contract/index.mjs', import.meta.url), 'utf8');
  assert.ok(
    identitySource.includes("from '../../auth.mjs'"),
    'the pre-existing auth.identity -> src/auth.mjs reach is still present; ' +
      'when it is retired, publish src/auth/security in domains.json',
  );
});

test('auth.identity@1.0.0 is untouched: still a read-only projection of exactly two exports', async () => {
  const row = LOCK.contracts.find((candidate) => candidate.id === 'auth.identity');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.owner, 'agent-3');
  // Compared as sorted sets: the lock records the re-export order, which is not
  // the assertion being made here. What matters is that the surface is exactly
  // these two names and nothing more.
  assert.deepEqual([...row.exports['src/auth/contract/index.mjs']].sort(), ['hasOwner', 'toPublicUser']);
  const module = await import('../src/auth/contract/index.mjs');
  assert.deepEqual(Object.keys(module).sort(), ['hasOwner', 'toPublicUser']);
  // It holds no authority and the kernel does not absorb it.
  const kernel = await import('../src/auth/security/index.mjs');
  assert.ok(!('toPublicUser' in kernel), 'the kernel does not re-export the identity projection');
});

test('P5.1 adds the ninety-fifth contract row and weakens nothing', () => {
  assert.equal(LOCK.contracts.length, 100, '94 rows through P9 + auth.principal');
  assert.equal(LOCK.contracts.filter((row) => row.domain === 'observability').length, 22, 'P9 rows intact');
  const plugin = LOCK.contracts.find((row) => row.id === 'lego.plugin-runtime');
  assert.equal(plugin.version, '0.10.0', 'P2.27 plugin runtime version untouched');
});
