/**
 * Vocabulary separation — PROGRAM != MILESTONE != SLICE != PRIORITY, enforced by machine.
 *
 * Five namespaces in this repository use a `Pn`-shaped token. Four of them mean different things
 * by the same string, and one of them (telemetry priority classes) is a locked contract that must
 * NOT be renamed by a cleanup. This test is the guard in both directions:
 *
 *   - a namespace that was disambiguated stays disambiguated (AI-UI phases, Manager priority);
 *   - a namespace that was deliberately left alone stays alone (telemetry P0-P4, Program P0-P11,
 *     slice IDs, the immutable historical sub-milestone ladder);
 *   - and a vocabulary change can never masquerade as progress: the headline denominators and
 *     numerators are pinned, because vocabulary cleanup is not delivery.
 *
 * Prose authority: docs/engineering-operations/VOCABULARY.md.
 * Machine-readable twin: docs/n8n-lego/milestones.json -> governance.terminology.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { headlineMetrics, accountingBreakdown } from '../../../tools/lego/governance-register.mjs';

// Path traversal, never the directory NAME: a repo checked out anywhere must pass.
// (packages/frontend-lego/test/12-knowledge.test.mjs once asserted the checkout directory
// was named after the repository - the known counter-example. It is repaired in #399, and
// the repo-wide guard in tools/workforce/test/repo-invariants.test.mjs now rejects that
// shape, so the literal is deliberately not repeated here.)
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');
const REGISTER = JSON.parse(read('docs/n8n-lego/milestones.json'));
const TERMINOLOGY = REGISTER.governance.terminology;
const VOCAB_DOC = 'docs/engineering-operations/VOCABULARY.md';

/** The seven-token operational urgency ladder, in order. */
const PRIORITY_TOKENS = ['Priority-00', 'Priority-01', 'Priority-02', 'Priority-03', 'Priority-04', 'Priority-05', 'Priority-06'];
const PRIORITY_MEANINGS = {
  'Priority-00': 'Security / Trust',
  'Priority-01': 'Merge Backlog',
  'Priority-02': 'CI / Runner',
  'Priority-03': 'Blocker Removal',
  'Priority-04': 'Authorized Delivery',
  'Priority-05': 'Root-Cause Hardening',
  'Priority-06': 'Future / Optional',
};
/** The eight AI-UI implementation phases after namespacing. */
const UI_PHASES = ['UI-PHASE-03', 'UI-PHASE-04', 'UI-PHASE-05', 'UI-PHASE-06', 'UI-PHASE-07', 'UI-PHASE-08', 'UI-PHASE-09', 'UI-PHASE-10'];
/** The three locked contracts that own the telemetry P0-P4 classes. */
const TELEMETRY_MODULES = ['telemetry-buffer.mjs', 'telemetry-retention.mjs', 'low-resource-mode.mjs'];
const TELEMETRY_CONTRACTS = ['observability.telemetry-buffer', 'observability.telemetry-retention', 'observability.low-resource-mode'];

/* ------------------------------------------------------------------ 1. the register carries it */

test('the canonical register declares the terminology block, and it names all four namespaces', () => {
  assert.ok(TERMINOLOGY, 'governance.terminology exists');
  for (const key of ['authority', 'absoluteRule', 'hierarchy', 'namespaces', 'reportFormat', 'openAmbiguities', 'notDelivery']) {
    assert.ok(TERMINOLOGY[key] !== undefined, `governance.terminology.${key} exists`);
  }
  for (const ns of ['program', 'milestone', 'slice', 'priority']) {
    assert.ok(TERMINOLOGY.namespaces[ns], `namespace "${ns}" is registered`);
    assert.ok(TERMINOLOGY.namespaces[ns].tokens, `namespace "${ns}" declares its tokens`);
    assert.ok(TERMINOLOGY.namespaces[ns].rule, `namespace "${ns}" declares its rule`);
  }
  assert.match(TERMINOLOGY.authority, /VOCABULARY\.md/, 'the prose authority is named');
});

test('the absolute rule states PROGRAM ID != PRIORITY ID with a worked contrast', () => {
  const rule = TERMINOLOGY.absoluteRule;
  assert.match(rule, /PROGRAM ID != PRIORITY ID/);
  assert.match(rule, /P0 = Program P0/);
  assert.match(rule, /Priority-00 = operational urgency/);
  assert.match(rule, /P5-M05/, 'the slice counter-example is spelled out');
  assert.match(rule, /orthogonal/, 'urgency and identity are declared orthogonal dimensions');
});

test('the priority ladder is exactly Priority-00..Priority-06 with the owner-defined meanings', () => {
  assert.deepEqual(Object.keys(TERMINOLOGY.namespaces.priority.scale), PRIORITY_TOKENS);
  assert.deepEqual(TERMINOLOGY.namespaces.priority.scale, PRIORITY_MEANINGS);
  assert.equal(TERMINOLOGY.namespaces.priority.tokens, 'Priority-00 .. Priority-06');
  // The ladder itself must not reintroduce the bare form it exists to replace.
  assert.doesNotMatch(TERMINOLOGY.namespaces.priority.tokens, /(^|[^-\w])P[0-6]([^-\w.]|$)/);
});

test('the report format is the nine fields in order, and forbids inventing a milestone', () => {
  assert.deepEqual(TERMINOLOGY.reportFormat.fields, ['PRIORITY', 'PROGRAM', 'MILESTONE', 'SLICE', 'BRANCH', 'PR', 'HEAD SHA', 'STATUS', 'EVIDENCE']);
  const ex = TERMINOLOGY.reportFormat.example;
  assert.equal(ex.PRIORITY, 'Priority-04', 'the example uses the priority namespace');
  assert.equal(ex.PROGRAM, 'P5', 'the example uses a canonical Program ID');
  assert.equal(ex.SLICE, 'P5-M05', 'the example uses a canonical slice ID');
  assert.equal(ex.MILESTONE, 'N/A', 'an unknown milestone is reported as N/A');
  assert.match(TERMINOLOGY.reportFormat.rules, /never fabricate/i);
  assert.ok(REGISTER.governance.statusVocabulary.includes(ex.STATUS), 'the example STATUS is in statusVocabulary');
});

/* ------------------------------------------------- 2. collision #5 resolved: AI-UI phases */

test('AI-UI implementation phases are namespaced UI-PHASE-nn, not bare P3-P10', () => {
  const doc = read('.ai/master/AI_UI_IMPLEMENTATION_PHASES.md');
  for (const phase of UI_PHASES) assert.ok(doc.includes(phase), `${phase} is used`);
  // The collision itself: no bare P3-P10 may remain in the BODY. The namespace-note blockquote is
  // excluded on purpose - it is the crosswalk, and a crosswalk that cannot show the old token is
  // not a crosswalk. Lookahead keeps canonical sub-milestones (P2.5 / P2.10) and Pn-Snn / Pn-Mnn
  // out of the match.
  const body = doc.split('\n').filter((line) => !line.startsWith('>')).join('\n');
  const bare = body.match(/\bP(?:[3-9]|1[0-9])\b(?![.\-\w])/g) ?? [];
  assert.deepEqual(bare, [], `no bare P3-P10 remains outside the crosswalk (found: ${bare.join(', ')})`);
  assert.ok(doc.startsWith('# AI UI'), 'the crosswalk is a note, not a rewrite of the document');
});

test('the AI-UI phase crosswalk is present, so historical references stay readable', () => {
  const doc = read('.ai/master/AI_UI_IMPLEMENTATION_PHASES.md');
  assert.match(doc, /Namespace note/, 'the document explains the namespace');
  assert.match(doc, /UI-PHASE-nn/, 'the new form is named');
  for (const n of [3, 4, 5, 6, 7, 8, 9, 10]) {
    assert.ok(doc.includes(`| \`P${n}\` | \`UI-PHASE-${String(n).padStart(2, '0')}\` |`), `crosswalk row P${n} -> UI-PHASE-${String(n).padStart(2, '0')}`);
  }
  assert.match(doc, /not\*{0,2}\s*\*{0,2}rewritten/i, 'historical evidence is explicitly not rewritten');
});

test('the AI-UI rename did not over-reach onto canonical sub-milestones or change any content', () => {
  const doc = read('.ai/master/AI_UI_IMPLEMENTATION_PHASES.md');
  // P2.5 / P2.10 are canonical historical sub-milestones of Program P2 and must survive verbatim.
  assert.match(doc, /P2\.5 \/ P2\.10 parity/, 'the foundation-gate sub-milestone reference survived');
  // Scope, dependencies, exit gates and the definition of done are untouched by a rename.
  for (const line of [
    '## 2. Common definition of done (applies to every phase)',
    '**Exit gate.** An instance with no provider is a *valid* instance',
    '**Depends on.** UI-PHASE-04\u2013UI-PHASE-09.',
    '## 4. What no phase does',
  ]) assert.ok(doc.includes(line), `content preserved: ${line.slice(0, 48)}`);
  assert.equal((doc.match(/^### UI-PHASE-\d\d — /gm) ?? []).length, 8, 'exactly 8 phase headings');
});

test('no other .ai/master document reintroduces a bare Pn as a phase heading', () => {
  const dir = join(REPO_ROOT, '.ai', 'master');
  const offenders = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const text = read(join('.ai/master', name));
    // A markdown heading whose label is a bare Pn is how the collision re-enters.
    for (const m of text.matchAll(/^#{2,4}\s+(P\d{1,2})\s*[—-]/gm)) {
      // MILESTONE_REGISTER.md legitimately renders canonical Programs as "## P0 - Core Application
      // Bootstrap"; those carry the Program title on the same line, a phase heading does not.
      const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index));
      if (!/Core Application Bootstrap|Compatibility|LEGO|Workflow|Trigger|Identity|Node Registry|Dynamic Parameters|Storage|Observability|Multi-Tenant|Worker/.test(line)) {
        offenders.push(`${name}: ${line.trim().slice(0, 70)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `bare-Pn phase headings collide with Programs:\n${offenders.join('\n')}`);
});

/* ------------------------------------ 3. collision #6 deliberately NOT changed: telemetry P0-P4 */

test('telemetry priority classes are still P0-P4 in their three locked contracts', () => {
  // Reverse guard: a vocabulary cleanup must NOT rename a locked contract. If this test fails,
  // someone changed a v1.0.0 frozen vocabulary without an ADR and a version bump.
  const lock = JSON.parse(read('apps/n8n-lego/src/lego/contracts/contract-lock.json'));
  for (const id of TELEMETRY_CONTRACTS) {
    const row = lock.contracts.find((c) => c.id === id);
    assert.ok(row, `contract ${id} is still locked`);
    assert.equal(row.version, '1.0.0', `${id} version unchanged`);
  }
  const buffer = read('apps/n8n-lego/src/lego/telemetry-buffer.mjs');
  assert.match(buffer, /TELEMETRY_PRIORITY_CLASSES = Object\.freeze\(\['P0', 'P1', 'P2', 'P3', 'P4'\]\)/);
  const retention = read('apps/n8n-lego/src/lego/telemetry-retention.mjs');
  assert.match(retention, /RETENTION_PRIORITIES = Object\.freeze\(\['P0', 'P1', 'P2', 'P3', 'P4'\]\)/);
  const lowResource = read('apps/n8n-lego/src/lego/low-resource-mode.mjs');
  assert.match(lowResource, /'P0', 'P1', 'P2', 'P3', 'P4'/);
});

test('the telemetry namespace is registered as an open, documented collision - not silently ignored', () => {
  const ns = TERMINOLOGY.namespaces.telemetryPriorityClass;
  assert.equal(ns.tokens, 'P0-P4');
  assert.equal(ns.collisionStatus, 'OPEN-DOCUMENTED (AMBIGUITY-01)');
  assert.match(ns.rule, /DELIBERATELY NOT RENAMED/);
  assert.match(ns.rule, /not vocabulary cleanup|not a vocabulary cleanup/i, 'it says why: this would be delivery');
  assert.deepEqual(Object.keys(ns.meanings), ['P0', 'P1', 'P2', 'P3', 'P4']);
  assert.equal(ns.meanings.P0, 'security/audit/safety evidence - never shed by pressure');
  // The two scales are different concepts: 5 values vs 7, and the meanings do not line up.
  assert.notEqual(Object.keys(ns.meanings).length, PRIORITY_TOKENS.length, 'the scales have different cardinality');
  assert.notEqual(ns.meanings.P1, PRIORITY_MEANINGS['Priority-01'], 'P1 (failure diagnostics) is not Priority-01 (merge backlog)');
  assert.match(ns.precedent, /GUARD_LANES/, 'the clean named-lane precedent is recorded');
});

test('the resource guard lanes stay named, the precedent for a future telemetry migration', () => {
  const guard = read('apps/n8n-lego/src/lego/resource-guard.mjs');
  assert.match(guard, /GUARD_LANES = Object\.freeze\(\[\s*'system',\s*'interactive',\s*'background',\s*'bulk',\s*'deferred',/);
  assert.doesNotMatch(guard.match(/GUARD_LANES = Object\.freeze\(\[[^\]]*\]\)/)[0], /'P\d'/, 'no Pn token in the lane vocabulary');
});

/**
 * Every first-party source file that carries a QUOTED `Pn` data value, with the namespace that
 * value means. This is an allowlist on purpose, in the house style of the accounting gates: every
 * counted item is listed by id and every non-counted item carries an explicit reason. A new file
 * that quotes 'P3' fails here until someone registers it and says which namespace it means - which
 * is exactly the moment a collision should be caught, not three months later in a report.
 */
const QUOTED_PN_ALLOWLIST = Object.freeze({
  // namespace: telemetryPriorityClass (locked contracts v1.0.0 - see AMBIGUITY-01, never renamed)
  'apps/n8n-lego/src/lego/telemetry-buffer.mjs': 'telemetryPriorityClass',
  'apps/n8n-lego/src/lego/telemetry-retention.mjs': 'telemetryPriorityClass',
  'apps/n8n-lego/src/lego/low-resource-mode.mjs': 'telemetryPriorityClass',
  'apps/n8n-lego/src/lego/self-observability.mjs': 'telemetryPriorityClass',
  // namespace: program (a canonical Program ID carried as a data value in a field the codebase
  // names `phase` / `source`. A mislabel, registered as namespace #8 - not a priority.)
  'apps/n8n-lego/src/compat/capability.mjs': 'program',
  'apps/n8n-lego/src/lego/contract-oracle.mjs': 'program',
  'apps/n8n-lego/src/lego/replay-evidence.mjs': 'program',
  'packages/frontend-lego/test/03-errors.test.mjs': 'program',
  'packages/frontend-lego/test/14-negotiation.test.mjs': 'program',
});

test('every quoted Pn data value in source belongs to a registered namespace', () => {
  // A quoted 'P0' is a serialized vocabulary value - a data format, the thing that actually
  // collides. Prose and comments are deliberately NOT swept: they legitimately reference canonical
  // Programs ("no scheduler, queue or retry policy (P4)") and slices ("P3 Slice D", "P3 Slice M"),
  // and flagging those would make the guard unusable.
  const roots = ['apps/n8n-lego/src', 'packages'];
  const found = new Map();
  const walk = (rel) => {
    for (const name of readdirSync(join(REPO_ROOT, rel))) {
      const child = join(rel, name);
      if (statSync(join(REPO_ROOT, child)).isDirectory()) { walk(child); continue; }
      if (!/\.(mjs|js|ts)$/.test(child)) continue;
      const quoted = read(child).match(/(['"])P[0-6]\1/g) ?? [];
      if (quoted.length) found.set(child.split('/').join('/'), quoted.length);
    }
  };
  for (const r of roots) if (existsSync(join(REPO_ROOT, r))) walk(r);

  const unregistered = [...found.keys()].filter((f) => !QUOTED_PN_ALLOWLIST[f]);
  assert.deepEqual(unregistered, [], `unregistered quoted Pn vocabulary (register it in QUOTED_PN_ALLOWLIST with its namespace):\n${unregistered.join('\n')}`);

  const gone = Object.keys(QUOTED_PN_ALLOWLIST).filter((f) => !found.has(f));
  assert.deepEqual(gone, [], `allowlist rows no longer carry any quoted Pn - prune them:\n${gone.join('\n')}`);
});

test('the guard is not vacuous: both registered namespaces really are present', () => {
  for (const [file, ns] of Object.entries(QUOTED_PN_ALLOWLIST)) {
    const text = read(file);
    assert.ok(/(['"])P[0-6]\1/.test(text), `${file} (${ns}) still quotes a Pn value`);
    assert.ok(TERMINOLOGY.namespaces[ns], `namespace "${ns}" is registered in governance.terminology`);
  }
  const counts = Object.values(QUOTED_PN_ALLOWLIST).reduce((a, ns) => ((a[ns] = (a[ns] ?? 0) + 1), a), {});
  assert.ok(counts.telemetryPriorityClass >= 3, 'the telemetry namespace has its three locked contracts');
  assert.ok(counts.program >= 3, 'the program-as-data-value namespace is represented');
});

test('a quoted Pn registered as "program" really is a canonical Program ID', () => {
  const valid = new Set(REGISTER.programs.map((p) => p.id));
  for (const [file, ns] of Object.entries(QUOTED_PN_ALLOWLIST)) {
    if (ns !== 'program') continue;
    for (const m of read(file).matchAll(/(['"])(P[0-6])\1/g)) {
      assert.ok(valid.has(m[2]), `${file} quotes '${m[2]}' as a Program, but the register has no such Program`);
    }
  }
});

test('the two priority-shaped scales are never conflated in one module', () => {
  // A file that quotes BOTH a telemetry priority class and the Manager ladder is the collision the
  // protocol exists to prevent. Today no module may carry Priority-NN as a data value at all: the
  // ladder is a reporting vocabulary, not a runtime one.
  for (const [file] of Object.entries(QUOTED_PN_ALLOWLIST)) {
    assert.doesNotMatch(read(file), /(['"])Priority-0\d\1/, `${file} must not serialize the Manager ladder as data`);
  }
  const roots = ['apps/n8n-lego/src', 'packages'];
  const walk = (rel) => {
    for (const name of readdirSync(join(REPO_ROOT, rel))) {
      const child = join(rel, name);
      if (statSync(join(REPO_ROOT, child)).isDirectory()) { walk(child); continue; }
      if (!/\.(mjs|js|ts)$/.test(child)) continue;
      assert.doesNotMatch(read(child), /(['"])Priority-0\d\1/, `${child} serializes the Manager ladder as a data value`);
    }
  };
  for (const r of roots) if (existsSync(join(REPO_ROOT, r))) walk(r);
});

/* --------------------------------------------- 4. canonical identity is untouched (both ways) */

test('every Program P0-P11 still resolves with its canonical title', () => {
  const titles = {
    P0: 'Core Application Bootstrap',
    P1: 'n8n Compatibility / Behavioral Baseline',
    P2: 'LEGO / AI / Plugin Foundation',
    P3: 'Workflow + Execution + Unlimited Nodes',
    P4: 'Trigger / Webhook / Ingress',
    P5: 'Identity / Authentication / Authorization / Credentials (Security)',
    P6: 'Node Registry / Node Runtime',
    P7: 'Dynamic Parameters / Schema Runtime',
    P8: 'Storage / Data Layer',
    P9: 'Observability / Diagnostics / Operations',
    P10: 'Multi-Tenant / Isolation / Quota',
    P11: 'Worker / Distributed Scaling / HA',
  };
  assert.deepEqual(REGISTER.programs.map((p) => p.id), Object.keys(titles), 'top level is exactly P0-P11');
  for (const [id, title] of Object.entries(titles)) {
    assert.equal(REGISTER.programs.find((p) => p.id === id).title, title, `${id} title unchanged`);
  }
  assert.equal(TERMINOLOGY.namespaces.program.tokens, 'P0-P11');
});

test('canonical slice IDs still resolve - a vocabulary change orphaned none of them', () => {
  const all = new Set([...REGISTER.programs, ...REGISTER.futurePrograms].flatMap((e) => (e.slices ?? []).map((s) => s.id)));
  for (const id of ['P2-S03', 'P2-S07', 'P2-S29', 'P5-M05', 'P5-M06', 'P6-S03', 'P6-S04', 'P6-S05', 'P8-S01', 'P10-S01', 'P11-S01', 'P3 Slice A', 'P3 Slice B']) {
    assert.ok(all.has(id), `slice ${id} still resolves`);
  }
  // The M in a historical slice ID is part of its identity, not a global Milestone namespace.
  assert.match(TERMINOLOGY.namespaces.milestone.rule, /NOT evidence of one global Milestone namespace/);
});

test('the immutable historical sub-milestone ladder is intact', () => {
  const ids = REGISTER.milestones.map((m) => m.id);
  assert.ok(ids.includes('P2.27'), 'P2.27 present');
  const p2 = REGISTER.programs.find((p) => p.id === 'P2').slices.map((s) => s.id);
  for (const id of ['P2.11', 'P2.12', 'P2.27', 'P2.27.0', 'P2.27.10']) assert.ok(p2.includes(id), `${id} present`);
  assert.match(REGISTER.governance.rule, /milestones\[\] array is the historical P2 granular ladder and stays immutable/);
});

test('the executionPointer still resolves and uses no ambiguous Pn for urgency', () => {
  const ep = REGISTER.executionPointer;
  assert.equal(typeof ep.lastVerifiedMain, 'string');
  assert.match(ep.lastVerifiedMain, /^[0-9a-f]{40}$/, 'lastVerifiedMain is a full 40-hex SHA');
  assert.deepEqual(ep.activeSlices, [], 'no active slices at the time of this vocabulary change');
  assert.equal(ep.latestCompletedSlice.id, 'P2-S03');
  // No field of the pointer may carry a bare Pn as an urgency label.
  const json = JSON.stringify(ep);
  assert.doesNotMatch(json, /"(priority|urgency|severity)":\s*"P\d"/, 'the pointer carries no Pn-shaped priority');
});

/* ------------------------------------------- 5. vocabulary cleanup is not delivery (pinned) */

test('progress is byte-for-byte unchanged by the vocabulary separation - no inflation', () => {
  const m = headlineMetrics(REGISTER);
  // Pinned at the accounting baseline of the register as it stands on main. A vocabulary PR
  // that moves any of these is claiming delivery it did not make.
  // Refresh 2026-09-30 (governance: five FUTURE-* slices activated into P0-P11 as P2-M01 /
  // P3-M01 / P4-M01 / P8-M01 / P11-M02, their origin rows `superseded`, PR #412): denominator
  // 193 -> 198, slice completion 97.9 -> 95.5, realtime 97.9 -> 95.5, checkpoint points
  // 19300 -> 19800. The numerator 189, earned 18900 and the global 190/199 = 95.5 are
  // untouched. That movement is #412's activation - it is not delivery claimed by this
  // vocabulary PR, and the census guard below still proves no row changed status here.
  assert.equal(m.current.total, 198, 'current-delivery denominator');
  assert.equal(m.current.implemented, 189, 'current-delivery numerator');
  assert.equal(m.current.percent, 95.5, 'current slice completion');
  assert.equal(m.current.realtime, 95.5, 'current realtime delivery progress');
  assert.equal(m.current.earned, 18900, 'checkpoint-weighted earned points');
  assert.equal(m.current.points, 19800, 'checkpoint-weighted total points');
  const g = accountingBreakdown(REGISTER).global;
  assert.equal(g.total, 199, 'global denominator');
  assert.equal(g.implemented, 190, 'global numerator');
  assert.equal(g.percent, 95.5, 'global completion');
  assert.match(TERMINOLOGY.notDelivery, /Vocabulary cleanup is not delivery/);
  assert.match(TERMINOLOGY.notDelivery, /contributes 0 to Realtime Delivery Progress/);
});

test('no status, DEC id, merge SHA or queue entry was moved to make the vocabulary tidy', () => {
  const all = [...REGISTER.programs, ...REGISTER.futurePrograms].flatMap((e) => (e.slices ?? []));
  const counts = {};
  for (const s of all) counts[s.status] = (counts[s.status] ?? 0) + 1;
  // RAW ROWS across programs + futurePrograms = 205: 191 implemented, 2 proposed, 7 planned,
  // 5 superseded (the FUTURE-* rows PR #412 activated into P0-P11 keep their history here).
  // The COUNTED figures are 199 / 190 because governance excludes the aggregate parent `P2.27`
  // (its delivery is represented by its P2.27.x children) and superseded rows (they left the
  // active denominator, which is why the five activated rows moved no percentage). Both are
  // pinned: the raw census proves no row changed status, the counted figures in the test above
  // prove no progress moved.
  assert.deepEqual(counts, { implemented: 191, proposed: 2, planned: 7, superseded: 5 }, 'raw slice status census unchanged');
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 205, 'raw row count unchanged');
  const ep = REGISTER.executionPointer;
  assert.deepEqual(ep.verifyingSlices, []);
  assert.deepEqual(ep.plannedQueue, []);
  assert.deepEqual(ep.blockedSlices, []);
  // lastVerifiedMain is NOT pinned to a literal here. It legitimately moves on main
  // through governance reconciliation (DEC-0021 telemetry: post-merge verification bumps
  // it), so pinning the value would make a lawful main-side bump look like a vocabulary
  // defect - and would pressure a future Manager into editing the canonical register just
  // to make this test pass. What this guard must prove is that the VOCABULARY work left
  // executionPointer semantics alone, so it asserts shape and meaning instead of a value.
  assert.match(
    ep.lastVerifiedMain,
    /^[0-9a-f]{40}$/,
    'lastVerifiedMain is a full 40-hex commit SHA (its value is main-owned, not pinned here)',
  );
  assert.equal(ep.historicalLastP2Milestone, REGISTER.currentMilestone, 'the historical pointer still tracks currentMilestone');
  assert.match(ep.latestCompletedSlice.mergeSha, /^[0-9a-f]{40}$/, 'latestCompletedSlice keeps a real merge SHA');
  assert.equal(typeof ep.latestCompletedSlice.id, 'string');
  assert.equal(typeof ep.latestCompletedSlice.pr, 'number');
  // the pointer keeps exactly its declared shape: a vocabulary change adds no key and drops none
  assert.deepEqual(
    Object.keys(ep).sort(),
    [
      'activeSlices', 'authority', 'blockedSlices', 'historicalLastP2Milestone',
      'latestCompletedSlice', 'lastVerifiedMain', 'notAuthorized', 'plannedQueue',
      'updateRule', 'verifyingSlices',
    ].sort(),
    'executionPointer key set unchanged by the vocabulary work',
  );
  // and the pointer still says what it said: main-owned authority, planned != authorized
  assert.match(ep.authority, /main \(DEC-0020\)/, 'authority still names main as the owner');
  assert.match(ep.notAuthorized, /planned is not authorized by itself/, 'planned != authorized survives');
  assert.match(ep.updateRule, /DEC-0020 \+ DEC-0021/, 'the two-path update rule survives');
});

/* ------------------------------------------------------------------ 6. the prose authority */

test('the vocabulary protocol document exists and carries every namespace and ambiguity', () => {
  assert.ok(existsSync(join(REPO_ROOT, VOCAB_DOC)), VOCAB_DOC);
  const doc = read(VOCAB_DOC);
  assert.match(doc, /PROGRAM ID\s*≠\s*PRIORITY ID|PROGRAM ID != PRIORITY ID/);
  for (const t of PRIORITY_TOKENS) assert.ok(doc.includes(t), `${t} documented`);
  for (const t of UI_PHASES) assert.ok(doc.includes(t), `${t} documented`);
  for (const id of ['AMBIGUITY-01', 'AMBIGUITY-02', 'AMBIGUITY-03']) {
    assert.ok(doc.includes(id), `${id} reported (NO BLIND REFACTOR: reported, not chosen)`);
  }
  for (const field of ['PRIORITY:', 'PROGRAM:', 'MILESTONE:', 'SLICE:', 'BRANCH:', 'PR:', 'HEAD SHA:', 'STATUS:', 'EVIDENCE:']) {
    assert.ok(doc.includes(field), `report field ${field} documented`);
  }
  assert.match(doc, /MILESTONE: N\/A/, 'an unknown milestone is N/A, never invented');
  assert.match(doc, /telemetry/i, 'the untouched locked-contract namespace is explained');
  assert.match(doc, /not delivery|NOT changed/i, 'it states what it deliberately left alone');
});

test('every open ambiguity records the six fields the NO BLIND REFACTOR rule requires', () => {
  assert.ok(TERMINOLOGY.openAmbiguities.length >= 3, 'at least the three found ambiguities');
  for (const a of TERMINOLOGY.openAmbiguities) {
    for (const f of ['id', 'field', 'location', 'currentMeaning', 'possibleMeanings', 'recommendation', 'authorityRequired', 'status']) {
      assert.ok(a[f] !== undefined, `${a.id ?? '?'} records ${f}`);
    }
    assert.ok(Array.isArray(a.possibleMeanings) && a.possibleMeanings.length >= 2, `${a.id} lists the competing readings`);
    assert.match(a.status, /NOT changed/, `${a.id} was reported, not silently chosen`);
  }
  const ids = TERMINOLOGY.openAmbiguities.map((a) => a.id);
  assert.deepEqual(new Set(ids).size, ids.length, 'ambiguity ids are unique');
});

/* ------------------------------------------------------------------ 8. README v2.0 documentation layer */

const README = read('README.md');
const BEGIN_MARK = '<!-- BEGIN GENERATED milestone-governance:';
const END_MARK = '<!-- END GENERATED milestone-governance -->';
const LEGEND_HEADING = '## How to read this register';
const legendStart = README.indexOf(LEGEND_HEADING);
const beginMark = README.indexOf(BEGIN_MARK);
const endMark = README.indexOf(END_MARK);
/** The curated legend only - everything before the generated block starts. */
const LEGEND = legendStart >= 0 && beginMark > legendStart ? README.slice(legendStart, beginMark) : '';
/** Whitespace-normalised, so a hard-wrapped list still matches a joined one. */
const flat = (text) => text.replace(/\s+/g, ' ');

test('the README carries a v2.0 documentation layer, entirely outside the generated block', () => {
  assert.ok(legendStart > 0, `"${LEGEND_HEADING}" exists in README.md`);
  assert.ok(beginMark > legendStart, 'the legend precedes the generated block, so the generator never touches it');
  assert.ok(endMark > beginMark, 'the generated block is still marker-delimited');
  assert.match(LEGEND, /Documentation layer: README v2\.0/, 'it declares the layer version');
  // Curated content must survive regeneration: the legend is not inside the markers.
  assert.ok(!README.slice(beginMark, endMark).includes(LEGEND_HEADING), 'the generated block does not contain the legend');
});

test('the README layer names all five namespaces a reader meets in the register table', () => {
  for (const heading of [
    '### PROGRAM — identity, `P0`–`P11`, permanent',
    '### PRIORITY — operational urgency, `Priority-00`–`Priority-06`',
    '### MILESTONE — grouping inside a program, `Pn.m`, historical and immutable',
    '### SLICE — delivery identity, one PR each (DEC-0014)',
    '### STATUS — `governance.statusVocabulary`, and nothing else',
  ]) {
    assert.ok(LEGEND.includes(heading), `README explains ${heading}`);
  }
  assert.match(LEGEND, /### A complete work record/, 'and it works one full record end to end');
  for (const field of ['PRIORITY:', 'PROGRAM:', 'MILESTONE:', 'SLICE:', 'STATUS:']) {
    assert.ok(LEGEND.includes(field), `the worked record shows ${field}`);
  }
});

test('every Program title in the README layer matches the canonical register exactly', () => {
  const rows = new Map();
  for (const m of LEGEND.matchAll(/^\| `(P\d{1,2})` \| (.+?) \|$/gm)) rows.set(m[1], m[2]);
  assert.equal(rows.size, REGISTER.programs.length, `${REGISTER.programs.length} programs documented`);
  for (const program of REGISTER.programs) {
    assert.equal(rows.get(program.id), program.title, `${program.id} title is quoted from the register, not paraphrased`);
  }
});

test('every Priority meaning in the README layer matches the canonical scale exactly', () => {
  const rows = new Map();
  for (const m of LEGEND.matchAll(/^\| `(Priority-\d\d)` \| (.+?) \|$/gm)) rows.set(m[1], m[2]);
  const scale = TERMINOLOGY.namespaces.priority.scale;
  assert.deepEqual([...rows.keys()].sort(), [...PRIORITY_TOKENS].sort(), 'exactly the seven tokens');
  for (const token of PRIORITY_TOKENS) {
    assert.equal(rows.get(token), scale[token], `${token} means "${PRIORITY_MEANINGS[token]}"`);
    assert.equal(rows.get(token), PRIORITY_MEANINGS[token], `${token} keeps the owner-defined wording`);
  }
});

test('the README status list is governance.statusVocabulary, exactly and in order', () => {
  const section = flat(LEGEND.split('### STATUS')[1].split('### One more namespace')[0]);
  const joined = REGISTER.governance.statusVocabulary.map((s) => `\`${s}\``).join(', ');
  assert.ok(section.includes(joined), 'all nine slice statuses, in register order, no extras');
  assert.match(section, /complete` \/ `in-progress` \/ `planned/, 'and it separates the program-status vocabulary from the slice one');
  assert.match(section, /is \*\*not\*\* a slice percentage/, 'program state is not a completion figure');
});

test('the README layer declares the registerVersion it projects, so it cannot drift', () => {
  assert.match(REGISTER.registerVersion, /^\d+\.\d+\.\d+$/, 'the register is semver');
  assert.ok(LEGEND.includes(`register ${REGISTER.registerVersion}`),
    `the curated layer names register ${REGISTER.registerVersion} - a stale legend fails here`);
  // The generated freshness line must agree with the curated one: two layers, one version.
  assert.match(README, new RegExp(`from register ${REGISTER.registerVersion.replace(/\./g, '\\.')} \\(fingerprint \`[0-9a-f]{16}\`\\)`),
    'the generated block projects the same register version');
  assert.ok(LEGEND.includes('docs/engineering-operations/VOCABULARY.md'), 'and it points at the prose authority');
});

test('the README layer states the non-inference rule with worked contrasts', () => {
  assert.match(flat(LEGEND), /A namespace must not be inferred from another namespace/, 'the rule itself');
  const block = LEGEND.split('```text')[1].split('```')[0];
  const contrasts = block.split('\n').map((l) => l.trim()).filter((l) => l.includes('!=')).map((l) => l.split('!=')[0].trim());
  assert.ok(contrasts.length >= 5, `${contrasts.length} worked contrasts`);
  for (const pair of ['P2', 'P5', 'Pn-Mnn', 'UI-PHASE-05', 'telemetry P0']) {
    assert.ok(contrasts.includes(pair), `"${pair}" is contrasted against the namespace it is confused with`);
  }
  assert.match(block, /Pn-Mnn\s*!=\s*Milestone-nn/, 'the M in a slice id is Maintenance, not Milestone');
});

test('the README layer teaches shapes and states no canonical slice or milestone fact', () => {
  // governance-register.test.mjs:331 forbids milestone/slice IDs outside the generated block,
  // because a curated layer that recites canonical state becomes a second authority and goes
  // stale. This asserts the same invariant from the vocabulary side, so the two gates agree.
  const liveIds = LEGEND.match(/\bP\d+(?:\.\d+|-[SM]\d{2})\b/g) ?? [];
  assert.deepEqual(liveIds, [], 'no Pn.m / Pn-Snn / Pn-Mnn in the curated layer');
  for (const shape of ['`Pn.m`', '`Pn-Snn`', '`Pn-Mnn`']) {
    assert.ok(LEGEND.includes(shape), `${shape} is taught as a shape, with n and nn as placeholders`);
  }
  assert.match(LEGEND, /shapes, not facts/, 'and it says why');
  assert.match(LEGEND, /would be a second authority/, 'naming the failure mode it avoids');
  // Bare Program IDs are permanent identity, not state, so the legend may name all twelve.
  assert.equal((LEGEND.match(/^\| `P\d{1,2}` \|/gm) ?? []).length, 12, 'the twelve Programs may be named');
});

test('the README layer says it is a projection, not an authority', () => {
  assert.match(LEGEND, /it does not define them/, 'it explains identifiers without defining them');
  assert.match(LEGEND, /The\s+register is the only authority/, 'the register stays the only authority');
  assert.match(LEGEND, /DEC-0020/, 'by the decision that makes milestone truth main-owned');
  assert.match(LEGEND, /npm run lego:ai:check/, 'and it names the check that keeps the layers in sync');
  assert.ok(!/authoritative source|source of truth for delivery/i.test(LEGEND), 'it never claims to originate state');
});

/* ------------------------------------------------------------------ 9. the register version decision */

test('this additive cycle bumped a MINOR, not a MAJOR - the repository precedent decides', () => {
  const [major, minor, patch] = REGISTER.registerVersion.split('.').map(Number);
  assert.equal(REGISTER.registerVersion, '2.5.0', 'registerVersion after this cycle');
  assert.equal(major, 2, 'MAJOR unchanged: no canonical re-foundation happened');
  assert.equal(minor, 5, 'MINOR bumped from 2.4.0: an additive governance rule');
  assert.equal(patch, 0);
  const policy = TERMINOLOGY.versionPolicy;
  assert.ok(policy, 'governance.terminology.versionPolicy exists');
  assert.match(policy.thisChange, /2\.4\.0 -> 2\.5\.0/, 'the transition is recorded');
  assert.match(policy.thisChange, /MINOR/, 'and classified');
  assert.match(policy.majorMeans, /8b7bd19b/, 'the one MAJOR precedent is cited by commit');
  assert.match(policy.majorMeans, /governance reset/, 'and by what it actually was');
  for (const dec of ['DEC-0020', 'DEC-0021', 'DEC-0024']) {
    assert.match(policy.minorMeans, new RegExp(dec), `${dec} cited as a MINOR precedent`);
  }
});

test('the 3.0.0 question is an open authority item, not a silent decision', () => {
  const policy = TERMINOLOGY.versionPolicy;
  assert.match(policy.v3Question, /3\.0\.0/, 'the requested label is addressed');
  assert.match(policy.v3Question, /open authority item|authority item/i, 'and left open rather than assumed');
  assert.match(policy.v3Question, /VOCABULARY\.md section 12/, 'with a pointer to the reasoning');
  assert.match(policy.authority, /owner/i, 'the escalation path names the owner');
  const doc = read(VOCAB_DOC);
  assert.match(doc, /## 12\. The register version decision: 2\.5\.0, not 3\.0\.0/, 'VOCABULARY.md §12 states the decision');
  assert.match(doc, /AUTHORITY — open, owner decision required/, 'as an explicit authority item');
  assert.ok(doc.includes('| `2.0.0` | `8b7bd19b` |'), 'with the full transition table as evidence');
});

/* ------------------------------------------------------------------ 10. documentation layers, and the word overload */

test('documentationLayers registers every layer with a kind and a version mechanism', () => {
  const dl = TERMINOLOGY.documentationLayers;
  assert.ok(dl, 'governance.terminology.documentationLayers exists');
  assert.match(dl.rule, /may never originate it/, 'a projection may restate but not originate');
  assert.match(dl.rule, /may never contradict the register/, 'curated prose may not contradict canonical state');
  const byId = new Map(dl.layers.map((l) => [l.id, l]));
  for (const id of ['canonical-register', 'generated-projection', 'curated-prose', 'readme-documentation-layer']) {
    assert.ok(byId.has(id), `layer "${id}" is registered`);
  }
  assert.equal(byId.get('canonical-register').kind, 'AUTHORITY', 'exactly one authority');
  assert.equal(dl.layers.filter((l) => l.kind === 'AUTHORITY').length, 1, 'and never a second one');
  assert.equal(byId.get('generated-projection').kind, 'GENERATED');
  assert.equal(byId.get('curated-prose').kind, 'CURATED');
  const readme = byId.get('readme-documentation-layer');
  assert.equal(readme.version, 'README v2.0', 'the README layer version');
  assert.ok(readme.contract.length > 200, 'its contract is documented, not just asserted');
  assert.match(readme.contract, /PROGRAM, PRIORITY, MILESTONE, SLICE, STATUS/, 'the contract names the five namespaces');
  assert.match(readme.whyVersionedSeparately, /declares no version string of its own/, 'and admits the label is new');
});

test('the capability vocabulary lock is disjoint from the identifier namespaces, and was not renamed', () => {
  const LOCK = 'packages/frontend-lego/src/vocabulary.mjs';
  const LOCK_TEST = 'packages/frontend-lego/test/24-vocabulary.test.mjs';
  assert.ok(existsSync(join(REPO_ROOT, LOCK)), LOCK);
  assert.ok(existsSync(join(REPO_ROOT, LOCK_TEST)), LOCK_TEST);
  const lock = read(LOCK);
  // A bare Program token would mean the two namespaces had touched. Dot-notation historical
  // ids (P2.13, P2.14) are provenance metadata and are expected - they are not Program tokens.
  const bare = lock.match(/\bP(?:[0-9]|1[01])\b(?!\.\d)/g) ?? [];
  assert.deepEqual(bare, [], 'the capability lock carries no bare P0-P11 token');
  assert.ok(/\bP2\.1[0-9]\b/.test(lock), 'it does quote dot-notation historical ids as provenance');
  for (const symbol of ['VOCABULARIES', 'DECLARED_OVERLAPS', 'detectCollisions', 'vocabularyDrift']) {
    assert.ok(lock.includes(symbol), `the lock still exports ${symbol} - untouched by this cycle`);
  }
  const overload = TERMINOLOGY.documentationLayers.wordOverload;
  assert.ok(overload.includes(LOCK), 'the register names the capability lock');
  assert.ok(overload.includes(LOCK_TEST), 'and its test');
  assert.match(overload, /IDENTIFIER NAMESPACES/, 'and states which sense this protocol governs');
  assert.match(read(VOCAB_DOC), /## 13\. The word "vocabulary" is itself overloaded/, 'VOCABULARY.md §13 records the overload');
});

/* ------------------------------------------------------------------ 11. milestone namespace discipline */

test('no Milestone-NN was invented in the canonical register', () => {
  const raw = read('docs/n8n-lego/milestones.json');
  assert.equal((raw.match(/Milestone-[0-9]+/g) ?? []).length, 0,
    'the register invents no Milestone-NN grouping - the canonical shape is Pn.m dot notation');
  assert.equal(REGISTER.currentMilestone, 'P2.27', 'currentMilestone is still dot notation');
  assert.equal(REGISTER.previousCompletedMilestone, 'P2.26', 'and so is previousCompletedMilestone');
  for (const row of REGISTER.milestones) {
    assert.match(row.id, /^P\d+\.\d+/, `milestone ${row.id} keeps its canonical dot-notation id`);
  }
  assert.match(TERMINOLOGY.namespaces.milestone.rule, /NOT evidence of one global Milestone namespace/,
    'the rule says the M in P5-M05 is not a milestone namespace');
  // The counter-example is written with placeholders, so no Milestone-NN token exists anywhere
  // in the repo: not as a grouping, not even as an illustration.
  const readmeHits = README.match(/Milestone-[0-9]+/g) ?? [];
  assert.deepEqual(readmeHits, [], 'README invents no Milestone-NN either');
  const docHits = read(VOCAB_DOC).match(/Milestone-[0-9]+/g) ?? [];
  assert.deepEqual(docHits, [], 'and neither does the protocol document');
  assert.match(LEGEND, /Pn-Mnn\s*!=\s*Milestone-nn/, 'the contrast is taught with placeholders');
  assert.match(LEGEND, /no global `Milestone-XX` namespace/, 'README states plainly that the namespace does not exist here');
});

test('the slice shapes in the README are governance.sliceNaming, verbatim in meaning', () => {
  const naming = REGISTER.governance.sliceNaming;
  assert.match(naming.maintenance, /^Pn-Mnn/, 'maintenance slices are Pn-Mnn');
  assert.match(naming.feature, /^Pn-Snn/, 'feature slices are Pn-Snn');
  assert.match(naming.historical, /^Pn\.m/, 'historical ids are Pn.m and immutable');
  for (const shape of ['`Pn-Snn`', '`Pn-Mnn`', '`Pn.m`', '`<FUTURE-PROGRAM>-Snn`']) {
    assert.ok(LEGEND.includes(shape), `README documents the ${shape} shape`);
  }
  assert.match(LEGEND, /Maintenance/, 'and says what the M actually means');
  assert.match(LEGEND, /never renamed for vocabulary reasons/, 'with the reason renaming is forbidden');
});
