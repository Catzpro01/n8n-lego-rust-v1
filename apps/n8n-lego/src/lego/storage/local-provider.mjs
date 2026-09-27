/**
 * P8-S06 — local reference provider for the P8 storage contract.
 *
 * Deterministic given the injected clock and persistence adapter: no hidden
 * global state, all side effects behind the injected persistence boundary.
 * This provider is the reference implementation the conformance harness runs
 * against, and the shape a Rust port replays byte for byte.
 *
 * Capability honesty (P8-S01-FOUNDATION.md item 10):
 * - multiHost is ALWAYS false. Local-only storage must not claim multi-host
 *   semantics (owner condition). A future shared provider declares multiHost
 *   true only after passing the same conformance harness under concurrency.
 * - durable is true only when a persistence adapter is supplied; acknowledged
 *   writes are visible after restart only then.
 *
 * Version tokens are opaque to callers ("o1", "o2", ... per key); the encoding
 * is provider detail and must never be parsed by a consumer.
 */

import {
  StorageError, absent, casApplied, casSkipped, deleteCasApplied, batchApplied, batchAborted,
  assertCapabilityProfile, invalid, unavailable,
} from './contract.mjs';

const DEFAULT_MAX_VALUE_BYTES = 1024 * 1024; // 1 MiB

/**
 * @param {object} options
 * @param {{ now: () => number }} options.clock REQUIRED deterministic clock (ms since epoch).
 * @param {{ load: () => Promise<Buffer|null>|Buffer|null, save: (bytes: Buffer) => Promise<void>|void }} [options.persistence]
 *        Optional write-through persistence adapter. `save` must be atomic at the
 *        adapter level (write temp + rename, or equivalent); the provider acks a
 *        write only after `save` resolves. A `save` throw becomes STORAGE_UNAVAILABLE
 *        and the in-memory state is rolled back for that operation.
 * @param {number} [options.maxValueBytes]
 */
export function createLocalStorage({ clock, persistence, maxValueBytes = DEFAULT_MAX_VALUE_BYTES } = {}) {
  if (!clock || typeof clock.now !== 'function') {
    throw invalid('createLocalStorage requires an injected clock ({ now }) for deterministic TTL behaviour');
  }
  if (persistence && (typeof persistence.load !== 'function' || typeof persistence.save !== 'function')) {
    throw invalid('persistence adapter must implement load() and save(bytes)');
  }

  const capabilities = assertCapabilityProfile({
    name: 'local-reference',
    multiHost: false,
    durable: Boolean(persistence),
    maxListLimit: 1000,
    maxValueBytes,
  });

  /** @type {Map<string, Map<string, { value: Buffer, version: number, expiresAt: number|null }>>} */
  let data = new Map();
  let loaded = false;

  const nsMap = (namespace) => {
    let map = data.get(namespace);
    if (!map) { map = new Map(); data.set(namespace, map); }
    return map;
  };

  const entryKey = (namespace, key) => `${namespace}\u0000${key}`;

  const isExpired = (entry, nowMs) => entry.expiresAt !== null && entry.expiresAt <= nowMs;

  const ensureLoaded = () => {
    if (loaded) return;
    loaded = true;
    if (!persistence) return;
    const raw = persistence.load();
    if (raw && typeof raw.then === 'function') {
      throw unavailable('local storage persistence.load must be synchronous at construction; hydrate() before use');
    }
    if (raw) hydrateFrom(raw);
  };

  const hydrateFrom = (raw) => {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    } catch (error) {
      throw unavailable(`persistence payload is unreadable: ${String(error?.message ?? error).slice(0, 80)}`);
    }
    if (!parsed || parsed.v !== 1 || typeof parsed.namespaces !== 'object') {
      throw unavailable('persistence payload has an unsupported shape (expected { v: 1, namespaces })');
    }
    const restored = new Map();
    for (const [namespace, entries] of Object.entries(parsed.namespaces)) {
      const map = new Map();
      for (const [key, entry] of Object.entries(entries)) {
        map.set(key, {
          value: Buffer.from(entry.value, 'base64'),
          version: entry.version,
          expiresAt: entry.expiresAt ?? null,
        });
      }
      restored.set(namespace, map);
    }
    data = restored;
  };

  /** Serialize durable state (write-through format; upgrade-compatible: { v: 1, namespaces }). */
  const persist = () => {
    if (!persistence) return;
    const namespaces = {};
    for (const [namespace, map] of data) {
      const entries = {};
      for (const [key, entry] of map) {
        entries[key] = {
          value: entry.value.toString('base64'),
          version: entry.version,
          expiresAt: entry.expiresAt,
        };
      }
      namespaces[namespace] = entries;
    }
    const payload = Buffer.from(JSON.stringify({ v: 1, namespaces }), 'utf8');
    try {
      const result = persistence.save(payload);
      if (result && typeof result.then === 'function') {
        throw unavailable('local storage persistence.save must be synchronous; wrap the adapter accordingly');
      }
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw unavailable(`persistence save failed: ${String(error?.message ?? error).slice(0, 80)}`, { cause: error });
    }
  };

  /**
   * Snapshot/rollback helper so a failed persist leaves in-memory state exactly
   * as it was (atomic visibility of applyBatch and single writes).
   */
  const cloneData = () => {
    const copy = new Map();
    for (const [namespace, map] of data) {
      const mapCopy = new Map();
      for (const [key, entry] of map) mapCopy.set(key, { ...entry });
      copy.set(namespace, mapCopy);
    }
    return copy;
  };

  const readEntry = (namespace, key) => {
    ensureLoaded();
    const map = data.get(namespace);
    const entry = map?.get(key);
    if (!entry) return null;
    if (isExpired(entry, clock.now())) {
      // Expiry is observed by callers, never silently kept readable past TTL.
      map.delete(key);
      return null;
    }
    return entry;
  };

  const writeEntry = (namespace, key, value, ttlSeconds, expectedVersion) => {
    const now = clock.now();
    const map = nsMap(namespace);
    const existing = map.get(key);
    const live = existing && !isExpired(existing, now) ? existing : null;
    if (expectedVersion !== undefined) {
      if (!live) return { ok: false, reason: 'absent' };
      if (live.version !== expectedVersion) return { ok: false, reason: 'version_conflict' };
    }
    const version = `o${(live?.version ? Number(live.version.slice(1)) : 0) + 1}`;
    const entry = {
      value,
      version,
      expiresAt: ttlSeconds === undefined ? null : now + ttlSeconds * 1000,
    };
    map.set(key, entry);
    return { ok: true, entry };
  };

  const deleteEntry = (namespace, key, expectedVersion) => {
    const now = clock.now();
    const map = nsMap(namespace);
    const existing = map.get(key);
    const live = existing && !isExpired(existing, now) ? existing : null;
    if (expectedVersion !== undefined) {
      if (!live) return { ok: false, reason: 'absent' };
      if (live.version !== expectedVersion) return { ok: false, reason: 'version_conflict' };
    }
    const deleted = Boolean(live);
    map.delete(key);
    return { ok: true, deleted };
  };

  const withPersist = (fn) => {
    ensureLoaded();
    const before = cloneData();
    let result;
    try {
      result = fn();
    } catch (error) {
      data = before;
      throw error;
    }
    try {
      persist();
    } catch (error) {
      data = before;
      throw error;
    }
    return result;
  };

  return Object.freeze({
    capabilities,

    get(namespace, key) {
      ensureLoaded();
      const entry = readEntry(namespace, key);
      if (!entry) return absent();
      return Object.freeze({
        found: true,
        value: entry.value,
        version: entry.version,
        expiresAt: entry.expiresAt,
      });
    },

    put(namespace, key, value, { ttlSeconds } = {}) {
      return withPersist(() => {
        const result = writeEntry(namespace, key, value, ttlSeconds);
        return Object.freeze({ version: result.entry.version });
      });
    },

    delete(namespace, key) {
      return withPersist(() => {
        const result = deleteEntry(namespace, key);
        return Object.freeze({ deleted: result.deleted });
      });
    },

    list(namespace, { cursor, limit }) {
      ensureLoaded();
      const map = data.get(namespace) ?? new Map();
      const now = clock.now();
      const keys = [];
      for (const [key, entry] of map) {
        if (isExpired(entry, now)) continue; // expired keys are excluded from list
        keys.push({ key, version: entry.version, expiresAt: entry.expiresAt });
      }
      keys.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)); // deterministic order
      let start = 0;
      if (cursor !== undefined) {
        // Opaque cursor: position token; a cursor from another namespace is INVALID.
        let position;
        try {
          const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
          if (decoded.ns !== namespace || !Number.isInteger(decoded.i)) throw new Error('shape');
          position = decoded.i;
        } catch {
          throw invalid('list cursor is not a token this namespace issued');
        }
        start = position;
      }
      const page = keys.slice(start, start + limit);
      const nextIndex = start + page.length;
      const result = { keys: page };
      if (nextIndex < keys.length) {
        result.nextCursor = Buffer.from(JSON.stringify({ ns: namespace, i: nextIndex }), 'utf8').toString('base64url');
      }
      return Object.freeze(result);
    },

    putIfVersion(namespace, key, value, expectedVersion, { ttlSeconds } = {}) {
      return withPersist(() => {
        const result = writeEntry(namespace, key, value, ttlSeconds, expectedVersion);
        return result.ok ? casApplied(result.entry.version) : casSkipped(result.reason);
      });
    },

    deleteIfVersion(namespace, key, expectedVersion) {
      return withPersist(() => {
        const result = deleteEntry(namespace, key, expectedVersion);
        return result.ok ? deleteCasApplied(result.deleted) : casSkipped(result.reason);
      });
    },

    applyBatch(ops) {
      // All-or-nothing: apply sequentially against the live map, and on the first
      // semantic conflict restore the snapshot taken before the batch (nothing
      // landed) and return the first-class abort result with the failed op index.
      return withPersist(() => {
        const before = cloneData();
        for (let index = 0; index < ops.length; index += 1) {
          const op = ops[index];
          const probe = op.type === 'put'
            ? writeEntry(op.namespace, op.key, op.value, op.ttlSeconds, op.expectedVersion)
            : deleteEntry(op.namespace, op.key, op.expectedVersion);
          if (!probe.ok) {
            data = before;
            return batchAborted(index, probe.reason);
          }
        }
        return batchApplied(ops.length);
      });
    },

    touch(namespace, key, ttlSeconds) {
      return withPersist(() => {
        const entry = readEntry(namespace, key);
        if (!entry) return absent();
        entry.expiresAt = clock.now() + ttlSeconds * 1000;
        return Object.freeze({
          found: true,
          version: entry.version,
          expiresAt: entry.expiresAt,
        });
      });
    },
  });
}
