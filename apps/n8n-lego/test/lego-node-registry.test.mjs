/**
 * P6.1 — Canonical Node Registry Contract.
 *
 * Matrix: identity (`type` + `typeVersion`, and nothing else — §P6.1 acceptance),
 * deterministic schema (equal declarations, equal digests, whatever the key or
 * capability order), explicit required fields, fail-closed validation for every
 * unknown value (trust, capability, runtime locality, lifecycle, health,
 * provenance, resource class, compatibility target, discovery group, unknown
 * field), duplicate-identity refusal with no partial publication, and the static
 * walls: no filesystem, no network, no process, no timers, no local clock — one
 * module, one contract, vocabulary quoted from the foundation rather than
 * re-declared, and no authority of any kind.
 *
 * Authentic compatibility fixtures come from the pinned catalog
 * (`n8n-nodes-base@2.9.1`, 483 node types, 90 of them multi-version): real node
 * versions include 1.1 … 4.4, so the identity rule is measured, not assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NODE_CAPABILITIES,
  NODE_COMPATIBILITY_KINDS,
  NODE_CONCURRENCY_MODES,
  NODE_DISCOVERY_GROUPS,
  NODE_FAILURE_BOUNDARIES,
  NODE_HEALTH_STATES,
  NODE_IDENTITY_RE,
  NODE_LIFECYCLE_STATES,
  NODE_PROVENANCE_KINDS,
  NODE_REGISTRY_CONTRACT,
  NODE_REGISTRY_CONTRACT_VERSION,
  NODE_REGISTRY_FIELDS,
  NODE_REGISTRY_OPERATIONS,
  NODE_REGISTRY_OPTIONAL_FIELDS,
  NODE_REGISTRY_PERMISSIONS,
  NODE_REGISTRY_REASONS,
  NODE_REGISTRY_REQUIRED_FIELDS,
  NODE_REGISTRY_RULES,
  NODE_REGISTRY_SCHEMA_VERSION,
  NODE_REGISTRY_VOCABULARY_SOURCE,
  NODE_RESOURCE_CLASSES,
  NODE_RESOURCE_FIELDS,
  NODE_RUNTIME_LOCALITIES,
  NODE_TRUST_CLASSES,
  NODE_TYPE_ID_RE,
  NODE_TYPE_VERSION_RE,
  NodeRegistryError,
  RUNTIME_LOCALITY_MODEL,
  canonicalNodeRegistryDeclaration,
  indexNodeRegistryDeclarations,
  isNodeTypeId,
  isNodeTypeVersion,
  nodeIdentity,
  nodeRegistryDeclarationDigest,
  parseNodeIdentity,
  validateNodeIdentity,
  validateNodeRegistryDeclaration,
} from '../src/lego/node-registry.mjs';
import { CAPABILITIES, TRUST_LEVELS } from '../src/lego/foundation.mjs';
import { PORTABILITY_TARGETS } from '../src/lego/node-portability.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = resolve(HERE, '..', 'src', 'lego', 'node-registry.mjs');
const SOURCE = readFileSync(MODULE_PATH, 'utf8');

/** A declaration that is valid by construction; tests break one thing at a time. */
function declaration(overrides = {}) {
  return {
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.4,
    package: 'n8n-nodes-base',
    packageVersion: '2.9.1',
    vendor: 'n8n',
    contractVersion: '0.1.0',
    implementationVersion: '0.1.0',
    digest: `sha256:${'a'.repeat(64)}`,
    provenance: { kind: 'package-registry', source: 'npm:n8n-nodes-base@2.9.1' },
    capabilities: ['network'],
    trustClass: 'core',
    runtimeLocality: 'js-compat',
    resourceProfile: {
      cpu: 'low', memory: 'medium', disk: 'none', network: true, concurrency: 'parallel-safe', startup: 'fast',
    },
    compatibility: { contractRange: '^0.1.0', portabilityTargets: ['JS'] },
    lifecycle: 'declared',
    health: 'unknown',
    discovery: { displayName: 'HTTP Request', group: 'input', description: 'Makes an HTTP request' },
    ...overrides,
  };
}

/* ---------------------------------------------------------------- contract */

test('the contract identifies itself and is versioned', () => {
  assert.equal(NODE_REGISTRY_CONTRACT, 'node.registry@0.1.0');
  assert.equal(NODE_REGISTRY_CONTRACT_VERSION, '0.1.0');
  assert.ok(Number.isInteger(NODE_REGISTRY_SCHEMA_VERSION) && NODE_REGISTRY_SCHEMA_VERSION >= 1);
  assert.deepEqual([...NODE_REGISTRY_OPERATIONS], ['validate', 'canonicalize', 'index']);
  assert.ok(NODE_REGISTRY_PERMISSIONS.every((word) => typeof word === 'string'));
  // A declaration without any required field is still a node declaration shape.
  assert.equal(NODE_REGISTRY_REQUIRED_FIELDS.length, NODE_REGISTRY_FIELDS.length);
  assert.ok(NODE_REGISTRY_REQUIRED_FIELDS.includes('digest'));
  assert.deepEqual([...NODE_REGISTRY_OPTIONAL_FIELDS], ['notes']);
});

test('the refusal vocabulary is closed and complete', () => {
  assert.ok(NODE_REGISTRY_REASONS.length >= 12);
  assert.equal(new Set(NODE_REGISTRY_REASONS).size, NODE_REGISTRY_REASONS.length);
  for (const reason of NODE_REGISTRY_REASONS) assert.match(reason, /^registry\.[a-z]+$/);
});

/* ---------------------------------------------------------------- identity */

test('identity is type + typeVersion, rendered the way n8n and the catalog write it', () => {
  assert.equal(nodeIdentity({ type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4 }), 'n8n-nodes-base.httpRequest@4.4');
  assert.equal(nodeIdentity({ type: 'n8n-nodes-base.set', typeVersion: 3 }), 'n8n-nodes-base.set@3');
  assert.deepEqual(parseNodeIdentity('n8n-nodes-base.httpRequest@4.4'), { type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4 });
  assert.deepEqual(parseNodeIdentity('n8n-nodes-base.set@3'), { type: 'n8n-nodes-base.set', typeVersion: 3 });
  assert.match('n8n-nodes-base.httpRequest@4.4', NODE_IDENTITY_RE);
});

test('scoped community/langchain node type ids are valid identities', () => {
  assert.ok(isNodeTypeId('@n8n/n8n-nodes-langchain.agent'));
  assert.equal(nodeIdentity({ type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1 }), '@n8n/n8n-nodes-langchain.agent@1');
  assert.ok(NODE_IDENTITY_RE.test('@n8n/n8n-nodes-langchain.agent@1'));
});

test('invalid identities fail closed, each with the identity reason', () => {
  const invalid = [
    { type: 'n8n-nodes-base', typeVersion: 4 },                    // no node segment
    { type: 'n8n-nodes-base.httpRequest', typeVersion: 0 },         // version 0
    { type: 'n8n-nodes-base.httpRequest', typeVersion: 4.44 },      // two decimals — not an n8n version
    { type: 'n8n-nodes-base.httpRequest', typeVersion: -1 },
    { type: 'n8n-nodes-base.httpRequest', typeVersion: 'latest' },
    { type: 'N8N-NODES-BASE.httpRequest', typeVersion: 4 },         // not canonical casing
    { type: 'n8n-nodes-base.hTtp.Request', typeVersion: 4 },        // second dot inside the node segment
    { type: 42, typeVersion: 4 },
    {},
  ];
  for (const identity of invalid) {
    const result = validateNodeIdentity(identity);
    assert.equal(result.ok, false, `expected ${JSON.stringify(identity)} to be refused`);
    assert.ok(result.errors.some((error) => error.code === 'registry.identity'));
    assert.throws(() => nodeIdentity(identity), NodeRegistryError);
  }
  for (const identity of ['n8n-nodes-base.httpRequest', 'n8n-nodes-base.httpRequest@', 'httpRequest@4', 'n8n-nodes-base.httpRequest@4.44']) {
    assert.equal(parseNodeIdentity(identity), null);
  }
});

test('identity survives an implementation change: same identity, different digest', () => {
  const js = declaration();
  const rust = declaration({
    runtimeLocality: 'rust-native',
    vendor: 'community:acme',
    trustClass: 'community',
    capabilities: ['network', 'filesystem'],
    package: 'n8n-nodes-acme',
    packageVersion: '1.2.3',
  });
  assert.equal(nodeIdentity(js), nodeIdentity(rust));
  assert.notEqual(nodeRegistryDeclarationDigest(js), nodeRegistryDeclarationDigest(rust));
});

test('node version helpers accept the versions the pinned catalog actually uses', () => {
  // Measured from `n8n-nodes-base@2.9.1`: fractional versions exist (1.1 … 4.4)
  // and 90 of 483 node types declare several versions at once.
  const catalogVariants = [
    { type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4 },
    { type: 'n8n-nodes-base.httpRequest', typeVersion: 3 },
    { type: 'n8n-nodes-base.airtable', typeVersion: 2.1 },
    { type: 'n8n-nodes-base.set', typeVersion: 3.4 },
    { type: 'n8n-nodes-base.merge', typeVersion: 3.2 },
  ];
  for (const identity of catalogVariants) {
    assert.equal(validateNodeIdentity(identity).ok, true, `expected ${identity.type}@${identity.typeVersion} to be valid`);
    assert.ok(NODE_IDENTITY_RE.test(nodeIdentity(identity)));
  }
  for (const version of [1, 4, 4.4, '4', '2.1']) assert.ok(isNodeTypeVersion(version), `${version} must be a node version`);
  for (const version of [0, 4.44, -2, '4.4.0', '']) assert.equal(isNodeTypeVersion(version), false, `${version} must not be a node version`);
  assert.equal(isNodeTypeVersion(Number.NaN), false);
});

/* ------------------------------------------------------------- vocabulary */

test('the vocabulary is quoted from the foundation, never re-declared', () => {
  assert.deepEqual([...NODE_TRUST_CLASSES], [...TRUST_LEVELS]);
  assert.deepEqual([...NODE_CAPABILITIES], [...CAPABILITIES]);
  assert.ok(NODE_TRUST_CLASSES.includes('untrusted'));
  assert.ok(NODE_CAPABILITIES.includes('native'));

  // Runtimes come from foundation.json — and the prose key `selectionRule` is
  // not a runtime.
  assert.deepEqual([...NODE_RUNTIME_LOCALITIES], ['js-compat', 'remote-worker', 'rust-native', 'wasm']);
  assert.equal(NODE_RUNTIME_LOCALITIES.includes('selectionRule'), false);

  assert.ok(NODE_LIFECYCLE_STATES.includes('declared'));
  assert.ok(NODE_LIFECYCLE_STATES.includes('active'));
  assert.ok(NODE_FAILURE_BOUNDARIES.includes('in-process-safe'));
  assert.deepEqual([...NODE_RESOURCE_FIELDS], ['cpu', 'memory', 'disk', 'network', 'concurrency', 'startup']);
  assert.deepEqual(Object.keys(NODE_RESOURCE_CLASSES).sort(), ['cpu', 'disk', 'memory', 'startup']);
});

test('the locality model maps the conceptual model onto runtimes that exist', () => {
  assert.deepEqual(RUNTIME_LOCALITY_MODEL.map((entry) => entry.locality), ['IN_PROCESS', 'WASM', 'ISOLATED_PROCESS', 'REMOTE']);
  for (const entry of RUNTIME_LOCALITY_MODEL) {
    assert.ok(NODE_RUNTIME_LOCALITIES.includes(entry.runtime), `${entry.runtime} must be a foundation runtime`);
    assert.ok(NODE_FAILURE_BOUNDARIES.includes(entry.failureBoundary));
    assert.ok(entry.portabilityTargets.length > 0);
    for (const target of entry.portabilityTargets) assert.ok(PORTABILITY_TARGETS.includes(target), `${target} must be a portability target`);
    assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.portabilityTargets));
  }
});

test('the published invariants say what the rulebook says', () => {
  for (const key of ['identity', 'authority', 'trust', 'capability', 'locality', 'resources', 'closure', 'determinism', 'residency']) {
    assert.equal(typeof NODE_REGISTRY_RULES[key], 'string', `${key} rule must be stated`);
  }
  assert.match(NODE_REGISTRY_RULES.authority, /grant no trust/);
  assert.match(NODE_REGISTRY_RULES.closure, /refused/);
});

/* ------------------------------------------------- valid declarations pass */

test('a complete declaration validates, and JSON round-trips unchanged', () => {
  const result = validateNodeRegistryDeclaration(declaration());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);

  const minimalCapabilities = declaration({ capabilities: [] });
  assert.equal(validateNodeRegistryDeclaration(minimalCapabilities).ok, true, 'a node may declare that it needs nothing');

  const withNotes = declaration({ notes: 'pinned to the reference catalog' });
  assert.equal(validateNodeRegistryDeclaration(withNotes).ok, true);

  const attested = declaration({ provenance: { kind: 'attested-build', source: 'builder:laptop-1', attestationRef: 'att:1' } });
  assert.equal(validateNodeRegistryDeclaration(attested).ok, true);
});

/* ------------------------------------------ fail-closed on unknown values */

test('every unknown value is refused with its own reason', () => {
  const cases = [
    [{ trustClass: 'trusted-because-rust' }, 'registry.trust'],
    [{ capabilities: ['network', 'gpu'] }, 'registry.capability'],
    [{ runtimeLocality: 'kubernetes' }, 'registry.locality'],
    [{ lifecycle: 'serving' }, 'registry.lifecycle'],
    [{ health: 'immortal' }, 'registry.health'],
    [{ digest: 'md5:abc' }, 'registry.digest'],
    [{ contractVersion: 'v1' }, 'registry.version'],
    [{ implementationVersion: '1.0' }, 'registry.version'],
    [{ provenance: { kind: 'verified-by-vibes', source: 'x' } }, 'registry.provenance'],
    [{ provenance: { kind: 'attested-build', source: 'x' } }, 'registry.provenance'],
    [{ capabilities: 'network' }, 'registry.capability'],
    [{ trustClass: 'CORE' }, 'registry.trust'],
  ];
  for (const [overrides, reason] of cases) {
    const result = validateNodeRegistryDeclaration(declaration(overrides));
    assert.equal(result.ok, false, `expected ${JSON.stringify(overrides)} to be refused`);
    assert.ok(result.errors.some((error) => error.code === reason), `expected reason ${reason}, got ${JSON.stringify(result.errors.map((error) => error.code + ':' + error.field))}`);
  }
});

test('unknown fields are refused — the schema is closed, not extensible by accident', () => {
  const result = validateNodeRegistryDeclaration(declaration({ computedTrust: true }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'registry.field' && error.field === 'computedTrust'));
});

test('each missing required field is reported, with the list of what is required', () => {
  for (const field of NODE_REGISTRY_FIELDS) {
    const broken = declaration();
    delete broken[field];
    const result = validateNodeRegistryDeclaration(broken);
    assert.equal(result.ok, false, `removing '${field}' must be refused`);
    assert.ok(
      result.errors.some((error) => error.field === field),
      `expected a problem on '${field}', got ${JSON.stringify(result.errors)}`,
    );
  }
});

test('resource profiles are validated against the quoted classes', () => {
  const broken = [
    declaration({ resourceProfile: { cpu: 'low', memory: 'medium', disk: 'none', network: true, concurrency: 'parallel-safe' } }),
    declaration({ resourceProfile: { cpu: 'infinite', memory: 'medium', disk: 'none', network: true, concurrency: 'parallel-safe', startup: 'fast' } }),
    declaration({ resourceProfile: { cpu: 'low', memory: 'medium', disk: 'none', network: 'yes', concurrency: 'parallel-safe', startup: 'fast' } }),
    declaration({ resourceProfile: { cpu: 'low', memory: 'medium', disk: 'none', network: true, concurrency: 'always', startup: 'fast' } }),
    declaration({ resourceProfile: { cpu: 'low', memory: 'medium', disk: 'none', network: true, concurrency: 'parallel-safe', startup: 'fast', gpu: 'high' } }),
  ];
  for (const brokenDeclaration of broken) {
    const result = validateNodeRegistryDeclaration(brokenDeclaration);
    assert.equal(result.ok, false, `expected ${JSON.stringify(brokenDeclaration.resourceProfile)} to be refused`);
    assert.ok(result.errors.some((error) => error.code === 'registry.resource'));
  }
  assert.ok(NODE_CONCURRENCY_MODES.includes('queueable'));
});

test('compatibility profiles are validated without resolving anything', () => {
  const cases = [
    declaration({ compatibility: { contractRange: 'latest', portabilityTargets: ['JS'] } }),
    declaration({ compatibility: { contractRange: '^0.1.0', portabilityTargets: [] } }),
    declaration({ compatibility: { contractRange: '^0.1.0', portabilityTargets: ['GO'] } }),
    declaration({ compatibility: { contractRange: '^0.1.0', portabilityTargets: ['JS'], kinds: ['probably-fine'] } }),
  ];
  for (const broken of cases) {
    const result = validateNodeRegistryDeclaration(broken);
    assert.equal(result.ok, false, `expected ${JSON.stringify(broken.compatibility)} to be refused`);
    assert.ok(result.errors.some((error) => error.code === 'registry.compatibility'));
  }
  assert.ok(NODE_COMPATIBILITY_KINDS.includes('migration-required'));
  assert.equal(validateNodeRegistryDeclaration(declaration({ compatibility: { contractRange: '*', portabilityTargets: ['JS', 'WASM'] } })).ok, true);
});

test('discovery metadata keeps the n8n editor contract', () => {
  const cases = [
    declaration({ discovery: { group: 'input' } }),
    declaration({ discovery: { displayName: '  ', group: 'input' } }),
    declaration({ discovery: { displayName: 'HTTP Request', group: 'network' } }),
    declaration({ discovery: { displayName: 'HTTP Request', group: 'input', keywords: 'http' } }),
  ];
  for (const broken of cases) {
    const result = validateNodeRegistryDeclaration(broken);
    assert.equal(result.ok, false, `expected ${JSON.stringify(broken.discovery)} to be refused`);
    assert.ok(result.errors.some((error) => error.code === 'registry.discovery'));
  }
  assert.deepEqual([...NODE_DISCOVERY_GROUPS], ['input', 'output', 'organization', 'schedule', 'transform', 'trigger']);
});

test('validation never throws for malformed input — it reports', () => {
  for (const value of [null, undefined, 42, 'node', [], new Date()]) {
    const result = validateNodeRegistryDeclaration(value);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  }
});

/* ------------------------------------------------------------- determinism */

test('canonical form is order-insensitive for keys, capabilities and targets', () => {
  const first = declaration();
  const second = declaration({
    capabilities: ['network'],
    compatibility: { portabilityTargets: ['JS'], contractRange: '^0.1.0' },
    resourceProfile: { startup: 'fast', concurrency: 'parallel-safe', network: true, disk: 'none', memory: 'medium', cpu: 'low' },
  });
  assert.equal(nodeRegistryDeclarationDigest(first), nodeRegistryDeclarationDigest(second));

  const shuffled = {};
  for (const key of Object.keys(first).reverse()) shuffled[key] = first[key];
  assert.equal(nodeRegistryDeclarationDigest(shuffled), nodeRegistryDeclarationDigest(first));

  const manyCapabilitiesA = declaration({ capabilities: ['network', 'filesystem', 'env'] });
  const manyCapabilitiesB = declaration({ capabilities: ['env', 'network', 'filesystem'] });
  assert.equal(nodeRegistryDeclarationDigest(manyCapabilitiesA), nodeRegistryDeclarationDigest(manyCapabilitiesB));

  const canonical = canonicalNodeRegistryDeclaration(first);
  assert.ok(Object.isFrozen(canonical));
  assert.deepEqual(canonical.capabilities, ['network']);
});

test('a changed declaration changes the digest', () => {
  const base = nodeRegistryDeclarationDigest(declaration());
  assert.notEqual(base, nodeRegistryDeclarationDigest(declaration({ typeVersion: 4.3 })));
  assert.notEqual(base, nodeRegistryDeclarationDigest(declaration({ capabilities: ['network', 'filesystem'] })));
  assert.notEqual(base, nodeRegistryDeclarationDigest(declaration({ health: 'healthy' })));
  assert.match(base, /^sha256:[0-9a-f]{64}$/);
});

/* ------------------------------------------------------------------ index */

test('the index is deterministic and publishes nothing until every entry is valid', () => {
  const declarations = [
    declaration({ type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4 }),
    declaration({ type: 'n8n-nodes-base.set', typeVersion: 3.4 }),
    declaration({ type: 'n8n-nodes-base.airtable', typeVersion: 2.1 }),
  ];
  const index = indexNodeRegistryDeclarations(declarations);
  assert.equal(index.ok, true);
  assert.equal(index.count, 3);
  assert.deepEqual(index.identities, ['n8n-nodes-base.airtable@2.1', 'n8n-nodes-base.httpRequest@4.4', 'n8n-nodes-base.set@3.4']);
  assert.match(index.indexDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(index.schemaVersion, NODE_REGISTRY_SCHEMA_VERSION);
  assert.ok(Object.isFrozen(index.byIdentity));
  assert.equal(index.byIdentity['n8n-nodes-base.set@3.4'].declaration.type, 'n8n-nodes-base.set');

  const reversed = indexNodeRegistryDeclarations([...declarations].reverse());
  assert.equal(reversed.indexDigest, index.indexDigest, 'declaration order must not change the index identity');

  const oneBroken = indexNodeRegistryDeclarations([...declarations, declaration({ type: 'n8n-nodes-base.nope', typeVersion: 1, trustClass: 'vibes' })]);
  assert.equal(oneBroken.ok, false);
  assert.equal(oneBroken.count, 0);
  assert.equal(oneBroken.byIdentity, null, 'no partial publication');
  assert.equal(oneBroken.indexDigest, null);
  assert.ok(oneBroken.errors.some((error) => error.code === 'registry.trust' && error.position === 3));
});

test('a duplicate identity is a conflict, not a precedence rule', () => {
  const index = indexNodeRegistryDeclarations([
    declaration({ runtimeLocality: 'js-compat' }),
    declaration({ runtimeLocality: 'rust-native' }),
  ]);
  assert.equal(index.ok, false);
  const duplicate = index.errors.find((error) => error.code === 'registry.duplicate');
  assert.ok(duplicate, 'expected registry.duplicate');
  assert.match(duplicate.message, /n8n-nodes-base\.httpRequest@4\.4/);
  assert.match(duplicate.message, /positions 0 and 1/);
  assert.equal(index.byIdentity, null);
});

test('the index API refuses non-arrays instead of guessing', () => {
  for (const value of [null, undefined, {}, 'declarations']) {
    assert.throws(() => indexNodeRegistryDeclarations(value), NodeRegistryError);
  }
  const empty = indexNodeRegistryDeclarations([]);
  assert.equal(empty.ok, true);
  assert.equal(empty.count, 0);
  assert.match(empty.indexDigest, /^sha256:[0-9a-f]{64}$/);
});

/* ------------------------------------------------------------ static wall */

test('the module is pure: its own immutable manifest, and nothing else', () => {
  const imports = [...SOURCE.matchAll(/^import[^;]*from\s+'([^']+)';/gm)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ['./negotiation.mjs', './node-portability.mjs', 'node:crypto', 'node:fs', 'node:path', 'node:url']);
  for (const forbidden of ['node:net', 'node:http', 'node:child_process', 'node:worker_threads', 'process.', 'setTimeout', 'setInterval', 'Date.now', 'Math.random']) {
    assert.equal(SOURCE.includes(forbidden), false, `node-registry.mjs must not reference '${forbidden}'`);
  }
  // The one file it reads is the published foundation manifest it quotes — and
  // it quotes it as data instead of reaching into `foundation.mjs`, which is
  // outside `lego-foundation`'s published surface (gate rule R4).
  assert.equal([...SOURCE.matchAll(/readFileSync\(/g)].length, 1, 'exactly one manifest read');
  assert.ok(SOURCE.includes("'manifest', 'foundation.json'"), 'that read must be the foundation manifest');
  assert.equal(
    [...SOURCE.matchAll(/^import[^;]*from\s+'([^']+)';/gm)].map((match) => match[1]).includes('./foundation.mjs'),
    false,
    'the accessor outside the published surface must not be imported',
  );
  assert.equal(NODE_REGISTRY_VOCABULARY_SOURCE, 'src/lego/manifest/foundation.json');
  assert.equal(/from\s+'\.\.\//.test(SOURCE), false, 'no reaching into another app tree');
  assert.equal(/export\s+(?:async\s+)?function\s+[a-z]*(?:grant|admit|authorize|approve)/i.test(SOURCE), false, 'P6.1 grants nothing');
});

test('the module never re-declares a quoted vocabulary as its own list', () => {
  for (const literal of ["'core', 'verified'", "'network', 'filesystem', 'subprocess'", "'js-compat', 'rust-native'"]) {
    assert.equal(SOURCE.includes(literal), false, `vocabulary literal ${literal} must be quoted from the foundation, not copied`);
  }
  // Every published enumeration is derived from its source of truth …
  for (const quoted of [
    'FOUNDATION_MANIFEST.trust.levels',
    'FOUNDATION_MANIFEST.trust.capabilities',
    'FOUNDATION_MANIFEST.failureBoundaries.levels',
    'FOUNDATION_MANIFEST.resources',
    'FOUNDATION_MANIFEST.runtimes',
    'LIFECYCLE_STATES',
    'PORTABILITY_TARGETS',
  ]) {
    assert.ok(SOURCE.includes(quoted), `${quoted} must be quoted, not copied`);
  }
  // … and the only literal vocabularies are the ones this contract itself owns.
  assert.match(SOURCE, /export const NODE_REGISTRY_FIELDS = Object\.freeze\(\[/);
  assert.match(SOURCE, /export const NODE_REGISTRY_REASONS = Object\.freeze\(\[/);
});
