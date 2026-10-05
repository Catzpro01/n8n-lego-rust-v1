/**
 * AUTH LEGO — public contract.
 *
 * PUBLIC CONTRACT (`auth.identity`, v1.0.0, owner: agent-3).
 *
 * WHY THIS FILE EXISTS: allowances A1 and A2 existed only because the auth
 * domain published nothing, so the compatibility layer and the settings LEGO had
 * to import `src/auth.mjs` internals directly. That is a boundary violation kept
 * alive by an absence, not by a genuine coupling — both consumers needed exactly
 * two small, stable, read-only functions.
 *
 * This is the narrow boundary contract that retires both allowances. It is
 * deliberately a re-export and nothing else: no new behaviour, no new policy, no
 * session mechanics. Session handling, password hashing, token signing and owner
 * creation all stay private inside `src/auth.mjs`, where agent-3 owns them.
 *
 * SCOPE DISCIPLINE — this contract exposes only what a *non-auth* LEGO
 * legitimately needs:
 *
 *   - `toPublicUser(user)` — the PublicUser projection. A caller needs this to
 *     render a user; it cannot be used to authenticate as one.
 *   - `hasOwner(store)`    — whether instance setup has happened. A boolean that
 *     drives the editor's first-run screen.
 *
 * Anything requiring authority (creating sessions, verifying passwords, minting
 * tokens) is absent on purpose. A consumer that needs those does not need a
 * wider contract — it needs to not be doing that.
 *
 * Agent 3 owns the evolution of this file. Adding an export is a contract change
 * and needs a version decision; `test/lego-boundary.test.mjs` fails if the
 * surface grows without one, so it cannot widen quietly the way an allowlist can.
 */
export { toPublicUser, hasOwner } from '../../auth.mjs';
