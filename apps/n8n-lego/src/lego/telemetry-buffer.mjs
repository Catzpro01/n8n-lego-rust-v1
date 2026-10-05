/** P9.6 bounded telemetry buffer + backpressure. Product owner agent-6;
 * implementation delegate Agent 4 (Issue #101). Hard capacity, deterministic
 * overflow, P0–P4 priority classes, low-priority shed before critical
 * evidence, exposed drop counters. No spill-to-disk in 1.0.0 (quota-defined
 * spill is a future additive capability). No I/O, no clock, no callback, no
 * workflow import — offer() never throws, so telemetry saturation cannot fail
 * a business path. Payloads are opaque caller references (already bounded by
 * their producer contract); this module never clones or stringifies them.
 */
export const TELEMETRY_BUFFER_CONTRACT = Object.freeze({
  id: 'observability.telemetry-buffer', version: '1.0.0', owner: 'agent-6',
});
/** Priority classes from #101 deep design §12: lower number = more critical. */
export const TELEMETRY_PRIORITY_CLASSES = Object.freeze(['P0', 'P1', 'P2', 'P3', 'P4']);
export const TELEMETRY_PRIORITY_DESCRIPTIONS = Object.freeze({
  P0: 'security/audit/safety evidence',
  P1: 'failure/error diagnostics',
  P2: 'execution lifecycle',
  P3: 'performance telemetry',
  P4: 'debug/verbose telemetry',
});
export const BUFFER_LIMITS = Object.freeze({ capacityMin: 1, capacityMax: 65536, takeMax: 65536 });
export const BUFFER_OUTCOMES = Object.freeze(['buffered', 'shed', 'rejected']);
/** Deterministic overflow policies. shed_lowest: a more critical incoming
 * record may evict exactly one lowest-priority resident (evicting only a
 * strictly lower priority — equal priority never evicts equal); when nothing
 * strictly lower remains, the incoming record sheds. reject_incoming: a full
 * buffer always sheds the incoming record (pure FIFO protection). */
export const BUFFER_OVERFLOW_POLICIES = Object.freeze(['shed_lowest', 'reject_incoming']);
const rank = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 });

/**
 * Create a bounded in-memory telemetry buffer. config.capacity is REQUIRED
 * (no forgettable default). Returns null on invalid config — never a buffer
 * that could grow past its wall. Ring slots are preallocated up front so the
 * memory ceiling is policy, not hope.
 */
export function createTelemetryBuffer(config) {
  try {
    if (!config || typeof config !== 'object') return null;
    const keys = Reflect.ownKeys(config);
    if (keys.some(key => !['capacity', 'overflowPolicy'].includes(key))) return null;
    const { capacity, overflowPolicy } = config;
    if (!Number.isSafeInteger(capacity) || capacity < BUFFER_LIMITS.capacityMin ||
        capacity > BUFFER_LIMITS.capacityMax) return null;
    const policy = overflowPolicy === undefined ? 'shed_lowest' : overflowPolicy;
    if (!BUFFER_OVERFLOW_POLICIES.includes(policy)) return null;

    // Preallocated ring of empty slots; size can never exceed capacity.
    const ring = new Array(capacity).fill(null);
    let head = 0; // next write index
    let size = 0;
    const counts = {
      buffered: 0, shed: 0, rejected: 0, evicted: 0,
      shedP0: 0, shedP1: 0, shedP2: 0, shedP3: 0, shedP4: 0,
      evictedP0: 0, evictedP1: 0, evictedP2: 0, evictedP3: 0, evictedP4: 0,
      peakSize: 0,
    };
    function bumpShed(priority) {
      counts.shed++;
      counts[`shed${priority}`]++;
    }
    function lowestResidentIndex() {
      // Deterministic: scan ring order (FIFO positions), track first slot with
      // the numerically highest priority class (lowest criticality). Ties →
      // earliest FIFO position, so eviction order is stable across runs.
      let best = -1, bestRank = -1;
      for (let i = 0; i < size; i++) {
        const idx = (head - size + i + capacity * 2) % capacity;
        const entry = ring[idx];
        if (entry && rank[entry.priority] > bestRank) {
          bestRank = rank[entry.priority];
          best = idx;
        }
      }
      return best;
    }
    function removeAt(idx) {
      // Compaction-free removal: rebuild by filtering is O(n) but n ≤ capacity
      // and only happens on shed (slow relative to offer hot path under load
      // only when shedding — still bounded, no allocation growth).
      const next = new Array(capacity).fill(null);
      let j = 0;
      for (let i = 0; i < size; i++) {
        const cur = (head - size + i + capacity * 2) % capacity;
        if (cur === idx) continue;
        next[j++] = ring[cur];
      }
      for (let i = 0; i < capacity; i++) ring[i] = next[i];
      size = j;
      head = j % capacity;
    }
    /**
     * Admit one record {priority, payload}. Returns a frozen outcome string.
     * Never throws: business callers are unaffected by saturation. Invalid
     * input answers 'rejected' (and counts as rejected, not silently lost —
     * rejected means the buffer refused admission of malformed telemetry).
     */
    function offer(record) {
      try {
        if (!record || typeof record !== 'object') return (counts.rejected++, 'rejected');
        const rkeys = Reflect.ownKeys(record);
        if (rkeys.length !== 2 || !rkeys.includes('priority') || !rkeys.includes('payload')) {
          return (counts.rejected++, 'rejected');
        }
        const descP = Object.getOwnPropertyDescriptor(record, 'priority');
        const descY = Object.getOwnPropertyDescriptor(record, 'payload');
        if (!descP || !('value' in descP) || !descP.enumerable ||
            !descY || !('value' in descY) || !descY.enumerable) {
          return (counts.rejected++, 'rejected');
        }
        const priority = descP.value;
        if (!TELEMETRY_PRIORITY_CLASSES.includes(priority)) return (counts.rejected++, 'rejected');
        // Payload must already be an object or primitive value the caller owns;
        // undefined/function/symbol are refused so slots never hold unusable data.
        const payload = descY.value;
        if (payload === undefined || typeof payload === 'function' || typeof payload === 'symbol') {
          return (counts.rejected++, 'rejected');
        }
        if (size < capacity) {
          ring[head] = { priority, payload };
          head = (head + 1) % capacity;
          size++;
          counts.buffered++;
          if (size > counts.peakSize) counts.peakSize = size;
          return 'buffered';
        }
        // Full.
        if (policy === 'reject_incoming') {
          bumpShed(priority);
          return 'shed';
        }
        // shed_lowest: evict only a STRICTLY lower-priority resident.
        const victim = lowestResidentIndex();
        if (victim < 0 || rank[ring[victim].priority] <= rank[priority]) {
          bumpShed(priority);
          return 'shed';
        }
        const victimPriority = ring[victim].priority;
        removeAt(victim);
        // Eviction is a resident drop, not an incoming shed: the victim was
        // already counted in `buffered` when it first entered. Counting it as
        // shed too would double-count offers (buffered + shed + rejected must
        // equal total offers exactly).
        counts.evicted++;
        counts[`evicted${victimPriority}`]++;
        ring[head] = { priority, payload };
        head = (head + 1) % capacity;
        size++;
        counts.buffered++;
        return 'buffered';
      } catch {
        return (counts.rejected++, 'rejected');
      }
    }
    /** Bounded FIFO drain: never returns more than min(requested, size). */
    function take(max = size) {
      try {
        if (!Number.isSafeInteger(max) || max < 0 || max > BUFFER_LIMITS.takeMax) return null;
        const n = Math.min(max, size);
        const out = [];
        const start = (head - size + capacity * 2) % capacity;
        for (let i = 0; i < n; i++) {
          const idx = (start + i) % capacity;
          out.push(ring[idx]);
          ring[idx] = null;
        }
        // Shift remaining down to keep FIFO simple after partial take.
        if (n > 0 && n < size) {
          const next = new Array(capacity).fill(null);
          for (let i = n; i < size; i++) {
            next[i - n] = ring[(start + i) % capacity];
          }
          for (let i = 0; i < capacity; i++) ring[i] = next[i];
          size -= n;
          head = size % capacity;
        } else if (n > 0) {
          size = 0;
          head = 0;
        }
        return Object.freeze(out);
      } catch { return null; }
    }
    /** Occupancy snapshot + drop observability (issue #101 §23 vocabulary). */
    function stats() {
      return Object.freeze({
        ...counts,
        size,
        capacity,
        occupancy: size / capacity,
        overflowPolicy: policy,
        // Telemetry-drop observability: shed/rejected are never silent;
        // evicted counts residents removed to admit a more critical record.
        droppedTotal: counts.shed + counts.rejected,
        // Full accounting: every offer is exactly one of buffered|shed|rejected.
        offerTotal: counts.buffered + counts.shed + counts.rejected,
      });
    }
    return Object.freeze({ offer, take, stats, capacity, overflowPolicy: policy });
  } catch { return null; }
}
