/**
 * Backend LEGO foundation — P2.27 secret broker (scoped, short-lived, one op).
 *
 * PUBLIC CONTRACT (`lego.plugin-runtime`, v0.5.0, owner: agent-1).
 *
 * Design §12, verbatim in code:
 *
 * ```text
 * plugin → secret broker → scoped short-lived secret → one operation
 * ```
 *
 * - **`plugin → credential database` is forbidden.** The broker never holds a
 *   credential store: material arrives per-issue through an injected
 *   `source(operation, meta)` living OUTSIDE the Core, and only for the span
 *   of one grant.
 * - A plugin receives an opaque **token**, not the material. The material is
 *   resolved exactly once, for the declared operation, and then deleted —
 *   there is nothing to persist, leak on a later call, or hand to a child
 *   (delegation of a consumed token is structurally impossible).
 * - Expiry is enforced at resolve-time against the injected clock; TTLs are
 *   bounded. Live grants are bounded (`lego.backpressure` past the cap) —
 *   no unbounded map, no standing credential, no queue (§63).
 * - Events (`plugin.secret-issued`) carry metadata only: **never** the token
 *   or the material.
 *
 * Failure codes (all published): `lego.deadline_exceeded` expired ·
 * `lego.access_denied` wrong scope or already-consumed ·
 * `lego.unavailable` unknown/revoked token or no source configured ·
 * `lego.backpressure` live-grant cap · `lego.contract_violation` bad input.
 */
import { randomBytes } from 'node:crypto';
import { PluginRuntimeError } from './plugin-runtime.mjs';

/** Bounds — short-lived means short; live means few (§63). */
export const PLUGIN_SECRET_LIMITS = Object.freeze({
  defaultTtlMs: 30_000,
  maxTtlMs: 300_000,
  maxLive: 64,
  tokenByteLength: 18,
  operationMaxLength: 128,
  pluginIdMaxLength: 64,
});

const violation = (message, details) => new PluginRuntimeError('lego.contract_violation', message, { details });

function assertTokenString(value, where, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw violation(`${where} must be a string of length [1, ${max}]`, { where });
  }
}

/**
 * Create a secret broker.
 *
 * @param {{
 *   now?: () => number,
 *   source?: (operation: string, meta: { pluginId: string }) => string,
 *   onEvent?: (type: string, detail: object) => void,
 *   maxLive?: number,
 *   defaultTtlMs?: number,
 *   tokenFactory?: () => string,
 * }} [options]
 */
export function createSecretBroker({
  now = Date.now,
  source = null,
  onEvent = null,
  maxLive = PLUGIN_SECRET_LIMITS.maxLive,
  defaultTtlMs = PLUGIN_SECRET_LIMITS.defaultTtlMs,
  tokenFactory = null,
} = {}) {
  if (typeof now !== 'function') throw new TypeError('createSecretBroker requires now() to be a function');
  if (source !== null && typeof source !== 'function') {
    throw new TypeError('createSecretBroker source must be a function or null');
  }
  if (onEvent !== null && typeof onEvent !== 'function') {
    throw new TypeError('createSecretBroker onEvent must be a function or null');
  }
  if (!Number.isInteger(maxLive) || maxLive < 1 || maxLive > 1024) {
    throw new TypeError('createSecretBroker maxLive must be an integer in [1, 1024]');
  }
  if (!Number.isInteger(defaultTtlMs) || defaultTtlMs < 1 || defaultTtlMs > PLUGIN_SECRET_LIMITS.maxTtlMs) {
    throw new TypeError(`createSecretBroker defaultTtlMs must be an integer in [1, ${PLUGIN_SECRET_LIMITS.maxTtlMs}]`);
  }
  if (tokenFactory !== null && typeof tokenFactory !== 'function') {
    throw new TypeError('createSecretBroker tokenFactory must be a function or null');
  }
  const mint = tokenFactory ?? (() => `sk_${randomBytes(PLUGIN_SECRET_LIMITS.tokenByteLength).toString('base64url')}`);

  /** @type {Map<string, { material: string, pluginId: string, operation: string, expiresAt: number }>} */
  const live = new Map();

  const emit = (type, detail) => {
    if (onEvent) onEvent(type, detail);
  };

  /**
   * Issue a scoped, short-lived grant for exactly one operation.
   * Returns metadata + token; the material never leaves this closure except
   * through a single successful `resolve`.
   */
  const issue = ({ pluginId, operation, ttlMs = defaultTtlMs } = {}) => {
    assertTokenString(pluginId, 'pluginId', PLUGIN_SECRET_LIMITS.pluginIdMaxLength);
    assertTokenString(operation, 'operation', PLUGIN_SECRET_LIMITS.operationMaxLength);
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > PLUGIN_SECRET_LIMITS.maxTtlMs) {
      throw violation(`ttlMs must be an integer in [1, ${PLUGIN_SECRET_LIMITS.maxTtlMs}]`, { ttlMs });
    }
    if (live.size >= maxLive) {
      throw new PluginRuntimeError('lego.backpressure', `secret broker is at its live-grant cap (${maxLive})`, {
        details: { maxLive, live: live.size },
        retryable: true,
      });
    }
    if (!source) {
      throw new PluginRuntimeError('lego.unavailable', 'secret broker has no source configured — nothing may be issued', {
        details: { pluginId, operation },
      });
    }
    const material = source(operation, { pluginId });
    if (typeof material !== 'string' || material.length === 0) {
      throw new PluginRuntimeError('lego.unavailable', 'secret source returned no material', {
        details: { pluginId, operation },
      });
    }
    const token = mint();
    if (live.has(token)) {
      throw new PluginRuntimeError('lego.contract_violation', 'tokenFactory produced a duplicate live token', {
        details: { pluginId },
      });
    }
    const expiresAt = now() + ttlMs;
    live.set(token, { material, pluginId, operation, expiresAt });
    emit('plugin.secret-issued', { pluginId, operation, expiresAt, ttlMs });
    return Object.freeze({ token, pluginId, operation, expiresAt, ttlMs });
  };

  /**
   * Resolve a grant exactly once for the declared operation. Every failure
   * path is a published code; every success deletes the grant first-class
   * (one operation — there is no second read).
   */
  const resolve = (token, operation) => {
    if (typeof token !== 'string' || token.length === 0 || token.length > 256) {
      throw violation('token must be a non-empty string of length <= 256');
    }
    assertTokenString(operation, 'operation', PLUGIN_SECRET_LIMITS.operationMaxLength);
    const grant = live.get(token);
    if (!grant) {
      throw new PluginRuntimeError('lego.unavailable', 'no live secret grant for this token (unknown, revoked, or consumed)', {
        details: { operation },
      });
    }
    if (now() > grant.expiresAt) {
      live.delete(token);
      throw new PluginRuntimeError('lego.deadline_exceeded', 'secret grant expired before it was resolved', {
        details: { pluginId: grant.pluginId, operation: grant.operation, expiresAt: grant.expiresAt },
      });
    }
    if (grant.operation !== operation) {
      throw new PluginRuntimeError('lego.access_denied', 'secret grant is scoped to a different operation', {
        details: { pluginId: grant.pluginId, scopedOperation: grant.operation, attemptedOperation: operation },
      });
    }
    // One operation: delete BEFORE returning material — a re-entrant or later
    // call finds nothing, even if the consumer throws while using it.
    live.delete(token);
    emit('plugin.resolved', { pluginId: grant.pluginId, operation: grant.operation });
    return grant.material;
  };

  const revoke = (token) => live.delete(token);

  /** Drop expired grants (they still count against the cap until swept). */
  const sweep = () => {
    const deadline = now();
    let removed = 0;
    for (const [token, grant] of live) {
      if (deadline > grant.expiresAt) {
        live.delete(token);
        removed += 1;
      }
    }
    return removed;
  };

  const liveCount = () => live.size;

  /** Metadata only — never materials, never tokens. */
  const inspect = () =>
    Object.freeze(
      [...live.values()].map((grant) =>
        Object.freeze({ pluginId: grant.pluginId, operation: grant.operation, expiresAt: grant.expiresAt }),
      ),
    );

  return Object.freeze({ issue, resolve, revoke, sweep, liveCount, inspect });
}
