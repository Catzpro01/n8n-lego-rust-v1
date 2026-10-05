/**
 * P5.7 (#220) — API keys, service principals, tenant security policy and agent
 * identity.
 *
 * Acceptance (Issue #220), each mapped to a describe block below:
 *   - revoked / expired key denied;
 *   - key scope escalation denied;
 *   - service principal cannot cross the tenant boundary;
 *   - delegation attenuation is enforced;
 *   - sensitive agent actions can require explicit approval without P5 becoming
 *     the approval engine (the manager-owned ai.approval foundation decides);
 *   - audit events contain references/reasons only.
 *
 * Layers: extracted vocabulary (differential against the pinned n8n source),
 * pure primitives, the authority chain wired to the REAL ai.approval
 * foundation, the real /rest/api-keys handlers over node:http, and the real
 * server with file storage across a restart.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { startServer } from '../src/server.mjs';
import { createStore } from '../src/store.mjs';
import { createRouter } from '../src/compat/route.mjs';
import { HttpError } from '../src/compat/error.mjs';
import { readBody, sendError } from '../src/compat/response.mjs';
import { authRoutes } from '../src/auth/routes.mjs';
import { createOwner, currentUser, securityVersionFor } from '../src/auth.mjs';
import { loadRoles } from '../src/compat/scopes.mjs';
import { apiKeyScopesForRole, loadApiKeyScopes } from '../src/compat/api-key-scopes.mjs';
import { authorize, DECISION } from '../src/auth/security/authorization.mjs';
import { createPermissionRegistry } from '../src/auth/security/permission-registry.mjs';
import { createPrincipalSnapshot } from '../src/auth/security/principal.mjs';
import { SECURITY_REASON } from '../src/auth/security/security-error.mjs';
import { evaluateStepUp } from '../src/auth/security/step-up.mjs';
import {
  API_KEY_AUDIENCE,
  API_KEY_POLICY,
  API_KEY_PREFIX,
  API_KEY_VERDICT,
  apiKeyMatches,
  apiKeyVerdict,
  attenuateScopes,
  effectiveScopes,
  generateApiKey,
  lastUsedIsStale,
  parseApiKey,
  pruneTombstones,
  redactApiKey,
  revokeWithTombstone,
} from '../src/auth/security/api-key.mjs';
import {
  DEFAULT_TENANT_SECURITY_POLICY,
  MACHINE_AUDIT_EVENTS,
  MACHINE_IDENTITY_LIMITS,
  MACHINE_OUTCOME,
  SERVICE_PRINCIPAL_KINDS,
  createServicePrincipalRecord,
  createTenantSecurityPolicy,
  decideMachineAction,
  delegate,
  keyPolicyViolation,
  machineAuditEvent,
  machinePrincipal,
} from '../src/auth/security/machine-identity.mjs';
import {
  MISSING_SCOPE_MESSAGE,
  apiKeyPermissionRegistry,
  authenticateMachineCredential,
  createServicePrincipal,
  listServicePrincipals,
  revokeServicePrincipal,
} from '../src/auth/api-key-routes.mjs';
import { APPROVAL_ACTIONS, createApprovalFoundation } from '../src/lego/approval.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const REPO = resolve(APP, '..', '..');
const REPO_CATALOG = join(APP, 'data');
const PERMISSIONS_SRC = join(REPO, 'reference', 'n8n', 'packages', '@n8n', 'permissions', 'src');
const CONFIG = { catalogDir: process.env.N8N_LEGO_CATALOG_DIR ?? REPO_CATALOG };
const PASSWORD = 'Machine-Passw0rd';

function upstreamArray(name) {
  const src = readFileSync(join(PERMISSIONS_SRC, 'public-api-permissions.ee.ts'), 'utf8');
  const match = src.match(new RegExp(`export const ${name}[^=]*= \\[([\\s\\S]*?)\\];`));
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const KEY_UNIVERSE = () => apiKeyPermissionRegistry(CONFIG).universe;
const owner = (extra = {}) => ({ id: 'owner1', role: 'global:owner', ...extra });

function keyRecord(extra = {}) {
  const minted = generateApiKey({ ownerId: 'owner1', keyId: extra.id ?? 'k1' });
  return {
    raw: minted.raw,
    record: {
      id: extra.id ?? 'k1',
      label: 'ci',
      scopes: ['workflow:read', 'workflow:list', 'user:create'],
      audience: API_KEY_AUDIENCE.PUBLIC_API,
      tenantId: 'default',
      digest: minted.digest,
      hint: minted.hint,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      ...extra,
    },
  };
}

/* ======================================================= 1. vocabulary */

describe('the API-key scope vocabulary is extracted, not typed (differential vs pinned n8n)', () => {
  test('the shipped data/api-key-scopes.json equals a fresh extraction from the reference source', { skip: !existsSync(PERMISSIONS_SRC) && 'reference checkout absent' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'p57-roles-'));
    try {
      execFileSync(process.execPath, [join(APP, 'scripts', 'fetch-n8n-roles.mjs'), '--dir', dir], { stdio: 'pipe' });
      assert.equal(readFileSync(join(dir, 'api-key-scopes.json'), 'utf8'), readFileSync(join(APP, 'data', 'api-key-scopes.json'), 'utf8'));
      assert.equal(readFileSync(join(dir, 'roles.json'), 'utf8'), readFileSync(join(APP, 'data', 'roles.json'), 'utf8'), 'roles.json is untouched');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('53 scopes; sixteen of them exist in no role, which is why keys get their own universe', () => {
    const vocabulary = loadApiKeyScopes(CONFIG);
    assert.equal(vocabulary.all.length, 53);
    const roles = loadRoles(CONFIG);
    const roleUniverse = new Set(Object.values(roles).flat().flatMap((r) => r.scopes));
    const keyOnly = vocabulary.all.filter((s) => !roleUniverse.has(s));
    assert.equal(keyOnly.length, 16);
    assert.ok(keyOnly.includes('execution:read') && keyOnly.includes('workflow:activate'));
    // The role registry would refuse them; the key registry accepts them.
    const roleRegistry = createPermissionRegistry(roles);
    assert.equal(roleRegistry.has('execution:read'), false);
    assert.equal(apiKeyPermissionRegistry(CONFIG).has('execution:read'), true);
  });

  test('owner/admin grantable == upstream OWNER_API_KEY_SCOPES exactly', { skip: !existsSync(PERMISSIONS_SRC) && 'reference checkout absent' }, () => {
    const expected = new Set(upstreamArray('OWNER_API_KEY_SCOPES'));
    for (const role of ['global:owner', 'global:admin']) {
      assert.deepEqual(new Set(apiKeyScopesForRole(role, CONFIG)), expected, role);
    }
  });

  test('member follows upstream getApiKeyScopesForRole: MEMBER_API_KEY_SCOPES plus the member role\'s own key-vocabulary scopes', { skip: !existsSync(PERMISSIONS_SRC) && 'reference checkout absent' }, () => {
    const computed = new Set(apiKeyScopesForRole('global:member', CONFIG));
    const staticList = upstreamArray('MEMBER_API_KEY_SCOPES');
    for (const scope of staticList) assert.ok(computed.has(scope), scope);
    const memberRole = new Set(loadRoles(CONFIG).global.find((r) => r.slug === 'global:member').scopes);
    const extras = [...computed].filter((s) => !staticList.includes(s));
    assert.deepEqual(extras.sort(), ['user:list', 'variable:list']);
    for (const scope of extras) assert.ok(memberRole.has(scope), `${scope} comes from the member role itself`);
  });

  test('chatUser and unknown roles may grant nothing', () => {
    assert.deepEqual(apiKeyScopesForRole('global:chatUser', CONFIG), []);
    assert.deepEqual(apiKeyScopesForRole('global:nope', CONFIG), []);
  });
});

/* ======================================================= 2. primitives */

describe('api-key primitives: one-time raw value, hashed storage', () => {
  test('format, digest-only storage, parse round-trip, constant-time match', () => {
    const minted = generateApiKey({ ownerId: 'owner1', keyId: 'k1' });
    assert.ok(minted.raw.startsWith(`${API_KEY_PREFIX}owner1.k1.`));
    assert.notEqual(minted.digest, minted.raw);
    assert.ok(!minted.digest.includes(minted.raw.split('.')[2]), 'the digest does not contain the secret');
    assert.equal(minted.hint, minted.raw.slice(-4));
    assert.deepEqual(parseApiKey(minted.raw), { ownerId: 'owner1', keyId: 'k1' });
    assert.equal(apiKeyMatches(minted.raw, minted.digest), true);
    const tampered = minted.raw.slice(0, -1) + (minted.raw.endsWith('A') ? 'B' : 'A');
    assert.equal(apiKeyMatches(tampered, minted.digest), false);
    assert.notEqual(generateApiKey({ ownerId: 'owner1', keyId: 'k1' }).raw, minted.raw, 'every key is fresh');
  });

  test('malformed presentations are refused before any lookup', () => {
    const good = generateApiKey({ ownerId: 'o', keyId: 'k' }).raw;
    for (const bad of [undefined, null, 42, '', 'Bearer x', good.replace(API_KEY_PREFIX, 'n8n_xyz_'), `${API_KEY_PREFIX}o.k`, `${good}.extra`, `${API_KEY_PREFIX}o.k.short`, 'x'.repeat(API_KEY_POLICY.maxPresentedLength + 1)]) {
      assert.equal(parseApiKey(bad), null, String(bad).slice(0, 30));
    }
    assert.throws(() => generateApiKey({ ownerId: 'a.b', keyId: 'k' }));
  });

  test('redaction matches upstream redactApiKey: ten characters, last four visible', () => {
    assert.equal(redactApiKey('abcd'), '******abcd');
    assert.equal(redactApiKey('abcd').length, 10);
  });

  test('revoked / expired / owner gone / owner disabled / wrong audience are all denials', () => {
    const { record } = keyRecord();
    const now = Date.now();
    assert.equal(apiKeyVerdict(record, { owner: owner(), now }), API_KEY_VERDICT.OK);
    assert.equal(apiKeyVerdict({ ...record, revokedAt: new Date().toISOString() }, { owner: owner(), now }), API_KEY_VERDICT.REVOKED);
    // Upstream expiresAt is unix SECONDS.
    assert.equal(apiKeyVerdict({ ...record, expiresAt: Math.floor(now / 1000) - 1 }, { owner: owner(), now }), API_KEY_VERDICT.EXPIRED);
    assert.equal(apiKeyVerdict({ ...record, expiresAt: Math.floor(now / 1000) + 3600 }, { owner: owner(), now }), API_KEY_VERDICT.OK);
    assert.equal(apiKeyVerdict(record, { owner: null, now }), API_KEY_VERDICT.OWNER_UNAVAILABLE);
    assert.equal(apiKeyVerdict(record, { owner: owner({ disabled: true }), now }), API_KEY_VERDICT.OWNER_UNAVAILABLE);
    assert.equal(apiKeyVerdict(record, { owner: owner(), now, audience: API_KEY_AUDIENCE.SERVICE }), API_KEY_VERDICT.AUDIENCE_MISMATCH);
    assert.equal(apiKeyVerdict(null, { owner: owner(), now }), API_KEY_VERDICT.UNKNOWN);
  });

  test('attenuation: escalation is reported, never silently trimmed', () => {
    assert.deepEqual(attenuateScopes(['workflow:read'], ['workflow:read', 'workflow:list']), { ok: true, scopes: ['workflow:read'], escalated: [] });
    const escalated = attenuateScopes(['workflow:read', 'user:delete'], ['workflow:read']);
    assert.equal(escalated.ok, false);
    assert.deepEqual(escalated.scopes, []);
    assert.deepEqual(escalated.escalated, ['user:delete']);
    assert.equal(attenuateScopes([], ['workflow:read']).ok, false);
    assert.equal(attenuateScopes('workflow:read', ['workflow:read']).ok, false);
    assert.deepEqual(effectiveScopes(['a:b', 'c:d'], ['c:d']), ['c:d']);
  });

  test('last-used writes are throttled', () => {
    const now = Date.now();
    assert.equal(lastUsedIsStale({ lastUsedAt: null }, now), true);
    assert.equal(lastUsedIsStale({ lastUsedAt: new Date(now - 1000).toISOString() }, now), false);
    assert.equal(lastUsedIsStale({ lastUsedAt: new Date(now - API_KEY_POLICY.lastUsedWriteIntervalMs).toISOString() }, now), true);
  });
});

/* =============================================== 3. tenant policy input */

describe('tenant security policy: validated input, canonical approval vocabulary only', () => {
  test('defaults are the single-tenant cheapest path', () => {
    assert.equal(DEFAULT_TENANT_SECURITY_POLICY.tenantId, 'default');
    assert.equal(DEFAULT_TENANT_SECURITY_POLICY.apiKeys.enabled, true);
    assert.deepEqual([...DEFAULT_TENANT_SECURITY_POLICY.agents.approvalRequiredActions], []);
    assert.ok(Object.isFrozen(DEFAULT_TENANT_SECURITY_POLICY.agents));
  });

  test('rejects invented approval actions, unknown kinds and unbounded depth', () => {
    assert.throws(() => createTenantSecurityPolicy({ agents: { approvalRequiredActions: ['execute workflow'] } }), /canonical approval vocabulary/);
    assert.throws(() => createTenantSecurityPolicy({ agents: { approvalRequiredActions: ['launch rockets'] } }, { approvalActions: APPROVAL_ACTIONS }), /not a canonical approval action/);
    assert.ok(createTenantSecurityPolicy({ agents: { approvalRequiredActions: ['execute workflow'] } }, { approvalActions: APPROVAL_ACTIONS }));
    assert.throws(() => createTenantSecurityPolicy({ servicePrincipals: { kinds: ['robot'] } }), /unknown service principal kind/);
    assert.throws(() => createTenantSecurityPolicy({ agents: { maxDelegationDepth: 99 } }), /maxDelegationDepth/);
    assert.throws(() => createTenantSecurityPolicy({ agents: { approvalPrincipalTypes: ['user'] } }), /approval cannot target/);
  });

  test('key expiry rules: future-or-null (upstream), required expiry, maximum lifetime', () => {
    const now = Date.now();
    const s = Math.floor(now / 1000);
    assert.equal(keyPolicyViolation(DEFAULT_TENANT_SECURITY_POLICY, { expiresAt: null, now }), null);
    assert.equal(keyPolicyViolation(DEFAULT_TENANT_SECURITY_POLICY, { expiresAt: s - 10, now }), 'Expiration date must be in the future or null');
    const strict = createTenantSecurityPolicy({ apiKeys: { requireExpiry: true, maxTtlSeconds: 3600 } });
    assert.equal(keyPolicyViolation(strict, { expiresAt: null, now }), 'This tenant requires API keys to expire');
    assert.equal(keyPolicyViolation(strict, { expiresAt: s + 7200, now }), 'Expiration exceeds the maximum key lifetime for this tenant');
    assert.equal(keyPolicyViolation(strict, { expiresAt: s + 600, now }), null);
    assert.equal(keyPolicyViolation(createTenantSecurityPolicy({ apiKeys: { enabled: false } }), { expiresAt: null, now }), 'API keys are disabled for this tenant');
  });
});

/* ============================================ 4. machine principal model */

describe('machine principals never exceed their accountable owner', () => {
  test('an API-key principal: identity = owner, principal = key, strength api-key, scopes ∩ owner grant', () => {
    const { record } = keyRecord();
    const p = machinePrincipal({ record, owner: owner(), kind: 'api-key', ownerGrantable: apiKeyScopesForRole('global:owner', CONFIG), universe: KEY_UNIVERSE(), principalVersion: 3 });
    assert.equal(p.principalId, 'apikey:k1');
    assert.equal(p.identityId, 'owner1');
    assert.equal(p.principalType, 'api-key');
    assert.equal(p.authMethod, 'api-key');
    assert.equal(p.authStrength, 'api-key');
    assert.equal(p.principalVersion, 3);
    assert.deepEqual([...p.permissions], ['user:create', 'workflow:list', 'workflow:read']);
  });

  test('demoting the owner shrinks the key immediately (no background rewrite needed)', () => {
    const { record } = keyRecord();
    const p = machinePrincipal({ record, owner: owner({ role: 'global:member' }), kind: 'api-key', ownerGrantable: apiKeyScopesForRole('global:member', CONFIG), universe: KEY_UNIVERSE(), principalVersion: 0 });
    assert.deepEqual([...p.permissions], ['workflow:list', 'workflow:read']);
    const d = authorize({ principal: p, action: 'user:create' }, { registry: apiKeyPermissionRegistry(CONFIG) });
    assert.equal(d.decision, DECISION.DENY);
    assert.equal(d.reasonCode, SECURITY_REASON.PERMISSION_DENIED);
  });

  test('unknown key scopes fail closed through the canonical key registry', () => {
    const { record } = keyRecord();
    const p = machinePrincipal({ record, owner: owner(), kind: 'api-key', ownerGrantable: apiKeyScopesForRole('global:owner', CONFIG), universe: KEY_UNIVERSE(), principalVersion: 0 });
    const d = authorize({ principal: p, action: 'workflow:frobnicate' }, { registry: apiKeyPermissionRegistry(CONFIG) });
    assert.deepEqual([d.decision, d.reasonCode], [DECISION.DENY, SECURITY_REASON.UNKNOWN_PERMISSION]);
  });

  test('no universe → no principal (fail closed)', () => {
    const { record } = keyRecord();
    assert.throws(
      () => machinePrincipal({ record, owner: owner(), kind: 'api-key', ownerGrantable: [], universe: new Set(), principalVersion: 0 }),
      (e) => e.code === SECURITY_REASON.AUTHORITY_UNAVAILABLE,
    );
  });
});

describe('service principals: own credential, bound to the owner\'s tenant', () => {
  const grantable = () => apiKeyScopesForRole('global:owner', CONFIG);

  test('a worker gets its own credential (no personal user credential), attenuated to the owner', () => {
    const { record, raw } = createServicePrincipalRecord({ id: 'w1', owner: owner(), kind: 'worker', label: 'worker-a', scopes: ['workflow:read', 'execution:read'], ownerGrantable: grantable() });
    assert.equal(record.audience, API_KEY_AUDIENCE.SERVICE);
    assert.ok(!JSON.stringify(record).includes(raw), 'only the digest is stored');
    assert.equal(apiKeyMatches(raw, record.digest), true);
    const p = machinePrincipal({ record, owner: owner(), kind: 'service', ownerGrantable: grantable(), universe: KEY_UNIVERSE(), principalVersion: 0 });
    assert.deepEqual([p.principalType, p.authMethod, p.principalId, p.identityId], ['service', 'service-credential', 'svc:w1', 'owner1']);
  });

  test('an agent-kind service principal is an agent principal', () => {
    const { record } = createServicePrincipalRecord({ id: 'a1', owner: owner(), kind: 'agent', label: 'agent', scopes: ['workflow:read'], ownerGrantable: grantable() });
    const p = machinePrincipal({ record, owner: owner(), kind: 'service', ownerGrantable: grantable(), universe: KEY_UNIVERSE(), principalVersion: 0 });
    assert.equal(p.principalType, 'agent');
  });

  test('scope escalation at creation is denied with the reason', () => {
    assert.throws(
      () => createServicePrincipalRecord({ id: 'w2', owner: owner({ role: 'global:member' }), kind: 'worker', label: 'x', scopes: ['user:delete'], ownerGrantable: apiKeyScopesForRole('global:member', CONFIG) }),
      (e) => e.code === SECURITY_REASON.PERMISSION_DENIED && e.details.reason === 'scope-escalation' && e.details.escalated.includes('user:delete'),
    );
  });

  test('cannot be created in, or act in, another tenant', () => {
    assert.throws(
      () => createServicePrincipalRecord({ id: 'w3', owner: owner(), kind: 'worker', label: 'x', tenantId: 'tenant-b', scopes: ['workflow:read'], ownerGrantable: grantable() }),
      (e) => e.details?.reason === 'cross-tenant-create',
    );
    const { record } = createServicePrincipalRecord({ id: 'w4', owner: owner(), kind: 'worker', label: 'x', scopes: ['workflow:read'], ownerGrantable: grantable() });
    // A record whose tenant does not match its owner is refused as a principal.
    assert.throws(
      () => machinePrincipal({ record: { ...record, tenantId: 'tenant-b' }, owner: owner(), kind: 'service', ownerGrantable: grantable(), universe: KEY_UNIVERSE(), principalVersion: 0 }),
      (e) => e.details?.reason === 'owner-tenant-mismatch',
    );
    // A valid principal is denied on another tenant's resource by the P5.3 engine.
    const p = machinePrincipal({ record, owner: owner(), kind: 'service', ownerGrantable: grantable(), universe: KEY_UNIVERSE(), principalVersion: 0 });
    const d = authorize({ principal: p, action: 'workflow:read', resourceTenantId: 'tenant-b' }, { registry: apiKeyPermissionRegistry(CONFIG) });
    assert.deepEqual([d.decision, d.reasonCode], [DECISION.DENY, SECURITY_REASON.TENANT_MISMATCH]);
    assert.equal(authorize({ principal: p, action: 'workflow:read', resourceTenantId: 'default' }, { registry: apiKeyPermissionRegistry(CONFIG) }).decision, DECISION.ALLOW);
  });

  test('policy: disabled or disallowed kinds are refused; the count is bounded', () => {
    const noServices = createTenantSecurityPolicy({ servicePrincipals: { enabled: false } });
    assert.throws(() => createServicePrincipalRecord({ id: 'x', owner: owner(), kind: 'worker', label: 'x', scopes: ['workflow:read'], ownerGrantable: grantable(), policy: noServices }), /disabled/);
    const workersOnly = createTenantSecurityPolicy({ servicePrincipals: { kinds: ['worker'] } });
    assert.throws(() => createServicePrincipalRecord({ id: 'x', owner: owner(), kind: 'mcp', label: 'x', scopes: ['workflow:read'], ownerGrantable: grantable(), policy: workersOnly }), /kind must be one of worker/);
    assert.throws(
      () => createServicePrincipalRecord({ id: 'x', owner: owner(), kind: 'worker', label: 'x', scopes: ['workflow:read'], ownerGrantable: grantable(), existing: MACHINE_IDENTITY_LIMITS.maxServicePrincipalsPerOwner }),
      /at most/,
    );
    assert.deepEqual([...SERVICE_PRINCIPAL_KINDS], ['worker', 'agent', 'mcp', 'gateway']);
  });
});

/* ===================================================== 5. delegation */

function userPrincipal(extra = {}) {
  return createPrincipalSnapshot({
    principalId: 'user:owner1',
    identityId: 'owner1',
    principalType: 'user',
    authMethod: 'password',
    authStrength: 'password',
    permissions: ['workflow:read', 'workflow:list', 'workflow:update', 'credential:create'],
    principalVersion: 1,
    expiresAt: Date.now() + 60 * 60 * 1000,
    ...extra,
  });
}

describe('delegation attenuation is enforced', () => {
  test('a delegate holds a subset, keeps the accountable identity, never outlives or out-ranks its parent', () => {
    const parent = userPrincipal({ authStrength: 'mfa', authMethod: 'mfa' });
    const { principal, grant } = delegate(parent, { principalId: 'agent:a1', permissions: ['workflow:read'], ttlMs: 24 * 60 * 60 * 1000, grantId: 'g1' });
    assert.deepEqual([...principal.permissions], ['workflow:read']);
    assert.equal(principal.identityId, 'owner1', 'the human stays accountable');
    assert.equal(principal.principalType, 'agent');
    assert.equal(principal.authMethod, 'service-credential');
    assert.equal(principal.authStrength, 'api-key', 'an agent never carries mfa strength it did not prove');
    assert.ok(principal.expiresAt <= parent.expiresAt, 'bounded by the parent');
    assert.deepEqual([grant.depth, grant.parentPrincipalId, grant.rootIdentityId, grant.tenantId], [1, 'user:owner1', 'owner1', 'default']);
    // A password-strength parent yields a password-strength delegate, never higher.
    assert.equal(delegate(userPrincipal(), { principalId: 'agent:a2', permissions: ['workflow:read'], ttlMs: 1000, grantId: 'g2' }).principal.authStrength, 'password');
  });

  test('escalation beyond the parent is denied, including through a chain', () => {
    const parent = userPrincipal();
    assert.throws(
      () => delegate(parent, { principalId: 'agent:x', permissions: ['workflow:read', 'user:delete'], ttlMs: 1000, grantId: 'g' }),
      (e) => e.code === SECURITY_REASON.PERMISSION_DENIED && e.details.reason === 'delegation-escalation' && e.details.escalated[0] === 'user:delete',
    );
    const first = delegate(parent, { principalId: 'agent:a', permissions: ['workflow:read'], ttlMs: 60_000, grantId: 'g1' });
    assert.throws(
      () => delegate(first.principal, { principalId: 'agent:b', permissions: ['workflow:update'], ttlMs: 1000, parentGrant: first.grant, grantId: 'g2' }),
      (e) => e.details?.reason === 'delegation-escalation',
      'a delegate cannot hand out what its parent kept',
    );
  });

  test('depth is bounded by tenant policy', () => {
    let current = { principal: userPrincipal(), grant: null };
    for (let depth = 1; depth <= 3; depth += 1) {
      current = delegate(current.principal, { principalId: `agent:${depth}`, permissions: ['workflow:read'], ttlMs: 60_000, parentGrant: current.grant, grantId: `g${depth}` });
      assert.equal(current.grant.depth, depth);
    }
    assert.throws(
      () => delegate(current.principal, { principalId: 'agent:4', permissions: ['workflow:read'], ttlMs: 60_000, parentGrant: current.grant, grantId: 'g4' }),
      (e) => e.details?.reason === 'delegation-depth',
    );
    const flat = createTenantSecurityPolicy({ agents: { maxDelegationDepth: 0 } });
    assert.throws(() => delegate(userPrincipal(), { principalId: 'agent:z', permissions: ['workflow:read'], ttlMs: 1000, policy: flat, grantId: 'g' }), (e) => e.details?.reason === 'delegation-depth');
  });

  test('cross-tenant delegation, expired parents and forged parent grants are refused', () => {
    assert.throws(() => delegate(userPrincipal(), { principalId: 'agent:x', permissions: ['workflow:read'], ttlMs: 1000, tenantId: 'tenant-b', grantId: 'g' }), (e) => e.details?.reason === 'cross-tenant-delegation');
    const expired = userPrincipal({ issuedAt: Date.now() - 10_000, expiresAt: Date.now() - 1 });
    assert.throws(() => delegate(expired, { principalId: 'agent:x', permissions: ['workflow:read'], ttlMs: 1000, grantId: 'g' }), (e) => e.details?.reason === 'parent-expired');
    const first = delegate(userPrincipal(), { principalId: 'agent:a', permissions: ['workflow:read'], ttlMs: 60_000, grantId: 'g1' });
    assert.throws(
      () => delegate(userPrincipal(), { principalId: 'agent:b', permissions: ['workflow:read'], ttlMs: 1000, parentGrant: first.grant, grantId: 'g2' }),
      (e) => e.details?.reason === 'grant-principal-mismatch',
    );
    assert.throws(() => delegate(userPrincipal(), { principalId: 'agent:x', permissions: ['workflow:read'], ttlMs: MACHINE_IDENTITY_LIMITS.maxDelegationTtlMs + 1, grantId: 'g' }), /ttlMs/);
  });

  test('agent identity grants no extra authority: account-security step-up refuses machines', () => {
    const { principal } = delegate(userPrincipal({ authStrength: 'mfa', authMethod: 'mfa' }), { principalId: 'agent:a', permissions: ['workflow:read'], ttlMs: 1000, grantId: 'g' });
    const verdict = evaluateStepUp('account.password.change', { sessionStrength: principal.authStrength, principalType: principal.principalType, enrolled: false, proofs: ['current-password'] });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'interactive-session-required');
  });
});

/* ================================= 6. authority chain + approval (ai.approval) */

describe('sensitive agent actions require explicit approval — decided by ai.approval, not by P5', () => {
  const policy = createTenantSecurityPolicy({ agents: { approvalRequiredActions: ['execute workflow'] } }, { approvalActions: APPROVAL_ACTIONS });
  const agent = () => delegate(userPrincipal({ permissions: ['workflow:read', 'workflow:execute'] }), { principalId: 'agent:a1', permissions: ['workflow:read', 'workflow:execute'], ttlMs: 60 * 60 * 1000, grantId: 'g' }).principal;
  const base = (principal, extra = {}) => ({ principal, action: 'workflow:execute', resourceType: 'workflow', resourceId: 'wf1', resourceTenantId: 'default', approvalAction: 'execute workflow', policy, ...extra });

  test('without an approval: approval-required, with an input the real foundation accepts', () => {
    const approvals = createApprovalFoundation();
    const result = decideMachineAction(base(agent()), { approvals });
    assert.equal(result.outcome, MACHINE_OUTCOME.APPROVAL_REQUIRED);
    assert.deepEqual({ ...result.approvalRequest }, { action: 'execute workflow', actor: 'agent:a1', risk: 'high', scope: 'workflow:wf1' });
    const requested = approvals.request({ approvalId: 'ap1', ...result.approvalRequest });
    assert.equal(requested.state, 'requested');
  });

  test('pending → deny; granted → allow; granted for another agent or resource → deny', () => {
    const approvals = createApprovalFoundation();
    const principal = agent();
    const req = decideMachineAction(base(principal), { approvals }).approvalRequest;
    approvals.request({ approvalId: 'ap1', ...req });
    const pending = decideMachineAction(base(principal, { approvalId: 'ap1' }), { approvals });
    assert.deepEqual([pending.outcome, pending.approvalReason], [MACHINE_OUTCOME.DENY, 'not-granted']);
    approvals.resolve({ approvalId: 'ap1', decision: 'granted', approver: 'owner1' });
    const granted = decideMachineAction(base(principal, { approvalId: 'ap1' }), { approvals });
    assert.deepEqual([granted.outcome, granted.approvalRef], [MACHINE_OUTCOME.ALLOW, 'ap1']);
    // Confused deputy: the same approval does not cover another resource…
    const otherResource = decideMachineAction(base(principal, { approvalId: 'ap1', resourceId: 'wf2' }), { approvals });
    assert.deepEqual([otherResource.outcome, otherResource.approvalReason], [MACHINE_OUTCOME.DENY, 'scope-mismatch']);
    // …or another agent.
    const other = delegate(userPrincipal({ permissions: ['workflow:execute'] }), { principalId: 'agent:a2', permissions: ['workflow:execute'], ttlMs: 60_000, grantId: 'g2' }).principal;
    const otherAgent = decideMachineAction(base(other, { approvalId: 'ap1' }), { approvals });
    assert.deepEqual([otherAgent.outcome, otherAgent.approvalReason], [MACHINE_OUTCOME.DENY, 'identity-mismatch']);
    // Unknown approval id and a denied approval both deny.
    assert.equal(decideMachineAction(base(principal, { approvalId: 'nope' }), { approvals }).outcome, MACHINE_OUTCOME.DENY);
  });

  test('authorization comes first: an approval can never turn a missing permission into an allow', () => {
    const approvals = createApprovalFoundation();
    const readOnly = delegate(userPrincipal(), { principalId: 'agent:ro', permissions: ['workflow:read'], ttlMs: 60_000, grantId: 'g' }).principal;
    approvals.request({ approvalId: 'ap9', action: 'execute workflow', actor: 'agent:ro', risk: 'high', scope: 'workflow:wf1' });
    approvals.resolve({ approvalId: 'ap9', decision: 'granted', approver: 'owner1' });
    const result = decideMachineAction(base(readOnly, { approvalId: 'ap9' }), { approvals });
    assert.deepEqual([result.outcome, result.reasonCode], [MACHINE_OUTCOME.DENY, SECURITY_REASON.PERMISSION_DENIED]);
    const crossTenant = decideMachineAction(base(agent(), { resourceTenantId: 'tenant-b' }), { approvals });
    assert.deepEqual([crossTenant.outcome, crossTenant.reasonCode], [MACHINE_OUTCOME.DENY, SECURITY_REASON.TENANT_MISMATCH]);
  });

  test('fail closed without an approval port; non-sensitive actions and human principals are not gated', () => {
    const noPort = decideMachineAction(base(agent(), { approvalId: 'ap1' }));
    assert.deepEqual([noPort.outcome, noPort.approvalReason], [MACHINE_OUTCOME.DENY, 'approval-unavailable']);
    assert.equal(decideMachineAction(base(agent(), { action: 'workflow:read', approvalAction: undefined })).outcome, MACHINE_OUTCOME.ALLOW);
    const human = userPrincipal({ permissions: ['workflow:execute'] });
    assert.equal(decideMachineAction(base(human)).outcome, MACHINE_OUTCOME.ALLOW, 'P5 does not invent approvals for humans');
  });
});

/* ========================================================== 7. audit */

describe('audit events carry references and reasons only', () => {
  test('whitelisted fields, frozen, timestamped', () => {
    const event = machineAuditEvent('api-key.revoked', { keyRef: 'k1', ownerRef: 'owner1', reason: 'revoked-by-owner' });
    assert.deepEqual(Object.keys(event).sort(), ['at', 'keyRef', 'ownerRef', 'reason', 'type']);
    assert.ok(Object.isFrozen(event));
    assert.ok(MACHINE_AUDIT_EVENTS.includes('delegation.denied'));
  });

  test('credential material, unknown fields, objects and unknown types are refused', () => {
    const raw = generateApiKey({ ownerId: 'o', keyId: 'k' }).raw;
    assert.throws(() => machineAuditEvent('api-key.denied', { keyRef: raw }), /credential material/);
    assert.throws(() => machineAuditEvent('api-key.denied', { reason: `x ${raw}` }), /credential material/);
    assert.throws(() => machineAuditEvent('api-key.denied', { digest: 'abc' }), /not a reference field/);
    assert.throws(() => machineAuditEvent('api-key.denied', { reason: { nested: true } }), /string or a number/);
    assert.throws(() => machineAuditEvent('api-key.exported', {}), /unknown machine audit event/);
  });
});

/* ============================================ 8. HTTP: /rest/api-keys */

async function harness() {
  const logs = [];
  const logger = { info: (m, d) => logs.push(JSON.stringify([m, d])), warn: (m, d) => logs.push(JSON.stringify([m, d])), error: (m, d) => logs.push(JSON.stringify([m, d])), debug: () => {} };
  const config = { secret: randomBytes(16).toString('hex'), protocol: 'http', port: 0, publicUrl: 'http://127.0.0.1', storage: 'memory', catalogDir: CONFIG.catalogDir };
  const store = createStore({ storage: 'memory' });
  const router = createRouter(authRoutes({ logger, vault: null }));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://h');
    const match = router.match(req.method, url.pathname);
    const ctx = { req, res, config, logger, store, method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), params: match?.params ?? {}, body: undefined, user: null };
    try {
      ctx.user = currentUser(store, config, req);
      if (!match) throw new HttpError(404, 'Not found');
      if (!match.public && !ctx.user) throw new HttpError(401, 'Unauthorized');
      if (['POST', 'PATCH'].includes(req.method)) ctx.body = await readBody(req, { limit: 1e6 });
      await match.handler(ctx);
    } catch (error) {
      sendError(res, error);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, store, config, logs, close: () => new Promise((r) => server.close(r)) };
}

function browser(base) {
  let cookie = '';
  return {
    async call(method, path, body, headers = {}) {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const c of res.headers.getSetCookie()) if (c.startsWith('n8n-auth=')) cookie = c.split(';')[0];
      const raw = await res.text();
      let json = null;
      try { json = raw ? JSON.parse(raw) : null; } catch { /* not json */ }
      return { status: res.status, body: json, raw };
    },
  };
}

function seedOwner(h, email = 'owner@p57.test') {
  return createOwner(h.store, { email, firstName: 'O', lastName: 'W', password: PASSWORD });
}

function seedUser(h, { email, role }) {
  const ownerRecord = seedOwner(h, `seed-${randomBytes(4).toString('hex')}@p57.test`);
  const id = randomBytes(8).toString('hex');
  h.store.users.insert({ ...ownerRecord, id, email, role });
  return h.store.users.get(id);
}

async function signedIn(h, email = 'owner@p57.test') {
  const b = browser(h.base);
  const r = await b.call('POST', '/rest/login', { emailOrLdapLoginId: email, password: PASSWORD });
  assert.equal(r.status, 200, r.raw);
  return b;
}

const future = (seconds) => Math.floor(Date.now() / 1000) + seconds;

describe('/rest/api-keys over HTTP: upstream contract, hashed storage, attenuation', () => {
  test('create returns the raw key once; list and storage never contain it', async () => {
    const h = await harness();
    try {
      const user = seedOwner(h);
      const b = await signedIn(h);
      assert.deepEqual((await b.call('GET', '/rest/api-keys')).body.data, []);
      const scopes = (await b.call('GET', '/rest/api-keys/scopes')).body.data;
      assert.equal(scopes.length, 52);
      const created = await b.call('POST', '/rest/api-keys', { label: 'ci', scopes: ['workflow:read', 'workflow:list'], expiresAt: null });
      assert.equal(created.status, 200, created.raw);
      const key = created.body.data;
      assert.ok(key.rawApiKey.startsWith(`${API_KEY_PREFIX}${user.id}.`));
      assert.equal(key.apiKey, `******${key.rawApiKey.slice(-4)}`);
      assert.deepEqual([key.label, key.userId, key.audience, key.expiresAt, key.scopes], ['ci', user.id, 'public-api', null, ['workflow:list', 'workflow:read']]);
      const listed = await b.call('GET', '/rest/api-keys');
      assert.equal(listed.body.data.length, 1);
      assert.ok(!listed.raw.includes(key.rawApiKey) && !('rawApiKey' in listed.body.data[0]) && !('digest' in listed.body.data[0]));
      assert.ok(!JSON.stringify(h.store.users.all()).includes(key.rawApiKey), 'the store holds a digest, never the key');
      assert.ok(!h.logs.join('\n').includes(key.rawApiKey), 'no log line holds the key');
      assert.ok(h.logs.some((l) => l.includes('auth.api-key.created')), 'creation is audited');
      // The user payload never exposes key records.
      const me = await b.call('GET', '/rest/login');
      assert.ok(!('apiKeys' in me.body.data) && !me.raw.includes(key.id));
    } finally {
      await h.close();
    }
  });

  test('scope escalation is denied (create and update) with the upstream message', async () => {
    const h = await harness();
    try {
      seedOwner(h);
      seedUser(h, { email: 'member@p57.test', role: 'global:member' });
      const member = await signedIn(h, 'member@p57.test');
      const escalate = await member.call('POST', '/rest/api-keys', { label: 'x', scopes: ['workflow:read', 'user:delete'], expiresAt: null });
      assert.deepEqual([escalate.status, escalate.body.message], [400, 'Invalid scopes for user role']);
      const ok = await member.call('POST', '/rest/api-keys', { label: 'x', scopes: ['workflow:read'], expiresAt: null });
      assert.equal(ok.status, 200);
      const patched = await member.call('PATCH', `/rest/api-keys/${ok.body.data.id}`, { label: 'x', scopes: ['user:changeRole'] });
      assert.deepEqual([patched.status, patched.body.message], [400, 'Invalid scopes for user role']);
      assert.ok(h.logs.some((l) => l.includes('auth.api-key.denied') && l.includes('scope-escalation')));
    } finally {
      await h.close();
    }
  });

  test('input validation mirrors the upstream DTOs', async () => {
    const h = await harness();
    try {
      seedOwner(h);
      const b = await signedIn(h);
      const post = (body) => b.call('POST', '/rest/api-keys', body);
      assert.equal((await post({ label: '', scopes: ['workflow:read'], expiresAt: null })).status, 400);
      assert.equal((await post({ label: 'x'.repeat(51), scopes: ['workflow:read'], expiresAt: null })).status, 400);
      assert.equal((await post({ label: '<b>x</b>', scopes: ['workflow:read'], expiresAt: null })).status, 400);
      assert.equal((await post({ label: 'x', scopes: [], expiresAt: null })).status, 400);
      const shape = await post({ label: 'x', scopes: ['workflow-read'], expiresAt: null });
      assert.deepEqual([shape.status, shape.body.message], [400, "Each scope must follow the format '{resource}:{scope}' with only letters (e.g., 'workflow:create')"]);
      const past = await post({ label: 'x', scopes: ['workflow:read'], expiresAt: future(-60) });
      assert.deepEqual([past.status, past.body.message], [400, 'Expiration date must be in the future or null']);
      const unknownScope = await post({ label: 'x', scopes: ['workflow:frobnicate'], expiresAt: null });
      assert.deepEqual([unknownScope.status, unknownScope.body.message], [400, 'Invalid scopes for user role']);
    } finally {
      await h.close();
    }
  });

  test('apiKey:manage is required (chatUser gets the upstream 403); anonymous gets 401', async () => {
    const h = await harness();
    try {
      seedOwner(h);
      seedUser(h, { email: 'chat@p57.test', role: 'global:chatUser' });
      const chat = await signedIn(h, 'chat@p57.test');
      const denied = await chat.call('GET', '/rest/api-keys');
      assert.deepEqual([denied.status, denied.body.message], [403, MISSING_SCOPE_MESSAGE]);
      assert.equal((await browser(h.base).call('GET', '/rest/api-keys')).status, 401);
    } finally {
      await h.close();
    }
  });

  test('another user\'s key id: update/delete are silent no-ops that confirm nothing', async () => {
    const h = await harness();
    try {
      seedOwner(h);
      seedUser(h, { email: 'member@p57.test', role: 'global:member' });
      const ownerBrowser = await signedIn(h);
      const member = await signedIn(h, 'member@p57.test');
      const key = (await ownerBrowser.call('POST', '/rest/api-keys', { label: 'mine', scopes: ['workflow:read'], expiresAt: null })).body.data;
      assert.deepEqual((await member.call('PATCH', `/rest/api-keys/${key.id}`, { label: 'stolen', scopes: ['workflow:read'] })).body.data, { success: true });
      assert.deepEqual((await member.call('DELETE', `/rest/api-keys/${key.id}`)).body.data, { success: true });
      const still = (await ownerBrowser.call('GET', '/rest/api-keys')).body.data;
      assert.deepEqual([still.length, still[0].label], [1, 'mine']);
    } finally {
      await h.close();
    }
  });

  test('keys per owner are bounded', async () => {
    const h = await harness();
    try {
      const user = seedOwner(h);
      h.store.users.update(user.id, { apiKeys: Array.from({ length: API_KEY_POLICY.maxKeysPerOwner }, (_, i) => ({ ...keyRecord({ id: `k${i}` }).record })) });
      const b = await signedIn(h);
      const over = await b.call('POST', '/rest/api-keys', { label: 'one too many', scopes: ['workflow:read'], expiresAt: null });
      assert.equal(over.status, 400);
      assert.match(over.body.message, /maximum of 50 API keys/);
    } finally {
      await h.close();
    }
  });

  test('an API key is not a session: /rest refuses it, as upstream does', async () => {
    const h = await harness();
    try {
      seedOwner(h);
      const b = await signedIn(h);
      const raw = (await b.call('POST', '/rest/api-keys', { label: 'x', scopes: ['workflow:read'], expiresAt: null })).body.data.rawApiKey;
      const res = await browser(h.base).call('GET', '/rest/api-keys', undefined, { 'x-n8n-api-key': raw });
      assert.equal(res.status, 401);
    } finally {
      await h.close();
    }
  });
});

describe('revoked / expired keys are denied at authentication', () => {
  async function withKey(fn, body = { label: 'x', scopes: ['workflow:read', 'user:create'], expiresAt: null }) {
    const h = await harness();
    try {
      const user = seedOwner(h);
      const b = await signedIn(h);
      const key = (await b.call('POST', '/rest/api-keys', body)).body.data;
      await fn({ h, b, user, key, auth: (extra = {}) => authenticateMachineCredential({ store: h.store, config: h.config, presented: key.rawApiKey, logger: { info: (m, d) => h.logs.push(JSON.stringify([m, d])) }, ...extra }) });
    } finally {
      await h.close();
    }
  }

  test('a live key authenticates to a key principal with the owner\'s current version', () =>
    withKey(async ({ user, auth }) => {
      const result = auth();
      assert.equal(result.ok, true);
      assert.equal(result.principal.identityId, user.id);
      assert.equal(result.principal.principalVersion, securityVersionFor(user.id));
      assert.deepEqual([...result.principal.permissions], ['user:create', 'workflow:read']);
    }));

  test('revoked (DELETE) → denied as REVOKED (tombstone, P5-M01), and audited without the key', () =>
    withKey(async ({ h, b, key, auth }) => {
      assert.deepEqual((await b.call('DELETE', `/rest/api-keys/${key.id}`)).body.data, { success: true });
      assert.deepEqual(auth(), { ok: false, verdict: API_KEY_VERDICT.REVOKED });
      assert.ok(h.logs.some((l) => l.includes('auth.api-key.revoked')));
      assert.ok(h.logs.some((l) => l.includes('auth.api-key.denied')));
      assert.ok(!h.logs.join('\n').includes(key.rawApiKey));
    }));

  test('expired → denied', () =>
    withKey(
      async ({ key, auth }) => {
        assert.equal(auth().ok, true);
        assert.deepEqual(auth({ now: (key.expiresAt + 1) * 1000 }), { ok: false, verdict: API_KEY_VERDICT.EXPIRED });
      },
      { label: 'x', scopes: ['workflow:read'], expiresAt: future(3600) },
    ));

  test('a wrong secret for a real key id, a forged owner, a deleted owner → denied', () =>
    withKey(async ({ h, user, key, auth }) => {
      const wrong = key.rawApiKey.slice(0, -2) + (key.rawApiKey.endsWith('AA') ? 'BB' : 'AA');
      assert.equal(auth({ presented: wrong }).verdict, API_KEY_VERDICT.UNKNOWN);
      assert.equal(auth({ presented: key.rawApiKey.replace(user.id, 'someoneelse0000') }).ok, false);
      assert.equal(auth({ presented: 'garbage' }).verdict, API_KEY_VERDICT.MALFORMED);
      h.store.users.remove(user.id);
      assert.equal(auth().ok, false);
    }));

  test('a user key is not a service credential (audience binding)', () =>
    withKey(async ({ auth }) => {
      assert.equal(auth({ audience: API_KEY_AUDIENCE.SERVICE }).ok, false);
    }));

  test('demotion shrinks a live key on the next request', () =>
    withKey(async ({ h, user, auth }) => {
      h.store.users.update(user.id, { role: 'global:member' });
      assert.deepEqual([...auth().principal.permissions], ['workflow:read']);
    }));

  test('last-used is recorded, and written at most once per interval', () =>
    withKey(async ({ h, b, user, auth }) => {
      const t0 = Date.now();
      auth({ now: t0 });
      const first = h.store.users.get(user.id).apiKeys[0].lastUsedAt;
      assert.ok(first);
      auth({ now: t0 + 1000 });
      assert.equal(h.store.users.get(user.id).apiKeys[0].lastUsedAt, first, 'no write inside the interval');
      auth({ now: t0 + API_KEY_POLICY.lastUsedWriteIntervalMs + 1 });
      assert.notEqual(h.store.users.get(user.id).apiKeys[0].lastUsedAt, first);
      assert.ok((await b.call('GET', '/rest/api-keys')).body.data[0].lastUsedAt, 'the editor list carries last-used');
    }));
});

describe('P5-M01: revocation keeps a bounded tombstone instead of deleting', () => {
  test('API key: DELETE keeps the record with revokedAt; hidden from the list; repeat DELETE is a silent no-op', async () => {
    const h = await harness();
    try {
      const user = seedOwner(h);
      const b = await signedIn(h);
      const key = (await b.call('POST', '/rest/api-keys', { label: 'x', scopes: ['workflow:read'], expiresAt: null })).body.data;
      assert.deepEqual((await b.call('DELETE', `/rest/api-keys/${key.id}`)).body.data, { success: true });
      const stored = h.store.users.get(user.id).apiKeys.find((k) => k.id === key.id);
      assert.ok(stored && typeof stored.revokedAt === 'string' && stored.revokedReason === 'revoked-by-owner', 'tombstone kept');
      assert.ok(!JSON.stringify(stored).includes(key.rawApiKey), 'the raw key is never stored');
      assert.deepEqual((await b.call('GET', '/rest/api-keys')).body.data.map((k) => k.id), []);
      const revokedAudits = () => h.logs.filter((l) => l.includes('auth.api-key.revoked')).length;
      const before = revokedAudits();
      assert.deepEqual((await b.call('DELETE', `/rest/api-keys/${key.id}`)).body.data, { success: true });
      assert.deepEqual((await b.call('DELETE', '/rest/api-keys/does-not-exist')).body.data, { success: true });
      assert.equal(revokedAudits(), before, 'no second revocation for an already revoked or unknown id');
      // A new key keeps the tombstone; the per-owner limit counts only live keys.
      const next = (await b.call('POST', '/rest/api-keys', { label: 'y', scopes: ['workflow:read'], expiresAt: null })).body.data;
      assert.deepEqual(h.store.users.get(user.id).apiKeys.map((k) => [k.id, Boolean(k.revokedAt)]), [[key.id, true], [next.id, false]]);
    } finally {
      await h.close();
    }
  });

  test('service principal: revoke keeps a tombstone -> REVOKED verdict; a second revoke is false', async () => {
    const h = await harness();
    try {
      const user = seedOwner(h);
      const { servicePrincipal, rawCredential } = createServicePrincipal({ store: h.store, config: h.config, ownerId: user.id, kind: 'worker', label: 'w', scopes: ['workflow:read'] });
      assert.equal(revokeServicePrincipal({ store: h.store, ownerId: user.id, id: servicePrincipal.id }), true);
      const verdict = authenticateMachineCredential({ store: h.store, config: h.config, presented: rawCredential, audience: API_KEY_AUDIENCE.SERVICE });
      assert.deepEqual(verdict, { ok: false, verdict: API_KEY_VERDICT.REVOKED });
      assert.equal(revokeServicePrincipal({ store: h.store, ownerId: user.id, id: servicePrincipal.id }), false);
      assert.deepEqual(listServicePrincipals({ store: h.store, ownerId: user.id }), []);
      const again = createServicePrincipal({ store: h.store, config: h.config, ownerId: user.id, kind: 'worker', label: 'w2', scopes: ['workflow:read'] });
      assert.deepEqual(h.store.users.get(user.id).servicePrincipals.map((sp) => [sp.id, Boolean(sp.revokedAt)]), [[servicePrincipal.id, true], [again.servicePrincipal.id, false]]);
      // A wrong secret for a revoked id is still UNKNOWN: REVOKED is reported only for the real credential.
      const wrong = rawCredential.slice(0, -4) + (rawCredential.endsWith('AAAA') ? 'BBBB' : 'AAAA');
      assert.equal(authenticateMachineCredential({ store: h.store, config: h.config, presented: wrong, audience: API_KEY_AUDIENCE.SERVICE }).verdict, API_KEY_VERDICT.UNKNOWN);
    } finally {
      await h.close();
    }
  });

  test('tombstones are bounded per owner: the oldest are pruned, live records are never pruned', () => {
    const cap = API_KEY_POLICY.maxRevokedTombstonesPerOwner;
    const iso = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    const live = [{ id: 'live-1', revokedAt: null }, { id: 'live-2', revokedAt: null }];
    const dead = Array.from({ length: cap + 5 }, (_, i) => ({ id: `dead-${i}`, revokedAt: iso(i) }));
    const kept = pruneTombstones([...dead, ...live]);
    assert.equal(kept.filter((r) => r.revokedAt).length, cap);
    assert.deepEqual(kept.filter((r) => !r.revokedAt).map((r) => r.id), ['live-1', 'live-2']);
    assert.ok(!kept.some((r) => ['dead-0', 'dead-4'].includes(r.id)) && kept.some((r) => r.id === 'dead-5'), 'oldest five pruned');
    const full = [...dead.slice(0, cap), { id: 'k', revokedAt: null }];
    const res = revokeWithTombstone(full, 'k', { now: Date.UTC(2027, 0, 1) });
    assert.equal(res.records.length, cap, 'revoking at the cap prunes the oldest tombstone');
    assert.equal(res.revoked.revokedReason, 'revoked-by-owner');
    assert.equal(revokeWithTombstone(res.records, 'k'), null, 'already revoked');
    assert.equal(revokeWithTombstone(res.records, 'missing'), null, 'unknown');
    assert.equal(revokeWithTombstone(undefined, 'k'), null);
  });
});

describe('service principal lifecycle at the storage boundary', () => {
  test('create (credential once) → authenticate → cross-tenant denied → revoke → denied', async () => {
    const h = await harness();
    try {
      const user = seedOwner(h);
      const logger = { info: (m, d) => h.logs.push(JSON.stringify([m, d])) };
      const { servicePrincipal, rawCredential } = createServicePrincipal({ store: h.store, config: h.config, ownerId: user.id, kind: 'worker', label: 'worker-a', scopes: ['workflow:read', 'execution:read'], logger });
      assert.equal(servicePrincipal.credential, `******${rawCredential.slice(-4)}`);
      assert.ok(!JSON.stringify(h.store.users.all()).includes(rawCredential));
      assert.deepEqual(listServicePrincipals({ store: h.store, ownerId: user.id }).map((sp) => sp.id), [servicePrincipal.id]);
      const ok = authenticateMachineCredential({ store: h.store, config: h.config, presented: rawCredential, audience: API_KEY_AUDIENCE.SERVICE });
      assert.equal(ok.ok, true);
      assert.deepEqual([ok.principal.principalType, ok.principal.authMethod, ok.principal.identityId], ['service', 'service-credential', user.id]);
      // A service credential is not a public-API key.
      assert.equal(authenticateMachineCredential({ store: h.store, config: h.config, presented: rawCredential }).ok, false);
      const cross = authorize({ principal: ok.principal, action: 'workflow:read', resourceTenantId: 'tenant-b' }, { registry: apiKeyPermissionRegistry(h.config) });
      assert.equal(cross.reasonCode, SECURITY_REASON.TENANT_MISMATCH);
      assert.equal(revokeServicePrincipal({ store: h.store, ownerId: user.id, id: servicePrincipal.id, logger }), true);
      assert.equal(authenticateMachineCredential({ store: h.store, config: h.config, presented: rawCredential, audience: API_KEY_AUDIENCE.SERVICE }).ok, false);
      assert.ok(!h.logs.join('\n').includes(rawCredential));
      assert.ok(h.logs.some((l) => l.includes('auth.service-principal.created')) && h.logs.some((l) => l.includes('auth.service-principal.revoked')));
    } finally {
      await h.close();
    }
  });

  test('a chatUser (no apiKey:manage) cannot mint a service principal', async () => {
    const h = await harness();
    try {
      seedOwner(h);
      const chat = seedUser(h, { email: 'chat@p57.test', role: 'global:chatUser' });
      assert.throws(() => createServicePrincipal({ store: h.store, config: h.config, ownerId: chat.id, kind: 'worker', label: 'x', scopes: ['workflow:read'] }), /missing a scope/);
    } finally {
      await h.close();
    }
  });
});

/* ======================================= 9. real server, file storage */

describe('real server: API keys persist hashed across a restart', () => {
  const USER_FOLDER = mkdtempSync(join(tmpdir(), 'n8n-lego-p57-'));
  let running = null;
  let base = '';
  const env = () => ({
    ...process.env,
    N8N_LEGO_PORT: '0',
    N8N_LEGO_HOST: '127.0.0.1',
    N8N_LEGO_STORAGE: 'file',
    N8N_LEGO_LOG_LEVEL: 'error',
    N8N_LEGO_PROTOCOL: 'http',
    N8N_LEGO_USER_FOLDER: USER_FOLDER,
    N8N_LEGO_CATALOG_DIR: CONFIG.catalogDir,
  });
  async function boot() {
    const { server } = await startServer({ env: env() });
    running = server;
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (running) await new Promise((r) => running.close(r));
    running = null;
  }
  function client() {
    const jar = {};
    return async (method, path, body) => {
      const headers = { 'content-type': 'application/json', origin: base };
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.cookie = cookie;
      if (jar['n8n-csrf']) headers['x-n8n-csrf-token'] = jar['n8n-csrf'];
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        jar[pair.slice(0, i)] = pair.slice(i + 1);
      }
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
    };
  }
  let raw = '';
  let keyId = '';
  before(boot);
  after(async () => {
    await stop();
    rmSync(USER_FOLDER, { recursive: true, force: true });
  });

  test('the editor is told the API and the scope picker are available', async () => {
    const settings = (await client()('GET', '/rest/settings')).body.data;
    assert.equal(settings.publicApi.enabled, true);
    assert.equal(settings.enterprise.apiKeyScopes, true);
  });

  test('owner creates a key through the editor flow (CSRF enforced)', async () => {
    const call = client();
    assert.equal((await call('POST', '/rest/owner/setup', { email: 'owner@real57.test', firstName: 'O', lastName: 'W', password: PASSWORD })).status, 200);
    const created = await call('POST', '/rest/api-keys', { label: 'deploy', scopes: ['workflow:read'], expiresAt: null });
    assert.equal(created.status, 200, created.raw);
    raw = created.body.data.rawApiKey;
    keyId = created.body.data.id;
    const forged = await fetch(`${base}/rest/api-keys`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ label: 'x', scopes: ['workflow:read'], expiresAt: null }) });
    assert.ok(forged.status === 401 || forged.status === 403, 'a cross-site request cannot mint a key');
  });

  test('the raw key is nowhere on disk', () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(USER_FOLDER);
    assert.ok(files.length > 0);
    for (const file of files) assert.ok(!readFileSync(file, 'latin1').includes(raw), `${file} holds no raw key`);
  });

  test('after a restart the key is still listed (redacted) and still revocable', async () => {
    await stop();
    await boot();
    const call = client();
    assert.equal((await call('POST', '/rest/login', { emailOrLdapLoginId: 'owner@real57.test', password: PASSWORD })).status, 200);
    const listed = (await call('GET', '/rest/api-keys')).body.data;
    assert.deepEqual(listed.map((k) => [k.id, k.apiKey]), [[keyId, `******${raw.slice(-4)}`]]);
    assert.deepEqual((await call('DELETE', `/rest/api-keys/${keyId}`)).body.data, { success: true });
    assert.deepEqual((await call('GET', '/rest/api-keys')).body.data, []);
  });
});
