/**
 * Compatibility layer — normalized errors.
 *
 * Part of the n8n compatibility boundary (`src/compat/`): every REST answer the
 * editor receives passes through these shapes, no matter which domain module
 * produced it.
 *
 * n8n's REST error convention is preserved (`ResponseHelper.sendErrorResponse`):
 *   failure -> `{ message, code?, meta? }` with the matching status code
 *
 * Status-code semantics for this instance:
 *   2xx  the feature exists and answered (an empty collection is a 200, never a stub)
 *   400  the request itself is wrong
 *   401  not authenticated
 *   403  authenticated but not allowed
 *   404  the addressed entity does not exist
 *   501  the capability is known but not implemented on this instance
 *        (upstream precedent: cli/src/errors/response-errors/not-implemented.error.ts)
 *   500  an unexpected server failure
 */

export class HttpError extends Error {
  constructor(status, message, { code = undefined, meta = undefined } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.meta = meta;
  }
}

export const unauthorized = () => new HttpError(401, 'Unauthorized');
export const forbidden = (message = 'Forbidden') => new HttpError(403, message);
export const notFound = (message = 'Not found') => new HttpError(404, message);
export const badRequest = (message, meta) => new HttpError(400, message, { meta });

/**
 * The capability is recognized (the real n8n API has it) but this instance does
 * not implement it yet. Distinct from 404 ("no such thing") and 500 ("broke"):
 * the editor gets an honest, distinguishable answer instead of the old fake
 * `200 {"data":null}` success.
 */
export const unsupported = (feature, message, meta = {}) =>
  new HttpError(501, message ?? `${feature} is not implemented on this n8n-lego instance`, {
    code: 'unsupported',
    meta: { feature, ...meta },
  });
