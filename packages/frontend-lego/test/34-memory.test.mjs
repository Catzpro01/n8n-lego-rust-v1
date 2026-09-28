/**
 * The Memory surface (P2.14) — `ai.memory@1.0.0` consumed, never redefined.
 *
 * `ai.memory` is published by agent-2 and owned by the backend; this package is its first consumer.
 * What is proven here, in the order the milestone defines it:
 *
 *   1. **The manifest.** `manifest/memory.json` consumes exactly one contract, names the LEGO it
 *      belongs to (`memory`, index 4 of the AI set, phase B — not a sub-LEGO of `context-session`)
 *      and ships empty, because a record surface renders what it is handed.
 *   2. **The vocabulary.** Nine sets are quoted with contract, version, owner, file and declaration,
 *      verbatim: 5 scopes, 6 kinds, 5 retentions, 13 fields, 2 lifecycle states, 10 graph nodes,
 *      11 graph edges, 4 operations and 2 permission words. The words the contract does NOT publish
 *      (embedding, similarity, relevance score, retention timer) have no set at all, so a screen
 *      cannot render them even by accident.
 *   3. **The alignment.** Against the tree that publishes Memory the quote is compared for real, in
 *      both directions. Against protected main @ `67e638ef`, which publishes no `ai.memory` row, the
 *      comparison is announced as a bounded non-comparison instead of a pass — and the surface
 *      reports `declared-not-locked` and renders no version.
 *   4. **States.** Four list states stay four (`rendered` / `empty` / `not-handed-over` / `refused`),
 *      because `empty` and `not-handed-over` look identical on screen and mean opposite things.
 *      Persistence has exactly three words; availability has its four; a record has an origin or
 *      says it has none.
 *   5. **The refusals.** No fabricated record, no persistence claim, no provider connected, no
 *      retrieval, no ranking, no retention countdown, no write, no forget, no restore, no transcript,
 *      no context payload, no session state, no secret — and no execution affordance.
 *
 * Backend-tree convention (same as `29-alignment.test.mjs`): the comparison reads
 * `apps/n8n-lego/src/lego/**` and **skips with a stated reason** while that tree publishes no
 * Memory contract, unless `N8N_BACKEND_LEGO_ROOT` is set — in which case a missing declaration is a
 * failure, never a skip. The self-consistency halves always run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFERRED_MEMORY_OPERATIONS,
  DISTINCT_CONCEPTS,
  FORBIDDEN_MEMORY_FIELDS,
  FORBIDDEN_MEMORY_KEY_PATTERN,
  MEMORY_AFFORDANCES,
  MEMORY_CONTRACT_ID,
  MEMORY_CONTENT_LIMIT_BYTES,
  MEMORY_DECLARED_VERSION,
  MEMORY_DECLARATION_SOURCE,
  MEMORY_ERROR_CODES,
  MEMORY_FIELDS,
  MEMORY_FORBIDDEN_IMPLICATIONS,
  MEMORY_GRAPH_EDGES,
  MEMORY_GRAPH_NODES,
  MEMORY_KINDS,
  MEMORY_LEGO_ID,
  MEMORY_LIFECYCLE,
  MEMORY_LIST_LIMIT,
  MEMORY_LIST_ORDERING,
  MEMORY_LIST_STATES,
  MEMORY_MODELING_DECISION,
  MEMORY_OPERATION_IDS,
  MEMORY_OPERATIONS,
  MEMORY_ORIGINS,
  MEMORY_PERMISSIONS,
  MEMORY_PERSISTENCE_STATES,
  MEMORY_PHASE,
  MEMORY_QUOTED_VOCABULARIES,
  MEMORY_REFERENCE_FIELDS,
  MEMORY_REFERENCE_LIMIT,
  MEMORY_RETENTIONS,
  MEMORY_SCOPES,
  MEMORY_SEPARATION,
  MEMORY_SURFACE_MODULE,
  MEMORY_UNSUPPORTED_ERROR,
  MemoryError,
  VOCABULARIES,
  LOCAL_VOCABULARIES,
  assertDistinctConcepts,
  assertMemoryIsNotContext,
  createFrontendLego,
  createMemoryView,
  describeMemory,
  memoryDrift,
  memoryKind,
  memoryKinds,
  memoryLifecycle,
  memoryLifecycleState,
  memoryList,
  memoryOrigin,
  memoryPersistence,
  memoryPublication,
  memoryRecallResult,
  memoryRetention,
  memoryRetentions,
  memoryScope,
  memoryScopeLadder,
  memoryUnsupported,
  scanForbiddenMemoryKeys,
  validateMemoryRecord,
  vocabularyOf,
} from '../index.mjs';
import { PACKAGE_ROOT, loadManifests, memorySurface } from '../src/manifests.mjs';

const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');
const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const DEFAULT_BACKEND = join(REPO_ROOT, 'apps', 'n8n-lego', 'src', 'lego');
const BACKEND = process.env.N8N_BACKEND_LEGO_ROOT ?? DEFAULT_BACKEND;
const overridden = process.env.N8N_BACKEND_LEGO_ROOT !== undefined;
const CONTRACT_LOCK = join(BACKEND, 'contracts', 'contract-lock.json');
const MEMORY_MANIFEST = join(BACKEND, 'manifest', 'memory.json');

const lockRows = () => {
  if (!existsSync(CONTRACT_LOCK)) return [];
  const lock = JSON.parse(readFileSync(CONTRACT_LOCK, 'utf8'));
  return Array.isArray(lock) ? lock : (lock.rows ?? lock.contracts ?? []);
};
const memoryRow = () => lockRows().find((row) => (row.id ?? row.contract) === MEMORY_CONTRACT_ID) ?? null;
/** A Memory contract is *published* when the tree carries both halves: the lock row and the manifest. */
const publishedThere = existsSync(MEMORY_MANIFEST) && memoryRow() !== null;
const why = overridden
  ? `N8N_BACKEND_LEGO_ROOT is set but ${BACKEND} publishes no Memory contract (no ai.memory row in ${CONTRACT_LOCK} and no manifest/memory.json)`
  : 'the pointed-at tree does not publish ai.memory yet (protected main @ 67e638ef::17 lock rows, no memory row, no manifest/memory.json) — the comparison runs against the tree that does, or after the merge';
const skip = publishedThere || overridden ? false : why;

/** Reads a declaration from the POINTED-AT tree, never from this branch's copy of it. */
const backendJson = (relative) => JSON.parse(readFileSync(join(BACKEND, relative), 'utf8'));

const SURFACE = memorySurface();
const DECISIONS = readJson('docs/n8n-lego/decisions/cross-agent-decisions.json');
const MILESTONES = readJson('docs/n8n-lego/milestones.json');
const decisionRow = (id) => DECISIONS.decisions.find((decision) => decision.id === id) ?? null;

/** One record in the shape the contract publishes, valid unless a field is overridden. */
const record = (overrides = {}) => ({
  memoryId: 'mem-0001',
  scope: 'PROJECT',
  scopeOwner: 'proj-7',
  kind: 'decision',
  retention: 'IMPORTANT',
  content: { summary: 'the bounded four-operation surface was chosen' },
  references: [{ id: 'dec-1', relation: 'decided_by', kind: 'decision' }],
  provenance: { createdBy: 'agent-2', source: 'p2.14' },
  version: 1,
  size: 96,
  checksum: 'a'.repeat(64),
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
  ...overrides,
});

/* ------------------------------------------------------------------ 1. the manifest */

test('the Memory catalog consumes exactly one contract, names its LEGO, and ships no records', () => {
  assert.deepEqual([...SURFACE.contracts], [MEMORY_CONTRACT_ID], 'Memory is one LEGO with one contract');
  assert.equal(SURFACE.lego, MEMORY_LEGO_ID);
  assert.equal(SURFACE.phase, MEMORY_PHASE);
  assert.deepEqual([...SURFACE.records], [], 'a record surface renders what it is handed');
  assert.deepEqual([...SURFACE.concepts], ['context', 'session', 'memory', 'execution'], 'four concepts, and Memory is one of them');
  assert.match(SURFACE.description, /Memory is ONE LEGO/);
  assert.match(SURFACE.description, /not a sub-LEGO of `context-session`/);
  assert.equal(SURFACE.rules.length, 13, 'thirteen rules, and every one is a sentence a reviewer can check');
  assert.match(SURFACE.rules.join(' '), /Memory survives context replacement/);
  assert.match(SURFACE.description, /not a sixteenth top-level LEGO/);
  assert.match(SURFACE.description, /`Context` is what is loaded now and can be replaced/);
  // The declaration the catalog says it consumes, and the two neighbours it does not consume.
  assert.equal(SURFACE.declarationSource.memory.file, MEMORY_DECLARATION_SOURCE.file);
  assert.equal(SURFACE.declarationSource.memory.owner, MEMORY_DECLARATION_SOURCE.owner);
  assert.match(SURFACE.declarationSource.lego.path, /lego#id=memory/);
  assert.match(SURFACE.declarationSource.capabilities.path, /capabilities\[id=ai\.memory\]/);
  // The manifests loader validates the catalog at load time, so a broken one cannot boot.
  assert.equal(loadManifests().memoryCatalog.contracts.length, 1);
  assert.equal(memorySurface(loadManifests()).records.length, 0);
});

test('the catalog says what the surface may render, and refuses the rest', () => {
  const may = ['publicationState', 'memoryList', 'memoryEntry', 'memoryScope', 'memoryKind', 'memoryRetention'];
  for (const flag of [...may, 'memoryLifecycle', 'memoryProvenance', 'memoryReferences', 'memoryIntegrityEnvelope',
    'persistenceState', 'separationFromContext', 'emptyResultState', 'degradedState', 'failureState', 'pendingPublication']) {
    assert.equal(SURFACE.rendering[flag], true, `${flag} is a fact the surface renders`);
  }
  for (const flag of ['fabricatedRecords', 'persistenceClaim', 'providerConnectedClaim', 'vectorSearch', 'relevanceScore',
    'retentionCountdown', 'memoryDump', 'contextPayload', 'sessionState', 'transcript', 'executionAffordance',
    'writeAffordance', 'deleteAffordance', 'restoreAffordance']) {
    assert.equal(SURFACE.rendering[flag], false, `${flag} is refused by the catalog itself`);
  }
});

/* ------------------------------------------------------------------ 2. the vocabulary */

test('nine sets are quoted with provenance — and no word is coined here', () => {
  assert.deepEqual([...MEMORY_QUOTED_VOCABULARIES], [
    'memoryScope', 'memoryKind', 'memoryRetention', 'memoryField', 'memoryLifecycle',
    'memoryOperation', 'memoryPermission', 'memoryGraphNode', 'memoryGraphEdge',
  ]);
  const expected = { memoryScope: 5, memoryKind: 6, memoryRetention: 5, memoryField: 13, memoryLifecycle: 2, memoryOperation: 4, memoryPermission: 2, memoryGraphNode: 10, memoryGraphEdge: 11 };
  for (const [id, size] of Object.entries(expected)) {
    const set = vocabularyOf(id);
    assert.equal(set.values.length, size, `${id} carries ${size} values`);
    assert.ok(set.values.length > 0, `${id} carries at least one value`);
    assert.equal(set.provenance.contract.id, MEMORY_CONTRACT_ID, `${id} names ai.memory`);
    assert.equal(set.provenance.contract.version, MEMORY_DECLARED_VERSION, `${id} names the version the declaration claims`);
    assert.equal(set.provenance.contract.owner, 'manager', `${id} names the owner`);
    assert.ok(String(set.provenance.file).includes('memory.json') || String(set.provenance.file).includes('ai-lego-set.json'), `${id} names the file it was read from`);
    assert.ok((set.provenance.symbol ?? set.provenance.path).length > 0, `${id} names the declaration it read`);
    assert.equal(set.provenance.publishedOn.branch, 'arena/01a0c90d-n8n-rust-v-4', `${id} records where the publication is visible`);
    assert.equal(set.provenance.publishedOn.lockRow, `${MEMORY_CONTRACT_ID}@1.0.0`);
    assert.equal(set.openDecision.decision, 'XA-12', `${id} names the decision that owns the deferred half`);
    assert.equal(set.publicationPending, undefined, `${id} is published, so it has nothing pending`);
  }
  // The values themselves, quoted verbatim.
  assert.deepEqual([...MEMORY_SCOPES], ['GLOBAL', 'PROJECT', 'WORKFLOW', 'AGENT', 'SESSION']);
  assert.deepEqual([...MEMORY_KINDS], ['note', 'decision', 'artifact', 'task', 'execution', 'reference']);
  assert.deepEqual([...MEMORY_RETENTIONS], ['EPHEMERAL', 'WORKING', 'IMPORTANT', 'DURABLE', 'PERMANENT']);
  assert.deepEqual([...MEMORY_LIFECYCLE], ['active', 'forgotten']);
  assert.deepEqual([...MEMORY_GRAPH_NODES], ['project', 'workflow', 'node', 'execution', 'agent', 'session', 'decision', 'evidence', 'artifact', 'task']);
  assert.deepEqual([...MEMORY_GRAPH_EDGES], ['depends_on', 'caused', 'derived_from', 'supports', 'contradicts', 'implements', 'belongs_to', 'delegated_to', 'decided_by', 'observed_in', 'related_to']);
  assert.equal(MEMORY_FIELDS.length, 13);
  assert.deepEqual([...MEMORY_REFERENCE_FIELDS], ['id', 'relation', 'kind']);
  assert.equal(MEMORY_REFERENCE_LIMIT, 32);
  assert.equal(MEMORY_CONTENT_LIMIT_BYTES, 64 * 1024);
  assert.equal(QUOTED_SOURCE_FILE(), 'apps/n8n-lego/src/lego/manifest/memory.json');
});

/** The file every memory set says it read — one file, quoted nine times, not nine copies. */
function QUOTED_SOURCE_FILE() {
  const files = new Set(MEMORY_QUOTED_VOCABULARIES.map((id) => vocabularyOf(id).provenance.file));
  assert.equal(files.size, 1, 'the nine sets come from one declaration');
  return [...files][0];
}

test('the local words are declared by the module the lock cites, and the two halves agree', () => {
  const local = LOCAL_VOCABULARIES.filter((set) => String(set.id).startsWith('memory'));
  assert.deepEqual(local.map((set) => set.id).sort(), ['memoryAffordance', 'memoryListState', 'memoryOrigin', 'memoryPersistenceState', 'memoryRefusal']);
  for (const set of local) {
    assert.equal(set.mapsTo, null, `${set.id} maps to no canonical set — it is this surface's own word`);
    assert.equal(set.decision, 'XA-12', `${set.id} names the decision that owns it`);
    assert.equal(set.provenance.file, 'packages/frontend-lego/src/memory.mjs');
    // The lock quotes a symbol; the symbol has to exist, or the citation points at nothing.
    const source = read(set.provenance.file);
    assert.ok(new RegExp(`export (const|function) ${set.provenance.symbol}\\b`).test(source),
      `${set.id}: ${set.provenance.symbol} is exported by ${set.provenance.file}`);
  }
  // And the declaration and the quote say the same thing, in both directions.
  assert.deepEqual([...vocabularyOf('memoryListState').values], [...MEMORY_LIST_STATES]);
  assert.deepEqual([...vocabularyOf('memoryPersistenceState').values], [...MEMORY_PERSISTENCE_STATES]);
  assert.deepEqual([...vocabularyOf('memoryOrigin').values], [...MEMORY_ORIGINS]);
  assert.deepEqual([...vocabularyOf('memoryAffordance').values], [...MEMORY_AFFORDANCES.allowed]);
  assert.deepEqual([...vocabularyOf('memoryRefusal').values], [...MEMORY_FORBIDDEN_IMPLICATIONS]);
  assert.equal(vocabularyOf('memoryRefusal').values.length, 14);
});

/* ------------------------------------------------------- 3. operations and permissions */

test('operations are quoted verbatim and never re-qualified, and the deferred half is named', () => {
  assert.deepEqual([...MEMORY_OPERATION_IDS], ['memory.remember', 'memory.recall', 'memory.list', 'memory.forget']);
  assert.deepEqual([...MEMORY_OPERATIONS], [...MEMORY_OPERATION_IDS]);
  assert.deepEqual([...DEFERRED_MEMORY_OPERATIONS], ['traverse', 'relate']);
  // The spelling is the published one: `memory.<verb>`, not a bare verb and not `ai.memory.<verb>`.
  const joined = [...MEMORY_OPERATION_IDS, ...MEMORY_OPERATIONS].join(' ');
  assert.match(joined, /^memory\./);
  assert.equal(joined.includes('ai.memory.'), false, 'a re-qualified operation name would be a second API');
  assert.equal(MEMORY_OPERATION_IDS.includes('memory.traverse'), false);
  assert.equal(DEFERRED_MEMORY_OPERATIONS.some((name) => MEMORY_OPERATION_IDS.includes(name)), false);
  // Not in anything the surface produces either — prose that forbids a spelling may quote it, a
  // rendered value may not: `describeMemory()` and the view are the surface's whole output.
  for (const probe of [JSON.stringify(describeMemory()), JSON.stringify(createMemoryView({ result: [record()], record: { record: null } }))]) {
    assert.equal(/ai\.memory\.[a-z]/.test(probe), false, 'nothing rendered re-qualifies a published operation name');
  }
  // The one place a prefixed name IS correct is the list of things this surface must never render:
  // `publication.notPublished` names `ai.memory.traverse` / `ai.memory.relate` as future stages.
  assert.deepEqual([...SURFACE.publication.notPublished], [
    'ai.memory.traverse',
    'ai.memory.relate',
    'ai.memory.remember.execute',
    'ai.context.memory',
    'ai.agent-session.memory',
  ], 'the names this surface must never render, pinned as data');
  // Nothing calls one, and nothing offers one.
  const view = createMemoryView();
  assert.deepEqual([...view.operations.published], [...MEMORY_OPERATION_IDS]);
  assert.deepEqual([...view.operations.deferred], [...DEFERRED_MEMORY_OPERATIONS]);
  assert.deepEqual([...view.operations.offered], [], 'no operation is offered');
  assert.match(view.operations.rule, /may not offer/);
  const refusals = Object.values(MEMORY_AFFORDANCES.forbidden).join(' ');
  for (const deferred of DEFERRED_MEMORY_OPERATIONS) {
    assert.equal(MEMORY_AFFORDANCES.forbidden[deferred].length > 40, true, `${deferred} is refused with a reason`);
    assert.match(refusals, new RegExp(deferred), `${deferred} is named as a future stage, not offered`);
  }
  assert.match(MEMORY_AFFORDANCES.forbidden.search, /no search/);
  assert.match(MEMORY_AFFORDANCES.forbidden.embeddings, /vector store/);
  assert.equal(MEMORY_FORBIDDEN_IMPLICATIONS.includes('relevance-ranking'), true);
  assert.equal(MEMORY_FORBIDDEN_IMPLICATIONS.includes('vector-search'), true);
});

test('permissions are quoted as requirements of backend operations, never as grants', () => {
  assert.deepEqual([...MEMORY_PERMISSIONS], ['ai:memory:read', 'ai:memory:write']);
  assert.equal(vocabularyOf('memoryPermission').provenance.path, 'permissions');
  const published = vocabularyOf('aiPermission').values;
  for (const permission of MEMORY_PERMISSIONS) {
    assert.equal(published.includes(permission), true, `${permission} is a word the ai-foundation registry publishes`);
  }
  const view = createMemoryView();
  assert.deepEqual([...view.permissions.required], [...MEMORY_PERMISSIONS]);
  assert.equal(view.permissions.grants, null, 'the surface holds no grant and gives none');
  assert.equal(MEMORY_PERMISSIONS.includes('ai:memory:admin'), false);
  assert.match(MEMORY_AFFORDANCES.forbidden.grantPermission, /never a grant/);
  assert.equal(MEMORY_FORBIDDEN_IMPLICATIONS.includes('permission-grant'), true);
});

/* -------------------------------------------------------------- 4. the real comparison */

test('the quoted words are the words the pointed-at tree declares', { skip }, () => {
  const declaration = {
    memory: JSON.parse(readFileSync(MEMORY_MANIFEST, 'utf8')),
    lego: backendJson('manifest/ai-lego-set.json').lego.find((entry) => entry.id === MEMORY_LEGO_ID),
    capabilities: [backendJson('manifest/domains.json').domains
      .find((entry) => entry.id === 'ai-foundation').capabilities
      .find((entry) => entry.id === MEMORY_CONTRACT_ID)],
  };
  // The file is read from the pointed-at root, not from this branch's copy — the path is built the
  // same way the sets build theirs.
  const declaredUnder = (path) => path.split('.').reduce((cursor, key) => cursor?.[key], declaration.memory);
  const paths = {
    memoryScope: declaredUnder('scopes'),
    memoryKind: declaredUnder('kinds'),
    memoryRetention: declaredUnder('retention'),
    memoryField: declaredUnder('fields'),
    memoryLifecycle: declaredUnder('lifecycle.states'),
    memoryOperation: declaredUnder('operations').map((operation) => operation.name),
    memoryPermission: declaredUnder('permissions'),
    memoryGraphNode: declaredUnder('graph.nodes'),
    memoryGraphEdge: declaredUnder('graph.edges'),
  };
  assert.deepEqual(Object.keys(paths).sort(), [...MEMORY_QUOTED_VOCABULARIES].sort(), 'every quoted set is compared, and nothing else is');
  for (const [id, values] of Object.entries(paths)) {
    assert.deepEqual([...vocabularyOf(id).values], [...values],
      `${id} is verbatim: missing ${JSON.stringify([...vocabularyOf(id).values].filter((value) => ![...values].includes(value)))}, unquoted ${JSON.stringify([...values].filter((value) => ![...vocabularyOf(id).values].includes(value)))}`);
  }
  // The registry half: the capability list and the permission words the declaration publishes.
  assert.equal(vocabularyOf('aiFoundationCapability').values.includes(MEMORY_CONTRACT_ID), true, `${MEMORY_CONTRACT_ID} is a registered ai-foundation capability`);
  assert.deepEqual([...declaration.capabilities[0].permissions].sort(), [...MEMORY_PERMISSIONS].sort(), 'the capability publishes the two quoted permissions and no more');
  assert.deepEqual([...declaration.capabilities[0].operations].map((operation) => operation.name), [...MEMORY_OPERATION_IDS], 'and the four published operations');
  // The lock row: version, owner, domain, surface module and tests.
  const row = memoryRow();
  assert.equal(row.version, MEMORY_DECLARED_VERSION);
  assert.equal(row.owner, 'manager');
  assert.equal(row.domain, 'ai-foundation');
  assert.equal(row.status, 'implemented');
  assert.equal(String(MEMORY_SURFACE_MODULE).endsWith(row.surface[0]), true, 'the surface module is the one the lock names');
  assert.deepEqual([...row.operations], [...MEMORY_OPERATION_IDS], 'the lock publishes the four operations');
  assert.deepEqual([...row.permissions], [...MEMORY_PERMISSIONS], 'and the two permission words');
  assert.ok(row.tests.includes('apps/n8n-lego/test/lego-memory.test.mjs'), 'and names the backend suite that proves it');
  // P9.1 envelope + P3 optimizer are merged; P9.2 structured-log adds row 42.
  assert.equal(lockRows().length, 100, 'the thirty-two post-protected rows through P3 Slice A workflow.graph plus P3 Slice D execution.frontier (thirty-fourth) plus P3 Slice E execution.state-stream (thirty-fifth) plus P3 Slice H workflow.dna (thirty-sixth) plus P3 Slice J execution.ir (thirty-seventh) plus P3 Slice L compatibility.oracle (thirty-eighth) plus P3 Slice M execution.guard (thirty-ninth) plus P3 Slice K execution.optimizer (forty-first) are added to the seventeen protected-main rows — P6.1 adds node.registry@0.1.0; P6.2 adds registry.compiler@0.1.0; P6.3 adds package.transaction@0.1.0; P6.4 adds registry.closure@0.1.0; P6.5 adds node.resolution@0.1.0; P6.6 adds runtime.lease@0.1.0; P6.7 adds node.residency@0.1.0; P6.8 adds node.capability@0.1.0; P6.9 adds node.semantics@0.1.0; P6.10 adds node.lifecycle@0.1.0; P6.11 adds node.health@0.1.0; P6.12 adds node.supply-chain@0.1.0; P6.13 adds registry.incremental@0.1.0; P6.14 adds node.worker-convergence@0.1.0; P6.15 adds node.acceptance@0.1.0; P6.16 adds registry.integrity@0.1.0; P6.17 adds node.admission@0.1.0; P6.18 adds node.sbom@0.1.0; P6.19 adds node.canary@0.1.0; P6.20 adds node.revocation@0.1.0; P6.21 adds node.io@0.1.0; P6.22 adds runtime.jit@0.1.0; P6.23 adds runtime.cancel@0.1.0; P6.24 adds runtime.pool@0.1.0; P6.25 adds node.abi@0.1.0; P6.26 adds runtime.wasm-cache@0.1.0; P6.27 adds node.provenance@0.1.0; P6.28 adds registry.freshness@0.1.0; P6.29 adds node.namespace@0.1.0; P6.30 adds registry.repair@0.1.0; P6.31 adds registry.acceptance@0.1.0; count-pins say 76; P2.27.1 adds lego.plugin-runtime@0.1.0 (seventy-sixth); P5.1 adds the ninety-fifth (auth.principal)'); // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  // The declaration records the same open decisions this frontend names, and says the bounded half
  // is what is published while the rest stays open.
  const declaredOpen = declaration.memory.openDecisions;
  const xa12 = declaredOpen[SURFACE.alignment.decision];
  assert.equal(typeof xa12, 'string', `the declaration records ${SURFACE.alignment.decision}`);
  assert.match(xa12, /Open-for-manager|open-for-manager/i, 'and it is still the manager\'s decision');
  assert.match(xa12, /relevance-ranked traversal/);
  assert.match(xa12, /retention-policy enforcement/);
  assert.match(declaredOpen['XA-21'], /4,096 KB/, 'the declaration heeds the heap pin and does not raise it');
  assert.match(declaredOpen['XA-11'], /ai-foundation/, 'and keeps ai.memory under the existing domain');
});

test('protected main publishes no Memory contract, and the surface says so instead of guessing', { skip: publishedThere ? `the pointed-at tree publishes ai.memory (${MEMORY_MANIFEST}) — this test asserts the OTHER tree, and its twin above runs against this one` : false }, () => {
  // The other side of the same bound: this assertion only means something against a tree that does
  // NOT publish Memory — which is why it is skipped when one does.
  assert.equal(memoryRow(), null);
  assert.equal(existsSync(MEMORY_MANIFEST), false);
  const view = createMemoryView();
  assert.equal(view.published, false);
  assert.equal(view.contract.status, 'declared-not-locked');
  assert.equal(view.contract.version, null, 'no version is rendered for a contract no row publishes');
  assert.match(view.contract.detail, /no contract-lock row publishes it in this tree/);
  assert.equal(view.unsupported.error, 'lego.capability_unavailable');
  assert.deepEqual([...view.pending].map((entry) => entry.decision), ['XA-12']);
  assert.equal(view.pending[0].onProtectedMain, false);
});

test('the declaration has not moved past the quote, and a move would be reported rather than adopted', { skip }, () => {
  const declaration = {
    memory: JSON.parse(readFileSync(MEMORY_MANIFEST, 'utf8')),
    lego: backendJson('manifest/ai-lego-set.json').lego.find((entry) => entry.id === MEMORY_LEGO_ID),
    capabilities: [backendJson('manifest/domains.json').domains
      .find((entry) => entry.id === 'ai-foundation').capabilities
      .find((entry) => entry.id === MEMORY_CONTRACT_ID)],
  };
  const drift = memoryDrift({ declaration, contract: [memoryRow()], surface: SURFACE });
  assert.equal(drift.state, 'in-sync', `unexpected drift: ${JSON.stringify(drift.differences)}`);
  assert.deepEqual([...drift.differences], []);
  assert.equal(drift.compared.length, 12, 'nine manifest fields, the registry operations and permissions, and the version claim');
  assert.deepEqual([...drift.pending], [], 'a published row leaves nothing pending');
  assert.equal(drift.owner, 'manager');
  assert.equal(drift.decision, 'XA-12');
});

test('a difference between declaration and quote is reported with both spellings', () => {
  const asDeclared = {
    memory: {
      scopes: [...MEMORY_SCOPES, 'TENANT'],
      kinds: [...MEMORY_KINDS],
      retention: [...MEMORY_RETENTIONS],
      fields: MEMORY_FIELDS.filter((field) => field !== 'checksum'),
      lifecycle: { states: [...MEMORY_LIFECYCLE] },
      graph: { nodes: [...MEMORY_GRAPH_NODES], edges: [...MEMORY_GRAPH_EDGES] },
      operations: MEMORY_OPERATIONS.map((name) => ({ name })),
      permissions: [...MEMORY_PERMISSIONS],
      version: '1.0.0',
    },
  };
  const drift = memoryDrift({ declaration: asDeclared, contract: [], surface: SURFACE });
  assert.equal(drift.state, 'drift');
  const scope = drift.differences.find((difference) => difference.field === 'scopes');
  assert.deepEqual([...scope.added], ['TENANT'], 'an added word is named');
  assert.deepEqual([...scope.removed], []);
  const fields = drift.differences.find((difference) => difference.field === 'fields');
  assert.deepEqual([...fields.removed], ['checksum'], 'a dropped word is named in the other direction');
  assert.deepEqual([...fields.added], []);
  assert.match(drift.rule, /never resolved locally/);
  // And the surface keeps rendering the words it quotes: TENANT is not renderable.
  assert.equal(MEMORY_SCOPES.includes('TENANT'), false);
  const view = createMemoryView({ declaration: asDeclared });
  assert.equal(view.drift.state, 'drift');
  assert.deepEqual([...view.scopes].map((scope) => scope.scope), [...MEMORY_SCOPES]);
  assert.equal(view.scopes.some((scope) => scope.scope === 'TENANT'), false);
});

/* ------------------------------------------------------------------- 5. publication */

test('publication is derived from the rows handed over — declared-not-locked, published, disagreeing', () => {
  const absent = memoryPublication({ contract: [] });
  assert.equal(absent.published, false);
  assert.equal(absent.memory.status, 'declared-not-locked');
  assert.equal(absent.memory.version, null);
  assert.equal(absent.memory.agreesWithClaim, false);
  assert.match(absent.memory.detail, /declared-not-locked|no contract-lock row/);
  const declared = memoryPublication({ surface: SURFACE });
  assert.equal(declared.published, false, 'the catalog ships no rows, so no publication is claimed');
  const row = { id: MEMORY_CONTRACT_ID, version: '1.0.0', owner: 'manager', status: 'implemented', domain: 'ai-foundation' };
  const published = memoryPublication({ contract: [row] });
  assert.equal(published.published, true);
  assert.equal(published.memory.version, '1.0.0');
  assert.equal(published.memory.agreesWithClaim, true);
  assert.equal(published.memory.status, 'implemented');
  assert.match(published.memory.lockedIn, /contract-lock\.json$/);
  // A version that moved is a difference to reconcile, not to average.
  const moved = memoryPublication({ contract: [{ ...row, version: '2.0.0' }] });
  assert.equal(moved.published, true);
  assert.equal(moved.memory.agreesWithClaim, false);
  assert.match(moved.memory.detail, /difference to reconcile, not to average/);
  // An object map is accepted the way the lock file stores rows.
  const mapped = memoryPublication({ contract: { 'ai.memory': { version: '1.0.0', owner: 'manager' } } });
  assert.equal(mapped.published, true);
  assert.equal(mapped.memory.version, '1.0.0');
});

test('the unsupported answer is a verdict with a reason, not an empty object', () => {
  const unsupported = memoryUnsupported('no declaration was handed over');
  assert.equal(unsupported.state, 'capability-unavailable');
  assert.equal(unsupported.error, 'lego.capability_unavailable');
  assert.equal(unsupported.contract.id, MEMORY_CONTRACT_ID);
  assert.equal(unsupported.contract.version, null);
  assert.equal(unsupported.contract.published, false);
  assert.equal(unsupported.decision, 'XA-12');
  assert.match(unsupported.detail, /no fallback store/);
  assert.match(unsupported.detail, /no model is implied/);
  const view = createMemoryView();
  assert.equal(view.availability, 'capability-unavailable');
  assert.equal(view.unsupported.reason, view.availabilityDetail);
});

/* ------------------------------------------------------------------ 6. the list states */

test('four list states stay four, and an empty answer is not an erased memory', () => {
  const absent = createMemoryView();
  assert.equal(absent.list.state, 'not-handed-over');
  assert.deepEqual([...absent.list.entries], []);
  assert.equal(absent.list.total, null, 'nobody asked, so no total is claimed');
  assert.match(absent.list.detail, /nothing was returned" is not "nothing is remembered/);

  const empty = createMemoryView({ result: { results: [], total: 0 } });
  assert.equal(empty.list.state, 'empty');
  assert.equal(empty.list.total, 0);
  assert.match(empty.list.detail, /an answer/);
  assert.match(empty.list.detail, /not a claim that anything was deleted/);
  assert.notEqual(empty.list.state, absent.list.state, 'the two states look alike on screen and must never collapse');

  const one = createMemoryView({ result: { results: [record()], total: 1 } });
  assert.equal(one.list.state, 'rendered');
  assert.equal(one.list.entries.length, 1);
  assert.equal(one.list.validations[0].ok, true);
  assert.equal(one.list.more, false);
  assert.match(one.list.detail, /in the published order/);

  const refused = createMemoryView({ result: { results: [record({ kind: 'guess' })], total: 1 } });
  assert.equal(refused.list.state, 'refused');
  assert.match(refused.list.detail, /refused before rendering/);
  assert.equal(refused.list.findings.length > 0, true);
  assert.equal(refused.list.state === 'empty', false, 'a refused payload is never rendered as an empty one');

  const secret = createMemoryView({ result: [{ ...record(), accessToken: 'x' }] });
  assert.equal(secret.list.state, 'refused');
  assert.equal(secret.refused.length > 0, true);
  assert.match(secret.refused[0].reason, /secret/);
  for (const state of [absent.list.state, empty.list.state, one.list.state, refused.list.state, secret.list.state]) {
    assert.equal(MEMORY_LIST_STATES.includes(state), true, `${state} is one of the four declared states`);
  }
});

test('the list contract is the published one: bounded, ordered, cursor-carried, never re-sorted', () => {
  assert.equal(MEMORY_LIST_LIMIT.min, 1);
  assert.equal(MEMORY_LIST_LIMIT.max, 100);
  assert.equal(MEMORY_LIST_LIMIT.default, 50);
  assert.deepEqual([...MEMORY_LIST_ORDERING], ['createdAt asc', 'memoryId asc']);
  const view = createMemoryView({ result: { results: [record()], total: 7, nextCursor: 'cur-9' } });
  assert.equal(view.list.requested.limit, 50, 'the default limit is quoted, not chosen');
  assert.equal(view.list.more, true);
  assert.equal(view.list.nextCursor, 'cur-9', 'the cursor travels through untouched');
  assert.deepEqual({ ...view.list.limits }, { min: 1, max: 100, default: 50 });
  assert.deepEqual([...view.list.ordering], ['createdAt asc', 'memoryId asc']);
  // The surface does not re-sort: the order handed over is the order rendered.
  const ordered = [record({ memoryId: 'mem-b' }), record({ memoryId: 'mem-a' })];
  const rendered = createMemoryView({ result: ordered });
  assert.deepEqual(rendered.list.entries.map((entry) => entry.memoryId), ['mem-b', 'mem-a']);
  assert.match(MEMORY_AFFORDANCES.forbidden.search, /would promise a ranking nobody implements/);
  // A scope filter is echoed and a scope that cannot name a namespace is refused, never widened.
  const scoped = createMemoryView({ scope: { scope: 'PROJECT', scopeOwner: 'proj-7' } });
  assert.equal(scoped.list.scope.known, true);
  assert.equal(scoped.list.scope.requiresOwner, true);
  assert.deepEqual([...scoped.list.scopeFindings], []);
  const unknown = createMemoryView({ scope: { scope: 'TENANT' } });
  assert.equal(unknown.findings.length, 1);
  assert.match(unknown.findings[0], /unknown scope "TENANT"/);
  assert.equal(unknown.list.scope.known, false, 'the unknown scope is reported, not mapped to a neighbour');
  assert.match(memoryScope('TENANT').detail, /refused, never widened/);
  const unowned = createMemoryView({ scope: { scope: 'SESSION' } });
  assert.match(unowned.findings[0], /scopeOwner/);
  assert.match(unowned.findings[0], /refused rather than widened/);
});

/* ------------------------------------------------------------ 7. record validation */

test('a record is validated against the quoted shape, and every refusal is named', () => {
  assert.equal(validateMemoryRecord(record()).ok, true);
  const cases = [
    [{ memoryId: '' }, /must name the record/],
    [{ memoryId: 'has space' }, /identity pattern/],
    [{ scope: undefined }, /"scope" must be declared/],
    [{ scope: 'TENANT' }, /unknown scope "TENANT"/],
    [{ scope: 'WORKFLOW', scopeOwner: undefined }, /requires a "scopeOwner"/],
    [{ kind: 'guess' }, /unknown kind "guess"/],
    [{ retention: 'FOREVER' }, /unknown retention "FOREVER"/],
    [{ content: undefined }, /"content" must be present/],
    [{ references: 'dec-1' }, /must be an array of \{ id, relation \}/],
    [{ references: [{ id: 'dec-1', relation: 'invented_edge' }] }, /the published edge vocabulary does not declare/],
    [{ references: Array.from({ length: 33 }, (unused, index) => ({ id: `dec-${index}`, relation: 'related_to' })) }, /published bound of 32/],
    [{ provenance: { createdBy: 'x', mood: 'happy' } }, /undeclared field\(s\) mood/],
    [{ size: -1 }, /non-negative/],
    [{ checksum: 'abc' }, /64 lowercase hex characters/],
    [{ nothing: true }, /unknown field "nothing"/],
  ];
  for (const [override, expected] of cases) {
    const validation = validateMemoryRecord(record(override));
    assert.equal(validation.ok, false, `${JSON.stringify(Object.keys(override))} is refused`);
    assert.ok(validation.findings.some((finding) => expected.test(finding)),
      `${JSON.stringify(override)}: expected ${expected} in ${JSON.stringify(validation.findings)}`);
  }
  assert.equal(validateMemoryRecord(null).ok, false);
  assert.match(validateMemoryRecord(null).findings[0], /must be an object/);
  assert.equal(validateMemoryRecord([]).ok, false);
  // A record that carries a secret, a transcript or private model material is refused by name.
  for (const key of ['token', 'credentials', 'chainOfThought', 'transcript', 'messages', 'systemPrompt', 'hostPath', 'grants']) {
    const validation = validateMemoryRecord(record({ [key]: 'x' }));
    assert.equal(validation.ok, false, `${key} is refused`);
    assert.equal(validation.refused.some((entry) => entry.key === key), true, `${key} is refused by name`);
    assert.equal(FORBIDDEN_MEMORY_FIELDS[key] !== undefined || FORBIDDEN_MEMORY_KEY_PATTERN.test(key), true);
  }
  assert.equal(FORBIDDEN_MEMORY_KEY_PATTERN.test('nestedApiKey'), true, 'and a key nobody enumerated still matches the pattern');
});

test('records carry provenance or say they do not — no author is invented', () => {
  const declared = memoryOrigin(record());
  assert.equal(declared.state, 'declared-provenance');
  assert.equal(declared.createdBy, 'agent-2');
  assert.equal(declared.source, 'p2.14');
  const anonymous = memoryOrigin({ memoryId: 'mem-2' });
  assert.equal(anonymous.state, 'no-provenance');
  assert.equal(anonymous.createdBy, null, 'no current user, no agent name, no default');
  assert.equal(anonymous.source, null);
  assert.match(anonymous.detail, /never fills in the current user/);
  assert.deepEqual([...MEMORY_ORIGINS], ['declared-provenance', 'no-provenance']);
  const rendered = memoryRecallResult({ record: record({ provenance: undefined }) });
  assert.equal(rendered.state, 'rendered');
  assert.equal(rendered.origin.state, 'no-provenance');
  assert.match(rendered.detail, /no-provenance/);
  const view = createMemoryView({ record: record() });
  assert.equal(view.detail.origin.state, 'declared-provenance');
  assert.equal(view.origins.includes(view.detail.origin.state), true);
});

test('recall answers with a record or with the published empty answer — never with an error', () => {
  const empty = memoryRecallResult({ record: null });
  assert.equal(empty.state, 'empty');
  assert.equal(empty.record, null);
  assert.equal(empty.origin, null);
  assert.match(empty.detail, /not an error/);
  assert.equal('error' in empty, false, 'the canonical null answer is not an error shape');
  const refused = memoryRecallResult({ record: record({ retention: 'FOREVER' }) });
  assert.equal(refused.state, 'refused');
  assert.match(refused.detail, /the record is refused/);
  // Through the view: nothing handed over renders no detail block, and the published null answer
  // renders as `empty` — the two are not the same state.
  assert.equal(createMemoryView().detail, null, 'no detail was handed over, so no detail block is rendered');
  assert.equal(createMemoryView({ record: null }).detail, null);
  assert.equal(createMemoryView({ record: { record: null } }).detail.state, 'empty');
  assert.equal(createMemoryView({ record: { record: null } }).detail.record, null);
});

/* ------------------------------------------------- 8. concepts, retention and scopes */

test('scope owns isolation, and the ladder is quoted rather than re-sorted', () => {
  const ladder = memoryScopeLadder();
  assert.deepEqual(ladder.map((entry) => entry.scope), [...MEMORY_SCOPES]);
  assert.equal(ladder[0].width, 'widest');
  assert.equal(ladder[ladder.length - 1].width, 'narrowest');
  assert.equal(ladder[0].requiresOwner, false, 'GLOBAL is the one scope with no owner');
  assert.equal(ladder.slice(1).every((entry) => entry.requiresOwner === true), true);
  for (const entry of ladder) {
    assert.equal(entry.known, true);
    assert.equal(typeof entry.rank, 'number');
    assert.equal(typeof entry.detail, 'string');
  }
  const unknown = memoryScope('TENANT');
  assert.equal(unknown.known, false);
  assert.equal(unknown.rank, null);
  assert.match(unknown.detail, /refused, never widened/);
  const view = createMemoryView();
  assert.equal(view.scopes.length, MEMORY_SCOPES.length);
  assert.equal(view.affordances.allowed.includes('show-memory-scope'), true);
});

test('kinds are records ABOUT things, and retention never expires on its own', () => {
  const kinds = memoryKinds();
  assert.deepEqual(kinds.map((entry) => entry.kind), [...MEMORY_KINDS]);
  for (const entry of kinds) {
    assert.equal(entry.known, true);
    assert.equal(entry.executing, false, `${entry.kind} is not an execution state`);
    assert.equal(entry.inference, false, `${entry.kind} implies no inference`);
    assert.equal(typeof entry.detail, 'string');
  }
  assert.match(memoryKind('task').detail, /not a running task/);
  assert.match(memoryKind('execution').detail, /execution state still comes from the execution domain/);
  const retentions = memoryRetentions();
  assert.deepEqual(retentions.map((entry) => entry.retention), [...MEMORY_RETENTIONS]);
  for (const entry of retentions) {
    assert.equal(entry.expiresOnItsOwn, false, `${entry.retention} never expires on its own`);
  }
  assert.equal(retentions.find((entry) => entry.retention === 'EPHEMERAL').requiresExplicitForget, false);
  assert.equal(retentions.find((entry) => entry.retention === 'PERMANENT').requiresExplicitForget, true);
  assert.match(memoryRetention('PERMANENT').detail, /still not a guarantee the UI may upgrade/);
  assert.equal(memoryRetention('FOREVER').known, false);
  assert.equal(MEMORY_FORBIDDEN_IMPLICATIONS.includes('automatic-retention'), true);
  assert.match(MEMORY_AFFORDANCES.forbidden.autoExpire, /no countdown|timer/);
  const lifecycles = memoryLifecycle();
  assert.deepEqual(lifecycles.map((entry) => entry.state), ['active', 'forgotten']);
  assert.equal(memoryLifecycleState('forgotten').terminal, true);
  assert.equal(memoryLifecycleState('forgotten').recoverable, false);
  assert.equal(memoryLifecycleState('deleted').known, false);
  assert.match(MEMORY_AFFORDANCES.forbidden.restore, /no restore operation exists/);
});

test('persistence has three words and is never claimed', () => {
  const undeclared = memoryPersistence();
  assert.equal(undeclared.state, 'not-declared');
  assert.equal(undeclared.connected, false);
  assert.match(undeclared.detail, /never renders "saved", "synced"/);
  const inMemory = memoryPersistence({ provider: { kind: 'in-memory' } });
  assert.equal(inMemory.state, 'in-memory-only');
  assert.match(inMemory.detail, /do not outlive the process/);
  assert.equal(inMemory.connected, false, 'in-memory is a provider, not a connection');
  const declaredByApplication = memoryPersistence({ provider: { kind: 'filesystem', id: 'fs-1', connected: true } });
  assert.equal(declaredByApplication.state, 'provider-bound');
  assert.equal(declaredByApplication.connected, true, 'a declared and connected provider may say so — because the application said it');
  assert.match(declaredByApplication.detail, /names the boundary rather than the storage engine/);
  assert.deepEqual([...MEMORY_PERSISTENCE_STATES], ['provider-bound', 'in-memory-only', 'not-declared']);
  const view = createMemoryView();
  assert.equal(MEMORY_PERSISTENCE_STATES.includes(view.persistence.state), true);
  assert.equal(view.persistence.state, 'not-declared');
  for (const word of ['saved', 'synced', 'durable', 'persisted']) {
    assert.equal(MEMORY_PERSISTENCE_STATES.includes(word), false, `"${word}" is not a state the surface may render`);
  }
  assert.equal(MEMORY_FORBIDDEN_IMPLICATIONS.includes('provider-connected'), true);
  assert.match(MEMORY_AFFORDANCES.forbidden.connectProvider, /never renders a connection it cannot see/);
});

test('Memory is not Context, in both directions', () => {
  const ok = assertMemoryIsNotContext(record());
  assert.equal(ok.ok, true);
  assert.match(ok.rule, /Referencing is allowed; merging is not/);
  assert.deepEqual(ok.separation.map((entry) => entry.id), ['context', 'session', 'memory', 'execution']);
  for (const entry of MEMORY_SEPARATION) {
    assert.equal(typeof entry.what, 'string');
    assert.equal(typeof entry.crosses, 'string');
    assert.equal(typeof entry.rule, 'string');
    assert.ok(entry.contract !== null, `${entry.id} names the contract it belongs to`);
  }
  assert.match(MEMORY_SEPARATION.find((entry) => entry.id === 'context').rule, /If a record held the window, memory would be replaced with it/);
  // Referencing a context is right; carrying one is refused.
  const withReference = assertMemoryIsNotContext(record({ references: [{ id: 'ctx-1', relation: 'observed_in' }] }));
  assert.equal(withReference.ok, true);
  for (const key of ['context', 'session', 'window', 'continuation', 'snapshot', 'messages', 'transcript', 'turns', 'history']) {
    assert.throws(() => assertMemoryIsNotContext(record({ [key]: { any: 'thing' } })), (error) => {
      assert.equal(error.name, 'MemoryError');
      assert.equal(error.code, 'frontend.memory.context-merged');
      assert.match(error.message, /memory stays a record/);
      assert.ok(error.findings.some((finding) => finding.includes(key)), `${key} is named in the refusal`);
      return true;
    });
  }
  assert.throws(() => assertMemoryIsNotContext(record({ execution: { runId: 'run-1' } })), /execution state comes from the execution domain/);
  assert.throws(() => assertMemoryIsNotContext(null), MemoryError);
  // The other direction: a context or session record that carries a memory payload is refused by
  // the Context & Session surface, which is where that half of the invariant lives.
  assert.throws(() => assertDistinctConcepts({ sessionId: 'sess-1', memory: { entries: 3 } }), (error) => {
    assert.equal(error.code, 'frontend.context-session.concepts-merged');
    assert.match(error.message, /SEPARATE LEGO/);
    return true;
  });
  const memoryConcept = DISTINCT_CONCEPTS.find((concept) => concept.id === 'memory');
  assert.equal(memoryConcept.contract, MEMORY_CONTRACT_ID, 'the neighbour names this contract, and this LEGO is the one that renders it');
});

/* ------------------------------------------------------------- 9. refusals and reach */

test('no secret, no private model material and no capability claim is rendered', () => {
  const refused = scanForbiddenMemoryKeys({ content: { apiKey: 'x', nested: { transcript: [] } }, authorization: 'Bearer x' });
  assert.equal(refused.length, 3);
  assert.deepEqual(refused.map((entry) => entry.key).sort(), ['authorization', 'content.apiKey', 'content.nested.transcript']);
  assert.deepEqual([...scanForbiddenMemoryKeys({ memoryId: 'mem-1' })], []);
  assert.deepEqual([...scanForbiddenMemoryKeys(null)], []);
  const view = createMemoryView();
  for (const key of ['credentials', 'token', 'chainOfThought', 'rawPrompt', 'transcript', 'messages', 'modelOutput', 'path', 'grants', 'permissions']) {
    assert.equal(typeof view.forbiddenFields[key], 'string', `${key} is refused with a reason`);
  }
  assert.equal(view.forbiddenImplications.length, MEMORY_FORBIDDEN_IMPLICATIONS.length);
  for (const implication of ['memory-dump', 'vector-search', 'embedding', 'relevance-ranking', 'automatic-retention', 'memory-to-context-injection', 'model-inference', 'agent-execution', 'workspace-action', 'filesystem-access', 'terminal-access', 'provider-connected', 'permission-grant', 'transcript-store']) {
    assert.equal(view.forbiddenImplications.includes(implication), true, `${implication} is refused`);
  }
  for (const key of Object.keys(view.affordances.forbidden)) {
    assert.match(view.affordances.forbidden[key], /\S/, `${key} is refused with a reason`);
  }
  assert.equal(view.affordances.allowed.every((entry) => entry.startsWith('show-')), true, 'every allowed affordance shows, none acts');
  for (const verb of ['remember', 'forget', 'restore', 'write', 'delete', 'execute', 'infer', 'connect']) {
    assert.equal(view.affordances.allowed.some((entry) => entry.includes(verb)), false, `no affordance ${verb}s`);
  }
  assert.equal(view.graph.traversalPublished, false);
  assert.match(view.graph.detail, /may be described and may not be drawn as a result set/);
});

test('the error codes this surface raises are declared once, and the contract document names them', () => {
  assert.deepEqual({ ...MEMORY_ERROR_CODES }, {
    invalid: 'frontend.memory.invalid',
    invalidRecord: 'frontend.memory.invalid-record',
    contextMerged: 'frontend.memory.context-merged',
  });
  // The two throw sites use the declared codes, and the record refusal is the one that fires for a
  // non-object.
  assert.throws(() => assertMemoryIsNotContext(null), (error) => {
    assert.equal(error.code, MEMORY_ERROR_CODES.invalidRecord);
    return true;
  });
  assert.throws(() => assertMemoryIsNotContext(record({ context: {} })), (error) => {
    assert.equal(error.code, MEMORY_ERROR_CODES.contextMerged);
    return true;
  });
  assert.equal(new MemoryError('x').code, MEMORY_ERROR_CODES.invalid, 'the class default is a declared code');
  // The unpublished case is a verdict, not an error: it is returned, and it reuses the shared
  // `lego.*` vocabulary rather than inventing a fifth code.
  assert.equal(MEMORY_UNSUPPORTED_ERROR, 'lego.capability_unavailable');
  assert.equal(memoryUnsupported().error, MEMORY_UNSUPPORTED_ERROR);
  assert.equal(MEMORY_ERROR_CODES.invalid.includes('lego.'), false);
  // Document coupling: the table in §19.20 names exactly these codes and this verdict — a doc that
  // promised a code the module never raises would be an invented interface.
  const contract = read('contracts/frontend.contract.md');
  const section = contract.slice(contract.indexOf('### 19.20 The Memory surface'));
  assert.equal(section.length > 0, true, 'the contract documents the Memory surface');
  for (const code of Object.values(MEMORY_ERROR_CODES)) {
    assert.ok(section.includes(`\`${code}\``), `§19.20 names ${code}`);
  }
  assert.ok(section.includes(`\`${MEMORY_UNSUPPORTED_ERROR}\``), 'and the returned verdict');
  assert.equal(/frontend\.memory\.[a-z-]+/.test(section.replace(/\`frontend\.memory\.[a-z-]+\`/g, '').replace(/frontend\.memory\.(invalid|invalid-record|context-merged)/g, '')), false,
    '§19.20 names no memory error code the module does not declare');
});

test('the assembly exposes Memory lazily, and the boot descriptor stays byte-identical', () => {
  const frontend = createFrontendLego({
    app: { name: 'n8n lego', version: '0.1.0', referenceVersion: '2.9.4' },
    ui: { basePath: '/', restEndpoint: 'rest' },
  });
  assert.equal(frontend.describe().memoryScopes, 5);
  assert.equal(frontend.describe().memoryKinds, 6);
  assert.equal(frontend.describe().memoryPublished, false, 'this tree publishes no ai.memory row');
  assert.equal(frontend.describe().memoryDrift, 'not-declared');
  assert.equal(frontend.memory.published, false);
  assert.equal(frontend.memory.list.state, 'not-handed-over');
  assert.equal(frontend.memory.availability, 'capability-unavailable');
  assert.equal(typeof frontend.describeMemory, 'function');
  const payload = JSON.stringify(frontend.bootPayload);
  // Refresh 2026-09-28 (P2-S14): the boot descriptor grows with the declared canvas
  // surface (manifest/surfaces.json + capability): 18,126 -> 18,477 bytes, measured.
  // Refresh 2026-09-28 (P2-S15): + the node-config surface: 18,477 -> 18,855 bytes, measured.
  // Refresh 2026-09-28 (P2-S16): + the connections surface: 18,855 -> 19,233 bytes, measured.
  // Refresh 2026-09-28 (P2-S18): + the environments surface: 19,233 -> 19,574 bytes, measured.
  assert.equal(payload.length, 19_574, 'the boot payload is byte-identical to the P2.18 baseline');
  for (const word of ['memoryId', 'scopeOwner', 'memory.remember', 'memory.list', 'memory.forget', 'provenance', 'IMPORTANT', 'forgotten']) {
    assert.equal(payload.includes(word), false, `${word} does not travel in the boot descriptor`);
  }
  // Handed a record and a publication, the surface renders them — and the descriptor still does not move.
  const wired = createFrontendLego({
    app: { name: 'n8n lego', version: '0.1.0', referenceVersion: '2.9.4' },
    memory: {
      contract: [{ id: MEMORY_CONTRACT_ID, version: '1.0.0', owner: 'manager', status: 'implemented', domain: 'ai-foundation' }],
      result: { results: [record({ memoryId: 'mem-secret-name' })], total: 1 },
      provider: { kind: 'in-memory' },
    },
  });
  assert.equal(wired.memory.published, true);
  assert.equal(wired.memory.contract.version, '1.0.0');
  assert.equal(wired.memory.list.state, 'rendered');
  assert.equal(wired.memory.persistence.state, 'in-memory-only');
  assert.equal(wired.describe().memoryPublished, true);
  assert.equal(wired.describe().memoryDrift, 'not-declared');
  assert.equal(JSON.stringify(wired.bootPayload).includes('mem-secret-name'), false, 'a rendered record never enters the descriptor');
  assert.equal(JSON.stringify(wired.bootPayload).length, 19_574);
});

test('describeMemory is the surface as data, and the milestone is not claimed complete', () => {
  const described = describeMemory();
  assert.equal(described.lego, MEMORY_LEGO_ID);
  assert.equal(described.phase, MEMORY_PHASE);
  assert.equal(described.contract.id, MEMORY_CONTRACT_ID);
  assert.equal(described.contract.declaredVersion, MEMORY_DECLARED_VERSION);
  assert.equal(described.contract.publishedVersion, null, 'a version claim is not a publication');
  assert.equal(described.contract.decision, 'XA-12');
  assert.equal(described.models, undefined, 'no model is described');
  assert.equal(described.scopes.length, 5);
  assert.equal(described.kinds.length, 6);
  assert.equal(described.retentions.length, 5);
  assert.equal(described.fields.length, 13);
  assert.equal(described.lifecycleStates.length, 2);
  assert.equal(described.operations.length, 4);
  assert.equal(described.deferredOperations.length, 2);
  assert.equal(described.permissions.length, 2);
  assert.equal(described.graphNodes.length, 10);
  assert.equal(described.graphEdges.length, 11);
  assert.equal(described.quoted.length, 9);
  assert.deepEqual([...described.listStates], [...MEMORY_LIST_STATES]);
  assert.deepEqual([...described.persistenceStates], [...MEMORY_PERSISTENCE_STATES]);
  assert.deepEqual([...described.origins], [...MEMORY_ORIGINS]);
  assert.equal(described.driftFields.length, 9);
  assert.equal(described.sources.memory.file, MEMORY_DECLARATION_SOURCE.file);
  assert.match(described.rule, /stays a separate LEGO from Context & Session/);
  // The register is the Manager's, and neither this code nor this branch claims the milestone is done.
  const row = MILESTONES.milestones.find((milestone) => milestone.id === 'P2.14');
  assert.ok(row, 'P2.14 is in the canonical register');
  assert.equal(row.status, 'complete', `P2.14 is complete on protected main (status "${row.status}")`);
  assert.equal('complete' in SURFACE, false, 'the frontend catalog makes no completion claim');
  // XA-12 is still the manager's open decision: this surface names it and does not resolve it.
  const xa12 = decisionRow('XA-12');
  assert.ok(xa12, 'XA-12 is recorded');
  assert.equal(xa12.status, 'open-for-manager');
  assert.equal(xa12.owner, 'manager');
  assert.deepEqual([...xa12.affectedDomains].sort(), ['ai-foundation', 'frontend']);
  assert.equal(SURFACE.alignment.decision, 'XA-12');
  assert.equal(SURFACE.alignment.status, 'open-for-manager');
  assert.match(SURFACE.alignment.openHalf, /relevance-ranked traversal/);
  assert.equal(SURFACE.alignment.test, 'packages/frontend-lego/test/34-memory.test.mjs');
  assert.equal(existsSync(join(REPO_ROOT, SURFACE.alignment.test)), true, 'the suite the catalog names is this one');
  assert.equal(MEMORY_MODELING_DECISION, 'XA-11');
  for (const id of ['XA-11', 'XA-20', 'XA-21']) {
    assert.equal(SURFACE.alignment.relatedDecisions.some((entry) => entry.startsWith(id)), true, `${id} is named beside the alignment rule`);
  }
});

/**
 * Doc coupling, written for the tree it is running in rather than for one of them.
 *
 * Agent-2 added the same check on its branch, and its version asserts that
 * `.ai/master/AI_CONTRACT_MATRIX.md` names `ai.memory` as `locked @ 1.0.0` / `IMPLEMENTED`. That is
 * true of a tree whose contract lock carries the row — and false of this one, which publishes no
 * `ai.memory` row, so its **generated** matrix correctly says `publicationPending` / `PLANNED`. The
 * matrix is generated from the lock by `tools/lego/ai-pack.mjs`, so asserting a fixed value would
 * make the test a copy of one tree's state instead of a coupling check. What is asserted here is
 * the coupling itself: the matrix is GENERATED, it is not hand-edited, and its Memory row agrees
 * with **this tree's** lock — `locked @ <version>` exactly when the row is there, `publicationPending`
 * exactly when it is not. That passes here, passes on agent-2's branch, passes on the merged tree,
 * and fails the moment somebody edits the generated file by hand or the lock and the matrix drift.
 */
test('the generated .ai contract matrix cannot disagree with the tree it was generated from', () => {
  const matrix = read('.ai/master/AI_CONTRACT_MATRIX.md');
  assert.match(matrix.slice(0, 200), /<!-- GENERATED by tools\/lego\/ai-pack\.mjs/, 'the matrix is generated output, never hand-edited');
  const row = matrix.split('\n').find((line) => /\|\s*\*\*Memory\*\*\s*\|/.test(line)) ?? null;
  assert.ok(row, 'the generated matrix carries a Memory row');
  // The matrix is generated from **this** tree's manifests and lock, so it is compared with this
  // tree's lock — not with the tree `N8N_BACKEND_LEGO_ROOT` points at, which may publish a row this
  // tree's generated output has never seen. Mixing the two would report a difference that is really
  // a description of one tree read against another.
  const localLock = JSON.parse(read('apps/n8n-lego/src/lego/contracts/contract-lock.json'));
  const localRows = Array.isArray(localLock) ? localLock : (localLock.rows ?? localLock.contracts ?? []);
  const lockCarriesTheRow = localRows.some((entry) => (entry.id ?? entry.contract) === MEMORY_CONTRACT_ID);
  if (lockCarriesTheRow) {
    assert.ok(row.includes('locked @ 1.0.0'), `this tree locks ai.memory, so the matrix must say so: ${row.trim()}`);
    assert.ok(row.includes('IMPLEMENTED'), 'and carry the published status');
  } else {
    assert.ok(row.includes('publicationPending'), `this tree publishes no ai.memory row, so the matrix must say so: ${row.trim()}`);
    assert.equal(row.includes('locked @'), false, 'and must not claim a lock this tree does not hold');
  }
  // The curated frontend matrix is a different file and carries the other half: it names the peer
  // publication and this branch's consumption, and it says which of the two is generated.
  const curated = read('.ai/master/AI_FRONTEND_CONTRACT_MATRIX.md');
  assert.match(curated, /P2\.14 UPDATE/);
  assert.match(curated, /ai\.memory@1\.0\.0/);
  assert.match(curated, /XA-12 stays `open-for-manager`/);
  assert.match(curated, /the descriptor-assembly heap pin is \*\*not edited\*\*/);
});

test('the peer tip is recorded, and the same-path collision is named before the merge finds it', () => {
  const peer = SURFACE.publication.publishedOnPeerBranch;
  assert.equal(peer.commit, 'f11aee01', 'the commit the words were read from — provenance, not a moving pointer');
  assert.match(peer.tip, /^[0-9a-f]{8}$/, 'and the tip the branch had reached when it was re-read');
  assert.equal(peer.tip, '2dcd8570');
  assert.equal(peer.tipChange.includes('no contract file'), true, 'the move touched no contract value');
  assert.equal(peer.collision.path, 'packages/frontend-lego/test/34-memory.test.mjs');
  assert.equal(existsSync(join(REPO_ROOT, peer.collision.path)), true, 'the colliding path is this suite');
  assert.match(peer.collision.rule, /frontend path stays the frontend suite/);
  // The publication the lock quotes is unchanged by the peer tip: the entries still resolve.
  assert.equal(vocabularyOf('memoryScope').provenance.publishedOn.commit, 'f11aee01');
  const memoryPublication = vocabularyOf('memoryOperation').provenance.publishedOn;
  assert.equal(memoryPublication.lockRow, `${MEMORY_CONTRACT_ID}@${MEMORY_DECLARED_VERSION}`);
});

test('the two LEGOs quote different contracts, and neither absorbs the other', () => {
  const contextSession = loadManifests().contextSessionCatalog;
  assert.deepEqual([...contextSession.contracts].sort(), ['ai.agent-session', 'ai.context']);
  assert.equal(contextSession.contracts.includes(MEMORY_CONTRACT_ID), false, 'Context & Session does not consume ai.memory');
  assert.equal(SURFACE.contracts.includes('ai.context'), false);
  assert.equal(SURFACE.contracts.includes('ai.agent-session'), false);
  const memorySets = new Set(VOCABULARIES.filter((set) => MEMORY_QUOTED_VOCABULARIES.includes(set.id)).map((set) => set.id));
  assert.equal(memorySets.size, MEMORY_QUOTED_VOCABULARIES.length);
  for (const id of MEMORY_QUOTED_VOCABULARIES) {
    assert.equal(vocabularyOf(id).provenance.contract.id, MEMORY_CONTRACT_ID, `${id} quotes ${MEMORY_CONTRACT_ID}`);
  }
  // The notPublished list names what this surface must never render, in the words of the contract.
  const notPublished = [...SURFACE.publication.notPublished];
  assert.equal(notPublished.includes('ai.memory.traverse'), true);
  assert.equal(notPublished.includes('ai.memory.relate'), true);
  assert.equal(notPublished.includes('ai.context.memory'), true);
  assert.equal(notPublished.includes('ai.agent-session.memory'), true);
  assert.equal(notPublished.length > 0, true);
});

/* ---------------------------------------- 6. the registry view, folded from agent-2's copy */

/**
 * Agent-2 wrote its own `packages/frontend-lego/test/34-memory.test.mjs` — the same path this suite
 * owns — so the two branches ADD one file and the Manager has to reconcile them. The reconciliation
 * rule recorded in `manifest/memory.json#publication.publishedOnPeerBranch.collision` is that the
 * frontend path keeps the frontend suite: everything below is already proven above, so replacing this
 * file with a five-test copy would delete real coverage.
 *
 * What is NOT already proven above is the REGISTRY view, and that is what was folded in here: the
 * publishing tree writes Memory in four places and they have to agree — the product manifest, the
 * capability registry, the contract lock and the contract document. The frontend's own manifest and
 * vocabulary are checked elsewhere; this is the tree that publishes the contract.
 *
 * One thing from the peer copy was deliberately NOT folded in: its assertion that the generated
 * `.ai/master/AI_CONTRACT_MATRIX.md` says `locked @ 1.0.0` / `IMPLEMENTED`. That value is true only on
 * a tree whose contract lock carries the `ai.memory` row, and the matrix is generated per tree — the
 * coupling that holds on both is already asserted above, where the matrix is compared with THIS tree's
 * lock. A fixed value would make the suite assert one tree's state instead of the coupling.
 */
test('the publishing tree registers Memory in four places, and the four agree', { skip }, () => {
  const manifest = backendJson('manifest/memory.json');
  const set = backendJson('manifest/ai-lego-set.json');
  const domains = backendJson('manifest/domains.json');
  const lock = lockRows();

  // 1. the product manifest: one `memory` LEGO row, implemented, pointing at the suite that proves it.
  const lego = (set.lego ?? []).find((entry) => entry.id === MEMORY_LEGO_ID);
  assert.ok(lego, 'ai-lego-set.json carries a memory LEGO row');
  assert.equal(lego.status, 'implemented', 'the LEGO row says implemented');
  assert.ok(lego.contracts.includes(MEMORY_CONTRACT_ID), 'the LEGO row names the contract it delivers');
  assert.equal(lego.versioning, `${MEMORY_CONTRACT_ID}@${MEMORY_DECLARED_VERSION}`, 'and pins the version it claimed');
  assert.ok(lego.tests.some((entry) => entry.includes('lego-memory.test.mjs')), 'and points at the backend suite that proves it');

  // 2. the capability registry: one `ai.memory` capability under `ai-foundation`, four operations.
  const capability = (domains.domains ?? [])
    .find((entry) => entry.id === 'ai-foundation').capabilities
    .find((entry) => entry.id === MEMORY_CONTRACT_ID);
  assert.ok(capability, `${MEMORY_CONTRACT_ID} is registered under ai-foundation`);
  assert.equal(capability.status, 'implemented');
  assert.deepEqual([...capability.operations].map((operation) => operation.name).sort(), [...MEMORY_OPERATION_IDS].sort(),
    'exactly the four published operations, and nothing deferred');
  assert.deepEqual([...capability.permissions].sort(), [...MEMORY_PERMISSIONS].sort(),
    'and exactly the two published permission words');

  // 3. the contract lock: exactly one row for ai.memory — not two, not zero.
  const rows = lock.filter((entry) => (entry.id ?? entry.contract) === MEMORY_CONTRACT_ID);
  assert.equal(rows.length, 1, 'exactly one lock row publishes ai.memory');
  assert.equal(rows[0].version, MEMORY_DECLARED_VERSION);
  assert.equal(rows[0].status, 'implemented');

  // 4. the contract document: the graph the surface quotes is the graph it publishes.
  assert.equal(manifest.graph.nodes.length, MEMORY_GRAPH_NODES.length, 'the graph node count is the quoted one');
  assert.equal(manifest.graph.edges.length, MEMORY_GRAPH_EDGES.length, 'and so is the edge count');
  assert.deepEqual([...manifest.graph.nodes], [...MEMORY_GRAPH_NODES]);
  assert.deepEqual([...manifest.graph.edges], [...MEMORY_GRAPH_EDGES]);
  // And the tree publishes ONE Memory document: nothing beside it re-states the vocabulary.
  assert.equal(existsSync(MEMORY_MANIFEST), true);
});
