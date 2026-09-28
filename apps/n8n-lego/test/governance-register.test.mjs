/**
 * Governance reset (Issue #256) — the canonical register's program / slice / feature layer, the
 * runner protocol, and the <= 1 s polling rule are enforced by machine, not by convention.
 *
 * The register (`docs/n8n-lego/milestones.json`) is the single source; the generated view
 * (`.ai/master/MILESTONE_REGISTER.md`) is kept fresh by `npm run lego:ai:check`. This test runs the
 * same validator the generator uses, then proves the validator is not vacuous by mutating a copy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { accountingRows,
  validateGovernanceRegister, TOP_LEVEL_PROGRAMS, EXPECTED_PROGRAM_STATUS, LEGACY_FUTURE_MILESTONES, countBy,
  README_MARKERS, renderReadmeMilestoneSection, syncReadmeMilestoneSection,
  completionTally, sliceRecords, percent1, completionPercentForStatus, displayStatus, verifyingIndex,
  validateMilestoneProjections, MILESTONE_AUTHORITY, HISTORICAL_P2_FINGERPRINT, historicalP2Fingerprint,
  headlineMetrics, sliceDeliveryProgress, completionContribution, programTally, validateSliceCheckpoints,
  formatPercent,
} from '../../../tools/lego/governance-register.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');
const REGISTER = JSON.parse(read('docs/n8n-lego/milestones.json'));
const GOVERNANCE = JSON.parse(read('docs/engineering-operations/workforce-governance.json'));
const clone = () => JSON.parse(JSON.stringify(REGISTER));
const slices = (register) => [...register.programs, ...register.futurePrograms].flatMap((entity) => entity.slices);

test('the canonical register passes every governance rule', () => {
  assert.deepEqual(validateGovernanceRegister(REGISTER), []);
});

test('top level is exactly P0-P11 with the recorded Manager statuses', () => {
  assert.deepEqual(REGISTER.programs.map((program) => program.id), [...TOP_LEVEL_PROGRAMS]);
  for (const program of REGISTER.programs) assert.equal(program.status, EXPECTED_PROGRAM_STATUS[program.id], program.id);
  assert.deepEqual(REGISTER.programs.filter((p) => p.status === 'complete').map((p) => p.id), ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P9']);
  assert.deepEqual(REGISTER.programs.filter((p) => p.status === 'planned').map((p) => p.id), ['P8', 'P10', 'P11']);
  assert.deepEqual(REGISTER.programs.filter((p) => p.status === 'in-progress').map((p) => p.id), ['P7'], 'P7 in-progress by owner authorization DEC-0024');
});

test('P5.1-P5.8 are recorded with their merge SHAs; P5 debt is P5-M01..M03, never P5.9', () => {
  const p5 = REGISTER.programs.find((program) => program.id === 'P5');
  const byId = new Map(p5.slices.map((slice) => [slice.id, slice]));
  const expected = {
    'P5.1': '0842a05f297b1c0fc96a3b0b65498e5c52febb49', 'P5.2': 'd8f18174697d6b8f3227490d28f5cce60e675b3c',
    'P5.3': '57606b52ff9e19ab0b57fb90d89e81a37002e75b', 'P5.4': 'ae99e9808d0685425ef99cca5005cf60a2407144',
    'P5.5': '260b838d2ab5e5de21ffa8acaeb94316cce8a39b', 'P5.6': '4e6802c84270986b519418856f95b625943edeb0',
    'P5.7': '5310bf31fd2517ea797432d9b86ed974a685bca0', 'P5.8': '87099dc0fd32264db711db3a43ef1167a84e9f96',
  };
  for (const [id, sha] of Object.entries(expected)) {
    assert.equal(byId.get(id)?.status, 'implemented', id);
    assert.equal(byId.get(id).mergeSha, sha, `${id} merge SHA`);
  }
  for (const id of ['P5-M01', 'P5-M02', 'P5-M03']) assert.equal(byId.get(id)?.kind, 'maintenance', id);
  assert.equal(byId.has('P5.9'), false);
});

test('legacy P12-P23 are consolidated into five thematic future programs, each exactly once', () => {
  assert.deepEqual(REGISTER.futurePrograms.map((future) => future.id),
    ['FUTURE-EVENT', 'FUTURE-RELIABILITY', 'FUTURE-PLATFORM', 'FUTURE-DISTRIBUTION', 'FUTURE-AI-ECOSYSTEM']);
  const legacy = REGISTER.futurePrograms.flatMap((future) => future.legacyMilestones).sort((a, b) => a.slice(1) - b.slice(1));
  assert.deepEqual(legacy, [...LEGACY_FUTURE_MILESTONES]);
  const issues = REGISTER.futurePrograms.flatMap((future) => future.legacyIssues).sort((a, b) => a - b);
  assert.deepEqual(issues, [228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239], 'every legacy planning issue stays traceable');
  for (const issue of issues) {
    assert.ok(REGISTER.features.some((feature) => feature.sourceIssue.includes(issue)), `#${issue} has at least one registered feature`);
  }
});

test('the reconciled PRs are recorded as implemented slices with post-merge verification', () => {
  const byId = new Map(slices(REGISTER).map((slice) => [slice.id, slice]));
  assert.equal(byId.get('P2-S01').pr, 244);
  assert.equal(byId.get('P2-S01').mergeSha, 'c77c3dba562e577c0f42348d55be9e5c722157ff');
  assert.equal(byId.get('FUTURE-RELIABILITY-S01').pr, 246);
  assert.equal(byId.get('FUTURE-RELIABILITY-S01').legacyMilestone, 'P21');
  for (const id of ['P2-S01', 'FUTURE-RELIABILITY-S01']) {
    assert.match(byId.get(id).postMergeVerified, /^[0-9a-f]{40}$/, `${id} records its post-merge verification`);
  }
});

test('every implemented feature is backed by a merged slice, never by an issue alone', () => {
  const byId = new Map(slices(REGISTER).map((slice) => [slice.id, slice]));
  for (const feature of REGISTER.features.filter((f) => f.status === 'implemented' && f.type !== 'governance')) {
    assert.ok(feature.slice, `${feature.id} names its slice`);
    assert.equal(byId.get(feature.slice)?.status, 'implemented', `${feature.id}: its slice is implemented`);
    assert.equal(feature.mergeSha, byId.get(feature.slice).mergeSha, `${feature.id}: SHA agrees with its slice`);
  }
  const counts = countBy(REGISTER.features, 'status');
  assert.ok(counts.implemented > 0 && counts.planned > 0);
  for (const status of Object.keys(counts)) assert.ok(REGISTER.governance.statusVocabulary.includes(status), status);
});

/* ------------------------------------------------------ the validator is not vacuous */

const MUTATIONS = [
  ['a P12 top-level program', (r) => { r.programs.push({ ...r.programs[7], id: 'P12' }); }, /exactly P0/],
  ['P5.9', (r) => { r.programs[5].slices.push({ ...r.programs[5].slices[0], id: 'P5.9' }); }, /P5\.9 is forbidden/],
  ['a changed program status', (r) => { r.programs[7].status = 'complete'; }, /Manager decision/],
  ['an implemented slice without a SHA', (r) => { r.programs[4].slices[0].mergeSha = null; }, /without a 40-hex merge SHA/],
  ['a slice named under the wrong P', (r) => { r.programs[3].slices.push({ ...r.programs[3].slices.at(-1), id: 'P4-S09' }); }, /sits under P3/],
  ['a future program named like a P', (r) => { r.futurePrograms[0].id = 'P24'; }, /FUTURE-<THEME>|never a P number/],
  ['a dropped legacy milestone', (r) => { r.futurePrograms[0].legacyMilestones = []; }, /exactly one future program/],
  ['an unknown feature status', (r) => { r.features[0].status = 'done'; }, /status "done"/],
  ['a duplicate feature id', (r) => { r.features.push({ ...r.features[0] }); }, /duplicate feature id/],
  ['an implemented feature claimed from an issue only', (r) => {
    const f = r.features.find((x) => x.status === 'planned'); f.status = 'implemented'; f.evidence = null;
  }, /implemented without evidence/],
  ['a superseded feature without replacement', (r) => { r.features.find((x) => x.status === 'planned').status = 'superseded'; }, /without supersededBy/],
  ['a slice reference into another program', (r) => { r.features.find((x) => x.parent === 'P7').slice = 'P8-S01'; }, /belongs to P8/],
  // DEC-0020: completion, in-progress and pointer semantics.
  ['a P24 top-level program', (r) => { r.programs.push({ ...r.programs[7], id: 'P24' }); }, /exactly P0/],
  ['a duplicate slice id', (r) => { r.programs[5].slices.push({ ...r.programs[5].slices.find((x) => x.id === 'P5-M09') }); }, /declared twice/],
  ['a verifying slice recorded as implemented before post-merge verification', (r) => {
    // The subject must still be un-merged, or the mutation is a no-op. Prefer the
    // first queued slice rather than pinning an id a later slice implements, and
    // fall back to any un-merged slice: draining the queue to empty must not turn
    // this mutation into a crash on `undefined`.
    const unmerged = (r) => r.programs.flatMap((program) => program.slices)
      .filter((slice) => slice.status !== 'implemented' && !slice.mergeSha);
    const subject = unmerged(r).find((slice) => r.executionPointer.plannedQueue.includes(slice.id))
      ?? unmerged(r)[0];
    subject.status = 'implemented';
  }, /implemented without a 40-hex merge SHA/],
  ['an implemented P5-M08 whose merge SHA is deleted', (r) => {
    r.programs[5].slices.find((x) => x.id === 'P5-M08').mergeSha = null;
  }, /P5-M08: implemented without a 40-hex merge SHA/],
  ['an implemented slice without evidence', (r) => { r.programs[5].slices.find((x) => x.id === 'P5-M03').evidence = null; }, /P5-M03: implemented without evidence/],
  ['an in-progress slice missing from the pointer', (r) => {
    // Whatever is queued becomes in-progress and is then dropped from every
    // pointer list, which is the state the rule exists to catch. Fall back to any
    // un-merged slice when the queue is empty, so the mutation still exercises the
    // rule once every queued slice has been started or blocked.
    const unmerged = (reg) => reg.programs.flatMap((program) => program.slices)
      .filter((slice) => slice.status !== 'implemented' && !slice.mergeSha);
    const subject = unmerged(r).find((slice) => r.executionPointer.plannedQueue.includes(slice.id))
      ?? unmerged(r)[0];
    subject.status = 'in-progress';
    r.executionPointer.plannedQueue = r.executionPointer.plannedQueue.filter((id) => id !== subject.id);
    r.executionPointer.activeSlices = r.executionPointer.activeSlices.filter((id) => id !== subject.id);
    r.executionPointer.verifyingSlices = r.executionPointer.verifyingSlices
      .filter((entry) => entry.id !== subject.id);
  }, /is neither active nor verifying/],
  ['a queued slice that is not planned', (r) => { r.executionPointer.plannedQueue.push('P5-M03'); }, /queued slice P5-M03 is implemented/],
  ['a blocked slice without blockedBy', (r) => { delete r.programs.flatMap((p) => p.slices).find((x) => x.id === 'P2-S03').blockedBy; }, /P2-S03 does not record blockedBy/],
  ['a blocked slice missing from blockedSlices', (r) => { r.executionPointer.blockedSlices = []; }, /blocked slice P2-S03 is missing/],
  ['a latest completed slice that is not implemented', (r) => {
    // Any slice that is not implemented will do; the queue may legitimately be
    // empty once every queued slice has been started or blocked.
    const notImplemented = r.programs.flatMap((program) => program.slices)
      .find((slice) => slice.status !== 'implemented');
    r.executionPointer.latestCompletedSlice.id = notImplemented.id;
  }, /latestCompletedSlice .* must be implemented with merge SHA/],
  ['a pointer naming an unknown slice', (r) => { r.executionPointer.plannedQueue.push('P5-M99'); }, /unknown slice P5-M99/],
  ['a pointer whose authority is not main', (r) => { r.executionPointer.authority = 'arena-manager'; }, /authority must be main/],
  ['a slice listed twice in the pointer', (r) => {
    // The duplicate the rule exists to catch needs a slice that is ALREADY claimed
    // by one pointer list, added to a DIFFERENT one. Derived from whichever list is
    // non-empty rather than from plannedQueue[0] (undefined once the queue drains).
    //
    // An earlier version of this fallback took the first slice of the first program,
    // which is in no pointer list at all — so the push created no duplicate, the
    // validator correctly passed, and the mutation silently stopped testing
    // anything. It only surfaced once P6-S02's reconciliation merged and drained
    // activeSlices, verifyingSlices and plannedQueue to empty at the same time.
    // Only the three STRING lists: verifyingSlices holds { id, pr, mergeSha, ... }
    // objects, so pushing a bare id there claims `undefined` rather than the slice
    // and produces a different, unrelated error instead of the duplicate.
    const lists = [
      ['activeSlices', r.executionPointer.activeSlices ?? []],
      ['plannedQueue', r.executionPointer.plannedQueue ?? []],
      ['blockedSlices', r.executionPointer.blockedSlices ?? []],
    ];
    const [from, claimed] = lists.find(([, ids]) => ids.length > 0);
    const target = lists.find(([name]) => name !== from)[1];
    target.push(claimed[0]);
  }, /listed in both/],
  // DEC-0020: main-owned milestone authority
  ['Main-Owned changed to Manager-Owned', (r) => { r.governance.milestoneAuthority.milestoneTruthOwner = 'arena-manager'; }, /milestoneTruthOwner must be "main"/],
  ['arena-manager declared canonical', (r) => { r.governance.milestoneAuthority.planningMemoryIsCanonical = true; }, /planningMemoryIsCanonical must be false/],
  ['a missing Main-Owned declaration', (r) => { delete r.governance.milestoneAuthority; }, /milestoneAuthority: missing/],
  ['ROADMAP declared as status owner', (r) => { r.governance.milestoneAuthority.roadmapOwnsStatus = true; }, /roadmapOwnsStatus must be false/],
  ['a register path other than the canonical one', (r) => { r.governance.milestoneAuthority.register = 'arena-manager:docs/n8n-lego/milestones.json'; }, /register must be/],
  ['a post-merge sequence without the README step', (r) => { r.governance.milestoneAuthority.postMergeSequence = r.governance.milestoneAuthority.postMergeSequence.filter((step) => !/README/.test(step)); }, /postMergeSequence lacks "README/],
  ['an arena-manager-only slice claim presented as canonical', (r) => { r.programs[5].slices.find((x) => x.id === 'P5-M09').canonicalSource = 'arena-manager'; }, /P5-M09: canonicalSource "arena-manager"/],
  // historical integrity and pointers
  ['a changed historical P2 milestone row', (r) => { r.milestones.find((m) => m.id === 'P2.20').title += ' (rewritten)'; }, /historical P2 ladder changed/],
  ['a changed historical P2 merge SHA', (r) => { const s = r.programs[2].slices.find((x) => x.id === 'P2.27.5'); s.mergeSha = 'f'.repeat(40); }, /historical P2 ladder changed/],
  ['a P2.27.x row removed', (r) => { r.programs[2].slices = r.programs[2].slices.filter((x) => x.id !== 'P2.27.10'); }, /historical P2 ladder changed/],
  ['a stale current pointer', (r) => { r.currentMilestone = 'P2.26'; }, /currentMilestone must be the last completed/],
  ['a stale previous pointer', (r) => { r.previousCompletedMilestone = 'P2.25'; }, /previousCompletedMilestone must be P2\.26/],
  ['the P2.17+ placeholder used as a pointer', (r) => { r.currentMilestone = 'P2.17+'; }, /historical placeholder/],
  ['an implemented P5-M08 whose merge SHA is dropped', (r) => {
    r.programs[5].slices.find((x) => x.id === 'P5-M08').mergeSha = null;
  }, /P5-M08: implemented without a 40-hex merge SHA/],
  ['an invented P13 slice', (r) => { r.programs[11].slices.push({ ...r.programs[11].slices[0], id: 'P13-S01' }); }, /P13-S01 sits under P11/],
];
for (const [name, mutate, expected] of MUTATIONS) {
  test(`the validator rejects ${name}`, () => {
    const register = clone();
    mutate(register);
    const errors = validateGovernanceRegister(register);
    assert.ok(errors.some((error) => expected.test(error)), `expected ${expected} in:\n${errors.join('\n')}`);
  });
}

/* ------------------------------------------------------------------ generated view */

test('the generated register view renders the program table from the canonical source', () => {
  const view = read('.ai/master/MILESTONE_REGISTER.md');
  assert.match(view, /GENERATED by tools\/lego\/ai-pack\.mjs/);
  assert.match(view, /## Programs P0–P11 \(top level\)/);
  for (const program of REGISTER.programs) assert.match(view, new RegExp(`\\| \\*\\*${program.id}\\*\\* \\|`));
  for (const future of REGISTER.futurePrograms) assert.match(view, new RegExp(`\\*\\*${future.id}\\*\\*`));
  assert.match(view, new RegExp(`\\| \\*\\*total\\*\\* \\| \\*\\*${REGISTER.features.length}\\*\\* \\|`));
});

/* ------------------------------------------------------------------ runner protocol */

test('runner protocol: 5 Windows + 5 WSL, 1 s polling, one authoritative document, cross-referenced from .ai/master', () => {
  const protocol = GOVERNANCE.runnerProtocol;
  assert.ok(protocol, 'workforce-governance.json carries runnerProtocol');
  assert.equal(protocol.runners.windows.length, 5);
  assert.equal(protocol.runners.wsl.length, 5);
  assert.equal(new Set([...protocol.runners.windows, ...protocol.runners.wsl]).size, 10);
  assert.equal(protocol.pollIntervalSeconds, 1);
  assert.equal(protocol.maxSleepSeconds, 1);
  assert.ok(existsSync(join(REPO_ROOT, protocol.document)), protocol.document);
  assert.match(read(protocol.document), /at most 1 second/);
  assert.equal(REGISTER.governance.runnerProtocol.startsWith(protocol.document), true, 'the register points at the same document');
  const view = read('.ai/master/PROJECT_WORKFORCE_ORCHESTRATION.md');
  assert.match(view, /## Runner protocol/);
  assert.ok(view.includes(protocol.document), 'the generated master view cross-references the document');
});

/** Waits in CI workflows and operations tooling: no literal sleep above 1 s. */
function* opsFiles(relative) {
  const absolute = join(REPO_ROOT, relative);
  if (!existsSync(absolute)) return;
  for (const name of readdirSync(absolute)) {
    const child = join(relative, name);
    const stat = statSync(join(REPO_ROOT, child));
    if (stat.isDirectory()) {
      if (['node_modules', 'tests', 'test', '__pycache__', 'vendor'].includes(name)) continue;
      yield* opsFiles(child);
    } else if (/\.(ya?ml|sh|py|ps1|mjs|cjs|js)$/.test(name)) {
      yield child;
    }
  }
}

test('no polling/wait sleep above 1 second in CI workflows or operations tooling', () => {
  const offenders = [];
  const roots = ['.github/workflows', 'tools/orchestration', 'scripts', 'apps/n8n-lego/scripts'];
  const patterns = [
    /\bsleep\s+(\d+(?:\.\d+)?)\b/g, // shell
    /time\.sleep\(\s*(\d+(?:\.\d+)?)\s*\)/g, // python literal
    /Start-Sleep\s+(?:-Seconds\s+)?(\d+(?:\.\d+)?)/gi, // powershell
  ];
  for (const root of roots) {
    for (const file of opsFiles(root)) {
      const lines = read(file).split('\n');
      lines.forEach((line, index) => {
        if (/^\s*(#|\/\/)/.test(line)) return;
        for (const pattern of patterns) {
          for (const match of line.matchAll(pattern)) {
            if (Number(match[1]) > 1) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        }
        for (const match of line.matchAll(/set(?:Timeout|Interval)\([^)]*?,\s*(\d[\d_]*)\s*\)/g)) {
          if (Number(match[1].replace(/_/g, '')) > 1000) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
  }
  assert.deepEqual(offenders, [], 'waits must poll at <= 1 s (docs/engineering-operations/RUNNER-PROTOCOL.md §3)');
});

test('runtime token material from the gateway is never committable', () => {
  assert.match(read('.gitignore'), /^\.arena\/gateway_tokens\.json$/m);
});

/* ------------------------------------------ DEC-0020: milestone truth is main-owned */

const README = read('README.md');
const HISTORICAL_LADDER = ['P2.11', 'P2.12', 'P2.13', 'P2.14', 'P2.15', 'P2.16', 'P2.17', 'P2.18', 'P2.19', 'P2.20', 'P2.21', 'P2.22',
  'P2.23', 'P2.24', 'P2.25', 'P2.26', 'P2.27', 'P2.17+'];
const HISTORICAL_P2_SLICES = ['P2.1-P2.4', 'P2.5', 'P2.6-P2.10', 'P2.11', 'P2.12', 'P2.13', 'P2.14', 'P2.15', 'P2.16', 'P2.17', 'P2.18',
  'P2.19', 'P2.20', 'P2.21', 'P2.22', 'P2.23', 'P2.24', 'P2.25', 'P2.26', 'P2.27', 'P2.27.0', 'P2.27.1', 'P2.27.2', 'P2.27.3', 'P2.27.4',
  'P2.27.5', 'P2.27.6', 'P2.27.7', 'P2.27.8', 'P2.27.9', 'P2.27.10'];

test('DEC-0020 is recorded as an active decision', () => {
  const decision = JSON.parse(read('docs/engineering-operations/workforce/decisions/DEC-0020.json'));
  assert.equal(decision.state, 'ACTIVE');
  assert.equal(decision.selectedOption, 'A-main-owned');
  assert.equal(decision.title, 'Milestone truth is Main-Owned');
  for (let n = 1; n <= 9; n += 1) assert.match(decision.rationale, new RegExp(`\\(${n}\\) `), `DEC-0020 point ${n}`);
  assert.match(decision.rationale, /complements DEC-0019/);
  const rules = read('.arena/RULES.md');
  assert.match(rules, /Milestone truth is main-owned \(DEC-0020\)/);
  assert.match(rules, /proposal pending reconciliation until merged to `main`/);
  assert.match(rules, /DEC-0020 complements DEC-0019/);
  assert.equal(REGISTER.governance.milestoneAuthority.decision, 'DEC-0020');
  assert.match(REGISTER.governance.milestoneAuthority.rule, /main-owned/);
  assert.match(REGISTER.governance.milestoneAuthority.rule, /arena-manager is not an alternate milestone authority/);
});

test('README carries the generated projection of the register, and it is current', () => {
  assert.equal(README.split(README_MARKERS.begin).length, 2, 'exactly one begin marker');
  assert.equal(README.split(README_MARKERS.end).length, 2, 'exactly one end marker');
  const synced = syncReadmeMilestoneSection(README, REGISTER);
  assert.equal(synced.ok, true);
  assert.equal(synced.changed, false, 'README milestone block is stale: run npm run lego:ai');
  const block = renderReadmeMilestoneSection(REGISTER);
  assert.match(block, /docs\/n8n-lego\/milestones\.json/);
  assert.match(block, /`main` owns milestone truth/);
  const pointer = REGISTER.executionPointer;
  assert.ok(block.includes(`\`${pointer.latestCompletedSlice.id}\``), 'latest completed slice');
  for (const entry of pointer.verifyingSlices) assert.ok(block.includes(`\`${entry.id}\``), `verifying ${entry.id}`);
  for (const id of [...pointer.activeSlices, ...pointer.plannedQueue, ...pointer.blockedSlices]) assert.ok(block.includes(`\`${id}\``), id);
  for (const program of REGISTER.programs) assert.match(block, new RegExp(`\\| ${program.id} \\| .* \\| ${program.status} \\|`));
});

test('README states no milestone truth outside the generated block', () => {
  const outside = README.slice(0, README.indexOf(README_MARKERS.begin)) + README.slice(README.indexOf(README_MARKERS.end));
  const ids = outside.match(/\bP\d+(?:\.\d+|-[SM]\d{2})\b/g) ?? [];
  assert.deepEqual(ids, [], 'milestone/slice ids belong in the generated block only');
});

test('ROADMAP.md points to the register instead of stating milestone status', () => {
  const roadmap = read('docs/n8n-lego/ROADMAP.md');
  assert.match(roadmap, /application roadmap/i);
  assert.match(roadmap, /docs\/n8n-lego\/milestones\.json|\(milestones\.json\)/);
  assert.doesNotMatch(roadmap, /\| \*\*P2\.13[^|]*\| 🔄/, 'no stale "P2.13 in progress" row');
  assert.doesNotMatch(roadmap, /^\| (\*\*)?P\d+\.\d+[^|]*\| (🔄|⏳)/m, 'no milestone status rows');
});

test('the historical P2 ladder and P2 slices are preserved unchanged', () => {
  assert.deepEqual(REGISTER.milestones.map((milestone) => milestone.id), HISTORICAL_LADDER);
  for (const milestone of REGISTER.milestones.filter((m) => m.id !== 'P2.17+')) assert.equal(milestone.status, 'complete', milestone.id);
  const p2 = REGISTER.programs.find((program) => program.id === 'P2');
  const historical = p2.slices.filter((slice) => slice.id.startsWith('P2.'));
  assert.deepEqual(historical.map((slice) => slice.id), HISTORICAL_P2_SLICES);
  for (const slice of historical) assert.equal(slice.status, 'implemented', slice.id);
  assert.equal(REGISTER.currentMilestone, REGISTER.executionPointer.historicalLastP2Milestone, 'the P2 pointer is history, not active work');
});

test('the P5 maintenance ladder is P5-M01..M10, each a separate slice with evidence-backed state', () => {
  const p5 = new Map(REGISTER.programs.find((program) => program.id === 'P5').slices.map((slice) => [slice.id, slice]));
  const ladder = ['P5-M01', 'P5-M02', 'P5-M03', 'P5-M04', 'P5-M05', 'P5-M06', 'P5-M07', 'P5-M08', 'P5-M09', 'P5-M10'];
  for (const id of ladder) assert.equal(p5.get(id)?.kind, 'maintenance', id);
  assert.deepEqual(['P5-M01', 'P5-M03'].map((id) => [p5.get(id).status, p5.get(id).mergeSha]), [
    ['implemented', '2719109169e99714e70937767e9a15af65bd640e'], ['implemented', 'cf52701c91e5447f19c32377c38f6ae5eea7f3a7']]);
  const m08 = p5.get('P5-M08');
  assert.equal(m08.pr, 304);
  const verifying = REGISTER.executionPointer.verifyingSlices.find((entry) => entry.id === 'P5-M08');
  if (m08.status === 'in-progress') assert.ok(verifying, 'a merged, unverified slice is listed as verifying');
  else assert.equal(m08.status, 'implemented', 'P5-M08 leaves in-progress only by post-merge verification');
  for (const id of REGISTER.executionPointer.blockedSlices) assert.ok(p5.get(id)?.blockedBy || REGISTER.programs.some((p) => p.slices.some((x) => x.id === id && x.blockedBy)), id);
});

/* ------------------------------------------------------ DEC-0020 projection checks */

const PROJECTION = () => ({ register: clone(), readme: read('README.md'), roadmap: read('docs/n8n-lego/ROADMAP.md') });

test('DEC-0020: the register declares main-owned authority with arena-manager non-canonical', () => {
  const authority = REGISTER.governance.milestoneAuthority;
  for (const [key, value] of Object.entries(MILESTONE_AUTHORITY)) assert.equal(authority[key], value, key);
  assert.equal(authority.planningMemoryIsCanonical, false);
  assert.match(authority.pendingReconciliation, /proposal/);
});

test('DEC-0020: README and .ai point to the canonical register on main', () => {
  const readme = read('README.md');
  assert.match(readme, /`main` owns milestone truth \(DEC-0020\)/);
  assert.match(readme, /Canonical register: \[`docs\/n8n-lego\/milestones\.json`\]/);
  assert.match(readme, /`arena-manager` is Manager planning memory only \(canonical: false\)/);
  assert.match(read('.ai/master/MILESTONE_REGISTER.md'), /docs\/n8n-lego\/milestones\.json/);
  assert.match(read('.ai/master/CURRENT_STATUS.md'), /canonical register `docs\/n8n-lego\/milestones\.json` on `main`/);
});

test('DEC-0020: README and ROADMAP pass the projection validator', () => {
  assert.deepEqual(validateMilestoneProjections(PROJECTION()), []);
});

test('README projection is deterministic (repeated generation gives no diff)', () => {
  assert.equal(renderReadmeMilestoneSection(clone()), renderReadmeMilestoneSection(clone()));
  const once = syncReadmeMilestoneSection(read('README.md'), REGISTER);
  assert.equal(once.changed, false);
  assert.equal(syncReadmeMilestoneSection(once.text, REGISTER).changed, false);
});

test('README projection lists current state, P5 ladder, recent slices and future programs', () => {
  const block = renderReadmeMilestoneSection(REGISTER);
  for (const heading of ['## Overall Milestone Progress', '## Program Overview', '## Active Execution', '### Active work', '## Status Legend', '## Milestone Governance', '## P5 —']) assert.ok(block.includes(heading), heading);
  for (let n = 1; n <= 10; n += 1) assert.match(block, new RegExp(`\\| \`P5-M${String(n).padStart(2, '0')}\` \\|`));
  assert.match(block, /Historical pointers: current `P2\.27`, previous completed `P2\.26`/);
  assert.match(block, /\| `P5-M08` \|[^\n]*✅ Implemented \| 100\.0% \| 100\.0% \|/);
  assert.match(block, /\| `P5-M09` \|[^\n]*✅ Implemented \| 100\.0% \| 100\.0% \|/);
  // Derived from the register: an empty verifying list renders the placeholder, and every
  // verifying slice renders its own VERIFYING block with its delivery PR and pending checks.
  const verifyingEntries = REGISTER.executionPointer.verifyingSlices ?? [];
  if (verifyingEntries.length === 0) assert.match(block, /_No verifying slice\._/);
  for (const entry of verifyingEntries) {
    assert.ok(block.includes(`### 🟠 ${entry.id} — `), `${entry.id} verifying block`);
    assert.ok(block.includes(`**PR:** #${entry.pr} · **Merge:** \`${entry.mergeSha.slice(0, 8)}\``), `${entry.id} delivery record`);
    assert.doesNotMatch(block, /_No verifying slice\._/);
  }
  // The latest completed slice is the delivery record that survives the verifying block emptying.
  // Derived from the register, so it follows the queue instead of going stale.
  const latest = REGISTER.executionPointer.latestCompletedSlice;
  assert.match(block, new RegExp(`#${latest.pr}`));
  assert.match(block, new RegExp(`\`${latest.mergeSha.slice(0, 8)}\``));
  assert.doesNotMatch(block, /\| `P5-M08` \|[^\n]*Verifying/);
});

test('completion KPI is implemented/total and never counts verifying or blocked', () => {
  const slices = sliceRecords(REGISTER).map((record) => record.slice);
  const tally = completionTally(slices);
  // Accounting rule PPA-1 (2026-09-28): aggregate parent rows (named as
  // parentSlice by other rows) are excluded - their delivery is represented by
  // their children. See test/progress-accounting.test.mjs for the full rules.
  const counted = accountingRows(slices);
  assert.equal(tally.implemented, counted.filter((slice) => slice.status === 'implemented').length);
  assert.equal(tally.total, counted.length);
  assert.equal(tally.percent, percent1(tally.implemented, tally.total));
  // Pin of the reconciled register. Refresh it when a slice's delivery state is reconciled; it
  // exists so a silently-flipped status cannot pass unnoticed. The tally itself is derived above,
  // so this pin is a tripwire on the register's delivery state, not on the arithmetic.
  // Refresh 2026-09-27: P6-S05 and P5-M02 reconciled to implemented on PR #355 merge d549d40d;
  // then P8-S01..P8-S07 (storage foundation vertical) on PR #356 merge 3e0f621d;
  // then P5-M05 (session + rate-limiter state) on PR #357 merge b7fb9ea4;
  // then P5-M11 (project/sharing model) on PR #358 merge 3cb5d356;
  // then P5-M12 (audit backing model) on PR #359 merge 8d86e657;
  // then P5-M13 (source-control backing model) on PR #360 merge cb4143d6;
  // then P5-M14 (data-table backing model) on PR #361 merge a6daad8a;
  // then P5-M15 (transfer backing model) on PR #362 merge 5cb23602;
  // then P5-M16 (workflow-version backing model) on PR #363 merge b8798bbf;
  // then P5-M17 (execution retry model) on PR #364 merge b616be84;
  // then P5-M18 (execution annotation/tag model) on PR #365 merge 97f03df9;
  // then P5-M10 (public /api/v1 resources over the backing models) on PR #366 merge c95a0fae;
  // then P5-M06 (injected mail transport + forgot-password delivery) on PR #367 merge 49103ac9;
  // then P2-S10 (Settings panels pilot) on PR #368 merge 60763a5e.
  // Refresh 2026-09-28: accounting repair PPA-1 - P2.27 reclassified as the
  // aggregate ladder row of P2.27.0..P2.27.10 and excluded from the denominator
  // (before 171/200 = 85.5; after 170/199 = 85.4; P2 40/60 -> 39/59). Evidence:
  // docs/n8n-lego/evidence/PROGRESS-ACCOUNTING-AUDIT.md.
  // Refresh 2026-09-28 (R1 P2-S11, PR #372 merge dd49d4d3, HARD GUARD queue-
  // unchanged PASSED): 170/199 = 85.4 -> 171/199 = 85.9; current 169/193 =
  // 87.6 -> 170/193 = 88.1; P2 39/59 -> 40/59. Evidence:
  // docs/n8n-lego/evidence/P2-S11-EVIDENCE.md.
  // Refresh 2026-09-28 (R1 P2-S12, PR #374 merge fbf5dbc, HARD GUARD queue-
  // unchanged PASSED): 171/199 = 85.9 -> 172/199 = 86.4; current 170/193 =
  // 88.1 -> 171/193 = 88.6; P2 40/59 -> 41/59. Evidence:
  // docs/n8n-lego/evidence/P2-S12-EVIDENCE.md.
  assert.equal(tally.percent, 86.4);
  assert.equal(tally.implemented, 172);
  assert.equal(tally.total, 199);
  const verifying = verifyingIndex(REGISTER);
  const m08 = slices.find((slice) => slice.id === 'P5-M08');
  assert.equal(displayStatus(m08, verifying), 'implemented');
  assert.equal(completionPercentForStatus(m08.status), 100);
  assert.equal(completionPercentForStatus('implemented'), 100);
  assert.equal(completionPercentForStatus('blocked'), 0);
  assert.equal(completionPercentForStatus('planned'), 0);
  const metrics = headlineMetrics(REGISTER);
    assert.equal(metrics.current.total, 193);
  assert.equal(metrics.current.implemented, 171);
  assert.equal(metrics.current.sliceCompletion, percent1(171, 193));
  assert.equal(metrics.future.total, 6);
  assert.equal(metrics.current.total + metrics.future.total, tally.total);
  const block = renderReadmeMilestoneSection(REGISTER);
  assert.match(block, new RegExp(`\\*\\*${formatPercent(metrics.current.sliceCompletion)}\\*\\*`));
  assert.match(block, new RegExp(`${metrics.current.implemented} / ${metrics.current.total} slices implemented`));
  assert.match(block, /Future programs are excluded/);
  assert.doesNotMatch(block, /\*\*82\.9%\*\*/);
  for (const record of sliceRecords(REGISTER)) assert.ok(block.includes('`' + record.slice.id + '`'), record.slice.id);
  const mutated = clone();
  mutated.programs[5].slices.find((slice) => slice.id === 'P5-M08').status = 'planned';
  assert.notEqual(renderReadmeMilestoneSection(mutated), block, 'the projection follows the register status');
});

test('Issue #307: two metrics, status independent, checkpoint weights only where declared', () => {
  const verifying = verifyingIndex(REGISTER);
  const metrics = headlineMetrics(REGISTER);
  // P5-M08 and P5-M09 (both with every checkpoint completed) plus P5-M07 and P4-S01. A slice can
  // sit at 100% realtime and still not be implemented, which is the whole point of keeping the two
  // axes apart. The count is derived from the register rather than pinned as a literal: a literal
  // here goes stale the moment the next slice installs its checkpoint model, which is exactly what
  // happened when P4-S01's four checkpoints landed.
  const checkpointed = sliceRecords(REGISTER)
    .map((record) => record.slice)
    .filter((slice) => Array.isArray(slice.checkpoints) && slice.checkpoints.length > 0)
    .map((slice) => slice.id)
    .sort();
  assert.equal(metrics.current.checkpointed, checkpointed.length,
    `checkpointed slices are ${checkpointed.join(', ')}`);
  // And the metric must agree with the register, not with the literal.
  assert.ok(checkpointed.every((id) => metrics.current.checkpointed > 0));
  // Independence, not inequality. Reopening CP-05 must move realtime and leave slice completion
  // untouched. The expectation is derived, not pinned: a literal number here goes stale the moment
  // another slice's checkpoint model changes, which is exactly what happened when P5-M09's five
  // checkpoints completed (P5-M09 no longer contributes 0, so the old 86.1 was wrong).
  const reopened = clone();
  const reopenedCheckpoints = reopened.programs[5].slices.find((slice) => slice.id === 'P5-M08').checkpoints;
  reopenedCheckpoints[4].status = 'in-progress';
  const reopenedMetrics = headlineMetrics(reopened).current;
  // P5-M08 drops 100 -> 70 (CP-05 carries 30 of the 100 points); P5-M09 is untouched, because
  // reopening one slice's checkpoint cannot move another slice's earned points.
  assert.equal(reopenedMetrics.realtime,
    percent1(metrics.current.earned - reopenedCheckpoints[4].weight, metrics.current.points),
    'reopening CP-05 must cost exactly CP-05\'s weight in realtime points');
  assert.ok(reopenedMetrics.realtime < metrics.current.realtime, 'reopening a checkpoint must lower realtime');
  assert.equal(reopenedMetrics.sliceCompletion, metrics.current.sliceCompletion, 'completion never follows telemetry');
  assert.equal(metrics.current.withoutModel,
    metrics.current.total - metrics.current.legacyImplemented - metrics.current.checkpointed,
    'a slice that is implemented AND declares checkpoints is counted once, in checkpointed');
  const p5 = REGISTER.programs.find((program) => program.id === 'P5');
  const p5Tally = programTally(p5, verifying);
  assert.equal(p5.status, 'complete');
  // "Program status complete is not numeric 100%": the status string is a
  // declared vocabulary value, never computed from the tally — and the tally is
  // computed from slice statuses, never from the status string. Once every P5
  // slice is implemented the tally legitimately reaches 100, so the invariant is
  // proven on a clone instead of by a state pin: reopen one slice and the
  // numbers move while the declared program status does not.
  const p5Open = clone();
  const p5OpenSlice = p5Open.programs[5].slices.find((slice) => slice.id === 'P5-M06');
  p5OpenSlice.status = 'in-progress';
  const p5OpenTally = programTally(p5Open.programs[5], verifyingIndex(p5Open));
  assert.ok(p5OpenTally.percent < 100, 'slice completion follows slice status');
  assert.equal(p5Open.programs[5].status, 'complete', 'program status is declared vocabulary, never computed from the tally');
  // Realtime is earned/declared and may legitimately reach 100 BEFORE slice
  // completion does: P5-M06's five checkpoints are all evidenced while the
  // slice is still in-progress (implemented only lands at R1). The two axes
  // moving apart is the metric's whole point (see the reopen check above), so
  // realtime is asserted as the derived ratio, never as a magic inequality —
  // an earlier `realtime != 100` pin only reflected P5-M06's weights being
  // unearned at the time and broke the moment the delivery was evidenced.
  const p5Progress = p5.slices.map((slice) => sliceDeliveryProgress(slice));
  assert.equal(p5Tally.earned, p5Progress.reduce((sum, item) => sum + item.earned, 0));
  assert.equal(p5Tally.points, p5Progress.reduce((sum, item) => sum + item.total, 0));
  assert.equal(p5Tally.realtime, percent1(p5Tally.earned, p5Tally.points), 'realtime is exactly earned/points');
  const m08 = p5.slices.find((slice) => slice.id === 'P5-M08');
  assert.equal(sliceDeliveryProgress(m08).source, 'checkpoints');
  assert.equal(sliceDeliveryProgress(m08).percent, 100, 'CP-01..CP-05 are all evidenced');
  assert.equal(completionContribution(m08), 100, 'an implemented slice contributes fully');
  assert.equal(displayStatus(m08, verifying), 'implemented');
  // The same independence from the other direction: full realtime evidence does
  // not implement a slice — only the lifecycle transition does. Proven on a
  // clone (status forced back to in-progress) so the check stays valid in any
  // live register state: before R1 it held directly, after R1 it holds via the
  // clone, and it can never rot into a state pin again.
  const m06 = p5.slices.find((slice) => slice.id === 'P5-M06');
  assert.equal(sliceDeliveryProgress(m06).source, 'checkpoints');
  assert.equal(sliceDeliveryProgress(m06).percent, 100, 'P5-M06 CP-01..CP-05 are all evidenced');
  const m06Open = clone();
  const m06Clone = m06Open.programs[5].slices.find((slice) => slice.id === 'P5-M06');
  m06Clone.status = 'in-progress';
  assert.equal(sliceDeliveryProgress(m06Clone).percent, 100);
  assert.notEqual(displayStatus(m06Clone, verifying), 'implemented', 'realtime 100 does not implement a slice');
  for (const id of REGISTER.executionPointer.blockedSlices) {
    const slice = slices(REGISTER).find((item) => item.id === id);
    assert.equal(slice.status, 'blocked', id);
    // A blocked slice never contributes to slice completion, whatever it has earned.
    assert.equal(completionContribution(slice), 0, id);
    assert.ok(slice.blockedBy, id);
    // But blocking must NOT reset realtime progress that was already earned. This used to
    // assert 'no-checkpoint-model' for every blocked slice, which held only while the
    // blocked list was four maintenance slices that never installed a model. It stopped
    // holding the moment a *delivered* slice was blocked by infrastructure (P2-S02, whose
    // merge is stuck behind the runner fleet): resetting its checkpoints would have
    // destroyed the earned progress that blocking is required to preserve. So the two
    // cases are asserted separately, and the earned figure is checked to survive.
    const progress = sliceDeliveryProgress(slice);
    if (Array.isArray(slice.checkpoints) && slice.checkpoints.length > 0) {
      assert.equal(progress.source, 'checkpoints', id);
      assert.ok(progress.percent > 0, `${id} keeps its earned realtime while blocked`);
    } else {
      assert.equal(progress.source, 'no-checkpoint-model', id);
    }
  }
  const block = renderReadmeMilestoneSection(REGISTER);
  assert.match(block, /### Realtime Delivery Progress/);
  assert.match(block, /### Slice Completion/);
  assert.match(block, /Status is not progress/);
  assert.match(block, /Program status is not a percentage/);
  assert.match(block, /Current checkpoint:/);
  assert.match(block, /Latest checkpoint:/);
  assert.match(block, /not register measurements/);
  assert.doesNotMatch(block, /91\.2%/);
  assert.doesNotMatch(block, /92\.0%/);
  assert.match(block, /\| `P5-M08` \|[^\n]*✅ Implemented \| 100\.0% \| 100\.0% \|/);
  assert.equal(REGISTER.governance.progressModel.reconciledToMain, true);
  assert.equal(historicalP2Fingerprint(REGISTER), HISTORICAL_P2_FINGERPRINT);
});

test('declared checkpoints move realtime progress and never slice completion or future denominators', () => {
  const before = headlineMetrics(REGISTER);
  // An implemented slice cannot carry an incomplete checkpoint: that is the mechanical
  // guarantee that a checkpoint state can never be used to inflate completion.
  const illegal = clone();
  illegal.programs.find((program) => program.id === 'P5').slices.find((slice) => slice.id === 'P5-M08').checkpoints[4].status = 'in-progress';
  assert.deepEqual(validateGovernanceRegister(illegal), ['P5-M08: an implemented slice cannot carry an incomplete checkpoint']);
  assert.equal(headlineMetrics(illegal).current.sliceCompletion, before.current.sliceCompletion, 'completion does not move');

  // The same slice, consistently back in flight (status, merge SHA and pointer together), so a
  // checkpoint change can be observed without touching delivery state.
  const inFlight = (cp05Status) => {
    const register = clone();
    const slice = register.programs.find((program) => program.id === 'P5').slices.find((item) => item.id === 'P5-M08');
    slice.status = 'in-progress';
    slice.mergeSha = null;
    slice.checkpoints[4] = { ...slice.checkpoints[4], status: cp05Status, completedAt: cp05Status === 'completed' ? '2026-09-26T09:00:00Z' : undefined };
    register.executionPointer.latestCompletedSlice = { id: 'P5-M03', pr: 291, mergeSha: 'cf52701c91e5447f19c32377c38f6ae5eea7f3a7' };
    // Whatever else is in flight on the canonical register stays in flight here: an
    // in-progress slice must be in the pointer, or the fixture is itself invalid.
    const alsoInFlight = [...REGISTER.programs, ...REGISTER.futurePrograms]
      .flatMap((entity) => entity.slices)
      .filter((slice) => slice.status === 'in-progress' && slice.id !== 'P5-M08')
      // A verifying slice is in-progress too, but the pointer already lists it under verifyingSlices.
      .filter((slice) => !(REGISTER.executionPointer.verifyingSlices ?? []).some((entry) => entry.id === slice.id))
      .map((slice) => slice.id);
    register.executionPointer.activeSlices = ['P5-M08', ...alsoInFlight];
    assert.deepEqual(validateSliceCheckpoints(slice), []);
    assert.deepEqual(validateGovernanceRegister(register), []);
    return register;
  };
  const open = inFlight('in-progress');
  const done = inFlight('completed');
  const openSlice = open.programs.find((program) => program.id === 'P5').slices.find((slice) => slice.id === 'P5-M08');
  const doneSlice = done.programs.find((program) => program.id === 'P5').slices.find((slice) => slice.id === 'P5-M08');
  assert.equal(sliceDeliveryProgress(openSlice).percent, 70, 'reopening CP-05 gives back its 30 points');
  assert.equal(sliceDeliveryProgress(doneSlice).percent, 100, 'completing CP-05 earns them back');
  assert.equal(completionContribution(openSlice), 0, 'an in-flight slice never contributes to completion');
  assert.equal(displayStatus(openSlice, verifyingIndex(open)), 'in-progress', 'an unmerged in-flight slice is not verifying');

  // The telemetry property: realtime follows the checkpoint, completion and the denominators do not.
  const openMetrics = headlineMetrics(open).current;
  const doneMetrics = headlineMetrics(done).current;
  assert.equal(sliceDeliveryProgress(openSlice).source, 'checkpoints');
  assert.ok(doneMetrics.realtime > openMetrics.realtime, `realtime ${openMetrics.realtime} → ${doneMetrics.realtime}`);
  assert.equal(doneMetrics.sliceCompletion, openMetrics.sliceCompletion, 'completion never follows telemetry');
  assert.equal(doneMetrics.implemented, openMetrics.implemented);
  assert.equal(headlineMetrics(done).future.realtime, headlineMetrics(open).future.realtime, 'future programs never dilute the denominator');

  // The implemented slice on main is the opposite: full completion, and telemetry cannot move it.
  const liveSlice = clone().programs.find((program) => program.id === 'P5').slices.find((slice) => slice.id === 'P5-M08');
  assert.equal(completionContribution(liveSlice), 100);
  assert.equal(sliceDeliveryProgress(liveSlice).percent, 100);
  // The delta is the TRUE points cost of CP-05 rounded once (percent1 semantics). Subtracting
  // two already-rounded realtime levels is a measurement bug: where the two halves fall on a
  // rounding boundary depends on where the register's earned total happens to sit, so an
  // unrelated checkpoint addition (a new slice declaring its model) moves that value while the
  // fixture has not changed at all. The claim is unchanged and asserted directly: reopening
  // CP-05 removes exactly its 30 points, leaves the denominator alone, and costs 0.2 realtime
  // points at the declared denominator.
  assert.equal(before.current.earned - openMetrics.earned, 30, 'the fixture removes exactly CP-05 weight points');
  assert.equal(openMetrics.points, before.current.points, 'the denominator does not move');
  const realtimeDelta = Math.round(((before.current.earned - openMetrics.earned) / before.current.points) * 100 * 10) / 10;
  assert.equal(realtimeDelta, 0.2, 'the fixture only moves P5-M08 realtime');

  const rendered = renderReadmeMilestoneSection(done);
  assert.match(rendered, /CP-05 DEC-0015 self-hosted runner verification on main[^\n]*\(completed, 30\)/);
  assert.match(rendered, /\| `P5-M08` \|[^\n]*🔵 In progress \| 100\.0% \| 0\.0% \|/,
    'an in-flight slice at 100% realtime still contributes 0% to completion');
  assert.doesNotMatch(rendered, /\| `P5-M08` \|[^\n]*Implemented/);

  const futureOnly = clone();
  const planned = futureOnly.futurePrograms.flatMap((program) => program.slices).find((slice) => slice.status === 'planned');
  planned.checkpoints = [{ id: 'CP-01', title: 'Not current delivery', weight: 100, status: 'completed', evidence: 'unit-test evidence' }];
  assert.equal(headlineMetrics(futureOnly).current.realtime, before.current.realtime);
  assert.notEqual(headlineMetrics(futureOnly).future.realtime, before.future.realtime);

  const missingEvidence = clone();
  const broken = missingEvidence.programs.find((program) => program.id === 'P5').slices.find((slice) => slice.id === 'P5-M08');
  broken.checkpoints = [{ id: 'CP-01', title: 'Unevidenced', weight: 100, status: 'completed', evidence: '   ' }];
  assert.ok(validateGovernanceRegister(missingEvidence).some((error) => /no evidence/.test(error)));
  const badWeight = clone();
  const weighted = badWeight.programs.find((program) => program.id === 'P5').slices.find((slice) => slice.id === 'P5-M08');
  weighted.checkpoints = [
    { id: 'CP-01', title: 'Partial', weight: 40, status: 'completed', evidence: 'docs/n8n-lego/evidence/P5-M08-EVIDENCE.md' },
    { id: 'CP-02', title: 'Rest', weight: 40, status: 'planned' },
  ];
  assert.ok(validateGovernanceRegister(badWeight).some((error) => /sum to 80, not 100/.test(error)));
});

test('the historical P2 fingerprint is pinned', () => {
  assert.equal(historicalP2Fingerprint(REGISTER), HISTORICAL_P2_FINGERPRINT);
});

const PROJECTION_MUTATIONS = [
  ['a stale README block', (p) => { p.readme = p.readme.replace('### Active work', '### Active work (edited)'); }, /block is stale/],
  // `reverse()` was order-only, so it silently became a no-op the moment the queue shrank to a
  // single entry (P2-S02 leaving the queue on its way to in-progress) and the mutation stopped
  // testing anything. Change the queue CONTENT instead, which is detected at any length.
  ['a README generated from a different register', (p) => {
    p.register.executionPointer.plannedQueue = [...p.register.executionPointer.plannedQueue, 'P2-ZZ-PROBE'];
  }, /stale or was generated from a different register/],
  ['a README/register mismatch after a status change', (p) => { p.register.programs[5].slices.find((x) => x.id === 'P5-M09').title = 'Changed title'; }, /different register/],
  ['a README without the generated block', (p) => { p.readme = p.readme.replace(README_MARKERS.begin, ''); }, /exactly once/],
  ['a duplicated README block', (p) => { p.readme += `\n${renderReadmeMilestoneSection(p.register)}\n`; }, /exactly once/],
  ['a manual milestone table outside the README block', (p) => { p.readme += '\n| P5-M09 | credentials | in-progress |\n'; }, /manual milestone status row outside/],
  ['a competing ROADMAP status table', (p) => { p.roadmap += '\n| P2.13 | Context & Session | in-progress |\n'; }, /ROADMAP\.md: competing milestone status row/],
  ['a ROADMAP without the register reference', (p) => { p.roadmap = p.roadmap.replaceAll('docs/n8n-lego/milestones.json', 'somewhere'); }, /must reference the canonical register/],
  ['a ROADMAP with the strategic narrative removed', (p) => { p.roadmap = p.roadmap.split('\n## 1.')[0]; }, /strategic Phase A-F narrative must remain/],
];
for (const [name, mutate, expected] of PROJECTION_MUTATIONS) {
  test(`the projection validator rejects ${name}`, () => {
    const projection = PROJECTION();
    mutate(projection);
    const errors = validateMilestoneProjections(projection);
    assert.ok(errors.some((error) => expected.test(error)), `expected ${expected} in:\n${errors.join('\n')}`);
  });
}

test('DEC-0024: P7 is authorized as the eight-slice ladder of #223 §42, each feature mapped to one slice', () => {
  const p7 = REGISTER.programs.find((program) => program.id === 'P7');
  assert.deepEqual(p7.slices.map((slice) => slice.id), ['P7-S01', 'P7-S02', 'P7-S03', 'P7-S04', 'P7-S05', 'P7-S06', 'P7-S07', 'P7-S08']);
  for (const slice of p7.slices) assert.equal(slice.authorizedBy, 'DEC-0024', slice.id);
  const features = REGISTER.features.filter((feature) => feature.parent === 'P7');
  assert.equal(features.length, 29);
  for (const feature of features) assert.match(feature.slice, /^P7-S0[1-8]$/, feature.id);
  for (const slice of p7.slices) assert.ok(features.some((feature) => feature.slice === slice.id), `${slice.id} owns at least one feature`);
  const decision = JSON.parse(read('docs/engineering-operations/workforce/decisions/DEC-0024.json'));
  assert.equal(decision.state, 'ACTIVE');
  assert.equal(decision.authority.decidedBy, 'OWNER');
});
