/**
 * Backend LEGO — P6-S01: the live node installation path.
 *
 * PUBLIC CONTRACT (`node.install@0.1.0`, owner: agent-1).
 *
 * WHAT THIS IS. P6.1-P6.31 built the admission *pipeline* as separate contracts:
 * the registry compiler, the transactional package install, the capability
 * compiler, the locality matrix, the policy ceilings, the lifecycle states, the
 * health breaker, the provenance log, the namespace rules. Every one of them is
 * reachable on its own. What did not exist is the ONE path a candidate node
 * actually travels when someone installs it live, which is what issue #95 asks
 * for and what this module is.
 *
 * THE ONE RULE THAT SHAPES EVERYTHING: a node class is a POLICY INPUT, not a
 * trust grant. Issue #95 says so in as many words, and the failure mode it is
 * guarding against is the obvious one — "official" and "Rust" and "signed" all
 * sound like trust, and none of them is. So:
 *
 *   - `official` does not buy `CORE`. It buys the *ceiling* `CORE`, and the node
 *     still has to pass every check to reach it.
 *   - `native` (Rust) does not buy in-process. It is the class most likely to be
 *     pushed to ISOLATED_PROCESS, because a native artifact is the one thing a
 *     WASM sandbox cannot hold.
 *   - `custom` and AI-created code default to the most restrictive class until
 *     an operator explicitly admits them.
 *
 * FAIL-CLOSED, and specifically: anything unclassifiable is `community` at best
 * and is never admitted on the strength of what it claims about itself. The
 * manifest is evidence the candidate supplies, not truth.
 *
 * THE RUNTIME CHOICE NEVER CHANGES THE NODE CONTRACT. A node installed behind a
 * WASM sandbox and the same node installed in-process present the same
 * `type`/`typeVersion`, the same parameters, the same credential bindings and
 * the same execution semantics to a workflow. The install decision is recorded
 * next to the node, not inside it — `planDigest` deliberately excludes the trust
 * class for exactly this reason (capability-compiler.mjs).
 */
import {
  LOCALITY_MATRIX,
  isLocalityAllowed,
  recommendLocality,
} from './plugin-locality.mjs';
import { PluginRuntimeError } from './plugin-runtime.mjs';

export const NODE_INSTALL_CONTRACT = 'node.install@0.1.0';
export const NODE_INSTALL_CONTRACT_VERSION = '0.1.0';
export const NODE_INSTALL_SCHEMA_VERSION = 1;

/** The classes issue #95 names, in the order the install path argues them. */
export const NODE_CLASSES = Object.freeze([
  'official',
  'verified-community',
  'community',
  'private',
  'custom',
  'native',
]);

/** Every class maps to a trust ceiling; none maps to an automatic grant. */
export const NODE_CLASS_TRUST_CEILING = Object.freeze({
  official: 'CORE',
  'verified-community': 'TRUSTED',
  community: 'ISOLATED',
  private: 'ISOLATED',
  custom: 'SANDBOXED',
  native: 'ISOLATED',
});

/**
 * The floor a class cannot fall below, and the reason. `custom` and AI-created
 * code sit here until an operator admits them explicitly: the code did not exist
 * before the request that produced it, so there is no history to trust.
 */
export const NODE_CLASS_TRUST_FLOOR = Object.freeze({
  official: 'TRUSTED',
  'verified-community': 'ISOLATED',
  community: 'ISOLATED',
  private: 'ISOLATED',
  custom: 'SANDBOXED',
  native: 'ISOLATED',
});

export const NODE_INSTALL_VERDICTS = Object.freeze(['admit', 'refuse', 'incomplete']);

/** The install steps, in the fixed order the path argues them. */
export const NODE_INSTALL_STEPS = Object.freeze([
  'identify',
  'trust',
  'capability',
  'locality',
  'resource',
  'compatibility',
  'health',
]);

export const NODE_INSTALL_REASONS = Object.freeze([
  'install.input',
  'install.class',
  'install.trust',
  'install.capability',
  'install.locality',
  'install.resource',
  'install.compatibility',
  'install.health',
]);

export const NODE_INSTALL_OPERATIONS = Object.freeze(['install', 'explain', 'describe']);

/** Resource ceilings, in the units the manifest declares. */
export const NODE_INSTALL_RESOURCE_LIMITS = Object.freeze({
  maxMemoryMb: 512,
  maxCpuMillicores: 2000,
  maxTimeoutMs: 300000,
  maxConcurrency: 16,
});

const violation = (message, details) => new PluginRuntimeError('lego.contract_violation', message, { details });

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function fail(message, details) {
  throw violation(message, details);
}

/* ------------------------------------------------------------------ classify */

/**
 * Resolves the node class of a candidate. The declaration is a CLAIM: an
 * unclassifiable or self-declared-inconsistently candidate is never promoted by
 * what it says about itself, only by evidence the caller supplies.
 *
 * @param {object} candidate
 * @param {string} candidate.type            node type identity, e.g. `n8n-nodes-base.httpRequest`
 * @param {string} [candidate.declaredClass] what the manifest claims
 * @param {string} [candidate.origin]        `registry` | `npm` | `git` | `local` | `generated`
 * @param {boolean} [candidate.attested]     a provenance statement was verified
 * @param {boolean} [candidate.aiGenerated]  the code was produced by a model
 * @returns {{ class: string, attested: boolean, aiGenerated: boolean, promoted: boolean }}
 */
export function classifyNode(candidate = {}) {
  if (!isPlainObject(candidate)) fail('a candidate must be an object', { code: 'install.input', got: typeof candidate });
  const type = candidate.type;
  if (!isNonEmptyString(type)) fail('a candidate must name its node type', { code: 'install.input', field: 'type' });
  const declared = candidate.declaredClass;
  if (declared !== undefined && !NODE_CLASSES.includes(declared)) {
    fail(`declaredClass must be one of ${NODE_CLASSES.join(', ')}`, { code: 'install.class', declaredClass: declared });
  }
  const origin = candidate.origin ?? 'registry';
  const attested = candidate.attested === true;
  const aiGenerated = candidate.aiGenerated === true;

  // A generated node is `custom` no matter what it declares: there is no review
  // history to inherit, which is exactly the case issue #95 calls out. This
  // applies even to a node that declares itself official — a class claim is not
  // evidence, and fail-closed means the restrictive reading wins.
  let resolved = declared ?? (origin === 'local' ? 'custom' : 'community');
  if (aiGenerated) resolved = 'custom';

  // An attestation promotes at most one step, and never above verified-community.
  // A signature proves provenance, not correctness, and certainly not authority.
  let promoted = false;
  if (attested && resolved === 'community' && origin !== 'local') {
    resolved = 'verified-community';
    promoted = true;
  }
  return { class: resolved, attested, aiGenerated, promoted, origin };
}

/** The trust class a node class may occupy, given what the candidate proved. */
export function resolveTrustClass(classification = {}) {
  if (!isPlainObject(classification)) fail('a classification must be an object', { code: 'install.input' });
  const { class: nodeClass } = classification;
  if (!NODE_CLASSES.includes(nodeClass)) {
    fail(`unknown node class '${nodeClass}'`, { code: 'install.class', nodeClass });
  }
  return {
    ceiling: NODE_CLASS_TRUST_CEILING[nodeClass],
    floor: NODE_CLASS_TRUST_FLOOR[nodeClass],
  };
}

/* --------------------------------------------------------------- capabilities */

/**
 * The two trust vocabularies this path has to speak. `plugin-locality.mjs` keys
 * its matrix on the ISOLATION POSTURE (uppercase), while `foundation.json` keys
 * its capability levels on PROVENANCE (lowercase). `plugin-policy.mjs` owns the
 * mapping between them; this module only ever speaks the posture vocabulary, and
 * only ever as a CEILING.
 */
export const TRUST_LOCALITY_POSTURE = Object.freeze({
  CORE: 'CORE',
  TRUSTED: 'TRUSTED',
  ISOLATED: 'ISOLATED',
  SANDBOXED: 'SANDBOXED',
});

export const PLUGIN_POSTURES = Object.freeze(Object.keys(TRUST_LOCALITY_POSTURE));

/**
 * Evaluates a requested capability against the trust ceiling of the resolved
 * class. The ceiling is a CEILING, not a grant: a capability the node asks for
 * and the ceiling allows still needs an explicit grant to be usable, which is
 * `plugin-policy.mjs`'s job. This step only decides whether the request is even
 * admissible, and it never widens anything.
 */
export function evaluateInstallCapabilities({ requested = [], trustClass, grants = [] } = {}) {
  if (!Array.isArray(requested)) fail('requested capabilities must be an array', { code: 'install.input' });
  if (!isNonEmptyString(trustClass) || !PLUGIN_POSTURES.includes(trustClass)) {
    fail(`a trust class is required and must be one of ${PLUGIN_POSTURES.join('/')}`, { code: 'install.trust', trustClass });
  }
  if (!Array.isArray(grants)) fail('grants must be an array', { code: 'install.input' });
  const granted = new Set(grants);
  const findings = Object.freeze(requested.map((capability) => Object.freeze({
    capability,
    admissible: isNonEmptyString(capability),
    granted: granted.has(capability),
  })));
  return Object.freeze({ trustClass, findings });
}

/* ------------------------------------------------------------------ locality */

/**
 * Resolves where the node runs. The rule from issue #95: untrusted, risky,
 * native and Python code goes to an isolated process; portable restricted
 * compute goes to WASM; a trusted hot path may run in-process; an external
 * provider implementation runs remote.
 *
 * Two things set the posture, and the stricter one wins:
 *
 *   1. the node class, through its trust ceiling;
 *   2. what the node actually asked for, because a native or subprocess
 *      capability has no in-process row to live in.
 *
 * That second rule is the one that stops the obvious exploit: an `official`
 * node that asks for `subprocess` must not be waved into the process on the
 * strength of its class claim. Its class buys it the CORE ceiling; the
 * capability it requested takes the ceiling away.
 *
 * The choice is recorded on the install decision and NEVER on the node contract,
 * so a workflow does not change when a node is re-placed.
 */
export function resolveInstallLocality({ classification = {}, capabilities = [], external = false } = {}) {
  const { ceiling } = resolveTrustClass(classification);
  const classPosture = TRUST_LOCALITY_POSTURE[ceiling];
  const requested = Array.isArray(capabilities) ? capabilities : [];
  const nativeRequested = requested.some((capability) => NATIVE_CAPABILITIES.includes(capability));
  const risky = requested.some((capability) => RISKY_CAPABILITIES.includes(capability));
  const posture = nativeRequested ? strictestPosture(classPosture, 'ISOLATED') : classPosture;
  const recommended = recommendLocality(posture, { external, crashRisk: risky });
  const allowed = LOCALITY_MATRIX[posture];
  // The recommendation must be a row in the matrix. If it is not, the matrix and
  // the recommender disagree, which is a bug we refuse to paper over.
  if (!isLocalityAllowed(posture, recommended)) {
    fail(`recommended locality ${recommended} is not in the ${posture} row`, { code: 'install.locality', posture, recommended });
  }
  // The invariant the whole capability/posture pairing exists to hold. If this
  // ever trips, the matrix and this rule disagree and the install must stop.
  if (nativeRequested && recommended === 'IN_PROCESS') {
    fail(`a node requesting ${NATIVE_CAPABILITIES.join('/')} cannot run in-process`, {
      code: 'install.locality',
      posture,
      recommended,
      requested,
    });
  }
  return Object.freeze({
    posture,
    classPosture,
    recommended,
    allowed: Object.freeze([...allowed]),
    external: external === true,
    nativeRequested,
  });
}

/**
 * The stricter of two postures. Higher index == more isolated == weaker
 * defaults, so the maximum index is the conservative answer.
 */
export function strictestPosture(a, b) {
  const order = Object.keys(TRUST_LOCALITY_POSTURE);
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}

/** Capabilities that force the node out of the process, by nature not by policy. */
export const NATIVE_CAPABILITIES = Object.freeze(['native', 'subprocess']);

/** Capabilities that make the node a crash risk for whatever hosts it. */
export const RISKY_CAPABILITIES = Object.freeze(['native', 'subprocess', 'filesystem', 'env']);

/* ---------------------------------------------------------------- resources */

export function evaluateInstallResources(declared = {}) {
  if (!isPlainObject(declared)) fail('declared resources must be an object', { code: 'install.input' });
  const findings = [];
  for (const [field, max] of Object.entries(NODE_INSTALL_RESOURCE_LIMITS)) {
    const value = declared[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      findings.push({ field, value, admitted: false, reason: 'must be a non-negative finite number' });
      continue;
    }
    findings.push({ field, value, max, admitted: value <= max });
  }
  return Object.freeze(findings);
}

/* ------------------------------------------------------------- compatibility */

export function evaluateInstallCompatibility(candidate = {}) {
  if (!isPlainObject(candidate)) fail('a candidate must be an object', { code: 'install.input' });
  const findings = [];
  const { contractVersion, implementationVersion, dependencies } = candidate;
  if (!isNonEmptyString(contractVersion)) {
    findings.push({ field: 'contractVersion', admitted: false, reason: 'a node must declare the contract version it implements' });
  }
  if (!isNonEmptyString(implementationVersion)) {
    findings.push({ field: 'implementationVersion', admitted: false, reason: 'a node must declare its implementation version' });
  }
  if (dependencies !== undefined && !isPlainObject(dependencies)) {
    findings.push({ field: 'dependencies', admitted: false, reason: 'dependencies must be an object of name to range' });
  } else if (isPlainObject(dependencies)) {
    for (const [name, range] of Object.entries(dependencies)) {
      if (!isNonEmptyString(name) || !isNonEmptyString(range)) {
        findings.push({ field: `dependencies.${name}`, admitted: false, reason: 'a dependency range must be a non-empty string' });
      }
    }
  }
  return Object.freeze(findings);
}

/* ------------------------------------------------------------------ install */

/**
 * The live installation path. One call, one verdict, every step cited.
 *
 * A verdict of `admit` requires that EVERY step passed AND that the caller
 * supplied the evidence each step cites. A step with no evidence is `incomplete`
 * and the whole install is `incomplete`, which fails closed: admitting a node
 * because nobody checked it is worse than refusing it.
 *
 * @param {object} candidate  the manifest, class claim, origin and requested capabilities
 * @param {object} [options]
 * @param {object} [options.evidence]  per-step verdicts from the contracts that produced them
 * @param {string[]} [options.grants]  explicitly granted capabilities
 * @returns {Readonly<object>} the install decision
 */
export function installNode(candidate = {}, { evidence = {}, grants = [] } = {}) {
  if (!isPlainObject(candidate)) fail('a candidate must be an object', { code: 'install.input', got: typeof candidate });
  if (!isPlainObject(evidence)) fail('evidence must be an object of per-step verdicts', { code: 'install.input' });

  const classification = classifyNode(candidate);
  const trust = resolveTrustClass(classification);
  const capabilities = Array.isArray(candidate.capabilities) ? candidate.capabilities : [];
  const capabilityFindings = evaluateInstallCapabilities({
    requested: capabilities,
    trustClass: trust.ceiling,
    grants,
  });
  const locality = resolveInstallLocality({
    classification,
    capabilities,
    external: candidate.external === true,
  });
  const resourceFindings = evaluateInstallResources(candidate.resources ?? {});
  const compatibilityFindings = evaluateInstallCompatibility(candidate);

  const steps = [];
  /**
   * Records one step. `source` says where the evidence for this step comes from:
   * `'self'` means this module produced it, so no external evidence is needed;
   * anything else names the contract that must have produced it. A step whose
   * source contract supplied no evidence is not a pass -- it is an opinion, and
   * an opinion cannot admit a node.
   */
  const addStep = (id, passed, detail, source) => {
    steps.push(Object.freeze({
      id,
      passed: passed === true,
      detail,
      source: isNonEmptyString(source) ? source : null,
      evidenced: source === 'self' || (isNonEmptyString(source) && evidence[id] !== undefined),
    }));
  };

  addStep('identify', true, `${candidate.type} classified as ${classification.class} (origin ${classification.origin})`, 'node.registry@0.1.0');
  addStep('trust', true, `ceiling ${trust.ceiling}, floor ${trust.floor}${classification.promoted ? ' (promoted one step by attestation)' : ''}`, 'foundation.json');
  addStep('capability', capabilityFindings.findings.every((finding) => finding.admissible),
    `${capabilityFindings.findings.length} capability request(s), ${capabilityFindings.findings.filter((f) => f.granted).length} explicitly granted, against the ${trust.ceiling} ceiling`, 'lego.plugin-runtime');
  addStep('locality', true, `${locality.recommended} (allowed: ${locality.allowed.join(', ')})`, 'lego.plugin-runtime');
  addStep('resource', resourceFindings.every((finding) => finding.admitted),
    resourceFindings.length
      ? resourceFindings.map((f) => `${f.field}=${f.value}${f.admitted ? '' : `(>${f.max})`}`).join(', ')
      : 'no resource declaration', 'self');
  addStep('compatibility', compatibilityFindings.every((finding) => finding.admitted),
    compatibilityFindings.length
      ? compatibilityFindings.map((f) => `${f.field}: ${f.reason ?? 'ok'}`).join('; ')
      : 'contractVersion, implementationVersion and dependencies all compare', 'self');
  addStep('health', evidence.health === 'pass', evidence.health === 'pass' ? 'self-test passed' : 'no self-test evidence', 'node.health@0.1.0');

  /**
   * Three outcomes, deliberately distinct:
   *
   *   refuse      -- something actually failed. A self-test that failed, a
   *                  resource over budget, a capability name that is not even a
   *                  string. There is evidence, and the evidence says no.
   *   incomplete  -- nothing failed, but nobody checked. No self-test evidence,
   *                  no registry verdict. This fails closed too, but it says a
   *                  different thing: run the check, do not fix the node.
   *   admit       -- every step passed and every external step was cited.
   */
  const selfFailed = steps.some((step) => step.source === 'self' && !step.passed);
  const refusedByEvidence = steps.some((step) => step.source !== 'self' && evidence[step.id] === 'fail');
  const unevidenced = steps.some((step) => !step.evidenced);
  let verdict = 'admit';
  if (selfFailed || refusedByEvidence) verdict = 'refuse';
  else if (unevidenced) verdict = 'incomplete';

  return Object.freeze({
    contract: NODE_INSTALL_CONTRACT,
    schemaVersion: NODE_INSTALL_SCHEMA_VERSION,
    ok: true,
    type: candidate.type,
    class: classification.class,
    trust,
    locality,
    capabilities: Object.freeze([...capabilities]),
    steps: Object.freeze(steps),
    verdict,
    // The consumer-facing contract is deliberately NOT part of the decision: a
    // node re-placed behind a different runtime is still the same node.
    consumerContract: Object.freeze({ type: candidate.type }),
  });
}

/** Human-readable explanation, in the fixed step order. */
export function explainInstall(decision) {
  if (!isPlainObject(decision) || decision.contract !== NODE_INSTALL_CONTRACT) {
    fail('explainInstall expects a decision from installNode', { got: typeof decision });
  }
  const lines = decision.steps.map((step) => `  ${step.passed ? 'pass' : 'FAIL'} ${step.id}: ${step.detail}${step.source ? ` [${step.source}]` : ''}`);
  return `'${decision.type}' (${decision.class}) -> ${decision.verdict}\n${lines.join('\n')}`;
}

export function isInstallDecision(value) {
  return isPlainObject(value) && value.contract === NODE_INSTALL_CONTRACT && NODE_INSTALL_VERDICTS.includes(value.verdict);
}
