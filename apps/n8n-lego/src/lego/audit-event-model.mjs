/**
 * P5-M12 audit backing model (P5-M10-B): append-only security-audit event
 * generation and store over the P8 storage facade. The /api/v1/audit surface
 * stays gated upstream; it mounts on top of this model later.
 *
 * Immutability contract:
 *  - events are append-only: creation is create-if-absent CAS, an existing
 *    event id can never be overwritten (AUDIT_CONFLICT);
 *  - the model exposes no mutation or deletion API at all (rollback = drop the
 *    model mount; history keys are never touched);
 *  - the stored record carries `tag: 'audit-event-v1'` and is returned
 *    byte-identical for identical inputs (determinism).
 *
 * Query contract (backing /api/v1/audit):
 *  - filters: actor, action, target, targetType, occurredFrom, occurredTo;
 *  - ordering: (occurredAt, eventId) ascending - stable across hosts;
 *  - paging: stateless opaque cursor of the last returned item
 *    (`<occurredAt>:<eventId>`); a well-formed cursor resumes strictly after
 *    that item; malformed cursors are AUDIT_INVALID.
 *
 * Error set (closed): AUDIT_INVALID | AUDIT_CONFLICT. Storage errors propagate
 * unchanged (STORAGE_TIMEOUT | STORAGE_UNAVAILABLE | ...).
 */
import { STORAGE_ERROR_CODES } from './storage/contract.mjs';

export const AUDIT_ERROR_CODES = Object.freeze({
  INVALID: 'AUDIT_INVALID',
  CONFLICT: 'AUDIT_CONFLICT',
});

export class AuditModelError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AuditModelError';
    this.code = code;
    this.details = options.details ?? {};
    if (!Object.values(AUDIT_ERROR_CODES).includes(code)) {
      throw new TypeError(`AuditModelError: unknown code ${String(code)}`);
    }
  }
}

const invalid = (message, details) => new AuditModelError(AUDIT_ERROR_CODES.INVALID, message, { details });
const conflict = (message, details) => new AuditModelError(AUDIT_ERROR_CODES.CONFLICT, message, { details });

const RECORD_TAG = 'audit-event-v1';
const CURSOR_PATTERN = /^(\d+):(.+)$/;

const requireString = (value, field) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`${field} must be a non-empty string`);
  }
  return value;
};

const compare = (a, b) =>
  (a.occurredAt - b.occurredAt) || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);

const matchFilters = (event, filters) => {
  if (filters.actor !== undefined && event.actor !== filters.actor) return false;
  if (filters.action !== undefined && event.action !== filters.action) return false;
  if (filters.target !== undefined && event.target !== filters.target) return false;
  if (filters.targetType !== undefined && event.targetType !== filters.targetType) return false;
  if (filters.occurredFrom !== undefined && event.occurredAt < filters.occurredFrom) return false;
  if (filters.occurredTo !== undefined && event.occurredAt > filters.occurredTo) return false;
  return true;
};

const eventKey = (eventId) => `e:${eventId}`;

/**
 * @param {object} storage storage facade handle - the ONLY persistence boundary
 * @param {object} options
 * @param {{ now: () => number }} options.clock REQUIRED deterministic clock (ms)
 * @param {() => string} options.idFactory REQUIRED opaque event id factory
 * @param {string} [options.namespace='audit']
 */
export function createAuditEventModel(storage, { clock, idFactory, namespace = 'audit' } = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.putIfVersion !== 'function') {
    throw invalid('createAuditEventModel requires a storage facade handle');
  }
  if (!clock || typeof clock.now !== 'function') throw invalid('an injected clock is required');
  if (typeof idFactory !== 'function') throw invalid('an injected idFactory is required');
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw invalid('namespace must be a non-empty string');
  }

  const readJson = (key) => {
    const got = storage.get(namespace, key);
    if (!got.found) return null;
    let record;
    try {
      record = JSON.parse(got.value.toString('utf8'));
    } catch (error) {
      throw conflict('audit event record is unreadable', { cause: error });
    }
    if (record.tag !== RECORD_TAG) throw conflict('audit event record has an unsupported shape');
    return { record, version: got.version };
  };

  const buildEvent = ({ eventId, actor, action, target, targetType, occurredAt, attestation, metadata, source }) => {
    const cleanId = requireString(eventId, 'eventId');
    const cleanAt = occurredAt ?? clock.now();
    if (!Number.isInteger(cleanAt)) throw invalid('occurredAt must be an integer timestamp');
    if (attestation !== undefined && attestation !== null
      && (typeof attestation !== 'object' || Array.isArray(attestation))) {
      throw invalid('attestation must be an object or null');
    }
    const cleanAttestation = attestation === undefined || attestation === null
      ? null
      : {
          kind: requireString(attestation.kind, 'attestation.kind'),
          by: String(attestation.by ?? ''),
          at: Number.isInteger(attestation.at ?? null) ? attestation.at : cleanAt,
          digest: String(attestation.digest ?? ''),
        };
    return {
      tag: RECORD_TAG,
      eventId: cleanId,
      actor: requireString(actor, 'actor'),
      action: requireString(action, 'action'),
      target: requireString(target, 'target'),
      targetType: String(targetType ?? 'unknown'),
      occurredAt: cleanAt,
      attestation: cleanAttestation,
      metadata: metadata === undefined ? null : structuredClone(metadata),
      source: String(source ?? 'local'),
    };
  };

  return Object.freeze({
    capabilities: storage.capabilities,
    namespace,

    /**
     * Append-only create. Refuses to overwrite history (AUDIT_CONFLICT);
     * identical inputs produce byte-identical records (determinism).
     */
    append(event) {
      if (event === null || typeof event !== 'object' || Array.isArray(event)) {
        throw invalid('audit event must be an object');
      }
      const record = buildEvent(event);
      const key = eventKey(record.eventId);
      const bytes = Buffer.from(JSON.stringify(record), 'utf8');
      // P8-S01 has no atomic create-if-absent; append-only is enforced with a
      // pre-check + unconditional put + read-back verify (documented deviation).
      if (storage.get(namespace, key).found) {
        throw conflict('audit event already exists (append-only)');
      }
      storage.put(namespace, key, bytes);
      const verify = storage.get(namespace, key);
      if (!verify.found || !verify.value.equals(bytes)) {
        throw conflict('audit event create lost a concurrent write (append-only)');
      }
      return Object.freeze({ ...record, version: verify.version });
    },

    /** Convenience: mint an id via idFactory and append. */
    record(event = {}) {
      const eventId = typeof event.id === 'string' && event.id.length > 0 ? event.id : idFactory();
      return this.append({ ...event, id: undefined, eventId });
    },

    /** Read one event; missing ids read as null (nothing throws for absence). */
    get(eventId) {
      requireString(eventId, 'eventId');
      const found = readJson(eventKey(eventId));
      return found ? Object.freeze({ ...found.record, version: found.version }) : null;
    },

    /**
     * Query contract with stable (occurredAt, eventId) ordering and stateless
     * cursor paging.
     */
    query(filters = {}) {
      const { limit = 50, cursor = null, ...rest } = filters;
      if (!Number.isInteger(limit) || limit <= 0) throw invalid('limit must be a positive integer');
      let after = null;
      if (cursor !== null) {
        const raw = String(cursor);
        const parsed = CURSOR_PATTERN.exec(raw);
        if (!parsed) throw invalid('cursor must be an opaque token issued by a previous query');
        after = { occurredAt: Number(parsed[1]), eventId: parsed[2] };
      }
      const collected = [];
      let scan = undefined;
      for (;;) {
        const page = storage.list(namespace, { cursor: scan, limit: 1000 });
        for (const entry of page.keys) {
          if (!entry.key.startsWith('e:')) continue;
          const found = readJson(entry.key);
          if (found) collected.push(found.record);
        }
        if (!page.nextCursor) break;
        scan = page.nextCursor;
      }
      const matched = collected
        .filter((event) => matchFilters(event, rest))
        .sort(compare)
        .filter((event) => (after === null ? true : compare(event, after) > 0));
      const items = matched.slice(0, limit);
      const hasMore = matched.length > items.length;
      const last = items[items.length - 1];
      return Object.freeze({
        items: Object.freeze(items.map((event) => Object.freeze({ ...event }))),
        count: items.length,
        nextCursor: hasMore && last ? `${last.occurredAt}:${last.eventId}` : null,
      });
    },

    /** Aggregate view backing the /api/v1/audit summary (deterministic order). */
    summarize(filters = {}) {
      const { items } = this.query({ ...filters, limit: Number.MAX_SAFE_INTEGER });
      const byAction = new Map();
      const byActor = new Map();
      for (const event of items) {
        byAction.set(event.action, (byAction.get(event.action) ?? 0) + 1);
        byActor.set(event.actor, (byActor.get(event.actor) ?? 0) + 1);
      }
      return Object.freeze({
        total: items.length,
        byAction: Object.freeze(Object.fromEntries([...byAction].sort())),
        byActor: Object.freeze(Object.fromEntries([...byActor].sort())),
      });
    },
  });
}

export const AUDIT_MODEL_VERSION = 1;
export { STORAGE_ERROR_CODES as AUDIT_STORAGE_ERROR_CODES };
