/**
 * Reference LEGO — PRIVATE IMPLEMENTATION.
 *
 * INTERNAL: nothing outside `src/reference-lego/` may import this file. The
 * architecture gate (`tools/lego/architecture-gate.mjs`) fails the build on any
 * cross-domain import of an `internal/` path, which is exactly the property
 * that makes the domain replaceable: swap this Map for SQLite, a file, or a
 * remote service and no consumer changes, because no consumer can see it.
 *
 * Internal data structures, helpers and algorithms belong here.
 */

export function createReferenceStore() {
  /** @type {Map<string, { key: string, value: unknown, revision: number }>} */
  const records = new Map();

  return {
    write(key, value) {
      const previous = records.get(key);
      const record = { key, value, revision: (previous?.revision ?? 0) + 1 };
      records.set(key, record);
      return { ...record };
    },
    read(key) {
      const record = records.get(key);
      return record ? { ...record } : undefined;
    },
    size() {
      return records.size;
    },
  };
}
