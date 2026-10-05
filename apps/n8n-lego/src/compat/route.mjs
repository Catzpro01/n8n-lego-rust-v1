/**
 * Compatibility layer — route ownership boundary.
 *
 * Part of the n8n compatibility boundary (`src/compat/`): the single router all
 * `/rest/*` traffic passes through. Domain modules (`src/auth/`, `src/settings/`,
 * the legacy aggregate in `src/rest/routes.mjs`) only declare routes; matching,
 * `:param` capture and the `public` flag contract live here, so a request always
 * follows `compat router → domain handler`.
 *
 * A miss on `/rest/*` is never silent: the server answers it through the
 * capability handler (`compat/capability.mjs`) with an explicit 501
 * "not implemented" response, logged once per path, instead of hanging or faking
 * a success.
 */

/**
 * @param {Array<{ method: string|string[], path: string, handler: Function, public?: boolean }>} routes
 */
export function createRouter(routes) {
  const compiled = routes.map((route) => compile(route));

  return {
    routes: compiled,
    /**
     * Resolves a method + path to a route without running it, so the caller can
     * enforce authentication before reading a request body.
     * @returns {{ handler: Function, params: Record<string,string>, public: boolean } | null}
     */
    match(method, path) {
      const upper = method.toUpperCase();
      for (const route of compiled) {
        if (!route.methods.includes(upper)) continue;
        const params = route.match(path);
        if (params === null) continue;
        return { handler: route.handler, params, public: route.public };
      }
      return null;
    },
  };
}

function compile(route) {
  const methods = (Array.isArray(route.method) ? route.method : [route.method]).map((m) => m.toUpperCase());
  const segments = route.path.split('/').filter((segment) => segment !== '');
  return {
    methods,
    public: route.public ?? false,
    handler: route.handler,
    match(path) {
      const parts = path.split('/').filter((segment) => segment !== '');
      if (parts.length !== segments.length) return null;
      const params = {};
      for (let i = 0; i < segments.length; i += 1) {
        const expected = segments[i];
        const actual = parts[i];
        if (expected.startsWith(':')) {
          params[expected.slice(1)] = decodeURIComponent(actual);
          continue;
        }
        if (expected !== actual) return null;
      }
      return params;
    },
  };
}
