/** P9.10 health / readiness model. Product owner agent-6;
 * implementation delegate Agent 4 (Issue #101). LIVENESS (can process?) and
 * READINESS (should receive new work?) are distinct axes; DEGRADED (reduced
 * guarantees) and UNAVAILABLE (cannot provide the capability) are distinct
 * conditions. Reason codes are structured and machine-readable. Startup and
 * recovery transitions are explicit phases. False-healthy is rejected: a
 * critical dependency that is unavailable forces NOT_READY + UNAVAILABLE —
 * never a generic green while critical dependencies are down. Health queries
 * are bounded (fixed dependency table, O(n) ≤ maxDependencies) and cheap
 * (pure, no I/O, no clock). The health report itself stays available during
 * DEGRADED/UNAVAILABLE (queries return structure, they do not fail closed to
 * empty). P9 reports; P3/P4/P6 policy decides.
 */
export const HEALTH_CONTRACT = Object.freeze({
  id: 'observability.health-readiness', version: '1.0.0', owner: 'agent-6',
});
/** Axis 1 — can the component process anything? */
export const LIVENESS_STATES = Object.freeze(['ALIVE', 'DEAD']);
/** Axis 2 — should this component receive new work? */
export const READINESS_STATES = Object.freeze(['READY', 'NOT_READY']);
/** Operating condition — DEGRADED and UNAVAILABLE are intentionally distinct. */
export const CONDITION_STATES = Object.freeze(['HEALTHY', 'DEGRADED', 'UNAVAILABLE']);
/** Startup / recovery lifecycle phases (transitions defined + tested). */
export const HEALTH_PHASES = Object.freeze(['STARTING', 'RUNNING', 'RECOVERING']);
/** Structured reason codes — namespace.category_action, stable vocabulary. */
export const HEALTH_REASON_CODES = Object.freeze([
  'startup.in_progress',
  'startup.complete',
  'liveness.probe_failed',
  'liveness.probe_recovered',
  'readiness.critical_dependency_down',
  'readiness.dependencies_not_ready',
  'readiness.ready',
  'condition.degraded_dependency',
  'condition.critical_unavailable',
  'condition.healthy',
  'recovery.in_progress',
  'recovery.complete',
  'false_healthy.rejected',
  'dependency.unknown',
]);
export const HEALTH_LIMITS = Object.freeze({
  maxDependencies: 64,
  maxReasons: 32,
  maxIdBytes: 128,
  maxDetailBytes: 256,
});
const CONFIG_KEYS = Object.freeze(['dependencies', 'maxDependencies']);
const DEP_KEYS = Object.freeze(['id', 'critical', 'initial']);

function isPlain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function boundedString(value, maxBytes) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length > maxBytes) return null;
  return value;
}

/**
 * Create a health/readiness model. Fail-closed: invalid config → null.
 * Dependencies form a fixed table (max 64) — queries stay O(n) and cheap.
 */
export function createHealthModel(config) {
  try {
    if (config !== undefined && config !== null && !isPlain(config)) return null;
    const cfg = config ?? {};
    const keys = Reflect.ownKeys(cfg);
    if (keys.some(k => !CONFIG_KEYS.includes(k))) return null;

    const maxDependencies = cfg.maxDependencies === undefined
      ? HEALTH_LIMITS.maxDependencies : cfg.maxDependencies;
    if (!Number.isSafeInteger(maxDependencies) || maxDependencies < 1 ||
        maxDependencies > HEALTH_LIMITS.maxDependencies) return null;

    /** Fixed dependency table: id → { critical, available, degraded, reason } */
    const deps = new Map();
    if (cfg.dependencies !== undefined) {
      if (!Array.isArray(cfg.dependencies)) return null;
      if (cfg.dependencies.length > maxDependencies) return null;
      for (const raw of cfg.dependencies) {
        if (!isPlain(raw)) return null;
        const dk = Reflect.ownKeys(raw);
        if (dk.some(k => !DEP_KEYS.includes(k))) return null;
        const id = boundedString(raw.id, HEALTH_LIMITS.maxIdBytes);
        if (!id || deps.has(id)) return null;
        if (raw.critical !== undefined && typeof raw.critical !== 'boolean') return null;
        const critical = raw.critical === true;
        let available = false;
        let degraded = false;
        let reason = 'dependency.unknown';
        if (raw.initial !== undefined) {
          if (!isPlain(raw.initial)) return null;
          const ik = Reflect.ownKeys(raw.initial);
          if (ik.some(k => !['available', 'degraded', 'reason'].includes(k))) return null;
          if (raw.initial.available !== undefined && typeof raw.initial.available !== 'boolean') return null;
          if (raw.initial.degraded !== undefined && typeof raw.initial.degraded !== 'boolean') return null;
          if (raw.initial.reason !== undefined &&
              boundedString(raw.initial.reason, HEALTH_LIMITS.maxDetailBytes) === null) return null;
          available = raw.initial.available === true;
          degraded = raw.initial.degraded === true;
          reason = raw.initial.reason ?? (available ? 'condition.healthy' : 'dependency.unknown');
        }
        deps.set(id, { critical, available, degraded, reason });
      }
    }

    // Lifecycle state
    let phase = 'STARTING';
    let liveness = 'ALIVE'; // optimistic process; probe can mark DEAD
    let livenessReason = 'startup.in_progress';
    let falseHealthyAttempts = 0;
    let queries = 0;
    let transitions = 0;
    let lastTransition = null;

    function addReason(list, code, detail) {
      if (list.length >= HEALTH_LIMITS.maxReasons) return;
      const entry = detail === undefined
        ? code
        : `${code}:${detail}`;
      if (!list.includes(entry)) list.push(entry);
    }

    function transition(nextPhase) {
      if (nextPhase === phase) return null;
      const from = phase;
      phase = nextPhase;
      transitions++;
      lastTransition = Object.freeze({ from, to: nextPhase });
      return lastTransition;
    }

    /**
     * Record a dependency observation. available=false on a critical dep
     * immediately flips readiness path on next evaluate (false-healthy block).
     */
    function setDependency(id, observation) {
      const key = boundedString(id, HEALTH_LIMITS.maxIdBytes);
      if (!key || !deps.has(key)) return false;
      if (!isPlain(observation)) return false;
      const ok = Reflect.ownKeys(observation)
        .every(k => ['available', 'degraded', 'reason'].includes(k));
      if (!ok) return false;
      const dep = deps.get(key);
      if (observation.available !== undefined) {
        if (typeof observation.available !== 'boolean') return false;
        dep.available = observation.available;
      }
      if (observation.degraded !== undefined) {
        if (typeof observation.degraded !== 'boolean') return false;
        dep.degraded = observation.degraded;
      }
      if (observation.reason !== undefined) {
        const r = boundedString(observation.reason, HEALTH_LIMITS.maxDetailBytes);
        if (r === null) return false;
        dep.reason = r;
      }
      return true;
    }

    function registerDependency(spec) {
      if (!isPlain(spec)) return false;
      if (deps.size >= maxDependencies) return false;
      const id = boundedString(spec.id, HEALTH_LIMITS.maxIdBytes);
      if (!id || deps.has(id)) return false;
      const dk = Reflect.ownKeys(spec);
      if (dk.some(k => !['id', 'critical', 'initial'].includes(k))) return false;
      // reuse initial parsing by delegating through a one-element config path
      const critical = spec.critical === true;
      deps.set(id, {
        critical,
        available: false,
        degraded: false,
        reason: 'dependency.unknown',
      });
      if (spec.initial !== undefined) return setDependency(id, spec.initial);
      return true;
    }

    function probeLiveness(alive) {
      if (typeof alive !== 'boolean') return false;
      if (alive) {
        if (liveness === 'DEAD') {
          liveness = 'ALIVE';
          addReason([], 'liveness.probe_recovered'); // side-effect free vocab touch
          livenessReason = 'liveness.probe_recovered';
          transitions++;
        } else {
          livenessReason = 'startup.complete';
        }
      } else {
        liveness = 'DEAD';
        livenessReason = 'liveness.probe_failed';
      }
      return true;
    }

    function markRunning() {
      if (phase === 'STARTING') {
        transition('RUNNING');
        return true;
      }
      return false;
    }

    function beginRecovery() {
      if (phase === 'RUNNING' || phase === 'RECOVERING') {
        transition('RECOVERING');
        return true;
      }
      return false;
    }

    /**
     * Bounded health query — the core DoD surface. Never throws; always
     * returns a frozen structured report (available even when DEGRADED /
     * UNAVAILABLE).
     */
    function evaluate() {
      queries++;
      try {
        const reasons = [];
        const depReports = [];

        let anyCriticalDown = false;
        let anyDown = anyCriticalDown;
        let anyDegraded = false;
        let unknownDeps = 0;
        let readyDeps = 0;

        for (const [id, dep] of deps) {
          const healthy = dep.available && !dep.degraded;
          const state = !dep.available ? 'UNAVAILABLE'
            : dep.degraded ? 'DEGRADED'
              : 'HEALTHY';
          if (!dep.available && dep.reason === 'dependency.unknown') unknownDeps++;
          if (dep.critical && !dep.available) anyCriticalDown = true;
          if (!dep.available) anyDown = true;
          if (dep.degraded || (!dep.available && !dep.critical)) anyDegraded = anyDegraded || dep.degraded || !dep.available;
          if (healthy) readyDeps++;
          depReports.push(Object.freeze({
            id, critical: dep.critical, state, reason: dep.reason,
          }));
        }
        // any non-critical unavailable counts as degraded-ish only if also degraded flag
        anyDegraded = false;
        for (const dep of deps.values()) {
          if (dep.degraded) anyDegraded = true;
          if (!dep.available && !dep.critical) anyDegraded = true;
        }

        // ---- Liveness axis ----
        const live = liveness;

        // ---- False-healthy rejection ----
        // Critical dependency down ⇒ NEVER READY and NEVER HEALTHY, even if
        // phase claims RUNNING and no one set a flag manually.
        let condition;
        let readiness;
        if (live === 'DEAD') {
          condition = 'UNAVAILABLE';
          readiness = 'NOT_READY';
          addReason(reasons, 'liveness.probe_failed');
        } else if (phase === 'STARTING') {
          condition = 'UNAVAILABLE';
          readiness = 'NOT_READY';
          addReason(reasons, 'startup.in_progress');
        } else if (phase === 'RECOVERING') {
          condition = anyCriticalDown ? 'UNAVAILABLE' : 'DEGRADED';
          readiness = 'NOT_READY';
          addReason(reasons, 'recovery.in_progress');
        } else if (anyCriticalDown) {
          // false-healthy rejected path
          condition = 'UNAVAILABLE';
          readiness = 'NOT_READY';
          falseHealthyAttempts++;
          addReason(reasons, 'false_healthy.rejected');
          addReason(reasons, 'condition.critical_unavailable');
          addReason(reasons, 'readiness.critical_dependency_down');
        } else if (anyDown || anyDegraded) {
          condition = 'DEGRADED';
          readiness = 'NOT_READY'; // degraded ⇒ do not receive *new* work
          addReason(reasons, anyDown ? 'condition.degraded_dependency' : 'condition.degraded_dependency');
          addReason(reasons, 'readiness.dependencies_not_ready');
        } else if (deps.size === 0) {
          // no dependencies declared — RUNNING + probes ok ⇒ healthy/ready
          condition = 'HEALTHY';
          readiness = 'READY';
          addReason(reasons, 'condition.healthy');
          addReason(reasons, 'readiness.ready');
        } else {
          condition = 'HEALTHY';
          readiness = 'READY';
          addReason(reasons, 'condition.healthy');
          addReason(reasons, 'readiness.ready');
        }

        if (phase === 'RUNNING' && readiness === 'READY') {
          addReason(reasons, 'startup.complete');
        }
        if (phase === 'RUNNING' && condition === 'HEALTHY' && anyDegraded === false && unknownDeps > 0) {
          // unknown reason on a dep that is somehow available — keep vocabulary honest
          addReason(reasons, 'dependency.unknown');
        }

        // Attach per-dep reasons (bounded)
        for (const d of depReports) {
          if (d.state !== 'HEALTHY') addReason(reasons, d.reason, d.id);
        }

        return Object.freeze({
          contractVersion: HEALTH_CONTRACT.version,
          phase,
          liveness: live,
          readiness,
          condition,
          // Distinct axes exported flat for cheap consumers:
          isAlive: live === 'ALIVE',
          isReady: readiness === 'READY',
          reasons: Object.freeze(reasons.slice(0, HEALTH_LIMITS.maxReasons)),
          dependencies: Object.freeze(depReports.slice(0, maxDependencies)),
          lastTransition,
        });
      } catch {
        // Query must remain available: structured fail-closed report.
        return Object.freeze({
          contractVersion: HEALTH_CONTRACT.version,
          phase,
          liveness: 'DEAD',
          readiness: 'NOT_READY',
          condition: 'UNAVAILABLE',
          isAlive: false,
          isReady: false,
          reasons: Object.freeze(['dependency.unknown']),
          dependencies: Object.freeze([]),
          lastTransition,
        });
      }
    }

    /**
     * Explicit recovery completion: only valid from RECOVERING; returns the
     * post-transition evaluate() so callers see the recovered report.
     */
    function completeRecovery() {
      if (phase !== 'RECOVERING') return null;
      transition('RUNNING');
      return evaluate();
    }

    function stats() {
      return Object.freeze({
        contractVersion: HEALTH_CONTRACT.version,
        phase,
        liveness,
        transitions,
        lastTransition,
        queries,
        falseHealthyAttempts,
        dependencyCount: deps.size,
        maxDependencies,
      });
    }

    function reset() {
      phase = 'STARTING';
      liveness = 'ALIVE';
      livenessReason = 'startup.in_progress';
      falseHealthyAttempts = 0;
      queries = 0;
      transitions = 0;
      lastTransition = null;
      for (const dep of deps.values()) {
        dep.available = false;
        dep.degraded = false;
        dep.reason = 'dependency.unknown';
      }
    }

    return Object.freeze({
      contract: HEALTH_CONTRACT,
      limits: HEALTH_LIMITS,
      setDependency,
      registerDependency,
      probeLiveness,
      markRunning,
      beginRecovery,
      completeRecovery,
      evaluate,
      stats,
      reset,
    });
  } catch {
    return null;
  }
}
