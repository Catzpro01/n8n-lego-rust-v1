/**
 * Compatibility layer — normalized responses.
 *
 * Part of the n8n compatibility boundary (`src/compat/`): the JSON envelope the
 * editor reads, independent of which domain module produced the payload.
 *
 * n8n's REST conventions are preserved:
 *   success -> `{ data: ... }`            (see ResponseHelper)
 *   failure -> `{ message, code?, meta? }` with the matching status code
 */
import { HttpError, badRequest } from './error.mjs';

export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/**
 * The editor reads almost every `/rest` response through `makeRestApiRequest`,
 * which does `return response.data` with the comment "All cli rest api endpoints
 * return data wrapped in `data` key" — so the wrapper is part of the contract.
 */
export function sendData(res, data, { status = 200, headers = {} } = {}) {
  sendJson(res, status, { data }, headers);
}

/**
 * Bare payload, for the handful of endpoints the editor reads with
 * `getFullApiResponse` (`GET /workflows`, `POST /workflows/with-node-types`, …).
 * Those return `{ count, data }` themselves and must NOT be wrapped again.
 */
export function sendBare(res, payload, { status = 200, headers = {} } = {}) {
  sendJson(res, status, payload, headers);
}

export function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const body = {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof HttpError && error.code ? { code: error.code } : {}),
    ...(error instanceof HttpError && error.meta ? { meta: error.meta } : {}),
  };
  sendJson(res, status, body);
}

export async function readBody(req, { limit }) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  const contentType = String(req.headers['content-type'] ?? '');
  if (contentType.includes('application/json') || raw.trimStart().startsWith('{') || raw.trimStart().startsWith('[')) {
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw badRequest(`Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return raw;
}
