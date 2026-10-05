/**
 * Backend LEGO foundation — contract compatibility model (P2.7).
 *
 * PUBLIC CONTRACT (`lego.contract-compat`, v1.0.0, owner: manager).
 *
 * P2.6 answered "what version is this contract, and who owns it?". P2.7 has to
 * answer the lifecycle questions a nested LEGO system actually runs into:
 *
 *   - is a consumer compatible with the version a provider publishes?
 *   - is an upgrade compatible, breaking, or migration-required?
 *   - is replacing an implementation safe?
 *   - must a parent version-bump because a child changed?
 *
 * Deliberately tiny: three comparison functions and a classifier, no resolver,
 * no lockfile solver, no dependency-range algebra beyond what the registry
 * needs. It is a decision procedure, not a package manager.
 *
 * Range syntax supported (the minimum that expresses real intent):
 *
 *   "1.2.3"    exact
 *   "^1.2.3"   compatible: same major, >= 1.2.3  (0.x: same minor, >= patch)
 *   "~1.2.3"   patch-compatible: same major.minor, >= 1.2.3
 *   ">=1.2.3"  at least
 *   "*"        any
 *
 * `^` on a 0.x version is intentionally strict (0.2.x satisfies ^0.2.1, 0.3.0
 * does not): P2.6 declared 0.x contracts provisional, so a minor bump there is
 * allowed to break and consumers must be told.
 */

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** @typedef {{ major: number, minor: number, patch: number }} Version */

export function parseVersion(value) {
  const match = VERSION_RE.exec(String(value).trim());
  if (!match) throw new Error(`invalid contract version '${value}' — expected major.minor.patch`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a;
  const right = typeof b === 'string' ? parseVersion(b) : b;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return 0;
}

export function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * How a version move is classified. This is the vocabulary the whole lifecycle
 * speaks — the registry, the gate and the upgrade plan all use these words.
 *
 *   compatible          consumers keep working untouched
 *   migration-required  consumers keep working, but state/data must be migrated
 *                       (declared per contract, never inferred)
 *   breaking            consumers must change; requires major bump + sign-off
 *   downgrade           the provider went backwards; never automatic
 *   unchanged           same version
 */
export const CHANGE_KINDS = Object.freeze([
  'unchanged',
  'compatible',
  'migration-required',
  'breaking',
  'downgrade',
]);

/**
 * Classifies a version move.
 *
 * @param {string} from previous contract version
 * @param {string} to new contract version
 * @param {{ migrations?: string[] }} [options] versions that are known to need a
 *        data/state migration even though they are semver-compatible. Declared
 *        in the contract lock (`migrations: ["1.2.0"]`), never guessed.
 */
export function classifyChange(from, to, { migrations = [] } = {}) {
  const a = parseVersion(from);
  const b = parseVersion(to);
  const direction = compareVersions(a, b);
  if (direction === 0) return { kind: 'unchanged', reason: 'same version' };
  if (direction > 0) {
    return { kind: 'downgrade', reason: `${to} is older than ${from}; a downgrade is never automatic` };
  }
  if (b.major !== a.major) {
    return { kind: 'breaking', reason: `major ${a.major} -> ${b.major}: consumers must be updated and sign off` };
  }
  // Pre-1.0 contracts are provisional: a minor bump there is allowed to break.
  if (a.major === 0 && b.minor !== a.minor) {
    return { kind: 'breaking', reason: `0.x contract: minor ${a.minor} -> ${b.minor} may break; 0.x is provisional` };
  }
  if (migrations.some((version) => compareVersions(version, a) > 0 && compareVersions(version, b) <= 0)) {
    const needed = migrations.filter((version) => compareVersions(version, a) > 0 && compareVersions(version, b) <= 0);
    return { kind: 'migration-required', reason: `crosses declared migration point(s) ${needed.join(', ')}` };
  }
  return {
    kind: 'compatible',
    reason: b.minor !== a.minor ? `additive minor ${a.minor} -> ${b.minor}` : `patch ${a.patch} -> ${b.patch}`,
  };
}

/**
 * Does `version` satisfy `range`?
 * @returns {{ satisfied: boolean, reason: string }}
 */
export function satisfies(version, range) {
  const spec = String(range ?? '*').trim();
  if (spec === '*' || spec === '') return { satisfied: true, reason: 'any version accepted' };
  const actual = parseVersion(version);

  if (spec.startsWith('^')) {
    const base = parseVersion(spec.slice(1));
    if (compareVersions(actual, base) < 0) {
      return { satisfied: false, reason: `${version} is older than the required ${spec}` };
    }
    if (base.major === 0) {
      const ok = actual.major === 0 && actual.minor === base.minor;
      return {
        satisfied: ok,
        reason: ok
          ? `${version} is within the provisional 0.${base.minor}.x line`
          : `${version} leaves the provisional 0.${base.minor}.x line required by ${spec} (0.x minors may break)`,
      };
    }
    const ok = actual.major === base.major;
    return {
      satisfied: ok,
      reason: ok ? `${version} satisfies ${spec}` : `major ${actual.major} != ${base.major} required by ${spec}`,
    };
  }

  if (spec.startsWith('~')) {
    const base = parseVersion(spec.slice(1));
    const ok = actual.major === base.major && actual.minor === base.minor && compareVersions(actual, base) >= 0;
    return {
      satisfied: ok,
      reason: ok ? `${version} satisfies ${spec}` : `${version} is outside the ${base.major}.${base.minor}.x line required by ${spec}`,
    };
  }

  if (spec.startsWith('>=')) {
    const base = parseVersion(spec.slice(2));
    const ok = compareVersions(actual, base) >= 0;
    return { satisfied: ok, reason: ok ? `${version} >= ${formatVersion(base)}` : `${version} < ${formatVersion(base)}` };
  }

  const base = parseVersion(spec);
  const ok = compareVersions(actual, base) === 0;
  return { satisfied: ok, reason: ok ? `${version} == ${spec}` : `${version} != the pinned ${spec}` };
}

/**
 * The minimum upgrade lifecycle P2.7 defines:
 *
 *   v1 -> compatibility check -> v2 -> migration if required -> tests -> activation
 *
 * This returns that plan as data so a future P9 upgrade system can execute it
 * and a test can assert it today, without building the upgrade system now.
 *
 * @param {{ id: string, from: string, to: string, migrations?: string[],
 *           consumers?: Array<{ id: string, requires: string }> }} request
 */
export function planUpgrade({ id, from, to, migrations = [], consumers = [] }) {
  const change = classifyChange(from, to, { migrations });
  const consumerChecks = consumers.map((consumer) => {
    const before = satisfies(from, consumer.requires);
    const after = satisfies(to, consumer.requires);
    return {
      consumer: consumer.id,
      requires: consumer.requires,
      satisfiedBefore: before.satisfied,
      satisfiedAfter: after.satisfied,
      mustChange: before.satisfied && !after.satisfied,
      reason: after.reason,
    };
  });

  const blockedBy = consumerChecks.filter((check) => check.mustChange).map((check) => check.consumer);
  const safe = change.kind === 'compatible' || change.kind === 'unchanged';

  return {
    contract: id,
    from,
    to,
    change: change.kind,
    reason: change.reason,
    consumers: consumerChecks,
    steps: [
      { step: 'compatibility-check', status: blockedBy.length === 0 ? 'pass' : 'fail', detail: blockedBy.length === 0 ? 'every consumer requirement is still satisfied' : `blocked by ${blockedBy.join(', ')}` },
      { step: 'migration', status: change.kind === 'migration-required' ? 'required' : 'not-required', detail: change.reason },
      { step: 'tests', status: 'required', detail: 'the provider contract tests plus every listed consumer test must pass' },
      { step: 'activation', status: blockedBy.length === 0 ? 'allowed' : 'blocked', detail: blockedBy.length === 0 ? 'the new version may be published' : 'consumers must be updated and sign off first' },
    ],
    safeToActivate: blockedBy.length === 0,
    requiresMigration: change.kind === 'migration-required',
    requiresSignOff: !safe,
    blockedBy,
  };
}

/**
 * Is swapping one implementation for another behind the SAME contract safe?
 *
 * This is the property that makes a future JS -> Rust replacement a
 * non-event: the consumer talks to the contract, so as long as the contract id
 * and version match and the replacement passes the contract's own tests, the
 * swap is invisible. P2.7 proves it with two JS implementations; nothing here
 * knows or cares which language is behind the port.
 */
export function canReplaceImplementation({ contract, current, replacement }) {
  const problems = [];
  if (current.contract !== replacement.contract) {
    problems.push(`different contract id: '${current.contract}' vs '${replacement.contract}'`);
  }
  const check = satisfies(replacement.version, `^${contract.version}`);
  if (!check.satisfied) problems.push(`replacement version ${replacement.version}: ${check.reason}`);
  const missing = (contract.operations ?? []).filter((operation) => typeof replacement.port?.[operation] !== 'function');
  if (missing.length > 0) problems.push(`replacement does not implement ${missing.join(', ')}`);
  return { safe: problems.length === 0, problems };
}
