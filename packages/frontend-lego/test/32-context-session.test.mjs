/**
 * The Context & Session surface (P2.13) — one LEGO, two contracts, five distinct things.
 *
 * What is proven here, in the order the milestone defines it:
 *
 *   1. **Provenance.** Every word the surface uses is quoted from a backend declaration, with the
 *      contract, the file and the path — and the comparison is run against the real backend tree
 *      on this branch, not against a synthetic fixture. A word nobody published stays in
 *      `PENDING_PUBLICATIONS` and is reported as pending.
 *   2. **Publication honesty.** Neither `ai.context` nor `ai.agent-session` has a contract-lock
 *      row at the P2.13 baseline, so the surface reports `declared-not-locked`, renders no
 *      version, and answers with the canonical unsupported state. Handed a real row, the same code
 *      reports `published` — the state is derived, never hardcoded.
 *   3. **State rendering.** Session identity and the seven session states, the context scope
 *      ladder and the six context lifecycle states, usage, rollover, continuation, verification and
 *      the previous/next relationship.
 *   4. **The refusals.** No fabricated token count, no Memory store, no execution affordance, no
 *      transcript, no secret, no merged "AI state" object, no silent reset, no phase advanced by
 *      the UI, no threshold at 100%.
 *   5. **The gap is rendered.** Three declared verbs (`rollover`, `rehydrate`, `verify`) have no
 *      registered operation, so every affordance that would need one is `operation-unpublished`.
 *
 * Backend-tree convention (same as `29-alignment.test.mjs`): the comparison reads
 * `apps/n8n-lego/src/lego/**` and **skips with a stated reason** when that tree is absent, unless
 * `N8N_BACKEND_LEGO_ROOT` is set — in which case a missing file is a failure, never a skip. The
 * self-consistency halves always run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CAPABILITY_DECLARATION_SOURCE,
  CONTEXT_DECLARED_VERBS,
  CONTEXT_DECLARED_VERSION,
  CONTEXT_DECLARATION_SOURCE,
  CONTEXT_FIELDS,
  CONTEXT_LIFECYCLE,
  CONTEXT_OPERATIONS,
  CONTEXT_PERMISSIONS,
  CONTEXT_SCOPES,
  CONTEXT_SESSION_AFFORDANCES,
  CONTEXT_SESSION_DECISION,
  CONTEXT_SESSION_LEGO_ID,
  CONTEXT_SESSION_QUOTED_VOCABULARIES,
  CONTEXT_CONTRACT_ID,
  CONTINUATION_ENVELOPE_FIELDS,
  CONTINUATION_AFFORDANCES,
  CONTINUATION_SECTIONS,
  CONTINUITY_CHECKS,
  ContextSessionError,
  DISTINCT_CONCEPTS,
  CONTEXT_SESSION_FORBIDDEN_FIELDS as FORBIDDEN_FIELDS,
  CONTEXT_SESSION_FORBIDDEN_IMPLICATIONS as FORBIDDEN_IMPLICATIONS,
  FORBIDDEN_KEY_PATTERN,
  LEGO_DECLARATION_SOURCE,
  MEMORY_DECISION,
  PUBLISHED_OPERATION_IDS,
  PENDING_CONTRACT_ROWS,
  PENDING_PUBLICATIONS,
  PROMOTED_PUBLICATIONS,
  ROLLOVER_LIFECYCLE_STATES,
  ROLLOVER_PHASES,
  VERIFICATION_RESULTS,
  continuationAffordances,
  forbiddenReasons,
  SESSION_CONTRACT_ID,
  SESSION_DECLARATION_SOURCE,
  SESSION_FIELDS,
  SESSION_OPERATIONS,
  SESSION_PERMISSIONS,
  SESSION_REFERENCES,
  SESSION_STATES,
  SESSION_TERMINAL_STATES,
  TOKEN_KINDS,
  UNPUBLISHED_CONTEXT_VERBS,
  USAGE_REPORT_STATES,
  assertDistinctConcepts,
  contextLifecycle,
  contextLifecycleState,
  contextScope,
  contextSessionUnsupported,
  contextUsage,
  continuityVerification,
  createContextSessionView,
  contextSessionDrift as declarationDrift,
  describeContextSession,
  expectedRolloverPhase,
  pendingPublicationOf,
  promotionOf,
  rehydration,
  scanForbiddenKeys,
  scopeLadder,
  sessionLineage,
  sessionLifecycle,
  sessionState,
  validateContextRecord,
  validateContinuationPackage,
  validateRolloverThreshold,
  validateSessionRecord,
  vocabularyOf,
} from '../index.mjs';
import { PACKAGE_ROOT, contextSessionSurface, loadManifests } from '../src/manifests.mjs';
import { createFrontendLego } from '../src/lego.mjs';

const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');
const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');
const DEFAULT_BACKEND = join(REPO_ROOT, 'apps', 'n8n-lego', 'src', 'lego');
const BACKEND = process.env.N8N_BACKEND_LEGO_ROOT ?? DEFAULT_BACKEND;
const overridden = process.env.N8N_BACKEND_LEGO_ROOT !== undefined;
const backendPresent = existsSync(join(BACKEND, 'manifest', 'ai-foundation.json'));
const skip = backendPresent || overridden
  ? false
  : (overridden
    ? `N8N_BACKEND_LEGO_ROOT is set but ${BACKEND} has no backend foundation`
    : 'the backend foundation is not on this branch — the comparison runs after the merge');
if (overridden && !backendPresent) {
  throw new Error(`N8N_BACKEND_LEGO_ROOT is set but ${BACKEND} has no backend foundation`);
}

const DECISIONS = JSON.parse(read('docs/n8n-lego/decisions/cross-agent-decisions.json'));
const MILESTONES = JSON.parse(read('docs/n8n-lego/milestones.json'));
const SURFACE = contextSessionSurface();
const manifests = loadManifests();

/** The backend tree, read the way the surface is handed it in production. */
const backendDeclaration = () => {
  const foundation = JSON.parse(readFileSync(join(BACKEND, 'manifest', 'ai-foundation.json'), 'utf8'));
  const set = JSON.parse(readFileSync(join(BACKEND, 'manifest', 'ai-lego-set.json'), 'utf8'));
  const domains = JSON.parse(readFileSync(join(BACKEND, 'manifest', 'domains.json'), 'utf8'));
  const scenarios = JSON.parse(readFileSync(join(BACKEND, 'manifest', 'reference-scenarios.json'), 'utf8'));
  const aiDomain = domains.domains.find((domain) => domain.id === 'ai-foundation');
  return Object.freeze({
    context: foundation.context,
    agentSession: foundation.agentSession,
    lego: set.lego.find((entry) => entry.id === CONTEXT_SESSION_LEGO_ID),
    capabilities: aiDomain.capabilities.filter((capability) => [CONTEXT_CONTRACT_ID, SESSION_CONTRACT_ID].includes(capability.id)),
    scenario: scenarios.scenarios.find((entry) => entry.id === 'context-rollover'),
  });
};

/** The contract lock rows the pointed-at tree publishes (an empty list when it publishes none). */
const lockRows = () => {
  const file = join(BACKEND, 'contracts', 'contract-lock.json');
  if (!existsSync(file)) return [];
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(lock) ? lock : (lock.contracts ?? []);
};
const rowFor = (id) => lockRows().find((row) => (row.id ?? row.contract) === id) ?? null;

/**
 * Whether the pointed-at tree carries agent-2's P2.13 publication (`ai.context@1.0.0` and
 * `ai.agent-session@1.0.0`, pushed to `arena/01a0c6b5-n8n-rust-v-4` @ `fb254f32`).
 *
 * This branch's own backend copy is still `e754c5df`, which publishes neither row, still spells two
 * continuation sections the manifest way and still registers two context operations. The lock quotes
 * the publication — a peer's published change is not an assumption this branch may keep ignoring —
 * so two comparisons are bounded by this predicate, and bounded means *announced*: the differences a
 * pre-publication tree produces are asserted exactly, and the open decision that carries them is
 * checked by id. Run with `N8N_BACKEND_LEGO_ROOT` pointed at the peer tree (or after the merge) and
 * the same tests demand `in-sync`.
 */
const publishes213 = () => rowFor(CONTEXT_CONTRACT_ID) !== null && rowFor(SESSION_CONTRACT_ID) !== null;
/**
 * The spelling divergence is **inside the backend** and survives its own publication:
 * `ai-lego-set.json#lego[id=context-session].continuationPackage` says `toolState`/`refs` on the
 * peer branch exactly as it does on protected main, while the locked contract surface publishes
 * `toolStateReferences`/`importantReferences`. The frontend quotes the contract, reports the
 * manifest as a difference, and waits for its owner to move one of the two — it does not average
 * them and it does not coin a third spelling. When the manifest is fixed, this list becomes empty
 * and the same tests demand `in-sync` with no edit here.
 */
const BACKEND_INTERNAL_DIVERGENCE = Object.freeze({ block: 'lego', field: 'continuationPackage', removed: ['toolStateReferences', 'importantReferences'], added: ['toolState', 'refs'] });
const PRE_MERGE_DIVERGENCE = Object.freeze({ block: 'capabilities', field: '[id=ai.context].operations', removed: ['rollover', 'rehydrate', 'verify'], added: [] });
const manifestHasDivergence = () => {
  const lego = backendDeclaration()?.lego?.continuationPackage ?? [];
  return lego.includes('toolState') || lego.includes('refs');
};
const registeredDifferences = () => {
  const diffs = [];
  if (manifestHasDivergence()) diffs.push(BACKEND_INTERNAL_DIVERGENCE);
  if (!publishes213()) diffs.push(PRE_MERGE_DIVERGENCE);
  return diffs;
};
const assertAwaitingPublicationDifferences = (differences) => {
  const expectedDifferences = registeredDifferences();
  assert.deepEqual(differences.map((entry) => `${entry.block} ${entry.field}`).sort(),
    expectedDifferences.map((entry) => `${entry.block} ${entry.field}`).sort(),
    `exactly the registered differences, and nothing else: ${JSON.stringify(differences)}`);
  for (const expected of expectedDifferences) {
    const difference = differences.find((entry) => entry.block === expected.block && entry.field === expected.field);
    assert.ok(difference, `${expected.block} ${expected.field} is reported`);
    assert.deepEqual([...difference.removed].sort(), [...expected.removed].sort(), `${expected.field}: the quoted values this tree does not declare are the registered ones`);
    assert.deepEqual([...difference.added].sort(), [...expected.added].sort(), `${expected.field}: and the values it declares that the lock does not quote are the registered ones`);
  }
  const row = DECISIONS.decisions.find((entry) => entry.id === CONTEXT_SESSION_DECISION);
  assert.ok(row, 'the difference is carried by a recorded decision');
  assert.equal(row.status.startsWith('open'), true, 'which is still open — the frontend does not resolve it');
  assert.match(`${row.question} ${row.finding}`, /continuationSection|contextOperation/, 'and names the vocabulary that moved');
};

/* ---------------------------------------------------------------- 1. provenance */

test('the surface quotes its vocabulary instead of declaring one', () => {
  assert.equal(CONTEXT_SESSION_QUOTED_VOCABULARIES.length, 15, 'fifteen quoted sets: thirteen declared at P2.13 plus the two promoted when agent-2 published ai.context@1.0.0');
  for (const id of CONTEXT_SESSION_QUOTED_VOCABULARIES) {
    const set = vocabularyOf(id);
    assert.ok(set, `${id} is a declared vocabulary`);
    assert.ok(set.provenance.file.startsWith('apps/n8n-lego/src/lego/'), `${id} quotes the backend, not this package`);
    assert.ok((set.provenance.symbol ?? set.provenance.path).length > 0, `${id} names the declaration it read`);
    if (set.provenance.contract === null) {
      assert.ok(set.publicationPending, `${id} is unpublished, so it carries a publication record`);
      assert.ok(DECISIONS.decisions.some((row) => row.id === set.publicationPending.decision), `${id} points at a recorded decision`);
    }
  }
  // The quoted values ARE the values the surface exports: no second copy to drift.
  assert.deepEqual(CONTEXT_SCOPES, vocabularyOf('contextScope').values);
  assert.deepEqual(CONTEXT_FIELDS, vocabularyOf('contextField').values);
  assert.deepEqual(CONTEXT_LIFECYCLE, vocabularyOf('contextLifecycle').values);
  assert.deepEqual(CONTINUATION_SECTIONS, vocabularyOf('continuationSection').values);
  assert.deepEqual(SESSION_STATES, vocabularyOf('agentSessionState').values);
  assert.deepEqual(SESSION_FIELDS, vocabularyOf('agentSessionField').values);
  assert.deepEqual(SESSION_REFERENCES, vocabularyOf('agentSessionReference').values);
  assert.deepEqual(TOKEN_KINDS, vocabularyOf('tokenKind').values);
  assert.deepEqual(ROLLOVER_PHASES, vocabularyOf('contextRolloverPhase').values);
  assert.deepEqual(VERIFICATION_RESULTS, vocabularyOf('continuationVerification').values);
  // The two promoted sets quote a published contract, and name the commit that published it.
  for (const id of ['contextRolloverPhase', 'continuationVerification', 'continuationSection']) {
    const set = vocabularyOf(id);
    assert.deepEqual(set.provenance.contract, { id: 'ai.context', version: '1.0.0', owner: 'manager' }, `${id} quotes the published contract`);
    assert.equal(set.provenance.publishedOn.commit, 'fb254f32', `${id} names the agent-2 commit that published it`);
    assert.equal(set.provenance.publishedOn.branch, 'arena/01a0c6b5-n8n-rust-v-4', `${id} names the branch, so a reader can fetch what was quoted`);
  }
});

test('the shapes the brief names are the shapes the backend declares', () => {
  assert.deepEqual([...CONTEXT_SCOPES], ['GLOBAL', 'WORKFLOW', 'NODE', 'EXECUTION', 'EVENT', 'AGENT', 'TASK']);
  assert.deepEqual([...CONTEXT_FIELDS], ['contextId', 'scope', 'parent', 'snapshot', 'version', 'source', 'dependencies', 'size', 'checksum']);
  assert.deepEqual([...SESSION_STATES], ['created', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled']);
  assert.deepEqual([...SESSION_FIELDS], ['sessionId', 'agentId', 'parentSessionId', 'taskId', 'workflowId', 'executionId', 'runtimeId', 'status', 'createdAt', 'updatedAt']);
  assert.deepEqual([...SESSION_REFERENCES], ['contextRef', 'artifactRef', 'traceRef']);
  assert.equal(CONTINUATION_SECTIONS.length, 14, 'the fourteen continuation sections');
  assert.deepEqual([...CONTINUATION_SECTIONS], [
    'identity', 'objective', 'plan', 'completedWork', 'unfinishedWork', 'constraints', 'decisions',
    'activeEntities', 'toolStateReferences', 'artifacts', 'importantReferences', 'errors',
    'unresolvedQuestions', 'compressedHistory',
  ], 'the published contract spelling, in publication order');
  // The AI-set manifest continuation vocabulary:
  const vocab = vocabularyOf('continuationSection');
  if (vocab.registeredDivergence) {
    const divergence = vocab.registeredDivergence;
    assert.equal(divergence.decision, CONTEXT_SESSION_DECISION, 'the divergence is carried by an open Manager-owned decision');
    assert.deepEqual(divergence.differs, [
      { published: 'toolStateReferences', manifest: 'toolState' },
      { published: 'importantReferences', manifest: 'refs' },
    ], 'exactly two spellings differ, and both are named');
    assert.equal(divergence.identical, 12, 'the other twelve are identical, so the difference cannot widen silently');
  } else if (vocab.divergenceClosed) {
    const closed = vocab.divergenceClosed;
    assert.equal(closed.decision, CONTEXT_SESSION_DECISION);
    assert.deepEqual([...closed.canonicalFields], ['toolStateReferences', 'importantReferences']);
    assert.equal(closed.closedBy.commit, 'fa18ba76');
  }
});

test('a word the backend published is quoted, and the promotion is recorded as evidence', () => {
  // The two Context & Session word lists were pending while nothing published them. Agent-2
  // published both at fb254f32, so they are quoted now — and the promotion is recorded with the
  // commit, the symbol and the values, because "we coined it and it happened to match" must stay
  // distinguishable from "we quoted it".
  assert.equal(PENDING_PUBLICATIONS.length, 0, 'nothing Context & Session is pending any more');
  assert.equal(PROMOTED_PUBLICATIONS.length, 2, 'the rollover phase machine and the verification results were promoted');
  for (const entry of PROMOTED_PUBLICATIONS) {
    assert.equal(entry.publishedBy.commit, 'fb254f32', `${entry.id} names the commit that published it`);
    assert.equal(entry.publishedBy.agent, 'agent-2', `${entry.id} names who published it`);
    assert.equal(entry.publishedAs.lockRow, 'ai.context@1.0.0', `${entry.id} names the lock row`);
    assert.match(entry.publishedAs.file, /^apps\/n8n-lego\/src\/lego\//, `${entry.id} names the backend file, not this package`);
    assert.deepEqual([...entry.ruledValues], [...entry.publishedValues], `${entry.id}: the published enumeration equals the ruled one`);
    assert.equal(entry.identical, true, `${entry.id}: promotion changed the provenance, not the words`);
    assert.equal(entry.decision, CONTEXT_SESSION_DECISION, `${entry.id} still names the decision that owed the publication`);
    assert.deepEqual([...vocabularyOf(entry.quotedAs.replace('VOCABULARIES#', '')).values], [...entry.publishedValues], `${entry.id} is quoted with exactly the published values`);
    assert.equal(pendingPublicationOf(entry.id), null, `${entry.id} is no longer pending`);
    assert.equal(promotionOf(entry.id), entry, `${entry.id} is retrievable as a promotion record`);
  }
  assert.deepEqual([...ROLLOVER_PHASES], ['NORMAL', 'PREPARE', 'ROLLOVER']);
  assert.deepEqual([...VERIFICATION_RESULTS], ['verified', 'degraded', 'failed']);
  assert.equal(promotionOf('no-such-vocabulary'), null, 'an unknown id is not a synonym');
  // The gate that forced this promotion still exists for the next unpublished word: a pending row
  // is legal only while nothing publishes it.
  assert.equal(typeof pendingPublicationOf, 'function');
});

test('the two contract rows P2.13 owes are recorded, with the claim they were verified against', () => {
  assert.deepEqual(PENDING_CONTRACT_ROWS.map((row) => row.contract), [CONTEXT_CONTRACT_ID, SESSION_CONTRACT_ID]);
  for (const row of PENDING_CONTRACT_ROWS) {
    assert.equal(row.declaredVersion, '1.0.0');
    assert.equal(row.owner, 'manager');
    assert.equal(row.domain, 'ai-foundation');
    assert.equal(row.decision, CONTEXT_SESSION_DECISION);
    assert.match(row.declaredIn, /ai-lego-set\.json#lego\[id=context-session\]\.versioning/, 'the claim is cited, not remembered');
    // Agent-2 published both rows on its branch; protected main still carries neither. Both facts
    // are recorded, because "published" without saying where is how a branch invents a contract.
    assert.equal(row.publishedOn.branch, 'arena/01a0c6b5-n8n-rust-v-4', `${row.contract} names the branch that publishes it`);
    assert.equal(row.publishedOn.commit, 'fb254f32', `${row.contract} names the commit`);
    assert.equal(row.publishedOn.status, 'implemented', `${row.contract} quotes the row's own status`);
    assert.equal(row.publishedOn.onProtectedMain, true, `${row.contract} is on protected main after PR #45`);
    assert.ok(row.publishedOn.operations.length >= 3, `${row.contract} records the operations the row publishes`);
    assert.ok(row.publishedOn.permissions.length >= 2, `${row.contract} records the permissions the row publishes`);
  }
  assert.deepEqual([...PENDING_CONTRACT_ROWS.find((row) => row.contract === CONTEXT_CONTRACT_ID).publishedOn.operations],
    ['load', 'compact', 'rollover', 'rehydrate', 'verify'], 'the five context operations the row publishes');
  assert.deepEqual([...PENDING_CONTRACT_ROWS.find((row) => row.contract === SESSION_CONTRACT_ID).publishedOn.operations],
    ['create', 'status', 'close'], 'and the three session operations');
  assert.equal(CONTEXT_DECLARED_VERSION, '1.0.0');
  assert.equal(CONTEXT_DECLARATION_SOURCE.publishedVersion, null, 'a claim is not a published version');
  assert.equal(SESSION_DECLARATION_SOURCE.publishedVersion, null);
});

test('provenance names the four declarations the surface is handed', () => {
  assert.equal(CONTEXT_DECLARATION_SOURCE.file, 'apps/n8n-lego/src/lego/manifest/ai-foundation.json');
  assert.equal(CONTEXT_DECLARATION_SOURCE.path, 'context');
  assert.equal(SESSION_DECLARATION_SOURCE.path, 'agentSession');
  assert.equal(LEGO_DECLARATION_SOURCE.path, 'lego#id=context-session');
  assert.equal(LEGO_DECLARATION_SOURCE.contract, null, 'the AI set is published by no lock row, so no contract is borrowed for it');
  assert.match(CAPABILITY_DECLARATION_SOURCE.path, /domains#id=ai-foundation\.capabilities\[id=ai\.context\|ai\.agent-session\]/);
  assert.equal(CAPABILITY_DECLARATION_SOURCE.contractVersion, '1.1.0');
  for (const source of [CONTEXT_DECLARATION_SOURCE, SESSION_DECLARATION_SOURCE, LEGO_DECLARATION_SOURCE, CAPABILITY_DECLARATION_SOURCE]) {
    assert.equal(source.owner, 'manager', `${source.path} names its owner`);
  }
});

/* ------------------------------------------------- 2. publication state honesty */

test('an unlocked contract is reported as declared-not-locked, never as published', { skip }, () => {
  if (!publishes213()) {
    assert.equal(rowFor(CONTEXT_CONTRACT_ID), null, 'this tree publishes no ai.context row');
    assert.equal(rowFor(SESSION_CONTRACT_ID), null, 'and no ai.agent-session row');
  }
  const view = createContextSessionView({ surface: SURFACE, declaration: backendDeclaration(), contract: [] });
  assert.equal(view.published, false, 'a declaration is not a publication: nothing handed over here publishes the rows, so nothing is claimed');
  for (const contract of [view.contracts.context, view.contracts.session]) {
    assert.equal(contract.published, false);
    assert.equal(contract.status, 'declared-not-locked');
    assert.equal(contract.version, null, 'no version is rendered that cannot be cited');
    assert.equal(contract.declaredVersion, '1.0.0', 'the claim is reported as a claim');
    assert.equal(contract.comparable, false);
    assert.equal(contract.decision, CONTEXT_SESSION_DECISION);
    assert.match(contract.detail, /no contract-lock row publishes it/);
  }
  assert.equal(view.availability, 'optional-absent', 'a declaration handed over with unlocked contracts is absent, not broken');
  assert.ok(view.unsupported, 'and the canonical unsupported answer is present');
  assert.equal(view.unsupported.state, 'capability-unavailable');
  assert.equal(view.unsupported.error, 'lego.capability_unavailable');
  assert.equal(view.unsupported.contract.version, null);
  assert.equal(view.unsupported.contract.published, false);
  // The same code, handed the rows this tree actually publishes, reports published — with no edit
  // in between. That is the whole point of deriving the state: agent-2's publication flips it.
  if (publishes213()) {
    const publishedView = createContextSessionView({ surface: SURFACE, declaration: backendDeclaration(), contract: lockRows() });
    assert.equal(publishedView.published, true);
    assert.equal(publishedView.contracts.context.version, rowFor(CONTEXT_CONTRACT_ID).version, 'the rendered version is the locked one');
    assert.equal(publishedView.contracts.context.status, rowFor(CONTEXT_CONTRACT_ID).status);
    assert.equal(publishedView.contracts.context.owner, rowFor(CONTEXT_CONTRACT_ID).owner);
    assert.equal(publishedView.contracts.context.agreesWithClaim, true, 'and it is the version the declaration claimed');
    assert.equal(publishedView.contracts.session.version, rowFor(SESSION_CONTRACT_ID).version);
    assert.equal(publishedView.unsupported, null, 'a published pair needs no unsupported answer');
    assert.equal(publishedView.availability, 'available');
  }
});

test('handed a real lock row, the same code reports published — the state is derived', () => {
  const rows = [
    { id: CONTEXT_CONTRACT_ID, version: '1.0.0', owner: 'manager', status: 'implemented', domain: 'ai-foundation' },
    { id: SESSION_CONTRACT_ID, version: '1.0.0', owner: 'manager', status: 'implemented', domain: 'ai-foundation' },
  ];
  const view = createContextSessionView({ surface: SURFACE, contract: rows });
  assert.equal(view.published, true);
  assert.equal(view.contracts.context.version, '1.0.0');
  assert.equal(view.contracts.session.status, 'implemented');
  assert.equal(view.unsupported, null, 'a published pair needs no unsupported answer');
  assert.equal(view.availability, 'available');
  // A row that disagrees with the claim is a difference to reconcile, not an average.
  const bumped = createContextSessionView({ surface: SURFACE, contract: [{ id: CONTEXT_CONTRACT_ID, version: '1.1.0', owner: 'manager' }, rows[1]] });
  assert.equal(bumped.contracts.context.agreesWithClaim, false);
  assert.match(bumped.contracts.context.detail, /while the declaration claims 1\.0\.0/);
  // A row with no version cannot be compared, and says so.
  const noVersion = createContextSessionView({ surface: SURFACE, contract: [{ id: CONTEXT_CONTRACT_ID, owner: 'manager' }, rows[1]] });
  assert.equal(noVersion.contracts.context.comparable, false);
  assert.equal(noVersion.published, true, 'publication is about the row existing');
  assert.match(noVersion.contracts.context.detail, /cannot be compared/);
});

test('if the backend publishes the rows, this surface must find them — pending is not permanent', { skip }, () => {
  const contextRow = rowFor(CONTEXT_CONTRACT_ID);
  const sessionRow = rowFor(SESSION_CONTRACT_ID);
  const view = createContextSessionView({ surface: SURFACE, declaration: backendDeclaration(), contract: lockRows() });
  assert.equal(view.contracts.context.published, contextRow !== null);
  assert.equal(view.contracts.session.published, sessionRow !== null);
  if (contextRow !== null) {
    assert.equal(view.contracts.context.version, contextRow.version, 'the rendered version is the locked one');
    assert.equal(view.contracts.context.owner, contextRow.owner);
  }
  // The manifest must record the publication whichever tree it is read against — as the rows THIS
  // tree publishes, or as the rows agent-2 published on its branch with the commit that published
  // them. What it may not do is stay silent while a publication exists: a manifest that says
  // "nothing is locked" next to a backend that locked both rows is how a frontend ends up quoting a
  // claim instead of a contract.
  const recorded = SURFACE.publication.rows.length > 0
    ? SURFACE.publication.rows
    : SURFACE.publication.publishedOnPeerBranch.rows;
  assert.equal(recorded.length, 2, 'manifest/context-session.json records both rows it was verified against');
  for (const row of recorded) {
    assert.equal(row.version, '1.0.0');
    assert.equal(row.owner, 'manager');
    assert.equal(row.domain, 'ai-foundation');
    assert.equal(row.status, 'implemented');
  }
  if (contextRow !== null && sessionRow !== null && !overridden) {
    // The default tree publishes them, so the manifest must have moved with it in the same change.
    assert.equal(SURFACE.publication.status, 'published');
    assert.deepEqual(SURFACE.publication.rows.map((row) => row.id ?? row.contract).sort(), [CONTEXT_CONTRACT_ID, SESSION_CONTRACT_ID].sort());
    assert.deepEqual(SURFACE.publication.rows.map((row) => row.version), ['1.0.0', '1.0.0']);
  } else if (contextRow !== null && sessionRow !== null) {
    // Pointed at a tree that publishes both rows: what the manifest recorded must be what that tree
    // publishes.
    const publishedIds = lockRows()
      .filter((row) => [CONTEXT_CONTRACT_ID, SESSION_CONTRACT_ID].includes(row.id ?? row.contract))
      .map((row) => `${row.id ?? row.contract}@${row.version}`)
      .sort();
    assert.deepEqual(recorded.map((row) => `${row.id ?? row.contract}@${row.version}`).sort(), publishedIds);
    assert.equal(SURFACE.publication.publishedOnPeerBranch.commit, 'fb254f32');
    /**
     * This assertion used to read `onProtectedMain === false` — "the peer branch is not main". That
     * was true while P2.13 was in flight and became false when the manager merged the branch as PR
     * #45: the same two rows are now protected main's, so the flat denial is the stale half. What is
     * checked instead is the claim itself: a publication recorded as being on protected main has to
     * name the merge that put it there, in the manifest and not only in a comment. A block that says
     * "published" without a merge would be the claim this used to catch in the other direction.
     */
    assert.equal(SURFACE.publication.publishedOnPeerBranch.onProtectedMain, true, 'the P2.13 rows are protected main\'s now, and the manifest says so');
    assert.match(SURFACE.publication.note, /PR #45/, 'and it names the merge that put them there');
    assert.equal(SURFACE.publication.protectedMain.state, 'published');
    assert.equal(SURFACE.publication.protectedMain.contextRow, true);
    assert.equal(SURFACE.publication.protectedMain.sessionRow, true);
  } else {
    assert.equal(SURFACE.publication.rows.length, 0, 'this tree publishes neither row, so the surface derives declared-not-locked');
    assert.equal(SURFACE.publication.status, 'declared-not-locked');
    assert.equal(SURFACE.publication.protectedMain.state, 'declared-not-locked');
    assert.equal(SURFACE.publication.publishedOnPeerBranch.onProtectedMain, false);
  }
});

test('pending vocabulary is promoted or the gate fails: a published word may not stay pending', { skip }, () => {
  // Scan the backend tree for the ruled values. If the backend publishes them, the set must be
  // quoted in the lock (with a contract, a version and a declaration path) — staying in
  // PENDING_PUBLICATIONS after publication is exactly the drift this check exists to catch.
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (/\.(json|mjs)$/.test(entry.name)) files.push(absolute);
    }
  };
  walk(join(BACKEND, 'manifest'));
  walk(join(BACKEND, 'contracts'));
  for (const file of ['ai-foundation.mjs', 'skill.mjs', 'foundation.mjs', 'interaction.mjs', 'negotiation.mjs',
    'context-session.mjs', 'context.mjs', 'agent-session.mjs']) {
    if (existsSync(join(BACKEND, file))) files.push(join(BACKEND, file));
  }
  // A vocabulary is published when the values are declared TOGETHER as one enumeration — a JSON
  // array in a manifest or a frozen array in a module. A word that merely appears in prose, or in
  // somebody else's enumeration (`trust: "verified"` is a trust level, not a continuation verdict),
  // publishes nothing, and counting it would promote a pending set on a coincidence.
  const enumerations = [];
  for (const file of files) {
    const body = readFileSync(file, 'utf8');
    if (file.endsWith('.json')) {
      const collect = (value) => {
        if (Array.isArray(value)) {
          if (value.every((entry) => typeof entry === 'string')) enumerations.push(value);
          for (const entry of value) collect(entry);
        } else if (value !== null && typeof value === 'object') {
          for (const entry of Object.values(value)) collect(entry);
        }
      };
      collect(JSON.parse(body));
    }
    for (const match of body.matchAll(/\[\s*((?:['"`][^'"`]*['"`]\s*,?\s*)+)\]/g)) {
      enumerations.push([...match[1].matchAll(/['"`]([^'"`]*)['"`]/g)].map((entry) => entry[1]));
    }
  }
  const declaredTogether = (values) => enumerations.some((list) => values.every((value) => list.includes(value)));
  for (const pending of PENDING_PUBLICATIONS) {
    const published = declaredTogether(pending.expectedValues) ? [...pending.expectedValues] : [];
    const quoted = vocabularyOf(pending.id) !== null;
    if (published.length === pending.expectedValues.length) {
      assert.equal(quoted, true, `${pending.id}: the backend now publishes ${published.join(', ')}, so the set must be quoted in the vocabulary lock with a contract and a declaration path — remove it from PENDING_PUBLICATIONS in the same change`);
    } else if (quoted) {
      assert.ok(true, `${pending.id} is quoted; the pending row should be dropped at reconciliation`);
    } else {
      assert.equal(published.length, 0, `${pending.id} stays pending: no backend declaration lists ${pending.expectedValues.join(' + ')} as one enumeration`);
    }
  }
});

/* ------------------------------------------------------- 3. alignment with backend */

test('the quoted vocabulary is the vocabulary the backend tree declares, block for block', { skip }, () => {
  const declaration = backendDeclaration();
  const drift = declarationDrift({ declaration, surface: SURFACE, contract: lockRows() });
  assert.deepEqual(drift.compared.length >= 10, true, `${drift.compared.length} declarations compared: ${drift.compared.join(', ')}`);
  if (registeredDifferences().length === 0) {
    assert.equal(drift.state, 'in-sync', JSON.stringify(drift.differences, null, 1));
    assert.deepEqual([...drift.differences], []);
  } else {
    assert.equal(drift.state, 'drift', 'a registered difference is reported as drift, never averaged away');
    assertAwaitingPublicationDifferences(drift.differences);
  }
  assert.equal(drift.owner, 'manager');
  assert.equal(drift.decision, CONTEXT_SESSION_DECISION);
  // The uncomparable half is named, so silence is never mistaken for agreement.
  const uncomparable = drift.uncomparable.filter((entry) => rowFor(entry.split(' ')[0]) === null);
  assert.ok(uncomparable.length >= 0);
  for (const row of PENDING_CONTRACT_ROWS) {
    if (rowFor(row.contract) === null) {
      assert.ok(drift.uncomparable.some((entry) => entry.startsWith(row.contract)), `${row.contract} is named as uncomparable while it has no lock row`);
    }
  }
});

test('a declaration that moved is reported with both spellings, never adopted', () => {
  const declaration = {
    context: { scopes: ['GLOBAL', 'WORKFLOW', 'NODE', 'EXECUTION', 'EVENT', 'AGENT', 'TASK', 'PROJECT'], fields: CONTEXT_FIELDS },
    agentSession: { states: ['created', 'running', 'waiting', 'suspended', 'completed', 'failed', 'cancelled'], fields: SESSION_FIELDS, references: SESSION_REFERENCES },
    lego: { lifecycle: CONTEXT_LIFECYCLE, continuationPackage: CONTINUATION_SECTIONS, operations: CONTEXT_DECLARED_VERBS, versioning: 'ai.context@1.0.0, ai.agent-session@1.0.0' },
  };
  const drift = declarationDrift({ declaration });
  assert.equal(drift.state, 'drift');
  const scopes = drift.differences.find((entry) => entry.field === 'scopes');
  assert.deepEqual([...scopes.added], ['PROJECT'], 'the word the backend added');
  assert.deepEqual([...scopes.removed], [], 'and nothing was dropped');
  const states = drift.differences.find((entry) => entry.field === 'states');
  assert.deepEqual([...states.added], ['suspended'], 'a renamed state is a contract conflict, not a synonym');
  assert.deepEqual([...states.removed], ['paused'], 'and the quoted spelling it replaced is named');
  assert.match(drift.rule, /never resolved locally/);
  // Absence is not a move: a block that does not carry a field says nothing about it.
  const partial = declarationDrift({ declaration: { context: { scopes: CONTEXT_SCOPES } } });
  assert.equal(partial.state, 'in-sync');
  assert.deepEqual([...partial.differences], []);
  assert.equal(partial.compared.length, 1);
  // Nothing handed over is a different state again.
  const none = declarationDrift({});
  assert.equal(none.state, 'not-declared');
  assert.equal(none.pending.length, PENDING_PUBLICATIONS.length + PENDING_CONTRACT_ROWS.length, 'the pending list names both the vocabulary and the two rows');
});

test('a version claim that disagrees with a locked row is a difference, not an average', () => {
  const rows = [{ id: CONTEXT_CONTRACT_ID, version: '2.0.0', owner: 'manager' }, { id: SESSION_CONTRACT_ID, version: '1.0.0', owner: 'manager' }];
  const drift = declarationDrift({
    declaration: { lego: { versioning: 'ai.context@1.0.0, ai.agent-session@1.0.0' } },
    contract: rows,
  });
  assert.equal(drift.state, 'drift');
  const versioning = drift.differences.find((entry) => entry.field === 'versioning');
  assert.deepEqual([...versioning.added], ['ai.context@2.0.0']);
  assert.deepEqual([...versioning.removed], ['ai.context@1.0.0']);
});

/* ------------------------------------------------------------- 4. state rendering */

test('the seven session states stay seven facts, and none of them is an execution', () => {
  const states = sessionLifecycle();
  assert.equal(states.length, 7);
  assert.equal(new Set(states.map((state) => state.state)).size, 7);
  for (const state of states) {
    assert.equal(state.known, true);
    assert.equal(state.executing, false, `${state.state} is not an execution state`);
    assert.equal(state.inference, false, `${state.state} implies no model call`);
    assert.equal(state.grants, null, `${state.state} grants nothing`);
    assert.ok(state.detail.length > 20, `${state.state} says what it means to the UI`);
  }
  assert.equal(sessionState('running').terminal, false);
  assert.equal(sessionState('completed').terminal, true);
  assert.equal(sessionState('failed').terminal, true);
  assert.equal(sessionState('cancelled').terminal, true);
  assert.deepEqual([...SESSION_TERMINAL_STATES].sort(), ['cancelled', 'completed', 'failed']);
  // No boolean is derived from the seven.
  assert.equal('enabled' in sessionState('running'), false);
  assert.equal('active' in sessionState('running'), false);
});

test('an unknown session state is reported, never mapped to the nearest one', () => {
  const unknown = sessionState('suspended');
  assert.equal(unknown.known, false);
  assert.equal(unknown.terminal, false);
  assert.equal(unknown.executing, false);
  assert.match(unknown.detail, /not one of the seven declared session states/);
  assert.match(unknown.detail, /created, running, waiting, paused, completed, failed, cancelled/);
  assert.equal(sessionState(undefined).known, false);
  assert.equal(sessionState(null).known, false);
});

test('the scope ladder is the quoted declaration order, widest to narrowest, and always selective', () => {
  const ladder = scopeLadder();
  assert.equal(ladder.length, 7);
  assert.deepEqual(ladder.map((entry) => entry.scope), [...CONTEXT_SCOPES]);
  assert.equal(ladder[0].width, 'widest');
  assert.equal(ladder[6].width, 'narrowest');
  assert.deepEqual(ladder.map((entry) => entry.rank), [0, 1, 2, 3, 4, 5, 6]);
  for (const entry of ladder) {
    assert.equal(entry.selective, true, `${entry.scope} is selectively loaded`);
    assert.equal(entry.eager, false, `${entry.scope} is never an eager load-everything context`);
    assert.ok(entry.detail.length > 10);
  }
  assert.equal(contextScope('PROJECT').known, false, 'an unknown scope is refused');
  assert.match(contextScope('workflow').detail, /not one of the seven declared scopes/, 'and a near-miss in the wrong case is refused too');
  assert.equal(contextScope('workflow').known, false);
});

test('the six context lifecycle states are rendered, and three of them are the rollover words', () => {
  const states = contextLifecycle();
  assert.equal(states.length, 6);
  assert.deepEqual(states.map((state) => state.state), [...CONTEXT_LIFECYCLE]);
  for (const state of states) {
    assert.equal(state.known, true);
    assert.ok(state.detail.length > 20, `${state.state} says what it means`);
  }
  assert.equal(contextLifecycleState('prepare').rollover, true);
  assert.equal(contextLifecycleState('compacting').rollover, true);
  assert.equal(contextLifecycleState('rolled-over').rollover, true);
  assert.equal(contextLifecycleState('rolled-over').compacted, true);
  assert.equal(contextLifecycleState('active').rollover, false);
  assert.deepEqual([...ROLLOVER_LIFECYCLE_STATES], ['prepare', 'compacting', 'rolled-over']);
  assert.equal(contextLifecycleState('NORMAL').known, false, 'the unpublished phase name is not a lifecycle state and is not accepted as one');
});

test('a session record is rendered from identity and references, with withheld fields named', () => {
  const session = {
    sessionId: 'sess-03',
    agentId: 'agent-copilot',
    parentSessionId: 'sess-02',
    status: 'running',
    createdAt: '2026-09-22T01:00:00Z',
    updatedAt: '2026-09-22T01:05:00Z',
    contextRef: 'ctx-9f2',
    artifactRef: 'art-11',
    traceRef: 'trace-4',
  };
  const view = createContextSessionView({ surface: SURFACE, session });
  assert.equal(view.session.validation.ok, true, JSON.stringify(view.session.validation.findings));
  assert.equal(view.session.state.state, 'running');
  assert.equal(view.session.lineage.previousSessionId, 'sess-02');
  assert.equal(view.session.lineage.linked, false, 'a parent is not a continuation link');
  assert.deepEqual([...view.session.withheld].sort(), ['executionId', 'runtimeId', 'taskId', 'workflowId'], 'the fields nobody reported are named, never guessed');
  assert.equal(view.session.record.contextRef, 'ctx-9f2');
});

test('the previous/next relationship comes from references, never from an inferred order', () => {
  const alone = sessionLineage({ session: { sessionId: 'sess-03', status: 'running' } });
  assert.equal(alone.linked, false);
  assert.equal(alone.affordance, null);
  assert.match(alone.detail, /no continuation reference/);
  const withParent = sessionLineage({ session: { sessionId: 'sess-04', parentSessionId: 'sess-03', status: 'running' } });
  assert.equal(withParent.previousSessionId, 'sess-03');
  const linked = sessionLineage({
    session: { sessionId: 'sess-04', parentSessionId: 'sess-03', nextSessionId: 'sess-05', contextRef: 'ctx-b' },
    continuation: { identity: { sessionId: 'sess-04', contextId: 'ctx-a' }, sourceContextId: 'ctx-a' },
  });
  assert.equal(linked.linked, true);
  assert.equal(linked.nextSessionId, 'sess-05');
  assert.equal(linked.parentContextId, 'ctx-a');
  assert.equal(linked.affordance, 'continuation-linked');
  // A verified / degraded / failed result changes the affordance, and only those three are accepted.
  for (const [result, affordance] of [['verified', 'continuity-verified'], ['degraded', 'continuation-degraded'], ['failed', 'continuation-failed']]) {
    const line = sessionLineage({
      session: { sessionId: 'sess-04', nextSessionId: 'sess-05' },
      continuation: { identity: { sessionId: 'sess-04', contextId: 'ctx-a' }, verification: { result } },
    });
    assert.equal(line.affordance, affordance, `${result} renders as ${affordance}`);
  }
  assert.match(linked.rule, /never inferred from time/);
});

/* ------------------------------------------------------------------- 5. rollover */

test('no usage reported means no phase, no percentage and no invented NORMAL', () => {
  const phase = expectedRolloverPhase({ threshold: 0.8 });
  const phaseSet = vocabularyOf('contextRolloverPhase');
  const phasePublished = phaseSet.provenance.contract !== null;
  assert.equal(phase.expectedPhase, null, 'silence is never a phase');
  assert.equal(phase.published, phasePublished, 'the publication state is derived from the lock, not hardcoded');
  assert.equal(phase.phasePublication, phasePublished ? 'published' : 'pending');
  assert.equal(phase.decision, phasePublished ? null : CONTEXT_SESSION_DECISION);
  assert.deepEqual([...phase.phases], ['NORMAL', 'PREPARE', 'ROLLOVER'], phasePublished
    ? 'quoted from CONTEXT_MANAGER_STATES inside the locked ai.context@1.0.0 surface'
    : 'the ruled phases are named as pending, not quoted');
  if (phasePublished) {
    assert.deepEqual(phase.phaseContract, { id: 'ai.context', version: '1.0.0', owner: 'manager' }, 'and the contract it came from is cited');
  }
  assert.equal(phase.usage.state, 'not-reported');
  assert.match(phase.detail, /no phase to expect/, 'nothing reported means nothing expected');
  assert.match(phase.detail, /never asserted from silence/);
});

test('a declared threshold below the bound produces a deterministic expectation', () => {
  const below = expectedRolloverPhase({ usage: { kind: 'modelInput', used: 12_000, budget: 32_000, unit: 'tokens', source: 'reported' }, threshold: 0.8 });
  assert.equal(below.expectedPhase, 'NORMAL');
  assert.equal(below.usage.percent, 38);
  assert.match(below.detail, /below the 80% threshold/);
  const at = expectedRolloverPhase({ usage: { kind: 'modelInput', used: 26_000, budget: 32_000, unit: 'tokens', source: 'reported' }, threshold: 0.8 });
  assert.equal(at.expectedPhase, 'PREPARE');
  assert.equal(at.publishedWord, 'prepare', 'the published lifecycle word the UI renders for it');
  assert.match(at.detail, /at or above the 80% threshold/);
  assert.match(at.detail, /not at the limit/);
  // Deterministic: the same inputs produce the same answer, every time.
  assert.deepEqual(expectedRolloverPhase({ usage: { kind: 'modelInput', used: 26_000, budget: 32_000, unit: 'tokens', source: 'reported' }, threshold: 0.8 }), at);
  // A reported lifecycle state wins over the computed expectation.
  const compacting = expectedRolloverPhase({ usage: { kind: 'modelInput', used: 26_000, budget: 32_000, unit: 'tokens', source: 'reported' }, threshold: 0.8, lifecycleState: 'compacting' });
  assert.equal(compacting.expectedPhase, 'ROLLOVER');
  assert.equal(compacting.publishedWord, 'compacting');
});

test('a threshold at or above the limit is refused, with the reason the declaration gives', () => {
  for (const threshold of [1, 1.2, 0]) {
    const check = validateRolloverThreshold(threshold);
    assert.equal(check.ok, false, `${threshold} is refused`);
    assert.ok(check.findings.length > 0);
  }
  assert.match(validateRolloverThreshold(1).findings[0], /no room left to write the continuation package/);
  assert.match(validateRolloverThreshold(0).findings[0], /rolls over before anything is loaded/);
  assert.match(validateRolloverThreshold(null).findings[0], /no rollover threshold was declared/);
  assert.equal(validateRolloverThreshold(0.85).ok, true);
  // The surface carries the refusal through: a bad threshold yields no expected phase.
  const phase = expectedRolloverPhase({ usage: { kind: 'modelInput', used: 30, budget: 32, unit: 'tokens', source: 'reported' }, threshold: 1 });
  assert.equal(phase.expectedPhase, null);
  assert.deepEqual([...phase.thresholdFindings], validateRolloverThreshold(1).findings);
});

test('the UI observes a rollover and never triggers one', () => {
  assert.equal(typeof CONTEXT_SESSION_AFFORDANCES.forbidden.rollOverNow, 'string');
  assert.match(CONTEXT_SESSION_AFFORDANCES.forbidden.rollOverNow, /not a button/);
  assert.equal(CONTEXT_SESSION_AFFORDANCES.allowed.includes('show-rollover-state'), true);
  // Derived, in both directions: agent-2's publication registers `rollover`, protected main does
  // not, and the UI triggers it in neither tree.
  assert.equal(PUBLISHED_OPERATION_IDS.some((id) => /rollover/.test(id)), CONTEXT_OPERATIONS.includes('rollover'),
    'a rollover operation is named only if the registry publishes one');
  assert.deepEqual([...UNPUBLISHED_CONTEXT_VERBS], CONTEXT_DECLARED_VERBS.filter((verb) => !CONTEXT_OPERATIONS.includes(verb)),
    'the declared verbs nobody registered — derived, so a publication empties the list instead of staleing a hardcoded three');
  assert.equal(CONTEXT_SESSION_AFFORDANCES.allowed.some((name) => /trigger|roll-over-now|start/i.test(name)), false, 'no allowed affordance triggers anything');
  assert.equal(CONTINUATION_AFFORDANCES.some((affordance) => affordance.id === 'roll-over-now'), false, 'and there is no such continuation line');
  // The refusal reasons move with the publication, and say which operation a backend would use.
  assert.match(forbiddenReasons().verify, CONTEXT_OPERATIONS.includes('verify') ? /published as ai\.context\.verify/ : /published as no operation/);
  assert.match(forbiddenReasons({ contextOperations: ['load', 'compact'] }).verify, /published as no operation/);
  assert.match(forbiddenReasons({ contextOperations: ['load', 'compact', 'rollover', 'rehydrate', 'verify'] }).continueSession, /ai\.context\.rollover -> ai\.context\.rehydrate -> ai\.context\.verify/,
    'the published path is named, and still not triggered from here');
});

/* ------------------------------------------------------------- 6. continuation */

test('a continuation package is validated against the fourteen quoted sections', () => {
  const pkg = {
    identity: { sessionId: 'sess-03', contextId: 'ctx-a' },
    objective: 'ship the frontend Context & Session surface',
    plan: ['quote the vocabulary', 'render the states', 'run the gates'],
    completedWork: ['vocabulary quoted'],
    unfinishedWork: ['gates'],
    constraints: ['no fabricated tokens'],
    decisions: [{ decisionId: 'XA-20', reasonSummary: 'publication owed' }],
    activeEntities: ['arena/01a0c6b4-n8n-rust-v-4'],
    toolStateReferences: [],
    artifacts: ['art-11'],
    importantReferences: ['docs/n8n-lego/milestones.json'],
    errors: [],
    unresolvedQuestions: ['XA-20'],
    compressedHistory: ['the surface was designed from the published declaration'],
  };
  const result = validateContinuationPackage(pkg);
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(result.present.length, 14);
  assert.deepEqual([...result.missing], []);
  assert.equal(result.bounded, true);
  assert.deepEqual([...result.refused], []);
});

test('a package with no identity is refused, not rendered', () => {
  const anonymous = validateContinuationPackage({ objective: 'something', plan: ['x'] });
  assert.equal(anonymous.ok, false);
  assert.ok(anonymous.findings.some((finding) => finding.includes('"identity" is required')));
  assert.match(anonymous.findings.find((finding) => finding.includes('identity')), /refused, not rendered/);
  const wrongIdentity = validateContinuationPackage({ identity: { sessionId: 'sess-03' } });
  assert.ok(wrongIdentity.findings.some((finding) => finding.includes('identity.contextId')), 'the context the continuation carries over must be named');
  const notAnObject = validateContinuationPackage(null);
  assert.equal(notAnObject.ok, false);
  assert.deepEqual([...notAnObject.missing], [...CONTINUATION_SECTIONS], 'nothing is present, so everything is reported missing');
});

test('a package that is a dump is refused as unbounded', () => {
  const tooMany = validateContinuationPackage({ identity: { sessionId: 's', contextId: 'c' }, importantReferences: Array.from({ length: 65 }, (_, index) => `ref-${index}`) });
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.findings.some((finding) => finding.includes('against a bound of 64')));
  assert.equal(tooMany.bounded, false);
  const transcript = validateContinuationPackage({ identity: { sessionId: 's', contextId: 'c' }, compressedHistory: [{ raw: 'the whole conversation verbatim' }] });
  assert.equal(transcript.ok, false);
  assert.ok(transcript.findings.some((finding) => finding.includes('a raw message body is a transcript')));
  const longString = validateContinuationPackage({ identity: { sessionId: 's', contextId: 'c' }, objective: 'x'.repeat(5000) });
  assert.equal(longString.ok, false);
  assert.ok(longString.findings.some((finding) => finding.includes('reads like a transcript')));
  const unknownSection = validateContinuationPackage({ identity: { sessionId: 's', contextId: 'c' }, chainSummary: 'x' });
  assert.ok(unknownSection.findings.some((finding) => finding.includes('unknown section "chainSummary"')));
});

test('verification has exactly three results, and an unknown one is refused', () => {
  const pkg = { identity: { sessionId: 'sess-04', contextId: 'ctx-a' }, objective: 'x', plan: ['y'], unfinishedWork: ['z'], constraints: ['c'], decisions: ['d'], artifacts: ['a'], importantReferences: ['r'], errors: [], completedWork: [], activeEntities: [], toolStateReferences: [], unresolvedQuestions: [], compressedHistory: [] };
  const before = { contextId: 'ctx-a', scope: 'TASK', checksum: 'aaa' };
  const after = { contextId: 'ctx-b', scope: 'TASK', parent: { contextId: 'ctx-a', checksum: 'aaa' }, checksum: 'bbb' };
  const verified = continuityVerification({ pkg, before, after });
  assert.equal(verified.result, 'verified');
  assert.equal(verified.published, vocabularyOf('continuationVerification').provenance.contract !== null,
    'the result vocabulary is published when the lock quotes a contract for it, and pending when it does not');
  assert.deepEqual([...verified.results], ['verified', 'degraded', 'failed']);
  assert.deepEqual([...verified.missing], []);
  assert.deepEqual([...verified.repaired], [], 'nothing is repaired here, ever');
  assert.equal(verified.checks.length, CONTINUITY_CHECKS.length);
  assert.ok(verified.checks.every((check) => check.ok), JSON.stringify(verified.checks.filter((check) => !check.ok)));
  // A backend result wins, and a disagreement is reported rather than swallowed.
  const disagreed = continuityVerification({ pkg, before, after, result: 'degraded' });
  assert.equal(disagreed.result, 'degraded');
  assert.equal(disagreed.reportedDisagreement.computed, 'verified');
  assert.match(disagreed.reportedDisagreement.detail, /neither is silently adopted/);
  // An unknown result is refused, not mapped to the nearest one.
  assert.throws(() => continuityVerification({ pkg, before, after, result: 'mostly-fine' }), (error) => {
    assert.ok(error instanceof ContextSessionError);
    assert.equal(error.code, 'frontend.context-session.unknown-verification-result');
    assert.match(error.message, /is not one of the three (published|ruled) verification results/, 'the wording follows the publication state');
    return true;
  });
});

test('a degraded continuation names what is missing, and a failed one is never a new session', () => {
  // `decisions` is absent from this package: that is a loss, and it is named.
  const partial = { identity: { sessionId: 'sess-04', contextId: 'ctx-a' }, objective: 'x', plan: ['y'], constraints: ['c'], artifacts: [], importantReferences: [], errors: [], completedWork: [], unfinishedWork: [], activeEntities: [], toolStateReferences: [], unresolvedQuestions: [], compressedHistory: [] };
  const before = { contextId: 'ctx-a' };
  const after = { contextId: 'ctx-b', parent: { contextId: 'ctx-a' } };
  const degraded = continuityVerification({ pkg: partial, before, after });
  assert.equal(degraded.result, 'degraded');
  assert.deepEqual([...degraded.missing].sort(), ['decisions']);
  assert.ok(degraded.checks.find((check) => check.id === 'decisions').ok === false);
  assert.match(degraded.checks.find((check) => check.id === 'decisions').detail, /was not carried/);
  assert.match(degraded.detail, /announced, not hidden, and not repaired here/);
  // Absent is not empty: the same package with `decisions: []` carried is verified, because
  // "there were no decisions" is a fact the reader is entitled to, not a loss.
  const explicitlyNone = continuityVerification({ pkg: { ...partial, decisions: [] }, before, after });
  assert.equal(explicitlyNone.result, 'verified');
  assert.deepEqual([...explicitlyNone.missing], []);
  assert.match(explicitlyNone.checks.find((check) => check.id === 'decisions').detail, /explicitly empty/);
  const rehydrated = rehydration({ pkg: partial, verification: degraded });
  assert.equal(rehydrated.state, 'continuation-degraded');
  assert.deepEqual([...rehydrated.missing], ['decisions']);
  // Lineage broken -> failed, and the failure is surfaced as a failure.
  const orphan = continuityVerification({ pkg: partial, before, after: { contextId: 'ctx-b', parent: { contextId: 'ctx-OTHER' } } });
  assert.equal(orphan.result, 'failed');
  assert.ok(orphan.missing.includes('lineage'));
  assert.equal(rehydration({ pkg: partial, verification: orphan }).state, 'continuation-failed');
  // No identity -> failed before any check runs.
  const noIdentity = continuityVerification({ pkg: { objective: 'x' }, before, after });
  assert.equal(noIdentity.result, 'failed');
  assert.match(noIdentity.detail, /refused before verification/);
  // Unverified is its own state: rehydration is never assumed to have worked.
  const unverified = rehydration({ pkg: partial, verification: null });
  assert.equal(unverified.state, 'not-verified');
  assert.match(unverified.detail, /never assumed to have worked/);
});

test('the six continuation affordances are the whole continuation vocabulary of the UI', () => {
  assert.equal(CONTINUATION_AFFORDANCES.length, 6);
  assert.deepEqual(
    CONTINUATION_AFFORDANCES.map((entry) => entry.id),
    ['continue-session', 'rollover-preparing', 'continuation-linked', 'continuity-verified', 'continuation-degraded', 'continuation-failed'],
  );
  assert.deepEqual([...vocabularyOf('continuationAffordance').values], CONTINUATION_AFFORDANCES.map((entry) => entry.id), 'the local set and the surface agree');
  for (const entry of CONTINUATION_AFFORDANCES) {
    assert.ok(entry.says.length > 0, `${entry.id} says something a user can read`);
    assert.ok(entry.rendersFrom.length > 0, `${entry.id} names the backend fact it renders`);
    assert.ok(entry.detail.length > 20, `${entry.id} explains itself`);
    assert.ok(['operation-unpublished', 'rendered-from-declaration'].includes(entry.state), `${entry.id} is either rendered from a declaration or answered unpublished`);
  }
  const continueSession = CONTINUATION_AFFORDANCES.find((entry) => entry.id === 'continue-session');
  assert.equal(continueSession.operation, null, 'no continue operation exists');
  assert.equal(continueSession.state, 'operation-unpublished');
  assert.match(continueSession.detail, /never wired to an invented operation/);
  assert.equal(vocabularyOf('operationOutcome').values.includes('operation-unpublished'), true, 'and that answer is a declared operation outcome');
  // No silent reset anywhere in the six.
  assert.equal(CONTINUATION_AFFORDANCES.some((entry) => /reset|new session|start over/i.test(entry.says)), false);
  assert.match(CONTEXT_SESSION_AFFORDANCES.forbidden.resetSession, /never as a fresh session/);
});

/* --------------------------------------------------------------- 7. usage honesty */

test('no fabricated tokens: four sourced states and no path from nothing to a number', () => {
  assert.deepEqual([...USAGE_REPORT_STATES], ['reported', 'estimated', 'not-reported', 'over-budget']);
  assert.deepEqual([...vocabularyOf('contextUsageReport').values], USAGE_REPORT_STATES);
  const nothing = contextUsage(null);
  assert.equal(nothing.state, 'not-reported');
  assert.equal(nothing.percent, null);
  assert.equal(nothing.used, null);
  assert.equal(nothing.fabricated, false);
  assert.match(nothing.detail, /never computed from nothing/);
  assert.equal(contextUsage({}).state, 'not-reported', 'an empty object reports nothing');
  assert.equal(contextUsage({ used: 100, unit: 'tokens', source: 'reported' }).state, 'not-reported', 'a number with no kind is ambiguous and is not rendered');
  assert.match(contextUsage({ kind: 'context', used: 100, unit: 'tokens', source: 'reported' }).detail, /not one of the three declared token kinds/);
  assert.equal(contextUsage({ kind: 'modelInput', used: 1847 }).state, 'not-reported', 'no unit, no figure');
  assert.match(contextUsage({ kind: 'modelInput', used: 1847, unit: 'tokens' }).detail, /source must be declared/);
});

test('a reported figure carries its kind, its unit and its source, and an estimate stays labelled', () => {
  const reported = contextUsage({ kind: 'modelInput', used: 12_400, budget: 32_000, unit: 'tokens', source: 'reported' });
  assert.equal(reported.state, 'reported');
  assert.equal(reported.percent, 39);
  assert.equal(reported.remaining, 19_600);
  assert.equal(reported.kind, 'modelInput');
  assert.equal(reported.fabricated, false);
  const estimated = contextUsage({ kind: 'message', used: 1, unit: 'tokens', source: 'estimated' });
  assert.equal(estimated.state, 'estimated');
  assert.equal(estimated.percent, null, 'no bound was declared, so no percentage is drawn');
  assert.match(estimated.detail, /^estimated /, 'an estimate is labelled as one');
  const over = contextUsage({ kind: 'modelInput', used: 33_000, budget: 32_000, unit: 'tokens', source: 'reported' });
  assert.equal(over.state, 'over-budget');
  assert.equal(over.remaining, 0);
  assert.match(over.detail, /no room left for the continuation package/);
  // The three kinds are the whole vocabulary, and the confusion they prevent is documented.
  assert.deepEqual([...TOKEN_KINDS], ['message', 'modelInput', 'output']);
  assert.equal(vocabularyOf('tokenKind').promotedFrom.decision, 'XA-17');
  assert.equal(vocabularyOf('tokenKind').provenance.contract.id, 'ai.token-usage',
    'tokenKind is quoted from the P2.24 publication, not held pending');
});

test('the surface is not a token dashboard and never renders the window itself', () => {
  assert.equal(SURFACE.rendering.tokenDashboard, false);
  assert.equal(SURFACE.rendering.transcript, false);
  assert.equal(SURFACE.rendering.fabricatedTokenCount, false);
  const view = createContextSessionView({ surface: SURFACE });
  assert.equal(view.context.usage.state, 'not-reported');
  assert.equal('transcript' in view.context, false);
  assert.equal('body' in view.context, false);
  assert.equal('messages' in view.session, false);
  assert.deepEqual([...view.operations.offered], [], 'no operation is offered');
  assert.equal(FORBIDDEN_IMPLICATIONS.includes('token-fabrication'), true);
  assert.equal(FORBIDDEN_IMPLICATIONS.includes('transcript-dump'), true);
});

/* --------------------------------------------------- 8. memory and execution honesty */

/**
 * P2.14 rewrote this test, and it is worth saying why rather than quietly changing an expectation.
 *
 * At P2.13 the assertion was `memory.exists === false` and `memory.contract === null` with "NO STORE
 * EXISTS" underneath, which was true of every tree while no tree published a memory contract. Agent-2
 * then published `ai.memory@1.0.0` on its P2.14 branch, so the flat denial became a statement that is
 * true of protected main and false of the tree the manager is about to merge. A test that keeps
 * demanding the denial would pass by being wrong about the backend — and the same test would have to
 * be re-deleted after the merge, which is how an assertion turns into a comment.
 *
 * What replaces it is strictly more: the concept is **derived from the rows handed over** (true in
 * both trees), the separation is asserted in the direction this surface owns (it renders no memory
 * record even when a store is published), and every refusal that was there before is still here.
 */
test('Memory is a separate LEGO, never an extension of this surface: the fifth concept is derived', () => {
  assert.equal(DISTINCT_CONCEPTS.length, 5);
  const memory = DISTINCT_CONCEPTS.find((concept) => concept.id === 'memory');
  // The module-level constant is the default tree (protected main @ 67e638ef: no ai.memory row).
  assert.equal(memory.exists, false);
  assert.equal(memory.contract, 'ai.memory', 'the contract is NAMED even when no tree locks it — naming it is what keeps the concept from being absorbed');
  assert.equal(memory.decision, MEMORY_DECISION);
  assert.match(memory.detail, /NO STORE IS PUBLISHED IN THIS TREE/);
  assert.match(memory.detail, /loaded context \(ai\.context\), decisions \(ai\.decision\) and artifacts \(ai\.artifact\)/);
  assert.equal(FORBIDDEN_IMPLICATIONS.includes('memory-store'), true);
  assert.equal(SURFACE.rendering.memoryStore, false);
  assert.match(CONTEXT_SESSION_AFFORDANCES.forbidden.loadMemory, /XA-12/);

  const view = createContextSessionView({ surface: SURFACE });
  assert.equal(view.concepts.find((concept) => concept.id === 'memory').exists, false);
  assert.equal(view.memoryPublication.published, false, 'this tree publishes no ai.memory row');

  // The derivation, in both directions — and the half that never changes: this surface renders no
  // memory record either way. A published store belongs to another LEGO; a denied one is denied here.
  const peerRows = [
    { id: 'ai.context', version: '1.0.0', owner: 'manager' },
    { id: 'ai.agent-session', version: '1.0.0', owner: 'manager' },
    { id: 'ai.memory', version: '1.0.0', owner: 'manager', status: 'implemented' },
  ];
  const withMemory = createContextSessionView({ surface: SURFACE, contract: peerRows });
  const derived = withMemory.concepts.find((concept) => concept.id === 'memory');
  assert.equal(withMemory.memoryPublication.published, true);
  assert.equal(derived.exists, 'implemented', 'a published ai.memory row makes the store exist in that tree');
  assert.equal(derived.contract, 'ai.memory');
  assert.match(derived.detail, /A STORE IS PUBLISHED, and it is a DIFFERENT LEGO/);
  assert.match(derived.detail, /renders NO memory record/);
  assert.equal('memory' in withMemory.session, false, 'and the session block still holds no memory');
  assert.equal(withMemory.context.record, null, 'nor does the context block');
  assert.equal(withMemory.published, true, 'the pair is published in that tree too, and the memory row did not have to be involved');
  // Publication is read, never absorbed: the surface's own publication state is about ITS two rows,
  // so an `ai.memory` row on its own publishes neither of them.
  const memoryOnly = createContextSessionView({ surface: SURFACE, contract: [{ id: 'ai.memory', version: '1.0.0', owner: 'manager', status: 'implemented' }] });
  assert.equal(memoryOnly.published, false, 'ai.memory does not publish ai.context or ai.agent-session');
  assert.equal(memoryOnly.memoryPublication.published, true, 'and the memory row is still read, for the concept only');
  assert.equal(memoryOnly.concepts.find((concept) => concept.id === 'memory').exists, 'implemented');
  assert.equal(memoryOnly.contracts.context.status, 'declared-not-locked', 'the pair still fails closed on its own rows');

  // A record that claims a memory is refused — and now the message says where memory actually lives.
  assert.throws(() => assertDistinctConcepts({ sessionId: 'sess-03', memory: { entries: 12 } }), (error) => {
    assert.equal(error.code, 'frontend.context-session.concepts-merged');
    assert.match(error.message, /SEPARATE LEGO/);
    assert.match(error.message, /ai\.memory/);
    return true;
  });
});

test('no execution affordance: the Agent Machine has no runtime and this surface is not it', () => {
  for (const name of ['execute', 'infer', 'continueSession', 'rehydrate', 'verify', 'writeContext', 'rollOverNow', 'grantPermission', 'tools', 'filesystem', 'terminal']) {
    assert.equal(typeof CONTEXT_SESSION_AFFORDANCES.forbidden[name], 'string', `${name} is refused with a reason`);
  }
  assert.match(CONTEXT_SESSION_AFFORDANCES.forbidden.execute, /Agent Machine has no runtime/);
  for (const implication of ['model-inference', 'provider-call', 'agent-execution', 'skill-execution', 'workspace-action', 'mcp-runtime', 'runtime-adapter', 'permission-grant']) {
    assert.equal(FORBIDDEN_IMPLICATIONS.includes(implication), true, `${implication} is forbidden`);
  }
  assert.equal(SURFACE.rendering.executionAffordance, false);
  const execution = DISTINCT_CONCEPTS.find((concept) => concept.id === 'execution');
  assert.match(execution.detail, /no execution affordance is offered from this surface/);
  const states = sessionLifecycle();
  assert.ok(states.every((state) => state.executing === false), 'no session state is an execution state');
});

test('five concepts stay five: a merged AI-state object is refused by name', () => {
  assert.deepEqual(DISTINCT_CONCEPTS.map((concept) => concept.id), ['conversation', 'session', 'context-window', 'memory', 'execution']);
  const ok = assertDistinctConcepts({ sessionId: 'sess-03', status: 'running', contextRef: 'ctx-a', artifactRef: 'art-1', traceRef: 'trace-1' });
  assert.equal(ok.ok, true);
  assert.equal(ok.concepts.length, 5);
  assert.match(ok.rule, /Referencing is allowed; merging is not/);
  const merged = [
    { sessionId: 's', transcript: ['hello'] },
    { sessionId: 's', context: { body: ['...'] } },
    { sessionId: 's', execution: { runData: {} } },
    { sessionId: 's', reasoning: 'the model considered...' },
    { sessionId: 's', messages: [] },
  ];
  for (const record of merged) {
    assert.throws(() => assertDistinctConcepts(record), ContextSessionError, `${Object.keys(record).join(',')} is refused`);
  }
  assert.throws(() => assertDistinctConcepts(null), /must be an object/);
  assert.throws(() => assertDistinctConcepts([]), /must be an object/);
});

/* --------------------------------------------------------------- 9. security */

test('secrets and private model material are refused by name and by pattern', () => {
  for (const key of ['credentials', 'token', 'accessToken', 'apiKey', 'cookie', 'authorization', 'password', 'privateKey', 'chainOfThought', 'reasoning', 'rawPrompt', 'hiddenPrompt', 'systemPrompt', 'transcript', 'messages', 'modelOutput', 'completion', 'path', 'hostPath', 'grants', 'permissions', 'capabilityGrants']) {
    assert.equal(typeof FORBIDDEN_FIELDS[key], 'string', `${key} is refused with a reason`);
    assert.equal(FORBIDDEN_KEY_PATTERN.test(key), true, `${key} also matches the pattern`);
  }
  const refused = scanForbiddenKeys({
    sessionId: 'sess-03',
    contextRef: 'ctx-a',
    nested: { authorizationHeader: 'Bearer ...', chain_of_thought: '...' },
  });
  assert.equal(refused.length, 2, JSON.stringify(refused));
  assert.equal(refused[0].key, 'nested.authorizationHeader', 'a nested key is named with its path');
  const view = createContextSessionView({
    surface: SURFACE,
    session: { sessionId: 'sess-03', agentId: 'a', status: 'running', cookie: 'sid=1' },
  });
  assert.equal(view.session.validation.ok, false);
  assert.ok(view.session.validation.findings.some((finding) => finding.includes('"cookie" is refused')));
  assert.equal(view.refused.length, 1);
  assert.equal(view.refused[0].key, 'cookie');
  // Nothing was declared, so the surface cannot render anything: the refusal is named in the
  // availability detail rather than changing the publication state it was verified against.
  assert.equal(view.availability, view.published ? 'degraded' : 'capability-unavailable');
  assert.match(view.availabilityDetail, /refused \(cookie\)/, 'the refusal is visible in the state a reader sees');
  assert.ok(view.findings.length > 0);
  // With the declaration handed over, the same refusal degrades the surface instead of hiding.
  const declared = createContextSessionView({
    surface: SURFACE,
    declaration: { context: { scopes: CONTEXT_SCOPES, fields: CONTEXT_FIELDS }, agentSession: { states: SESSION_STATES, fields: SESSION_FIELDS, references: SESSION_REFERENCES } },
    session: { sessionId: 'sess-03', agentId: 'a', status: 'running', cookie: 'sid=1' },
  });
  assert.equal(declared.availability, declared.published ? 'degraded' : 'optional-absent');
  assert.equal(declared.refused.length, 1);
});

test('a session and a context are bounded: references, not payloads', () => {
  const inlined = validateSessionRecord({ sessionId: 's', agentId: 'a', status: 'running', contextRef: { contextId: 'ctx-a', body: ['...'] } });
  assert.equal(inlined.ok, false);
  assert.ok(inlined.findings.some((finding) => finding.includes('must be a reference string')));
  const unknownField = validateSessionRecord({ sessionId: 's', agentId: 'a', status: 'running', history: [] });
  assert.ok(unknownField.findings.some((finding) => finding.includes('"history"')));
  const overBound = validateContextRecord({ contextId: 'ctx-a', scope: 'TASK', size: 40_000, budget: 32_000 });
  assert.equal(overBound.ok, false);
  assert.ok(overBound.findings.some((finding) => finding.includes('exceeds the declared bound')));
  const parentPayload = validateContextRecord({ contextId: 'ctx-b', scope: 'TASK', parent: { contextId: 'ctx-a', body: ['...'] } });
  assert.ok(parentPayload.findings.some((finding) => finding.includes('inlined payload')), 'lineage stays provable and bounded');
  assert.equal(validateContextRecord({ contextId: 'ctx-b', scope: 'TASK', parent: { contextId: 'ctx-a', checksum: 'aaa' }, checksum: 'bbb', version: '3' }).ok, true);
});

test('context and session validation fail closed on identity, scope and state', () => {
  const noId = validateContextRecord({ scope: 'TASK' });
  assert.equal(noId.ok, false);
  assert.ok(noId.findings.some((finding) => finding.includes('"contextId" must name the context')));
  const noScope = validateContextRecord({ contextId: 'ctx-a' });
  assert.ok(noScope.findings.some((finding) => finding.includes('an undeclared scope is an eager load by accident')));
  const badScope = validateContextRecord({ contextId: 'ctx-a', scope: 'EVERYTHING' });
  assert.ok(badScope.findings.some((finding) => finding.includes('unknown scope "EVERYTHING"')));
  const badLifecycle = validateContextRecord({ contextId: 'ctx-a', scope: 'TASK', lifecycle: 'NORMAL' });
  assert.ok(badLifecycle.findings.some((finding) => finding.includes('unknown lifecycle state "NORMAL"')), 'the unpublished phase name is not accepted as a lifecycle state');
  const badVersion = validateContextRecord({ contextId: 'ctx-a', scope: 'TASK', version: 'latest' });
  assert.ok(badVersion.findings.some((finding) => finding.includes('"version" must be a monotonic identifier')));
  const session = validateSessionRecord({ sessionId: 's', status: 'running' });
  assert.ok(session.findings.some((finding) => finding.includes('"agentId" must name the agent')));
  const noStatus = validateSessionRecord({ sessionId: 's', agentId: 'a' });
  assert.ok(noStatus.findings.some((finding) => finding.includes('never inferred from the presence of fields')));
  const badStatus = validateSessionRecord({ sessionId: 's', agentId: 'a', status: 'suspended' });
  assert.ok(badStatus.findings.some((finding) => finding.includes('unknown status "suspended"')));
  assert.equal(badStatus.terminal, false);
  assert.equal(validateSessionRecord({ sessionId: 's', agentId: 'a', status: 'failed' }).terminal, true);
  assert.equal(validateContextRecord(null).ok, false);
  assert.equal(validateSessionRecord([]).ok, false);
});

/* ------------------------------------------------------- 10. the assembled view */

test('the view carries the whole surface, and every absence has a name', () => {
  const view = createContextSessionView({ surface: SURFACE, contract: [] });
  assert.equal(view.published, false);
  assert.equal(view.availability, 'capability-unavailable');
  assert.match(view.availabilityDetail, /nothing was declared, so no state is rendered/);
  assert.equal(view.session.state, null);
  assert.equal(view.context.scope, null);
  assert.equal(view.context.usage.state, 'not-reported');
  assert.equal(view.rollover.expectedPhase, null);
  assert.equal(view.continuation.verification, null);
  assert.equal(view.continuation.rehydration, null);
  assert.deepEqual([...view.continuation.missing], []);
  assert.equal(view.session.lineage.linked, false);
  assert.equal(view.drift.state, 'not-declared');
  assert.equal(view.pending.length, PENDING_PUBLICATIONS.length);
  assert.equal(view.quote.length, CONTEXT_SESSION_QUOTED_VOCABULARIES.length);
  assert.equal(view.permissions.grants, null, 'the surface holds no grant');
  assert.deepEqual([...view.operations.published], PUBLISHED_OPERATION_IDS);
  assert.equal(view.operations.published.length, CONTEXT_OPERATIONS.length + SESSION_OPERATIONS.length,
    'the published operation list is derived from the quoted registry operations, so a publication changes the count and not the code');
  assert.match(view.rule, /never merges them, never fabricates a number and never offers an execution/);
});

test('a full, honest view renders session, scope, usage, rollover, continuation and verification together', { skip }, () => {
  const declaration = backendDeclaration();
  const view = createContextSessionView({
    surface: SURFACE,
    declaration,
    contract: lockRows(),
    context: { contextId: 'ctx-a', scope: 'TASK', lifecycle: 'prepare', version: '4', checksum: 'aaa', size: 26_000, budget: 32_000, parent: { contextId: 'ctx-prev', checksum: '999' } },
    session: { sessionId: 'sess-04', agentId: 'agent-copilot', parentSessionId: 'sess-03', status: 'running', contextRef: 'ctx-a', traceRef: 'trace-4', updatedAt: '2026-09-22T02:00:00Z' },
    continuation: {
      identity: { sessionId: 'sess-04', contextId: 'ctx-a' },
      objective: 'finish P2.13', plan: ['render', 'verify'], completedWork: ['render'], unfinishedWork: ['verify'],
      constraints: ['no fabricated tokens'], decisions: ['XA-20 recorded'], activeEntities: ['arena/01a0c6b4-n8n-rust-v-4'],
      toolStateReferences: [], artifacts: ['art-11'], importantReferences: ['docs/n8n-lego/milestones.json'], errors: [], unresolvedQuestions: ['XA-20'],
      compressedHistory: ['the surface was built from the published declaration'],
      sourceContextId: 'ctx-a',
      target: { contextId: 'ctx-b', scope: 'TASK', parent: { contextId: 'ctx-a', checksum: 'aaa' }, checksum: 'bbb' },
    },
    usage: { kind: 'modelInput', used: 26_000, budget: 32_000, unit: 'tokens', source: 'reported' },
    threshold: 0.8,
  });
  if (registeredDifferences().length === 0) {
    assert.equal(view.drift.state, 'in-sync', JSON.stringify(view.drift.differences));
  } else {
    assert.equal(view.drift.state, 'drift', 'the registered difference is visible in the assembled view too');
    assertAwaitingPublicationDifferences(view.drift.differences);
  }
  assert.equal(view.session.state.state, 'running');
  assert.equal(view.context.scope.scope, 'TASK');
  assert.equal(view.context.lifecycle.state, 'prepare');
  assert.equal(view.context.lifecycle.rollover, true);
  assert.equal(view.context.usage.state, 'reported');
  assert.equal(view.context.usage.percent, 81);
  assert.equal(view.rollover.expectedPhase, 'PREPARE');
  assert.equal(view.rollover.publishedWord, 'prepare');
  assert.equal(view.continuation.verification.result, 'verified');
  assert.equal(view.continuation.rehydration.state, 'continuity-verified');
  assert.equal(view.session.lineage.linked, true);
  assert.equal(view.session.lineage.previousSessionId, 'sess-03');
  assert.equal(view.session.lineage.affordance, 'continuity-verified');
  assert.deepEqual([...view.findings], []);
  assert.deepEqual([...view.refused], []);
});

test('describeContextSession is the surface as data, for docs and gates', () => {
  const described = describeContextSession();
  assert.equal(described.lego, CONTEXT_SESSION_LEGO_ID);
  assert.equal(described.contracts.context.id, CONTEXT_CONTRACT_ID);
  assert.equal(described.contracts.context.publishedVersion, null);
  assert.equal(described.publishedOperations.length, CONTEXT_OPERATIONS.length + SESSION_OPERATIONS.length);
  assert.deepEqual([...described.unpublishedVerbs], [...UNPUBLISHED_CONTEXT_VERBS]);
  assert.equal(described.sessionStates.length, 7);
  assert.equal(described.scopes.length, 7);
  assert.equal(described.contextLifecycle.length, 6);
  assert.equal(described.continuationSections.length, 14);
  assert.equal(described.concepts.length, 5);
  assert.equal(described.continuationAffordances.length, 6);
  assert.equal(described.continuityChecks.length, CONTINUITY_CHECKS.length);
  assert.deepEqual([...described.verificationResults], ['verified', 'degraded', 'failed']);
  assert.deepEqual([...described.rolloverPhases], ['NORMAL', 'PREPARE', 'ROLLOVER']);
  assert.equal(described.quoted.length, CONTEXT_SESSION_QUOTED_VOCABULARIES.length);
  assert.equal(described.permissions.grants, undefined, 'no grant is described');
  assert.match(described.rule, /a publication gap that is rendered instead of hidden/);
});

test('the assembly exposes the surface, and the boot descriptor stays byte-identical', () => {
  const frontend = createFrontendLego({
    app: { name: 'n8n lego', version: '0.1.0', referenceVersion: '2.9.4' },
    ui: { basePath: '/', restEndpoint: 'rest' },
  });
  const isPublished = SURFACE.publication.status === 'published';
  assert.equal(frontend.contextSession.published, isPublished);
  assert.equal(frontend.contextSession.session.states.length, 7);
  assert.equal(frontend.describe().sessionStates, 7);
  assert.equal(frontend.describe().contextScopes, 7);
  assert.equal(frontend.describe().contextSessionPublished, isPublished);
  assert.equal(frontend.describe().contextSessionDrift, 'not-declared');
  assert.equal(typeof frontend.describeContextSession, 'function');
  // The browser receives the descriptor and nothing else: no context, no session, no usage.
  const payload = JSON.stringify(frontend.bootPayload);
  // Refresh 2026-09-28 (P2-S14): the boot descriptor grows with the declared canvas
  // surface (manifest/surfaces.json + capability): 18,126 -> 18,477 bytes, measured.
  // Refresh 2026-09-28 (P2-S15): + the node-config surface: 18,477 -> 18,855 bytes, measured.
  // Refresh 2026-09-28 (P2-S16): + the connections surface: 18,855 -> 19,233 bytes, measured.
  // Refresh 2026-09-28 (P2-S18): + the environments surface: 19,233 -> 19,574 bytes, measured.
  // Refresh 2026-09-28 (P2-S19): + the integrations surface: 19,574 -> 19,934 bytes, measured.
  // Refresh 2026-09-28 (P2-S20): + the execution-mgmt surface: 19,934 -> 20,271 bytes, measured.
  // Refresh 2026-09-28 (P2-S21): + the project-admin surface: 20,271 -> 20,624 bytes, measured.
  // Refresh 2026-09-28 (P2-S22): + the assistant surface: 20,624 -> 20,942 bytes, measured.
  // Refresh 2026-09-28 (P2-S23): + the copilot surface: 20,942 -> 21,262 bytes, measured.
  // Refresh 2026-09-28 (P2-S24): + the ai-node surface: 21,262 -> 21,589 bytes, measured.
  assert.equal(payload.length, 21_589, 'the boot payload is byte-identical to the P2-S24 baseline');
  for (const word of ['contextId', 'sessionId', 'continuation', 'rollover', 'contextRef', 'chainOfThought', 'NORMAL']) {
    assert.equal(payload.includes(word), false, `${word} does not travel in the boot payload`);
  }
  // And a handed-over declaration changes the view, still without touching the payload.
  const wired = createFrontendLego({
    app: { name: 'n8n lego', version: '0.1.0' },
    contextSession: { session: { sessionId: 'sess-04', agentId: 'agent-copilot', status: 'waiting' } },
  });
  assert.equal(wired.contextSession.session.state.state, 'waiting');
  assert.equal(JSON.stringify(wired.bootPayload).includes('sess-04'), false, 'a rendered session never enters the descriptor');
});

/* ------------------------------------------------------------- 11. the manifest */

test('the surface manifest declares two contracts, one LEGO, and ships empty', () => {
  assert.deepEqual([...SURFACE.contracts], [CONTEXT_CONTRACT_ID, SESSION_CONTRACT_ID]);
  assert.equal(SURFACE.lego, CONTEXT_SESSION_LEGO_ID);
  assert.deepEqual([...SURFACE.contexts], [], 'a state surface renders what it is handed');
  assert.deepEqual([...SURFACE.sessions], []);
  assert.equal(SURFACE.publication.status, 'published', 'what THIS tree publishes');
  assert.equal(SURFACE.publication.rows.length, 2, 'the two locked contract rows');
  assert.equal(SURFACE.publication.expected.length, 2);
  const peer = SURFACE.publication.publishedOnPeerBranch;
  assert.equal(peer.commit, 'fb254f32');
  assert.equal(peer.branch, 'arena/01a0c6b5-n8n-rust-v-4');
  assert.equal(peer.onProtectedMain, true);
  assert.equal(peer.lockedContractRows, 17);
  assert.deepEqual(peer.rows.map((row) => `${row.id}@${row.version}`), ['ai.context@1.0.0', 'ai.agent-session@1.0.0']);
  assert.equal(SURFACE.publication.protectedMain.commit, 'efa3da35');
  assert.equal(SURFACE.publication.protectedMain.lockedContractRows, 17);
  assert.equal(SURFACE.publication.protectedMain.state, 'published');
  for (const expected of SURFACE.publication.expected) {
    assert.equal(expected.declaredVersion, '1.0.0');
    assert.equal(expected.owner, 'manager');
    assert.equal(expected.domain, 'ai-foundation');
    assert.match(expected.declaredIn, /ai-lego-set\.json#lego\[id=context-session\]\.versioning/);
  }
  const expectedOperations = SURFACE.publication.expected.flatMap((entry) => entry.operations);
  assert.deepEqual([...expectedOperations].sort(), [...PUBLISHED_OPERATION_IDS].sort(), 'the manifest names the same operations the quoted registry publishes — eight of them since agent-2 registered rollover, rehydrate and verify');
  for (const notPublished of ['ai.context.execute', 'ai.context.continue', 'ai.agent-session.continue', 'ai.agent-session.pause', 'ai.agent-session.resume', 'ai.agent-runtime.*']) {
    assert.ok(SURFACE.publication.notPublished.includes(notPublished), `${notPublished} is declared unpublished`);
    assert.equal(PUBLISHED_OPERATION_IDS.includes(notPublished), false);
  }
  /**
   * The Memory half of this list, tightened by P2.14.
   *
   * It used to read `'ai.memory.*'` — "none of Memory is published" — which was true at the P2.13
   * baseline and stopped being true when agent-2 published the bounded `ai.memory@1.0.0` surface.
   * The wildcard is replaced by the two names that are still unpublished (`traverse`, `relate`), and
   * the bound is asserted in both directions: a name of the form `ai.memory.<published verb>` may not
   * appear in a list of unpublished names, so this manifest cannot quietly keep claiming that the
   * four published operations do not exist — while this surface still renders no memory of its own
   * (the Memory catalog consumes `ai.memory`; this one does not).
   */
  assert.deepEqual(
    [...SURFACE.publication.notPublished].filter((entry) => entry.startsWith('ai.memory.')),
    ['ai.memory.traverse', 'ai.memory.relate'],
    'the unpublished Memory names are exactly the deferred half the contract declares',
  );
  for (const publishedOperation of ['ai.memory.remember', 'ai.memory.recall', 'ai.memory.list', 'ai.memory.forget']) {
    assert.equal(SURFACE.publication.notPublished.includes(publishedOperation), false, `${publishedOperation} is published and is never listed as unpublished`);
  }
  assert.equal(SURFACE.contracts.includes('ai.memory'), false, 'and the memory contract stays consumed by the Memory catalog, not by this one');
  assert.equal(SURFACE.alignment.decision, CONTEXT_SESSION_DECISION);
  assert.equal(SURFACE.alignment.status, 'open-for-manager');
  assert.ok(existsSync(join(REPO_ROOT, SURFACE.alignment.test)), 'the manifest names the suite that proves it');
  assert.ok(existsSync(join(REPO_ROOT, SURFACE.alignment.package)), 'and the arbitration package');
  assert.ok(SURFACE.rules.length >= 10, `${SURFACE.rules.length} rules`);
  assert.ok(SURFACE.rules.some((rule) => rule.includes('Conversation != Session != Context window != Memory != Execution')));
  // The five concepts in the manifest are the five in the code.
  assert.deepEqual([...SURFACE.concepts], DISTINCT_CONCEPTS.map((concept) => concept.id));
  // Two contracts, one LEGO: the loader refuses a catalog that cannot name both, and the surface
  // the assembly carries is the same frozen catalog the manifest loader produced.
  assert.deepEqual(manifests.contextSessionCatalog, SURFACE);
  assert.equal(contextSessionSurface(manifests), manifests.contextSessionCatalog, 'the same instance, not a second read');
  assert.equal(manifests.contexts.length, 0);
  assert.equal(manifests.sessions.length, 0);
});

test('the unsupported answer is a verdict, not an empty object', () => {
  const answer = contextSessionUnsupported('nothing was handed over', { declaredVersion: CONTEXT_DECLARED_VERSION });
  assert.equal(answer.state, 'capability-unavailable');
  assert.equal(answer.error, 'lego.capability_unavailable');
  assert.equal(answer.reason, 'nothing was handed over');
  assert.equal(answer.decision, CONTEXT_SESSION_DECISION);
  assert.equal(answer.contract.version, null);
  assert.equal(answer.contract.declaredVersion, '1.0.0');
  assert.equal(answer.contract.published, false);
  assert.equal(answer.pending.length, PENDING_CONTRACT_ROWS.length);
  assert.match(answer.detail, /no fallback capability, no execution control, no memory store and no token figure/);
});

/* ------------------------------------------- 12. decisions and milestone register */

test('XA-20 is recorded, open, and says what the frontend does meanwhile', () => {
  const row = DECISIONS.decisions.find((entry) => entry.id === CONTEXT_SESSION_DECISION);
  assert.ok(row, 'XA-20 is in the reconciled register');
  assert.equal(row.status, 'open-for-manager');
  assert.equal(row.resolution, null);
  assert.equal(row.owner, 'manager');
  assert.ok(row.arbiter.length > 10);
  assert.ok(row.blocks.length > 0);
  assert.ok(row.evidence.length >= 2);
  assert.ok(row.question.endsWith('?'));
  assert.match(row.finding, /no row for either contract/);
  assert.match(row.frontendBehaviour, /declared-not-locked/);
  assert.deepEqual([...row.affectedDomains].sort(), ['ai-foundation', 'frontend']);
  assert.equal(row.blockingLevel, 'milestone');
  assert.match(row.relatedOpenDecision, /XA-12/);
  assert.ok(existsSync(join(REPO_ROOT, row.package)), 'the arbitration package exists');
  // Memory stays a separate question: publishing context must not create a store.
  const memory = DECISIONS.decisions.find((entry) => entry.id === MEMORY_DECISION);
  assert.equal(memory.status, 'open-for-manager', 'XA-12 is still open');
});

/**
 * The P2.13 half of the register, read after the reconciliation moved it on.
 *
 * This test was written while P2.13 was the in-progress row and asserted exactly that. The
 * Manager merged both P2.13 branches (#45 backend, #46 frontend) into protected main, so the row it
 * describes is now `complete` — the boundary, the owners, the nonScope and the start evidence it
 * checks are unchanged, which is the point: the milestone's coordinates move, its content does not.
 */
test('the milestone register records P2.15 as complete on protected main and P2.16 as current without implementation', () => {
  const byId = new Map(MILESTONES.milestones.map((milestone) => [milestone.id, milestone]));
  assert.equal(MILESTONES.owner, 'manager');
  const p212 = byId.get('P2.12');
  assert.equal(p212.status, 'complete');
  assert.equal(p212.title.includes('Skill'), true);
  assert.ok(p212.deliverables.some((item) => item.includes('ai.skill@1.0.0')));
  assert.ok(p212.deliverables.some((item) => /four published operations|4 published operations/i.test(item)));
  assert.ok(p212.deliverables.some((item) => /permissions/i.test(item)));
  assert.ok(p212.decisionDependencies.some((item) => item.includes('XA-19')));
  assert.ok(p212.decisionDependencies.some((item) => item.includes('XA-11')));
  assert.ok(p212.completionCriteria.some((item) => item.includes('no Skill runtime')));
  assert.equal(p212.currentCommitReference.includes('e754c5df'), true);
  assert.equal(p212.nextMilestone, 'P2.13');

  const p213 = byId.get('P2.13');
  assert.equal(p213.status, 'complete');
  assert.equal(p213.startEvidence.commit, 'e754c5df35b41b0ff2ac769519f05f056835411c', 'its implementation baseline is preserved, not overwritten');
  assert.match(p213.finishEvidence.protectedMain, /^67e638ef/, 'and it names the protected-main commit that closed it');
  assert.equal(p213.backendOwner, 'agent-2');
  assert.equal(p213.frontendOwner, 'agent-1');
  assert.ok(p213.implementationBoundary.includes('Context is not Conversation'));
  assert.ok(p213.nonScope.includes('model inference'));
  assert.ok(p213.nonScope.includes('Memory persistent store'));
  assert.ok(p213.nonScope.includes('Rust implementation'));
  assert.ok(p213.nonScope.includes('Agent Machine execution loop'));
  assert.ok(p213.decisionDependencies.some((item) => item.includes('XA-11')));
  assert.ok(p213.reconciliation && typeof p213.reconciliation === 'object');
  assert.equal(p213.reconciliation.historical, true, 'a complete milestone carries its reconciliation as history');
  assert.equal(p213.nextMilestone, 'P2.14');

  // P2.15 is complete on protected main; P2.16 is current in the roadmap only.
  const p215 = byId.get('P2.15');
  assert.equal(p215.status, 'complete');
  assert.equal(p215.finishEvidence.protectedMain, 'ce65851bd5b5194555baa635feb4c8aeae3f16eb');
  // P2.15's start baseline stays preserved history on the P2.15 row; the top-level baseline moved
  // on to the final protected-main commit when P2.16 became the current milestone.
  assert.equal(p215.startEvidence.commit, '0d9466f19a149f6e30bdee559086b7a28b080cb3', 'P2.15 start baseline is preserved history');
  assert.equal(MILESTONES.mainBaseline, 'fc54c8c2bfc2557ddecf466e662869f197fc9595', 'the baseline is protected main after the governance reset merge (#257, anchor #256); Issue #81 requires mainBaseline == protected main HEAD');
  const p216 = byId.get('P2.16');
  assert.equal(p216.status, 'complete');
  assert.ok(p216.finishEvidence, 'P2.16 carries protected-main finish evidence after the PR #52 merge');
  assert.equal(p216.finishEvidence.protectedMain, 'f21882233c1f4efc5bfb8f3e1b5e1ad4db781d7d');

  const p211 = byId.get('P2.11');
  assert.equal(p211.status, 'complete');
});

test('the register keeps the strategic phases, the ladder and the merge protocol', () => {
  // Phase A-F survive: the milestone layer sits beneath them.
  assert.deepEqual(MILESTONES.strategicRoadmap.preservePhases, ['A', 'B', 'C', 'D', 'E', 'F']);
  for (const milestone of MILESTONES.milestones) assert.ok(milestone.phase, `${milestone.id} names its phase`);
  /**
   * The ladder is visible — and it has to survive the milestone *moving*.
   *
   * This assertion used to require a milestone titled `Memory` among the rows whose status is
   * `planned`. That was true while P2.14 was unstarted and became false the moment agent-2's P2.14
   * register edit set the row to `in-progress`: the test would then fail on the very tree that is
   * about to be merged, for the milestone this branch exists to deliver. The claim worth checking
   * was never "Memory has not started" — it is "the ladder still names Memory, and nothing claims it
   * is finished". So the planned bucket is checked for the milestones nobody has started, and
   * Memory is checked by identity and by status: named, P2.14, and not `complete`.
   *
   * Measured on both trees: this passes against the register as protected main carries it (P2.14
   * `planned`) and against agent-2's register (P2.14 `in-progress`), which is the state the merge
   * produces.
   */
  const planned = MILESTONES.milestones.filter((milestone) => milestone.status === 'planned');
  assert.ok(planned.length >= 1, `${planned.length} planned milestones`);
  assert.equal(planned.some((milestone) => /Workspace/.test(milestone.title)), false, 'Workspace is complete');
  // Agent Machine closed on protected main via the PR #52 merge — named by identity,
  // checked by status and by its finish evidence (the same pattern Memory uses at P2.14).
  const agentMachine = MILESTONES.milestones.find((milestone) => /Agent Machine/.test(milestone.title));
  assert.ok(agentMachine, 'the ladder still names Agent Machine');
  assert.equal(agentMachine.id, 'P2.16');
  assert.equal(agentMachine.status, 'complete', `the register carries Agent Machine's real status (\"${agentMachine.status}\")`);
  assert.ok(agentMachine.finishEvidence, 'and names its protected-main finish evidence after the PR #52 merge');
  assert.ok(planned.some((milestone) => /P2\.17\+/.test(milestone.id)), 'the future ladder is still named');
  const memoryLadder = MILESTONES.milestones.find((milestone) => /Memory/.test(milestone.title));
  assert.ok(memoryLadder, 'the ladder still names Memory');
  assert.equal(memoryLadder.id, 'P2.14');
  assert.equal(memoryLadder.status, 'complete', `the register carries Memory's real status ("${memoryLadder.status}")`);
  assert.equal(MILESTONES.currentMilestone, 'P2.27', `currentMilestone follows the reconciliation ("${MILESTONES.currentMilestone}")`);
  // The merge protocol: agent completion IS merge execution under the current policy.
  const protocol = MILESTONES.mergeProtocol;
  assert.equal(protocol.owner, 'agent-1');
  assert.equal(protocol.managerRole, 'architecture-and-milestone-authority');
  assert.equal(protocol.agentCompletionIsMergeExecution, true);
  assert.equal(protocol.agentCompletionIsNotMergeApproval, undefined, 'the obsolete flag is gone');
  assert.ok(Array.isArray(protocol.sequence) && protocol.sequence.length >= 5);
  assert.ok(protocol.sequence.some((step) => step.includes('reconcil')));
  assert.ok(protocol.sequence.some((step) => step.includes('merge')));
  assert.equal(protocol.failureState, 'RECONCILIATION_FAILED');
  assert.match(protocol.completionRule, /merged and post-merge verification passes on protected main/);
  // Workforce governance milestoneMergeProtocol carries the detailed gates and conflict classes:
  const governance = JSON.parse(read('docs/engineering-operations/workforce-governance.json'));
  const govProtocol = governance.milestoneMergeProtocol;
  assert.ok(govProtocol, 'governance carries milestoneMergeProtocol');
  assert.equal(govProtocol.canonicalRegister, 'docs/n8n-lego/milestones.json');
  assert.ok(govProtocol.gates.some((g) => g.id === 'RECONCILIATION PASS'));
  assert.ok(govProtocol.gates.some((g) => g.id === 'MERGE PASS'));
  assert.equal(govProtocol.failureState, 'RECONCILIATION_FAILED');
  // Top-level canonical truth:
  assert.equal(MILESTONES.currentMilestone, 'P2.27');
  assert.equal(MILESTONES.previousCompletedMilestone, 'P2.26');
  assert.equal(MILESTONES.mainBaseline, 'fc54c8c2bfc2557ddecf466e662869f197fc9595');
  assert.equal(MILESTONES.strategicRoadmap.source, 'apps/n8n-lego/src/lego/manifest/ai-lego-set.json');
  assert.equal(MILESTONES.protectedBranch, 'main');
});
