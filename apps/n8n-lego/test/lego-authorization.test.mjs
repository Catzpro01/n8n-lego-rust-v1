/**
 * P5.3 — Authorization engine tests.
 *
 * PUBLIC CONTRACT (`auth.authorization`, v1.0.0): default-deny evaluation, the
 * canonical permission universe, and the versioned decision cache.
 *
 * The negative matrix carries this file. Every denial below is a case an
 * attacker would try, and several of them (unknown permission, cross-tenant,
 * approval mismatch, stale cache) are cases that a naive implementation would
 * let through as an inert no-op or a stale allow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CACHE_POLICY,
  DECISION,
  authorize,
  authorizeCached,
  cacheKeyFor,
  createDecisionCache,
} from '../src/auth/security/authorization.mjs';
import { createPermissionRegistry, permissionRegistryFor } from '../src/auth/security/permission-registry.mjs';
import { createPrincipalSnapshot, hasPermission } from '../src/auth/security/principal.mjs';
import { createSecurityStamp } from '../src/auth/security/security-stamp.mjs';
import { STAMP_AUTHORITY, evaluateStampAuthority, isStampCurrent } from '../src/auth/security/security-stamp.mjs';
import { SECURITY_REASON } from '../src/auth/security/index.mjs';
import { isErrorCode } from '../src/lego/errors.mjs';

const LOCK = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
const DOMAINS = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url), 'utf8'));

/** The canonical universe, loaded from the extracted n8n role model. */
const REGISTRY = permissionRegistryFor({ catalogDir: '/nonexistent' });

function principal(overrides = {}) {
  return createPrincipalSnapshot({
    principalId: 'principal-1',
    identityId: 'identity-1',
    tenantId: 'default',
    principalType: 'user',
    authMethod: 'password',
    authStrength: 'password',
    permissions: ['workflow:read', 'workflow:update', 'credential:read'],
    principalVersion: 2,
    ...overrides,
  });
}

/** The four authority versions, without the derived `value` (createSecurityStamp rejects unknown fields). */
const VERSIONS = Object.freeze({ principalVersion: 2, tenantVersion: 1, policyVersion: 3, sessionVersion: 4 });
const STAMP = createSecurityStamp(VERSIONS);
/** A stamp with one or more versions advanced. */
const bumped = (overrides) => createSecurityStamp({ ...VERSIONS, ...overrides });

/** authorize() with the canonical registry wired in. */
function check(request) {
  return authorize({ principal: principal(), ...request }, { registry: REGISTRY });
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

test('a principal holding the scope is allowed', () => {
  const d = check({ action: 'workflow:read', resourceType: 'workflow', resourceId: 'wf-1' });
  assert.equal(d.allowed, true);
  assert.equal(d.decision, DECISION.ALLOW);
  assert.equal(d.reasonCode, null);
});

test('the decision is frozen and carries no credential material', () => {
  const d = check({ action: 'workflow:read' });
  assert.ok(Object.isFrozen(d));
  for (const key of ['password', 'secret', 'token', 'credentialData', 'apiKey']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(d, key), `decision must not carry ${key}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Default deny
// ─────────────────────────────────────────────────────────────────────────────

test('a missing scope is denied', () => {
  const d = check({ action: 'workflow:delete' });
  assert.equal(d.allowed, false);
  assert.equal(d.reasonCode, SECURITY_REASON.PERMISSION_DENIED);
  assert.ok(isErrorCode(d.reasonCode));
});

test('a malformed or absent request is denied, never defaulted', () => {
  for (const bad of [null, undefined, 'nope', 42]) {
    const d = authorize(bad, { registry: REGISTRY });
    assert.equal(d.allowed, false, `${JSON.stringify(bad)} must be denied`);
    assert.equal(d.reasonCode, SECURITY_REASON.MALFORMED_INPUT);
  }
});

test('there is no principal, no authorization: authentication grants nothing', () => {
  for (const bad of [null, undefined, {}, { principalId: 'x' }]) {
    const d = authorize({ principal: bad, action: 'workflow:read' }, { registry: REGISTRY });
    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, SECURITY_REASON.NO_PRINCIPAL, `${JSON.stringify(bad)} -> NO_PRINCIPAL`);
  }
});

test('an empty or non-string action is denied', () => {
  for (const bad of [undefined, '', null, 7]) {
    assert.equal(check({ action: bad }).allowed, false);
  }
});

test('an expired principal is denied', () => {
  const expiring = principal({ expiresAt: 5_000, issuedAt: 1_000 });
  const opts = { registry: REGISTRY };
  assert.equal(authorize({ principal: expiring, action: 'workflow:read', now: 4_999 }, opts).allowed, true);
  const d = authorize({ principal: expiring, action: 'workflow:read', now: 5_000 }, opts);
  assert.equal(d.allowed, false);
  assert.equal(d.reasonCode, SECURITY_REASON.SESSION_INVALID);
});

// ─────────────────────────────────────────────────────────────────────────────
// CRITICAL: unknown permission fails closed
// ─────────────────────────────────────────────────────────────────────────────

test('an unknown permission is DENIED, not treated as an inert no-op', () => {
  // This is the P5.3 critical invariant. A typo'd scope must not quietly grant
  // nothing while looking like it should work.
  const d = check({ action: 'workflow:reed' });
  assert.equal(d.allowed, false);
  assert.equal(d.reasonCode, SECURITY_REASON.UNKNOWN_PERMISSION);
  assert.equal(d.details.unknownPermission, true);
});

test('unknown-permission denial is reported distinctly from a routine denial', () => {
  const unknown = check({ action: 'workflow:reed' });
  const missing = check({ action: 'workflow:delete' });
  assert.equal(unknown.details.unknownPermission, true);
  assert.equal(missing.details.unknownPermission, undefined, 'a real-but-unheld scope is not "unknown"');
  assert.equal(unknown.reasonCode, missing.reasonCode, 'both deny on the same published code');
});

test('every reason the engine emits is a published error code', () => {
  const cases = [
    { action: 'workflow:read' },
    { action: 'workflow:delete' },
    { action: 'workflow:reed' },
    { action: 'workflow:read', resourceTenantId: 'other' },
    { action: 'workflow:read', capability: 'net.fetch' },
    { action: 'workflow:read', requiredAuthStrength: 'mfa' },
    { action: 'workflow:read', approval: { granted: false } },
  ];
  for (const c of cases) {
    const d = check(c);
    if (d.reasonCode !== null) assert.ok(isErrorCode(d.reasonCode), `${JSON.stringify(c)} -> ${d.reasonCode}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Tenant boundary
// ─────────────────────────────────────────────────────────────────────────────

test('a cross-tenant resource is denied', () => {
  const d = check({ action: 'workflow:read', resourceTenantId: 'tenant-b' });
  assert.equal(d.allowed, false);
  assert.equal(d.reasonCode, SECURITY_REASON.TENANT_MISMATCH);
});

test('default is not a wildcard', () => {
  const multi = principal({ tenantId: 'tenant-a' });
  const opts = { registry: REGISTRY };
  assert.equal(authorize({ principal: multi, action: 'workflow:read' }, opts).allowed, true, 'no resource tenant = ok');
  assert.equal(
    authorize({ principal: multi, action: 'workflow:read', resourceTenantId: 'default' }, opts).allowed,
    false,
    'a tenant-a principal cannot read a default-tenant resource',
  );
  assert.equal(
    authorize({ principal: multi, action: 'workflow:read', resourceTenantId: 'tenant-a' }, opts).allowed,
    true,
  );
});

test('same-tenant access is allowed for both single- and multi-tenant', () => {
  assert.equal(check({ action: 'workflow:read', resourceTenantId: 'default' }).allowed, true);
  const multi = principal({ tenantId: 'tenant-a' });
  assert.equal(
    authorize({ principal: multi, action: 'workflow:read', resourceTenantId: 'tenant-a' }, { registry: REGISTRY }).allowed,
    true,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Capability and step-up
// ─────────────────────────────────────────────────────────────────────────────

test('capability is a separate axis: holding the scope does not grant it', () => {
  assert.equal(check({ action: 'workflow:read', capability: 'net.fetch', capabilityGrants: [] }).allowed, false);
  assert.equal(
    check({ action: 'workflow:read', capability: 'net.fetch', capabilityGrants: ['net.fetch'] }).allowed,
    true,
  );
  assert.equal(
    check({ action: 'workflow:read', capability: 'net.fetch', capabilityGrants: ['fs.read'] }).reasonCode,
    SECURITY_REASON.CAPABILITY_UNAVAILABLE,
  );
});

test('step-up is enforced as an input constraint', () => {
  assert.equal(check({ action: 'workflow:read', requiredAuthStrength: 'password' }).allowed, true);
  const d = check({ action: 'workflow:read', requiredAuthStrength: 'mfa' });
  assert.equal(d.allowed, false);
  assert.equal(d.details.reason, 'auth-strength-insufficient');

  const strong = principal({ authMethod: 'mfa', authStrength: 'mfa' });
  assert.equal(
    authorize({ principal: strong, action: 'workflow:read', requiredAuthStrength: 'mfa' }, { registry: REGISTRY }).allowed,
    true,
  );
});

test('an unknown required strength is a refusal, not a pass', () => {
  assert.equal(check({ action: 'workflow:read', requiredAuthStrength: 'vibes' }).allowed, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Approval — confused deputy
// ─────────────────────────────────────────────────────────────────────────────

test('approval must cover this exact action and resource', () => {
  assert.equal(check({ action: 'workflow:read', approval: { granted: true, action: 'workflow:read' } }).allowed, true);
  const wrongAction = check({ action: 'workflow:read', approval: { granted: true, action: 'workflow:delete' } });
  assert.equal(wrongAction.allowed, false);
  assert.equal(wrongAction.details.reason, 'action-mismatch');

  const wrongResource = check({
    action: 'workflow:read',
    resourceId: 'wf-1',
    approval: { granted: true, action: 'workflow:read', resourceId: 'wf-2' },
  });
  assert.equal(wrongResource.allowed, false);
  assert.equal(wrongResource.details.reason, 'resource-mismatch');
});

test('an expired or absent approval is denied', () => {
  const expired = check({
    action: 'workflow:read',
    approval: { granted: true, action: 'workflow:read', expiresAt: Date.now() - 1 },
  });
  assert.equal(expired.allowed, false);
  assert.equal(expired.details.reason, 'expired');

  for (const bad of [{ granted: false }, null, undefined, {}]) {
    const d = check({ action: 'workflow:read', approval: bad });
    // undefined/null mean "not required" — only an explicitly false/absent grant denies.
    if (bad === null || bad === undefined) {
      assert.equal(d.allowed, true, 'no approval requirement means no approval needed');
    } else {
      assert.equal(d.allowed, false, JSON.stringify(bad));
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Versioned decision cache
// ─────────────────────────────────────────────────────────────────────────────

test('a repeated decision is served from cache, and marked as cached', () => {
  const cache = createDecisionCache();
  const req = { principal: principal(), action: 'workflow:read', resourceId: 'wf-1' };
  const opts = { currentStamp: STAMP, registry: REGISTRY };
  assert.equal(authorizeCached(cache, req, opts).cached, false, 'first call evaluates');
  const second = authorizeCached(cache, req, opts);
  assert.equal(second.cached, true);
  assert.equal(second.allowed, true);
});

test('STALE CACHE NEVER GRANTS AUTHORITY — the central cache invariant', () => {
  const cache = createDecisionCache();
  const req = { principal: principal(), action: 'workflow:read', resourceId: 'wf-1' };
  authorizeCached(cache, req, { currentStamp: STAMP, registry: REGISTRY });
  assert.equal(cache.size(), 1);

  // Authority moves on: the principal's role changed, a policy was bumped...
  for (const field of ['principalVersion', 'tenantVersion', 'policyVersion', 'sessionVersion']) {
    const fresh = createDecisionCache();
    authorizeCached(fresh, req, { currentStamp: STAMP, registry: REGISTRY });
    const after = authorizeCached(fresh, req, { currentStamp: bumped({ [field]: VERSIONS[field] + 1 }), registry: REGISTRY });
    assert.equal(after.cached, false, `a bumped ${field} must defeat the cache`);
    assert.equal(fresh.size(), 1, 'the stale entry is dropped, not left to serve later');
  }
});

test('a cached ALLOW is dropped the moment authority advances', () => {
  // The dangerous direction: something was allowed, then authority was revoked.
  const cache = createDecisionCache();
  const req = { principal: principal(), action: 'workflow:read', resourceId: 'wf-1' };
  const before = authorizeCached(cache, req, { currentStamp: STAMP, registry: REGISTRY });
  assert.equal(before.allowed, true);

  const revoked = bumped({ policyVersion: VERSIONS.policyVersion + 1 });
  const after = authorizeCached(cache, req, { currentStamp: revoked, registry: REGISTRY });
  assert.equal(after.cached, false, 'must re-evaluate, not serve the old allow');
});

test('the cache refuses to serve when it cannot validate authority', () => {
  const cache = createDecisionCache();
  const req = { principal: principal(), action: 'workflow:read' };
  authorizeCached(cache, req, { currentStamp: STAMP, registry: REGISTRY });
  const unstampable = cache.get(cacheKeyFor(req), { principalVersion: 1 });
  assert.equal(unstampable.hit, false);
  assert.equal(unstampable.reason, 'unstampable');
  assert.equal(cache.size(), 0, 'the unvalidatable entry is dropped');
});

test('the cache is bounded', () => {
  const cache = createDecisionCache({ ...CACHE_POLICY, maxEntries: 64, evictBatch: 8 });
  for (let i = 0; i < 5_000; i += 1) cache.set(`key-${i}`, { allowed: true }, STAMP);
  assert.ok(cache.size() <= 64, `cache held ${cache.size()} entries, expected <= 64`);
});

test('invalidate drops only entries that are no longer current', () => {
  const cache = createDecisionCache();
  const stale = createSecurityStamp({ principalVersion: 1, tenantVersion: 1, policyVersion: 1, sessionVersion: 1 });
  const current = createSecurityStamp({ principalVersion: 9, tenantVersion: 1, policyVersion: 1, sessionVersion: 1 });
  cache.set('stale', { allowed: true }, stale);
  cache.set('current', { allowed: true }, current);
  assert.equal(cache.invalidate(current), 1);
  assert.equal(cache.size(), 1);
  assert.equal(cache.get('current', current).hit, true);
});

test('cacheKeyFor is stable across time and varies with every deciding field', () => {
  const base = { principal: principal(), action: 'workflow:read', resourceId: 'wf-1' };
  assert.equal(cacheKeyFor(base), cacheKeyFor({ ...base, now: 123 }), 'now is not part of the key');
  assert.notEqual(cacheKeyFor(base), cacheKeyFor({ ...base, resourceId: 'wf-2' }));
  assert.notEqual(cacheKeyFor(base), cacheKeyFor({ ...base, action: 'workflow:update' }));
  assert.notEqual(cacheKeyFor(base), cacheKeyFor({ ...base, resourceTenantId: 'tenant-b' }));
  assert.notEqual(
    cacheKeyFor(base),
    cacheKeyFor({ ...base, approval: { granted: true } }),
    'an approval changes the answer, so it changes the key',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Permission registry — canonical universe
// ─────────────────────────────────────────────────────────────────────────────

test('every canonical permission can be held and authorized — no scope is unrepresentable', () => {
  // The strongest form of the camelCase regression: the FULL extracted universe
  // must round-trip through PrincipalSnapshot and authorize() without a single
  // rejection. If any scope in the real vocabulary cannot be represented, a real
  // role cannot be compiled into a principal.
  const owner = createPrincipalSnapshot({
    principalId: 'owner', identityId: 'i', tenantId: 'default', principalType: 'user',
    authMethod: 'password', authStrength: 'password',
    permissions: REGISTRY.permissions, principalVersion: 1,
  });
  assert.equal(owner.permissions.length, REGISTRY.size, 'the whole universe survived compilation');
  for (const scope of REGISTRY.permissions) {
    assert.equal(hasPermission(owner, scope), true, `${scope} must be held`);
    const d = authorize({ principal: owner, action: scope }, { registry: REGISTRY });
    assert.equal(d.allowed, true, `${scope} must authorize`);
  }
});

test('the universe is derived from the extracted n8n role model, not declared here', () => {
  assert.ok(REGISTRY.size > 50, `expected the full extracted vocabulary, got ${REGISTRY.size}`);
  assert.ok(REGISTRY.has('workflow:read'));
  assert.ok(REGISTRY.has('credential:read'));
  assert.ok(REGISTRY.has('user:list'));
  assert.equal(REGISTRY.has('invented:scope'), false);
  // Sorted and dense: id i maps to permission[i].
  REGISTRY.permissions.forEach((name, index) => {
    assert.equal(REGISTRY.idOf(name), index);
    assert.equal(REGISTRY.nameOf(index), name);
  });
});

test('compile reports unknown permissions instead of silently dropping them', () => {
  const result = REGISTRY.compile(['workflow:read', 'workflow:reed', 'workflow:read']);
  assert.equal(result.unknown.length, 1);
  assert.equal(result.unknown[0], 'workflow:reed');
  assert.equal(result.ids.length, 1, 'the known permission compiled, deduplicated');
  assert.equal(REGISTRY.compile([]).unknown.length, 0, 'no permissions is valid');
});

test('an empty role model is refused rather than becoming a deny-everything universe', () => {
  assert.throws(() => createPermissionRegistry({ global: [], project: [], credential: [], workflow: [] }), /no scopes/);
  assert.throws(() => createPermissionRegistry(null), TypeError);
});

test('the registry is memoised per role model and rebuilds when it changes', () => {
  const config = { catalogDir: '/nonexistent' };
  assert.equal(permissionRegistryFor(config), permissionRegistryFor(config), 'same model -> same registry');
});

// ─────────────────────────────────────────────────────────────────────────────
// No-I/O guarantee
// ─────────────────────────────────────────────────────────────────────────────

test('the authorization engine performs no network, filesystem or credential I/O', () => {
  const forbidden = [
    /\bfetch\(|node:http|\bhttps?\.\get\b/,
    /\bfs\.|from 'node:fs'/,
    /\bdecrypt\b|\bscrypt\b|\bcreateDecipher/,
    /\bchild_process\b/,
    /\bprocess\.env\b/,
  ];
  for (const file of ['authorization.mjs', 'permission-registry.mjs']) {
    const src = readFileSync(new URL(`../src/auth/security/${file}`, import.meta.url), 'utf8');
    for (const pattern of forbidden) {
      assert.equal(pattern.test(src), false, `${file} must not match ${pattern}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Contract registration
// ─────────────────────────────────────────────────────────────────────────────

test('auth.authorization is registered at 1.0.0 with an exact surface', async () => {
  const row = LOCK.contracts.find((c) => c.id === 'auth.authorization');
  assert.ok(row, 'auth.authorization is in contract-lock.json');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.domain, 'auth');
  assert.equal(row.status, 'stable');
  assert.deepEqual(row.surface, [
    'src/auth/security/authorization.mjs',
    'src/auth/security/permission-registry.mjs',
  ]);
  assert.deepEqual(row.tests, ['apps/n8n-lego/test/lego-authorization.test.mjs']);

  const auth = await import('../src/auth/security/authorization.mjs');
  const reg = await import('../src/auth/security/permission-registry.mjs');
  assert.deepEqual([...row.exports['src/auth/security/authorization.mjs']].sort(), Object.keys(auth).sort());
  assert.deepEqual([...row.exports['src/auth/security/permission-registry.mjs']].sort(), Object.keys(reg).sort());
});

test('the auth domain declares the authorization capability and stays at 26 domains', () => {
  const domains = Object.values(DOMAINS.domains ?? DOMAINS);
  assert.equal(domains.length, 26, 'P5.3 adds contracts and capabilities, not domains');
  const auth = domains.find((d) => d.id === 'auth');
  assert.ok(auth.capabilities.some((c) => c.id === 'auth.authorization'), 'authorization capability declared');
});

test('P5.3 adds the ninety-seventh row and preserves every earlier phase', () => {
  assert.equal(LOCK.contracts.length, 100, '96 through P5.2 + auth.authorization');
  assert.equal(LOCK.contracts.filter((r) => r.domain === 'observability').length, 22, 'P9 intact');
  const byId = Object.fromEntries(LOCK.contracts.map((r) => [r.id, r.version]));
  assert.equal(byId['auth.principal'], '1.0.0', 'P5.1 intact');
  assert.equal(byId['auth.session'], '1.0.0', 'P5.2 intact');
  assert.equal(byId['auth.identity'], '1.0.0', 'untouched, owner agent-3');
  assert.equal(byId['lego.plugin-runtime'], '0.10.0', 'P2.27 intact');
  assert.equal(new Set(LOCK.contracts.map((r) => r.id)).size, LOCK.contracts.length, 'no duplicate ids');
});

test('isStampCurrent agrees with evaluateStampAuthority over a full input matrix', () => {
  // This is the test that makes the hand-unrolled fast path safe to keep.
  // `isStampCurrent` was written out longhand purely for speed (dynamic
  // `value[field]` loads cost 260 ns vs 5 ns); it must therefore be proved
  // equivalent to the rich verdict it replaces, not merely assumed so.
  const base = { principalVersion: 1, tenantVersion: 1, policyVersion: 1, sessionVersion: 1 };
  const current = createSecurityStamp({ ...base });
  const currentWithResource = createSecurityStamp({ ...base, resourceVersion: 7 });

  const presentedStamps = [
    current,
    createSecurityStamp({ ...base, principalVersion: 2 }),
    createSecurityStamp({ ...base, principalVersion: 0 }),
    createSecurityStamp({ ...base, tenantVersion: 9 }),
    createSecurityStamp({ ...base, policyVersion: 4 }),
    createSecurityStamp({ ...base, sessionVersion: 3 }),
    createSecurityStamp({ ...base, principalVersion: 2, tenantVersion: 2, policyVersion: 2, sessionVersion: 2 }),
    createSecurityStamp({ ...base, resourceVersion: 7 }),
    createSecurityStamp({ ...base, resourceVersion: 8 }),
    currentWithResource,
  ];
  const currentStamps = [current, currentWithResource];

  // Non-stamp garbage must fail closed in BOTH functions, never throw.
  const garbage = [null, undefined, 'stamp', 42, {}, [], { principalVersion: -1, tenantVersion: 1, policyVersion: 1, sessionVersion: 1 }, { principalVersion: 1.5, tenantVersion: 1, policyVersion: 1, sessionVersion: 1 }];

  let compared = 0;
  for (const authority of currentStamps) {
    for (const presented of presentedStamps) {
      const rich = evaluateStampAuthority(presented, authority).verdict === STAMP_AUTHORITY.CURRENT;
      const fast = isStampCurrent(presented, authority);
      assert.equal(fast, rich, `disagreement: presented=${JSON.stringify(presented)} authority=${JSON.stringify(authority)}`);
      compared += 1;
    }
  }
  // Garbage as `presented`: both must say false, and neither may throw.
  for (const g of garbage) {
    assert.equal(isStampCurrent(g, current), false, `garbage presented must fail closed: ${JSON.stringify(g)}`);
    const richVerdict = evaluateStampAuthority(g, current).verdict;
    assert.notEqual(richVerdict, STAMP_AUTHORITY.CURRENT, `garbage must not be CURRENT: ${JSON.stringify(g)}`);
    compared += 1;
    // Garbage as `current` (the authority side) must also fail closed.
    assert.equal(isStampCurrent(current, g), false, `garbage authority must fail closed: ${JSON.stringify(g)}`);
    compared += 1;
  }
  assert.ok(compared >= 30, `matrix too small: ${compared}`);
});
