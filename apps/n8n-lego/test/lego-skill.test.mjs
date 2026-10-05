/**
 * Skill LEGO tests (P2.12).
 *
 * The Skill registry is real code, so unlike the contract-only AI tests these
 * exercise behaviour. They are organised around the ways this specific design
 * fails in practice:
 *
 *   1. a skill quietly becomes an actor — something in the lifecycle starts
 *      implying permission to run, and "selected" turns into "allowed";
 *   2. the capability map turns into a capability GRANT, so declaring a
 *      requirement becomes a way of obtaining it;
 *   3. discovery stops being lazy the moment one convenience field is added to
 *      `list()`, and the context window is gone before work starts;
 *   4. the state machine grows a shortcut, and `active` no longer guarantees a
 *      loaded body;
 *   5. an unknown capability is treated as "probably fine";
 *   6. a second top-level AI domain appears for skill internals.
 *
 * Negative tests here assert the refusal AND its reason: a test that only
 * checks "it threw" passes just as happily when the code throws for the wrong
 * reason.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SKILL_CONTRACT,
  SKILL_CONTRACT_VERSION,
  SKILL_LIFECYCLE,
  SKILL_OPERATIONS,
  SKILL_TRANSITIONS,
  SKILL_TRUST_LEVELS,
  SkillError,
  createSkillRegistry,
} from '../src/lego/skill.mjs';
import { loadRegistry } from '../src/lego/registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const registry = loadRegistry();

/** A capability that really is declared in this tree, so tests stay honest. */
const REAL_CAPABILITY = 'lego.capability-negotiation';
/** A destructive one, by declared permission, for the trust tests. */
const REAL_DESTRUCTIVE = 'workflow.crud';

const declaration = (overrides = {}) => ({
  id: 'demo.summarise',
  contractVersion: '1.0.0',
  implementationVersion: '1.0.0',
  owner: 'manager',
  title: 'Summarise a workflow',
  description: 'Explain what a workflow does, in order, without running it.',
  trust: 'core',
  requiredCapabilities: [REAL_CAPABILITY],
  produces: ['summary'],
  ...overrides,
});

const fresh = () => createSkillRegistry({ registry });

/* ------------------------------------------------------------ 1. registration */

test('a valid skill registers, and is immediately discoverable at L0', () => {
  const skills = fresh();
  const id = skills.register(declaration());
  assert.equal(id, 'demo.summarise');
  assert.equal(skills.size, 1);
  assert.equal(skills.stateOf(id), 'registered');

  const listed = skills.list();
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]).sort(), ['id', 'state', 'summary', 'title', 'trust']);
  assert.equal(skills.resolve(id).title, 'Summarise a workflow');
  assert.equal(skills.resolve('nope'), null);
});

test('a declaration missing a required field is refused, naming the field', () => {
  const skills = fresh();
  for (const field of ['id', 'contractVersion', 'implementationVersion', 'owner', 'title', 'description', 'trust']) {
    const broken = declaration();
    delete broken[field];
    assert.throws(() => skills.register(broken), (error) => {
      assert.ok(error instanceof SkillError);
      assert.equal(error.code, 'lego.contract_violation');
      assert.match(error.message, new RegExp(field));
      return true;
    }, `a skill without '${field}' must be refused`);
  }
});

test('an unknown trust level is refused rather than coerced', () => {
  const skills = fresh();
  assert.throws(() => skills.register(declaration({ trust: 'probably-fine' })), (error) => {
    assert.equal(error.code, 'lego.contract_violation');
    assert.match(error.message, /unknown trust/);
    return true;
  });
  // And the real levels all work.
  for (const trust of SKILL_TRUST_LEVELS) {
    const skills2 = fresh();
    assert.doesNotThrow(() => skills2.register(declaration({ trust })));
  }
});

/* --------------------------------------------------------------- 2. duplicates */

test('a duplicate id is refused — the second registration never silently wins', () => {
  const skills = fresh();
  skills.register(declaration());
  assert.throws(() => skills.register(declaration({ title: 'A different skill, same id' })), (error) => {
    assert.equal(error.code, 'lego.contract_violation');
    assert.match(error.message, /already registered/);
    return true;
  });
  // The original survived intact: a rejected duplicate must not mutate state.
  assert.equal(skills.size, 1);
  assert.equal(skills.resolve('demo.summarise').title, 'Summarise a workflow');
});

/* ----------------------------------------------------- 3. version compatibility */

test('version compatibility is by contract major, and refused at registration', () => {
  const skills = fresh();
  assert.doesNotThrow(() => skills.register(declaration({ id: 'demo.a', contractVersion: '1.7.3' })),
    'a later minor of the same major is compatible');

  assert.throws(() => skills.register(declaration({ id: 'demo.b', contractVersion: '2.0.0' })), (error) => {
    assert.equal(error.code, 'lego.version_incompatible');
    return true;
  }, 'a different major is refused');

  // Refused at REGISTRATION, not at use: a skill that can never be selected
  // must not appear in the list as though it might be.
  assert.equal(skills.list().some((skill) => skill.id === 'demo.b'), false);
});

test('the implementation version moves freely while the contract holds', () => {
  const skills = fresh();
  skills.register(declaration({ implementationVersion: '9.4.1' }));
  const card = skills.describe('demo.summarise');
  assert.equal(card.contractVersion, '1.0.0');
  assert.equal(card.implementationVersion, '9.4.1');
  assert.equal(card.availability, 'available', 'implementation version must not affect availability');
});

/* ------------------------------------------------------------- 4/5. lifecycle */

test('the declared lifecycle is exactly the six states, in order', () => {
  assert.deepEqual(SKILL_LIFECYCLE,
    ['registered', 'available', 'selected', 'loaded', 'active', 'released']);
});

test('the happy path walks every state', () => {
  const skills = fresh();
  const id = skills.register(declaration(), { load: () => ({ procedure: ['read', 'summarise'] }) });
  assert.equal(skills.stateOf(id), 'registered');
  assert.equal(skills.transition(id, 'available'), 'available');
  assert.equal(skills.transition(id, 'selected'), 'selected');
  skills.load(id);
  assert.equal(skills.stateOf(id), 'loaded');
  assert.equal(skills.transition(id, 'active'), 'active');
  assert.equal(skills.transition(id, 'released'), 'released');
  assert.equal(skills.bodyOf(id), null, 'releasing drops the loaded body');
});

test('every illegal transition is refused, and the error names what was allowed', () => {
  // Exhaustive: for each state, every target NOT in its transition list must
  // throw. A hand-picked example would pass while a hole existed elsewhere.
  for (const from of SKILL_LIFECYCLE) {
    for (const to of SKILL_LIFECYCLE) {
      if (SKILL_TRANSITIONS[from].includes(to)) continue;
      const skills = fresh();
      const id = skills.register(declaration());
      // Drive to `from` along the legal path.
      const path = { registered: [], available: ['available'], selected: ['available', 'selected'],
        loaded: ['available', 'selected'], active: ['available', 'selected'],
        released: ['available', 'released'] }[from];
      for (const step of path) skills.transition(id, step);
      if (from === 'loaded' || from === 'active') {
        skills.load(id);
        if (from === 'active') skills.transition(id, 'active');
      }
      assert.equal(skills.stateOf(id), from);
      assert.throws(() => skills.transition(id, to), (error) => {
        assert.equal(error.code, 'lego.interaction_mismatch',
          `${from} -> ${to} must fail as an interaction mismatch`);
        assert.match(error.message, new RegExp(`${from} -> ${to}`));
        return true;
      }, `${from} -> ${to} must be refused`);
      assert.equal(skills.stateOf(id), from, 'a refused transition must not move the state');
    }
  }
});

test('a skill cannot reach active without a loaded body', () => {
  const skills = fresh();
  const id = skills.register(declaration());
  skills.transition(id, 'available');
  skills.transition(id, 'selected');
  // `selected -> active` is not a declared transition: active asserts the body
  // is in memory, so skipping load would make the state a lie.
  assert.throws(() => skills.transition(id, 'active'), (error) => {
    assert.equal(error.code, 'lego.interaction_mismatch');
    return true;
  });
  assert.throws(() => skills.load('nope'), (error) => {
    assert.equal(error.code, 'lego.capability_unavailable');
    return true;
  });
});

test('load refuses unless the skill is selected', () => {
  const skills = fresh();
  const id = skills.register(declaration(), { load: () => ({ procedure: [] }) });
  assert.throws(() => skills.load(id), (error) => {
    assert.equal(error.code, 'lego.interaction_mismatch');
    assert.match(error.message, /must be 'selected'/);
    return true;
  });
});

/* --------------------------------------------------------- 6. lazy discovery */

test('discovery never loads a body — the loader is not invoked by list, resolve, describe or validate', () => {
  const skills = fresh();
  let loaderCalls = 0;
  const id = skills.register(declaration(), {
    load: () => { loaderCalls += 1; return { procedure: ['step'], knowledge: 'a great deal of text' }; },
  });

  skills.list();
  skills.resolve(id);
  skills.describe(id);
  skills.validateSelection(id);
  skills.availabilityOf(id);
  skills.list();

  assert.equal(loaderCalls, 0, 'discovery must not load the body');
  assert.equal(skills.loadCount(id), 0);
  assert.equal(skills.bodyOf(id), null);
  assert.equal(skills.describe(id).loaded, false);

  skills.transition(id, 'available');
  skills.transition(id, 'selected');
  skills.load(id);
  assert.equal(loaderCalls, 1, 'load is the only thing that loads');
  assert.equal(skills.loadCount(id), 1);
  assert.deepEqual(skills.bodyOf(id).procedure, ['step']);
});

test('describe returns the card without the procedure or deep knowledge', () => {
  const skills = fresh();
  skills.register(declaration(), { load: () => ({ procedure: ['secret step'], knowledge: 'L3' }) });
  const card = skills.describe('demo.summarise');
  const serialised = JSON.stringify(card);
  assert.equal(serialised.includes('secret step'), false, 'the card must not carry L2');
  assert.equal(serialised.includes('L3'), false, 'the card must not carry L3');
  assert.ok(card.requiredCapabilities.length > 0, 'but it does carry the capability map');
});

/* -------------------------------------------- 7/8. capability reference + unknown */

test('a declared capability validates, and the map says it was not granted', () => {
  const skills = fresh();
  const id = skills.register(declaration());
  const verdict = skills.validateSelection(id);
  assert.equal(verdict.selectable, true);
  assert.deepEqual(verdict.missingCapabilities, []);
  assert.equal(verdict.grantsAuthority, false);

  const card = skills.describe(id);
  assert.equal(card.capabilityMap.length, 1);
  assert.equal(card.capabilityMap[0].capability, REAL_CAPABILITY);
  assert.equal(card.capabilityMap[0].declared, true);
  assert.equal(card.capabilityMap[0].granted, false,
    'a capability map entry must never report itself as granted');
});

test('an unknown capability fails closed — registered, listable, never selectable', () => {
  const skills = fresh();
  const id = skills.register(declaration({ requiredCapabilities: ['does.not.exist'] }));

  // Registration succeeds: the skill genuinely exists, its requirement is unmet.
  assert.equal(skills.size, 1);
  assert.equal(skills.list().length, 1);

  assert.equal(skills.availabilityOf(id), 'capability-unavailable');
  const verdict = skills.validateSelection(id);
  assert.equal(verdict.selectable, false, 'an unknown capability must never be assumed available');
  assert.ok(verdict.reasons.includes('capability-unavailable'));
  assert.deepEqual(verdict.missingCapabilities, ['does.not.exist']);
  assert.equal(verdict.code, 'lego.capability_unavailable');
});

test('the capability authority is the registry, not the skill', () => {
  // The skill registry must read the real capability list. If it kept its own
  // copy, this test would pass against the copy and the two would drift.
  const declared = new Set();
  for (const domain of registry.domains) {
    for (const capability of domain.capabilities ?? []) declared.add(capability.id);
  }
  assert.ok(declared.has(REAL_CAPABILITY), 'the fixture capability must really exist');

  const skills = fresh();
  skills.register(declaration({ requiredCapabilities: [REAL_CAPABILITY, 'invented.capability'] }));
  const verdict = skills.validateSelection('demo.summarise');
  assert.deepEqual(verdict.missingCapabilities, ['invented.capability'],
    'the declared one resolves, the invented one does not');
});

/* ------------------------------------------------------- 9. trust degradation */

test('low trust degrades a destructive skill to requires-approval, never to silently selectable', () => {
  for (const trust of ['community', 'untrusted']) {
    const skills = fresh();
    const id = skills.register(declaration({ trust, requiredCapabilities: [REAL_DESTRUCTIVE] }));
    const verdict = skills.validateSelection(id);
    assert.equal(verdict.requiresApproval, true, `${trust} + destructive must require approval`);
    assert.equal(verdict.selectable, false, `${trust} must not be selectable without approval`);
    assert.ok(verdict.reasons.includes('approval-required'));

    const approved = skills.validateSelection(id, { approved: true });
    assert.equal(approved.selectable, true, 'with approval it becomes selectable');
    assert.equal(approved.grantsAuthority, false, 'and still grants nothing');
  }
});

test('core trust does not need approval, and trust never raises what a skill may require', () => {
  const skills = fresh();
  const id = skills.register(declaration({ trust: 'core', requiredCapabilities: [REAL_DESTRUCTIVE] }));
  assert.equal(skills.validateSelection(id).requiresApproval, false);

  // Trust is not a capability grant: a core skill's map is still ungranted.
  assert.equal(skills.describe(id).capabilityMap.every((row) => row.granted === false), true);
});

test('an unknown capability is treated as destructive, not as harmless', () => {
  // The safe default for an unknown effect is the most restrictive one.
  const skills = fresh();
  const id = skills.register(declaration({ trust: 'untrusted', requiredCapabilities: ['unknown.thing'] }));
  const verdict = skills.validateSelection(id);
  assert.equal(verdict.requiresApproval, true,
    'an undeclared capability must not be assumed non-destructive');
});

/* ------------------------------------------------ 10. replacement metadata */

test('replacement metadata separates identity from what may be rewritten', () => {
  const { replacement } = SKILL_CONTRACT;
  assert.equal(replacement.policy, 'contract-preserving');
  assert.ok(replacement.identityFields.includes('id'));
  assert.ok(replacement.identityFields.includes('contractVersion'));
  assert.ok(replacement.identityFields.includes('requiredCapabilities'));
  assert.ok(replacement.freeFields.includes('procedure'));
  assert.ok(replacement.freeFields.includes('implementationVersion'));
  for (const field of replacement.identityFields) {
    assert.equal(replacement.freeFields.includes(field), false,
      `'${field}' cannot be both identity and free`);
  }
  assert.equal(SKILL_CONTRACT.replacement.rule.length > 60, true);
  assert.ok(SKILL_CONTRACT.degradation.rule.includes('never silently repaired'));
});

test('a replaced implementation does not change what a consumer sees', () => {
  // The point of contract-preserving replacement: same id, same required
  // capabilities, entirely different body — and the card a consumer reads for
  // selection is unchanged apart from the implementation version.
  const before = fresh();
  before.register(declaration(), { load: () => ({ procedure: ['old'] }) });
  const after = fresh();
  after.register(declaration({ implementationVersion: '2.0.0', description: 'Explain what a workflow does, in order, without running it.' }),
    { load: () => ({ procedure: ['completely', 'different'] }) });

  const strip = (card) => ({ ...card, implementationVersion: null });
  assert.deepEqual(strip(after.describe('demo.summarise')), strip(before.describe('demo.summarise')));
});

/* ------------------------------------------------------- 11. contract stability */

test('the contract publishes the four discovery operations and no execute operation', () => {
  assert.deepEqual([...SKILL_OPERATIONS].sort(),
    ['skill.describe', 'skill.list', 'skill.resolve', 'skill.validate-selection']);
  for (const operation of SKILL_CONTRACT.operations) {
    assert.equal(operation.interaction, 'call');
    assert.equal(operation.idempotent, true, `${operation.name} must be idempotent — discovery has no side effects`);
    assert.ok(['ai:skill:read', 'ai:skill:select'].includes(operation.permission));
  }
  const serialised = JSON.stringify(SKILL_CONTRACT).toLowerCase();
  assert.equal(/"[a-z.]*execute"/.test(serialised), false, 'no operation may be named execute');
  assert.equal(SKILL_CONTRACT.permissions.includes('ai:skill:execute'), false,
    'there must be no execute permission — execution is not a skill operation');
});

test('the contract, and every value it returns, is frozen', () => {
  assert.throws(() => { SKILL_CONTRACT.version = '9.9.9'; }, TypeError);
  const skills = fresh();
  const id = skills.register(declaration());
  assert.throws(() => { skills.describe(id).requiredCapabilities.push('sneaky'); }, TypeError);
  assert.throws(() => { skills.list().push({}); }, TypeError);
  assert.throws(() => { skills.validateSelection(id).reasons.push('nope'); }, TypeError);
});

test('the registry in the manifest matches the module', () => {
  const manifest = JSON.parse(readFileSync(
    resolve(HERE, '..', 'src', 'lego', 'manifest', 'skill.json'), 'utf8'));
  assert.equal(manifest.version, SKILL_CONTRACT_VERSION);
  assert.deepEqual(manifest.lifecycle.states, [...SKILL_LIFECYCLE]);

  // And the capability declared in domains.json agrees with the contract.
  const domains = JSON.parse(readFileSync(
    resolve(HERE, '..', 'src', 'lego', 'manifest', 'domains.json'), 'utf8'));
  const capability = domains.domains
    .flatMap((domain) => domain.capabilities ?? [])
    .find((entry) => entry.id === 'ai.skill');
  assert.ok(capability, 'ai.skill must be declared as a capability');
  assert.deepEqual(capability.operations.map((operation) => operation.name).sort(),
    [...SKILL_OPERATIONS].sort(), 'the declared operations must match the contract');
  assert.deepEqual(capability.permissions, ['ai:skill:read', 'ai:skill:select']);
});

/* --------------------------------------------- 12/13. authority and execution */

test('a skill cannot declare granted authority — the attempt is refused, not ignored', () => {
  const skills = fresh();
  for (const field of ['grants', 'grantedCapabilities', 'permissions', 'credentials', 'authority']) {
    assert.throws(() => skills.register(declaration({ [field]: ['anything'] })), (error) => {
      assert.equal(error.code, 'lego.access_denied');
      assert.match(error.message, /never grants them/);
      return true;
    }, `a skill declaring '${field}' must be refused`);
  }
});

test('no authority is inherited from, or granted to, an Agent Machine', () => {
  // The registry has no concept of an agent at all, which is the strongest
  // form this guarantee can take: there is no seam to inherit through.
  const source = readFileSync(resolve(HERE, '..', 'src', 'lego', 'skill.mjs'), 'utf8');
  const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const forbidden of ['agentMachine', 'agent_machine', 'AgentMachine', 'delegate', 'impersonate']) {
    assert.equal(code.includes(forbidden), false,
      `skill.mjs must not reference '${forbidden}' — a skill is not bound to an agent`);
  }
  // Nothing the registry returns can be used as authority.
  const skills = fresh();
  const id = skills.register(declaration());
  const card = skills.describe(id);
  for (const key of ['token', 'credential', 'secret', 'grant', 'handle', 'permission']) {
    assert.equal(Object.keys(card).some((field) => field.toLowerCase().includes(key)), false,
      `the card must not expose a '${key}' field`);
  }
});

test('the registry executes nothing: no tool, filesystem, process, network or model', () => {
  const source = readFileSync(resolve(HERE, '..', 'src', 'lego', 'skill.mjs'), 'utf8');
  const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const forbidden of [
    'child_process', 'node:http', 'node:https', 'node:net', 'fetch(', 'exec(', 'spawn(',
    'writeFileSync', 'rmSync', 'unlinkSync', 'mkdirSync', 'process.env',
  ]) {
    assert.equal(code.includes(forbidden), false, `skill.mjs must not contain '${forbidden}'`);
  }
  // It reads exactly one file: its own contract, at import time. Two mentions
  // of readFileSync are expected -- the import binding and the single call.
  const callSites = code.match(/readFileSync\(/g) ?? [];
  assert.equal(callSites.length, 1, 'skill.mjs must read exactly one file');
  assert.match(code, /readFileSync\(resolve\(HERE, 'manifest', 'skill\.json'\)/);
});

test('a custom validator cannot take the registry down, and a throwing one never passes', () => {
  const skills = fresh();
  const id = skills.register(declaration({
    validators: [{ kind: 'custom', summary: 'explodes', check: () => { throw new Error('boom'); } }],
  }));
  const verdict = skills.validateSelection(id);
  assert.equal(verdict.selectable, false, 'a throwing validator must fail closed');
  assert.ok(verdict.reasons.some((reason) => reason.startsWith('validator-failed')));
});

test('a custom validator that returns a truthy non-true value does not pass', () => {
  // `=== true` rather than truthiness: a validator returning an object or a
  // non-empty string is a bug, and treating it as a pass is how a fail-open
  // default gets written by accident.
  const skills = fresh();
  const id = skills.register(declaration({
    validators: [{ kind: 'custom', summary: 'sloppy', check: () => 'yes' }],
  }));
  assert.equal(skills.validateSelection(id).selectable, false);
});

/* ------------------------------------------------- 14. no duplicate top-level */

test('Skill added no second top-level AI domain', () => {
  const domains = JSON.parse(readFileSync(
    resolve(HERE, '..', 'src', 'lego', 'manifest', 'domains.json'), 'utf8'));
  const ids = domains.domains.map((domain) => domain.id);
  assert.equal(ids.length, 26, 'the domain count must not have moved');
  for (const forbidden of ['ai-skill', 'skill', 'skills', 'ai.skill']) {
    assert.equal(ids.includes(forbidden), false, `'${forbidden}' must not be a top-level domain`);
  }
  // It lives as a capability of the existing AI Foundation domain.
  const owner = domains.domains.find((domain) => (domain.capabilities ?? [])
    .some((capability) => capability.id === 'ai.skill'));
  assert.equal(owner.id, 'ai-foundation');

  // And the official set still has exactly fifteen entries with skill among them.
  const set = JSON.parse(readFileSync(
    resolve(HERE, '..', 'src', 'lego', 'manifest', 'ai-lego-set.json'), 'utf8'));
  assert.equal(set.lego.length, 15);
  const skill = set.lego.find((lego) => lego.id === 'skill');
  assert.ok(skill, 'the official Skill LEGO declaration is the one used');
  assert.deepEqual(skill.lifecycle, [...SKILL_LIFECYCLE],
    'the implementation must use the lifecycle the official set declares');
});

test('the open decisions this touches are recorded, not silently settled', () => {
  // XA-11 asks whether a skill is a backend concept at all. Implementing the
  // registry does not answer that, and the contract must not pretend it did.
  assert.ok(SKILL_CONTRACT.openDecisions['XA-11'],
    'XA-11 must stay visible on the contract that would be affected by it');
  const register = JSON.parse(readFileSync(
    resolve(HERE, '..', '..', '..', 'docs', 'n8n-lego', 'decisions', 'cross-agent-decisions.json'), 'utf8'));
  const xa11 = register.decisions.find((row) => row.id === 'XA-11');
  assert.equal(xa11.status, 'open-for-manager',
    'P2.12 must not have resolved XA-11 unilaterally');
});

/* ------------------------------------- P2.12 finalize: the published lock (XA-19) */

const LOCK = JSON.parse(readFileSync(
  resolve(HERE, '..', 'src', 'lego', 'contracts', 'contract-lock.json'), 'utf8'));
const LOCKED_SKILL = LOCK.contracts.find((entry) => entry.id === 'ai.skill');
const CANONICAL_OPERATIONS = ['skill.describe', 'skill.list', 'skill.resolve', 'skill.validate-selection'];
/** Deliberately NOT published: internal registry lifecycle methods. */
const INTERNAL_ONLY = ['skill.register', 'skill.select', 'skill.load', 'skill.release'];

test('the contract lock publishes ai.skill@1.0.0 against the existing ai-foundation domain', () => {
  assert.ok(LOCKED_SKILL, 'ai.skill must be in the contract lock');
  assert.equal(LOCKED_SKILL.version, '1.0.0');
  assert.equal(LOCKED_SKILL.owner, 'manager');
  assert.equal(LOCKED_SKILL.domain, 'ai-foundation', 'no new top-level domain');
  assert.equal(LOCKED_SKILL.status, 'implemented');
  assert.equal(LOCKED_SKILL.version, SKILL_CONTRACT_VERSION, 'the lock and the module must agree');
});

test('the lock publishes exactly the four canonical operations, and none of the internal ones', () => {
  assert.deepEqual([...LOCKED_SKILL.operations].sort(), CANONICAL_OPERATIONS);
  assert.deepEqual([...SKILL_OPERATIONS].sort(), CANONICAL_OPERATIONS,
    'the module must publish the same four');
  assert.deepEqual([...LOCKED_SKILL.operations].sort(),
    [...SKILL_CONTRACT.operations.map((operation) => operation.name)].sort(),
    'the lock and the contract manifest must agree operation for operation');

  for (const internal of INTERNAL_ONLY) {
    assert.equal(LOCKED_SKILL.operations.includes(internal), false,
      `${internal} is an internal lifecycle method and must not be published`);
    assert.equal(SKILL_OPERATIONS.includes(internal), false,
      `${internal} must not appear in the published operation set`);
  }
});

test('no execute operation and no execute permission exists at any layer', () => {
  // Checked in the lock, the contract manifest, the module surface and the
  // capability declaration -- one place agreeing is not the guarantee.
  assert.deepEqual([...LOCKED_SKILL.permissions].sort(), ['ai:skill:read', 'ai:skill:select']);
  // Assert on the DECLARED surface, not on prose. Several fields legitimately
  // explain in words that execution is absent ("there is deliberately no
  // `ai:skill:execute`"); a substring scan would read those denials as the
  // thing they deny. So enumerate the real name-bearing fields instead.
  const declaredNames = [
    ...LOCKED_SKILL.operations,
    ...LOCKED_SKILL.permissions,
    ...SKILL_CONTRACT.operations.map((operation) => operation.name),
    ...SKILL_CONTRACT.operations.map((operation) => operation.permission),
    ...SKILL_CONTRACT.permissions.map((entry) => (typeof entry === 'string' ? entry : entry.id)),
  ];
  for (const name of declaredNames) {
    assert.equal(/execute/.test(String(name)), false,
      `no declared operation or permission may mention execution, found '${name}'`);
  }
  // ...and the denials themselves must still be on the record.
  assert.match(SKILL_CONTRACT.permissionNote, /no `?ai:skill:execute`?/i);
  assert.ok(/no .{0,40}execute/i.test(LOCKED_SKILL.notes),
    'the lock notes must still record, in words, that execution is deliberately absent');
  const domains = JSON.parse(readFileSync(
    resolve(HERE, '..', 'src', 'lego', 'manifest', 'domains.json'), 'utf8'));
  const capability = domains.domains.flatMap((domain) => domain.capabilities ?? [])
    .find((entry) => entry.id === 'ai.skill');
  assert.deepEqual([...capability.permissions].sort(), ['ai:skill:read', 'ai:skill:select']);
  assert.deepEqual([...capability.operations.map((operation) => operation.name)].sort(), CANONICAL_OPERATIONS);
  for (const operation of capability.operations) {
    assert.ok(['ai:skill:read', 'ai:skill:select'].includes(operation.permission));
  }
});

test('the locked surface and exports are real', () => {
  for (const file of LOCKED_SKILL.surface) {
    assert.ok(existsSync(resolve(HERE, '..', file)), `missing locked surface file '${file}'`);
  }
  const source = readFileSync(resolve(HERE, '..', 'src', 'lego', 'skill.mjs'), 'utf8');
  for (const name of LOCKED_SKILL.exports['src/lego/skill.mjs']) {
    assert.match(source, new RegExp(`export (const|function|class) ${name}\\b`),
      `the lock claims export '${name}', which skill.mjs does not export`);
  }
});

test('XA-19 may only read resolved while the lock and the declaration actually agree', () => {
  // The register must not be able to claim a settled vocabulary that the code
  // contradicts. If the lock, the contract manifest and the module ever
  // disagree, this fails rather than leaving a resolved row that lies.
  const register = JSON.parse(readFileSync(
    resolve(HERE, '..', '..', '..', 'docs', 'n8n-lego', 'decisions', 'cross-agent-decisions.json'), 'utf8'));
  const xa19 = register.decisions.find((row) => row.id === 'XA-19');
  assert.ok(xa19, 'XA-19 must be recorded');
  if (xa19.status !== 'resolved') return;

  assert.ok(LOCKED_SKILL, 'XA-19 is resolved but ai.skill is not in the contract lock');
  assert.equal(xa19.canonical.contract, `ai.skill@${LOCKED_SKILL.version}`);
  assert.equal(xa19.canonical.domain, LOCKED_SKILL.domain);
  assert.equal(xa19.canonical.owner, LOCKED_SKILL.owner);
  assert.deepEqual([...xa19.canonical.operations].sort(), [...LOCKED_SKILL.operations].sort());
  assert.deepEqual([...xa19.canonical.operations].sort(), [...SKILL_OPERATIONS].sort());
  assert.deepEqual([...xa19.canonical.permissions].sort(), [...LOCKED_SKILL.permissions].sort());
  assert.deepEqual([...xa19.canonical.notPublished].sort(), [...INTERNAL_ONLY].sort());
  assert.ok(xa19.historicalFinding, 'the original drift evidence must be kept');
  assert.ok(xa19.historicalEvidence.length > 0, 'agent-1 drift evidence must be kept as historical');
  assert.ok(xa19.currentRepositoryState, 'a resolved row must name the state it was verified against');
});

test('XA-11 stays open: publishing the contract did not decide where Skill belongs', () => {
  const register = JSON.parse(readFileSync(
    resolve(HERE, '..', '..', '..', 'docs', 'n8n-lego', 'decisions', 'cross-agent-decisions.json'), 'utf8'));
  const xa11 = register.decisions.find((row) => row.id === 'XA-11');
  assert.equal(xa11.status, 'open-for-manager',
    'XA-11 is a separate architecture decision and must not be closed by locking the contract');
  const xa19 = register.decisions.find((row) => row.id === 'XA-19');
  assert.match(xa19.relatedOpenDecision, /XA-11 remains open-for-manager/,
    'the resolved row must say plainly that it did not settle XA-11');
});

test('no canonical backend document still calls Skill publicationPending', () => {
  // A resolved contract with documents still saying "pending" is the drift
  // XA-19 exists to end. Curated documents may keep the old claim only when
  // they carry an explicit historical label.
  const masterDir = resolve(HERE, '..', '..', '..', '.ai', 'master');
  const offenders = [];
  for (const name of readdirSync(masterDir)) {
    if (!name.endsWith('.md')) continue;
    const body = readFileSync(join(masterDir, name), 'utf8');
    const claimsPending = /skill[^.\n]{0,80}publicationPending|publicationPending[^.\n]{0,80}skill|XA-11 pending|Skill: XA-11/i.test(body);
    if (!claimsPending) continue;
    if (body.includes('SUPERSEDED IN PART')) continue;
    offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});
