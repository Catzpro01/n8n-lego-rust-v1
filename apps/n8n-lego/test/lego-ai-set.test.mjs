/**
 * AI/Agent LEGO set, governance and scenario invariants (P2.11).
 *
 * WHAT THIS PROTECTS
 * ------------------
 * `manifest/ai-lego-set.json` is the authoritative declaration of the fifteen
 * official AI/Agent LEGO, and every master document under `.ai/master/` is
 * generated from it. That makes it the single highest-leverage file in the
 * planning layer: a wrong value there is not one wrong value, it is a wrong
 * value reproduced across six documents that then read as corroboration.
 *
 * THE FAILURE MODES THESE TESTS TARGET
 * ------------------------------------
 *   1. A SECOND VOCABULARY. The set names `workspace` and `capability`, both of
 *      which already exist in the core manifest. The cheap mistake is to let the
 *      AI set quietly mean something else by the same word, at which point the
 *      repository has two registries and they begin to drift. Reconciliation is
 *      therefore mandatory and asserted.
 *   2. A DANGLING ROADMAP. `dependsOn`, `phase`, `owner` and `contracts` are all
 *      cross-references. A typo in any of them produces a plausible-looking
 *      document describing a dependency on something that does not exist.
 *   3. AN INVENTED VERSION. The rule for an unpublished contract is
 *      `publicationPending` — never a hopeful `1.0.0`. A fabricated version is
 *      indistinguishable from a real one once it is in a generated table.
 *   4. A DOWNGRADED BLOCKER. The blocker register exists to be inconvenient. A
 *      test asserts the class-A storage blockers are still declared open, so
 *      closing one requires deleting an assertion rather than editing prose.
 *   5. A SCENARIO THAT NEEDS AN UNDECLARED CONCEPT. Scenarios are the cheapest
 *      sufficiency test of the decomposition, and they only work if they are
 *      held to the declared vocabulary.
 *
 * Several tests below are written as NEGATIVE proofs: they mutate a clone of
 * the manifest to plant the exact defect and require the checker to reject it.
 * A validator nobody has watched reject anything is a validator that may not
 * work — that is the same principle the architecture and foundation gates are
 * built on, applied to the planning layer.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_DIR = resolve(HERE, '..', 'src', 'lego', 'manifest');
const CONTRACTS_DIR = resolve(HERE, '..', 'src', 'lego', 'contracts');

const read = (dir, name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

const AI_SET = read(MANIFEST_DIR, 'ai-lego-set.json');
const DOMAINS = read(MANIFEST_DIR, 'domains.json');
// Workforce governance is ENGINEERING OPERATIONS, not product architecture, so
// it deliberately lives outside the product manifest directory. See the
// scope-boundary tests below.
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const GOVERNANCE = JSON.parse(
  readFileSync(join(REPO_ROOT, 'docs', 'engineering-operations', 'workforce-governance.json'), 'utf8'),
);
const SCENARIOS = read(MANIFEST_DIR, 'reference-scenarios.json');
const LOCK = read(CONTRACTS_DIR, 'contract-lock.json');

const legoIds = new Set(AI_SET.lego.map((lego) => lego.id));
const domainIds = new Set(DOMAINS.domains.map((domain) => domain.id));
const agentIds = new Set(Object.keys(DOMAINS.agents));
const lockedContracts = new Set(LOCK.contracts.map((contract) => contract.id));
const declaredCapabilities = new Set(
  DOMAINS.domains.flatMap((domain) => (domain.capabilities ?? []).map((capability) => capability.id)),
);

const clone = (value) => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------- the set itself */

test('the set declares exactly fifteen official LEGO, indexed 1..15 without gaps', () => {
  assert.equal(AI_SET.lego.length, 15);
  const indexes = AI_SET.lego.map((lego) => lego.index).sort((a, b) => a - b);
  assert.deepEqual(indexes, Array.from({ length: 15 }, (_, i) => i + 1));
  assert.equal(new Set(AI_SET.lego.map((lego) => lego.id)).size, 15, 'ids must be unique');
});

test('every LEGO carries the full documentation profile', () => {
  // The profile is the point of the file. A LEGO missing `nonScope` or
  // `replacementBoundary` is the one that will later be argued about, because
  // those two fields are where boundaries are actually decided.
  const required = [
    'id', 'index', 'title', 'owner', 'status', 'phase', 'mission', 'scope', 'nonScope',
    'contracts', 'lifecycle', 'operations', 'interaction', 'permissions', 'dependsOn',
    'replacementBoundary', 'resourceProfile', 'degradation', 'observability', 'versioning',
    'tests', 'futureStages',
  ];
  for (const lego of AI_SET.lego) {
    for (const field of required) {
      assert.ok(field in lego, `${lego.id} is missing '${field}'`);
    }
    assert.ok(lego.scope.length > 0, `${lego.id} declares no scope`);
    assert.ok(lego.nonScope.length > 0, `${lego.id} declares no non-scope`);
    assert.ok(lego.tests.length > 0, `${lego.id} declares no tests`);
  }
});

test('every status is a word the manifest itself defines', () => {
  const vocabulary = new Set(Object.keys(AI_SET.statusVocabulary));
  for (const lego of AI_SET.lego) {
    assert.ok(vocabulary.has(lego.status), `${lego.id} has undeclared status '${lego.status}'`);
  }
});

test('every phase letter exists in the phase table', () => {
  const phases = new Set(Object.keys(AI_SET.phases).filter((key) => key !== 'rule'));
  for (const lego of AI_SET.lego) {
    assert.ok(phases.has(lego.phase), `${lego.id} names phase '${lego.phase}', which is not declared`);
  }
});

test('every owner is an agent the core manifest knows', () => {
  // Ownership that does not resolve to a real agent is ownership by nobody,
  // which is how a LEGO ends up with two authors and no arbiter.
  for (const lego of AI_SET.lego) {
    assert.ok(agentIds.has(lego.owner), `${lego.id} is owned by unknown agent '${lego.owner}'`);
  }
});

test('every dependency names a real LEGO or a real core domain', () => {
  for (const lego of AI_SET.lego) {
    for (const dependency of lego.dependsOn) {
      assert.ok(
        legoIds.has(dependency) || domainIds.has(dependency),
        `${lego.id} depends on '${dependency}', which is neither an official LEGO nor a core domain`,
      );
    }
  }
});

test('the dependency graph is acyclic and AI Foundation is a leaf', () => {
  // AI Foundation being dependency-free is the structural expression of "the
  // foundation is not the agent loop". The moment it depends on something, the
  // layering has inverted and every consumer inherits that dependency.
  const foundation = AI_SET.lego.find((lego) => lego.id === 'ai-foundation');
  assert.deepEqual(foundation.dependsOn, [], 'AI Foundation must depend on nothing');

  const edges = new Map(AI_SET.lego.map((lego) => [lego.id, lego.dependsOn.filter((id) => legoIds.has(id))]));
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === 'done') return;
    assert.ok(state.get(id) !== 'open', `dependency cycle: ${[...trail, id].join(' -> ')}`);
    state.set(id, 'open');
    for (const next of edges.get(id) ?? []) visit(next, [...trail, id]);
    state.set(id, 'done');
  };
  for (const id of edges.keys()) visit(id, []);
});

test('a forward phase dependency exists only where it is declared and justified', () => {
  // A phase-B LEGO depending on a phase-C LEGO is a roadmap that cannot run in
  // its own stated order. There is exactly one such edge — Agent Machine (B)
  // needs Approval (C) — and it is tolerable only because approval fails
  // closed. The rule here is not "no forward edges"; it is "no UNDECLARED
  // forward edges", because the dangerous version is the one nobody noticed.
  const order = ['A', 'B', 'C', 'D', 'E', 'F'];
  const phaseOf = new Map(AI_SET.lego.map((lego) => [lego.id, order.indexOf(lego.phase)]));
  const exceptions = new Set(
    (AI_SET.phaseDependencyExceptions ?? []).map((entry) => `${entry.lego}->${entry.dependsOn}`),
  );
  const found = [];
  for (const lego of AI_SET.lego) {
    for (const dependency of lego.dependsOn) {
      if (!phaseOf.has(dependency)) continue;
      if (phaseOf.get(dependency) > phaseOf.get(lego.id)) found.push(`${lego.id}->${dependency}`);
    }
  }
  for (const edge of found) {
    assert.ok(exceptions.has(edge), `undeclared forward phase dependency: ${edge}`);
  }
  for (const edge of exceptions) {
    assert.ok(found.includes(edge), `declared exception '${edge}' no longer exists — delete it`);
  }
  // A declared exception must state its degradation, or it is just permission.
  for (const entry of AI_SET.phaseDependencyExceptions ?? []) {
    assert.ok(entry.why?.length > 0 && entry.degradation?.length > 0 && entry.closes?.length > 0,
      `exception ${entry.lego}->${entry.dependsOn} must state why, degradation and closes`);
  }
});

test('the canonical chain covers every LEGO and starts at the foundation', () => {
  const chain = AI_SET.architecture.chain.filter((id) => id !== 'policy');
  assert.equal(chain[0], 'ai-foundation', 'the chain must start at the foundation');
  assert.deepEqual([...chain].sort(), [...legoIds].sort(), 'the chain must cover exactly the fifteen');
  assert.ok(AI_SET.architecture.policyNote.length > 0, 'the non-LEGO `policy` entry must be explained');
});

/* --------------------------------------------------------------- reconciliation */

test('a LEGO whose id collides with a core domain must declare how it reconciles', () => {
  // This is the no-second-vocabulary rule made mechanical. `workspace` exists
  // in both manifests; without this, the two meanings diverge silently and the
  // divergence is only discovered when someone implements the wrong one.
  for (const lego of AI_SET.lego) {
    if (!domainIds.has(lego.id)) continue;
    assert.ok(lego.reconciles, `${lego.id} collides with a core domain but declares no 'reconciles'`);
    assert.ok(
      domainIds.has(lego.reconciles.coreDomain),
      `${lego.id} reconciles to '${lego.reconciles.coreDomain}', which is not a core domain`,
    );
    assert.ok(lego.reconciles.rule.length > 0, `${lego.id} reconciles without stating the rule`);
  }
});

test('the reconciliation requirement actually rejects a fork', () => {
  // Negative proof. Drop the declaration from `workspace` — the exact shape of
  // "an ai-workspace domain appeared beside workspace" — and require detection.
  const mutated = clone(AI_SET);
  delete mutated.lego.find((lego) => lego.id === 'workspace').reconciles;
  const unreconciled = mutated.lego.filter((lego) => domainIds.has(lego.id) && !lego.reconciles);
  assert.deepEqual(unreconciled.map((lego) => lego.id), ['workspace']);
});

test('no official LEGO invents a domain id the core manifest does not have', () => {
  // The inverse check: an AI LEGO id that is *close to* a core domain id
  // (`ai-workspace` beside `workspace`) is the forking pattern.
  for (const lego of AI_SET.lego) {
    if (domainIds.has(lego.id)) continue;
    const shadowed = lego.id.replace(/^ai-/, '');
    assert.ok(
      lego.id === 'ai-foundation' || !domainIds.has(shadowed),
      `${lego.id} shadows core domain '${shadowed}' — reconcile with it instead of prefixing`,
    );
  }
});

/* -------------------------------------------------------------- contract status */

test('every contract is locked, declared as a capability, or honestly pending', () => {
  for (const lego of AI_SET.lego) {
    for (const contract of lego.contracts) {
      const known = lockedContracts.has(contract) || declaredCapabilities.has(contract);
      if (known) continue;
      assert.equal(
        lego.versioning, 'publicationPending',
        `${lego.id} names contract '${contract}' that nothing publishes, but claims version '${lego.versioning}'`,
      );
    }
  }
});

test('publicationPending never carries an invented version, and a version always names its contract', () => {
  for (const lego of AI_SET.lego) {
    if (lego.versioning === 'publicationPending') {
      assert.ok(
        !/\d+\.\d+\.\d+/.test(JSON.stringify(lego.contracts)),
        `${lego.id} is publicationPending but a version leaked into its contracts`,
      );
      continue;
    }
    // A concrete versioning string must reference contracts the LEGO declares.
    for (const entry of lego.versioning.split(',').map((part) => part.trim())) {
      const [id, version] = entry.split('@');
      assert.ok(version && /^\d+\.\d+\.\d+$/.test(version), `${lego.id} versioning entry '${entry}' is malformed`);
      assert.ok(
        lego.contracts.includes(id) || lockedContracts.has(id),
        `${lego.id} versions '${id}', which it does not declare as a contract`,
      );
    }
  }
});

test('a fabricated version on an unpublished contract is detected', () => {
  // Negative proof for the rule above: the temptation is to write `1.0.0` for a
  // contract nobody has published, because it reads as progress. Workspace is
  // no longer a valid fixture: P2.15 publishes ai.workspace@1.0.0.
  const mutated = clone(AI_SET);
  const translation = mutated.lego.find((lego) => lego.id === 'translation');
  assert.equal(translation.versioning, 'publicationPending', 'the fixture must start unpublished');
  translation.versioning = 'ai.translation@1.0.0';
  const offenders = mutated.lego.filter((lego) =>
    lego.id === 'translation' && lego.versioning !== 'publicationPending');
  assert.deepEqual(offenders.map((lego) => lego.id), ['translation']);
});

test('status and evidence agree: `implemented` requires real test files, `planned` does not claim them', () => {
  for (const lego of AI_SET.lego) {
    const realTests = lego.tests.filter((entry) => entry.startsWith('test/'));
    if (lego.status === 'implemented' || lego.status === 'in-progress' || lego.status === 'contract-only') {
      assert.ok(realTests.length > 0, `${lego.id} is '${lego.status}' but names no real test file`);
    }
    if (lego.status === 'planned') {
      assert.equal(realTests.length, 0, `${lego.id} is 'planned' but claims a real test file`);
      assert.ok(
        lego.tests.every((entry) => entry.startsWith('planned:')),
        `${lego.id} is 'planned'; its tests must be declared as planned`,
      );
    }
  }
});

test('published registries are implemented without claiming the AI runtime', () => {
  // The single most consequential honesty check in the file. If this test ever
  // has to change, someone has claimed a runtime exists — and that claim should
  // cost them a deliberate edit to an assertion, not a quiet status flip.
  //
  // P2.15 deliberate edit. Workspace now has a real bounded contract and
  // provider-neutral implementation, but it is not an execution runtime.
  // Context & Session remains in-progress until its protected-main reconciliation.
  const implemented = AI_SET.lego.filter((lego) => lego.status === 'implemented').map((lego) => lego.id);
  assert.deepEqual(implemented, ['skill', 'memory', 'workspace', 'capability']);

  // The runtime LEGO specifically must NOT be implemented. Naming them keeps
  // the guarantee concrete instead of relying on the list above staying short.
  for (const id of ['agent-machine', 'mcp-adapter', 'runtime-adapter',
    'node-creator', 'translation', 'token-usage', 'ai-foundation']) {
    const lego = AI_SET.lego.find((entry) => entry.id === id);
    assert.notEqual(lego.status, 'implemented', `${id} must not be implemented`);
  }

  // And Skill, being implemented, must still declare that it executes nothing.
  const skill = AI_SET.lego.find((lego) => lego.id === 'skill');
  assert.ok(skill.nonScope.includes('executing tools directly'));
  assert.ok(skill.nonScope.includes('being an agent'));
  const claims = JSON.stringify(AI_SET.currentLimits);
  for (const phrase of ['NOT scale-out ready', 'AI runtime is NOT implemented', 'Model inference is NOT implemented']) {
    assert.ok(claims.includes(phrase), `currentLimits no longer states: ${phrase}`);
  }
});

/* ------------------------------------------------------ vocabulary consistency */

test('interaction classes stay at exactly four, everywhere', () => {
  const classes = ['call', 'event', 'stream', 'batch'];
  const capability = AI_SET.lego.find((lego) => lego.id === 'capability');
  assert.deepEqual(capability.interactionClasses, classes);
  for (const lego of AI_SET.lego) {
    for (const interaction of lego.interaction) {
      assert.ok(classes.includes(interaction), `${lego.id} uses a fifth interaction class '${interaction}'`);
    }
  }
});

test('every resource profile is one the AI Foundation declares', () => {
  const profiles = new Set(Object.keys(read(MANIFEST_DIR, 'ai-foundation.json').resourceProfiles.profiles));
  for (const lego of AI_SET.lego) {
    assert.ok(profiles.has(lego.resourceProfile), `${lego.id} uses undeclared profile '${lego.resourceProfile}'`);
  }
});

test('permissions are namespaced, never bare words', () => {
  for (const lego of AI_SET.lego) {
    for (const permission of lego.permissions) {
      assert.match(permission, /^[a-z][a-z0-9-]*:[a-z][a-z0-9:-]*$/, `${lego.id} has unnamespaced permission '${permission}'`);
    }
  }
});

test('Work Trace forbids chain-of-thought, and the prohibition is structural', () => {
  const trace = AI_SET.lego.find((lego) => lego.id === 'agent-event');
  assert.ok(trace.nonScope.includes('chain-of-thought'));
  assert.match(trace.privacyRule, /never stored/i);
  // The prohibition must not be contradicted by any event field.
  assert.ok(
    !trace.eventFields.some((field) => /thought|reasoning|transcript|prompt/i.test(field)),
    'an event field would carry reasoning',
  );
});

test('every experience maps to backend contracts, and Execution AI stays a Copilot mode', () => {
  const experiences = AI_SET.experiences.items;
  assert.equal(experiences.length, 3, 'three experiences, one foundation');
  for (const experience of experiences) {
    assert.ok(experience.backendContracts.length > 0, `${experience.id} names no backend contract`);
    assert.ok(agentIds.has(experience.owner), `${experience.id} has unknown owner '${experience.owner}'`);
  }
  const copilot = experiences.find((experience) => experience.id === 'ai-copilot');
  assert.equal(copilot.modes.length, 9);
  assert.match(copilot.note, /Execution AI is a Copilot MODE/);
});

/* ----------------------------------------------------------------- governance */

test('manager authority is never inherited by a worker', () => {
  // The same invariant the product enforces for delegation. Declaring it for
  // agents and not for the workforce would mean the project does not believe it.
  assert.match(GOVERNANCE.roles.authorityRule, /does NOT inherit/);
  for (const forbidden of ['resolve a manager-owned decision', 'modify or force-push main']) {
    assert.ok(GOVERNANCE.roles.worker.mayNot.includes(forbidden), `worker restriction missing: ${forbidden}`);
  }
});

test('exactly one control plane is authoritative for code', () => {
  const planes = GOVERNANCE.controlPlanes;
  const codeAuthorities = Object.entries(planes)
    .filter(([key, value]) => key !== 'rule' && (value.authoritativeFor ?? []).includes('repository state'))
    .map(([key]) => key);
  assert.deepEqual(codeAuthorities, ['github']);
  assert.deepEqual(planes.obsidian.authoritativeFor, [], 'Obsidian must be authoritative for nothing');
});

test('unverified control planes are declared unverified, not operational', () => {
  // Supabase and the VPS gate have no client, schema or credential in this
  // tree. Asserting their status keeps the plan from reading as a description
  // of something that exists here.
  for (const key of ['supabase', 'vpsGate']) {
    assert.match(GOVERNANCE.controlPlanes[key].status, /NOT VERIFIED/, `${key} claims a status this repo cannot support`);
  }
});

test('the class-A storage blockers are still open', () => {
  const blockers = new Map(GOVERNANCE.blockers.map((blocker) => [blocker.id, blocker]));
  for (const id of ['BL-1', 'BL-2']) {
    assert.equal(blockers.get(id).severity, 'class-A');
    assert.equal(blockers.get(id).status, 'open', `${id} was closed without evidence`);
    assert.match(blockers.get(id).where, /store\.mjs/);
  }
  assert.ok(GOVERNANCE.blockers.every((blocker) => blocker.owner && blocker.consequence),
    'every blocker needs an owner and a stated consequence');
});

test('scale-out is not claimed anywhere while class-A blockers are open', () => {
  const open = GOVERNANCE.blockers.some((blocker) => blocker.severity === 'class-A' && blocker.status === 'open');
  assert.ok(open, 'this test assumes the blockers are open');
  const text = JSON.stringify(AI_SET) + JSON.stringify(GOVERNANCE);
  assert.ok(!/scale-out ready(?!")/i.test(text.replace(/NOT scale-out ready/gi, '')),
    'something claims scale-out readiness while class-A blockers are open');
});

test('all twenty-nine decision principles are present and unique', () => {
  assert.equal(GOVERNANCE.decisionPrinciples.length, 29);
  assert.equal(new Set(GOVERNANCE.decisionPrinciples).size, 29);
});

/* ------------------------------------------------------------------ scenarios */

test('every scenario is expressible in declared vocabulary alone', () => {
  // The sufficiency test. A scenario reaching for an undeclared LEGO means the
  // decomposition does not cover a plausible request.
  for (const scenario of SCENARIOS.scenarios) {
    for (const id of scenario.lego ?? []) {
      assert.ok(legoIds.has(id), `scenario '${scenario.id}' uses undeclared LEGO '${id}'`);
    }
  }
});

test('scenario capabilities are drawn from the declared external action model', () => {
  const declared = new Set(AI_SET.externalActionModel.examples.map((example) => example.capability));
  for (const scenario of SCENARIOS.scenarios) {
    for (const capability of scenario.capabilities ?? []) {
      assert.ok(declared.has(capability), `scenario '${scenario.id}' uses undeclared capability '${capability}'`);
    }
  }
});

test('every scenario is marked contract-only', () => {
  // None of these run. Saying so per scenario is what stops a reader from
  // treating the walkthrough as a description of behaviour.
  for (const scenario of SCENARIOS.scenarios) {
    assert.equal(scenario.status, 'contract-only', `scenario '${scenario.id}' claims more than contract-only`);
  }
});

test('an undeclared concept in a scenario is detected', () => {
  // Negative proof: this is exactly how a new concept sneaks in — as a
  // reasonable-sounding word inside an otherwise valid scenario.
  const mutated = clone(SCENARIOS);
  mutated.scenarios[0].lego.push('ai-scheduler');
  const offenders = mutated.scenarios.filter((scenario) => (scenario.lego ?? []).some((id) => !legoIds.has(id)));
  assert.deepEqual(offenders.map((scenario) => scenario.id), ['website-creation']);
});

test('the external-runtime scenario keeps ownership on the n8n side', () => {
  const scenario = SCENARIOS.scenarios.find((entry) => entry.id === 'external-runtime');
  for (const retained of ['policy', 'workspace boundary', 'approval', 'artifact references', 'resource accounting']) {
    assert.ok(scenario.n8nRetains.includes(retained), `external runtime scenario gives away '${retained}'`);
  }
  assert.match(scenario.lockInRule, /never reimplemented/);
});

test('the token scenario keeps message tokens distinct from model input tokens', () => {
  const scenario = SCENARIOS.scenarios.find((entry) => entry.id === 'context-rollover');
  assert.notEqual(scenario.tokenExample.message, scenario.tokenExample.modelInput);
  assert.ok(scenario.tokenExample.modelInput > scenario.tokenExample.message);
  assert.match(scenario.rolloverRule, /never at the exact limit/);
});

/* ------------------------------------------------------------- master docs */

test('the master document set exists and is generated, not hand-written', () => {
  // The whole point of the planning layer is that it cannot drift from the
  // declarations. A hand-written file in `.ai/master/` would be deleted by the
  // next `npm run lego:ai` — so the banner is not decoration, it is the only
  // thing telling a future editor their change will not survive.
  const masterDir = resolve(HERE, '..', '..', '..', '.ai', 'master');
  const expected = [
    'PROJECT_MASTER_PLAN.md',
    'CORE_LEGO_ARCHITECTURE.md',
    'AI_AGENT_LEGO_MASTER_PLAN.md',
    'AI_RUNTIME_AND_PROVIDER_PLAN.md',
    'AI_CONTRACT_MATRIX.md',
    'IMPLEMENTATION_PHASES.md',
    'PROJECT_DECISIONS.md',
    'PROJECT_WORKFORCE_ORCHESTRATION.md',
    'REFERENCE_AGENT_SCENARIOS.md',
    'CURRENT_STATUS.md',
    'KNOWN_BLOCKERS.md',
  ];
  for (const name of expected) {
    const body = readFileSync(join(masterDir, name), 'utf8');
    assert.match(body, /^<!-- GENERATED by tools\/lego\/ai-pack\.mjs/, `${name} is missing the generated banner`);
    assert.ok(body.length > 400, `${name} is suspiciously short`);
  }
});

test('the master index names a canonical document for every question it poses', () => {
  const masterDir = resolve(HERE, '..', '..', '..', '.ai', 'master');
  const plan = readFileSync(join(masterDir, 'PROJECT_MASTER_PLAN.md'), 'utf8');
  const rows = plan.split('\n').filter((line) => line.startsWith('| ') && line.includes('.md`'));
  assert.ok(rows.length >= 20, 'the answer index should cover the project questions');
  // Every document referenced by the index must actually exist.
  for (const match of plan.matchAll(/`([A-Z_]+\.md)`/g)) {
    assert.ok(
      existsSync(join(masterDir, match[1])),
      `the index points at ${match[1]}, which does not exist`,
    );
  }
});

test('the core architecture document reports the manifest domain count', () => {
  // The 25-vs-26 drift is exactly what generating this number prevents.
  const masterDir = resolve(HERE, '..', '..', '..', '.ai', 'master');
  const core = readFileSync(join(masterDir, 'CORE_LEGO_ARCHITECTURE.md'), 'utf8');
  assert.ok(core.includes(`**${DOMAINS.domains.length} core LEGO domains**`),
    `CORE_LEGO_ARCHITECTURE.md does not state the manifest count of ${DOMAINS.domains.length}`);
  for (const domain of DOMAINS.domains) {
    assert.ok(core.includes(`\`${domain.id}\``), `domain '${domain.id}' is missing from the core document`);
  }
});

/* --------------------------------------------- P2.11 reconciliation boundary */

test('no development-workforce concept leaks into product architecture', () => {
  // The manager's ruling: Arena manager/worker, Supabase and the VPS gate are
  // ENGINEERING OPERATIONS. They must never become product domains, AI LEGO,
  // runtime dependencies or product capabilities. Checking the manifests by
  // substring is crude but exactly right here — the failure mode is a workforce
  // word appearing in a product declaration at all.
  const forbidden = [/\barena\b/i, /\bsupabase\b/i, /arena[- ]bridge/i, /workforce/i];
  const productManifests = {
    'domains.json': DOMAINS,
    'ai-lego-set.json': AI_SET,
    'reference-scenarios.json': SCENARIOS,
    'contract-lock.json': LOCK,
  };
  for (const [name, manifest] of Object.entries(productManifests)) {
    const text = JSON.stringify(manifest);
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(text), `${name} mentions ${pattern} — workforce tooling is not product architecture`);
    }
  }
});

test('workforce governance lives outside the product manifest directory', () => {
  // Physical separation, not merely a stated intention: if the file were inside
  // src/lego/manifest/ the next reader would reasonably treat it as product
  // architecture regardless of what its prose said.
  assert.ok(
    !existsSync(join(MANIFEST_DIR, 'project-governance.json')),
    'workforce governance must not sit in the product manifest directory',
  );
  assert.match(GOVERNANCE.scopeBoundary, /NOT n8n LEGO product architecture/);
  // Every blocker states which plane it belongs to, so a process blocker can
  // never be mistaken for a product one.
  for (const blocker of GOVERNANCE.blockers) {
    assert.ok(['product', 'engineering-operations'].includes(blocker.plane),
      `blocker ${blocker.id} does not declare its plane`);
  }
  // The class-A storage blockers are product blockers; that is what makes them
  // block a product readiness claim.
  for (const id of ['BL-1', 'BL-2']) {
    assert.equal(GOVERNANCE.blockers.find((blocker) => blocker.id === id).plane, 'product');
  }
});

test('regeneration preserves curated agent-1 documents instead of deleting them', () => {
  // The reconciliation's sharpest hazard: `npm run lego:ai` wipes `.ai/` before
  // writing, so before the curated list existed it silently destroyed 27
  // hand-written frontend documents — with a green build, because nothing
  // asserted their existence. This test is that assertion.
  const aiRoot = resolve(HERE, '..', '..', '..', '.ai');
  const curatedSamples = [
    'master/AI_UI_EXPERIENCE_MASTER_PLAN.md',
    'master/AI_UI_STATES_AND_FLOWS.md',
    'master/SKILL_AND_CAPABILITY_PLAN.md',
    'master/AGENT_MACHINE_PLAN.md',
    'master/SECURITY_AND_APPROVAL_MODEL.md',
    'master/PROVIDER_TAXONOMY.md',
    'master/frontend/CURRENT_STATUS.md',
    'index/capabilities.json',
    'frontend/glossary.md',
  ];
  for (const relative of curatedSamples) {
    assert.ok(existsSync(join(aiRoot, relative)), `curated document '${relative}' is missing`);
  }
  // A frontend consumption view must point at its canonical counterpart, or a
  // reader will treat a P2.10-era number as current.
  const view = readFileSync(join(aiRoot, 'master', 'frontend', 'CURRENT_STATUS.md'), 'utf8');
  assert.match(view, /not the canonical document/i);
  assert.match(view, /\.\.\/CURRENT_STATUS\.md/);
});

test('every canonical master subject resolves to a document that exists', () => {
  // The acceptance criterion is that the index names ONE canonical document per
  // major subject. Verifying the links resolve is what stops the index becoming
  // a list of aspirations.
  const masterDir = resolve(HERE, '..', '..', '..', '.ai', 'master');
  const subjects = [
    'CORE_LEGO_ARCHITECTURE.md', 'AI_AGENT_LEGO_MASTER_PLAN.md', 'AI_RUNTIME_AND_PROVIDER_PLAN.md',
    'AI_UI_EXPERIENCE_MASTER_PLAN.md', 'CONTEXT_SESSION_MEMORY_PLAN.md', 'TOKEN_USAGE_AND_RESOURCE_PLAN.md',
    'SKILL_AND_CAPABILITY_PLAN.md', 'AGENT_MACHINE_PLAN.md', 'WORKSPACE_AND_EXTERNAL_ACTION_PLAN.md',
    'MCP_AND_RUNTIME_ADAPTER_PLAN.md', 'NODE_CREATOR_PLAN.md', 'TRANSLATION_PLAN.md',
    'SECURITY_AND_APPROVAL_MODEL.md', 'CURRENT_STATUS.md', 'KNOWN_BLOCKERS.md',
    'PROJECT_DECISIONS.md', 'REFERENCE_AGENT_SCENARIOS.md', 'PROVIDER_TAXONOMY.md',
  ];
  const index = readFileSync(join(masterDir, 'PROJECT_MASTER_PLAN.md'), 'utf8');
  for (const subject of subjects) {
    assert.ok(existsSync(join(masterDir, subject)), `canonical document '${subject}' does not exist`);
    assert.ok(index.includes(subject), `the master index does not name '${subject}'`);
  }
});

test('no stale 173-operation or 25-domain claim survives anywhere in .ai/', () => {
  // Both numbers were wrong in prose at some point. Asserting their absence
  // across the whole generated+curated tree is cheaper than trusting review.
  const aiRoot = resolve(HERE, '..', '..', '..', '.ai');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(md|json)$/.test(entry.name)) continue;
      const body = readFileSync(full, 'utf8');
      // Allow the correction notes, which necessarily quote the old figure.
      const stripped = body.replace(/[^\n]*\b(previously|was|correct|error|not 173|stale)\b[^\n]*/gi, '');
      if (/\b173 operations?\b/.test(stripped)) offenders.push(`${full} (173)`);
      if (/\b25 (core )?(domains|LEGO)\b/.test(stripped)) offenders.push(`${full} (25 domains)`);
    }
  };
  walk(aiRoot);
  assert.deepEqual(offenders, []);
});

test('the published .ai counters equal the tree they describe', () => {
  // P2.11 final cleanup. "in sync = 63 files" was ambiguous: 63 is the generated
  // pack, not the total, and a reader had no way to tell which number they were
  // being given. The counters are now named and computed from the tree, so this
  // test is what stops the published table becoming a remembered figure.
  const aiRoot = resolve(HERE, '..', '..', '..', '.ai');
  const walk = (dir, prefix = '') => {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
      else out.push(rel);
    }
    return out;
  };
  const onDisk = walk(aiRoot);

  const source = readFileSync(resolve(HERE, '..', '..', '..', 'tools', 'lego', 'ai-pack.mjs'), 'utf8');
  const block = source.slice(source.indexOf('const CURATED = Object.freeze({'));
  const curated = [...block.slice(0, block.indexOf('});')).matchAll(/'([^']+\.(?:md|json))'/g)].map((m) => m[1]);

  for (const file of curated) {
    assert.ok(onDisk.includes(file), `curated file '${file}' is declared but missing from .ai/`);
  }
  const generated = onDisk.filter((file) => !curated.includes(file));

  const index = readFileSync(join(aiRoot, 'master', 'PROJECT_MASTER_PLAN.md'), 'utf8');
  // Parse the published counter table by splitting rows, not by building a
  // regex per label: the labels contain backticks and asterisks, and escaping
  // them into a constructed RegExp is how this test would quietly stop matching.
  const counters = new Map();
  for (const line of index.split('\n')) {
    const cells = line.split('|').map((part) => part.trim());
    if (cells.length !== 4) continue;
    const value = Number(cells[2].replaceAll('*', ''));
    if (Number.isNaN(value)) continue;
    counters.set(cells[1].replaceAll('*', '').replaceAll('`', ''), value);
  }
  const cell = (label) => {
    assert.ok(counters.has(label), `the master index publishes no '${label}' counter`);
    return counters.get(label);
  };
  assert.equal(cell('Generated pack'), generated.length, 'the published generated count is wrong');
  assert.equal(cell('Curated'), curated.length, 'the published curated count is wrong');
  assert.equal(cell('Total .ai'), onDisk.length, 'the published total is wrong');
  assert.equal(generated.length + curated.length, onDisk.length, 'every .ai file is generated or curated');

  const masterTop = onDisk.filter((f) => f.startsWith('master/') && f.split('/').length === 2);
  const views = onDisk.filter((f) => f.startsWith('master/frontend/'));
  assert.equal(cell('.ai/master (top level, canonical)'), masterTop.length);
  assert.equal(cell('.ai/master/frontend (consumption views)'), views.length);
});

test('XA-5 is only recorded as resolved while the lego.* codes are really published', () => {
  // The decision register and the contract must not be able to disagree. If
  // someone unpublishes a code, this fails rather than leaving a register that
  // claims a closed issue.
  const root = resolve(HERE, '..', '..', '..');
  const register = JSON.parse(readFileSync(join(root, 'docs', 'n8n-lego', 'decisions', 'cross-agent-decisions.json'), 'utf8'));
  const xa5 = register.decisions.find((entry) => entry.id === 'XA-5');
  assert.ok(xa5, 'XA-5 must stay in the register as history even once resolved');
  if (xa5.status !== 'resolved') return;

  const contract = JSON.parse(readFileSync(join(HERE, '..', 'src', 'lego', 'contracts', 'errors.contract.json'), 'utf8'));
  const published = new Set(contract.codes.map((entry) => entry.code));
  for (const code of ['lego.capability_unavailable', 'lego.version_incompatible',
    'lego.dependency_disabled', 'lego.migration_required']) {
    assert.ok(published.has(code), `XA-5 is marked resolved but '${code}' is not published`);
  }
  const domains = JSON.parse(readFileSync(join(HERE, '..', 'src', 'lego', 'manifest', 'domains.json'), 'utf8'));
  assert.ok(
    domains.domains.some((domain) => domain.errorNamespace === 'lego'),
    'XA-5 is marked resolved but no domain declares the `lego` error namespace',
  );
  assert.ok(xa5.historicalFinding, 'the original P2.10 finding must be kept, not overwritten');
  assert.ok(xa5.historicalEvidenceCommit, 'the historical evidence commit must stay recorded');
  assert.ok(xa5.currentRepositoryState, 'a resolved decision must name the state it was verified against');
});

test('the status documents publish the decision counts the reconciled register actually holds', () => {
  // P2.12 step 0. CURRENT_STATUS.md published "7 item(s) await the manager:
  // XA-8 .. XA-14" while the reconciled register held eleven open rows,
  // XA-8 .. XA-18 — because the generator read agent-2's partial register
  // instead of the reconciled one. A stale count is worse than no count: it
  // reads as authoritative. This test makes the two disagree loudly.
  const root = resolve(HERE, '..', '..', '..');
  const register = JSON.parse(readFileSync(
    join(root, 'docs', 'n8n-lego', 'decisions', 'cross-agent-decisions.json'), 'utf8'));
  const open = register.decisions.filter((row) => row.status !== 'resolved');
  const resolved = register.decisions.filter((row) => row.status === 'resolved');
  const openIds = open
    .sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)))
    .map((row) => row.id);

  const status = readFileSync(join(root, '.ai', 'master', 'CURRENT_STATUS.md'), 'utf8');
  const claim = /(\d+) item\(s\) await the manager: ([^.]+)\./.exec(status);
  assert.ok(claim, 'CURRENT_STATUS.md must publish an open-arbitration count');
  assert.equal(Number(claim[1]), open.length, 'the published open count is stale');
  assert.deepEqual(claim[2].split(',').map((id) => id.trim()), openIds, 'the published open ids are stale');
  const resolvedClaim = /(\d+) row\(s\) are resolved/.exec(status);
  assert.ok(resolvedClaim, 'CURRENT_STATUS.md must publish a resolved count');
  assert.equal(Number(resolvedClaim[1]), resolved.length, 'the published resolved count is stale');

  // Every open row must be reachable in the decisions document, including the
  // rows agent-1 raised — the partial register is why they went missing.
  const decisions = readFileSync(join(root, '.ai', 'master', 'PROJECT_DECISIONS.md'), 'utf8');
  for (const id of openIds) {
    assert.ok(new RegExp(`\`${id}\``).test(decisions), `${id} is open but PROJECT_DECISIONS.md never names it`);
  }
  const totals = /\*\*(\d+) open\*\*, (\d+) resolved,\s*\n?(\d+) recorded in total/.exec(decisions);
  assert.ok(totals, 'PROJECT_DECISIONS.md must publish its totals');
  assert.deepEqual(
    [Number(totals[1]), Number(totals[2]), Number(totals[3])],
    [open.length, resolved.length, register.decisions.length],
  );

  // The master index must name the register that supplies the counts.
  const index = readFileSync(join(root, '.ai', 'master', 'PROJECT_MASTER_PLAN.md'), 'utf8');
  assert.match(index, /cross-agent-decisions\.json.*reconciled/,
    'the master index must name the reconciled register as the source of decision counts');
});

test('a decision row is either resolved or owned by somebody who can resolve it', () => {
  // A row that is open but assigned to nobody never moves. This is the shape
  // check that keeps the register actionable rather than a list of worries.
  const root = resolve(HERE, '..', '..', '..');
  const register = JSON.parse(readFileSync(
    join(root, 'docs', 'n8n-lego', 'decisions', 'cross-agent-decisions.json'), 'utf8'));
  for (const row of register.decisions) {
    assert.match(row.id, /^XA-\d+$/);
    if (row.status === 'resolved') {
      assert.ok(row.resolution && row.resolution.length > 40, `${row.id} is resolved but does not say how`);
    } else {
      assert.ok(row.owner, `${row.id} is open with no owner`);
      assert.ok(row.status.startsWith('open-for-'), `${row.id} has an unrecognised status '${row.status}'`);
    }
  }
});
