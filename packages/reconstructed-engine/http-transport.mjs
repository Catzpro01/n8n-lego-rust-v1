/**
 * HTTP transport seam for the httpRequest node (P6-S05).
 *
 * The node-registry is deterministic by design (no network inside the
 * registry). Network I/O is therefore a CONTRACT, injected at composition:
 *
 *   request({ method, url, headers, body })
 *     -> Promise<{ status: number, headers: object, body: string }>
 *     -> throws TransportError on connection/timeout failure
 *
 * This contract is deliberately language-neutral (JSON-shaped request and
 * response, plain string body) so the future Rust implementation can satisfy
 * the same fixtures (REQ-0005 section 16: JS reference <-> Rust parity).
 *
 * Reference behaviour: n8n 2.9.4 nodes-base HttpRequest (V2/V3) executes the
 * request through its httpHelper; failures surface as errors, never as empty
 * success.
 */

export class TransportError extends Error {
  constructor(message, { cause = null, kind = 'network' } = {}) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind; // 'network' | 'timeout'
    this.cause = cause;
  }
}

/** Validate a transport response shape. Fail-closed: unknown shapes are refused. */
export function normalizeTransportResponse(response) {
  if (response === null || typeof response !== 'object') {
    throw new TypeError('http transport must resolve to a response object');
  }
  const { status, headers, body } = response;
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new TypeError('http transport response.status must be an integer in [100, 599]');
  }
  if (headers !== undefined && (headers === null || typeof headers !== 'object' || Array.isArray(headers))) {
    throw new TypeError('http transport response.headers must be a plain object when present');
  }
  if (body !== undefined && typeof body !== 'string') {
    throw new TypeError('http transport response.body must be a string when present');
  }
  return { status, headers: { ...(headers ?? {}) }, body: body ?? '' };
}

/**
 * The real transport: performs an actual HTTP request. Used by integration
 * tests against a mock endpoint and by real runs. Never called by unit tests.
 */
export function createFetchTransport({ fetchImpl = globalThis.fetch, timeoutMsDefault = 5000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createFetchTransport requires a fetch implementation');
  return Object.freeze({
    async request({ method, url, headers = {}, body = null, timeoutMs = timeoutMsDefault }) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller && Number.isInteger(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;
      try {
        const response = await fetchImpl(url, {
          method,
          headers: { ...headers },
          body: body ?? undefined,
          ...(controller ? { signal: controller.signal } : {}),
        });
        const responseBody = await response.text();
        const responseHeaders = {};
        for (const [key, value] of response.headers.entries()) responseHeaders[key] = value;
        return { status: response.status, headers: responseHeaders, body: responseBody };
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new TransportError(`request to ${url} timed out after ${timeoutMs}ms`, { cause: error, kind: 'timeout' });
        }
        throw new TransportError(`request to ${url} failed: ${error?.message ?? 'unknown transport error'}`, {
          cause: error,
          kind: 'network',
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  });
}

/**
 * Deterministic transport for tests and fixtures: a scripted response (or a
 * function of the request), and it RECORDS every request so a test can assert
 * what was sent (including the Authorization header) without any real network.
 */
export function createMockTransport(script) {
  const calls = [];
  const transport = {
    calls,
    async request(req) {
      calls.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: req.body ?? null });
      if (typeof script === 'function') return normalizeTransportResponse(await script(req));
      if (script instanceof Error) throw script;
      return normalizeTransportResponse(script ?? { status: 200, headers: {}, body: '' });
    },
  };
  return Object.freeze(transport);
}
