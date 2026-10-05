/**
 * AUTH LEGO — the session, account and permission-model routes.
 *
 * Domain ownership: login/logout, owner setup, the current-user (`me`) twin of
 * `PublicUser`, the users list and the role catalog. Registration goes through
 * the compatibility router (`src/compat/route.mjs`); every envelope/error goes
 * through `src/compat/`. Scopes exposed to the editor come from the extracted
 * permission model (`src/compat/scopes.mjs`), never from a hardcoded list.
 *
 * P5.6: password change, password recovery, MFA and the login second factor
 * are implemented in `./account-routes.mjs` and mounted here. User-management
 * *administration* (invite, role change, delete) and API keys still answer via
 * the compatibility layer's unsupported semantics — see `src/compat/capability.mjs`.
 */
import { badRequest, forbidden, notFound, unauthorized } from '../compat/error.mjs';
import { sendData } from '../compat/response.mjs';
import { publicUser, requireUser } from '../compat/auth-context.mjs';
import { loadRoles } from '../compat/scopes.mjs';
import {
  bumpSecurityVersion,
  clearSessionCookieHeader,
  createOwner,
  createSession,
  currentSession,
  hasOwner,
  revokeCurrentSession,
} from '../auth.mjs';
import { accountRoutes, createAccountSecurity, guardEmailChange, login } from './account-routes.mjs';
import { apiKeyRoutes } from './api-key-routes.mjs';

/**
 * @param {object} options
 * @param {object} options.logger
 * @param {object|null} [options.vault] P5.5 vault; seals MFA secrets (null => MFA fails closed with 503)
 * @param {object|null} [options.delivery] password-reset delivery port (null => upstream no-SMTP answer)
 * @param {object} [options.security] bounded abuse-control / reset-token state
 */
export function authRoutes({ logger, vault = null, delivery = null, security = createAccountSecurity() }) {
  const deps = { security, vault };
  return [
    {
      method: 'GET',
      path: '/rest/login',
      public: true,
      handler: (ctx) => {
        if (!ctx.user) throw unauthorized();
        const session = currentSession(ctx.config, ctx.req);
        sendData(ctx.res, publicUser(ctx.user, ctx.config, { mfaAuthenticated: session?.authStrength === 'mfa' }));
      },
    },
    {
      method: 'POST',
      path: '/rest/login',
      public: true,
      // P5.2: a fresh login gets a fresh session AND a fresh CSRF token (bound
      // to the session id). P5.6: bounded rate limits, failure back-off and the
      // MFA second factor — see account-routes.mjs `login`.
      handler: (ctx) => login(ctx, deps),
    },
    {
      method: 'POST',
      path: '/rest/logout',
      public: true,
      handler: (ctx) => {
        // P5.2: logout now kills the server-side session, not just the cookie.
        // Clearing the cookie alone only stopped *this* browser from presenting
        // the token — any copy of it stayed valid until it expired.
        revokeCurrentSession(ctx.config, ctx.req);
        sendData(ctx.res, { loggedOut: true }, { headers: { 'set-cookie': clearSessionCookieHeader() } });
      },
    },
    {
      method: 'POST',
      path: '/rest/owner/setup',
      public: true,
      handler: (ctx) => {
        if (hasOwner(ctx.store)) throw forbidden('Instance owner already exists');
        const { email, firstName, lastName, password } = ctx.body ?? {};
        if (!email || !password) throw badRequest('Email and password are required');
        const user = createOwner(ctx.store, { email, firstName, lastName, password });
        const { cookie, csrfCookie } = createSession(user, ctx.config);
        logger.info('owner account created', { email: user.email });
        sendData(ctx.res, publicUser(user, ctx.config), {
          headers: { 'set-cookie': [cookie, csrfCookie] },
        });
      },
    },
    {
      method: 'POST',
      path: '/rest/owner/dismiss-banner',
      handler: (ctx) => {
        sendData(ctx.res, true);
      },
    },

    /* ------------------------------------------------------------------- me */
    {
      method: ['GET', 'PATCH'],
      path: '/rest/me',
      handler: (ctx) => {
        const user = requireUser(ctx);
        if (ctx.method === 'PATCH') {
          // P5.6: changing the e-mail needs fresh proof (upstream semantics).
          const emailChanging = guardEmailChange(ctx, deps, user);
          const patch = {};
          for (const key of ['firstName', 'lastName', 'email']) {
            if (typeof ctx.body?.[key] === 'string') patch[key] = ctx.body[key];
          }
          if (typeof patch.email === 'string') patch.email = patch.email.toLowerCase();
          const updated = ctx.store.users.update(user.id, patch);
          // An e-mail change is an authority change: kill every session and
          // reissue one (upstream's JWT hash covers the e-mail, same effect).
          let headers = {};
          if (emailChanging) {
            const strength = currentSession(ctx.config, ctx.req)?.authStrength ?? 'password';
            bumpSecurityVersion(user.id);
            const { cookie, csrfCookie } = createSession(updated, ctx.config, { authStrength: strength });
            headers = { 'set-cookie': [cookie, csrfCookie] };
          }
          // Upstream `me.controller.updateCurrentUser` returns `toPublic(user)`
          // without scopes — the editor merges it into its current user, while
          // the RBAC store keeps the scopes it was seeded with at login.
          return sendData(ctx.res, publicUser(updated, ctx.config, { withScopes: false }), { headers });
        }
        return sendData(ctx.res, publicUser(user, ctx.config));
      },
    },
    {
      method: 'PATCH',
      path: '/rest/me/settings',
      handler: (ctx) => {
        const user = requireUser(ctx);
        const updated = ctx.store.users.update(user.id, { settings: { ...(user.settings ?? {}), ...(ctx.body ?? {}) } });
        sendData(ctx.res, publicUser(updated, ctx.config, { withScopes: false }));
      },
    },
    {
      // Upstream `users.controller.listUsers` serializes without scopes; the
      // RBAC store only tracks the signed-in user's scopes.
      method: 'GET',
      path: '/rest/users',
      handler: (ctx) => {
        requireUser(ctx);
        const users = ctx.store.users.all().map((user) => publicUser(user, ctx.config, { withScopes: false }));
        sendData(ctx.res, { count: users.length, items: users });
      },
    },

    /* ----------------------------------------------------------------- roles */
    {
      method: 'GET',
      path: '/rest/roles',
      handler: (ctx) => {
        requireUser(ctx);
        sendData(ctx.res, loadRoles(ctx.config));
      },
    },
    {
      method: 'GET',
      path: '/rest/roles/:slug',
      handler: (ctx) => {
        requireUser(ctx);
        const roles = loadRoles(ctx.config);
        const all = [...roles.global, ...roles.project, ...roles.credential, ...roles.workflow];
        const role = all.find((candidate) => candidate.slug === ctx.params.slug);
        if (!role) throw notFound('Role not found');
        sendData(ctx.res, { ...role, usedByUsers: 1 });
      },
    },

    /* ------------------------------------------- account security (P5.6) */
    ...accountRoutes({ logger, vault, security, delivery }),
    ...apiKeyRoutes({ logger }),
  ];
}
