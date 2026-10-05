/**
 * SETTINGS LEGO — the instance-settings routes.
 *
 * Domain ownership: `GET /rest/settings`, the boot payload the editor builds
 * its whole navigation from. The payload itself is built in
 * `frontend-settings.mjs`; endpoint administration behind the Settings pages
 * (security settings, community packages, license management, SSO…) is owned by
 * the respective LEGOs/roadmap phases and answers via the compatibility layer's
 * unsupported semantics until implemented (see `src/compat/capability.mjs`).
 */
import { sendData } from '../compat/response.mjs';
import { hasOwner } from '../auth/contract/index.mjs';
import { buildFrontendSettings } from './frontend-settings.mjs';

function buildSettingsContext(store) {
  // The editor shows the owner-setup screen while `showSetupOnFirstLoad` is true,
  // so it has to reflect whether an owner account exists yet.
  return { hasOwner: hasOwner(store) };
}

/** Origin as seen by the browser — honours proxy headers, falls back to Host. */
function requestOrigin(req, config) {
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  if (typeof host !== 'string' || host === '') return null;
  const proto = req.headers['x-forwarded-proto'] ?? config.protocol;
  return `${String(proto).split(',')[0]}://${host.split(',')[0]}`;
}

export function settingsRoutes() {
  return [
    {
      method: 'GET',
      path: '/rest/settings',
      public: true,
      handler: (ctx) => {
        sendData(
          ctx.res,
          buildFrontendSettings(ctx.config, {
            ...buildSettingsContext(ctx.store),
            requestOrigin: requestOrigin(ctx.req, ctx.config),
          }),
        );
      },
    },
  ];
}
