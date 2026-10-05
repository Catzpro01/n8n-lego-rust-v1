/**
 * P2.26 — provider declaration profile + workspace/GitHub boundaries +
 * foundation-readiness re-verification (focused suite).
 *
 * Scope discipline: this file proves §2–§6 of the Master Prompt P2.26. It
 * contains no P2.27 *implementation* assertions — P2.27 modules are asserted by
 * their own `lego-plugin-*.test.mjs` suites, never here.
 *
 * What this file does assert about P2.27 is administrative only, and it tracks
 * the register truth rather than a fixed point in time: the row started life as
 * a planning reservation ("still not started") and is now asserted as
 * `status === 'complete'` with `finishEvidence = PR #197 → 7d4eae8d`, while the
 * design document's original planning banner is asserted to be *preserved as
 * history*, not deleted. See the "P2.27 is the current administrative
 * milestone" test below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INTEGRATION_ACCESS_RULES,
  PROVIDER_DECLARATION_CONTRACT,
  PROVIDER_DECLARATION_CONTRACT_VERSION,
  PROVIDER_DECLARATION_FIELDS,
  PROVIDER_PROFILES,
  ProviderDeclarationError,
  assertHandedOverAccess,
  assertProviderDeclaration,
  describeProviderProfile,
} from '../src/lego/provider-declaration.mjs';
import {
  AI_FOUNDATION,
  AI_TRANSPORTS,
  PROVIDER_KINDS,
  isZeroInstallState,
} from '../src/lego/ai-foundation.mjs';
import * as workspaceModule from '../src/lego/workspace.mjs';
import { loadRegistry } from '../src/lego/registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');

const LOCK = JSON.parse(read('apps/n8n-lego/src/lego/contracts/contract-lock.json'));
const ROWS = LOCK.contracts ?? LOCK;
const row = (id) => ROWS.find((r) => r.id === id);
const MANIFEST = JSON.parse(read('apps/n8n-lego/src/lego/manifest/ai-foundation.json'));
const LEGO_SET = JSON.parse(read('apps/n8n-lego/src/lego/manifest/ai-lego-set.json'));
const ERRORS = JSON.parse(read('apps/n8n-lego/src/lego/contracts/errors.contract.json'));
const REGISTER = JSON.parse(read('docs/n8n-lego/milestones.json'));
const BY_ID = new Map(REGISTER.milestones.map((m) => [m.id, m]));
const registry = loadRegistry({ reload: true });
const DOMAIN = registry.byId.get('ai-foundation');
const WORKSPACE_DOMAIN = registry.byId.get('workspace');
const PD_SRC = read('apps/n8n-lego/src/lego/provider-declaration.mjs');
const WS_SRC = read('apps/n8n-lego/src/lego/workspace.mjs');

const DECL = Object.freeze({ providerId: 'prov-main', kind: 'model-provider', profile: 'cloud' });
const caught = (fn) => {
  try { fn(); return null; } catch (error) { return error; }
};
const caughtAsync = async (fn) => {
  try { await fn(); return null; } catch (error) { return error; }
};
const D15 = 'd15a9538b1899e9fd2ea9d5bd37d3fd26ecc1943';

/* ============================================== A. CONTRACT / LOCK ROW */

test('the lock row is the thirty-second: ai.provider-declaration@1.0.0, owner manager, exports byte-parity', () => {
  const r = row('ai.provider-declaration');
  assert.ok(r, 'the provider declaration contract is locked');
  // P9.1 envelope + P3 optimizer are merged; P9.2 structured-log adds row 42.
  assert.equal(ROWS.length, 100, 'P2.26 added the thirty-second; P3 Slice A adds the thirty-third (workflow.graph); P3 Slice D adds the thirty-fourth (execution.frontier); P3 Slice E adds the thirty-fifth (execution.state-stream); P3 Slice H adds the thirty-sixth (workflow.dna); P3 Slice J the thirty-seventh (execution.ir); P3 Slice L the thirty-eighth (compatibility.oracle); P3 Slice M the thirty-ninth (execution.guard) — P6.1 adds node.registry@0.1.0; P6.2 adds registry.compiler@0.1.0; P6.3 adds package.transaction@0.1.0; P6.4 adds registry.closure@0.1.0; P6.5 adds node.resolution@0.1.0; P6.6 adds runtime.lease@0.1.0; P6.7 adds node.residency@0.1.0; P6.8 adds node.capability@0.1.0; P6.9 adds node.semantics@0.1.0; P6.10 adds node.lifecycle@0.1.0; P6.11 adds node.health@0.1.0; P6.12 adds node.supply-chain@0.1.0; P6.13 adds registry.incremental@0.1.0; P6.14 adds node.worker-convergence@0.1.0; P6.15 adds node.acceptance@0.1.0; P6.16 adds registry.integrity@0.1.0; P6.17 adds node.admission@0.1.0; P6.18 adds node.sbom@0.1.0; P6.19 adds node.canary@0.1.0; P6.20 adds node.revocation@0.1.0; P6.21 adds node.io@0.1.0; P6.22 adds runtime.jit@0.1.0; P6.23 adds runtime.cancel@0.1.0; P6.24 adds runtime.pool@0.1.0; P6.25 adds node.abi@0.1.0; P6.26 adds runtime.wasm-cache@0.1.0; P6.27 adds node.provenance@0.1.0; P6.28 adds registry.freshness@0.1.0; P6.29 adds node.namespace@0.1.0; P6.30 adds registry.repair@0.1.0; P6.31 adds registry.acceptance@0.1.0; count-pins say 76; P2.27.1 adds lego.plugin-runtime@0.1.0 (seventy-sixth); P5.1 adds the ninety-fifth (auth.principal)'); // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  assert.equal(r.owner, 'manager');
  assert.equal(r.domain, 'ai-foundation');
  assert.equal(r.version, '1.0.0');
  assert.equal(r.status, 'implemented');
  assert.deepEqual(r.surface, ['src/lego/provider-declaration.mjs']);
  const locked = r.exports['src/lego/provider-declaration.mjs'];
  const module_ = {
    INTEGRATION_ACCESS_RULES, PROVIDER_DECLARATION_CONTRACT, PROVIDER_DECLARATION_CONTRACT_VERSION,
    PROVIDER_DECLARATION_FIELDS, PROVIDER_PROFILES, ProviderDeclarationError,
    assertHandedOverAccess, assertProviderDeclaration, describeProviderProfile,
  };
  assert.deepEqual([...locked].sort(), Object.keys(module_).sort(),
    'the lock exports exactly what the module exports');
  assert.deepEqual([...locked], [...locked].slice().sort(), 'export list stays sorted ASCII');
  assert.deepEqual(r.tests, ['apps/n8n-lego/test/lego-provider-declaration.test.mjs']);
  assert.ok(readFileSync(join(REPO_ROOT, r.tests[0]), 'utf8').length > 0,
    'the declared contract test exists');
  assert.equal(PROVIDER_DECLARATION_CONTRACT.id, r.id);
  assert.equal(PROVIDER_DECLARATION_CONTRACT_VERSION, r.version);
  assert.equal(PROVIDER_DECLARATION_CONTRACT.owner, r.owner);
});

test('the neighbouring contracts are untouched: ai.foundation stays contract-only 1.0.0 with its old export set', () => {
  const f = row('ai.foundation');
  assert.equal(f.version, '1.0.0');
  assert.equal(f.status, 'contract-only');
  const names = f.exports['src/lego/ai-foundation.mjs'];
  assert.ok(!names.includes('PROVIDER_PROFILES'), 'profiles publish on the new contract, not the old one');
  assert.ok(!names.includes('assertProviderDeclaration'));
  assert.ok(!names.includes('assertHandedOverAccess'));
  assert.equal(names.includes('PROVIDER_KINDS'), true, 'the old vocabulary is intact');
  assert.equal(DOMAIN.status, 'partial', 'domain status unchanged');
  assert.equal(DOMAIN.contract.version, '1.0.0', 'domain contract pin unchanged');
});

test('no capability was added: the ai-foundation capability list is still the same seventeen words', () => {
  const ids = DOMAIN.capabilities.map((c) => c.id);
  assert.equal(ids.length, 17, 'FE pins aiFoundationCapability at 17 — P2.26 adds none');
  assert.equal(ids.includes('ai.provider-declaration'), false,
    'a declaration profile is a contract row, not a second capability dialect');
  const appProvider = DOMAIN.capabilities.find((c) => c.id === 'ai.application-provider');
  assert.equal(appProvider.status, 'contract-only', 'GitHub stays behind the declared boundary');
  assert.equal(appProvider.lifecycle, 'declared');
  const row32 = row('ai.provider-declaration');
  assert.equal('operations' in row32, false, 'no operations without a capability — no phantom surface');
  assert.equal('permissions' in row32, false, 'permissions stay with the published capability words');
});

test('ownership stays split: provider declaration joins ai-foundation paths; Workspace never moves', () => {
  assert.ok(DOMAIN.paths.includes('src/lego/provider-declaration.mjs'));
  assert.equal(DOMAIN.paths.length, 19, '18 paths + the new module');
  assert.equal(DOMAIN.paths.includes('src/lego/workspace.mjs'), false,
    'workspace internals must not enter AI Foundation');
  assert.ok(WORKSPACE_DOMAIN.paths.includes('src/lego/workspace.mjs'),
    'the Workspace keeps owning its module');
  assert.ok(WORKSPACE_DOMAIN.paths.includes('src/lego/manifest/workspace.json'));
  assert.equal(row('ai.workspace').owner, 'manager', 'the Workspace contract stays manager-owned');
  assert.equal(typeof WORKSPACE_DOMAIN.owner, 'string', 'the workspace domain keeps its registered owner');
});

/* ================================================== B. PROFILE VOCABULARY */

test('the profile vocabulary is exactly sim | local | cloud, quoted from the manifest', () => {
  assert.deepEqual([...PROVIDER_PROFILES], ['sim', 'local', 'cloud']);
  assert.deepEqual([...PROVIDER_PROFILES],
    Object.keys(MANIFEST.providerProfiles.profiles),
    'module and manifest publish byte-identical profile words');
  assert.deepEqual([...PROVIDER_DECLARATION_FIELDS], ['providerId', 'kind', 'profile'],
    'the declaration shape is closed at three fields');
  for (const profile of PROVIDER_PROFILES) {
    const described = describeProviderProfile(profile);
    assert.ok(described, `${profile} is describable`);
    assert.equal(typeof described.summary, 'string');
    assert.ok(described.summary.length > 20, `${profile} states what it means`);
    assert.equal(typeof described.authority, 'string');
    assert.match(described.configRule, /explicit/i, `${profile} keeps configuration explicit`);
  }
  assert.equal(describeProviderProfile('SIM'), null, 'no case-insensitive fallback');
  assert.equal(describeProviderProfile('private'), null, 'a fourth profile does not exist');
  assert.equal(describeProviderProfile(null), null);
});

test('the declaration rule says declared-not-assumed with every hard prohibition present', () => {
  const rule = MANIFEST.providerProfiles.rule;
  assert.ok(typeof rule === 'string' && rule.length > 80);
  for (const claim of [/not assumed/i, /discover/i, /select/i, /credential/i, /explicit/i]) {
    assert.match(rule, claim, `declarationRule must state ${claim}`);
  }
  assert.match(MANIFEST.providerProfiles.profiles.cloud.authority, /never stored/i,
    'cloud authority never becomes a stored credential');
  assert.match(MANIFEST.providerProfiles.profiles.sim.configRule, /never becomes a fallback/i,
    'sim is never the silent default');
  assert.match(MANIFEST.providerProfiles.profiles.local.configRule, /no process or port discovery|never implies trusted/i);
});

test('zero-install still holds beside the profiles: no declaration is the valid not-configured state', () => {
  assert.match(AI_FOUNDATION.zeroInstall.rule, /not an error/i);
  assert.equal(isZeroInstallState({ modelProvider: 'not-configured', toolProvider: 'not-configured', agentRuntime: 'not-configured' }), true);
  assert.deepEqual([...PROVIDER_KINDS],
    ['model-provider', 'tool-provider', 'application-provider', 'agent-runtime', 'simulation-runtime'],
    'profiles add an axis, they do not fork provider kinds');
  assert.deepEqual([...AI_TRANSPORTS], ['in-process', 'worker', 'remote', 'mcp']);
  assert.deepEqual(Object.keys(MANIFEST.providerKinds),
    ['model-provider', 'tool-provider', 'application-provider', 'agent-runtime', 'simulation-runtime']);
});

/* ============================================= C. DECLARATION VALIDATOR */

test('a valid declaration validates, freezes and survives later mutation of the input', () => {
  const input = { providerId: 'prov-main', kind: 'model-provider', profile: 'cloud' };
  const declared = assertProviderDeclaration(input);
  assert.deepEqual(declared, { providerId: 'prov-main', kind: 'model-provider', profile: 'cloud' });
  assert.equal(Object.isFrozen(declared), true);
  input.profile = 'sim';
  assert.equal(declared.profile, 'cloud', 'the declaration is a frozen copy — mutation never rewrites it');
  // every published kind × every profile combination is declarable
  for (const kind of PROVIDER_KINDS) {
    for (const profile of PROVIDER_PROFILES) {
      const d = assertProviderDeclaration({ providerId: 'prov-x', kind, profile });
      assert.deepEqual(d, { providerId: 'prov-x', kind, profile });
    }
  }
});

test('nothing is defaulted: each missing field refuses with the declared-not-assumed message', () => {
  for (const field of PROVIDER_DECLARATION_FIELDS) {
    const input = { ...DECL };
    delete input[field];
    const error = caught(() => assertProviderDeclaration(input));
    assert.ok(error, `${field} missing must refuse`);
    assert.equal(error.code, 'lego.contract_violation');
    assert.equal(error.details.field, field);
    assert.match(error.message, /is required/);
    assert.match(error.message, /declared, never assumed, discovered or selected by default/);
  }
  // and an empty object never becomes a usable provider
  const error = caught(() => assertProviderDeclaration({}));
  assert.ok(error);
  assert.equal(error.details.field, 'providerId');
});

test('kind and profile are exact published words — no synonyms, no case folding, no fourth profile', () => {
  for (const kind of ['model', 'Model-provider', 'model-Provider', 'MCP', 42]) {
    const error = caught(() => assertProviderDeclaration({ ...DECL, kind }));
    assert.equal(error.code, 'lego.contract_violation');
    assert.match(error.message, /published provider kind/);
  }
  for (const profile of ['SIM', 'Cloud', 'private', 'sim ', 'locall']) {
    const error = caught(() => assertProviderDeclaration({ ...DECL, profile }));
    assert.ok(error, `profile ${JSON.stringify(profile)} refuses`);
    assert.equal(error.code, 'lego.contract_violation');
    assert.match(error.message, /sim \| local \| cloud/);
    assert.equal(error.details.reason, 'undeclared-profile');
  }
});

test('the declaration shape is closed and credential fields are refused by name without echoing values', () => {
  const unknown = caught(() => assertProviderDeclaration({ ...DECL, endpoint: 'http://x' }));
  assert.match(unknown.message, /shape is closed/);
  const second = caught(() => assertProviderDeclaration({ ...DECL, availability: 'available' }));
  assert.match(second.message, /shape is closed/,
    'configuration fields belong to the P2.25 adapters — not to the declaration');
  for (const field of ['apiKey', 'token', 'credential', 'credentials', 'authorization', 'headers', 'secret', 'password']) {
    const error = caught(() => assertProviderDeclaration({ ...DECL, [field]: 'super-secret-value-42' }));
    assert.equal(error.code, 'lego.contract_violation');
    assert.equal(error.details.field, field);
    assert.equal(error.details.reason, 'credential-field-refused');
    assert.equal(error.message.includes('super-secret-value-42'), false, 'the value never travels');
  }
  for (const bad of [null, undefined, 'prov-main', 42, ['prov-main']]) {
    const error = caught(() => assertProviderDeclaration(bad));
    assert.match(error.message, /plain object/);
  }
});

test('providerId accepts only opaque bounded references — full-form credentials and paths refuse', () => {
  const fullForms = [
    `ghp_${'A'.repeat(36)}`,
    `github_pat_${'B'.repeat(20)}${'C'.repeat(8)}`,
    `sk-${'x'.repeat(24)}`,
    'Bearer zzzzzzzzzzzzzzzzzzzzzzzz',
    '-----BEGIN RSA PRIVATE KEY-----',
  ];
  for (const providerId of fullForms) {
    const error = caught(() => assertProviderDeclaration({ ...DECL, providerId }));
    assert.ok(error, `credential-shaped providerId refuses: ${providerId.slice(0, 12)}…`);
    assert.equal(error.code, 'lego.contract_violation');
    assert.ok(['credential-shaped-value', 'not-an-opaque-reference'].includes(error.details.reason));
  }
  for (const providerId of ['../escape', '/etc/passwd', '~/secrets', 'x'.repeat(129), 'has space']) {
    const error = caught(() => assertProviderDeclaration({ ...DECL, providerId }));
    assert.ok(error, `non-opaque providerId refuses: ${providerId.slice(0, 20)}`);
    assert.ok(['not-an-opaque-reference', 'credential-shaped-value'].includes(error.details.reason)
      || /bounded identifier/.test(error.message));
  }
  assert.equal(assertProviderDeclaration({ ...DECL, providerId: 'prov-1' }).providerId, 'prov-1');
});

/* =========================================== D. HANDED-OVER ACCESS (GitHub) */

test('a valid handed-over access validates frozen: opaque reference, declared scope, requestId', () => {
  const input = {
    grantReference: 'grant/77',
    scope: ['github.create_pr', 'repo.read'],
    requestId: 'req-1',
  };
  const handoff = assertHandedOverAccess(input);
  assert.deepEqual(handoff, input);
  assert.equal(Object.isFrozen(handoff), true);
  assert.equal(Object.isFrozen(handoff.scope), true);
  input.scope.push('issue.create');
  assert.deepEqual(handoff.scope, ['github.create_pr', 'repo.read'], 'the scope is a frozen copy');
  const wordy = assertHandedOverAccess({
    grantReference: 'apr/9',
    scope: ['pr.create', 'branch.read', 'git.status'],
    requestId: 'x'.repeat(128),
  });
  assert.equal(wordy.requestId.length, 128, 'the requestId bound is inclusive');
});

test('each missing handoff field refuses with its own boundary message', () => {
  const cases = [
    [{ scope: ['repo.read'], requestId: 'r' }, /grantReference is required — access is handed over explicitly, never ambient/],
    [{ grantReference: 'grant/1', requestId: 'r' }, /scope is required — handed-over access is scoped, never global/],
    [{ grantReference: 'grant/1', scope: ['repo.read'] }, /requestId is required — handed-over access is request-bound, never standing/],
  ];
  for (const [input, pattern] of cases) {
    const error = caught(() => assertHandedOverAccess(input));
    assert.ok(error, JSON.stringify(input));
    assert.equal(error.code, 'lego.contract_violation');
    assert.match(error.message, pattern);
  }
  for (const bad of [null, 'grant/1', 7, ['grant/1']]) {
    assert.match(caught(() => assertHandedOverAccess(bad)).message, /plain object/);
  }
});

test('the handoff shape is closed — a standing credential can never ride along', () => {
  const unknown = caught(() => assertHandedOverAccess({
    grantReference: 'grant/1', scope: ['repo.read'], requestId: 'r', repository: 'owner/repo',
  }));
  assert.match(unknown.message, /shape is closed/);
  assert.equal(unknown.details.field, 'repository',
    'global repository authority is not a field of a scoped handoff');
  for (const field of ['apiKey', 'token', 'credential', 'credentials', 'authorization', 'headers', 'secret', 'password']) {
    const error = caught(() => assertHandedOverAccess({
      grantReference: 'grant/1', scope: ['repo.read'], requestId: 'r', [field]: 'hunter2-hunter2-hunter2',
    }));
    assert.equal(error.details.reason, 'credential-field-refused');
    assert.equal(error.message.includes('hunter2'), false, 'values never echo');
    assert.equal(error.details.field, field);
  }
});

test('scope rules: non-empty, bounded, capability words only — tokens and shouty words refuse', () => {
  const base = { grantReference: 'grant/1', requestId: 'r' };
  assert.equal(caught(() => assertHandedOverAccess({ ...base, scope: [] })).details.reason, 'scope-not-scoped');
  assert.equal(caught(() => assertHandedOverAccess({ ...base, scope: 'repo.read' })).details.reason, 'scope-not-scoped');
  const tooMany = Array.from({ length: 33 }, (_, i) => `cap${i}.read`);
  const bounded = caught(() => assertHandedOverAccess({ ...base, scope: tooMany }));
  assert.match(bounded.message, /at most 32/);
  const shouty = caught(() => assertHandedOverAccess({ ...base, scope: ['GitHub.read'] }));
  assert.equal(shouty.details.reason, 'not-a-capability-word');
  const messy = caught(() => assertHandedOverAccess({ ...base, scope: ['repo read'] }));
  assert.equal(messy.details.reason, 'not-a-capability-word');
  const tokenWord = caught(() => assertHandedOverAccess({ ...base, scope: [`ghp_${'A'.repeat(36)}`] }));
  assert.equal(tokenWord.details.reason, 'credential-shaped-value');
  assert.equal(tokenWord.details.field, 'scope');
  const overlong = caught(() => assertHandedOverAccess({ ...base, scope: ['x'.repeat(65)] }));
  assert.ok(overlong);
});

test('raw credentials in grantReference/requestId refuse by FULL form; bare prefixes do not false-positive', () => {
  const scope = ['repo.read'];
  const requestId = 'req-1';
  const fullForms = [
    `ghp_${'A'.repeat(36)}`,
    `github_pat_${'B'.repeat(20)}${'C'.repeat(8)}`,
    `sk-${'x'.repeat(24)}`,
    'Bearer zzzzzzzzzzzzzzzzzzzzzzzz',
    '-----BEGIN RSA PRIVATE KEY-----',
  ];
  for (const grantReference of fullForms) {
    const error = caught(() => assertHandedOverAccess({ grantReference, scope, requestId }));
    assert.ok(error, `raw credential refuses: ${grantReference.slice(0, 12)}…`);
    assert.equal(error.code, 'lego.contract_violation');
  }
  for (const requestIdBad of [`Bearer ${'q'.repeat(30)}`, `ghp_${'A'.repeat(36)}`]) {
    const error = caught(() => assertHandedOverAccess({ grantReference: 'grant/1', scope, requestId: requestIdBad }));
    assert.ok(error);
    assert.ok(['credential-shaped-value'].includes(error.details.reason) || /bounded/.test(error.message));
  }
  // P2.23 lesson: the detector matches canonical shapes, not truncated prefixes
  const bare1 = assertHandedOverAccess({ grantReference: 'sk-x', scope, requestId });
  assert.equal(bare1.grantReference, 'sk-x', "a bare 'sk-' prefix is not a credential shape");
  const bare2 = assertHandedOverAccess({ grantReference: 'ghp_', scope, requestId });
  assert.equal(bare2.grantReference, 'ghp_', "a bare 'ghp_' prefix is not a credential shape");
});

test('the integration access rules are the manifest bytes: handed over, scoped, request-bound, never-four, replaceable', () => {
  assert.deepEqual(INTEGRATION_ACCESS_RULES, MANIFEST.applicationProvider.handedOverAccess,
    'module and manifest publish byte-identical rules');
  assert.match(INTEGRATION_ACCESS_RULES.rule, /handed over/i);
  assert.match(INTEGRATION_ACCESS_RULES.rule, /scoped/i);
  assert.match(INTEGRATION_ACCESS_RULES.rule, /request-bound/i);
  assert.deepEqual([...INTEGRATION_ACCESS_RULES.never], [
    'stored credential',
    'standing GitHub token',
    'global repository authority',
    'implicit account discovery',
  ]);
  assert.match(INTEGRATION_ACCESS_RULES.replaceable, /replaceable/);
  assert.match(INTEGRATION_ACCESS_RULES.replaceable, /built-in dependency of every plugin/);
  assert.match(INTEGRATION_ACCESS_RULES.decides, /ai\.approval/i);
  assert.match(INTEGRATION_ACCESS_RULES.decides, /configuration is never authority/);
});

test('the application-provider boundary still says GitHub is ONE capability set on two paths', () => {
  const app = MANIFEST.applicationProvider;
  assert.match(app.firstClassRule, /native/i);
  assert.match(app.firstClassRule, /gateway/i);
  assert.equal(app.exampleCapabilities.application, 'github');
  assert.match(app.exampleCapabilities.note, /No GitHub client is implemented here/);
  const ids = app.exampleCapabilities.capabilities.map((c) => c.id);
  for (const id of ['repo.read', 'repo.write', 'pr.create', 'branch.read', 'issue.create']) {
    assert.ok(ids.includes(id), `github example declares ${id}`);
  }
  for (const capability of app.exampleCapabilities.capabilities) {
    assert.match(capability.permission, /^app:github:(read|write|receive)$/);
    assert.ok(['read-only', 'writes', 'external'].includes(capability.sideEffects));
  }
});

test('the lego-set keeps github.create_pr contract-only: external side effects, approval required, not workspace-scoped', () => {
  const entry = LEGO_SET.externalActionModel.examples.find((e) => e.capability === 'github.create_pr');
  assert.ok(entry, 'the capability boundary is declared');
  assert.equal(entry.sideEffects, 'external');
  assert.equal(entry.approval, 'required');
  assert.equal(entry.workspaceScoped, false);
  assert.match(LEGO_SET.externalActionModel.status, /contract-only/);
  // sibling workspace-scoped primitives keep their own scoping (git.* stays inside a workspace)
  for (const cap of ['git.status', 'git.diff', 'git.commit', 'browser.open']) {
    const e = LEGO_SET.externalActionModel.examples.find((x) => x.capability === cap);
    assert.ok(e, `${cap} still declared`);
    assert.equal(e.workspaceScoped, true, `${cap} remains workspace-scoped`);
  }
});

/* ============================================= E. WORKSPACE BOUNDARY */

test('the Workspace contract is untouched: same row, same version, same exports, same ops and permissions', () => {
  const r = row('ai.workspace');
  assert.ok(r, 'the Workspace row exists');
  assert.equal(r.version, '1.0.0');
  assert.equal(r.status, 'implemented');
  assert.deepEqual([...r.operations],
    ['workspace.create', 'workspace.describe', 'workspace.mount', 'workspace.release']);
  assert.deepEqual([...r.permissions], ['ai:workspace:read', 'ai:workspace:create']);
  const locked = r.exports['src/lego/workspace.mjs'];
  assert.deepEqual([...locked].sort(), Object.keys(workspaceModule).sort(),
    'module ⇄ lock exports byte-parity — no second Workspace surface grew here');
  assert.equal(workspaceModule.WORKSPACE_CONTRACT.id, 'ai.workspace');
  assert.equal(workspaceModule.WORKSPACE_CONTRACT.version, '1.0.0');
  assert.equal(Object.isFrozen(workspaceModule.WORKSPACE_CONTRACT), true);
  assert.deepEqual([...workspaceModule.WORKSPACE_KINDS],
    ['LOCAL', 'CONTAINER', 'REMOTE', 'VPS', 'EPHEMERAL', 'PERSISTENT']);
  assert.deepEqual([...workspaceModule.WORKSPACE_LIFECYCLE.states],
    ['declared', 'created', 'mounted', 'active', 'released']);
});

test('there is exactly one Workspace implementation in the backend', () => {
  const legoDir = join(REPO_ROOT, 'apps', 'n8n-lego', 'src', 'lego');
  const owners = [];
  for (const name of readdirSync(legoDir)) {
    if (!name.endsWith('.mjs')) continue;
    const source = readFileSync(join(legoDir, name), 'utf8');
    if (/export (?:function|const) createWorkspaceManager/.test(source)) owners.push(name);
  }
  assert.deepEqual(owners, ['workspace.mjs'],
    'a second createWorkspaceManager would be a second Workspace implementation');
});

test('no boundary introduced filesystem/shell/subprocess/network authority', () => {
  // the new module: only the two foundation quotes, no node:*, no console, no clock
  const imports = [...PD_SRC.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./ai-foundation.mjs', './token-usage.mjs'],
    'provider-declaration depends on the foundation vocabulary only');
  assert.equal(/from 'node:/.test(PD_SRC), false, 'no node:* import');
  assert.equal(/console\.(log|error|warn|info|debug)/.test(PD_SRC), false);
  assert.equal(/Date\.now\(|new Date\(|Math\.random\(/.test(PD_SRC), false,
    'no clock or identity is minted at a boundary');
  assert.equal(/child_process|execSync|spawnSync|node:http|node:net|node:https/.test(PD_SRC), false);
  // the Workspace module keeps its manifest read and gains no shell/network
  assert.equal(/node:child_process|node:http|node:https|node:net/.test(WS_SRC), false,
    'Workspace never grew shell, subprocess or network authority');
});

test('no GitHub client exists anywhere under src/lego — the integration stays replaceable', () => {
  const legoDir = join(REPO_ROOT, 'apps', 'n8n-lego', 'src', 'lego');
  for (const name of readdirSync(legoDir, { recursive: true })) {
    const asName = String(name);
    if (!asName.endsWith('.mjs') && !asName.endsWith('.json')) continue;
    const source = readFileSync(join(legoDir, asName), 'utf8');
    assert.equal(/github\.com/.test(source), false, `${asName} must not name a GitHub endpoint`);
    assert.equal(/from 'node:https'/.test(source), false, `${asName} must not import an HTTPS client`);
  }
});

/* ==================================== F. FOUNDATION-READINESS RE-VERIFICATION */

test('every P2.16–P2.25 milestone is still complete with intact start/finish evidence', async () => {
  const ids = ['P2.16', 'P2.17', 'P2.18', 'P2.19', 'P2.20', 'P2.21', 'P2.22', 'P2.23', 'P2.24', 'P2.25'];
  for (const id of ids) {
    const milestone = BY_ID.get(id);
    assert.ok(milestone, `${id} row exists`);
    assert.equal(milestone.status, 'complete', `${id} stays complete`);
    assert.ok(milestone.startEvidence && milestone.startEvidence.commit, `${id} start evidence intact`);
    assert.ok(milestone.finishEvidence && milestone.finishEvidence.protectedMain, `${id} finish evidence intact`);
    assert.ok(Object.keys(milestone.finishEvidence).length > 0);
  }
  // historical chain anchors named by the register corrections
  assert.equal(BY_ID.get('P2.25').finishEvidence.protectedMain, '9cc6ba889790a814cdbf23768f1d4f734306b22e');
  assert.equal(BY_ID.get('P2.25').finishEvidence.pr, 71);
  assert.equal(BY_ID.get('P2.24').finishEvidence.protectedMain, 'a409d9301247078aaadb4883dd9cb1082928ac82');
  assert.equal(BY_ID.get('P2.23').startEvidence.commit, 'ab4a589821e247ed181a91b54ad8c2d39d83eeb1',
    'the P2.23 start anchor from the standing corrections stays exact');
  // pointers: current is P2.26 and the baseline correction from §0 landed
  assert.equal(REGISTER.currentMilestone, 'P2.27');
  assert.equal(REGISTER.previousCompletedMilestone, 'P2.26');
  const p226 = BY_ID.get('P2.26');
  assert.equal(p226.status, 'complete', 'P2.26 closed via PR #73 (completion transition)');
  assert.equal(p226.finishEvidence.protectedMain, '6d70bcfb22b2cea7993d4ce42b59991528a7dc78');
  assert.equal(p226.finishEvidence.pr, 73);
  assert.equal(p226.startEvidence.commit, D15, 'P2.26 starts from the P2.25 completion transition (§0)');
  assert.match(p226.startEvidence.role, /9cc6ba88 stays P2\.25 implementation evidence/,
    'the correction documents the distinction instead of hiding it');
});

test('P2.27 is the current administrative milestone with authorized implementation and a terminating chain', () => {
  const p227 = BY_ID.get('P2.27');
  assert.ok(p227, 'the reservation row exists');
  assert.equal(p227.status, 'complete', 'closed on protected main via PR #197 (completion transition: slices P2.27.0-P2.27.10 all merged and post-merge verified)');
  assert.equal(p227.finishEvidence.protectedMain, '7d4eae8d34f70eb03ec413486a5f5c5318048d4d');
  assert.equal(p227.finishEvidence.pr, 197, 'the finish evidence names the final slice PR');
  assert.match(p227.implementationBoundary, /AUTHORIZED by the dedicated P2\.27 Master Prompt/, 'the reservation is lifted by the dedicated prompt');
  assert.ok(!/NO P2\.27 IMPLEMENTATION IS STARTED/.test(p227.implementationBoundary), 'the lifted boundary no longer claims zero implementation');
  assert.ok(p227.deliverables.length >= 5);
  assert.ok(p227.completionCriteria.length >= 15, 'the §38 acceptance list is on the row');
  assert.ok(p227.decisionDependencies.length >= 1, 'authorized row records its placement/duplication decisions');
  for (const decision of p227.decisionDependencies) assert.ok(typeof decision === 'string' && decision.length > 10);
  for (const dependency of p227.dependencies) {
    const ids = dependency.match(/P\d+\.\d+/g) ?? [];
    assert.ok(ids.length > 0, `dependency names a milestone: ${dependency}`);
    for (const id of ids) assert.ok(BY_ID.has(id), `${id} resolves in the register`);
  }
  assert.equal(REGISTER.currentMilestone, 'P2.27', 'the completion transition advanced the pointer');
  assert.equal(BY_ID.get('P2.26').nextMilestone, 'P2.27', 'chain rewired by the completion transition only');
  assert.equal(BY_ID.get('P2.27').nextMilestone, 'P2.17+', 'P2.27 still terminates into the residual ladder');
  // design document exists, is planning-only and contains no implementation code fence for plugins
  const design = read('docs/n8n-lego/P2.27-PLUGIN-RUNTIME-DESIGN.md');
  assert.match(design, /STATUS \(2026-09-24\): AUTHORIZED/, 'the design doc carries the authorization');
  assert.match(design, /PLANNING \/ DESIGN ONLY/);  // preserved historical banner
  assert.match(design, /NO P2\.27 IMPLEMENTATION IS STARTED/);
  assert.match(design, /current administrative/);
  assert.match(design, /canonical status `in-progress`/);
  assert.match(design, /implementation = ZERO/i, 'the historical reservation self-check line is preserved');
  assert.match(design, /secret broker/i);
  assert.match(design, /deny-by-default/i);
  assert.match(design, /QUARANTINED/);
  assert.equal(/```(js|javascript|ts|typescript)/.test(design), false, 'no implementation code in the design doc');
  // P2.27 landed the tiny core (.1), secrets broker (.5 under plugin-secrets.mjs)
  // and the supervisor (.7); the remaining named artifacts are non-milestone or
  // future-slice scoped — each lands only with its dedicated slice assertion.
  const legoDir = join(REPO_ROOT, 'apps', 'n8n-lego', 'src', 'lego');
  const names = readdirSync(legoDir);
  for (const forbidden of ['plugin-manager.mjs', 'secret-broker.mjs', 'wasm-runtime.mjs']) {
    assert.equal(names.includes(forbidden), false, `${forbidden} lands with its dedicated slice, not before`);
  }
});

/* ======================================== G. HONESTY / ERROR / FREEZE */

test('the honesty list grew honestly: still contract-only, claims preserved, new claims added', () => {
  assert.equal(MANIFEST.status, 'contract-only');
  assert.ok(MANIFEST.notImplemented.length >= 5);
  const text = MANIFEST.notImplemented.join(' ').toLowerCase();
  for (const claim of ['inference', 'mcp', 'agent runtime']) {
    assert.ok(text.includes(claim), `the honesty list still mentions '${claim}'`);
  }
  assert.ok(text.includes('no github client'), 'P2.26 adds the GitHub-boundary honesty claim');
  assert.ok(text.includes('no provider discovery'), 'P2.26 adds the no-discovery claim');
  assert.equal(MANIFEST.version, '1.0.0', 'additive manifest sections do not bump the contract version');
});

test('one error family: lego.contract_violation is published; details redact credential-shaped values', () => {
  assert.equal(ERRORS.version, '1.2.0', 'the errors contract stays untouched');
  const published = new Set((ERRORS.codes ?? ERRORS.errors ?? []).map((entry) => entry.code ?? entry.id));
  assert.ok(published.size > 0, 'the published set loads');
  assert.equal(published.has('lego.contract_violation'), true);
  // every lego.* code quoted in the new module is published (F16 discipline, asserted locally)
  for (const match of PD_SRC.matchAll(/'(lego\.[a-z0-9_]+)'/g)) {
    assert.ok(published.has(match[1]), `${match[1]} is published`);
  }
  // redaction: a credential-shaped detail value never survives construction
  const error = new ProviderDeclarationError('boundary refused', {
    field: 'x',
    note: `ghp_${'A'.repeat(36)}`,
  });
  assert.equal(error.code, 'lego.contract_violation');
  assert.equal(error.name, 'ProviderDeclarationError');
  assert.equal(error.details.note, '[redacted]');
  assert.equal(error.details.field, 'x');
  assert.equal(Object.isFrozen(error.details), true);
  const normal = new ProviderDeclarationError('plain', { field: 'profile' });
  assert.equal(normal.details.field, 'profile');
});

test('the ai-set register mirror was not silently rewritten by this milestone', () => {
  // Post-Issue #81 governance reconcile (PR against f63a91e7): the set mirror is
  // intentionally brought back in line with the canonical register — both now
  // name P2.27 and the same protected-main baseline. The mirror is still not the
  // authority: ai-pack prefers milestones.json; this asserts they agree after the
  // explicit reconcile rather than a milestone silently diverging them again.
  assert.equal(LEGO_SET.currentMilestone, 'P2.27',
    'the set mirror was reconciled to the canonical pointer (Issue #81)');
  assert.equal(REGISTER.currentMilestone, 'P2.27');
  assert.equal(LEGO_SET.mainBaseline, REGISTER.mainBaseline,
    'set mirror and register share the same protected-main baseline after reconcile');
  // Governance reset (#256): both pointers moved together to protected main fc54c8c2 (#257).
  assert.equal(REGISTER.mainBaseline, 'fc54c8c2bfc2557ddecf466e662869f197fc9595');
  assert.match(LEGO_SET.statusNote, /P2\.27/);
});
