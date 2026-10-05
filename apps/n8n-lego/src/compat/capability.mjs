/**
 * Compatibility layer — capability registry and the unsupported handler.
 *
 * Part of the n8n compatibility boundary (`src/compat/`): explicit semantics for
 * endpoints the real n8n API has but this instance does not implement yet.
 *
 * Before P2, every unknown `/rest/*` call was answered with a fake success:
 *
 *   200 {"data":null}     (GET — indistinguishable from "feature works, no data")
 *   200 {"data":true}     (writes — indistinguishable from "it persisted")
 *
 * That violated the boundary rule "an unavailable feature answers with a
 * distinguishable error/state, never 200 {}". The replacement contract:
 *
 *   501  { message, code: 'unsupported', meta: { feature, owner, phase } }
 *
 * …logged once per path as `[rest:unsupported]`, so the log stays the precise
 * backlog it was under the todo fallback. 501 matches upstream
 * (`cli/src/errors/response-errors/not-implemented.error.ts`); the editor's
 * REST client surfaces `message` while tooling can branch on `code`/`meta`.
 *
 * Owners/phases come from docs/n8n-lego/FRONTEND_COMPATIBILITY.md §5–§6 — this
 * registry is the runtime side of that map, not a promise to implement anything.
 */
import { unsupported } from './error.mjs';

/**
 * Known-but-unimplemented capability namespaces, longest prefix first.
 * Prefixes only ever fire on router misses, so implemented routes always win.
 *
 * @type {ReadonlyArray<{ prefix: string, feature: string, label: string, owner: string, phase: string }>}
 */
export const UNSUPPORTED_FEATURES = Object.freeze([
  // --- workspace LEGO (P3) ---
  { prefix: '/rest/workflow-history', feature: 'workflow-history', label: 'Workflow history', owner: 'workflow', phase: 'P3' },
  { prefix: '/rest/projects/', feature: 'workspace-projects', label: 'Team projects / project detail', owner: 'workspace', phase: 'P3' },
  // --- auth LEGO (P5) ---
  { prefix: '/rest/settings/security', feature: 'security-settings', label: 'Security settings', owner: 'auth', phase: 'P5' },
  { prefix: '/rest/me/survey', feature: 'personalization-survey', label: 'Personalization survey', owner: 'auth', phase: 'P5' },
  { prefix: '/rest/mfa/enforce-mfa', feature: 'mfa-enforcement', label: 'Enforce two-factor authentication (enterprise)', owner: 'auth', phase: 'deferred' },
  { prefix: '/rest/users/', feature: 'user-management', label: 'User management (invite / roles / delete)', owner: 'auth', phase: 'P5' },
  { prefix: '/rest/users', feature: 'user-management', label: 'User management (invite)', owner: 'auth', phase: 'P5' },
  // --- credentials LEGO ---
  { prefix: '/rest/oauth1-credential', feature: 'oauth1-flow', label: 'OAuth1 credential flow', owner: 'credentials', phase: 'P5+' },
  { prefix: '/rest/oauth2-credential', feature: 'oauth2-flow', label: 'OAuth2 credential flow', owner: 'credentials', phase: 'P5+' },
  { prefix: '/rest/credential-resolvers', feature: 'credential-resolvers', label: 'Credential resolvers (enterprise)', owner: 'credentials', phase: 'deferred' },
  { prefix: '/rest/external-secrets', feature: 'external-secrets', label: 'External secrets (enterprise)', owner: 'credentials', phase: 'deferred' },
  { prefix: '/rest/secret-providers', feature: 'external-secrets', label: 'External secrets providers (enterprise)', owner: 'credentials', phase: 'deferred' },
  // --- node-registry LEGO (P6) ---
  { prefix: '/rest/community-packages', feature: 'community-packages', label: 'Community nodes', owner: 'node-registry', phase: 'P6' },
  { prefix: '/rest/community-node-types/', feature: 'community-node-type-detail', label: 'Community node detail', owner: 'node-registry', phase: 'P6' },
  { prefix: '/rest/breaking-changes', feature: 'breaking-changes', label: 'Migration / breaking-changes report', owner: 'compatibility', phase: 'P6' },
  // --- dynamic-parameters LEGO (P7) ---
  { prefix: '/rest/dynamic-node-parameters', feature: 'dynamic-parameters', label: 'Dynamic node parameters', owner: 'dynamic-parameters', phase: 'P7' },
  // --- enterprise / licensed capabilities (deferred) ---
  { prefix: '/rest/sso', feature: 'sso', label: 'SSO (enterprise)', owner: 'auth', phase: 'deferred' },
  { prefix: '/rest/ldap', feature: 'ldap', label: 'LDAP (enterprise)', owner: 'auth', phase: 'deferred' },
  { prefix: '/rest/log-streaming', feature: 'log-streaming', label: 'Log streaming (enterprise)', owner: 'observability', phase: 'deferred' },
  { prefix: '/rest/source-control', feature: 'source-control', label: 'Source control / environments (enterprise)', owner: 'workflow', phase: 'deferred' },
  { prefix: '/rest/licenses', feature: 'license-management', label: 'License management', owner: 'compatibility', phase: 'deferred' },
  { prefix: '/rest/license/', feature: 'license-management', label: 'License management', owner: 'compatibility', phase: 'deferred' },
  { prefix: '/rest/insights', feature: 'insights', label: 'Insights', owner: 'compatibility', phase: 'deferred' },
  { prefix: '/rest/data-tables', feature: 'data-tables', label: 'Data tables', owner: 'data-tables', phase: 'deferred' },
  // --- worker LEGO (P11) ---
  { prefix: '/rest/orchestration', feature: 'orchestration', label: 'Worker view / orchestration (needs queue mode)', owner: 'worker', phase: 'P11' },
]);

const ORDERED = [...UNSUPPORTED_FEATURES].sort((a, b) => b.prefix.length - a.prefix.length);

/** Resolves a request path to the capability it belongs to, if one is registered. */
export function resolveUnsupportedFeature(path) {
  for (const entry of ORDERED) {
    if (path === entry.prefix || path.startsWith(entry.prefix)) return entry;
  }
  return null;
}

/** Sends the 501 for a capability entry, with the registry metadata attached. */
function throwEntry(entry) {
  throw unsupported(entry.feature, `${entry.label} is not available on this n8n-lego instance`, {
    owner: entry.owner,
    phase: entry.phase,
  });
}

/**
 * Placeholder route handler for a capability that is intentionally not
 * implemented — use inside a domain route table instead of inventing a stub:
 *
 *   { method: 'GET', path: '/rest/example', handler: unsupportedFeature('example') }
 */
export function unsupportedFeature(feature) {
  return () => {
    const entry = UNSUPPORTED_FEATURES.find((candidate) => candidate.feature === feature) ?? {
      feature,
      label: feature,
      owner: 'compatibility',
      phase: 'deferred',
    };
    throwEntry(entry);
  };
}

/**
 * The `/rest/*` catch-all: answers any unmatched path with the explicit
 * unsupported semantics and logs it once as the backlog signal. Throws nothing;
 * it sends the response itself because the server's error path is for failures,
 * and "this instance does not have this capability" is a described state.
 */
export function createUnsupportedHandler(logger) {
  const seen = new Set();
  return (ctx) => {
    const key = `${ctx.method} ${ctx.path}`;
    const entry = resolveUnsupportedFeature(ctx.path) ?? {
      feature: 'endpoint-not-implemented',
      label: `Endpoint ${ctx.method} ${ctx.path}`,
      owner: 'compatibility',
      phase: 'unplanned',
    };
    if (!seen.has(key)) {
      seen.add(key);
      logger.warn('[rest:unsupported] capability not implemented on this instance — answered 501', {
        method: ctx.method,
        path: ctx.path,
        feature: entry.feature,
        owner: entry.owner,
        phase: entry.phase,
        query: Object.keys(ctx.query ?? {}).length > 0 ? ctx.query : undefined,
      });
    }
    throwEntry(entry);
  };
}
