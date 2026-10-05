/** P9.22 full P9 acceptance. Product owner agent-6; implementation delegate
 * Agent 4 (Issue #101). Codifies the FINAL NON-INTERFERENCE GATE (twelve
 * named checks), OFF-vs-NORMAL workflow equivalence, and the milestone
 * status vocabulary (IMPLEMENTED/PARTIAL/BLOCKED/DEFERRED/COMPLETE).
 * Pure decision helpers — the acceptance test suite supplies observations
 * from the live P9 modules. No I/O, no clock, no workflow/execution import.
 */
import { containsSecretShape } from './telemetry-redaction.mjs';

export const ACCEPT_CONTRACT = Object.freeze({
  id: 'observability.p9-acceptance', version: '1.0.0', owner: 'agent-6',
});
export const ACCEPT_SCHEMA_VERSION = '1.0.0';

/** The twelve final non-interference gates (fixed order). */
export const ACCEPT_GATES = Object.freeze([
  'exporter_unavailable_workflow_continues',
  'exporter_slow_nonblocking',
  'queue_full_sheds_low_priority',
  'tail_sampler_overload_bounded_fallback',
  'extreme_cardinality_reduced',
  'profiling_failure_isolated',
  'ebpf_unavailable_isolated',
  'security_audit_preserved',
  'disk_spill_quota_sheds_low_priority',
  'operator_query_storm_bounded',
  'resource_firewall_degrades_first',
  'policy_change_ab_equivalent',
]);

/** Milestone status vocabulary (P9 final milestone status rule). */
export const ACCEPT_STATUSES = Object.freeze([
  'IMPLEMENTED', 'PARTIAL', 'BLOCKED', 'DEFERRED', 'COMPLETE',
]);

/** COMPLETE requires implementation + tests + evidence + PR + merge + verified main. */
export const ACCEPT_COMPLETE_REQUIREMENTS = Object.freeze([
  'implementation', 'tests', 'evidence', 'pr', 'merge', 'verified_main',
]);

export const ACCEPT_LIMITS = Object.freeze({
  maxGates: 12,
  maxMilestones: 32,
  maxObservationBytes: 65536,
});

export const ACCEPT_NOTES = Object.freeze([
  'twelve-gate-non-interference',
  'off-vs-normal-equivalence',
  'exporter-and-storage-unavailable',
  'queue-and-tail-overload',
  'cardinality-bounded',
  'profiling-ebpf-optional-isolated',
  'security-audit-preserved',
  'resource-firewall-and-low-resource',
  'self-observability-and-oracle',
  'final-benchmarks-and-rollback-documented',
]);

const OBS_KEYS = Object.freeze(['passed', 'detail', 'module']);

function isPlain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function err(code, message, extra = undefined) {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message, ...(extra ? { ...extra } : {}) }),
  });
}

/**
 * Evaluate one non-interference gate observation.
 * observation: { passed: boolean, detail: string, module: string }.
 * Fail-closed: unknown gate or malformed observation → error.
 */
export function evaluateGate(gateId, observation) {
  if (!ACCEPT_GATES.includes(gateId)) {
    return err('accept.invalid_gate', 'unknown gate id');
  }
  if (!isPlain(observation) || Reflect.ownKeys(observation).some(k => !OBS_KEYS.includes(k))) {
    return err('accept.invalid_observation', 'observation must be { passed, detail, module }');
  }
  if (typeof observation.passed !== 'boolean') {
    return err('accept.invalid_observation', 'passed must be boolean');
  }
  if (typeof observation.detail !== 'string' || observation.detail.length === 0 ||
      observation.detail.length > ACCEPT_LIMITS.maxObservationBytes) {
    return err('accept.invalid_observation', 'detail invalid');
  }
  if (typeof observation.module !== 'string' || observation.module.length === 0) {
    return err('accept.invalid_observation', 'module invalid');
  }
  if (containsSecretShape(observation)) {
    return err('accept.secret', 'secret-shaped observation');
  }
  return Object.freeze({
    ok: true,
    verdict: Object.freeze({
      gate: gateId,
      passed: observation.passed,
      status: observation.passed ? 'pass' : 'fail',
      module: observation.module,
      detail: observation.detail,
    }),
  });
}

/**
 * Evaluate all twelve gates. map: { gateId: observation }.
 * Missing or failed gates appear in the summary; all-pass required for ready.
 */
export function evaluateAllGates(map) {
  if (!isPlain(map)) return err('accept.invalid_map', 'map must be an object');
  const verdicts = [];
  for (const gate of ACCEPT_GATES) {
    const obs = map[gate];
    if (obs === undefined) {
      verdicts.push(Object.freeze({
        gate, passed: false, status: 'missing',
        module: null, detail: 'observation missing',
      }));
      continue;
    }
    const r = evaluateGate(gate, obs);
    if (!r.ok) return err('accept.invalid_observation', `gate ${gate}: ${r.error.message}`);
    verdicts.push(r.verdict);
  }
  const passed = verdicts.filter(v => v.passed).length;
  return Object.freeze({
    ok: true,
    summary: Object.freeze({
      total: ACCEPT_GATES.length,
      passed,
      failed: ACCEPT_GATES.length - passed,
      allPassed: passed === ACCEPT_GATES.length,
      verdicts: Object.freeze(verdicts),
    }),
  });
}

/**
 * Telemetry OFF vs NORMAL workflow result equivalence.
 * Two arrays of { input, result } (or frozen result values) must deep-equal
 * on results; inputs must align. Fail-closed on shape mismatch.
 */
export function workflowEquivalence(offResults, normalResults) {
  if (!Array.isArray(offResults) || !Array.isArray(normalResults)) {
    return err('accept.invalid_results', 'both sides must be arrays');
  }
  if (offResults.length === 0 || offResults.length !== normalResults.length) {
    return err('accept.invalid_results', 'sides must be non-empty and equal length');
  }
  const diffs = [];
  for (let i = 0; i < offResults.length; i++) {
    const a = JSON.stringify(offResults[i]);
    const b = JSON.stringify(normalResults[i]);
    if (a !== b) diffs.push(i);
  }
  return Object.freeze({
    ok: true,
    equivalence: Object.freeze({
      samples: offResults.length,
      equivalent: diffs.length === 0,
      diffIndexes: Object.freeze(diffs),
    }),
  });
}

/**
 * Milestone status roll-up. milestones: [{ id, status }] with statuses from
 * ACCEPT_STATUSES. COMPLETE count drives readiness; next may only start when
 * previous is COMPLETE (rule enforced in `nextAllowed`).
 */
export function summarizeMilestones(milestones) {
  if (!Array.isArray(milestones) || milestones.length === 0 ||
      milestones.length > ACCEPT_LIMITS.maxMilestones) {
    return err('accept.invalid_milestones', 'milestones must be a non-empty array');
  }
  const ids = new Set();
  let complete = 0;
  for (const m of milestones) {
    if (!isPlain(m) || typeof m.id !== 'string' || !ACCEPT_STATUSES.includes(m.status)) {
      return err('accept.invalid_milestones', 'each milestone needs { id, status }');
    }
    if (ids.has(m.id)) return err('accept.invalid_milestones', `duplicate id ${m.id}`);
    ids.add(m.id);
    if (m.status === 'COMPLETE') complete++;
  }
  // Sequential rule: every milestone except the last must be COMPLETE for the
  // final acceptance roll-up to claim the lane is merge-ready.
  const ordered = milestones.map(m => m.status);
  let sequentialComplete = true;
  for (let i = 0; i < ordered.length - 1; i++) {
    if (ordered[i] !== 'COMPLETE') { sequentialComplete = false; break; }
  }
  return Object.freeze({
    ok: true,
    rollup: Object.freeze({
      total: milestones.length,
      complete,
      lastStatus: milestones[milestones.length - 1].status,
      // True only when all but last are COMPLETE and last is at least IMPLEMENTED
      // (last may still await merge — Manager integrates).
      laneImplementsThroughLast: sequentialComplete &&
        ['IMPLEMENTED', 'COMPLETE'].includes(milestones[milestones.length - 1].status),
      allComplete: complete === milestones.length,
      statuses: Object.freeze(ordered),
    }),
  });
}

/**
 * Final acceptance verdict: twelve gates + OFF/NORMAL equivalence +
 * milestone roll-up. merge_ready is true only when gates+equivalence pass
 * AND every milestone is COMPLETE (merge+verified_main are Manager-owned).
 */
export function finalAcceptance({ gates, equivalence, milestones } = {}) {
  const g = evaluateAllGates(gates);
  if (!g.ok) return g;
  const e = workflowEquivalence(
    equivalence && equivalence.off, equivalence && equivalence.normal);
  if (!e.ok) return e;
  const m = summarizeMilestones(milestones);
  if (!m.ok) return m;
  return Object.freeze({
    ok: true,
    acceptance: Object.freeze({
      gatesPassed: g.summary.allPassed,
      gatesSummary: g.summary,
      equivalence: e.equivalence,
      milestones: m.rollup,
      // Lane can deliver; merge+verified_main remain external (Manager).
      laneReadyForMergeReview: g.summary.allPassed && e.equivalence.equivalent &&
        m.rollup.laneImplementsThroughLast,
      mergeReady: g.summary.allPassed && e.equivalence.equivalent && m.rollup.allComplete,
    }),
  });
}
