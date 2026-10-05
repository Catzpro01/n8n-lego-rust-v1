/**
 * Audit foundation — bounded, structured, reasoning-free records (P2.19).
 *
 * PUBLIC CONTRACT: ai.audit@1.0.0 (owner: manager).
 *
 * An audit record says WHAT happened, WHO/WHICH side asked, WHICH operation ran
 * and WHICH outcome occurred — nothing more. Records are structured (a fixed
 * field set), deterministic under an injectable clock and id factory, and the
 * store itself is bounded: a declared capacity with drop-oldest retention, so
 * the foundation can never become an unlimited event store. No production
 * audit database exists here.
 *
 * WHAT THIS IS NOT: a reasoning log. Hidden chain-of-thought, private
 * reasoning, raw prompts/completions, secret-bearing context and credentials
 * are refused at the door (fail-closed), never stored "for debugging".
 *
 * Event types quote the canonical vocabulary in manifest/ai-foundation.json
 * (events.types) plus `artifact.referenced`, the one P2.19 acceptance type
 * ("audit records: artifact referenced") the canonical list does not yet
 * spell — it follows the same dotted pattern and edits nothing.
 *
 * Owner of the contract: manager. Implementation: agent-1 (P2.19).
 */
import { randomUUID } from 'node:crypto';

import { AI_FOUNDATION, AGENT_EVENT_TYPES } from './ai-foundation.mjs';

/* ---------------------------------------------------------------- contract */

export const AUDIT_CONTRACT = Object.freeze({
  id: "ai.audit",
  version: '1.0.0',
  owner: 'manager',
  fields: Object.freeze([
    'auditId', 'eventType', 'timestamp', 'actor', 'subject',
    'operation', 'result', 'correlationId', 'causationId',
    'references', 'metadata',
  ]),
});

export const AUDIT_CONTRACT_VERSION = AUDIT_CONTRACT.version;
export const AUDIT_FIELDS = AUDIT_CONTRACT.fields;

/**
 * The audit event vocabulary. Four members are quoted verbatim from the
 * canonical events.types list; `artifact.referenced` is the P2.19 addition
 * required by the cross-domain acceptance and matches the canonical pattern.
 */
export const AUDIT_EVENT_TYPES = Object.freeze([
  'approval.requested',
  'approval.granted',
  'approval.denied',
  'artifact.created',
  'artifact.referenced',
]);

export const AUDIT_EVENT_TYPES_CANONICAL = Object.freeze(
  AUDIT_EVENT_TYPES.filter((type) => AGENT_EVENT_TYPES.includes(type)),
);

/** The canonical events list quoted from ai-foundation.json (drift check aid). */
export const AUDIT_CANONICAL_EVENT_TYPES = Object.freeze([...AI_FOUNDATION.events.types]);

export const AUDIT_OPERATIONS = Object.freeze(['record', 'list']);

export const AUDIT_LIMITS = Object.freeze({
  maxEntries: 512,
  maxCapacity: 512,
  maxIdentifierLength: 128,
  maxFieldLength: 128,
  maxResultLength: 64,
  maxReferences: 8,
  maxMetadataBytes: 4 * 1024,
  maxMetadataKeys: 16,
  maxMetadataDepth: 4,
  maxMetadataKeyLength: 64,
});

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REFERENCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SENSITIVE_KEY = /(?:credential|secret|password|passwd|token|cookie|authorization|api[-_]?key|private[-_]?key|hidden[-_]?prompt|raw[-_]?prompt|chain[-_]?of[-_]?thought|reasoning|model[-_]?thought|transcript|completion|messages?|host[-_]?path|filesystem|terminal|capability[-_]?grant|permission[-_]?grant)/i;
const REASONING_KEY = /(?:reasoning|chain[-_]?of[-_]?thought|thoughts?|prompt|completion|transcript)/i;
const SENSITIVE_TEXT = /(?:BEGIN\s+(?:RSA|OPENSSH|PRIVATE)\s+KEY|(?:^|\W)sk-[a-z0-9]{8,}|(?:^|\W)ghp_[a-z0-9]{8,}|(?:^|\W)github_pat_[a-z0-9_]{8,}|Bearer\s+[a-z0-9._-]+)/i;

/* ------------------------------------------------------------------ errors */

export class AuditError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, details = {}) {
  throw new AuditError('lego.contract_violation', message, details);
}

/* -------------------------------------------------------------- primitives */

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function assertText(value, field, maxLength, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    fail(`${field} must be a non-empty string of at most ${maxLength} characters`);
  }
  if (SENSITIVE_TEXT.test(value)) {
    fail(`${field} carries secret-shaped material — audit records never hold credentials`, { field });
  }
  return value;
}

function assertReference(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > AUDIT_LIMITS.maxIdentifierLength || !REFERENCE_ID_RE.test(value)) {
    fail(`${field} must be an opaque reference of 1..${AUDIT_LIMITS.maxIdentifierLength} characters`);
  }
  if (SENSITIVE_TEXT.test(value)) fail(`${field} carries secret-shaped material`, { field });
  return value;
}

function assertMetadata(value) {
  if (value === undefined || value === null) return Object.freeze({});
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('metadata must be a plain object');
  const keys = Object.keys(value);
  if (keys.length > AUDIT_LIMITS.maxMetadataKeys) {
    fail(`metadata exceeds ${AUDIT_LIMITS.maxMetadataKeys} keys`, { limit: 'maxMetadataKeys' });
  }
  for (const key of keys) {
    if (key.length === 0 || key.length > AUDIT_LIMITS.maxMetadataKeyLength) {
      fail(`metadata key must be 1..${AUDIT_LIMITS.maxMetadataKeyLength} characters`);
    }
    if (SENSITIVE_KEY.test(key) || REASONING_KEY.test(key)) {
      fail(`metadata key '${key}' is forbidden: audit metadata cannot carry secrets, authority or reasoning`, { key });
    }
  }
  const size = Buffer.byteLength(stableJson(value), 'utf8');
  if (size > AUDIT_LIMITS.maxMetadataBytes) {
    fail(`metadata is ${size} bytes, beyond the ${AUDIT_LIMITS.maxMetadataBytes}-byte bound`, { size, limit: 'maxMetadataBytes' });
  }
  validateDepth(value, 'metadata', 0);
  return freezeDeep(clone(value));
}

function validateDepth(value, path, depth) {
  if (depth > AUDIT_LIMITS.maxMetadataDepth) {
    fail(`${path} exceeds metadata nesting depth ${AUDIT_LIMITS.maxMetadataDepth}`, { limit: 'maxMetadataDepth' });
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) validateDepth(entry, path, depth + 1);
  } else {
    for (const entry of Object.values(value)) validateDepth(entry, path, depth + 1);
  }
}

function assertReferences(value) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) fail('references must be an array of opaque references');
  if (value.length > AUDIT_LIMITS.maxReferences) {
    fail(`references exceed ${AUDIT_LIMITS.maxReferences} entries`, { limit: 'maxReferences' });
  }
  return Object.freeze(value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > AUDIT_LIMITS.maxIdentifierLength || !REFERENCE_ID_RE.test(entry)) {
      fail(`references[${index}] must be an opaque reference of 1..${AUDIT_LIMITS.maxIdentifierLength} characters`);
    }
    if (SENSITIVE_TEXT.test(entry)) fail(`references[${index}] carries secret-shaped material`);
    return entry;
  }));
}

/* ------------------------------------------------------------------- log */

function makeAuditLog(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  // Canonical identity mechanism, injectable for deterministic tests.
  const newId = options.newId ?? (() => randomUUID());
  const limits = Object.freeze({ ...AUDIT_LIMITS, ...(options.limits ?? {}) });
  if (typeof now !== 'function') fail('now must be a function returning an ISO timestamp');
  if (typeof newId !== 'function') fail('newId must be a function returning an identifier');

  const requestedCapacity = options.capacity ?? limits.maxEntries;
  if (!Number.isInteger(requestedCapacity) || requestedCapacity < 1 || requestedCapacity > limits.maxCapacity) {
    fail(`capacity must be an integer in [1, ${limits.maxCapacity}]`, { limit: 'maxCapacity' });
  }
  const capacity = requestedCapacity;

  /** Bounded ring: record past capacity drops the oldest entry deterministically. */
  const entries = [];
  let dropped = 0;
  const byId = new Map();

  function clock() {
    const value = now();
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('now() must return an ISO timestamp');
    return new Date(value).toISOString();
  }

  const log = {
    /**
     * Record one bounded event. Fail-closed on unknown types, missing
     * semantics, oversized fields, secret-shaped values and reasoning keys.
     */
    record(event) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) fail('record input must be a plain object');
      const {
        auditId: providedId = null,
        eventType,
        actor,
        subject,
        operation,
        result,
        correlationId = null,
        causationId = null,
        references = [],
        metadata = {},
      } = event;

      if (typeof eventType !== 'string' || !AUDIT_EVENT_TYPES.includes(eventType)) {
        fail(`eventType must be one of ${AUDIT_EVENT_TYPES.join(', ')}`, { eventType: eventType ?? null });
      }
      const auditId = providedId === null || providedId === undefined ? newId() : providedId;
      if (typeof auditId !== 'string' || !ID_RE.test(auditId)) {
        fail(`auditId must match ${ID_RE} (1..${AUDIT_LIMITS.maxIdentifierLength} characters)`, { auditId: String(auditId).slice(0, 64) });
      }
      const existing = byId.get(auditId);
      const entry = Object.freeze({
        auditId,
        eventType,
        timestamp: clock(),
        actor: assertText(actor, 'actor', AUDIT_LIMITS.maxFieldLength),
        subject: assertText(subject, 'subject', AUDIT_LIMITS.maxFieldLength),
        operation: assertText(operation, 'operation', AUDIT_LIMITS.maxFieldLength),
        result: assertText(result, 'result', AUDIT_LIMITS.maxResultLength),
        correlationId: assertReference(correlationId, 'correlationId'),
        causationId: assertReference(causationId, 'causationId'),
        references: assertReferences(references),
        metadata: assertMetadata(metadata),
      });
      if (existing) {
        const same = stableJson(existing) === stableJson({ ...entry, timestamp: existing.timestamp });
        if (same) return freezeDeep(clone(existing));
        fail(`auditId '${auditId}' already exists with different content — duplicate ids are refused`, { auditId });
      }
      if (entries.length >= capacity) {
        const evicted = entries.shift();
        if (evicted) byId.delete(evicted.auditId);
        dropped += 1;
      }
      entries.push(entry);
      byId.set(auditId, entry);
      return freezeDeep(clone(entry));
    },

    /** Bounded read. Never returns more than the declared capacity. */
    list({ limit = capacity, eventType = null } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > capacity) {
        fail(`limit must be an integer in [1, ${capacity}]`, { capacity });
      }
      if (eventType !== null && eventType !== undefined && !AUDIT_EVENT_TYPES.includes(eventType)) {
        fail(`eventType must be one of ${AUDIT_EVENT_TYPES.join(', ')}`, { eventType });
      }
      const filtered = eventType ? entries.filter((entry) => entry.eventType === eventType) : entries;
      return Object.freeze(filtered.slice(-limit).map((entry) => freezeDeep(clone(entry))));
    },

    get stats() {
      return Object.freeze({ size: entries.length, capacity, dropped });
    },
    clear() {
      entries.length = 0;
      byId.clear();
      dropped = 0;
    },
  };
  return log;
}

/**
 * Create an audit foundation instance.
 * @param {{ now?: () => string, newId?: () => string, capacity?: number, limits?: object }} [options]
 */
export function createAuditLog(options = {}) {
  return makeAuditLog(options);
}
