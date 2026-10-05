/**
 * Reference LEGO — PUBLIC CONTRACT (`reference.lego`, v1.0.0, owner: manager).
 *
 * TEMPLATE, NOT A FEATURE. Nothing here is mounted on a route. Copy the shape,
 * not the behaviour. See ../README.md.
 *
 * What a public contract file is allowed to contain:
 *   - capability identity and contract version,
 *   - request/response models (plain data shapes),
 *   - the port factory consumers call,
 *   - error identity raised as codes from the LEGO error contract.
 *
 * What it must never contain:
 *   - persistence details, internal algorithms, internal data structures
 *     (those live in ../internal/, which no other domain may import),
 *   - HTTP: no `req`/`res`, no status codes. Transport is the compatibility
 *     layer's job, so this contract stays reusable by a CLI, a worker or a test.
 *
 * Allowed imports here: the shared kernel and the LEGO foundation only.
 */
import { assertErrorCode } from '../../lego/errors.mjs';
import { createReferenceStore } from '../internal/store.mjs';
// Composition inside one LEGO: the parent uses its own sub-LEGOs through their
// PUBLIC contracts. Reaching into `sub/*/internal/` would fail the gate even
// for the parent — being the parent grants composition, not x-ray vision.
import { createValidationLego, VALIDATION_CONTRACT_VERSION } from '../sub/validation/contract/index.mjs';
import { createRepositoryLego, REPOSITORY_CONTRACT_VERSION } from '../sub/repository/contract/index.mjs';

/** Capability identity — must match the id registered in src/lego/manifest/domains.json. */
export const REFERENCE_CAPABILITY = 'reference.echo';

/**
 * Contract version — must match the row in src/lego/contracts/contract-lock.json.
 *
 * Still 1.0.0 after `reference.validation` went 1.0.0 -> 1.1.0. That is the
 * P2.7 parent/sub-LEGO lifecycle rule: a parent does NOT bump because a child
 * changed compatibly, only if its own parent-facing surface moves. Asserted by
 * "a compatible sub-LEGO upgrade does not move the parent contract".
 */
export const REFERENCE_CONTRACT_VERSION = '1.0.0';

/**
 * The sub-LEGO versions this parent composes. Observable so a test — and a
 * future upgrade tool — can see which children are wired in without reaching
 * into any of them.
 */
export const REFERENCE_SUBLEGOS = Object.freeze({
  'reference.validation': VALIDATION_CONTRACT_VERSION,
  'reference.repository': REPOSITORY_CONTRACT_VERSION,
});

/**
 * Error identity this contract can raise. Codes come from the shared error
 * contract; a domain never invents a code at the call site.
 * `reference.*` has no registered codes (the template raises none in anger), so
 * it borrows `storage.not_found` to show the assertion in use.
 */
export const REFERENCE_ERRORS = Object.freeze({
  notFound: assertErrorCode('storage.not_found'),
});

/**
 * Request model. Plain data: no class, no framework object, nothing that ties a
 * consumer to this implementation.
 * @typedef {{ key: string, value: unknown }} ReferencePutRequest
 * @typedef {{ key: string, value: unknown, revision: number }} ReferenceRecord
 */

/**
 * Domain-level error. Carries a contract error code, not an HTTP status — the
 * compatibility layer is what turns a code into a response.
 */
export class ReferenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReferenceError';
    this.code = assertErrorCode(code);
  }
}

/**
 * The port. Consumers receive behaviour, never the internal structure, so the
 * implementation behind it is replaceable without touching a single consumer.
 *
 * @param {{ logger?: { debug: Function } }} [deps] injected — a LEGO never
 *        reaches out for its own collaborators, the composition root supplies them.
 * @returns {{
 *   capability: string,
 *   version: string,
 *   put(request: ReferencePutRequest): ReferenceRecord,
 *   get(key: string): ReferenceRecord,
 *   has(key: string): boolean,
 * }}
 */
export function createReferenceLego({ logger } = {}) {
  const store = createReferenceStore();

  return Object.freeze({
    capability: REFERENCE_CAPABILITY,
    version: REFERENCE_CONTRACT_VERSION,

    put({ key, value }) {
      if (typeof key !== 'string' || key === '') {
        throw new ReferenceError('storage.not_found', 'key must be a non-empty string');
      }
      const record = store.write(key, value);
      logger?.debug?.('[reference-lego] wrote record', { key, revision: record.revision });
      return record;
    },

    get(key) {
      const record = store.read(key);
      if (!record) throw new ReferenceError(REFERENCE_ERRORS.notFound, `no reference record for '${key}'`);
      return record;
    },

    has(key) {
      return store.read(key) !== undefined;
    },
  });
}

/**
 * Composes the whole nested LEGO: parent + its sub-LEGOs, each behind its own
 * public contract.
 *
 * Every collaborator is injectable. That is what makes the hierarchy testable
 * (swap a child for a double), upgradeable (swap a child for a new version) and
 * scale-out ready (nothing is process-global or filesystem-bound).
 *
 * @param {{ validation?: object, repository?: object, logger?: object }} [deps]
 */
export function createReferenceTree({ validation, repository, logger } = {}) {
  const parent = createReferenceLego({ logger });
  const validator = validation ?? createValidationLego({ logger });
  const store = repository ?? createRepositoryLego();

  return Object.freeze({
    capability: REFERENCE_CAPABILITY,
    version: REFERENCE_CONTRACT_VERSION,
    /** Which child contract versions are actually wired in, for diagnostics. */
    composition: Object.freeze({
      'reference.validation': validator.version,
      'reference.repository': store.version,
    }),

    /**
     * The parent-facing operation. Its signature and behaviour are what
     * `reference.lego@1.0.0` promises — unchanged by the validation upgrade.
     */
    store(record) {
      const result = validator.validate(record);
      if (!result.valid) {
        return { stored: false, issues: result.issues };
      }
      store.save(record);
      parent.put({ key: record.id, value: record });
      return { stored: true, issues: [] };
    },

    read(id) {
      return store.load(id);
    },
  });
}
