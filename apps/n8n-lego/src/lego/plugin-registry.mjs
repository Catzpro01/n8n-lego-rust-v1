/**
 * Backend LEGO foundation — P2.27 plugin registry.
 *
 * PUBLIC CONTRACT (`lego.plugin-runtime`, v0.2.0, owner: agent-1).
 *
 * The registry is the *identity* half of the plugin boundary (design §4/§5):
 * validated manifests in, frozen records out, one live version per plugin id,
 * contract resolution with `compat.mjs` range semantics, and an explicit
 * `unregister` for drains/rollbacks. It is deliberately NOT a package manager:
 * no network, no disk, no loading mechanism — an `implementation` is whatever
 * the caller hands over (in-process object today; other localities arrive with
 * the locality slice, without changing this contract).
 *
 * Duplicate plugin ids fail closed (`lego.contract_violation`). Side-by-side
 * v1|v2 candidates do NOT live here until the upgrade slice (P2.27.9), which
 * composes a candidate slot on top of this single-active-version registry —
 * no second registry (design §7).
 *
 * Events: `plugin.registered` / `plugin.rejected` / `plugin.deactivated`
 * flow to the core's bounded event ring through the injected `onEvent` hook.
 */
import { PluginRuntimeError } from './plugin-runtime.mjs';
import { validateManifest } from './plugin-manifest.mjs';
import { satisfies } from './compat.mjs';

/**
 * Create a plugin registry.
 *
 * @param {{ now?: () => number, onEvent?: (type: string, detail: object) => void }} [options]
 */
export function createPluginRegistry({ now = Date.now, onEvent = null } = {}) {
  if (typeof now !== 'function') throw new TypeError('createPluginRegistry requires now() to be a function');
  if (onEvent !== null && typeof onEvent !== 'function') {
    throw new TypeError('createPluginRegistry onEvent must be a function or null');
  }
  /** @type {Map<string, object>} one active version per plugin id */
  const plugins = new Map();

  const emit = (type, detail) => {
    if (onEvent) onEvent(type, detail);
  };

  const summaryOf = (record) =>
    Object.freeze({
      id: record.id,
      version: record.version,
      publisher: record.manifest.publisher,
      trustClass: record.manifest.trustClass,
      runtimeClass: record.manifest.runtimeClass,
      contract: record.manifest.contract,
      state: record.state,
    });

  const register = (manifest, implementation) => {
    let normalized;
    try {
      normalized = validateManifest(manifest);
    } catch (error) {
      emit('plugin.rejected', {
        id: manifest && typeof manifest === 'object' ? String(manifest.id ?? '') : '',
        code: error instanceof PluginRuntimeError ? error.code : 'lego.contract_violation',
        phase: 'validate',
      });
      throw error;
    }
    if (implementation === undefined || implementation === null) {
      emit('plugin.rejected', { id: normalized.id, code: 'lego.contract_violation', phase: 'implementation' });
      throw new PluginRuntimeError('lego.contract_violation', `plugin '${normalized.id}' has no implementation`, {
        details: { id: normalized.id },
      });
    }
    if (plugins.has(normalized.id)) {
      emit('plugin.rejected', { id: normalized.id, code: 'lego.contract_violation', phase: 'duplicate' });
      throw new PluginRuntimeError('lego.contract_violation', `plugin id '${normalized.id}' is already registered`, {
        details: { id: normalized.id, registeredVersion: plugins.get(normalized.id).version, attemptedVersion: normalized.version },
      });
    }
    const record = Object.freeze({
      id: normalized.id,
      version: normalized.version,
      state: 'DISCOVERED',
      registeredAt: now(),
      manifest: normalized,
      implementation,
    });
    plugins.set(record.id, record);
    emit('plugin.registered', {
      id: record.id,
      version: record.version,
      trustClass: record.manifest.trustClass,
      runtimeClass: record.manifest.runtimeClass,
    });
    return record;
  };

  const get = (id) => plugins.get(id);
  const has = (id) => plugins.has(id);

  const list = () => Object.freeze([...plugins.values()].map(summaryOf));

  const size = () => plugins.size;

  const unregister = (id) => {
    const existed = plugins.delete(id);
    if (existed) emit('plugin.deactivated', { id, reason: 'unregistered' });
    return existed;
  };

  /**
   * Resolve `contractId@range` against registered plugins. The plugin's own
   * version numbers are the contract version numbers it provides (1:1), so
   * range semantics are exactly `compat.mjs satisfies`.
   *
   * - no provider for the id → `lego.unavailable`
   * - providers exist, none satisfies the range → `lego.version_incompatible`
   *   (with the available versions in `details`)
   */
  const resolveContract = (contractId, range) => {
    const candidates = [...plugins.values()].filter((record) => record.manifest.contract.id === contractId);
    if (candidates.length === 0) {
      throw new PluginRuntimeError('lego.unavailable', `no registered plugin provides contract '${contractId}'`, {
        details: { contractId },
      });
    }
    for (const candidate of candidates) {
      const verdict = satisfies(candidate.version, range);
      if (verdict.satisfied) return candidate;
    }
    throw new PluginRuntimeError(
      'lego.version_incompatible',
      `contract '${contractId}' has no registered version satisfying '${range}'`,
      {
        details: { contractId, range, available: candidates.map((candidate) => candidate.version) },
        retryable: false,
      },
    );
  };

  return Object.freeze({
    register,
    get,
    has,
    list,
    size,
    unregister,
    resolveContract,
  });
}
