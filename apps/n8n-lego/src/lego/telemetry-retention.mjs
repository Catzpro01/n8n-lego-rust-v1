/** P9.15 telemetry retention + HOT/WARM/COLD policy. Product owner agent-6;
 * implementation delegate Agent 4 (Issue #101). Signal-specific retention with
 * deterministic expiry, policy-controlled incident extension, audit/security
 * retention distinct from normal telemetry, real removal/compaction of expired
 * records, deletion isolated from authoritative workflow state, and safe
 * degradation under storage pressure before corruption. No I/O, no clock (now
 * is an argument), no workflow/execution/credential import. The store only
 * ever holds telemetry records — never workflows, executions, checkpoints,
 * credentials, triggers, or the node registry.
 */
import { containsSecretShape } from './telemetry-redaction.mjs';

export const RETENTION_CONTRACT = Object.freeze({
  id: 'observability.telemetry-retention', version: '1.0.0', owner: 'agent-6',
});
export const RETENTION_SCHEMA_VERSION = '1.0.0';

/** Residence tiers from #101 deep design §17 (retention plane). */
export const RETENTION_TIERS = Object.freeze(['HOT', 'WARM', 'COLD']);

/** Signal classes with independent retention policies. */
export const RETENTION_SIGNALS = Object.freeze([
  'log', 'metric', 'trace', 'audit', 'security', 'replay', 'diagnostic',
]);

/** What a retention pass may do to a record (observable, policy-driven). */
export const RETENTION_ACTIONS = Object.freeze([
  'kept', 'promoted', 'demoted', 'compacted', 'expired', 'shed', 'extended',
]);

/** Priorities for pressure shedding: lower sheds first; audit/security last. */
export const RETENTION_PRIORITIES = Object.freeze(['P0', 'P1', 'P2', 'P3', 'P4']);
const RET_RANK = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 });
const SIGNAL_DEFAULT_PRIORITY = Object.freeze({
  security: 'P0', audit: 'P0', diagnostic: 'P1', log: 'P2',
  trace: 'P3', metric: 'P3', replay: 'P2',
});

export const RETENTION_LIMITS = Object.freeze({
  identifierBytes: 128,
  maxRecords: 4096,
  maxSignals: RETENTION_SIGNALS.length,
  minTtlMs: 1,
  maxTtlMs: 365 * 24 * 60 * 60 * 1000,
  minHotMs: 0,
  maxIncidentExtendMs: 30 * 24 * 60 * 60 * 1000,
  maxBytes: 64 * 1024 * 1024,
  recordBytesMin: 1,
  recordBytesMax: 1024 * 1024,
});

export const RETENTION_NOTES = Object.freeze([
  'signal-specific-ttl',
  'deterministic-expiry',
  'incident-extension-policy-controlled',
  'audit-distinct-from-telemetry',
  'deletion-isolated-from-authoritative-state',
  'pressure-degrades-before-corrupt',
]);

// ---- Authoritative-state isolation ---------------------------------------
// Retention NEVER touches these. The store accepts only telemetry record shapes;
// any attempt to address workflow/execution/credential/etc. identity is refused.
export const AUTHORITATIVE_KINDS = Object.freeze([
  'workflow', 'execution', 'checkpoint', 'credential',
  'triggerRegistration', 'nodeRegistry',
]);

const POLICY_SPEC_KEYS = Object.freeze(['signals', 'incident']);
const SIGNAL_POLICY_KEYS = Object.freeze([
  'hotMs', 'warmMs', 'ttlMs', 'incidentExtendMs', 'maxIncidentExtendMs',
]);
const INCIDENT_POLICY_KEYS = Object.freeze(['allowExtension', 'maxExtendMs', 'signals']);
const RECORD_KEYS = Object.freeze([
  'id', 'signal', 'priority', 'bytes', 'createdAt', 'body', 'incidentId',
]);

function isPlain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedId(value) {
  if (typeof value !== 'string' || value.length === 0 ||
      value.length > RETENTION_LIMITS.identifierBytes) return null;
  if (containsSecretShape(value)) return null;
  if (/\b(?:bearer|basic)\s+\S/i.test(value)) return null;
  if (/\b(?:password|secret|token|api[-_]?key)\s*[:=]\s*\S/i.test(value)) return null;
  return value;
}

function defaultPolicyFor(signal) {
  // Signal-specific defaults (ms): logs shortest; audit/security longest;
  // metrics aggregated longer than raw logs; traces sampled/selected;
  // replay tied to artifact-class longer retention; diagnostics incident-shaped.
  const table = {
    log: { hotMs: 5 * 60_000, warmMs: 60 * 60_000, ttlMs: 24 * 60 * 60_000,
           incidentExtendMs: 60 * 60_000, maxIncidentExtendMs: 6 * 60 * 60_000 },
    metric: { hotMs: 5 * 60_000, warmMs: 24 * 60 * 60_000, ttlMs: 7 * 24 * 60 * 60_000,
              incidentExtendMs: 60 * 60_000, maxIncidentExtendMs: 24 * 60 * 60_000 },
    trace: { hotMs: 5 * 60_000, warmMs: 60 * 60_000, ttlMs: 7 * 24 * 60 * 60_000,
             incidentExtendMs: 60 * 60_000, maxIncidentExtendMs: 24 * 60 * 60_000 },
    audit: { hotMs: 60 * 60_000, warmMs: 7 * 24 * 60 * 60_000, ttlMs: 90 * 24 * 60 * 60_000,
             incidentExtendMs: 24 * 60 * 60_000, maxIncidentExtendMs: 90 * 24 * 60 * 60_000 },
    security: { hotMs: 60 * 60_000, warmMs: 7 * 24 * 60 * 60_000, ttlMs: 365 * 24 * 60 * 60_000,
                incidentExtendMs: 24 * 60 * 60_000, maxIncidentExtendMs: 180 * 24 * 60 * 60_000 },
    replay: { hotMs: 60 * 60_000, warmMs: 24 * 60 * 60_000, ttlMs: 30 * 24 * 60 * 60_000,
              incidentExtendMs: 60 * 60_000, maxIncidentExtendMs: 7 * 24 * 60 * 60_000 },
    diagnostic: { hotMs: 5 * 60_000, warmMs: 60 * 60_000, ttlMs: 14 * 24 * 60 * 60_000,
                  incidentExtendMs: 60 * 60_000, maxIncidentExtendMs: 7 * 24 * 60 * 60_000 },
  };
  return table[signal];
}

/**
 * Compile a retention policy from `{ signals?, incident? }`.
 * Missing signals fall back to documented defaults (signal-specific, not one TTL).
 * Fail closed → null on invalid shape, inverted windows, or secret-shaped fields.
 */
export function createRetentionPolicy(spec = {}) {
  if (!isPlain(spec)) return null;
  if (Reflect.ownKeys(spec).some(k => !POLICY_SPEC_KEYS.includes(k))) return null;
  if (containsSecretShape(spec)) return null;

  const signals = {};
  const inSignals = spec.signals === undefined ? {} : spec.signals;
  if (!isPlain(inSignals)) return null;
  for (const signal of RETENTION_SIGNALS) {
    const raw = inSignals[signal];
    const base = defaultPolicyFor(signal);
    if (raw === undefined) {
      const maxIncidentExtendMs = Math.min(base.maxIncidentExtendMs,
        RETENTION_LIMITS.maxIncidentExtendMs, base.ttlMs);
      const incidentExtendMs = Math.min(base.incidentExtendMs, maxIncidentExtendMs, base.ttlMs);
      signals[signal] = Object.freeze({
        hotMs: base.hotMs, warmMs: base.warmMs, ttlMs: base.ttlMs,
        incidentExtendMs, maxIncidentExtendMs,
      });
      continue;
    }
    if (!isPlain(raw)) return null;
    if (Reflect.ownKeys(raw).some(k => !SIGNAL_POLICY_KEYS.includes(k))) return null;
    const hotMs = raw.hotMs === undefined ? base.hotMs : raw.hotMs;
    const warmMs = raw.warmMs === undefined ? base.warmMs : raw.warmMs;
    const ttlMs = raw.ttlMs === undefined ? base.ttlMs : raw.ttlMs;
    // Defaults may advertise long incident windows; clamp to the contract ceiling
    // so partial overrides stay valid (limits are part of the public contract).
    const maxIncidentExtendMs = Math.min(
      raw.maxIncidentExtendMs === undefined ? base.maxIncidentExtendMs : raw.maxIncidentExtendMs,
      RETENTION_LIMITS.maxIncidentExtendMs,
      ttlMs,
    );
    const incidentExtendMs = Math.min(
      raw.incidentExtendMs === undefined ? base.incidentExtendMs : raw.incidentExtendMs,
      maxIncidentExtendMs,
      ttlMs,
    );
    for (const v of [hotMs, warmMs, ttlMs, incidentExtendMs, maxIncidentExtendMs]) {
      if (!Number.isSafeInteger(v) || v < 0) return null;
    }
    if (ttlMs < RETENTION_LIMITS.minTtlMs || ttlMs > RETENTION_LIMITS.maxTtlMs) return null;
    if (hotMs > warmMs || warmMs > ttlMs) return null;
    if (incidentExtendMs > maxIncidentExtendMs) return null;
    signals[signal] = Object.freeze({ hotMs, warmMs, ttlMs, incidentExtendMs, maxIncidentExtendMs });
  }

  let incident;
  if (spec.incident === undefined) {
    incident = Object.freeze({
      allowExtension: true,
      maxExtendMs: RETENTION_LIMITS.maxIncidentExtendMs,
      signals: Object.freeze([...RETENTION_SIGNALS]),
    });
  } else {
    if (!isPlain(spec.incident)) return null;
    if (Reflect.ownKeys(spec.incident).some(k => !INCIDENT_POLICY_KEYS.includes(k))) return null;
    const allowExtension = spec.incident.allowExtension === undefined
      ? true : spec.incident.allowExtension;
    if (typeof allowExtension !== 'boolean') return null;
    const maxExtendMs = spec.incident.maxExtendMs === undefined
      ? RETENTION_LIMITS.maxIncidentExtendMs : spec.incident.maxExtendMs;
    if (!Number.isSafeInteger(maxExtendMs) || maxExtendMs < 0 ||
        maxExtendMs > RETENTION_LIMITS.maxIncidentExtendMs) return null;
    let signalsAllow = [...RETENTION_SIGNALS];
    if (spec.incident.signals !== undefined) {
      if (!Array.isArray(spec.incident.signals) || spec.incident.signals.length === 0) return null;
      signalsAllow = [];
      for (const s of spec.incident.signals) {
        if (!RETENTION_SIGNALS.includes(s)) return null;
        if (!signalsAllow.includes(s)) signalsAllow.push(s);
      }
    }
    incident = Object.freeze({
      allowExtension, maxExtendMs, signals: Object.freeze(signalsAllow),
    });
  }

  return Object.freeze({ schemaVersion: RETENTION_SCHEMA_VERSION, signals: Object.freeze(signals), incident });
}

/**
 * Deterministic residency for a record age under a policy:
 * age < hotMs → HOT; age < warmMs → WARM; age < ttlMs → COLD; else EXPIRED.
 * Pure: (age, policy) → tier. Same inputs → same tier anywhere.
 */
export function classifyResidency(ageMs, policy) {
  if (!Number.isSafeInteger(ageMs) || ageMs < 0) return null;
  if (!isPlain(policy)) return null;
  if (!Number.isSafeInteger(policy.hotMs) || !Number.isSafeInteger(policy.warmMs) ||
      !Number.isSafeInteger(policy.ttlMs)) return null;
  if (ageMs < policy.hotMs) return 'HOT';
  if (ageMs < policy.warmMs) return 'WARM';
  if (ageMs < policy.ttlMs) return 'COLD';
  return 'EXPIRED';
}

function normalizeRecord(raw, now) {
  if (!isPlain(raw)) return null;
  if (Reflect.ownKeys(raw).some(k => !RECORD_KEYS.includes(k))) return null;
  const id = boundedId(raw.id);
  if (id === null) return null;
  if (!RETENTION_SIGNALS.includes(raw.signal)) return null;
  const priority = raw.priority === undefined ? SIGNAL_DEFAULT_PRIORITY[raw.signal] : raw.priority;
  if (!RETENTION_PRIORITIES.includes(priority)) return null;
  if (!Number.isSafeInteger(raw.bytes) || raw.bytes < RETENTION_LIMITS.recordBytesMin ||
      raw.bytes > RETENTION_LIMITS.recordBytesMax) return null;
  if (!Number.isSafeInteger(raw.createdAt) || raw.createdAt < 0 || raw.createdAt > now) return null;
  // body is optional opaque payload reference; must not be secret-shaped
  if (raw.body !== undefined && containsSecretShape(raw.body)) return null;
  let incidentId = null;
  if (raw.incidentId !== undefined && raw.incidentId !== null) {
    incidentId = boundedId(raw.incidentId);
    if (incidentId === null) return null;
  }
  return Object.freeze({
    id, signal: raw.signal, priority, bytes: raw.bytes, createdAt: raw.createdAt,
    ...(raw.body !== undefined ? { body: raw.body } : {}),
    ...(incidentId !== null ? { incidentId } : {}),
    // extension bookkeeping (absolute expiry cap after incident extension)
    expiresAt: null, // filled by caller with policy.ttlMs
    tier: 'HOT',
    extended: false,
  });
}

/** Wrap a normalized record with absolute expiry from its signal policy. */
function withExpiry(rec, policy) {
  const pol = policy.signals[rec.signal];
  return Object.freeze({
    ...rec,
    expiresAt: rec.createdAt + pol.ttlMs,
    tier: 'HOT',
  });
}

/**
 * Build a retention store: `{ schemaVersion, policy, records: Map, stats, byteBudget }`.
 * Holds ONLY telemetry records (see AUTHORITATIVE_KINDS isolation). Fail closed → null.
 */
export function createRetentionStore(config) {
  if (!isPlain(config)) return null;
  if (Reflect.ownKeys(config).some(k => !['policy', 'byteBudget'].includes(k))) return null;
  const policy = config.policy === undefined ? createRetentionPolicy({}) : config.policy;
  if (policy === null) return null;
  if (config.byteBudget !== undefined) {
    if (!Number.isSafeInteger(config.byteBudget) || config.byteBudget < RETENTION_LIMITS.recordBytesMin ||
        config.byteBudget > RETENTION_LIMITS.maxBytes) return null;
  }
  return {
    schemaVersion: RETENTION_SCHEMA_VERSION,
    policy,
    byteBudget: config.byteBudget === undefined ? null : config.byteBudget,
    records: new Map(),
    stats: {
      ingested: 0, expired: 0, shed: 0, extended: 0, compacted: 0,
      transitions: 0, refusedAuthoritative: 0, bytes: 0,
    },
  };
}

/**
 * Ingest one telemetry record at logical time `now`. Refuses authoritative-state
 * identities and secret-shaped bodies. Returns frozen outcome string.
 */
export function ingestRecord(store, record, now) {
  if (!store || !isPlain(store) || !(store.records instanceof Map)) return 'rejected';
  if (!Number.isSafeInteger(now) || now < 0) return 'rejected';
  if (store.records.size >= RETENTION_LIMITS.maxRecords) return 'rejected';
  // Isolation: refuse anything that claims to be authoritative state.
  if (isPlain(record)) {
    const kind = record.kind;
    if (typeof kind === 'string' && AUTHORITATIVE_KINDS.includes(kind)) {
      store.stats.refusedAuthoritative++;
      return 'refused_authoritative';
    }
  }
  const rec = normalizeRecord(record, now);
  if (rec === null) return 'rejected';
  if (store.records.has(rec.id)) return 'duplicate';
  const full = withExpiry(rec, store.policy);
  // Ingest-time expiry check: already past TTL → do not admit
  if (full.expiresAt <= now) return 'expired_on_ingest';
  store.records.set(full.id, full);
  store.stats.ingested++;
  store.stats.bytes += full.bytes;
  return 'kept';
}

/**
 * Deterministic transition + expiry pass at logical time `now`.
 * - promotes/demotes residency by age (classifyResidency)
 * - EXPIRED records are REMOVED (compaction: count bytes freed)
 * Never touches anything outside store.records (authoritative isolation).
 * Returns frozen `{ removed, transitions, bytesFreed, remaining }`.
 */
export function applyRetentionPass(store, now) {
  if (!store || !(store.records instanceof Map)) return null;
  if (!Number.isSafeInteger(now) || now < 0) return null;
  const transitions = [];
  const expired = [];
  for (const [id, rec] of store.records) {
    const pol = store.policy.signals[rec.signal];
    const ageMs = now - rec.createdAt;
    let nextTier;
    if (now >= rec.expiresAt) {
      nextTier = 'EXPIRED';
    } else if (rec.extended) {
      // Extended records never re-enter HOT (incident evidence sits warm/cold).
      nextTier = ageMs < pol.warmMs ? 'WARM' : 'COLD';
    } else {
      nextTier = classifyResidency(ageMs, pol);
      if (nextTier === 'EXPIRED') nextTier = 'COLD'; // absolute expiresAt is authoritative below
    }
    if (nextTier === 'EXPIRED') {
      expired.push(id);
      continue;
    }
    if (nextTier !== rec.tier) {
      transitions.push(Object.freeze({ id, from: rec.tier, to: nextTier }));
      store.records.set(id, Object.freeze({ ...rec, tier: nextTier }));
      store.stats.transitions++;
    }
  }
  let bytesFreed = 0;
  for (const id of expired) {
    const rec = store.records.get(id);
    if (rec) {
      bytesFreed += rec.bytes;
      store.stats.bytes -= rec.bytes;
      store.records.delete(id);
      store.stats.expired++;
      store.stats.compacted++;
    }
  }
  return Object.freeze({
    removed: Object.freeze(expired),
    transitions: Object.freeze(transitions),
    bytesFreed,
    remaining: store.records.size,
  });
}

/**
 * Policy-controlled incident extension. Only when policy.incident.allowExtension;
 * only for allow-listed signals; each signal capped by min(signal.maxIncidentExtendMs,
 * policy.incident.maxExtendMs) from now (not unbounded). Deterministic.
 * Returns frozen `{ extended: [ids], refused: [ids], expiresAtById }`.
 */
export function extendForIncident(store, spec, now) {
  if (!store || !(store.records instanceof Map)) return null;
  if (!isPlain(spec)) return null;
  if (Reflect.ownKeys(spec).some(k => !['incidentId', 'signals', 'extendMs'].includes(k))) return null;
  if (!Number.isSafeInteger(now) || now < 0) return null;
  const incidentId = boundedId(spec.incidentId);
  if (incidentId === null) return null;
  if (!Number.isSafeInteger(spec.extendMs) || spec.extendMs <= 0) return null;
  const signals = spec.signals === undefined ? [...store.policy.incident.signals] : spec.signals;
  if (!Array.isArray(signals) || signals.length === 0) return null;

  const extended = [];
  const refused = [];
  const expiresAtById = {};
  const inc = store.policy.incident;
  if (!inc.allowExtension) {
    return Object.freeze({
      extended: Object.freeze([]),
      refused: Object.freeze(signals.map(s => `policy:${s}`)),
      expiresAtById: Object.freeze({}),
      reason: 'extension-disabled',
    });
  }
  for (const [id, rec] of store.records) {
    // Extend records already linked to this incident, or any matching signal in list
    const matches = rec.incidentId === incidentId || signals.includes(rec.signal);
    if (!matches) continue;
    if (!inc.signals.includes(rec.signal) || !signals.includes(rec.signal)) {
      refused.push(id);
      continue;
    }
    const pol = store.policy.signals[rec.signal];
    const cap = Math.min(pol.maxIncidentExtendMs, inc.maxExtendMs);
    const grant = Math.min(spec.extendMs, pol.incidentExtendMs, cap);
    if (grant <= 0) {
      refused.push(id);
      continue;
    }
    const nextExpiry = Math.max(rec.expiresAt, now + grant);
    // Never exceed absolute max extension from original TTL end
    const absMax = rec.expiresAt + cap;
    const finalExpiry = Math.min(nextExpiry, Math.max(rec.expiresAt, rec.createdAt + pol.ttlMs + cap));
    void absMax;
    if (finalExpiry > rec.expiresAt) {
      store.records.set(id, Object.freeze({
        ...rec, incidentId, expiresAt: finalExpiry, extended: true, tier: rec.tier === 'EXPIRED' ? 'COLD' : rec.tier,
      }));
      store.stats.extended++;
      extended.push(id);
      expiresAtById[id] = finalExpiry;
    } else {
      refused.push(id);
      expiresAtById[id] = rec.expiresAt;
    }
  }
  return Object.freeze({
    extended: Object.freeze(extended),
    refused: Object.freeze(refused),
    expiresAtById: Object.freeze(expiresAtById),
  });
}

/**
 * Storage-pressure degradation: when total bytes exceed byteBudget, shed
 * records lowest-priority first (P4 → P1), audit/security (P0) last.
 * Never sheds when under budget. Never "repairs" bytes by mutating payloads
 * (corruption); only whole-record shed or keep. Returns frozen report.
 */
export function applyStoragePressure(store, now) {
  if (!store || !(store.records instanceof Map)) return null;
  if (!Number.isSafeInteger(now) || now < 0) return null;
  if (store.byteBudget === null) {
    return Object.freeze({ shed: Object.freeze([]), bytes: store.stats.bytes, degraded: false, reason: 'no-budget' });
  }
  if (store.stats.bytes <= store.byteBudget) {
    return Object.freeze({ shed: Object.freeze([]), bytes: store.stats.bytes, degraded: false, reason: 'within-budget' });
  }
  // Candidate order: highest priority rank number first (P4 first), then oldest id asc for determinism
  const candidates = [...store.records.values()]
    .filter(r => r.priority !== 'P0') // P0 audit/security never shed by pressure
    .sort((a, b) => {
      const d = RET_RANK[b.priority] - RET_RANK[a.priority]; // P4 before P3 ...
      if (d !== 0) return d;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  const shed = [];
  for (const rec of candidates) {
    if (store.stats.bytes <= store.byteBudget) break;
    store.records.delete(rec.id);
    store.stats.bytes -= rec.bytes;
    store.stats.shed++;
    shed.push(Object.freeze({ id: rec.id, priority: rec.priority, signal: rec.signal, bytes: rec.bytes }));
  }
  const degraded = store.stats.bytes > store.byteBudget; // P0-only overflow remains degraded, not corrupted
  return Object.freeze({
    shed: Object.freeze(shed),
    bytes: store.stats.bytes,
    degraded,
    reason: degraded ? 'budget-floor-p0' : 'degraded-to-budget',
  });
}

/**
 * Deletion isolation: delete ONLY telemetry record ids from the store.
 * Refuses authoritative-kind claims. Never receives a workflow/execution map —
 * there isn't one. Returns frozen outcome.
 */
export function deleteTelemetryRecord(store, id) {
  if (!store || !(store.records instanceof Map)) return null;
  const rid = boundedId(id);
  if (rid === null) return 'rejected';
  if (typeof id === 'string' && AUTHORITATIVE_KINDS.some(k => id.startsWith(`${k}:`))) {
    store.stats.refusedAuthoritative++;
    return 'refused_authoritative';
  }
  const rec = store.records.get(rid);
  if (!rec) return 'missing';
  store.stats.bytes -= rec.bytes;
  store.records.delete(rid);
  return 'deleted';
}

/** Deterministic snapshot of tier histogram + counters (no Map iteration order dependence). */
export function retentionReport(store) {
  if (!store || !(store.records instanceof Map)) return null;
  const tiers = { HOT: 0, WARM: 0, COLD: 0 };
  const bySignal = {};
  for (const sig of RETENTION_SIGNALS) bySignal[sig] = 0;
  const ids = [...store.records.keys()].sort();
  for (const id of ids) {
    const rec = store.records.get(id);
    if (tiers[rec.tier] !== undefined) tiers[rec.tier]++;
    bySignal[rec.signal]++;
  }
  return Object.freeze({
    schemaVersion: RETENTION_SCHEMA_VERSION,
    contract: Object.freeze({ ...RETENTION_CONTRACT }),
    tiers: Object.freeze(tiers),
    bySignal: Object.freeze(bySignal),
    stats: Object.freeze({ ...store.stats }),
    byteBudget: store.byteBudget,
    recordCount: store.records.size,
    ids: Object.freeze(ids),
  });
}
