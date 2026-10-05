/**
 * Backend LEGO foundation — P2.27 runtime locality policy.
 *
 * PUBLIC CONTRACT (`lego.plugin-runtime`, v0.4.0, owner: agent-1).
 *
 * Design §6 is a *rule*, not a vibe: where a plugin executes is derived from
 * its trust class and the shape of the work (hot path, crash risk, external
 * scale). This module is that rule as data + checks — the matrix of
 * (trust class → allowed localities), the default posture per class,
 * a fail-closed assertion for the boundary, and a recommender that lets
 * `external`/`crashRisk` move a plugin **only along lanes its class already
 * allows** (an override can never widen the matrix).
 *
 * ```text
 * CORE        → IN_PROCESS            (the tiny trusted base stays in-process)
 * TRUSTED     → IN_PROCESS | ISOLATED_PROCESS | REMOTE
 * ISOLATED    → ISOLATED_PROCESS | REMOTE
 * SANDBOXED   → WASM | ISOLATED_PROCESS   (never in-process, never remote)
 * ```
 *
 * Vocabulary note: these are the same four locality words the node registry
 * already emits (`IN_PROCESS`, `ISOLATED_PROCESS`, …) — one locality
 * vocabulary, two registries' worth of *consumers*, zero synonyms. WASM here
 * is the locality class; a production WASM engine is explicitly out of scope
 * for this milestone (admission/locality policy is in scope).
 *
 * Failure codes: values that are not in the canonical vocabularies are
 * `lego.contract_violation` (schema). Values that ARE canonical but the class
 * forbids them are **`lego.access_denied`** — the policy said no.
 */
import { PluginRuntimeError, PLUGIN_TRUST_CLASSES, PLUGIN_RUNTIME_LOCALITIES } from './plugin-runtime.mjs';

/**
 * Allowed localities per trust class (design §6 × §8), fail-closed rows:
 * any class/locality pair not listed here is denied.
 */
export const LOCALITY_MATRIX = Object.freeze({
  CORE: Object.freeze(['IN_PROCESS']),
  TRUSTED: Object.freeze(['IN_PROCESS', 'ISOLATED_PROCESS', 'REMOTE']),
  ISOLATED: Object.freeze(['ISOLATED_PROCESS', 'REMOTE']),
  SANDBOXED: Object.freeze(['WASM', 'ISOLATED_PROCESS']),
});

/** The posture each class gets when nothing else applies (always a matrix row). */
export const DEFAULT_LOCALITY = Object.freeze({
  CORE: 'IN_PROCESS',
  TRUSTED: 'IN_PROCESS',
  ISOLATED: 'ISOLATED_PROCESS',
  SANDBOXED: 'WASM',
});

const violation = (message, details) => new PluginRuntimeError('lego.contract_violation', message, { details });
const denial = (message, details) => new PluginRuntimeError('lego.access_denied', message, { details });

function assertCanonical(trustClass, locality) {
  if (typeof trustClass !== 'string' || !PLUGIN_TRUST_CLASSES.includes(trustClass)) {
    throw violation(`trustClass must be one of ${PLUGIN_TRUST_CLASSES.join('/')}`, {
      trustClass,
      declared: PLUGIN_TRUST_CLASSES,
    });
  }
  if (typeof locality !== 'string' || !PLUGIN_RUNTIME_LOCALITIES.includes(locality)) {
    throw violation(`locality must be one of ${PLUGIN_RUNTIME_LOCALITIES.join('/')}`, {
      locality,
      declared: PLUGIN_RUNTIME_LOCALITIES,
    });
  }
}

/**
 * Is `(trustClass, locality)` a legal posture? Returns a frozen, explainable
 * verdict — never a bare boolean.
 *
 * @param {string} trustClass
 * @param {string} locality
 * @returns {{ allowed: boolean, reason: string, trustClass: string, locality: string }}
 */
export function isLocalityAllowed(trustClass, locality) {
  assertCanonical(trustClass, locality);
  const allowedRow = LOCALITY_MATRIX[trustClass];
  const allowed = allowedRow.includes(locality);
  return Object.freeze({
    allowed,
    reason: allowed
      ? `${trustClass} may execute as ${locality}`
      : `${trustClass} may not execute as ${locality} (allowed: ${allowedRow.join(', ') || 'none'})`,
    trustClass,
    locality,
  });
}

/**
 * The locality boundary assertion: allowed → `true`, canonical-but-forbidden
 * → `lego.access_denied`, non-canonical input → `lego.contract_violation`.
 *
 * @param {string} trustClass
 * @param {string} locality
 */
export function assertLocality(trustClass, locality) {
  const verdict = isLocalityAllowed(trustClass, locality);
  if (!verdict.allowed) {
    throw denial(verdict.reason, { trustClass, locality, allowedRow: [...LOCALITY_MATRIX[trustClass]] });
  }
  return true;
}

/**
 * Recommend a locality for a work shape (design §6 locality rule). Overrides
 * (`external`, `crashRisk`) only move the choice **within the class matrix**;
 * if the override lane is not allowed, the class default wins (fail closed —
 * an override can never widen authority).
 *
 * @param {string} trustClass
 * @param {{ external?: boolean, crashRisk?: boolean }} [shape]
 * @returns {string} one of PLUGIN_RUNTIME_LOCALITIES
 */
export function recommendLocality(trustClass, { external = false, crashRisk = false } = {}) {
  if (typeof trustClass !== 'string' || !PLUGIN_TRUST_CLASSES.includes(trustClass)) {
    throw violation(`trustClass must be one of ${PLUGIN_TRUST_CLASSES.join('/')}`, {
      trustClass,
      declared: PLUGIN_TRUST_CLASSES,
    });
  }
  if (typeof external !== 'boolean' || typeof crashRisk !== 'boolean') {
    throw violation('external/crashRisk flags must be booleans', { external, crashRisk });
  }
  const row = LOCALITY_MATRIX[trustClass];
  if (external && row.includes('REMOTE')) return 'REMOTE';
  if (crashRisk && row.includes('ISOLATED_PROCESS')) return 'ISOLATED_PROCESS';
  const fallback = DEFAULT_LOCALITY[trustClass];
  if (!row.includes(fallback)) {
    // Construction bug in the matrix/defaults pair — fail closed anyway.
    throw violation(`default locality for ${trustClass} is not in its matrix row`, { trustClass, fallback });
  }
  return fallback;
}
