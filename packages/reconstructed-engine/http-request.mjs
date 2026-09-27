/**
 * `n8n-nodes-base.httpRequest` — minimal credential-consuming node (P6-S05).
 *
 * Behavioural reference: n8n 2.9.4 nodes-base HttpRequest (V2/V3) + the
 * HttpBearerAuth / HttpHeaderAuth credential types. Extracted behaviour:
 *   - authentication vocabulary tokens `httpBearerAuth` and `httpHeaderAuth`
 *     (and `none`), matching the reference genericCredentialType names;
 *   - bearer auth sends `Authorization: Bearer <token>`;
 *   - header auth sends the caller-chosen header (`name` -> `value`);
 *   - a request failure is an explicit error, never an empty success;
 *   - the credential value never appears in output items, warnings or errors.
 *
 * Intentional deviations from the reference (documented, tested):
 *   - expressions (`= {{ ... }}`) are NOT evaluated (registry-wide policy):
 *     literal values are used verbatim and EXPRESSION_NOT_EVALUATED is emitted;
 *   - only the two auth modes above are implemented (the reference also has
 *     basic/digest/query/oauth); other modes are refused explicitly;
 *   - network I/O goes through the injected http transport seam (the registry
 *     stays deterministic; see http-transport.mjs).
 *
 * Chain (REQ-0005 section 6): workflow node -> credentialRef -> SecretRef ->
 * P2.27 Secret Broker -> credential resolution -> this node -> Authorization
 * header -> mock HTTP server. This file consumes the RESOLVED credential from
 * `context.credentials.resolve(...)`; it never touches the broker itself, and
 * there is exactly one credential path.
 */

/** Closed authentication vocabulary (reference tokens). */
export const HTTP_AUTH_MODES = Object.freeze(['none', 'httpBearerAuth', 'httpHeaderAuth']);

/** Closed method vocabulary. */
export const HTTP_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

/** Explicit failure codes. None of them carry secret material in details. */
export const HTTP_REQUEST_ERRORS = Object.freeze({
  INVALID_PARAMETERS: 'HTTP_REQUEST_INVALID_PARAMETERS',
  CREDENTIAL_MISSING: 'HTTP_REQUEST_CREDENTIAL_MISSING',
  CREDENTIAL_UNAUTHORIZED: 'HTTP_REQUEST_CREDENTIAL_UNAUTHORIZED',
  CREDENTIAL_INVALID: 'HTTP_REQUEST_CREDENTIAL_INVALID',
  CREDENTIAL_MALFORMED_REF: 'HTTP_REQUEST_CREDENTIAL_MALFORMED_REF',
  CREDENTIAL_BROKER_FAILURE: 'HTTP_REQUEST_CREDENTIAL_BROKER_FAILURE',
  TARGET_REQUEST_FAILURE: 'HTTP_REQUEST_TARGET_REQUEST_FAILURE',
});

export class HttpRequestNodeError extends Error {
  constructor(code, message, { node = null, details = {} } = {}) {
    super(message);
    this.name = 'HttpRequestNodeError';
    this.code = code;
    this.node = node;
    // Details are declarative (codes/ids/counts) - never secret material.
    this.details = Object.freeze({ ...details });
  }
}

/** Response headers that must never reach output items (sensitive). */
const SENSITIVE_RESPONSE_HEADERS = Object.freeze(['set-cookie', 'www-authenticate', 'proxy-authenticate']);

const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function isLiteralExpression(value) {
  return typeof value === 'string' && value.trimStart().startsWith('=');
}

/**
 * Parameter validation runs BEFORE any credential resolution: a malformed
 * request must not touch the secret broker at all.
 */
export function validateParameters(node) {
  const parameters = node?.parameters ?? {};
  const method = typeof parameters.method === 'string' ? parameters.method.toUpperCase() : 'GET';
  if (!HTTP_METHODS.includes(method)) {
    throw new HttpRequestNodeError(
      HTTP_REQUEST_ERRORS.INVALID_PARAMETERS,
      `method must be one of ${HTTP_METHODS.join(', ')}`,
      { node: node?.name },
    );
  }
  if (isLiteralExpression(parameters.url)) {
    throw new HttpRequestNodeError(
      HTTP_REQUEST_ERRORS.INVALID_PARAMETERS,
      'url expressions are not evaluated by this registry (EXPRESSION policy)',
      { node: node?.name },
    );
  }
  assertUrl(parameters.url);
  const authentication = parameters.authentication ?? 'none';
  if (!HTTP_AUTH_MODES.includes(authentication)) {
    throw new HttpRequestNodeError(
      HTTP_REQUEST_ERRORS.INVALID_PARAMETERS,
      `authentication must be one of ${HTTP_AUTH_MODES.join(', ')}`,
      { node: node?.name, details: { authentication: String(authentication).slice(0, 32) } },
    );
  }
  if (authentication === 'httpHeaderAuth') {
    const headerName = parameters.headerName;
    if (typeof headerName !== 'string' || !HEADER_NAME_RE.test(headerName)) {
      throw new HttpRequestNodeError(
        HTTP_REQUEST_ERRORS.INVALID_PARAMETERS,
        'headerName must be a valid HTTP header name when authentication is httpHeaderAuth',
        { node: node?.name },
      );
    }
  }
  if (parameters.sendBody === true) {
    if (isLiteralExpression(parameters.body)) {
      throw new HttpRequestNodeError(
        HTTP_REQUEST_ERRORS.INVALID_PARAMETERS,
        'body expressions are not evaluated by this registry (EXPRESSION policy)',
        { node: node?.name },
      );
    }
    if (typeof parameters.body !== 'string') {
      throw new HttpRequestNodeError(
        HTTP_REQUEST_ERRORS.INVALID_PARAMETERS,
        'body must be a string when sendBody is true',
        { node: node?.name },
      );
    }
  }
  return { method, authentication };
}

function assertUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new HttpRequestNodeError(HTTP_REQUEST_ERRORS.INVALID_PARAMETERS, 'url must be a non-empty string');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpRequestNodeError(HTTP_REQUEST_ERRORS.INVALID_PARAMETERS, 'url must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpRequestNodeError(HTTP_REQUEST_ERRORS.INVALID_PARAMETERS, 'url scheme must be http or https');
  }
}

/**
 * Build the outbound request from node parameters + resolved credential.
 * Pure and deterministic - this is the contract the Rust implementation must
 * reproduce exactly (fixtures pin it).
 */
export function buildRequest(node, resolvedCredential) {
  const parameters = node?.parameters ?? {};
  const method = typeof parameters.method === 'string' ? parameters.method.toUpperCase() : 'GET';
  if (!HTTP_METHODS.includes(method)) {
    throw new HttpRequestNodeError(
      HTTP_REQUEST_ERRORS.INVALID_PARAMETERS,
      `method must be one of ${HTTP_METHODS.join(', ')}`,
      { node: node?.name },
    );
  }
  if (isLiteralExpression(parameters.url)) {
    throw new HttpRequestNodeError(
      HTTP_REQUEST_ERRORS.INVALID_PARAMETERS,
      'url expressions are not evaluated by this registry (EXPRESSION policy)',
      { node: node?.name },
    );
  }
  assertUrl(parameters.url);

  const authentication = parameters.authentication ?? 'none';
  if (!HTTP_AUTH_MODES.includes(authentication)) {
    throw new HttpRequestNodeError(
      HTTP_REQUEST_ERRORS.INVALID_PARAMETERS,
      `authentication must be one of ${HTTP_AUTH_MODES.join(', ')}`,
      { node: node?.name, details: { authentication: String(authentication).slice(0, 32) } },
    );
  }

  const headers = {};
  if (authentication === 'httpBearerAuth') {
    if (resolvedCredential?.kind !== 'bearer' || typeof resolvedCredential.token !== 'string') {
      throw new HttpRequestNodeError(
        HTTP_REQUEST_ERRORS.CREDENTIAL_INVALID,
        'bearer authentication requires resolved credential of kind "bearer" with a string token',
        { node: node?.name, details: { kind: resolvedCredential?.kind ?? null } },
      );
    }
    headers.Authorization = `Bearer ${resolvedCredential.token}`;
  } else if (authentication === 'httpHeaderAuth') {
    const headerName = parameters.headerName;
    if (typeof headerName !== 'string' || !HEADER_NAME_RE.test(headerName)) {
      throw new HttpRequestNodeError(
        HTTP_REQUEST_ERRORS.INVALID_PARAMETERS,
        'headerName must be a valid HTTP header name when authentication is httpHeaderAuth',
        { node: node?.name },
      );
    }
    if (resolvedCredential?.kind !== 'header' || typeof resolvedCredential.token !== 'string') {
      throw new HttpRequestNodeError(
        HTTP_REQUEST_ERRORS.CREDENTIAL_INVALID,
        'header authentication requires resolved credential of kind "header" with a string token',
        { node: node?.name, details: { kind: resolvedCredential?.kind ?? null } },
      );
    }
    headers[headerName] = resolvedCredential.token;
  }

  let body = null;
  if (parameters.sendBody === true) {
    if (isLiteralExpression(parameters.body)) {
      throw new HttpRequestNodeError(
        HTTP_REQUEST_ERRORS.INVALID_PARAMETERS,
        'body expressions are not evaluated by this registry (EXPRESSION policy)',
        { node: node?.name },
      );
    }
    if (typeof parameters.body !== 'string') {
      throw new HttpRequestNodeError(
        HTTP_REQUEST_ERRORS.INVALID_PARAMETERS,
        'body must be a string when sendBody is true',
        { node: node?.name },
      );
    }
    body = parameters.body;
  }

  return { method, url: parameters.url, headers, body };
}

/**
 * Resolve the credential for this node through the ONE canonical path
 * (`context.credentials.resolve`). Errors map to the closed failure codes
 * without leaking material.
 */
function resolveCredentialOrThrow(node, context, authentication) {
  const credentialRef = node?.credentialRef ?? null;
  if (authentication === 'none') {
    if (credentialRef !== null && credentialRef !== undefined) {
      throw new HttpRequestNodeError(
        HTTP_REQUEST_ERRORS.INVALID_PARAMETERS,
        'credentialRef present while authentication is "none" (wiring error)',
        { node: node?.name },
      );
    }
    return null;
  }
  if (credentialRef === null || credentialRef === undefined || credentialRef === '') {
    throw new HttpRequestNodeError(
      HTTP_REQUEST_ERRORS.CREDENTIAL_MISSING,
      'authentication requires a credentialRef on the node',
      { node: node?.name },
    );
  }
  const resolver = context?.credentials?.resolve;
  if (typeof resolver !== 'function') {
    throw new HttpRequestNodeError(
      HTTP_REQUEST_ERRORS.CREDENTIAL_MISSING,
      'no credential resolver is wired into the execution context',
      { node: node?.name, details: { credentialRef: String(credentialRef).slice(0, 64) } },
    );
  }
  let resolved;
  try {
    resolved = resolver({ credentialRef, node });
  } catch (error) {
    const code = error?.code ?? 'BROKER_FAILURE';
    // CredentialResolutionError codes translate to the node's closed codes.
    const RESOLUTION_TO_NODE = {
      CREDENTIAL_UNAUTHORIZED: HTTP_REQUEST_ERRORS.CREDENTIAL_UNAUTHORIZED,
      CREDENTIAL_INVALID: HTTP_REQUEST_ERRORS.CREDENTIAL_INVALID,
      CREDENTIAL_MALFORMED_REF: HTTP_REQUEST_ERRORS.CREDENTIAL_MALFORMED_REF,
      CREDENTIAL_BROKER_FAILURE: HTTP_REQUEST_ERRORS.CREDENTIAL_BROKER_FAILURE,
    };
    if (RESOLUTION_TO_NODE[code]) {
      throw new HttpRequestNodeError(RESOLUTION_TO_NODE[code], String(error?.message ?? 'credential resolution failed').slice(0, 120), {
        node: node?.name,
        details: { reason: String(error?.reason ?? code).slice(0, 64) },
      });
    }
    if (code === 'ref.malformed') {
      throw new HttpRequestNodeError(HTTP_REQUEST_ERRORS.CREDENTIAL_MALFORMED_REF, 'credential reference is malformed', {
        node: node?.name,
        details: { reason: code },
      });
    }
    if (code === 'ref.not_authorized' || code === 'ref.tenant_mismatch' || code === 'ref.capability_mismatch'
      || code === 'ref.audience_mismatch' || code === 'ref.version_mismatch' || code === 'ref.credential_mismatch'
      || code === 'ref.request_mismatch') {
      throw new HttpRequestNodeError(HTTP_REQUEST_ERRORS.CREDENTIAL_UNAUTHORIZED, 'credential reference was refused', {
        node: node?.name,
        details: { reason: code },
      });
    }
    if (code === 'CREDENTIAL_MISSING') {
      throw new HttpRequestNodeError(HTTP_REQUEST_ERRORS.CREDENTIAL_MISSING, 'credential could not be resolved', {
        node: node?.name,
        details: { reason: String(error?.message ?? '').slice(0, 64) },
      });
    }
    // ref.no_material | ref.already_redeemed | anything unexpected = broker failure
    throw new HttpRequestNodeError(HTTP_REQUEST_ERRORS.CREDENTIAL_BROKER_FAILURE, 'secret broker failed to release material', {
      node: node?.name,
      details: { reason: String(code).slice(0, 64) },
    });
  }
  if (resolved === null || resolved === undefined || typeof resolved.token !== 'string' || resolved.token === '') {
    throw new HttpRequestNodeError(
      HTTP_REQUEST_ERRORS.CREDENTIAL_INVALID,
      'credential resolution returned no usable material',
      { node: node?.name, details: { kind: resolved?.kind ?? null } },
    );
  }
  return resolved;
}

/** Shape the transport response into the output item (redaction applied). */
export function shapeResponse(request, response) {
  const safeHeaders = {};
  for (const [key, value] of Object.entries(response.headers ?? {})) {
    if (SENSITIVE_RESPONSE_HEADERS.includes(key.toLowerCase())) continue;
    safeHeaders[key] = value;
  }
  const contentType = String(response.headers?.['content-type'] ?? response.headers?.['Content-Type'] ?? '');
  let body = response.body;
  if (contentType.includes('application/json')) {
    try {
      body = JSON.parse(response.body);
    } catch {
      // Non-JSON body under a json content type stays a string (explicit, not guessed).
      body = response.body;
    }
  }
  return {
    statusCode: response.status,
    headers: safeHeaders,
    body,
    request: { method: request.method, url: request.url },
  };
}

/**
 * The registered handler: `n8n-nodes-base.httpRequest`.
 * One request per input item (literal parameters; expressions are refused).
 */
export function httpRequestHandler(node, items, context) {
  const runForItem = async (item) => {
    validateParameters(node);
    const parameters = node?.parameters ?? {};
    const authentication = parameters.authentication ?? 'none';
    const resolved = resolveCredentialOrThrow(node, context, authentication);
    const request = buildRequest(node, resolved);
    const transport = context?.httpTransport;
    if (!transport || typeof transport.request !== 'function') {
      throw new HttpRequestNodeError(
        HTTP_REQUEST_ERRORS.TARGET_REQUEST_FAILURE,
        'no http transport is wired into the execution context (registry stays deterministic)',
        { node: node?.name, details: { url: request.url.slice(0, 64) } },
      );
    }
    let response;
    try {
      response = await transport.request({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body,
      });
    } catch (error) {
      if (error instanceof HttpRequestNodeError) throw error;
      throw new HttpRequestNodeError(
        HTTP_REQUEST_ERRORS.TARGET_REQUEST_FAILURE,
        `target request failed: ${String(error?.message ?? error).slice(0, 120)}`,
        { node: node?.name, details: { kind: error?.kind ?? 'network', url: request.url.slice(0, 64) } },
      );
    }
    return { json: shapeResponse(request, response), pairedItem: item?.pairedItem ?? undefined };
  };
  return Promise.all(items.map(runForItem));
}
