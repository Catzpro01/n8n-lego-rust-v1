/**
 * P6.28 — update metadata freshness: rollback, freeze and mix-and-match.
 * Contract `registry.freshness@0.1.0`.
 *
 * Matrix: the surface, metadata and its digest, trusted state, a fresh update, rollback and fork,
 * expiry and the clock, thresholds and missing roles, snapshot binding, delegation narrowing, the
 * refresh plan, determinism and the reads, the walls, and the lock row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FRESHNESS_CONTRACT,
  FRESHNESS_CONTRACT_VERSION,
  FRESHNESS_FORMAT,
  FRESHNESS_OPERATIONS,
  FRESHNESS_PERMISSIONS,
  FRESHNESS_REASONS,
  FRESHNESS_RULES,
  FRESHNESS_SCHEMA_VERSION,
  FRESHNESS_VERDICTS,
  FreshnessError,
  UPDATE_ROLES,
  createDelegation,
  createRoleMetadata,
  createTrustedState,
  describeFreshness,
  evaluateFreshness,
  explainFreshness,
  freshnessDigest,
  isCoveredBy,
  isRoleMetadata,
  isTrustedState,
  meetsThreshold,
  planRefresh,
  stableJson,
} from '../src/lego/freshness.mjs';

/* ------------------------------------------------------------------ fixtures */

const DIGEST = {
  root: '1'.repeat(64),
  timestamp: '2'.repeat(64),
  snapshot: '3'.repeat(64),
  targets: '4'.repeat(64),
  other: '5'.repeat(64),
};

const ROLE = (role, { version = 1, digest = DIGEST[role] ?? DIGEST.other, expiresAt = 100, valid = 1, required = 1, meta = null } = {}) =>
  createRoleMetadata({ role, version, digest, expiresAt, signatures: { valid, required }, meta });

const CANDIDATE = (overrides = {}) => ({
  root: ROLE('root'),
  timestamp: ROLE('timestamp', { version: 4, expiresAt: 50 }),
  snapshot: ROLE('snapshot', { version: 2, expiresAt: 50, meta: { targets: { version: 3, digest: DIGEST.targets } } }),
  targets: ROLE('targets', { version: 3, expiresAt: 50 }),
  ...overrides,
});

const TRUSTED = (roles = {
  root: { version: 1, digest: DIGEST.root, expiresAt: 100 },
  timestamp: { version: 4, digest: DIGEST.timestamp, expiresAt: 50 },
  snapshot: { version: 2, digest: DIGEST.snapshot, expiresAt: 50 },
  targets: { version: 3, digest: DIGEST.targets, expiresAt: 50 },
}, checkedAt = 0) => createTrustedState({ roles, checkedAt });

const EMPTY_TRUSTED = () => createTrustedState({ roles: {}, checkedAt: 0 });

const throwsWith = (fn, code) => {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof FreshnessError, `expected a FreshnessError carrying ${code}`);
  assert.equal(caught.code, 'lego.contract_violation');
  assert.equal(caught.meta.code, code);
  return caught;
};

/* ------------------------------------------------------------------ contract */

test('the contract surface is the published one: id, version, ops, closed vocabularies', () => {
  assert.equal(FRESHNESS_CONTRACT, 'registry.freshness@0.1.0');
  assert.equal(FRESHNESS_CONTRACT_VERSION, '0.1.0');
  assert.equal(FRESHNESS_SCHEMA_VERSION, 1);
  assert.equal(FRESHNESS_FORMAT, 'lego-freshness@1');
  assert.deepEqual([...FRESHNESS_OPERATIONS], ['trust', 'evaluate', 'refresh', 'delegate', 'describe']);
  assert.deepEqual([...FRESHNESS_PERMISSIONS], ['node:read']);
  assert.deepEqual([...UPDATE_ROLES], ['root', 'timestamp', 'snapshot', 'targets']);
  assert.deepEqual([...FRESHNESS_VERDICTS], ['fresh', 'rollback', 'frozen', 'mismatch', 'incomplete']);
  assert.equal(FRESHNESS_REASONS.length, 10);
  assert.match(FRESHNESS_RULES.monotone, /a version that goes backwards is the attack the number exists to stop/);
  assert.match(FRESHNESS_RULES.refresh, /if it did not move, do not ask for anything below it/);
  assert.match(FRESHNESS_RULES.authority, /never decides whether the artifact it describes may run/);
});

test('metadata is digests, versions and counts handed in: this contract never sees a key', () => {
  const targets = ROLE('targets');
  assert.equal(isRoleMetadata(targets), true);
  assert.equal(Object.isFrozen(targets), true);
  assert.deepEqual({ ...targets.signatures }, { valid: 1, required: 1 });
  const { metadataDigest, ...body } = targets;
  assert.equal(metadataDigest, freshnessDigest(body));
  assert.equal(stableJson({ b: [1, { d: 2, c: 3 }], a: 1 }), stableJson({ a: 1, b: [1, { c: 3, d: 2 }] }));

  const snapshot = ROLE('snapshot', { version: 2, meta: { targets: { version: 3, digest: DIGEST.targets } } });
  assert.equal(snapshot.meta.targets.version, 3);
  assert.equal(Object.isFrozen(snapshot.meta.targets), true);
  assert.equal(isRoleMetadata({ role: 'targets' }), false);

  throwsWith(() => ROLE(''), 'freshness.role');
  throwsWith(() => ROLE('targets', { version: 0 }), 'freshness.version');
  throwsWith(() => ROLE('targets', { version: 1.5 }), 'freshness.version');
  throwsWith(() => ROLE('targets', { digest: 'nope' }), 'freshness.digest');
  throwsWith(() => ROLE('targets', { expiresAt: -1 }), 'freshness.expiry');
  throwsWith(() => ROLE('targets', { valid: 1, required: 0 }), 'freshness.threshold');
  assert.match(throwsWith(() => ROLE('targets', { valid: 3, required: 2 }), 'freshness.threshold').message, /more signatures than the role accepts is a reporting mistake, not a surplus/);
  throwsWith(() => ROLE('targets', { valid: 0.5 }), 'freshness.threshold');
  throwsWith(() => createRoleMetadata({ role: 'targets', version: 1, digest: DIGEST.targets, expiresAt: 1, signatures: 'two' }), 'freshness.threshold');
  assert.match(throwsWith(() => ROLE('targets', { meta: { other: { version: 1, digest: DIGEST.other } } }), 'freshness.snapshot').message, /only a snapshot names the versions below it/);
  throwsWith(() => ROLE('snapshot', { meta: 'none' }), 'freshness.snapshot');
  assert.match(throwsWith(() => ROLE('snapshot', { meta: { snapshot: { version: 1, digest: DIGEST.snapshot } } }), 'freshness.snapshot').message, /a snapshot does not name itself/);
  throwsWith(() => ROLE('snapshot', { meta: { targets: { version: 0, digest: DIGEST.targets } } }), 'freshness.snapshot');
  assert.match(throwsWith(() => ROLE('snapshot', { meta: { targets: { version: 3 } } }), 'freshness.snapshot').message, /a version alone does not say which bytes/);
  throwsWith(() => ROLE('snapshot', { meta: { targets: null } }), 'freshness.snapshot');
});

test('the trusted state records what is already known and when it was last looked at', () => {
  const trusted = TRUSTED();
  assert.equal(isTrustedState(trusted), true);
  assert.equal(isTrustedState({ roles: {} }), false);
  assert.equal(trusted.checkedAt, 0);
  assert.equal(trusted.roles.targets.version, 3);
  assert.equal(trusted.roles.root.expiresAt, 100);
  assert.equal(createTrustedState({ roles: { targets: { version: 1, digest: DIGEST.targets } }, checkedAt: 0 }).roles.targets.expiresAt, null, 'a role may be trusted without an expiry, and that is recorded as absent');
  const described = describeFreshness(trusted);
  assert.equal(described.format, FRESHNESS_FORMAT);
  assert.deepEqual([...described.roles], ['root', 'snapshot', 'targets', 'timestamp']);
  assert.equal(described.versions.snapshot, 2);
  assert.equal(described.nextExpiryAt, 50);
  assert.equal(described.stateDigest, trusted.stateDigest);
  assert.match(described.message, /4 role\(s\) trusted, checked at tick 0/);
  assert.match(describeFreshness(EMPTY_TRUSTED()).message, /nothing is trusted yet, so every role is a first contact/);

  throwsWith(() => createTrustedState({ roles: [] }), 'freshness.input');
  throwsWith(() => createTrustedState({ roles: {} }), 'freshness.tick');
  throwsWith(() => createTrustedState({ roles: { targets: { version: 0, digest: DIGEST.targets } }, checkedAt: 0 }), 'freshness.version');
  throwsWith(() => createTrustedState({ roles: { targets: { version: 1 } }, checkedAt: 0 }), 'freshness.digest');
  throwsWith(() => createTrustedState({ roles: { targets: { version: 1, digest: DIGEST.targets, expiresAt: -1 } }, checkedAt: 0 }), 'freshness.expiry');
  throwsWith(() => createTrustedState({ roles: { targets: null }, checkedAt: 0 }), 'freshness.input');
  throwsWith(() => describeFreshness({ roles: {} }), 'freshness.input');
});

/* --------------------------------------------------------------- evaluation */

test('a current update is fresh, and a role that did not move is named as unchanged', () => {
  const empty = evaluateFreshness({ trusted: EMPTY_TRUSTED(), candidate: CANDIDATE(), tick: 10 });
  assert.equal(empty.ok, true);
  assert.equal(empty.verdict, 'fresh');
  assert.equal(empty.reason, null);
  assert.deepEqual([...empty.unchanged], []);
  assert.deepEqual({ ...empty.versions }, { root: 1, snapshot: 2, targets: 3, timestamp: 4 });
  assert.match(empty.message, /metadata is current at tick 10: root v1, snapshot v2, targets v3, timestamp v4$/);
  assert.match(empty.decisionDigest, /^[0-9a-f]{64}$/);

  const known = evaluateFreshness({ trusted: TRUSTED(), candidate: CANDIDATE(), tick: 10 });
  assert.equal(known.verdict, 'fresh');
  assert.deepEqual([...known.unchanged], ['root', 'snapshot', 'targets', 'timestamp']);
  assert.match(known.message, /\(4 unchanged\)$/);
  assert.match(explainFreshness(known), /^FRESH — metadata is current at tick 10/);
});

test('a version that goes backwards is a rollback, and the same version with other bytes is a fork', () => {
  const rolled = evaluateFreshness({
    trusted: TRUSTED({ snapshot: { version: 3, digest: DIGEST.snapshot } }),
    candidate: CANDIDATE(),
    tick: 10,
  });
  assert.equal(rolled.ok, false);
  assert.equal(rolled.verdict, 'rollback');
  assert.equal(rolled.reason, 'freshness.version');
  assert.equal(rolled.role, 'snapshot');
  assert.deepEqual([rolled.from, rolled.to], [3, 2]);
  assert.match(rolled.message, /'snapshot' went from version 3 back to 2: a version that goes backwards is the attack the number exists to stop/);

  const forked = evaluateFreshness({
    trusted: TRUSTED({ targets: { version: 3, digest: '9'.repeat(64) } }),
    candidate: CANDIDATE(),
    tick: 10,
  });
  assert.equal(forked.verdict, 'mismatch');
  assert.equal(forked.reason, 'freshness.digest');
  assert.match(forked.message, /version 3 is already trusted as 999999999999… and now arrives as 444444444444…: the same version with different bytes is a fork, not an update/);

  const newer = evaluateFreshness({
    trusted: TRUSTED(),
    candidate: CANDIDATE({
      snapshot: ROLE('snapshot', { version: 2, expiresAt: 50, meta: { targets: { version: 4, digest: DIGEST.targets } } }),
      targets: ROLE('targets', { version: 4, expiresAt: 50 }),
    }),
    tick: 10,
  });
  assert.equal(newer.verdict, 'fresh');
  assert.equal(newer.versions.targets, 4);
  assert.deepEqual([...newer.unchanged], ['root', 'snapshot', 'timestamp'], 'a newer version is not "unchanged", and it is not a problem either');
});

test('expiry is a verdict rather than a timestamp, and a clock that runs backwards is refused too', () => {
  const frozen = evaluateFreshness({ trusted: EMPTY_TRUSTED(), candidate: CANDIDATE({ timestamp: ROLE('timestamp', { version: 4, expiresAt: 5 }) }), tick: 10 });
  assert.equal(frozen.ok, false);
  assert.equal(frozen.verdict, 'frozen');
  assert.equal(frozen.reason, 'freshness.expiry');
  assert.deepEqual([...frozen.roles], ['timestamp']);
  assert.match(frozen.message, /'timestamp' expired at tick 5 and it is now 10: expired metadata says yesterday's truth, so it is refused rather than used/);

  const withSkew = evaluateFreshness({ trusted: EMPTY_TRUSTED(), candidate: CANDIDATE({ timestamp: ROLE('timestamp', { version: 4, expiresAt: 5 }) }), tick: 10, policy: { maxClockSkew: 10 } });
  assert.equal(withSkew.verdict, 'fresh', 'a declared skew is a decision, and it has to be declared');
  const pastSkew = evaluateFreshness({ trusted: EMPTY_TRUSTED(), candidate: CANDIDATE({ timestamp: ROLE('timestamp', { version: 4, expiresAt: 5 }) }), tick: 16, policy: { maxClockSkew: 10 } });
  assert.equal(pastSkew.verdict, 'frozen');
  assert.match(pastSkew.message, /\(allowing a clock skew of 10\)/);

  const backwards = evaluateFreshness({ trusted: TRUSTED(undefined, 20), candidate: CANDIDATE(), tick: 10 });
  assert.equal(backwards.verdict, 'frozen');
  assert.equal(backwards.reason, 'freshness.tick');
  assert.match(backwards.message, /a clock that goes backwards relative to the last check is how a freeze is hidden/);
  throwsWith(() => evaluateFreshness({ trusted: TRUSTED(), candidate: CANDIDATE() }), 'freshness.tick');
});

test('silence is not a signature, and a required role that is absent is not fresh', () => {
  const silent = evaluateFreshness({
    trusted: EMPTY_TRUSTED(),
    candidate: CANDIDATE({ snapshot: ROLE('snapshot', { version: 2, expiresAt: 50, meta: { targets: { version: 3, digest: DIGEST.targets } }, valid: 0, required: 1 }) }),
    tick: 10,
  });
  assert.equal(silent.verdict, 'incomplete');
  assert.equal(silent.reason, 'freshness.threshold');
  assert.equal(silent.role, 'snapshot');
  assert.match(silent.message, /silence is not a signature: 'snapshot' carries 0 of 1 valid signature\(s\) for this policy/);

  const stricter = evaluateFreshness({
    trusted: EMPTY_TRUSTED(),
    candidate: CANDIDATE({ targets: ROLE('targets', { version: 3, expiresAt: 50, valid: 1, required: 2 }) }),
    tick: 10,
    policy: { threshold: { targets: 2 } },
  });
  assert.equal(stricter.verdict, 'incomplete');
  assert.match(stricter.message, /'targets' carries 1 of 2 valid signature\(s\) for this policy/);

  const absent = evaluateFreshness({ trusted: EMPTY_TRUSTED(), candidate: (() => { const { targets, ...rest } = CANDIDATE(); return rest; })(), tick: 10 });
  assert.equal(absent.verdict, 'incomplete');
  assert.equal(absent.reason, 'freshness.role');
  assert.deepEqual([...absent.missing], ['targets']);
  assert.match(absent.message, /an update that arrives without its targets cannot be said to be current: 1 required role\(s\) are absent, and absent is not fresh/);

  const waived = evaluateFreshness({ trusted: EMPTY_TRUSTED(), candidate: (() => { const { targets, ...rest } = CANDIDATE(); return rest; })(), tick: 10, policy: { requiredRoles: ['timestamp'] } });
  assert.equal(waived.verdict, 'fresh', 'a policy that does not require a role does not invent evidence for it');
  assert.equal(meetsThreshold(ROLE('targets')).ok, true);
  assert.equal(meetsThreshold(ROLE('targets'), { thresholds: { targets: 2 } }).ok, false);
  assert.match(meetsThreshold(ROLE('targets'), { thresholds: { targets: 2 } }).message, /carries 1 of 2/);
  throwsWith(() => meetsThreshold({ role: 'targets' }), 'freshness.input');
  throwsWith(() => meetsThreshold(ROLE('targets'), { thresholds: { targets: 0 } }), 'freshness.threshold');
});

test('metadata from two snapshots is one snapshot too many: the binding is checked, not assumed', () => {
  const mixed = evaluateFreshness({
    trusted: EMPTY_TRUSTED(),
    candidate: CANDIDATE({ snapshot: ROLE('snapshot', { version: 2, expiresAt: 50, meta: { targets: { version: 4, digest: DIGEST.other } } }) }),
    tick: 10,
  });
  assert.equal(mixed.verdict, 'mismatch');
  assert.equal(mixed.reason, 'freshness.snapshot');
  assert.deepEqual({ ...mixed.named }, { version: 4, digest: DIGEST.other });
  assert.deepEqual({ ...mixed.found }, { version: 3, digest: DIGEST.targets });
  assert.match(mixed.message, /the snapshot names 'targets' at version 4 \(555555555555…\) and what is in hand is version 3 \(444444444444…\): metadata from two snapshots is one snapshot too many/);

  const delegatedAbsent = evaluateFreshness({
    trusted: EMPTY_TRUSTED(),
    candidate: CANDIDATE({ snapshot: ROLE('snapshot', { version: 2, expiresAt: 50, meta: { targets: { version: 3, digest: DIGEST.targets }, 'targets-set': { version: 1, digest: DIGEST.other } } }) }),
    tick: 10,
  });
  assert.equal(delegatedAbsent.verdict, 'fresh', 'a role the snapshot names but nobody supplied is simply not in hand');

  const waived = evaluateFreshness({
    trusted: EMPTY_TRUSTED(),
    candidate: CANDIDATE({ snapshot: ROLE('snapshot', { version: 2, expiresAt: 50, meta: { targets: { version: 4, digest: DIGEST.targets } } }) }),
    tick: 10,
    policy: { requireSnapshotBinding: false },
  });
  assert.equal(waived.verdict, 'fresh');
});

/* -------------------------------------------------- delegation and refresh */

test('a delegation may narrow what it can sign, never widen it, and may not lower the bar', () => {
  const delegation = createDelegation({ from: 'targets', to: 'targets-set', parentPaths: ['packages/'], paths: ['packages/set/'] });
  assert.equal(delegation.from, 'targets');
  assert.equal(delegation.threshold, 1, 'a delegation that does not state a bar inherits its parent\'s');
  assert.deepEqual([...delegation.paths], ['packages/set/']);
  assert.match(delegation.delegationDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual([...delegation.parentPaths], ['packages/']);

  assert.equal(isCoveredBy('packages/set/x.json', ['packages/']), true);
  assert.equal(isCoveredBy('packages/set/x.json', ['packages/*']), true);
  assert.equal(isCoveredBy('packages', ['packages/']), false, 'the directory itself is not a path inside it, and a role signs paths');
  assert.equal(isCoveredBy('packages', ['packages']), true);
  assert.equal(isCoveredBy('tools/x.json', ['packages/']), false);
  assert.equal(isCoveredBy('packages-other/x.json', ['packages/']), false, 'a prefix match is a path match, not a string match');
  throwsWith(() => isCoveredBy('x', 'packages/'), 'freshness.delegation');

  assert.match(
    throwsWith(() => createDelegation({ from: 'targets', to: 'targets-set', parentPaths: ['packages/'], paths: ['packages/set/', 'tools/'] }), 'freshness.delegation').message,
    /'targets-set' asks to sign 'tools\/' and 'targets' covers packages\/: a delegation may narrow what it can sign, never widen it/,
  );
  assert.match(throwsWith(() => createDelegation({ from: 'targets', to: 'targets', parentPaths: ['packages/'], paths: ['packages/set/'] }), 'freshness.delegation').message, /cannot delegate to itself/);
  assert.match(throwsWith(() => createDelegation({ from: 'targets', to: 'targets-set', parentPaths: ['packages/'], paths: ['packages/set/'], threshold: 2, parentThreshold: 3 }), 'freshness.delegation').message, /may not lower the bar its parent set/);
  throwsWith(() => createDelegation({ from: 'targets', to: 'targets-set', parentPaths: ['packages/'], paths: [] }), 'freshness.delegation');
  throwsWith(() => createDelegation({ from: 'targets', to: 'targets-set', parentPaths: ['packages/'], paths: ['packages/set/', 'packages/set/'] }), 'freshness.delegation');
  throwsWith(() => createDelegation({ from: 'targets', to: 'targets-set', parentPaths: [], paths: ['packages/set/'] }), 'freshness.delegation');
  throwsWith(() => createDelegation({ from: 'targets', to: 'targets-set', parentPaths: ['packages/'], paths: ['packages/set/'], threshold: 0 }), 'freshness.delegation');
  throwsWith(() => createDelegation({ from: 'targets', to: 'targets-set', parentPaths: ['packages/'], paths: ['packages/set/'], threshold: 1, parentThreshold: 0 }), 'freshness.delegation');
});

test('a refresh is a plan that stops at the first role that did not move', () => {
  const unchangedTimestamp = planRefresh({ trusted: TRUSTED(), candidate: { timestamp: ROLE('timestamp', { version: 4, expiresAt: 50 }) } });
  assert.deepEqual([...unchangedTimestamp.roles], ['root', 'timestamp']);
  assert.equal(unchangedTimestamp.stopAt, 'timestamp');
  assert.equal(unchangedTimestamp.unchanged, true);
  assert.match(unchangedTimestamp.message, /the timestamp is still version 4, so nothing below it can have changed: the refresh stops here rather than asking for metadata that cannot be newer/);

  const movedTimestamp = planRefresh({
    trusted: TRUSTED(),
    candidate: { timestamp: ROLE('timestamp', { version: 5, expiresAt: 50 }), snapshot: ROLE('snapshot', { version: 2, expiresAt: 50, meta: { targets: { version: 3, digest: DIGEST.targets } } }) },
  });
  assert.deepEqual([...movedTimestamp.roles], ['root', 'timestamp', 'snapshot']);
  assert.equal(movedTimestamp.stopAt, 'snapshot');
  assert.equal(movedTimestamp.unchanged, false);
  assert.match(movedTimestamp.message, /the timestamp moved to version 5; the snapshot is still version 2, so the targets cannot have changed/);

  const movedBoth = planRefresh({
    trusted: TRUSTED(),
    candidate: { timestamp: ROLE('timestamp', { version: 5, expiresAt: 50 }), snapshot: ROLE('snapshot', { version: 3, expiresAt: 50, meta: { targets: { version: 3, digest: DIGEST.targets } } }) },
  });
  assert.deepEqual([...movedBoth.roles], ['root', 'timestamp', 'snapshot', 'targets']);
  assert.equal(movedBoth.stopAt, null);
  assert.match(movedBoth.message, /the metadata below the timestamp moved as well, so the plan asks for everything the roles cover/);

  const blind = planRefresh({ trusted: TRUSTED() });
  assert.deepEqual([...blind.roles], ['root', 'timestamp', 'snapshot', 'targets']);
  assert.match(blind.message, /no timestamp was supplied, so nothing can be short-circuited: the plan asks for the whole chain/);

  const noRoot = planRefresh({ trusted: TRUSTED(), policy: { includeRoot: false } });
  assert.deepEqual([...noRoot.roles], ['timestamp', 'snapshot', 'targets']);
  throwsWith(() => planRefresh({ trusted: TRUSTED(), policy: { includeRoot: 'yes' } }), 'freshness.input');
  throwsWith(() => planRefresh({ trusted: TRUSTED(), candidate: [] }), 'freshness.input');
  throwsWith(() => planRefresh({}), 'freshness.input');
});

/* ------------------------------------------------------- determinism, reads */

test('the same inputs give the same decision, and a malformed policy is refused rather than guessed', () => {
  const first = evaluateFreshness({ trusted: TRUSTED(), candidate: CANDIDATE(), tick: 10 });
  const second = evaluateFreshness({ trusted: TRUSTED(), candidate: CANDIDATE(), tick: 10 });
  assert.equal(first.decisionDigest, second.decisionDigest);
  const later = evaluateFreshness({ trusted: TRUSTED(), candidate: CANDIDATE(), tick: 11 });
  assert.notEqual(first.decisionDigest, later.decisionDigest, 'a decision names the tick it was made at');
  assert.equal(first.decisionDigest, evaluateFreshness({ trusted: TRUSTED(), candidate: CANDIDATE(), tick: 10 }).decisionDigest);

  throwsWith(() => evaluateFreshness({ trusted: TRUSTED(), tick: 10 }), 'freshness.input');
  throwsWith(() => evaluateFreshness({ trusted: TRUSTED(), candidate: [], tick: 10 }), 'freshness.input');
  throwsWith(() => evaluateFreshness({ trusted: TRUSTED(), candidate: { targets: { role: 'targets' } }, tick: 10 }), 'freshness.input');
  const mislabeled = (() => { const { targets, ...rest } = CANDIDATE(); return { ...rest, other: ROLE('targets') }; })();
  assert.match(
    throwsWith(() => evaluateFreshness({ trusted: TRUSTED(), candidate: mislabeled, tick: 10 }), 'freshness.role').message,
    /the candidate is keyed 'other' and the metadata inside says 'targets'/,
  );
  throwsWith(() => evaluateFreshness({ trusted: TRUSTED(), candidate: CANDIDATE(), tick: 10, policy: { requiredRoles: [] } }), 'freshness.input');
  throwsWith(() => evaluateFreshness({ trusted: TRUSTED(), candidate: CANDIDATE(), tick: 10, policy: { requiredRoles: [''] } }), 'freshness.role');
  throwsWith(() => evaluateFreshness({ trusted: TRUSTED(), candidate: CANDIDATE(), tick: 10, policy: { maxClockSkew: -1 } }), 'freshness.input');
  throwsWith(() => evaluateFreshness({ trusted: TRUSTED(), candidate: CANDIDATE(), tick: 10, policy: { threshold: [] } }), 'freshness.threshold');
  throwsWith(() => evaluateFreshness({ trusted: TRUSTED(), candidate: CANDIDATE(), tick: 10, policy: { threshold: { targets: 0 } } }), 'freshness.threshold');
  throwsWith(() => explainFreshness({ verdict: 'maybe' }), 'freshness.input');
  throwsWith(() => evaluateFreshness({}), 'freshness.input');
});

/* --------------------------------------------------------------------- walls */

test('freshness decides whether metadata is current: it verifies nothing and fetches nothing', () => {
  const source = readFileSync(new URL('../src/lego/freshness.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(', 'node:vm', 'eval(', 'createSign', 'createVerify', 'subtle', 'privateKey', 'publicKey']) {
    assert.equal(code.includes(forbidden), false, `the freshness contract must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
  for (const forbidden of ['./registry-integrity.mjs', './supply-chain.mjs', './node-registry.mjs', './sbom-policy.mjs', './provenance-log.mjs', './wasm-cache.mjs', './native-abi.mjs', './canary-rollout.mjs', './admission-explain.mjs']) {
    assert.equal(code.includes(forbidden), false, `P6.28 must not reach into ${forbidden}: attestations are P6.12 and the epoch chain is P6.16`);
  }
  for (const name of ['checkFreshness', 'verifyChain', 'appendEpoch', 'witnessChain', 'signAttestation', 'NODE_TRUST_CLASSES', 'verifyAcceptanceReport']) {
    assert.equal(code.includes(name), false, `${name} belongs to another milestone: freshness is not trust and not acceptance`);
  }
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'registry.freshness');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, FRESHNESS_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/freshness.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-freshness.test.mjs']);
  for (const name of ['createRoleMetadata', 'createTrustedState', 'evaluateFreshness', 'planRefresh', 'createDelegation', 'describeFreshness']) {
    assert.equal(rows[0].exports['src/lego/freshness.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'node.provenance', 'node.abi', 'runtime.wasm-cache', 'registry.integrity', 'node.supply-chain', 'node.admission', 'node.sbom', 'node.canary', 'node.revocation']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.28 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/freshness.mjs'));
});
