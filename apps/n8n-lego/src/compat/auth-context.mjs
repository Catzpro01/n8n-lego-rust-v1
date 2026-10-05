/**
 * Compatibility layer — auth context.
 *
 * Part of the n8n compatibility boundary (`src/compat/`): how the signed-in user
 * is exposed to the editor. Session mechanics stay in `src/auth.mjs`; this
 * module owns the *shape* of the authenticated context — above all the
 * `PublicUser` envelope, which upstream returns where the editor seeds its
 * RBAC store (`app/init.ts`: `RBACStore.setGlobalScopes(user.globalScopes)`).
 */
import { toPublicUser } from '../auth/contract/index.mjs';
import { getGlobalScopes } from './scopes.mjs';
import { unauthorized } from './error.mjs';

/**
 * `PublicUser` as the editor expects it. `toPublicUser` (auth module) produces
 * the stored fields; the compatibility layer adds the contract fields upstream
 * attaches via `userService.toPublic(user, { withScopes: true, mfaAuthenticated })`:
 *
 *   - `globalScopes`   — computed from the user's global role (compat/scopes.mjs).
 *     Without it the editor's RBAC store stays empty, every scope-gated route
 *     redirects to `/home` and the settings sidebar collapses to "Personal".
 *   - `mfaAuthenticated` — whether THIS session was established with a second
 *     factor (P5.6). The auth domain passes it from the session record; the
 *     compatibility layer only places it in the envelope. Defaults to false,
 *     which is what upstream sends for a non-MFA session.
 *
 * @param {object} user stored user record
 * @param {object} config runtime config
 * @param {{ withScopes?: boolean, mfaAuthenticated?: boolean }} [options] pass
 *   `withScopes: false` for payloads upstream returns without scopes (the
 *   `/rest/users` list, see `users.controller.ts` listUsers).
 */
export function publicUser(user, config, { withScopes = true, mfaAuthenticated = false } = {}) {
  const base = toPublicUser(user);
  if (base === null) return null;
  if (!withScopes) return base;
  return {
    ...base,
    globalScopes: getGlobalScopes(user, config),
    mfaAuthenticated: mfaAuthenticated === true,
  };
}

/** Requires an authenticated context — the 401 gate every protected route shares. */
export function requireUser(ctx) {
  if (!ctx.user) throw unauthorized();
  return ctx.user;
}
