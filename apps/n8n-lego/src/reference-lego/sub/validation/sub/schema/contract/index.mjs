/**
 * Reference sub-sub-LEGO — PUBLIC CONTRACT (`reference.validation.schema`, v1.0.0).
 *
 * TEMPLATE, NOT A FEATURE. Depth 3: `reference-lego > validation > schema`.
 * Parent: `reference-lego.validation`. Owner: manager.
 *
 * This grandchild carries the P2.7 **implementation replacement** proof:
 *
 *         public contract (this file)
 *         ├── implementation A  internal/strict-checker.mjs   (hand-written)
 *         └── implementation B  internal/table-checker.mjs    (table-driven)
 *
 * Both satisfy `SCHEMA_OPERATIONS`. The consumer (`reference.validation`) holds
 * the contract, never a concrete checker, so swapping A for B changes nothing
 * for it — the same property that will later let a Rust implementation replace
 * the JS one behind an unchanged contract. No Rust is created here; the point
 * is that the seam exists and is tested.
 */
import { createStrictChecker } from '../internal/strict-checker.mjs';
import { createTableChecker } from '../internal/table-checker.mjs';

export const SCHEMA_CAPABILITY = 'reference.validate.schema';
export const SCHEMA_CONTRACT_VERSION = '1.0.0';

/** The operations any implementation must provide. Replacement is checked against this. */
export const SCHEMA_OPERATIONS = Object.freeze(['check']);

/** Named implementations behind the one contract. Adding one is a MINOR change. */
export const SCHEMA_IMPLEMENTATIONS = Object.freeze({
  /** A — explicit, hand-written checks. The default. */
  strict: createStrictChecker,
  /** B — the same contract, driven by a rule table. Interchangeable with A. */
  table: createTableChecker,
});

/**
 * @param {{ implementation?: keyof typeof SCHEMA_IMPLEMENTATIONS }} [options]
 * @returns {{ capability: string, version: string, implementation: string, check(value: unknown): { issues: Array<{path: string, reason: string}> } }}
 */
export function createSchemaChecker({ implementation = 'strict' } = {}) {
  const factory = SCHEMA_IMPLEMENTATIONS[implementation];
  if (!factory) {
    throw new Error(
      `unknown schema implementation '${implementation}' — expected one of ${Object.keys(SCHEMA_IMPLEMENTATIONS).join(', ')}`,
    );
  }
  const impl = factory();
  return Object.freeze({
    capability: SCHEMA_CAPABILITY,
    version: SCHEMA_CONTRACT_VERSION,
    /** Which implementation is behind the port — observable for diagnostics only. */
    implementation,
    check(value) {
      return impl.check(value);
    },
  });
}
