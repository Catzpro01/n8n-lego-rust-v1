/**
 * Reference sub-LEGO — PUBLIC CONTRACT (`reference.repository`, v1.0.0).
 *
 * TEMPLATE, NOT A FEATURE. Parent: `reference-lego`. Owner: manager.
 *
 * This is the "A/C" in the P2.7 upgrade proof: the sibling that must remain
 * **completely untouched** while `reference.validation` goes 1.0.0 -> 1.1.0.
 * Its version stays 1.0.0 across that upgrade, and a test asserts it, because
 * a sub-LEGO upgrade that forces its siblings to move is not isolation.
 *
 * It also demonstrates the scale-out rule: no module-level mutable state, no
 * filesystem, no singleton. State is created per instance and injectable, so
 * the same contract works unchanged in one process or across many workers.
 */
import { assertErrorCode } from '../../../../lego/errors.mjs';

export const REPOSITORY_CAPABILITY = 'reference.repository';
export const REPOSITORY_CONTRACT_VERSION = '1.0.0';
export const REPOSITORY_OPERATIONS = Object.freeze(['save', 'load', 'list']);

/**
 * @param {{ backend?: Map<string, object> }} [deps] the backing store is
 *        injected, never reached for. Swap the Map for SQL or a remote service
 *        and no consumer changes — and nothing is process-global.
 */
export function createRepositoryLego({ backend = new Map() } = {}) {
  return Object.freeze({
    capability: REPOSITORY_CAPABILITY,
    version: REPOSITORY_CONTRACT_VERSION,

    save(record) {
      if (!record?.id) throw new Error(assertErrorCode('storage.not_found') && 'record.id is required');
      backend.set(record.id, { ...record });
      return { ...record };
    },

    load(id) {
      const found = backend.get(id);
      return found ? { ...found } : undefined;
    },

    list() {
      return [...backend.values()].map((record) => ({ ...record }));
    },
  });
}
