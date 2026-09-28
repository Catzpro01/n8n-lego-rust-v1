/**
 * Progress accounting governance (A-J) - the accounting repair of 2026-09-28
 * (evidence docs/n8n-lego/evidence/PROGRESS-ACCOUNTING-AUDIT.md).
 *
 * A. Inventory completeness   - every progress-counted item has a canonical record
 * B. No orphan                - every item resolves to a program and parents resolve
 * C. No duplicate counting    - one delivery item is counted exactly once
 * D. Deterministic aggregation- same register in, same progress out
 * E. Projection consistency   - README projection == canonical derived progress
 * F. Evidence consistency     - implemented/verified rows carry their evidence
 * G. Queue independence      - plannedQueue is an execution queue, not inventory
 * H. Progress delta           - every status transition moves progress explainably
 * I. Zero unexplained progress- displayed numbers decompose into counted ids
 * J. Zero invisible completion- no completed item escapes the calculation
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  accountingRows, accountingBreakdown, aggregateParentIds, progressRoleOf,
  excludedRows, isVerifiedRow, completionTally, headlineMetrics, percent1,
  renderReadmeMilestoneSection, sliceRecords, validateGovernanceRegister,
  validateSliceCheckpoints,
} from '../../../tools/lego/governance-register.mjs';

const REGISTER_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'n8n-lego', 'milestones.json');
const REGISTER = JSON.parse(readFileSync(REGISTER_PATH, 'utf8'));
const RECORDS = sliceRecords(REGISTER);
const ALL = RECORDS.map((record) => record.slice);
const BY_ID = new Map(ALL.map((slice) => [slice.id, slice]));
const BREAKDOWN = accountingBreakdown(REGISTER);

function countedIdsOf(programId) {
  const program = BREAKDOWN.programs.find((entry) => entry.id === programId);
  assert.ok(program, `${programId} is in the breakdown`);
  return program.countedIds;
}

/* --------------------------------------------------------------- A (inventory) */

test('A every progress-counted item has a canonical register record', () => {
  const counted = accountingRows(ALL);
  assert.ok(counted.length > 0);
  for (const slice of counted) {
    assert.ok(slice.id && typeof slice.id === 'string', 'counted row has an id');
    assert.ok(slice.status, `${slice.id} has a status`);
    assert.ok(RECORDS.some((record) => record.slice === slice), `${slice.id} is a register row`);
    assert.ok(BREAKDOWN.programs.some((program) => program.countedIds.includes(slice.id)), `${slice.id} is counted by exactly one program breakdown`);
  }
});

test('A the accounting breakdown covers P0-P11 and every future program', () => {
  const ids = BREAKDOWN.programs.map((program) => program.id);
  for (const expected of ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11']) {
    assert.ok(ids.includes(expected), `${expected} is inventoried`);
  }
  assert.ok(ids.filter((id) => id.startsWith('FUTURE-')).length >= 5, 'future programs are inventoried');
  assert.equal(BREAKDOWN.programs.length, REGISTER.programs.length + REGISTER.futurePrograms.length);
});

/* -------------------------------------------------------------------- B (orphan) */

test('B no orphan: every item resolves to its program and every parent resolves', () => {
  for (const record of RECORDS) {
    assert.ok(record.parentId, `${record.slice.id} has a program parent`);
  }
  for (const slice of ALL) {
    if (slice.parentSlice) {
      assert.ok(BY_ID.has(slice.parentSlice), `${slice.id}: parentSlice ${slice.parentSlice} exists`);
    }
  }
  for (const id of [...REGISTER.executionPointer.plannedQueue, ...REGISTER.executionPointer.activeSlices, ...REGISTER.executionPointer.blockedSlices]) {
    assert.ok(BY_ID.has(id), `pointer id ${id} resolves to a register row`);
  }
});

/* ----------------------------------------------------------------- C (no double) */

test('C one delivery item is counted exactly once (unique ids, disjoint counted/excluded)', () => {
  const ids = ALL.map((slice) => slice.id);
  assert.equal(new Set(ids).size, ids.length, 'slice ids are unique');
  const counted = new Set(accountingRows(ALL).map((slice) => slice.id));
  const excluded = excludedRows(ALL);
  for (const entry of excluded) {
    assert.equal(counted.has(entry.id), false, `${entry.id} is excluded and not counted`);
    assert.ok(entry.reason, `${entry.id} carries an explicit exclusion reason`);
  }
  for (const program of BREAKDOWN.programs) {
    assert.equal(new Set(program.countedIds).size, program.countedIds.length, `${program.id} counts no id twice`);
  }
});

test('C an aggregate parent is excluded and its children are the counted leaves (PPA-1)', () => {
  const aggregates = aggregateParentIds(ALL);
  assert.deepEqual([...aggregates], ['P2.27'], 'the only aggregate parent is the P2.27 ladder row');
  const parent = BY_ID.get('P2.27');
  assert.equal(progressRoleOf(parent, aggregates), 'aggregate-parent');
  // the aggregate points at the final child's delivery - the double-counting signal
  const lastChild = BY_ID.get('P2.27.10');
  assert.equal(parent.pr, lastChild.pr);
  assert.equal(parent.mergeSha, lastChild.mergeSha);
  // children stay counted (the aggregate never removes its children)
  const children = ALL.filter((slice) => slice.parentSlice === 'P2.27');
  assert.equal(children.length, 11);
  for (const child of children) {
    assert.ok(countedIdsOf('P2').includes(child.id), `${child.id} is a counted leaf`);
  }
  assert.equal(countedIdsOf('P2').includes('P2.27'), false, 'the aggregate itself is not counted');
});

test('C range rollup rows do not overlap individual rows (each historical milestone once)', () => {
  const ids = new Set(ALL.map((slice) => slice.id));
  for (const range of ALL.filter((slice) => /^\d|P\d+\.\d+-P\d+\.\d+$/.test(slice.id) && slice.id.includes('-P'))) {
    // e.g. P2.1-P2.4 covers P2.1..P2.4; none of those may exist as their own row
    const [from, to] = range.id.split('-');
    const [pf, mf] = from.split('.');
    const mt = Number(to.split('.')[1]);
    for (let i = Number(mf); i <= mt; i += 1) {
      assert.equal(ids.has(`${pf}.${i}`), false, `${pf}.${i} is covered by rollup ${range.id}, not a second row`);
    }
    assert.ok(countedIdsOf(pf).includes(range.id), `rollup ${range.id} counts once`);
  }
});

/* ----------------------------------------------------------- D (deterministic) */

test('D the same register always aggregates to the same progress', () => {
  const again = accountingBreakdown(JSON.parse(readFileSync(REGISTER_PATH, 'utf8')));
  assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(BREAKDOWN)));
  const tally1 = completionTally(ALL);
  const tally2 = completionTally(ALL.slice());
  assert.deepEqual(tally2, tally1);
});

test('D the counting rule is documented and derivable (roles come from the schema)', () => {
  const aggregates = aggregateParentIds(ALL);
  for (const slice of ALL) {
    const role = progressRoleOf(slice, aggregates);
    assert.ok(['leaf', 'aggregate-parent', 'excluded-explicit'].includes(role), `${slice.id} role ${role}`);
    if (role === 'aggregate-parent') {
      assert.ok(ALL.some((other) => other.parentSlice === slice.id), `${slice.id} is aggregate because rows name it as parentSlice`);
    }
    if (role === 'excluded-explicit') {
      assert.equal(slice.countedInProgress, false, `${slice.id} is excluded by its explicit flag`);
    }
    if (role === 'leaf') {
      assert.equal(slice.countedInProgress ?? true, true, `${slice.id} is not explicitly excluded`);
      assert.equal(aggregates.has(slice.id), false, `${slice.id} is nobody's aggregate`);
    }
  }
});

/* -------------------------------------------------------- E (projection == canon) */

test('E the README projection equals the canonical derived projection', () => {
  const readme = readFileSync(join(REGISTER_PATH, '..', '..', '..', 'README.md'), 'utf8');
  const block = renderReadmeMilestoneSection(REGISTER);
  assert.ok(readme.includes(block), 'README carries the generated block rendered from the register');
  const metrics = headlineMetrics(REGISTER);
  assert.match(block, new RegExp(`\\*\\*${String(metrics.current.sliceCompletion.toFixed(1))}`), 'projection shows the derived slice completion');
});

/* ------------------------------------------------------------- F (evidence) */

test('F implemented rows carry evidence and verified rows carry a verification SHA', () => {
  for (const slice of ALL) {
    if (slice.status === 'implemented' && slice.kind !== 'historical') {
      assert.ok(String(slice.evidence ?? '').trim(), `${slice.id} is implemented with evidence`);
    }
    if (slice.postMergeVerified !== undefined) {
      assert.equal(slice.status, 'implemented', `${slice.id} can only be verified when implemented`);
      assert.ok(isVerifiedRow(slice), `${slice.id} postMergeVerified is a 40-hex verification SHA`);
      assert.match(String(slice.evidence), /post-merge/i, `${slice.id} evidence records the post-merge verification`);
    }
    for (const problem of validateSliceCheckpoints(slice)) {
      assert.fail(`${slice.id}: ${problem}`);
    }
  }
});

/* --------------------------------------------------------- G (queue independence) */

test('G the plannedQueue is an execution queue, not the program inventory', () => {
  const queue = REGISTER.executionPointer.plannedQueue;
  assert.equal(queue.length, 18, 'the queue holds the executable P2 tail only');
  assert.equal(BREAKDOWN.global.total, 199, 'the denominator is the inventory, not the queue');
  for (const id of queue) {
    const slice = BY_ID.get(id);
    assert.equal(slice.status, 'planned', `${id} is queued and planned`);
    assert.equal(countedIdsOf('P2').includes(id), true, `${id} is in the P2 inventory denominator`);
  }
});

test('G accounting does not move queue membership or any pointer state', () => {
  const clone = structuredClone(REGISTER);
  clone.programs.find((program) => program.id === 'P2').slices.find((slice) => slice.id === 'P2-S12').status = 'implemented';
  const before = JSON.stringify(REGISTER.executionPointer);
  accountingBreakdown(clone);
  completionTally(clone.programs.flatMap((program) => program.slices));
  assert.equal(JSON.stringify(clone.executionPointer), before, 'accounting is read-only over the pointer');
  assert.deepEqual(clone.executionPointer.plannedQueue, REGISTER.executionPointer.plannedQueue, 'queue membership untouched');
});

/* ----------------------------------------------------------------- H (delta) */

test('H a counted transition moves progress by exactly +1, an aggregate transition by 0', () => {
  const base = completionTally(ALL);
  const flip = (id, status) => {
    const clone = structuredClone(ALL);
    clone.find((slice) => slice.id === id).status = status;
    return completionTally(clone);
  };
  const counted = flip('P2-S12', 'implemented');
  assert.equal(counted.implemented, base.implemented + 1, 'a leaf planned -> implemented is +1');
  assert.equal(counted.total, base.total, 'no denominator change');
  assert.equal(counted.percent, percent1(base.implemented + 1, base.total));
  const aggregate = flip('P2.27', 'planned');
  assert.equal(aggregate.implemented, base.implemented, 'the aggregate never moves the numerator');
  assert.equal(aggregate.total, base.total, 'the aggregate never moves the denominator');
  const blocked = flip('P2-S03', 'implemented');
  assert.equal(blocked.implemented, base.implemented + 1, 'unblocking a leaf is the same +1 with its own evidence');
});

/* --------------------------------------------------- I (zero unexplained progress) */

test('I every displayed number decomposes into counted ids (no manual figures)', () => {
  let sumCounted = 0;
  let sumImplemented = 0;
  for (const program of BREAKDOWN.programs) {
    sumCounted += program.countedIds.length;
    sumImplemented += program.countedIds.filter((id) => BY_ID.get(id).status === 'implemented').length;
    assert.equal(program.counted, program.countedIds.length, `${program.id}: counted == |countedIds|`);
    assert.equal(program.implemented, program.countedIds.filter((id) => BY_ID.get(id).status === 'implemented').length, `${program.id}: implemented decomposes`);
    assert.equal(program.percent, percent1(program.implemented, program.counted), `${program.id}: percent is derived`);
  }
  assert.equal(sumCounted, BREAKDOWN.global.total, 'global denominator == sum of counted ids');
  assert.equal(sumImplemented, BREAKDOWN.global.implemented, 'global numerator == sum of implemented counted ids');
  assert.equal(BREAKDOWN.global.percent, percent1(BREAKDOWN.global.implemented, BREAKDOWN.global.total));
});

test('I progress figures are pinned to the reconciled accounting (refresh with evidence)', () => {
  // Refresh 2026-09-28: accounting repair PPA-1 (P2.27 aggregate excluded,
  // evidence docs/n8n-lego/evidence/PROGRESS-ACCOUNTING-AUDIT.md): before
  // 171/200 = 85.5 (P2 40/60), after 170/199 = 85.4 (P2 39/59).
  assert.equal(BREAKDOWN.global.implemented, 170);
  assert.equal(BREAKDOWN.global.total, 199);
  assert.equal(BREAKDOWN.global.percent, 85.4);
  const p2 = BREAKDOWN.programs.find((program) => program.id === 'P2');
  assert.equal(p2.implemented, 39);
  assert.equal(p2.counted, 59);
  assert.deepEqual(p2.excluded.map((entry) => entry.id), ['P2.27']);
  const metrics = headlineMetrics(REGISTER);
  assert.equal(metrics.current.implemented, 169);
  assert.equal(metrics.current.total, 193);
  assert.equal(metrics.future.implemented, 1);
  assert.equal(metrics.future.total, 6);
});

/* ----------------------------------------------- J (zero invisible completion) */

test('J no completed item escapes the calculation (counted or explicitly excluded)', () => {
  const counted = new Set(accountingRows(ALL).map((slice) => slice.id));
  const excluded = new Map(excludedRows(ALL).map((entry) => [entry.id, entry.reason]));
  for (const slice of ALL) {
    if (slice.status === 'implemented') {
      assert.ok(counted.has(slice.id) || excluded.has(slice.id), `${slice.id} is implemented: counted or explicitly excluded`);
      if (excluded.has(slice.id)) assert.ok(excluded.get(slice.id), `${slice.id} has an exclusion reason`);
    }
  }
  const tally = completionTally(ALL);
  assert.equal(tally.implemented, ALL.filter((slice) => slice.status === 'implemented' && counted.has(slice.id)).length);
});

test('J the register validators stay green under the accounting rules', () => {
  assert.deepEqual(validateGovernanceRegister(REGISTER), []);
});
