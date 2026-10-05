/**
 * Reference sub-LEGO — PUBLIC CONTRACT (`reference.validation`, v1.1.0).
 *
 * TEMPLATE, NOT A FEATURE. Parent: `reference-lego`. Owner: manager.
 *
 * This is the "B" in the P2.7 sub-LEGO upgrade proof:
 *
 *     Parent v1                    Parent v1
 *     ├── repository v1     →      ├── repository v1   (untouched)
 *     ├── validation v1            ├── validation v2   (upgraded alone)
 *     └── schema v1                └── schema v1       (untouched)
 *
 * It was published at 1.0.0 with `validate()`. 1.1.0 ADDED `explain()` and the
 * optional `strict` option — additive only, so every 1.0.0 consumer keeps
 * working untouched and the parent contract does not move. See
 * `docs/n8n-lego/BACKEND_LEGO.md` §Parent/sub-LEGO lifecycle.
 *
 * It composes its own grandchild (`reference.validation.schema`) through that
 * child's PUBLIC contract — never its internals. That single import is what the
 * nested-boundary rule is really about.
 */
import { assertErrorCode } from '../../../../lego/errors.mjs';
import { createSchemaChecker, SCHEMA_CONTRACT_VERSION } from '../sub/schema/contract/index.mjs';
import { applyRules } from '../internal/rules.mjs';

export const VALIDATION_CAPABILITY = 'reference.validate';

/**
 * 1.1.0 — additive minor over 1.0.0:
 *   + explain()            new operation
 *   + options.strict       new optional input
 * Nothing was removed or narrowed, so `^1.0.0` consumers stay satisfied.
 */
export const VALIDATION_CONTRACT_VERSION = '1.1.0';

/** Operations a replacement implementation must provide to be swappable. */
export const VALIDATION_OPERATIONS = Object.freeze(['validate', 'explain']);

export class ValidationError extends Error {
  constructor(code, message, { issues = [] } = {}) {
    super(message);
    this.name = 'ValidationError';
    this.code = assertErrorCode(code);
    this.issues = issues;
  }
}

/**
 * @param {{ schema?: object, logger?: object }} [deps] the grandchild port is
 *        injectable: that is how a test doubles it, and how a future
 *        implementation swap happens without touching this file.
 */
export function createValidationLego({ schema = createSchemaChecker(), logger } = {}) {
  return Object.freeze({
    capability: VALIDATION_CAPABILITY,
    version: VALIDATION_CONTRACT_VERSION,
    /** The version of the grandchild contract actually wired in. */
    schemaVersion: schema.version ?? SCHEMA_CONTRACT_VERSION,

    /**
     * @param {object} value
     * @param {{ strict?: boolean }} [options] `strict` added in 1.1.0; omitted
     *        by 1.0.0 consumers, who therefore see exactly the old behaviour.
     */
    validate(value, { strict = false } = {}) {
      const shape = schema.check(value);
      const issues = [...shape.issues, ...applyRules(value, { strict })];
      logger?.debug?.('[reference.validation] validated', { issues: issues.length, strict });
      return { valid: issues.length === 0, issues };
    },

    /** Added in 1.1.0. A 1.0.0 consumer simply never calls it. */
    explain(value) {
      const { issues } = this.validate(value, { strict: true });
      return issues.map((issue) => `${issue.path}: ${issue.reason}`);
    },
  });
}
