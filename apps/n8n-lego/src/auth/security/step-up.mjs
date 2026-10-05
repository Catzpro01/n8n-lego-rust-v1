/**
 * P5.6 — declared authentication strength for sensitive operations (step-up).
 *
 * Every account-security operation is DECLARED here: the minimum strength the
 * session must already have, and the fresh proofs the request itself must carry.
 * A route does not decide its own bar — it names its operation, collects the
 * proofs it verified, and asks `evaluateStepUp`. A test walks the route table
 * and fails if any mutating account route is missing from this table.
 *
 * Strength uses the ONE ladder P5.1 defined (`AUTH_STRENGTHS`,
 * `meetsAuthStrength`): none < password < api-key < mfa < step-up. Satisfying an
 * operation's proofs raises the request — only that request — to `step-up`.
 *
 * Interactive only: every operation here refuses `api-key`/`service` sessions.
 * An API key or an agent identity is never a way to change a human's password,
 * e-mail or second factor (P5.7 must keep it that way).
 *
 * The requirements reproduce upstream n8n's checks exactly where upstream has
 * one (so the editor's forms keep working) and name them explicitly:
 *   - PATCH /me/password      current password, plus TOTP when enrolled
 *   - PATCH /me (email)       TOTP when enrolled, otherwise current password
 *   - POST /mfa/enable        a TOTP from the pending secret
 *   - POST /mfa/disable       a TOTP or a recovery code
 *   - POST /change-password   a reset token, plus TOTP when enrolled
 */
import { meetsAuthStrength } from './principal.mjs';

/** Proof kinds a request can present. */
export const PROOF = Object.freeze({
  CURRENT_PASSWORD: 'current-password',
  TOTP: 'totp',
  RECOVERY_CODE: 'recovery-code',
  RESET_TOKEN: 'reset-token',
});

/**
 * @typedef {object} StepUpRequirement
 * @property {string} session     minimum session strength before any proof
 * @property {string} enrolledSession minimum session strength when MFA is enabled
 * @property {Array<Array<string>>} proofs  proofs when NOT enrolled: every inner list is
 *   an alternative set (OR of ANDs); [] => no proof needed
 * @property {Array<Array<string>>} enrolledProofs proofs when MFA is enabled
 * @property {string} required    strength the request must reach
 */
export const STEP_UP_REQUIREMENTS = Object.freeze({
  'account.password.change': Object.freeze({
    session: 'password',
    enrolledSession: 'mfa',
    proofs: [[PROOF.CURRENT_PASSWORD]],
    enrolledProofs: [[PROOF.CURRENT_PASSWORD, PROOF.TOTP]],
    required: 'step-up',
  }),
  'account.email.change': Object.freeze({
    session: 'password',
    enrolledSession: 'mfa',
    proofs: [[PROOF.CURRENT_PASSWORD]],
    enrolledProofs: [[PROOF.TOTP]],
    required: 'step-up',
  }),
  'account.mfa.setup': Object.freeze({
    session: 'password',
    enrolledSession: 'mfa',
    proofs: [],
    enrolledProofs: [],
    required: 'password',
  }),
  'account.mfa.enable': Object.freeze({
    session: 'password',
    enrolledSession: 'mfa',
    proofs: [[PROOF.TOTP]],
    enrolledProofs: [[PROOF.TOTP]],
    required: 'step-up',
  }),
  'account.mfa.disable': Object.freeze({
    session: 'password',
    enrolledSession: 'mfa',
    proofs: [[PROOF.TOTP], [PROOF.RECOVERY_CODE]],
    enrolledProofs: [[PROOF.TOTP], [PROOF.RECOVERY_CODE]],
    required: 'step-up',
  }),
  'account.password.reset': Object.freeze({
    session: 'none',
    enrolledSession: 'none',
    proofs: [[PROOF.RESET_TOKEN]],
    enrolledProofs: [[PROOF.RESET_TOKEN, PROOF.TOTP]],
    required: 'step-up',
  }),
});

/** Session kinds that may never perform an account-security operation. */
const NON_INTERACTIVE = new Set(['api-key', 'service', 'agent']);

/**
 * The proof alternatives an operation demands for this account.
 * @returns {Array<Array<string>>}
 */
export function requiredProofs(operation, { enrolled }) {
  const requirement = STEP_UP_REQUIREMENTS[operation];
  if (!requirement) return null;
  return enrolled ? requirement.enrolledProofs : requirement.proofs;
}

/**
 * Decide whether a request meets its operation's declared bar.
 *
 * @param {string} operation key of STEP_UP_REQUIREMENTS
 * @param {object} input
 * @param {string} input.sessionStrength strength of the session (or 'none')
 * @param {string} [input.principalType] 'user' unless stated
 * @param {boolean} input.enrolled MFA enabled on the account
 * @param {Iterable<string>} input.proofs proofs the route VERIFIED on this request
 * @returns {{ ok: boolean, strength: string, reason: string|null, missing: string[] }}
 */
export function evaluateStepUp(operation, { sessionStrength, principalType = 'user', enrolled, proofs = [] }) {
  const requirement = STEP_UP_REQUIREMENTS[operation];
  // Undeclared operation: fail closed. A new sensitive route cannot ship
  // without choosing its bar.
  if (!requirement) return { ok: false, strength: sessionStrength, reason: 'undeclared-operation', missing: [] };
  if (NON_INTERACTIVE.has(principalType) || NON_INTERACTIVE.has(sessionStrength)) {
    return { ok: false, strength: sessionStrength, reason: 'interactive-session-required', missing: [] };
  }
  const floor = enrolled ? requirement.enrolledSession : requirement.session;
  if (!meetsAuthStrength({ authStrength: sessionStrength }, floor)) {
    return { ok: false, strength: sessionStrength, reason: 'session-too-weak', missing: [] };
  }
  const have = new Set(proofs);
  const alternatives = enrolled ? requirement.enrolledProofs : requirement.proofs;
  let strength = sessionStrength;
  if (alternatives.length > 0) {
    const satisfied = alternatives.find((set) => set.every((proof) => have.has(proof)));
    if (!satisfied) {
      const closest = alternatives[0].filter((proof) => !have.has(proof));
      return { ok: false, strength, reason: 'proof-missing', missing: closest };
    }
    strength = 'step-up';
  }
  if (!meetsAuthStrength({ authStrength: strength }, requirement.required)) {
    return { ok: false, strength, reason: 'strength-insufficient', missing: [] };
  }
  return { ok: true, strength, reason: null, missing: [] };
}
