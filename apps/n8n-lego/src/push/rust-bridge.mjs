/**
 * Rust Realtime Bridge (Milestone R14, R15)
 *
 * Connects HTTP Upgrade requests (/rest/push and /push) from n8n-lego (port 5677)
 * directly to the Rust Axum realtime engine (port 5678) with transparent fallback
 * to the Node.js push server when Rust engine is unreachable.
 */

import net from 'node:net';
import http from 'node:http';

const DEFAULT_RUST_PORT = 5678;
const DEFAULT_RUST_HOST = '127.0.0.1';
const DEFAULT_CONNECT_TIMEOUT_MS = 2000;

/**
 * Checks whether the Rust realtime engine is available and accepting connections.
 *
 * @param {Object|number} [options] - Configuration options or port number
 * @param {string} [options.host] - Target host (defaults to N8N_RUST_HOST or 127.0.0.1)
 * @param {number} [options.port] - Target port (defaults to N8N_RUST_PORT or 5678)
 * @param {number} [options.timeoutMs] - Probe timeout in ms (default: 1000)
 * @returns {Promise<boolean>} True if Rust port accepts TCP connection
 */
export async function isRustRealtimeAvailable(options = {}) {
  let host = process.env.N8N_RUST_HOST || DEFAULT_RUST_HOST;
  let port = parseInt(process.env.N8N_RUST_PORT || String(DEFAULT_RUST_PORT), 10);
  let timeoutMs = 1000;

  if (typeof options === 'number') {
    port = options;
  } else if (typeof options === 'object' && options !== null) {
    if (options.host) host = options.host;
    if (options.port) port = Number(options.port);
    if (options.timeoutMs) timeoutMs = Number(options.timeoutMs);
  }

  // Normalize localhost to 127.0.0.1 for consistent IPv4 handshake on Windows
  if (host === 'localhost') {
    host = '127.0.0.1';
  }

  return new Promise((resolve) => {
    let finished = false;
    const socket = net.createConnection({ host, port });

    const finish = (result) => {
      if (!finished) {
        finished = true;
        socket.removeAllListeners();
        socket.destroy();
        resolve(result);
      }
    };

    socket.setTimeout(timeoutMs, () => finish(false));
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
  });
}

/**
 * Creates the Rust Push Bridge instance compatible with n8n-lego server.mjs.
 *
 * @param {Object} params
 * @param {Object} [params.config] - Application configuration
 * @param {Object} [params.logger] - Logger instance
 * @param {Object} [params.fallbackPush] - Node.js push server fallback
 * @returns {Object} Bridge interface with handleUpgrade, broadcast, closeAll, etc.
 */
export function createRustPushBridge({ config = {}, logger, fallbackPush } = {}) {
  const log = {
    info: (msg, meta) => logger?.info?.(`[RustPushBridge] ${msg}`, meta),
    warn: (msg, meta) => logger?.warn?.(`[RustPushBridge] ${msg}`, meta),
    error: (msg, meta) => logger?.error?.(`[RustPushBridge] ${msg}`, meta),
    debug: (msg, meta) => logger?.debug?.(`[RustPushBridge] ${msg}`, meta),
  };

  const rawHost = config?.rustHost || process.env.N8N_RUST_HOST || DEFAULT_RUST_HOST;
  const rustHost = rawHost === 'localhost' ? '127.0.0.1' : rawHost;
  const rustPort = parseInt(String(config?.rustPort || process.env.N8N_RUST_PORT || DEFAULT_RUST_PORT), 10);
  const connectTimeoutMs = parseInt(String(config?.rustConnectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS), 10);

  const basePath = config?.basePath ?? '/';
  const restEndpoint = config?.restEndpoint ?? 'rest';
  const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`;
  const normalizedRest = restEndpoint.startsWith('/') ? restEndpoint.slice(1) : restEndpoint;
  const canonicalRestPush = `${normalizedBase}${normalizedRest}/push`.replace(/\/+/g, '/');
  const canonicalPush = `${normalizedBase}push`.replace(/\/+/g, '/');

  // Paths supported for HTTP Upgrade
  const paths = new Set([
    canonicalRestPush,
    canonicalPush,
    '/rest/push',
    '/push',
    ...(fallbackPush?.paths ? Array.from(fallbackPush.paths) : []),
  ]);

  // Set of active connection pairs: { clientSocket, rustSocket }
  const activeConnections = new Set();

  /**
   * Serializes the original HTTP Upgrade request to send over TCP to the Rust server.
   */
  function buildRequestHeaderPayload(req) {
    let targetUrl = req.url || '/rest/push';
    const pushRef = req.pushRef || (req.query && req.query.pushRef);
    if (pushRef && !targetUrl.includes('pushRef=')) {
      const separator = targetUrl.includes('?') ? '&' : '?';
      targetUrl = `${targetUrl}${separator}pushRef=${encodeURIComponent(pushRef)}`;
    }

    const method = req.method || 'GET';
    const lines = [`${method} ${targetUrl} HTTP/1.1`];
    const seenHeaders = new Set();

    if (Array.isArray(req.rawHeaders) && req.rawHeaders.length > 0) {
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        const val = req.rawHeaders[i + 1];
        lines.push(`${name}: ${val}`);
        seenHeaders.add(name.toLowerCase());
      }
    } else if (req.headers && typeof req.headers === 'object') {
      for (const [key, val] of Object.entries(req.headers)) {
        if (val === undefined || val === null) continue;
        const formattedKey = formatHeaderName(key);
        if (Array.isArray(val)) {
          for (const item of val) {
            lines.push(`${formattedKey}: ${item}`);
          }
        } else {
          lines.push(`${formattedKey}: ${val}`);
        }
        seenHeaders.add(key.toLowerCase());
      }
    }

    // Ensure essential headers for WebSocket handshake if omitted
    if (!seenHeaders.has('upgrade')) {
      lines.push('Upgrade: websocket');
    }
    if (!seenHeaders.has('connection')) {
      lines.push('Connection: Upgrade');
    }
    if (!seenHeaders.has('host') && req.headers?.host) {
      lines.push(`Host: ${req.headers.host}`);
    }
    if (!seenHeaders.has('origin') && req.headers?.origin) {
      lines.push(`Origin: ${req.headers.origin}`);
    }
    if (!seenHeaders.has('cookie') && req.headers?.cookie) {
      lines.push(`Cookie: ${req.headers.cookie}`);
    }

    return lines.join('\r\n') + '\r\n\r\n';
  }

  function formatHeaderName(name) {
    const map = {
      'upgrade': 'Upgrade',
      'connection': 'Connection',
      'host': 'Host',
      'origin': 'Origin',
      'cookie': 'Cookie',
      'sec-websocket-key': 'Sec-WebSocket-Key',
      'sec-websocket-version': 'Sec-WebSocket-Version',
      'sec-websocket-extensions': 'Sec-WebSocket-Extensions',
      'sec-websocket-protocol': 'Sec-WebSocket-Protocol',
    };
    return map[name.toLowerCase()] || name;
  }

  /**
   * Handles HTTP Upgrade requests by connecting directly to the Rust Axum server
   * and piping the duplex byte stream. Falls back to fallbackPush if Rust is unreachable.
   */
  function handleUpgrade(req, socket, head) {
    if (!socket || socket.destroyed) return;

    let isConnected = false;
    let isFailed = false;
    const earlyChunks = [];

    const onEarlyData = (chunk) => {
      earlyChunks.push(chunk);
    };
    socket.on('data', onEarlyData);

    let rustSocket = null;
    let connectTimer = null;

    const triggerFallback = (err) => {
      if (isFailed || isConnected) return;
      isFailed = true;

      if (connectTimer) clearTimeout(connectTimer);
      if (rustSocket) {
        rustSocket.removeAllListeners();
        rustSocket.destroy();
      }

      socket.removeListener('data', onEarlyData);
      socket.removeListener('error', onClientErrorBeforeConnect);
      socket.removeListener('close', onClientCloseBeforeConnect);

      if (earlyChunks.length > 0) {
        socket.unshift(Buffer.concat(earlyChunks));
      }

      log.warn(`Rust realtime bridge connection to ${rustHost}:${rustPort} failed, falling back to Node push`, {
        error: err?.message || String(err),
      });

      if (fallbackPush && typeof fallbackPush.handleUpgrade === 'function') {
        fallbackPush.handleUpgrade(req, socket, head);
      } else {
        socket.destroy();
      }
    };

    const onClientErrorBeforeConnect = (err) => {
      log.debug('Client socket error before bridge connection established', { error: err.message });
      if (connectTimer) clearTimeout(connectTimer);
      if (rustSocket) {
        rustSocket.removeAllListeners();
        rustSocket.destroy();
      }
    };

    const onClientCloseBeforeConnect = () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (rustSocket) {
        rustSocket.removeAllListeners();
        rustSocket.destroy();
      }
    };

    socket.once('error', onClientErrorBeforeConnect);
    socket.once('close', onClientCloseBeforeConnect);

    try {
      rustSocket = net.connect({ host: rustHost, port: rustPort });
    } catch (err) {
      triggerFallback(err);
      return;
    }

    connectTimer = setTimeout(() => {
      triggerFallback(new Error(`Connection to Rust realtime at ${rustHost}:${rustPort} timed out`));
    }, connectTimeoutMs);

    rustSocket.once('error', (err) => {
      triggerFallback(err);
    });

    rustSocket.once('connect', () => {
      if (isFailed) {
        rustSocket.destroy();
        return;
      }
      isConnected = true;
      if (connectTimer) clearTimeout(connectTimer);
      rustSocket.setTimeout(0);

      socket.removeListener('data', onEarlyData);
      socket.removeListener('error', onClientErrorBeforeConnect);
      socket.removeListener('close', onClientCloseBeforeConnect);

      if (socket.destroyed) {
        rustSocket.destroy();
        return;
      }

      const connectionPair = { clientSocket: socket, rustSocket };
      activeConnections.add(connectionPair);

      const cleanup = () => {
        activeConnections.delete(connectionPair);
        try { socket.destroy(); } catch (_) {}
        try { rustSocket.destroy(); } catch (_) {}
      };

      socket.on('error', (err) => {
        log.debug('Client socket error on bridged push connection', { error: err.message });
        cleanup();
      });
      rustSocket.on('error', (err) => {
        log.debug('Rust socket error on bridged push connection', { error: err.message });
        cleanup();
      });
      socket.on('close', cleanup);
      rustSocket.on('close', cleanup);

      // 1. Send HTTP Upgrade request line + headers to Rust Axum server
      const headerPayload = buildRequestHeaderPayload(req);
      rustSocket.write(headerPayload);

      // 2. Forward any head buffer passed by node:http upgrade event
      if (head && head.length > 0) {
        rustSocket.write(head);
      }

      // 3. Forward any chunks buffered while awaiting connect
      if (earlyChunks.length > 0) {
        for (const chunk of earlyChunks) {
          rustSocket.write(chunk);
        }
      }

      // 4. Byte-level duplex piping (socket.pipe(rustSocket).pipe(socket))
      socket.pipe(rustSocket).pipe(socket);

      log.debug('Piped duplex push stream to Rust engine', {
        activeBridges: activeConnections.size,
        url: req.url,
      });
    });
  }

  /**
   * Broadcasts an event payload to the Rust internal broadcast endpoint if active,
   * or distributes it via fallbackPush.
   *
   * @param {Object|string} payload - The event payload to broadcast
   */
  function broadcast(payload) {
    const hasFallbackClients = (fallbackPush?.clientCount?.() || 0) > 0;
    if (hasFallbackClients && typeof fallbackPush?.broadcast === 'function') {
      fallbackPush.broadcast(payload);
    }

    sendToRustBroadcast(payload)
      .then((success) => {
        if (!success && !hasFallbackClients && typeof fallbackPush?.broadcast === 'function') {
          fallbackPush.broadcast(payload);
        }
      })
      .catch((err) => {
        log.debug('Rust internal broadcast endpoint unavailable, delegating to fallbackPush', {
          error: err?.message,
        });
        if (!hasFallbackClients && typeof fallbackPush?.broadcast === 'function') {
          fallbackPush.broadcast(payload);
        }
      });
  }

  /**
   * Sends payload to Rust internal broadcast endpoint via HTTP POST.
   */
  function sendToRustBroadcast(payload) {
    return new Promise((resolve, reject) => {
      try {
        const broadcastUrl = config?.rustBroadcastUrl ||
          process.env.N8N_RUST_BROADCAST_URL ||
          `http://${rustHost}:${rustPort}/api/realtime/broadcast`;

        const parsed = new URL(broadcastUrl);
        const body = typeof payload === 'string' ? payload : JSON.stringify(payload);

        const clientReq = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port || rustPort,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
            timeout: 1500,
          },
          (res) => {
            res.resume();
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(true);
            } else {
              resolve(false);
            }
          }
        );

        clientReq.on('timeout', () => {
          clientReq.destroy(new Error('Rust broadcast request timeout'));
        });

        clientReq.on('error', (err) => {
          reject(err);
        });

        clientReq.write(body);
        clientReq.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Closes all active bridged connections and invokes fallbackPush closeAll.
   */
  function closeAll() {
    log.debug('Closing all bridged push connections', { count: activeConnections.size });
    for (const conn of activeConnections) {
      try { conn.clientSocket?.destroy(); } catch (_) {}
      try { conn.rustSocket?.destroy(); } catch (_) {}
    }
    activeConnections.clear();

    if (fallbackPush && typeof fallbackPush.closeAll === 'function') {
      try { fallbackPush.closeAll(); } catch (_) {}
    }
  }

  return {
    paths,
    path: '/rest/push',
    handleUpgrade,
    broadcast,
    closeAll,
    clientCount: () => activeConnections.size + (fallbackPush?.clientCount?.() || 0),
    onMessage: (listener) => fallbackPush?.onMessage?.(listener),
    isRustRealtimeAvailable: () => isRustRealtimeAvailable({ host: rustHost, port: rustPort }),
    _activeBridgesCount: () => activeConnections.size,
  };
}

export default createRustPushBridge;
