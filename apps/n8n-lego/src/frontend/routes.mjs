/**
 * FRONTEND LEGO — the descriptor route.
 *
 * Ownership: `GET /rest/frontend/bootstrap`, the machine-readable frontend
 * contract (contracts/frontend.contract.md §4). It answers the same JSON the
 * served `index.html` carries in its boot `<meta>` tag, for tooling, for future
 * frontend feature LEGOs and for tests that do not want to parse HTML.
 *
 * Deliberately additive: the pinned editor bundle never calls this path, so the
 * compatibility surface the UI depends on is unchanged. It is authenticated like
 * every other `/rest/*` route — the descriptor describes the instance's UI, it is
 * not a public endpoint.
 */
import { sendData } from '../compat/response.mjs';
import { unsupported } from '../compat/error.mjs';

const FRONTEND_BOOTSTRAP_PATH = '/rest/frontend/bootstrap';

export function frontendRoutes({ frontend }) {
  return [
    {
      method: 'GET',
      path: FRONTEND_BOOTSTRAP_PATH,
      handler: (ctx) => {
        if (!frontend?.available) {
          // Honest answer instead of an empty success: the descriptor is a
          // capability of this instance, and here it is genuinely unimplemented.
          throw unsupported('frontend-bootstrap', 'the frontend descriptor is not available on this instance', {
            owner: 'ui-frontend',
            phase: 'P2.5',
          });
        }
        sendData(ctx.res, frontend.bootPayload);
      },
    },
  ];
}

export const FRONTEND_BOOTSTRAP_ROUTE = FRONTEND_BOOTSTRAP_PATH;
