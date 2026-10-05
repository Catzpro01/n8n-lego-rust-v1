/** P9.3 — bounded local metrics, product owner agent-6, delegate Agent 4.
 * No clock, raw sample history, I/O, exporter or business runtime dependency.
 */
import { TELEMETRY_SEVERITIES } from './telemetry-envelope.mjs';

export const METRIC_CONTRACT = Object.freeze({ id: `observability.metrics`, version: '1.0.0', owner: 'agent-6' });
export const METRIC_LIMITS = Object.freeze({ maxSeries: 4096, inputLabels: 8, labelBytes: 64 });
export const LATENCY_BUCKETS_MS = Object.freeze([1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000]);
export const METRIC_LABEL_POLICY = Object.freeze({
  component: Object.freeze(['execution', 'node', 'trigger', 'webhook', 'scheduler', 'ingress', 'registry', 'runtime', 'checkpoint', 'telemetry', 'other']),
  severity: Object.freeze([...TELEMETRY_SEVERITIES, 'other']),
  outcome: Object.freeze(['started', 'completed', 'failed', 'cancelled', 'accepted', 'rejected', 'deferred', 'duplicate', 'rate_limited', 'other']),
});
const definitions = [];
function family(kind, unit, names) {
  for (const name of names.split(' ')) definitions.push(Object.freeze({ name, kind, unit }));
}
family('counter', '1', 'execution.started execution.completed execution.failed execution.cancelled node.started node.completed node.failed node.cold_start checkpoint.operations ingress.accepted ingress.rejected ingress.deferred ingress.duplicate ingress.rate_limited node.admission node.quarantine runtime.lease runtime.startup runtime.rollback telemetry.generated telemetry.dropped telemetry.sampled telemetry.export_failed telemetry.redacted telemetry.cardinality_rejected');
family('gauge', '1', 'node.runtime_load frontier.depth node.health registry.epoch telemetry.buffered');
family('gauge', 'ratio', 'execution.memory_pressure execution.cpu_pressure');
family('histogram', 'ms', 'execution.duration node.duration frontier.wait_time webhook.latency schedule.delay runtime.startup_duration');
export const METRIC_DEFINITIONS = Object.freeze(definitions);
const byName = new Map(METRIC_DEFINITIONS.map(d => [d.name, d]));
const labelKeys = Object.freeze(Object.keys(METRIC_LABEL_POLICY));
const MAX = Number.MAX_SAFE_INTEGER;
const increment = value => Math.min(MAX, value + 1);
function plain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function fields(value, allowed) {
  if (!plain(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length <= allowed.length && keys.every(k => allowed.includes(k) &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, k), 'value'));
}
function normalizeLabels(input) {
  if (!plain(input)) return null;
  const keys = Reflect.ownKeys(input);
  if (keys.length > METRIC_LIMITS.inputLabels) return null;
  let rejected = 0;
  for (const key of keys) {
    if (typeof key !== 'string' || key.length > METRIC_LIMITS.labelBytes) return null;
    // Never read the value of a business-ID, tenant, URL, secret or invented label.
    if (!labelKeys.includes(key)) rejected++;
  }
  const labels = {};
  const parts = [];
  for (const key of labelKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor) continue;
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
    const value = descriptor.value;
    if (typeof value !== 'string' || value.length > METRIC_LIMITS.labelBytes) return null;
    const normalized = METRIC_LABEL_POLICY[key].includes(value) ? value : 'other';
    if (normalized !== value) rejected++;
    labels[key] = normalized;
    parts.push(`${key}=${normalized}`);
  }
  return { labels: Object.freeze(labels), key: parts.join('|'), rejected };
}
function newSeries(definition, labels) {
  return { definition, labels, count: 0, value: 0, sum: 0, reducedCount: 0,
    buckets: definition.kind === 'histogram' ? new Array(LATENCY_BUCKETS_MS.length + 1).fill(0) : null };
}

/**
 * Required hard GLOBAL slot budget, including one reserved fallback per family.
 * Disabled/malformed config => null. No unbounded dictionary or raw sample list.
 * Unknown values bucket to `other`; exhausted slots aggregate into the reserved
 * unlabeled family series. No business IDs become labels or stored hashes.
 */
export function createMetricGovernor(config) {
  try {
    if (!fields(config, ['maxSeries']) || !Number.isSafeInteger(config.maxSeries) ||
        config.maxSeries < METRIC_DEFINITIONS.length || config.maxSeries > METRIC_LIMITS.maxSeries) return null;
    const maxSeries = config.maxSeries;
    const families = new Map(METRIC_DEFINITIONS.map(d => [d.name, new Map([['', newSeries(d, Object.freeze({}))]])]));
    let allocated = METRIC_DEFINITIONS.length;
    const counts = { accepted: 0, invalid: 0, cardinalityRejected: 0, aggregated: 0 };
    function invalid() { counts.invalid = increment(counts.invalid); return false; }
    function observe(name, value = 1, labels = {}) {
      try {
        if (typeof name !== 'string' || name.length > 64 || !byName.has(name) ||
            typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX) return invalid();
        const definition = byName.get(name);
        if (definition.unit === '1' && !Number.isSafeInteger(value)) return invalid();
        if (name === `node.health` && value !== 0 && value !== 1) return invalid();
        const normalized = normalizeLabels(labels);
        if (!normalized) return invalid();
        const series = families.get(name);
        let target = series.get(normalized.key);
        let aggregate = false, fresh = false;
        if (!target) {
          if (allocated === maxSeries) { target = series.get(''); aggregate = true; }
          else { target = newSeries(definition, normalized.labels); fresh = true; }
        }
        // Arithmetic overflow rejects atomically; even a newly allocated slot is
        // not published until the sample is known to fit the numeric contract.
        if (target.count === MAX ||
            (definition.kind === 'counter' && !Number.isSafeInteger(target.value + value)) ||
            (definition.kind === 'histogram' && target.sum + value > MAX)) return invalid();
        if (definition.kind === 'counter') target.value += value;
        else if (definition.kind === 'gauge') target.value = value;
        else {
          target.sum += value;
          const bucket = LATENCY_BUCKETS_MS.findIndex(bound => value <= bound);
          target.buckets[bucket < 0 ? LATENCY_BUCKETS_MS.length : bucket]++;
        }
        target.count++;
        if (normalized.rejected || aggregate) target.reducedCount++;
        if (fresh) { series.set(normalized.key, target); allocated++; }
        counts.accepted = increment(counts.accepted);
        counts.cardinalityRejected = Math.min(MAX, counts.cardinalityRejected + normalized.rejected);
        if (aggregate) counts.aggregated = increment(counts.aggregated);
        return true;
      } catch { return invalid(); }
    }
    function stats() { return Object.freeze({ ...counts, allocatedSeries: allocated, maxSeries, reservedSeries: METRIC_DEFINITIONS.length }); }
    function snapshot() {
      const result = [];
      // Fixed metric order + lexicographic normalized label order, independent
      // of input object key order. Never emit fabricated zero/unobserved gauges.
      for (const definition of METRIC_DEFINITIONS) {
        const series = families.get(definition.name);
        for (const key of [...series.keys()].sort()) {
          const s = series.get(key);
          if (!s.count) continue;
          const value = definition.kind === 'histogram'
            ? { count: s.count, sum: s.sum, bounds: LATENCY_BUCKETS_MS, buckets: Object.freeze([...s.buckets]) }
            : { count: s.count, value: s.value };
          result.push(Object.freeze({ ...definition, labels: s.labels, ...value, reducedCount: s.reducedCount }));
        }
      }
      return Object.freeze({ contractVersion: METRIC_CONTRACT.version, series: Object.freeze(result), stats: stats() });
    }
    // Caller-owned aggregation window reset, not an operator mutation endpoint.
    function reset() {
      for (const definition of METRIC_DEFINITIONS) families.set(definition.name, new Map([['', newSeries(definition, Object.freeze({}))]]));
      allocated = METRIC_DEFINITIONS.length;
      for (const key of Object.keys(counts)) counts[key] = 0;
    }
    return Object.freeze({ observe, snapshot, stats, reset });
  } catch { return null; }
}
