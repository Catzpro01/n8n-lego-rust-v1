/**
 * P2.27.10 — frontend plugin boundary.
 *
 * Issue #83: "Trusted frontend extensions use public extension points.
 * Untrusted/high-risk extensions use isolated/sandboxed message
 * boundaries."
 *
 * This module is the security decision and the message oracle — not a second
 * extension-point catalog. What may hang on a hook stays owned by the
 * frontend conformance suite (`manifest/extension-points.json`); here:
 *
 * - Attachment routes are DERIVED from trust, never requested. A register
 *   request cannot name its own route (no authority by asking), unknown
 *   fields fail closed, and the shape is deny-by-default.
 * - CORE/TRUSTED attach through PUBLIC_EXTENSION_POINT with a direct
 *   in-process handler; ISOLATED/SANDBOXED — and any extension flagged
 *   high-risk — attach through MESSAGE_BOUNDARY with a channel only. A
 *   direct handle across a message boundary is a contract violation.
 * - Boundary delivery sends a deep-frozen serialized copy (stableStringify
 *   round-trip): no shared mutable references cross the line, no functions,
 *   no cycles — the same fail-closed oracle the replay contract uses.
 * - Public delivery hands the trusted in-process caller the same object it
 *   passed (locality semantics: trusted = direct reference).
 *
 * Events: none. Extension state is returned as data (operator model:
 * list/inspect); the `.1` plugin.* vocabulary stays for backend plugins.
 */
import { PluginRuntimeError, PLUGIN_TRUST_CLASSES } from './plugin-runtime.mjs';
import { stableStringify } from './plugin-replay.mjs';

const violation = (message, details) =>
  new PluginRuntimeError('lego.contract_violation', message, { details });
const unavailable = (message, details) =>
  new PluginRuntimeError('lego.unavailable', message, { details });

/** The two attachment routes #83 allows — nothing else exists. */
export const FRONTEND_ATTACHMENT_ROUTES = Object.freeze(['PUBLIC_EXTENSION_POINT', 'MESSAGE_BOUNDARY']);

/** Bounds — ids, types and correlation keys are declared, never unbounded (§63). */
export const FRONTEND_MESSAGE_BOUNDS = Object.freeze({
  idMaxLength: 64,
  typeMaxLength: 128,
  requestIdMaxLength: 128,
  extensionPointMaxLength: 128,
});

const TRUST_CLASSES = new Set(PLUGIN_TRUST_CLASSES);
const MESSAGE_KEYS = new Set(['type', 'payload', 'requestId']);

/**
 * Derive the attachment route from trust and risk. Pure and fail-closed:
 * an unknown trust class or a malformed risk flag is a contract violation,
 * never a default.
 *
 * @param {{ trustClass: string, highRisk?: boolean }} request
 * @returns {'PUBLIC_EXTENSION_POINT' | 'MESSAGE_BOUNDARY'}
 */
export function resolveAttachmentRoute({ trustClass, highRisk = false } = {}) {
  if (typeof trustClass !== 'string' || !TRUST_CLASSES.has(trustClass)) {
    throw violation(`trustClass must be one of ${PLUGIN_TRUST_CLASSES.join('/')}`, {
      trustClass,
      declared: PLUGIN_TRUST_CLASSES,
    });
  }
  if (typeof highRisk !== 'boolean') {
    throw violation('highRisk must be a boolean', { highRisk: typeof highRisk });
  }
  // Untrusted classes are always message-bound; risk forces the boundary even
  // for trusted classes — high-risk work never gets a direct handle.
  if (trustClass === 'ISOLATED' || trustClass === 'SANDBOXED' || highRisk) {
    return 'MESSAGE_BOUNDARY';
  }
  return 'PUBLIC_EXTENSION_POINT';
}

/**
 * Validate a boundary/public message: plain object, declared top-level keys
 * only, bounded `type`, bounded optional `requestId`, and a payload graph
 * that survives the replay oracle's stable serialization (no functions, no
 * cycles, finite numbers). Throws `lego.contract_violation` on anything else.
 *
 * @param {unknown} message
 * @returns {true}
 */
export function assertFrontendMessage(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw violation('frontend message must be a plain object', { received: message === null ? 'null' : typeof message });
  }
  const unknown = Object.keys(message).filter((key) => !MESSAGE_KEYS.has(key));
  if (unknown.length > 0) {
    throw violation(`frontend message declares unknown field(s): ${unknown.join(', ')}`, { unknown });
  }
  const { type, requestId } = message;
  if (typeof type !== 'string' || type.length === 0 || type.length > FRONTEND_MESSAGE_BOUNDS.typeMaxLength) {
    throw violation(`message.type must be a string of length [1, ${FRONTEND_MESSAGE_BOUNDS.typeMaxLength}]`, {
      type: typeof type === 'string' ? type.length : typeof type,
    });
  }
  if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length > FRONTEND_MESSAGE_BOUNDS.requestIdMaxLength)) {
    throw violation(`message.requestId must be a string of length [0, ${FRONTEND_MESSAGE_BOUNDS.requestIdMaxLength}]`, {
      requestId: typeof requestId,
    });
  }
  // Fail-closed serialization oracle — the same one contract replay uses.
  stableStringify(message);
  return true;
}

function freezeDeep(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) freezeDeep(value[key]);
  return Object.freeze(value);
}

/**
 * Host for frontend extensions: registration derives the route from trust,
 * delivery enforces the route's semantics, detach removes. Metadata-only
 * list/inspect for the operator model; no events (state is data).
 *
 * @param {{ now?: () => number }} [options]
 */
export function createFrontendExtensionHost({ now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  /** @type {Map<string, object>} */
  const extensions = new Map();

  const knownRegisterKeys = new Set(['id', 'trustClass', 'highRisk', 'extensionPoint', 'handler', 'channel']);

  return Object.freeze({
    /**
     * Register an extension. The route is derived — `route` is not a field
     * this request accepts.
     *
     * @param {object} request
     * @param {string} request.id
     * @param {string} request.trustClass
     * @param {boolean} [request.highRisk]
     * @param {string} [request.extensionPoint] — declared hook id (public route)
     * @param {(message: object) => unknown} [request.handler] — required for PUBLIC_EXTENSION_POINT
     * @param {{ send: (message: object) => unknown }} [request.channel] — required for MESSAGE_BOUNDARY
     */
    register(request = {}) {
      if (request === null || typeof request !== 'object' || Array.isArray(request)) {
        throw violation('register request must be a plain object', {});
      }
      const unknown = Object.keys(request).filter((key) => !knownRegisterKeys.has(key));
      if (unknown.length > 0) {
        throw violation(`register request declares unknown field(s): ${unknown.join(', ')} — the route is derived, never requested`, {
          unknown,
        });
      }
      const { id, trustClass, highRisk, extensionPoint, handler, channel } = request;
      if (typeof id !== 'string' || id.length === 0 || id.length > FRONTEND_MESSAGE_BOUNDS.idMaxLength) {
        throw violation(`extension id must be a string of length [1, ${FRONTEND_MESSAGE_BOUNDS.idMaxLength}]`, {
          id: typeof id === 'string' ? id.length : typeof id,
        });
      }
      if (extensions.has(id)) {
        throw violation(`extension '${id}' is already registered`, { id });
      }
      if (extensionPoint !== undefined && (typeof extensionPoint !== 'string' || extensionPoint.length === 0 || extensionPoint.length > FRONTEND_MESSAGE_BOUNDS.extensionPointMaxLength)) {
        throw violation(`extensionPoint must be a string of length [1, ${FRONTEND_MESSAGE_BOUNDS.extensionPointMaxLength}]`, {
          extensionPoint: typeof extensionPoint,
        });
      }
      const route = resolveAttachmentRoute({ trustClass, highRisk });

      if (route === 'PUBLIC_EXTENSION_POINT') {
        if (typeof handler !== 'function') {
          throw violation('PUBLIC_EXTENSION_POINT requires a handler function', { id, route });
        }
        if (channel !== undefined) {
          throw violation('PUBLIC_EXTENSION_POINT speaks through its handler only — a message channel is not part of this route', {
            id,
            route,
          });
        }
      } else {
        if (handler !== undefined) {
          throw violation('MESSAGE_BOUNDARY forbids a direct handle — register a channel, not a handler', { id, route });
        }
        if (channel === null || typeof channel !== 'object' || typeof channel.send !== 'function') {
          throw violation('MESSAGE_BOUNDARY requires a channel with a send(message) function', { id, route });
        }
      }

      const record = Object.freeze({
        id,
        route,
        trustClass,
        highRisk: highRisk === true,
        extensionPoint: extensionPoint ?? null,
        registeredAt: now(),
        handler: route === 'PUBLIC_EXTENSION_POINT' ? handler : null,
        channel: route === 'MESSAGE_BOUNDARY' ? channel : null,
      });
      extensions.set(id, record);
      return Object.freeze({ id, route, trustClass: record.trustClass, highRisk: record.highRisk, extensionPoint: record.extensionPoint });
    },

    /** Metadata-only view — handlers and channels never leak through inspect. */
    list: () =>
      Object.freeze(
        [...extensions.values()].map((record) =>
          Object.freeze({
            id: record.id,
            route: record.route,
            trustClass: record.trustClass,
            highRisk: record.highRisk,
            extensionPoint: record.extensionPoint,
          })
        )
      ),

    routeOf(id) {
      const record = extensions.get(id);
      if (record === undefined) throw unavailable(`extension '${id}' is not registered`, { id });
      return record.route;
    },

    /**
     * Deliver a message. Validation runs before dispatch (an invalid message
     * never reaches an extension). PUBLIC_EXTENSION_POINT receives the SAME
     * object (trusted, in-process); MESSAGE_BOUNDARY receives a deep-frozen
     * serialized copy — no shared mutable state crosses the line.
     */
    deliver(id, message) {
      const record = extensions.get(id);
      if (record === undefined) throw unavailable(`extension '${id}' is not registered`, { id });
      assertFrontendMessage(message);
      if (record.route === 'PUBLIC_EXTENSION_POINT') {
        record.handler(message);
      } else {
        const copy = JSON.parse(stableStringify(message));
        record.channel.send(freezeDeep(copy));
      }
      return Object.freeze({ id, route: record.route, delivered: true, at: now() });
    },

    detach(id) {
      const record = extensions.get(id);
      if (record === undefined) throw unavailable(`extension '${id}' is not registered`, { id });
      extensions.delete(id);
      return Object.freeze({ id, detached: true });
    },
  });
}
