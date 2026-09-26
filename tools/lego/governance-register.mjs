/**
 * Governance register — validation and rendering for the program / slice / feature layer of the
 * canonical register `docs/n8n-lego/milestones.json` (governance reset, Issue #256).
 *
 * The register is the ONE source of truth. This module never writes it: `tools/lego/ai-pack.mjs`
 * uses `validateGovernanceRegister()` to refuse generating `.ai/master/MILESTONE_REGISTER.md` from an
 * invalid register, and `renderGovernanceSections()` to render the readable views. The unit test
 * `apps/n8n-lego/test/governance-register.test.mjs` runs the same validator, so a register that
 * breaks a rule fails both the generator freshness gate and the test suite.
 *
 * Rules encoded (all from the governance mandate #254/#255/#256):
 *  - top-level programs are exactly P0..P11 — no P12+ and never P24+;
 *  - P0-P6 and P9 are complete; P7 is in-progress (DEC-0024); P8, P10 and P11 are planned (a status change is a Manager
 *    decision recorded here, and this list must be updated in the same change);
 *  - new work inside an existing P is a slice `Pn-Snn`, maintenance is `Pn-Mnn`; there is no P5.9;
 *  - legacy P12-P23 are consolidated into thematic future programs, each exactly once;
 *  - status / relevance come from the fixed vocabularies;
 *  - `implemented` requires a 40-hex merge SHA and evidence (an issue existing is not evidence);
 *  - superseded requires supersededBy; rejected / retired carry a recorded reason;
 *  - feature ids are unique and every slice reference resolves inside its own parent.
 *  - DEC-0020: milestone truth is main-owned (governance.milestoneAuthority), the historical P2
 *    ladder is fingerprinted, and README.md / ROADMAP.md are checked as projections, never registers.
 *  - DEC-0021 (LIVE-MILESTONE EXCEPTION): checkpoint / milestone progress telemetry may be
 *    reconciled straight to `main` by the Manager in a `governance(progress):` commit, using
 *    `tools/lego/progress-event.mjs`. Only LIVE_PROGRESS_PATHS may change in such a commit
 *    (`classifyProgressCommit`); implementation, contracts, CI, Cargo and runner configuration
 *    are outside the exception and still need a delivery PR.
 */

import { createHash } from 'node:crypto';

export const TOP_LEVEL_PROGRAMS = Object.freeze(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11']);
export const EXPECTED_PROGRAM_STATUS = Object.freeze({
  P0: 'complete', P1: 'complete', P2: 'complete', P3: 'complete', P4: 'complete', P5: 'complete', P6: 'complete',
  P7: 'in-progress', P8: 'planned', P9: 'complete', P10: 'planned', P11: 'planned',
});
export const LEGACY_FUTURE_MILESTONES = Object.freeze(['P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21', 'P22', 'P23']);
export const FEATURE_REQUIRED_FIELDS = Object.freeze([
  'id', 'title', 'type', 'sourceIssue', 'parent', 'slice', 'owner', 'status', 'relevance',
  'dependencies', 'evidence', 'pr', 'mergeSha', 'relatedEvidence', 'supersededBy', 'replacement',
]);

const SHA = /^[0-9a-f]{40}$/;
const HISTORICAL_SLICE = /^(P\d+\.\d+(\.\d+)?(-[A-Za-z0-9]+)?|P\d+\.\d+-P\d+\.\d+|P3 Slice [A-Z])$/;
const NEW_SLICE = /^(P\d+)-(S|M)\d{2}$/;
const FUTURE_SLICE = /^(FUTURE-[A-Z-]+)-S\d{2}$/;
const FEATURE_ID = /^((P\d+|FUTURE-[A-Z-]+)-F-[A-Z0-9]+-\d{3}|GOV-F-\d{3})$/;

function programOfHistoricalSlice(id) {
  return id.match(/^(P\d+)[ .]/)?.[1] ?? null;
}

/** Returns an array of human-readable violations; empty means valid. */
export function validateGovernanceRegister(register) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const gov = register?.governance;
  if (!gov) return ['register has no governance block'];
  const statuses = new Set(gov.statusVocabulary ?? []);
  const relevances = new Set(gov.relevanceVocabulary ?? []);
  const programStatuses = new Set(gov.programStatusVocabulary ?? []);
  for (const word of ['implemented', 'in-progress', 'planned', 'proposed', 'blocked', 'deferred', 'superseded', 'retired', 'rejected']) {
    if (!statuses.has(word)) fail(`statusVocabulary lacks "${word}"`);
  }
  for (const word of ['active', 'maintenance', 'deprecated', 'archived']) {
    if (!relevances.has(word)) fail(`relevanceVocabulary lacks "${word}"`);
  }

  const programs = register.programs ?? [];
  const futures = register.futurePrograms ?? [];
  const ids = programs.map((program) => program.id);
  if (JSON.stringify(ids) !== JSON.stringify(TOP_LEVEL_PROGRAMS)) fail(`programs must be exactly ${TOP_LEVEL_PROGRAMS.join(',')} in order (got ${ids.join(',')})`);
  const sliceOwner = new Map();

  const checkSlice = (slice, parentId, isFuture) => {
    if (!slice.id) return fail(`${parentId}: slice without id`);
    if (sliceOwner.has(slice.id)) fail(`slice ${slice.id} is declared twice`);
    sliceOwner.set(slice.id, parentId);
    if (/^P5\.9\b/.test(slice.id)) fail('P5.9 is forbidden — P5 debt is P5-Mnn');
    if (isFuture) {
      const match = slice.id.match(FUTURE_SLICE);
      if (!match || match[1] !== parentId) fail(`${slice.id}: future-program slices are named ${parentId}-Snn`);
    } else if (NEW_SLICE.test(slice.id)) {
      if (slice.id.match(NEW_SLICE)[1] !== parentId) fail(`${slice.id} sits under ${parentId}`);
    } else if (HISTORICAL_SLICE.test(slice.id)) {
      if (programOfHistoricalSlice(slice.id) !== parentId) fail(`${slice.id} sits under ${parentId}`);
      if (slice.status !== 'implemented') fail(`${slice.id}: historical slices are immutable completed history`);
    } else {
      fail(`${slice.id}: slice id is neither historical (Pn.m) nor Pn-Snn / Pn-Mnn`);
    }
    if (!statuses.has(slice.status)) fail(`${slice.id}: status "${slice.status}" is not in the vocabulary`);
    if (slice.status === 'implemented') {
      if (!SHA.test(slice.mergeSha ?? '')) fail(`${slice.id}: implemented without a 40-hex merge SHA`);
      if (!slice.evidence) fail(`${slice.id}: implemented without evidence`);
    } else if (slice.mergeSha) {
      fail(`${slice.id}: a ${slice.status} slice cannot carry a merge SHA`);
    }
    for (const problem of validateSliceCheckpoints(slice)) fail(problem);
  };

  for (const program of programs) {
    if (!programStatuses.has(program.status)) fail(`${program.id}: program status "${program.status}" is not in the program vocabulary`);
    if (EXPECTED_PROGRAM_STATUS[program.id] && program.status !== EXPECTED_PROGRAM_STATUS[program.id]) {
      fail(`${program.id}: status "${program.status}" differs from the recorded Manager decision "${EXPECTED_PROGRAM_STATUS[program.id]}"`);
    }
    if (!Array.isArray(program.slices) || program.slices.length === 0) fail(`${program.id}: no slices`);
    for (const slice of program.slices ?? []) checkSlice(slice, program.id, false);
    if (program.status === 'complete' && !(program.slices ?? []).some((slice) => slice.status === 'implemented')) {
      fail(`${program.id}: complete without one implemented slice`);
    }
  }

  const legacySeen = [];
  for (const future of futures) {
    if (!/^FUTURE-[A-Z-]+$/.test(future.id)) fail(`${future.id}: future programs are FUTURE-<THEME>`);
    if (/^P\d+$/.test(future.id)) fail(`${future.id}: a future program is never a P number`);
    legacySeen.push(...(future.legacyMilestones ?? []));
    for (const slice of future.slices ?? []) checkSlice(slice, future.id, true);
  }
  const sortedLegacy = [...legacySeen].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  if (JSON.stringify(sortedLegacy) !== JSON.stringify(LEGACY_FUTURE_MILESTONES)) {
    fail(`legacy P12-P23 must each map to exactly one future program (got ${sortedLegacy.join(',')})`);
  }

  const parents = new Set([...ids, ...futures.map((future) => future.id), 'GOVERNANCE']);
  const featureIds = new Set();
  for (const feature of register.features ?? []) {
    for (const field of FEATURE_REQUIRED_FIELDS) if (!(field in feature)) fail(`${feature.id ?? '?'}: missing "${field}"`);
    if (!FEATURE_ID.test(feature.id ?? '')) fail(`${feature.id}: feature id format`);
    if (featureIds.has(feature.id)) fail(`${feature.id}: duplicate feature id`);
    featureIds.add(feature.id);
    if (!feature.id.startsWith(feature.parent === 'GOVERNANCE' ? 'GOV-' : `${feature.parent}-F-`)) fail(`${feature.id}: id prefix must match parent ${feature.parent}`);
    if (!parents.has(feature.parent)) fail(`${feature.id}: unknown parent ${feature.parent}`);
    if (!statuses.has(feature.status)) fail(`${feature.id}: status "${feature.status}"`);
    if (!relevances.has(feature.relevance)) fail(`${feature.id}: relevance "${feature.relevance}"`);
    if (!Array.isArray(feature.sourceIssue) || feature.sourceIssue.length === 0) fail(`${feature.id}: sourceIssue must name at least one issue`);
    if (feature.slice !== null) {
      if (!sliceOwner.has(feature.slice)) fail(`${feature.id}: slice ${feature.slice} does not exist`);
      else if (sliceOwner.get(feature.slice) !== feature.parent) fail(`${feature.id}: slice ${feature.slice} belongs to ${sliceOwner.get(feature.slice)}, not ${feature.parent}`);
    }
    if (feature.status === 'implemented') {
      if (!feature.evidence) fail(`${feature.id}: implemented without evidence`);
      if (feature.type !== 'governance' && !SHA.test(feature.mergeSha ?? '')) fail(`${feature.id}: implemented without a 40-hex merge SHA`);
    }
    if (feature.status === 'superseded' && !feature.supersededBy) fail(`${feature.id}: superseded without supersededBy`);
    if ((feature.status === 'rejected' || feature.status === 'retired') && !(feature.note || feature.evidence)) fail(`${feature.id}: ${feature.status} without a recorded reason`);
  }
  errors.push(...validateExecutionPointer(register, sliceOwner));
  errors.push(...validateMilestoneAuthority(register));
  errors.push(...validateLiveProgressModel(register));
  const model = gov.progressModel;
  if (model) {
    if (model.legacyImplementedWithoutCheckpoints !== LEGACY_IMPLEMENTED_POINTS) fail(`progressModel.legacyImplementedWithoutCheckpoints must be ${LEGACY_IMPLEMENTED_POINTS}`);
    if (model.noCheckpointModel !== NO_CHECKPOINT_MODEL_POINTS) fail(`progressModel.noCheckpointModel must be ${NO_CHECKPOINT_MODEL_POINTS}`);
    if (!Array.isArray(model.completionCounts) || JSON.stringify(model.completionCounts) !== JSON.stringify(['implemented'])) fail('progressModel.completionCounts must be ["implemented"]');
    if (model.currentDelivery !== 'P0-P11') fail('progressModel.currentDelivery must be P0-P11');
  }
  errors.push(...validateHistoricalPointers(register));
  return errors;
}

/**
 * DEC-0020: the active-work pointer must agree with the slice statuses it
 * names, so the README/.ai projections can never claim a state the register
 * does not hold.
 */
export function validateExecutionPointer(register, sliceOwner = null) {
  const errors = [];
  const fail = (message) => errors.push(`executionPointer: ${message}`);
  const pointer = register?.executionPointer;
  if (!pointer) return ['executionPointer: missing (DEC-0020 active-work pointer)'];
  const all = new Map([...(register.programs ?? []), ...(register.futurePrograms ?? [])]
    .flatMap((entity) => (entity.slices ?? []).map((slice) => [slice.id, slice])));
  const get = (id, where) => {
    const slice = all.get(id);
    if (!slice) fail(`${where} names unknown slice ${id}`);
    return slice;
  };
  if (!/^main\b/.test(pointer.authority ?? '')) fail('authority must be main');
  if (pointer.historicalLastP2Milestone !== register.currentMilestone) fail('historicalLastP2Milestone must equal currentMilestone (the historical P2 pointer)');
  if (!SHA.test(pointer.lastVerifiedMain ?? '')) fail('lastVerifiedMain must be a 40-hex SHA');
  const latest = pointer.latestCompletedSlice;
  const latestSlice = latest ? get(latest.id, 'latestCompletedSlice') : null;
  if (!latest) fail('latestCompletedSlice missing');
  else if (latestSlice && (latestSlice.status !== 'implemented' || latestSlice.mergeSha !== latest.mergeSha)) {
    fail(`latestCompletedSlice ${latest.id} must be implemented with merge SHA ${latest.mergeSha}`);
  }
  const listed = new Map();
  const claim = (id, list) => {
    if (listed.has(id)) fail(`${id} is listed in both ${listed.get(id)} and ${list}`);
    listed.set(id, list);
  };
  for (const id of pointer.activeSlices ?? []) {
    claim(id, 'activeSlices');
    const slice = get(id, 'activeSlices');
    if (slice && slice.status !== 'in-progress') fail(`active slice ${id} is ${slice.status}, not in-progress`);
  }
  for (const entry of pointer.verifyingSlices ?? []) {
    claim(entry.id, 'verifyingSlices');
    const slice = get(entry.id, 'verifyingSlices');
    if (slice && slice.status !== 'in-progress') fail(`verifying slice ${entry.id} is ${slice.status}; verifying is in-progress until post-merge verification passes`);
    if (!Number.isInteger(entry.pr)) fail(`verifying slice ${entry.id} names no delivery PR`);
    if (!SHA.test(entry.mergeSha ?? '') || !SHA.test(entry.headSha ?? '')) fail(`verifying slice ${entry.id} needs 40-hex headSha and mergeSha`);
    if (!entry.pending) fail(`verifying slice ${entry.id} must say what is pending`);
  }
  const queue = pointer.plannedQueue ?? [];
  for (const id of queue) {
    claim(id, 'plannedQueue');
    const slice = get(id, 'plannedQueue');
    if (slice && slice.status !== 'planned') fail(`queued slice ${id} is ${slice.status}, not planned`);
  }
  for (const id of pointer.blockedSlices ?? []) {
    claim(id, 'blockedSlices');
    const slice = get(id, 'blockedSlices');
    if (slice && slice.status !== 'blocked') fail(`blocked slice ${id} is ${slice.status}`);
  }
  for (const [id, slice] of all) {
    if (slice.status === 'in-progress' && !['activeSlices', 'verifyingSlices'].includes(listed.get(id))) fail(`in-progress slice ${id} is neither active nor verifying`);
    if (slice.status === 'blocked') {
      if (listed.get(id) !== 'blockedSlices') fail(`blocked slice ${id} is missing from blockedSlices`);
      if (!slice.blockedBy) fail(`blocked slice ${id} does not record blockedBy`);
    }
  }
  if (sliceOwner && sliceOwner.size !== all.size) fail('slice index mismatch');
  return errors;
}

/** DEC-0020 authority block: main owns milestone truth; arena-manager is planning memory only. */
export const MILESTONE_AUTHORITY = Object.freeze({
  decision: 'DEC-0020',
  milestoneTruthOwner: 'main',
  register: 'docs/n8n-lego/milestones.json',
  publicProjection: 'README.md',
  generatedProjection: '.ai/master/MILESTONE_REGISTER.md',
  planningMemory: 'arena-manager',
  planningMemoryIsCanonical: false,
  roadmapOwnsStatus: false,
});

export function validateMilestoneAuthority(register) {
  const errors = [];
  const authority = register?.governance?.milestoneAuthority;
  if (!authority) return ['milestoneAuthority: missing (DEC-0020 main-owned declaration)'];
  for (const [key, expected] of Object.entries(MILESTONE_AUTHORITY)) {
    if (authority[key] !== expected) errors.push(`milestoneAuthority: ${key} must be ${JSON.stringify(expected)} (got ${JSON.stringify(authority[key])})`);
  }
  for (const key of ['rule', 'noBatching', 'pendingReconciliation']) {
    if (!authority[key]) errors.push(`milestoneAuthority: ${key} missing`);
  }
  const sequence = authority.postMergeSequence ?? [];
  for (const step of ['merge to main', 'post-merge verification', 'README milestone projection (generated)', '.ai regeneration', 'governance PR', 'final main verification']) {
    if (!sequence.includes(step)) errors.push(`milestoneAuthority: postMergeSequence lacks "${step}"`);
  }
  // No slice may present a non-main (e.g. arena-manager-only) source as its canonical state.
  for (const entity of [...(register.programs ?? []), ...(register.futurePrograms ?? [])]) {
    for (const slice of entity.slices ?? []) {
      for (const key of ['canonicalSource', 'authority', 'milestoneTruthOwner']) {
        if (key in slice && slice[key] !== 'main') errors.push(`${slice.id}: ${key} "${slice[key]}" — milestone truth is main-owned (DEC-0020)`);
      }
    }
  }
  return errors;
}

/**
 * Historical P2 ladder (milestones[] and the P2.x slices under program P2) is immutable
 * implementation history. The fingerprint pins every field; changing it is a deliberate,
 * reviewed governance act that must update this constant in the same PR.
 */
export const HISTORICAL_P2_FINGERPRINT = '0a20c8311e55124254f42cb7fc837b1a0338bd8ed6374d6f6e48333041be43b2';

export function historicalP2Fingerprint(register) {
  const p2 = (register.programs ?? []).find((program) => program.id === 'P2');
  const payload = {
    milestones: register.milestones ?? [],
    slices: (p2?.slices ?? []).filter((slice) => /^P2\.\d/.test(slice.id)),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function validateHistoricalPointers(register) {
  const errors = [];
  const ladder = register.milestones ?? [];
  const completed = ladder.filter((milestone) => milestone.status === 'complete').map((milestone) => milestone.id);
  if (historicalP2Fingerprint(register) !== HISTORICAL_P2_FINGERPRINT) errors.push('historical P2 ladder changed: milestones[] / P2.x slices are immutable history (fingerprint mismatch)');
  for (const key of ['currentMilestone', 'previousCompletedMilestone']) {
    const id = register[key];
    if (/\+/.test(id ?? '')) errors.push(`${key}: "${id}" is a historical placeholder, never a milestone pointer`);
    else if (!completed.includes(id)) errors.push(`${key}: "${id}" is not a completed historical milestone`);
  }
  if (register.currentMilestone !== completed.at(-1)) errors.push(`currentMilestone must be the last completed historical milestone ${completed.at(-1)} (stale pointer)`);
  if (register.previousCompletedMilestone !== completed.at(-2)) errors.push(`previousCompletedMilestone must be ${completed.at(-2)} (stale pointer)`);
  for (const milestone of ladder) {
    if (milestone.status !== 'complete' && !/\+$/.test(milestone.id)) errors.push(`${milestone.id}: the historical ladder only holds completed milestones and the P2.17+ placeholder`);
  }
  return errors;
}

export function registerFingerprint(register) {
  return createHash('sha256').update(JSON.stringify(register)).digest('hex').slice(0, 16);
}

const STATUS_ROW = /^\s*\|.*`?\b(P\d{1,2}(?:\.\d+)+\+?|P\d{1,2}-[SM]\d{2}|FUTURE-[A-Z-]+-S\d{2})\b.*\b(implemented|in-progress|planned|blocked|complete|verifying|deferred)\b/;

/**
 * README.md and ROADMAP.md are projections / narrative, never registers (DEC-0020).
 * Returns violations; empty means both are consistent with the register.
 */
export function validateMilestoneProjections({ register, readme, roadmap }) {
  const errors = [];
  const begins = readme.split(README_MARKERS.begin).length - 1;
  const ends = readme.split(README_MARKERS.end).length - 1;
  if (begins !== 1 || ends !== 1) errors.push('README.md: the generated milestone-governance block must appear exactly once');
  else {
    const start = readme.indexOf(README_MARKERS.begin);
    const end = readme.indexOf(README_MARKERS.end) + README_MARKERS.end.length;
    if (readme.slice(start, end) !== renderReadmeMilestoneSection(register)) {
      errors.push('README.md: milestone-governance block is stale or was generated from a different register (run npm run lego:ai)');
    }
    const outside = (readme.slice(0, start) + readme.slice(end)).split('\n');
    outside.forEach((line, index) => {
      if (STATUS_ROW.test(line)) errors.push(`README.md: manual milestone status row outside the generated block: "${line.trim().slice(0, 80)}"`);
    });
  }
  if (!roadmap.includes('docs/n8n-lego/milestones.json')) errors.push('ROADMAP.md: must reference the canonical register docs/n8n-lego/milestones.json');
  if (!/strategic Phase A-F narrative/.test(roadmap) || (roadmap.match(/^## \d+\. /gm) ?? []).length < 3) errors.push('ROADMAP.md: the strategic Phase A-F narrative must remain');
  roadmap.split('\n').forEach((line) => {
    if (STATUS_ROW.test(line)) errors.push(`ROADMAP.md: competing milestone status row: "${line.trim().slice(0, 80)}"`);
  });
  return errors;
}

const sliceTitle = (slice) => String(slice?.title ?? '').split(/: |; | \(|\. /)[0].replace(/\.$/, '').trim();

/** The active-work section (MILESTONE_REGISTER.md and README.md). */
function activeWorkLines(register) {
  const pointer = register.executionPointer;
  const all = new Map([...(register.programs ?? []), ...(register.futurePrograms ?? [])]
    .flatMap((entity) => (entity.slices ?? []).map((slice) => [slice.id, slice])));
  const latest = pointer.latestCompletedSlice;
  const line = (id) => `\`${id}\` — ${cell(sliceTitle(all.get(id)))}`;
  return [
    `| Latest completed slice | ${line(latest.id)} (PR #${latest.pr}, merge ${short(latest.mergeSha)}) |`,
    `| Active slices | ${(pointer.activeSlices ?? []).map(line).join('<br>') || '— (none)'} |`,
    `| Verifying (merged, post-merge verification pending) | ${(pointer.verifyingSlices ?? []).map((entry) => `${line(entry.id)} (PR #${entry.pr}, merge ${short(entry.mergeSha)}): ${cell(entry.pending)}`).join('<br>') || '— (none)'} |`,
    `| Planned queue (in order; planned ≠ authorized) | ${(pointer.plannedQueue ?? []).map((id) => `\`${id}\``).join(', ') || '—'} |`,
    `| Blocked | ${(pointer.blockedSlices ?? []).map((id) => `\`${id}\` — blocked by ${cell(all.get(id)?.blockedBy)}`).join('<br>') || '—'} |`,
    `| Not authorized | ${cell(pointer.notAuthorized)} |`,
    `| Historical P2 ladder pointer | \`${pointer.historicalLastP2Milestone}\` (history, not active work) |`,
    `| Last verified main | ${short(pointer.lastVerifiedMain)} |`,
  ];
}

export const README_MARKERS = Object.freeze({
  begin: '<!-- BEGIN GENERATED milestone-governance: npm run lego:ai renders this block from docs/n8n-lego/milestones.json; do not edit by hand -->',
  end: '<!-- END GENERATED milestone-governance -->',
});

/** Completion contribution. Derived only from slice status. Verifying is not a status and never counts. */
export function completionPercentForStatus(status) {
  if (status === 'implemented' || status === 'retired') return 100;
  return 0;
}

/** Retired is historical and stays out of the active completion ratio unless the register opts in. */
export function countsTowardCompletion(slice) {
  if (slice?.status === 'retired' && slice?.includeInCompletion !== true) return false;
  return slice?.status === 'implemented';
}

const OUT_OF_ACTIVE_DENOMINATOR = new Set(['superseded', 'retired', 'rejected']);

/** Active denominator: superseded, retired and rejected stay out. Deferred stays in and contributes 0. */
export function inActiveCompletionTotal(slice) {
  if (slice?.status === 'retired' && slice?.includeInCompletion === true) return true;
  if (OUT_OF_ACTIVE_DENOMINATOR.has(slice?.status)) return false;
  return true;
}

export function percent1(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function formatPercent(value) {
  return `${Number(value).toFixed(1)}%`;
}

export function progressBar(percent, width = 20) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = clamped >= 100 ? width : clamped <= 0 ? 0 : Math.round((clamped / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

export function sliceRecords(register) {
  return [...(register.programs ?? []), ...(register.futurePrograms ?? [])].flatMap((entity) => (entity.slices ?? []).map((slice) => ({
    slice,
    parentId: entity.id,
    parentTitle: entity.title,
    parentStatus: entity.status,
    parentScope: entity.scope ?? entity.rule ?? '',
    currentDelivery: (register.programs ?? []).includes(entity),
  })));
}

export function verifyingIndex(register) {
  return new Map((register.executionPointer?.verifyingSlices ?? []).map((entry) => [entry.id, entry]));
}

export function displayStatus(slice, verifying) {
  return verifying.has(slice.id) ? 'verifying' : slice.status;
}

export function slicePurpose(slice) {
  if (typeof slice.purpose === 'string' && slice.purpose.trim()) return slice.purpose.trim();
  const title = String(slice.title ?? '').trim();
  const parts = title.split(/: /);
  return parts.length > 1 ? parts.slice(1).join(': ').trim() : title;
}

const STATUS_LABEL = Object.freeze({
  implemented: '✅ Implemented',
  verifying: '🟠 Verifying',
  planned: '🟡 Planned',
  blocked: '🔴 Blocked',
  proposed: '⚪ Proposed',
  'in-progress': '🔵 In progress',
  deferred: 'Deferred',
  superseded: 'Superseded',
  retired: 'Retired',
  rejected: 'Rejected',
});

export function statusLabel(status) {
  return STATUS_LABEL[status] ?? status;
}

export const CHECKPOINT_STATUSES = Object.freeze(['planned', 'in-progress', 'completed', 'blocked', 'skipped']);
export const LEGACY_IMPLEMENTED_POINTS = 100;
export const NO_CHECKPOINT_MODEL_POINTS = 0;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * DEC-0021 (LIVE-MILESTONE EXCEPTION). Progress telemetry — and only progress
 * telemetry — may be reconciled straight to `main` by the Manager, without a
 * governance PR. Everything a progress-only commit is allowed to touch is
 * listed here; anything else is implementation and still needs a delivery PR.
 */
export const LIVE_PROGRESS_MODEL = Object.freeze({
  decision: 'DEC-0021',
  name: 'LIVE-MILESTONE EXCEPTION',
  commitPrefix: 'governance(progress):',
  tool: 'tools/lego/progress-event.mjs',
  register: 'docs/n8n-lego/milestones.json',
  publicProjection: 'README.md',
  generatedProjections: Object.freeze(['.ai/master/MILESTONE_REGISTER.md', '.ai/master/CURRENT_STATUS.md']),
  evidenceRoot: 'docs/n8n-lego/evidence/',
});

/** Paths a `governance(progress):` commit may touch (DEC-0021). Nothing else. */
export const LIVE_PROGRESS_PATHS = Object.freeze([
  LIVE_PROGRESS_MODEL.register,
  LIVE_PROGRESS_MODEL.publicProjection,
  ...LIVE_PROGRESS_MODEL.generatedProjections,
  LIVE_PROGRESS_MODEL.evidenceRoot,
]);

/**
 * Classify a set of changed paths for a direct-main progress commit. Returns the
 * allowed paths and the violations; `ok` is false when any path is not pure
 * telemetry, which is how a progress commit is stopped from smuggling in
 * implementation, contracts, CI, Cargo or runner configuration (DEC-0021 §20).
 */
export function classifyProgressCommit(paths = []) {
  const allowed = [];
  const violations = [];
  for (const raw of paths) {
    const path = String(raw ?? '').trim().replace(/^\.\//, '');
    if (!path) continue;
    const permitted = LIVE_PROGRESS_PATHS.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
    (permitted ? allowed : violations).push(path);
  }
  return { ok: violations.length === 0, allowed, violations, decision: LIVE_PROGRESS_MODEL.decision };
}

/** DEC-0021: the register's own declaration of the live-progress path must stay truthful. */
export function validateLiveProgressModel(register) {
  const errors = [];
  const model = register?.governance?.progressModel?.liveException;
  if (!model) return errors;
  const fail = (message) => errors.push(`progressModel.liveException: ${message}`);
  if (model.decision !== LIVE_PROGRESS_MODEL.decision) fail(`decision must be ${LIVE_PROGRESS_MODEL.decision}`);
  if (model.commitPrefix !== LIVE_PROGRESS_MODEL.commitPrefix) fail(`commitPrefix must be ${LIVE_PROGRESS_MODEL.commitPrefix}`);
  if (model.tool !== LIVE_PROGRESS_MODEL.tool) fail(`tool must be ${LIVE_PROGRESS_MODEL.tool}`);
  if (!Array.isArray(model.directMainPaths) || model.directMainPaths.length === 0) fail('directMainPaths must be a non-empty array');
  else {
    const classified = classifyProgressCommit(model.directMainPaths);
    if (!classified.ok) fail(`directMainPaths contains non-telemetry paths: ${classified.violations.join(', ')}`);
    for (const required of [LIVE_PROGRESS_MODEL.register, LIVE_PROGRESS_MODEL.publicProjection, ...LIVE_PROGRESS_MODEL.generatedProjections]) {
      if (!model.directMainPaths.includes(required)) fail(`directMainPaths must include ${required}`);
    }
  }
  if (!model.noBatching) fail('noBatching must be recorded');
  if (!model.forbidden) fail('forbidden must record what the exception never covers');
  if (Array.isArray(model.checkpointStatuses) && JSON.stringify(model.checkpointStatuses) !== JSON.stringify(CHECKPOINT_STATUSES)) {
    fail(`checkpointStatuses must be ${JSON.stringify(CHECKPOINT_STATUSES)}`);
  }
  return errors;
}

/**
 * Issue #307. Weights are never invented here. A slice contributes checkpoint
 * points only when `slice.checkpoints` declares them. Otherwise an implemented
 * slice contributes the legacy 100, and every other slice contributes 0.
 * Verifying and blocked do not zero earned checkpoint points and do not count
 * toward slice completion.
 */
export function validateSliceCheckpoints(slice) {
  const errors = [];
  if (!slice || slice.checkpoints == null) return errors;
  const checkpoints = slice.checkpoints;
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    errors.push(`${slice.id}: checkpoints must be a non-empty array or omitted`);
    return errors;
  }
  const seen = new Set();
  let weight = 0;
  for (const checkpoint of checkpoints) {
    const id = checkpoint?.id;
    if (!id || seen.has(id)) errors.push(`${slice.id}: checkpoint id missing or duplicate`);
    if (id) seen.add(id);
    if (!checkpoint?.title || !String(checkpoint.title).trim()) errors.push(`${slice.id}: checkpoint ${id ?? '?'} has no title`);
    if (!CHECKPOINT_STATUSES.includes(checkpoint?.status)) errors.push(`${slice.id}: checkpoint ${id ?? '?'} status is not completed, in-progress, blocked or planned`);
    if (!Number.isInteger(checkpoint?.weight) || checkpoint.weight <= 0) errors.push(`${slice.id}: checkpoint ${id ?? '?'} weight must be a positive integer`);
    else weight += checkpoint.weight;
    if (checkpoint?.status === 'completed' && !String(checkpoint.evidence ?? '').trim()) {
      errors.push(`${slice.id}: completed checkpoint ${id ?? '?'} has no evidence`);
    }
    if (checkpoint?.status === 'blocked' && !String(checkpoint.blockedBy ?? slice.blockedBy ?? '').trim()) {
      errors.push(`${slice.id}: blocked checkpoint ${id ?? '?'} has no blocker`);
    }
    if (checkpoint?.status === 'skipped' && !String(checkpoint.reason ?? '').trim()) {
      errors.push(`${slice.id}: skipped checkpoint ${id ?? '?'} has no reason`);
    }
  }
  if (weight !== 100) errors.push(`${slice.id}: checkpoint weights sum to ${weight}, not 100`);
  if (slice.status === 'implemented' && checkpoints.some((checkpoint) => checkpoint?.status !== 'completed')) {
    errors.push(`${slice.id}: an implemented slice cannot carry an incomplete checkpoint`);
  }
  // DEC-0021: live progress is always timestamped, so a reader of the register alone
  // knows how fresh the state is without opening chat.
  if (!ISO_TIMESTAMP.test(slice.updatedAt ?? '')) {
    errors.push(`${slice.id}: a slice with checkpoints must record updatedAt (ISO-8601 Z)`);
  }
  return errors;
}

export function sliceDeliveryProgress(slice) {
  const checkpoints = Array.isArray(slice?.checkpoints) && slice.checkpoints.length ? slice.checkpoints : null;
  if (checkpoints) {
    const earned = checkpoints.filter((checkpoint) => checkpoint.status === 'completed').reduce((sum, checkpoint) => sum + checkpoint.weight, 0);
    const open = checkpoints.find((checkpoint) => checkpoint.status === 'in-progress' || checkpoint.status === 'blocked') ?? null;
    const latestCompleted = [...checkpoints].reverse().find((checkpoint) => checkpoint.status === 'completed') ?? null;
    return { percent: earned, earned, total: 100, source: 'checkpoints', current: open, latestCompleted };
  }
  if (slice?.status === 'implemented') {
    return { percent: LEGACY_IMPLEMENTED_POINTS, earned: LEGACY_IMPLEMENTED_POINTS, total: 100, source: 'legacy-implemented', current: null, latestCompleted: null };
  }
  return { percent: NO_CHECKPOINT_MODEL_POINTS, earned: NO_CHECKPOINT_MODEL_POINTS, total: 100, source: 'no-checkpoint-model', current: null, latestCompleted: null };
}

export function completionContribution(slice) {
  return countsTowardCompletion(slice) ? 100 : 0;
}

export function completionTally(slices) {
  const counted = slices.filter(inActiveCompletionTotal);
  const implemented = counted.filter(countsTowardCompletion).length;
  const byStatus = {};
  for (const slice of counted) byStatus[slice.status] = (byStatus[slice.status] ?? 0) + 1;
  return {
    total: counted.length,
    implemented,
    percent: percent1(implemented, counted.length),
    byStatus,
  };
}

function deliverySummary(slices) {
  const tally = completionTally(slices);
  const active = slices.filter(inActiveCompletionTotal);
  const progress = active.map((slice) => sliceDeliveryProgress(slice));
  const earned = progress.reduce((sum, item) => sum + item.earned, 0);
  const points = progress.reduce((sum, item) => sum + item.total, 0);
  return {
    ...tally,
    sliceCompletion: tally.percent,
    realtime: percent1(earned, points),
    earned,
    points,
    checkpointed: progress.filter((item) => item.source === 'checkpoints').length,
    legacyImplemented: progress.filter((item) => item.source === 'legacy-implemented').length,
    withoutModel: progress.filter((item) => item.source === 'no-checkpoint-model').length,
  };
}

/** Headline metrics. Future programs are visible and excluded from both denominators. */
export function headlineMetrics(register) {
  const current = (register.programs ?? []).flatMap((program) => program.slices ?? []);
  const future = (register.futurePrograms ?? []).flatMap((program) => program.slices ?? []);
  return { current: deliverySummary(current), future: deliverySummary(future) };
}

export function programTally(entity, verifying) {
  const slices = entity.slices ?? [];
  const summary = deliverySummary(slices);
  return {
    ...summary,
    verifying: slices.filter((slice) => verifying.has(slice.id)).length,
    planned: slices.filter((slice) => slice.status === 'planned').length,
    blocked: slices.filter((slice) => slice.status === 'blocked').length,
    inProgress: slices.filter((slice) => slice.status === 'in-progress' && !verifying.has(slice.id)).length,
    proposed: slices.filter((slice) => slice.status === 'proposed').length,
    remaining: summary.total - summary.implemented,
  };
}

function tallyLine(tally) {
  const parts = [`${tally.implemented} implemented`];
  for (const [status, label] of [['verifying', 'verifying'], ['inProgress', 'in progress'], ['planned', 'planned'], ['blocked', 'blocked'], ['proposed', 'proposed']]) {
    if (tally[status]) parts.push(`${tally[status]} ${label}`);
  }
  return parts.join(', ');
}

function checkpointText(checkpoint) {
  if (!checkpoint) return '—';
  const weight = Number.isInteger(checkpoint.weight) ? `, ${checkpoint.weight}` : '';
  return `${checkpoint.id} ${checkpoint.title} (${checkpoint.status}${weight})`;
}

function checkpointColumns(slice) {
  const progress = sliceDeliveryProgress(slice);
  if (progress.source === 'checkpoints') {
    return {
      current: checkpointText(progress.current),
      latest: progress.latestCompleted ? checkpointText(progress.latestCompleted) : '—',
    };
  }
  if (progress.source === 'legacy-implemented') {
    return { current: 'none declared', latest: 'legacy implemented (100, no checkpoint list)' };
  }
  return { current: 'none declared', latest: 'none declared' };
}

/** DEC-0021: every completed checkpoint with the evidence that completed it. */
function checkpointEvidenceLine(slice) {
  const completed = (slice?.checkpoints ?? []).filter((checkpoint) => checkpoint.status === 'completed');
  if (!completed.length) return '— (no completed checkpoint)';
  return completed.map((checkpoint) => `${checkpoint.id}: ${checkpoint.evidence ?? '—'}${checkpoint.reference ? ` [${checkpoint.reference}]` : ''}`).join('; ');
}

/** DEC-0021: when the live state was last moved, and by which reference. */
function updateLine(slice) {
  if (!slice?.updatedAt) return '—';
  return `${slice.updatedAt}${slice.latestUpdate ? ` — ${slice.latestUpdate}` : ''}`;
}

function progressNote(slice) {
  const progress = sliceDeliveryProgress(slice);
  if (progress.source === 'checkpoints') return 'Checkpoint-weighted from declared slice.checkpoints. Incomplete checkpoints contribute 0.';
  if (progress.source === 'legacy-implemented') return 'No checkpoint list. Implemented slices contribute 100 until an evidenced checkpoint model says otherwise.';
  return 'No checkpoint model is declared, so realtime progress stays 0.0%. That 0 is not a measured fraction of the work, and evidenced work is not converted into a percentage.';
}

/** README.md projection of the canonical register (DEC-0020, Issue #307). Not a second register. */
export function renderReadmeMilestoneSection(register) {
  const gov = register.governance;
  const authority = gov.milestoneAuthority;
  const verifying = verifyingIndex(register);
  const records = sliceRecords(register);
  const byId = new Map(records.map((record) => [record.slice.id, record]));
  const metrics = headlineMetrics(register);
  const current = metrics.current;
  const future = metrics.future;
  const programs = register.programs ?? [];
  const futures = register.futurePrograms ?? [];
  const currentRecords = records.filter((record) => record.currentDelivery);
  const verifyingCount = currentRecords.filter((record) => verifying.has(record.slice.id)).length;
  const inProgressOnly = currentRecords.filter((record) => record.slice.status === 'in-progress' && !verifying.has(record.slice.id)).length;
  const programRows = programs.map((program) => {
    const tally = programTally(program, verifying);
    return `| ${program.id} | ${cell(program.title)} | ${formatPercent(tally.realtime)} | ${formatPercent(tally.percent)} | ${tally.implemented}/${tally.total} | ${program.status} |`;
  });
  const bars = programs.map((program) => {
    const tally = programTally(program, verifying);
    return `${program.id.padEnd(4)} realtime ${progressBar(tally.realtime)} ${formatPercent(tally.realtime).padStart(6)}  completion ${formatPercent(tally.percent).padStart(6)}  ${tally.implemented}/${tally.total}  status ${program.status}`;
  });
  const pointer = register.executionPointer ?? {};
  const queue = [
    ...(pointer.verifyingSlices ?? []).map((entry) => entry.id),
    ...(pointer.activeSlices ?? []),
    ...(pointer.plannedQueue ?? []),
  ];
  const queueLines = queue.map((id, index) => {
    const slice = byId.get(id)?.slice;
    const shown = slice ? displayStatus(slice, verifying) : 'unknown';
    const progress = slice ? sliceDeliveryProgress(slice) : { percent: 0 };
    const contribution = slice ? completionContribution(slice) : 0;
    const updated = slice?.updatedAt ? `; updated ${slice.updatedAt}` : '';
    return `${String(index + 1).padStart(2, ' ')}. \`${id}\` ${shown}; realtime ${formatPercent(progress.percent)}; completion contribution ${formatPercent(contribution)}${updated}`;
  });
  const verifyingBlocks = (pointer.verifyingSlices ?? []).map((entry) => {
    const slice = byId.get(entry.id)?.slice;
    const progress = slice ? sliceDeliveryProgress(slice) : { percent: 0, source: 'no-checkpoint-model', current: null, latestCompleted: null };
    const columns = slice ? checkpointColumns(slice) : { current: 'none declared', latest: 'none declared' };
    return [
      `### 🟠 ${entry.id} — ${cell(sliceTitle(slice))}`,
      '',
      `- **Status:** VERIFYING. Status is not progress. Merged work is not implemented. Completion contribution: **0%**.`,
      `- **Realtime Delivery Progress:** ${formatPercent(progress.percent)}. ${progressNote(slice)}`,
      `- **Completion contribution:** **0%**.`,
      `- **Current checkpoint:** ${cell(columns.current)}`,
      `- **Latest checkpoint:** ${cell(columns.latest)}`,
      `- **Checkpoint evidence:** ${cell(checkpointEvidenceLine(slice))}`,
      `- **Last progress update:** ${cell(updateLine(slice))}`,
      `- **Purpose:** ${cell(slice ? slicePurpose(slice) : '—')}`,
      `- **Evidence:** ${cell(slice?.evidence)}`,
      `- **PR:** #${entry.pr} · **Merge:** ${short(entry.mergeSha)} · **Head:** ${entry.headSha ? short(entry.headSha) : '—'}`,
      `- **Pending:** ${cell(entry.pending)}`,
      '',
    ].join('\n');
  });
  const blockedBlocks = (pointer.blockedSlices ?? []).map((id) => {
    const slice = byId.get(id)?.slice;
    const progress = slice ? sliceDeliveryProgress(slice) : { percent: 0 };
    const columns = slice ? checkpointColumns(slice) : { current: 'none declared', latest: 'none declared' };
    return `- 🔴 **${id}** — ${cell(sliceTitle(slice))}. Status: BLOCKED. Realtime ${formatPercent(progress.percent)}. ${progressNote(slice)} Current checkpoint: ${cell(columns.current)}. Latest checkpoint: ${cell(columns.latest)}. Checkpoint evidence: ${cell(checkpointEvidenceLine(slice))}. Blocker: ${cell(slice?.blockedBy)}. Last progress update: ${cell(updateLine(slice))}. Completion contribution: 0%.`;
  });
  const ladder = (register.milestones ?? []).filter((milestone) => milestone.status === 'complete').map((milestone) => milestone.id);
  const generic = (register.milestones ?? []).filter((milestone) => milestone.status !== 'complete').map((milestone) => `\`${milestone.id}\` (${milestone.status})`);
  const sliceTable = (entity) => {
    const rows = (entity.slices ?? []).map((slice) => {
      const shown = displayStatus(slice, verifying);
      const progress = sliceDeliveryProgress(slice);
      const columns = checkpointColumns(slice);
      return `| \`${slice.id}\` | ${cell(sliceTitle(slice))} | ${cell(slicePurpose(slice))} | ${statusLabel(shown)} | ${formatPercent(progress.percent)} | ${formatPercent(completionContribution(slice))} | ${cell(columns.current)} | ${cell(columns.latest)} | ${cell(slice.blockedBy)} |`;
    });
    return rows.join('\n');
  };
  const programSections = programs.map((entity) => {
    const tally = programTally(entity, verifying);
    return `## ${entity.id} — ${cell(entity.title)}

- **Realtime Delivery Progress:** **${formatPercent(tally.realtime)}** \`${progressBar(tally.realtime)} ${formatPercent(tally.realtime)}\`
- **Slice Completion:** **${formatPercent(tally.percent)}** (${tally.implemented} / ${tally.total} implemented). Remaining ${tally.remaining}. ${tallyLine(tally)}.
- **Program status:** ${entity.status}. Program status is not a percentage and is not 100% just because the word is complete.
- **Purpose:** ${cell(entity.scope ?? entity.rule ?? entity.title)}
- **Checkpoint model:** ${tally.checkpointed} slice(s) declare checkpoints; ${tally.legacyImplemented} implemented slice(s) use the legacy 100 rule; ${tally.withoutModel} slice(s) have no checkpoint model and stay at 0.0%.

<details><summary>Slices (${tally.total})</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
${sliceTable(entity)}

</details>`;
  });
  const futureSections = futures.map((entity) => {
    const tally = programTally(entity, verifying);
    return `## ${entity.id} — ${cell(entity.title)}

Excluded from the current-delivery denominator. Realtime **${formatPercent(tally.realtime)}**. Slice completion **${formatPercent(tally.percent)}** (${tally.implemented} / ${tally.total}). Program status: ${entity.status}.

<details><summary>Slices (${tally.total})</summary>

| Slice | Title | Purpose | Status | Realtime | Completion | Current checkpoint | Latest checkpoint | Blocker |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
${sliceTable(entity)}

</details>`;
  });
  const futureRows = futures.map((item) => {
    const tally = programTally(item, verifying);
    return `| ${item.id} | ${(item.legacyMilestones ?? []).join(', ') || '—'} | ${formatPercent(tally.realtime)} | ${formatPercent(tally.percent)} | ${tally.implemented}/${tally.total} | ${item.status} |`;
  });
  const model = gov.progressModel;
  const modelLine = model
    ? `- **Progress model (${model.decision}):** ${model.realtimeName} is checkpoint-weighted across ${model.currentDelivery}. ${model.completionName} is implemented / active in that same denominator. ${model.futurePrograms}. ${model.examplesAreNotMeasurements} ${model.weights} This projection is not canonical until the change is on main.`
    : '- **Progress model:** Realtime Delivery Progress is checkpoint-weighted across P0–P11. Slice Completion is implemented / active in that denominator. Future programs are excluded. Weights are never invented.';
  return `${README_MARKERS.begin}
## Overall Milestone Progress

Status is not progress. Both percentages below are generated from [\`docs/n8n-lego/milestones.json\`](docs/n8n-lego/milestones.json). They are not estimated from time, PR count or lines of code. Rounding is half-up to one decimal, never a ceiling.

### Realtime Delivery Progress

**${formatPercent(current.realtime)}**

\`${progressBar(current.realtime)} ${formatPercent(current.realtime)}\`

Checkpoint-weighted earned points / current-delivery points: ${current.earned} / ${current.points}. Denominator: programs P0–P11 only (${current.total} active slices). Future programs are excluded. ${current.checkpointed} slice(s) declare checkpoints. ${current.legacyImplemented} implemented slice(s) have no checkpoint list and contribute 100 each. ${current.withoutModel} slice(s) have no checkpoint model and contribute 0. A 0 from a missing model is not a measured fraction of that slice.

### Slice Completion

**${formatPercent(current.sliceCompletion)}**

\`${progressBar(current.sliceCompletion)} ${formatPercent(current.sliceCompletion)}\`

**${current.implemented} / ${current.total} slices implemented** in the same P0–P11 denominator. Only \`implemented\` increases this numerator. Verifying, blocked, in-progress, planned, proposed and deferred contribute 0. Superseded, retired and rejected stay out of the denominator.

| | |
| --- | ---: |
| Current-delivery slices | ${current.total} |
| Implemented (completion numerator) | ${current.implemented} |
| Verifying (display status; completion contribution 0) | ${verifyingCount} |
| In progress, not verifying | ${inProgressOnly} |
| Planned | ${current.byStatus.planned ?? 0} |
| Blocked | ${current.byStatus.blocked ?? 0} |
| Proposed | ${current.byStatus.proposed ?? 0} |
| Deferred | ${current.byStatus.deferred ?? 0} |
| Future-program slices excluded from both denominators | ${future.total} |

\`\`\`text
${bars.join('\n')}
\`\`\`

## Program Overview

| Program | Focus | Realtime | Slice completion | Implemented | State |
| --- | --- | ---: | ---: | ---: | --- |
${programRows.join('\n')}

A program state of \`complete\` is not numeric 100%. Read the two percentage columns.

## Active Execution

### Active work

The queue is \`executionPointer\` only. Historical \`P2.27\` is not the next slice, and there is no \`P2.28\`.

\`\`\`text
${queueLines.join('\n')}
\`\`\`

${pointer.latestCompletedSlice ? `Latest completed slice: \`${pointer.latestCompletedSlice.id}\` (PR #${pointer.latestCompletedSlice.pr}, merge ${short(pointer.latestCompletedSlice.mergeSha)}).` : '_No completed slice recorded._'}

${verifyingBlocks.join('\n') || '_No verifying slice._'}

${blockedBlocks.length ? `### Blocked\n\n${blockedBlocks.join('\n')}` : ''}

Planned queue (planned ≠ authorized): ${(pointer.plannedQueue ?? []).map((id) => `\`${id}\``).join(' → ') || '—'}.

Not authorized: ${cell(pointer.notAuthorized)}

## Status Legend

- ✅ Implemented — realtime 100% when no checkpoint list is declared; the only status that adds to Slice Completion
- 🟠 Verifying — display status for a merged slice whose post-merge verification has not passed. Checkpoint progress is kept. Completion contribution 0%
- 🔵 In progress — checkpoint progress if declared, otherwise 0%. Completion contribution 0%
- 🟡 Planned — 0% until an evidenced checkpoint exists. Completion contribution 0%
- 🔴 Blocked — last evidenced checkpoint progress is kept. The blocker stays visible. Completion contribution 0%
- ⚪ Proposed — 0%. Completion contribution 0%
- Deferred — prior evidenced checkpoint progress if declared, otherwise 0%. Completion contribution 0%

## P0–P11

${programSections.join('\n\n')}

## Future programs (legacy P12–P23 consolidated)

These programs stay visible. They are not in the Realtime Delivery Progress denominator and not in the Slice Completion denominator.

| Future program | Legacy milestones | Realtime | Slice completion | Slices implemented | State |
| --- | --- | ---: | ---: | ---: | --- |
${futureRows.join('\n')}

${futureSections.join('\n\n')}

## Historical P2 ladder

${ladder.length} completed milestones (\`${ladder[0]}\` … \`${ladder.at(-1)}\`, with the \`P2.27.x\` sub-slices under program P2) are immutable implementation history. Historical pointers: current \`${register.currentMilestone}\`, previous completed \`${register.previousCompletedMilestone}\` (history, not active work).${generic.length ? ` The generic ${generic.join(', ')} row is a historical placeholder label; it authorizes no work.` : ''}

## Milestone Governance

- **Milestone authority:** \`main\` owns milestone truth (DEC-0020). Canonical register: [\`docs/n8n-lego/milestones.json\`](docs/n8n-lego/milestones.json); generated projections: this section of \`README.md\`, \`.ai/master/MILESTONE_REGISTER.md\` and \`.ai/master/CURRENT_STATUS.md\`. \`arena-manager\` is Manager planning memory only (canonical: false); \`docs/n8n-lego/ROADMAP.md\` is strategy narrative and owns no status.
- **Live progress (DEC-0021, LIVE-MILESTONE EXCEPTION):** checkpoint progress, checkpoint status, checkpoint evidence, current checkpoint, slice / program / overall progress and the milestone evidence of a slice still in flight are operational telemetry. The Manager may reconcile them straight to \`main\` in a \`governance(progress):\` commit, without a governance PR, with \`node tools/lego/progress-event.mjs record --slice <id> --checkpoint <CP-nn> --status <status> --evidence <reference>\`. The tool runs the whole atomic chain: validate evidence and weights → write the register → regenerate \`README.md\` and \`.ai\` → run \`npm run lego:ai:check\` → commit → push → verify \`main\`. One measurable event is one commit; live progress is never batched and a partial state is never published. The Manager never types a percentage: \`resolve\` derives the state from evidence — \`--fetch\` reads the DEC-0015 jobs and the runner availability from the GitHub API, \`--jobs <file.json>\` reads an export, and \`verify --cmd\` derives completed / blocked from a verification command's exit code. A checkpoint that declares \`requires\` is earned only when every named check has passed; an absent self-hosted check is never PASS and \`WAITING_RUNNER\` is never PASS, so a head that never ran the suite cannot look green. Two paths, never mixed: delivery state is implementation → delivery PR → merge → post-merge verification → one governance PR reconciling status, merge SHA, evidence and projections; telemetry is evidence → checkpoint update → register → README → .ai → a \`governance(progress):\` commit → main. A slice status becoming \`implemented\` is delivery state and is never telemetry. The exception never covers source code, tests, runtime behaviour, API / frontend / backend / contract / schema implementation, dependencies, packages, Rust code, CI workflows, security policy, permissions, infrastructure, database schema or production configuration — those still go through a delivery PR. Live telemetry never bypasses a completion gate: 100% realtime progress with a completion contribution of 0% is a legitimate state, and only \`implemented\` (DEC-0014 + DEC-0015) moves Slice Completion.
- **Rule:** ${authority.rule}
- **Pending reconciliation:** ${authority.pendingReconciliation}
- **Freshness:** generated by \`npm run lego:ai\` from register ${register.registerVersion} (fingerprint \`${registerFingerprint(register)}\`); \`npm run lego:ai:check\` fails when this section, the \`.ai\` pack or the register disagree.
${modelLine}
- **Completion KPI:** Slice Completion is implemented slices / active slices in P0–P11. A verifying or blocked slice never increases that numerator. Realtime Delivery Progress is a separate checkpoint-weighted figure and can move while Slice Completion stays still.
- **Purpose field:** a slice purpose is \`slice.purpose\` when present, otherwise the text after the first \`: \` in the canonical title, otherwise the title. No purpose is invented.
- **Top level:** programs P0–P11 only. There is no P12+ or P24+ and no P5.9; legacy P12–P23 are consolidated into future programs. New work is \`Pn-Snn\`, \`Pn-Mnn\` or \`FUTURE-<THEME>-Snn\`.
- **Post-merge sequence:** ${authority.postMergeSequence.join(' → ')}.
- **No batching:** ${authority.noBatching}
- **Completion rule:** ${gov.completionRule}
- One delivery PR per slice (DEC-0014); the post-merge register/README/.ai reconciliation of a delivery is a separate governance PR, not a second delivery PR. Progress telemetry is the other path (DEC-0021) and never carries delivery state.
- A slice cycle is closed only when implementation, register, this README section, the generated \`.ai\` and evidence agree on \`main\`.
- Evidence lives in \`docs/n8n-lego/evidence/\`; each slice's \`evidence\` field names its file.
${README_MARKERS.end}`;
}

/** Replace (or report) the generated block inside README.md text. */
export function syncReadmeMilestoneSection(readme, register) {
  const block = renderReadmeMilestoneSection(register);
  const start = readme.indexOf(README_MARKERS.begin);
  const end = readme.indexOf(README_MARKERS.end);
  if (start === -1 || end === -1 || end < start) return { ok: false, text: null, reason: 'README.md has no milestone-governance markers' };
  const text = readme.slice(0, start) + block + readme.slice(end + README_MARKERS.end.length);
  return { ok: true, text, changed: text !== readme };
}

export function countBy(items, key) {
  const counts = {};
  for (const item of items) counts[item[key]] = (counts[item[key]] ?? 0) + 1;
  return counts;
}

const cell = (value) => String(value ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const short = (sha) => (sha ? `\`${sha.slice(0, 8)}\`` : '—');
const issues = (list) => (list ?? []).map((n) => `#${n}`).join(', ') || '—';

function nextSlice(program) {
  return (program.slices ?? []).find((slice) => slice.status === 'in-progress')
    ?? (program.slices ?? []).find((slice) => slice.status === 'planned')
    ?? null;
}

/** Markdown sections rendered into the generated MILESTONE_REGISTER.md. */
export function renderGovernanceSections(register) {
  const gov = register.governance;
  const programs = register.programs ?? [];
  const futures = register.futurePrograms ?? [];
  const features = register.features ?? [];
  const byParent = new Map();
  for (const feature of features) {
    if (!byParent.has(feature.parent)) byParent.set(feature.parent, []);
    byParent.get(feature.parent).push(feature);
  }
  const statusOrder = gov.statusVocabulary;
  const featureCounts = countBy(features, 'status');
  const top = programs.map((program) => {
    const done = program.slices.filter((slice) => slice.status === 'implemented').length;
    const next = nextSlice(program);
    return `| **${program.id}** | ${cell(program.title)} | **${program.status.toUpperCase()}** | ${done}/${program.slices.length} | ${(byParent.get(program.id) ?? []).length} | ${next ? `\`${next.id}\` (${next.status})` : '—'} |`;
  });
  const futureTop = futures.map((future) => {
    const next = nextSlice(future);
    return `| **${future.id}** | ${cell(future.title)} | ${future.legacyMilestones.join(', ')} | ${issues(future.legacyIssues)} | ${future.status} | ${(byParent.get(future.id) ?? []).length} | ${next ? `\`${next.id}\`` : '—'} |`;
  });
  const sliceTable = (slices) => ['| Slice | Title | Status | PR | Merge SHA | Issue |', '| --- | --- | --- | --- | --- | --- |',
    ...slices.map((slice) => `| \`${slice.id}\` | ${cell(slice.title)}${slice.blockedBy ? ` **Blocked by:** ${cell(slice.blockedBy)}` : ''} | ${slice.status} | ${slice.pr ? `#${slice.pr}` : '—'} | ${short(slice.mergeSha)} | ${slice.issue ? `#${slice.issue}` : '—'} |`)].join('\n');
  const featureTable = (list) => ['| Feature | Title | Status | Relevance | Slice | Issues | Merge SHA |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...list.map((feature) => `| \`${feature.id}\` | ${cell(feature.title)} | ${feature.status} | ${feature.relevance} | ${feature.slice ? `\`${feature.slice}\`` : '—'} | ${issues(feature.sourceIssue)} | ${short(feature.mergeSha)} |`)].join('\n');
  const detail = (entity) => {
    const list = byParent.get(entity.id) ?? [];
    const extra = [entity.acceptance ? `**Acceptance:** ${entity.acceptance}` : '', entity.legacyLadder ? `**Historical ladder:** ${entity.legacyLadder}` : '',
      entity.domainAffinity ? `**Domain affinity (#254 mapping):** ${entity.domainAffinity.join('; ')}` : '',
      entity.designDecisions ? `**Design decisions:** ${entity.designDecisions.join(' ')}` : ''].filter(Boolean).join('\n\n');
    return `### ${entity.id} — ${entity.title} (${entity.status})

${entity.scope ?? entity.rule ?? ''}${extra ? `\n\n${extra}` : ''}

**Source issues:** ${issues(entity.sourceIssues ?? entity.legacyIssues)}

<details><summary>Slices (${entity.slices.length})</summary>

${sliceTable(entity.slices)}

</details>

<details><summary>Features (${list.length}: ${Object.entries(countBy(list, 'status')).map(([s, n]) => `${n} ${s}`).join(', ') || 'none'})</summary>

${list.length ? featureTable(list) : '_none_'}

</details>`;
  };
  const metrics = headlineMetrics(register);
  const progressTable = (register.programs ?? []).map((program) => {
    const tally = programTally(program, verifyingIndex(register));
    return `| ${program.id} | ${formatPercent(tally.realtime)} | ${formatPercent(tally.percent)} | ${tally.implemented}/${tally.total} | ${program.status} |`;
  }).join('\n');
  return `## Delivery progress (same two metrics as README.md)

**Realtime Delivery Progress ${formatPercent(metrics.current.realtime)}** — ${metrics.current.earned}/${metrics.current.points} checkpoint-weighted points, P0–P11 only. Future programs are excluded (${metrics.future.total} slices). ${metrics.current.withoutModel} current-delivery slice(s) have no checkpoint model and contribute 0.

**Slice Completion ${formatPercent(metrics.current.sliceCompletion)}** — ${metrics.current.implemented}/${metrics.current.total} implemented. Verifying and blocked contribute 0. Program status is not this percentage.

| Program | Realtime | Slice completion | Implemented | State |
| --- | ---: | ---: | ---: | --- |
${progressTable}

## Active work (executionPointer, DEC-0020)

| | |
| --- | --- |
${activeWorkLines(register).join('\n')}

## Programs P0–P11 (top level)

| Program | Title | Status | Slices implemented | Features | Next slice |
| --- | --- | --- | --- | --- | --- |
${top.join('\n')}

> ${gov.noNewTopLevelMilestones}

## Future programs (legacy P12–P23, consolidated)

| Program | Title | Legacy milestones | Legacy issues | Status | Features | Next slice |
| --- | --- | --- | --- | --- | --- | --- |
${futureTop.join('\n')}

Legacy traceability: legacy issue → feature (\`sourceIssue\`) → program (\`parent\`) → future slice (\`slice\`).

## Feature registry summary

| Status | Features |
| --- | --- |
${statusOrder.map((status) => `| ${status} | ${featureCounts[status] ?? 0} |`).join('\n')}
| **total** | **${features.length}** |

Relevance: ${Object.entries(countBy(features, 'relevance')).map(([r, n]) => `${r} ${n}`).join(', ')}.

## Governance rules

- **Intake flow:** ${gov.intakeFlow.join(' → ')}.
- **Completion:** ${gov.completionRule}
${gov.deliveryModel ? `- **Delivery model (${gov.deliveryModel.decision}):** Slice = ${gov.deliveryModel.slice}, Task = ${gov.deliveryModel.task}, PR = ${gov.deliveryModel.pr}. ${gov.deliveryModel.invariant} Slice completion gate: ${gov.deliveryModel.completionGate.map((g, i) => `(${i + 1}) ${g}`).join('; ')}.\n` : ''}- **Slice naming:** ${Object.entries(gov.sliceNaming).map(([k, v]) => `${k}: ${v}`).join('; ')}.
- **Status vocabulary:** ${gov.statusVocabulary.map((s) => `\`${s}\``).join(', ')}. **Relevance:** ${gov.relevanceVocabulary.map((s) => `\`${s}\``).join(', ')}.
- **Invariants:** ${gov.invariants.join('; ')}.
- **Pointer scope:** ${gov.pointerScope}
${gov.milestoneAuthority ? `- **Milestone authority (${gov.milestoneAuthority.decision}):** ${gov.milestoneAuthority.rule} Post-merge sequence: ${gov.milestoneAuthority.postMergeSequence.join(' → ')}. ${gov.milestoneAuthority.noBatching}\n` : ''}
- **Branches:** ${gov.branchPolicy}
- **Runner protocol:** ${gov.runnerProtocol}

## Program detail

${programs.map(detail).join('\n\n')}

## Future program detail

${futures.map(detail).join('\n\n')}

## Governance items

${featureTable(byParent.get('GOVERNANCE') ?? [])}
`;
}
