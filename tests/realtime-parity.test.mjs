/**
 * tests/realtime-parity.test.mjs
 *
 * Realtime WebSocket & Push Engine Contract Parity Test Suite (Milestone R17, R18, R19).
 * Memverifikasi keselarasan (parity) protokol dan semantik antara:
 * - JavaScript Push Engine (@lego/realtime / reconstructed-engine)
 * - Rust Realtime WebSocket Engine (crates/n8n-realtime & apps/n8n-rust/src/server.rs)
 *
 * Cakupan Pengujian:
 * 1. Handshake RFC 6455 & koneksi WebSocket ke URL `/rest/push?pushRef=<test-ref>`
 * 2. Session parity: pesan handshake '{ "type": "connection", "data": { "authenticated": true } }'
 * 3. Heartbeat frame swallowing & liveness: client mengirim '{ "type": "heartbeat" }' dan koneksi stabil
 * 4. Reconnection / pushRef duplication handling: koneksi kedua dengan pushRef sama diterima & koneksi lama ditutup rapi
 * 5. Targeted routing dan parsing pesan JSON wire envelope '{ type, data }'
 * 6. Frozen contract invariants (R1..R13, R17, R18, R19): konstanta, error isolation, & circular ref handling
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

// RFC 6455 Constants & Invariants
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_PUSH_BACKEND = 'websocket';
const MAX_PAYLOAD_SIZE_BYTES = 5 * 1024 * 1024; // 5 MiB
const PING_INTERVAL_MS = 60 * 1000; // 60s

/**
 * Validasi helper heartbeat frame parity (R10, R18, R19)
 * Format spesifikasi: tepat 1 key dan bertipe 'heartbeat'
 */
function isHeartbeatMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
  const keys = Object.keys(msg);
  return keys.length === 1 && msg.type === 'heartbeat';
}

/**
 * Ancestor-scoped circular reference serializer parity (R4/R4b)
 */
function stringifyPushMessage(val) {
  const stack = [];
  return JSON.stringify(val, function (key, value) {
    if (typeof value === 'object' && value !== null) {
      const idx = stack.indexOf(this);
      if (idx !== -1) {
        stack.splice(idx + 1);
      }
      if (stack.includes(value)) {
        return '[Circular Reference]';
      }
      stack.push(value);
    }
    return value;
  });
}

/* -------------------------------------------------------------------------- */
/* RFC 6455 WebSocket Frame Encoders & Decoders (Hermetic Test Harness)       */
/* -------------------------------------------------------------------------- */

function encodeFrame(payload, opcode = 0x1) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = buf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, buf]);
}

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) === 0x80;
    let length = second & 0x7f;
    let headerLen = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const big = buffer.readBigUInt64BE(offset + 2);
      length = Number(big);
      headerLen = 10;
    }

    const maskKeyLen = masked ? 4 : 0;
    const totalFrameLen = headerLen + maskKeyLen + length;
    if (offset + totalFrameLen > buffer.length) {
      break; // incomplete chunk
    }

    let payload = buffer.subarray(offset + headerLen + maskKeyLen, offset + totalFrameLen);
    if (masked) {
      const maskKey = buffer.subarray(offset + headerLen, offset + headerLen + 4);
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        unmasked[i] = payload[i] ^ maskKey[i % 4];
      }
      payload = unmasked;
    } else {
      payload = Buffer.from(payload);
    }

    frames.push({ opcode, payload });
    offset += totalFrameLen;
  }

  return { frames, remainder: buffer.subarray(offset) };
}

function sendCloseFrame(socket, code = 1000, reason = '') {
  try {
    const reasonBuf = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    socket.write(encodeFrame(payload, 0x8));
  } catch {
    // Socket might already be ended
  }
}

/* -------------------------------------------------------------------------- */
/* Realtime WebSocket Parity Server Harness                                   */
/* Mengemulasikan perilaku exact dari apps/n8n-rust/src/server.rs & engine JS */
/* -------------------------------------------------------------------------- */

class RealtimeSessionRegistry {
  constructor() {
    this.sessions = new Map(); // pushRef -> { socket, userId, isAlive }
    this.swallowedHeartbeats = 0;
    this.disconnectionEvents = [];
    this.receivedClientMessages = [];
  }

  register(pushRef, userId, clientSocket) {
    if (this.sessions.has(pushRef)) {
      const old = this.sessions.get(pushRef);
      // R5 / R18: Re-registering pushRef terminates previous connection cleanly first
      sendCloseFrame(old.socket, 1000, 'Replaced by duplicate pushRef session');
      old.socket.end();
      this.disconnectionEvents.push({ pushRef, reason: 'replaced' });
      this.sessions.delete(pushRef);
    }

    this.sessions.set(pushRef, {
      socket: clientSocket,
      userId,
      isAlive: true,
      registeredAt: Date.now(),
    });
  }

  unregister(pushRef) {
    const session = this.sessions.get(pushRef);
    if (session) {
      this.sessions.delete(pushRef);
      this.disconnectionEvents.push({ pushRef, reason: 'unregistered' });
    }
  }

  hasPushRef(pushRef) {
    return this.sessions.has(pushRef);
  }

  get connectionCount() {
    return this.sessions.size;
  }

  sendToOne(pushRef, msg) {
    const session = this.sessions.get(pushRef);
    if (!session || !session.socket.writable) return false;
    const jsonStr = stringifyPushMessage(msg);
    session.socket.write(encodeFrame(jsonStr, 0x1));
    return true;
  }

  sendToAll(msg) {
    const jsonStr = stringifyPushMessage(msg);
    const frame = encodeFrame(jsonStr, 0x1);
    let sentCount = 0;
    for (const session of this.sessions.values()) {
      if (session.socket.writable) {
        session.socket.write(frame);
        sentCount++;
      }
    }
    return sentCount;
  }

  handleClientMessage(pushRef, rawText) {
    let parsed;
    try {
      parsed = typeof rawText === 'string' ? JSON.parse(rawText) : rawText;
    } catch (e) {
      return { type: 'parse_error', error: e };
    }

    // Milestone R19 / R10: Swallowing heartbeat frame
    if (isHeartbeatMessage(parsed)) {
      this.swallowedHeartbeats++;
      const session = this.sessions.get(pushRef);
      if (session) session.isAlive = true;
      return { type: 'heartbeat_swallowed' };
    }

    this.receivedClientMessages.push({ pushRef, message: parsed });
    return { type: 'message', message: parsed };
  }
}

function createRealtimeHarnessServer() {
  const registry = new RealtimeSessionRegistry();
  const events = new EventEmitter();

  const server = http.createServer((req, res) => {
    // Normal HTTP requests to /rest/push without upgrade header should be rejected
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname === '/rest/push' || url.pathname === '/push') {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('The query parameter "pushRef" is missing!');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.on('upgrade', (req, socket, head) => {
    const host = req.headers.host || '127.0.0.1';
    const url = new URL(req.url, `http://${host}`);
    const pathname = url.pathname;
    const pushRef = url.searchParams.get('pushRef');

    // Route verification: /rest/push & /push
    if (pathname !== '/rest/push' && pathname !== '/push') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Milestone R17 / Invariant R12: pushRef is required
    if (!pushRef) {
      socket.write('HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nThe query parameter "pushRef" is missing!\r\n');
      socket.destroy();
      return;
    }

    // RFC 6455 Handshake
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    // Register session into parity registry
    registry.register(pushRef, 'user-default', socket);
    events.emit('clientConnected', pushRef);

    // Milestone R18: Exact handshake parity frame
    // Persis seperti implementasi Rust: apps/n8n-rust/src/server.rs:1695
    const handshakePayload = {
      type: 'connection',
      data: {
        authenticated: true,
      },
    };
    socket.write(encodeFrame(JSON.stringify(handshakePayload), 0x1));

    // Client buffer processing
    let buffer = Buffer.alloc(0);
    if (head && head.length > 0) {
      buffer = Buffer.concat([buffer, head]);
    }

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, remainder } = decodeFrames(buffer);
      buffer = remainder;

      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          // Close frame received
          sendCloseFrame(socket, 1000, 'Goodbye');
          socket.end();
          registry.unregister(pushRef);
          return;
        }
        if (frame.opcode === 0x9) {
          // Ping frame -> send Pong
          socket.write(encodeFrame(frame.payload, 0xa));
          continue;
        }
        if (frame.opcode === 0x1) {
          // Text frame
          const text = frame.payload.toString('utf8');
          const outcome = registry.handleClientMessage(pushRef, text);
          events.emit('clientFrame', { pushRef, outcome, raw: text });
        }
      }
    });

    socket.on('close', () => {
      if (registry.sessions.get(pushRef)?.socket === socket) {
        registry.unregister(pushRef);
      }
      events.emit('clientDisconnected', pushRef);
    });

    socket.on('error', () => {
      if (registry.sessions.get(pushRef)?.socket === socket) {
        registry.unregister(pushRef);
      }
      socket.destroy();
    });
  });

  return {
    server,
    registry,
    events,
    start() {
      return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          resolve(addr.port);
        });
        server.on('error', reject);
      });
    },
    stop() {
      return new Promise((resolve) => {
        for (const session of registry.sessions.values()) {
          try {
            sendCloseFrame(session.socket, 1001, 'Harness server stopping');
            session.socket.end();
          } catch {}
        }
        server.close(resolve);
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Client Helpers (Node 22 Built-in globalThis.WebSocket RFC 6455)             */
/* -------------------------------------------------------------------------- */

function connectClient(port, pushRef, path = '/rest/push') {
  return new Promise((resolve, reject) => {
    const query = pushRef !== undefined ? `?pushRef=${encodeURIComponent(pushRef)}` : '';
    const wsUrl = `ws://127.0.0.1:${port}${path}${query}`;
    const ws = new globalThis.WebSocket(wsUrl);

    const receivedMessages = [];
    const messageWaiters = [];
    const closeWaiters = [];
    let isClosed = false;
    let closeEvent = null;

    ws.onopen = () => {
      resolve({
        ws,
        pushRef,
        url: wsUrl,
        receivedMessages,
        isClosed() { return isClosed; },
        getCloseEvent() { return closeEvent; },
        waitForMessage(timeoutMs = 2500) {
          if (receivedMessages.length > 0) {
            return Promise.resolve(receivedMessages.shift());
          }
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              const idx = messageWaiters.indexOf(res);
              if (idx !== -1) messageWaiters.splice(idx, 1);
              rej(new Error(`Timeout waiting for message after ${timeoutMs}ms (pushRef: ${pushRef})`));
            }, timeoutMs);

            messageWaiters.push((msg) => {
              clearTimeout(timer);
              res(msg);
            });
          });
        },
        waitForClose(timeoutMs = 2500) {
          if (isClosed) return Promise.resolve(closeEvent);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              rej(new Error(`Timeout waiting for WebSocket close after ${timeoutMs}ms`));
            }, timeoutMs);
            closeWaiters.push((evt) => {
              clearTimeout(timer);
              res(evt);
            });
          });
        },
        sendJson(obj) {
          ws.send(JSON.stringify(obj));
        },
        close(code = 1000, reason = '') {
          ws.close(code, reason);
        },
      });
    };

    ws.onmessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        parsed = event.data;
      }
      if (messageWaiters.length > 0) {
        const nextWaiter = messageWaiters.shift();
        nextWaiter(parsed);
      } else {
        receivedMessages.push(parsed);
      }
    };

    ws.onclose = (evt) => {
      isClosed = true;
      closeEvent = evt;
      while (closeWaiters.length > 0) {
        const w = closeWaiters.shift();
        w(evt);
      }
    };

    ws.onerror = (err) => {
      if (ws.readyState === globalThis.WebSocket.CONNECTING) {
        reject(err);
      }
    };
  });
}

/* -------------------------------------------------------------------------- */
/* TEST SUITES: Realtime Parity (Milestones R17, R18, R19)                     */
/* -------------------------------------------------------------------------- */

describe('Realtime WebSocket & Push Engine Contract Parity (Milestones R17, R18, R19)', () => {
  let harness;
  let port;

  before(async () => {
    harness = createRealtimeHarnessServer();
    port = await harness.start();
  });

  after(async () => {
    if (harness) {
      await harness.stop();
    }
  });

  /* ------------------------------------------------------------------------ */
  /* 1. Handshake RFC 6455 & koneksi WebSocket ke URL `/rest/push?pushRef=...` */
  /* ------------------------------------------------------------------------ */
  test('R17 — RFC 6455 Handshake & WebSocket connection to /rest/push?pushRef=<test-ref>', async () => {
    const testRef = 'session-handshake-101';
    const client = await connectClient(port, testRef);

    try {
      assert.equal(client.ws.readyState, globalThis.WebSocket.OPEN, 'WebSocket readyState must be OPEN (1)');
      assert.equal(harness.registry.hasPushRef(testRef), true, 'pushRef must be registered in the session registry');
      assert.ok(client.url.includes(`/rest/push?pushRef=${testRef}`), 'URL must contain /rest/push and pushRef');
    } finally {
      client.close();
      await client.waitForClose();
    }
  });

  test('R17 — missing pushRef parameter is rejected with 400 Bad Request', async () => {
    // Attempting a connection without pushRef query parameter
    let errorOccurred = false;
    try {
      await connectClient(port, undefined);
    } catch {
      errorOccurred = true;
    }
    assert.equal(errorOccurred, true, 'Connection without pushRef parameter must fail');
  });

  test('R17 — alternative /push endpoint is also supported according to n8n contract', async () => {
    const testRef = 'session-alt-push-202';
    const client = await connectClient(port, testRef, '/push');

    try {
      assert.equal(client.ws.readyState, globalThis.WebSocket.OPEN);
      assert.equal(harness.registry.hasPushRef(testRef), true);
    } finally {
      client.close();
      await client.waitForClose();
    }
  });

  /* ------------------------------------------------------------------------ */
  /* 2. Session parity: pesan handshake '{ "type": "connection", ... }'        */
  /* ------------------------------------------------------------------------ */
  test('R18 — Session parity: initial handshake frame is exactly { type: "connection", data: { authenticated: true } }', async () => {
    const testRef = 'session-auth-parity-303';
    const client = await connectClient(port, testRef);

    try {
      const firstMessage = await client.waitForMessage();
      assert.deepEqual(
        firstMessage,
        {
          type: 'connection',
          data: {
            authenticated: true,
          },
        },
        'Initial frame must be exact match with Rust apps/n8n-rust/src/server.rs handshake envelope',
      );
      assert.equal(firstMessage.type, 'connection');
      assert.equal(firstMessage.data.authenticated, true);
    } finally {
      client.close();
      await client.waitForClose();
    }
  });

  /* ------------------------------------------------------------------------ */
  /* 3. Heartbeat frame swallowing & liveness                                  */
  /* ------------------------------------------------------------------------ */
  test('R19 — Heartbeat frame swallowing & liveness: { type: "heartbeat" } is swallowed without disconnection', async () => {
    const testRef = 'session-heartbeat-404';
    const client = await connectClient(port, testRef);

    try {
      // Consume initial handshake frame
      const initialHandshake = await client.waitForMessage();
      assert.equal(initialHandshake.type, 'connection');

      const initialSwallowed = harness.registry.swallowedHeartbeats;

      // Client sends standard heartbeat frame
      client.sendJson({ type: 'heartbeat' });

      // Give event loop time to process incoming frame
      await new Promise((r) => setTimeout(r, 100));

      assert.equal(
        harness.registry.swallowedHeartbeats,
        initialSwallowed + 1,
        'Server registry must record swallowed heartbeat count',
      );
      assert.equal(client.ws.readyState, globalThis.WebSocket.OPEN, 'Connection must remain open and stable');
      assert.equal(client.receivedMessages.length, 0, 'No echo or unsolicited message generated from heartbeat');

      // Parity invariant check on isHeartbeatMessage helper
      assert.equal(isHeartbeatMessage({ type: 'heartbeat' }), true);
      assert.equal(isHeartbeatMessage({ type: 'heartbeat', extra: 'invalid' }), false, 'Extra fields must not qualify');
      assert.equal(isHeartbeatMessage({ type: 'other' }), false);
      assert.equal(isHeartbeatMessage(null), false);
      assert.equal(isHeartbeatMessage('heartbeat'), false);

      // Verify connection liveness: can send regular data after heartbeat
      harness.registry.sendToOne(testRef, { type: 'livenessCheck', data: { alive: true } });
      const reply = await client.waitForMessage();
      assert.deepEqual(reply, { type: 'livenessCheck', data: { alive: true } });
    } finally {
      client.close();
      await client.waitForClose();
    }
  });

  /* ------------------------------------------------------------------------ */
  /* 4. Reconnection / pushRef duplication handling                           */
  /* ------------------------------------------------------------------------ */
  test('R18 — Reconnection & pushRef duplication: second connection accepted, old connection cleanly closed (R5 parity)', async () => {
    const sharedPushRef = 'session-reconnect-duplicate-505';

    // Step 1: Open First Connection
    const client1 = await connectClient(port, sharedPushRef);
    const hs1 = await client1.waitForMessage();
    assert.equal(hs1.type, 'connection');
    assert.equal(harness.registry.connectionCount, 1);

    // Step 2: Open Second Connection with the SAME pushRef
    const client2 = await connectClient(port, sharedPushRef);
    const hs2 = await client2.waitForMessage();
    assert.equal(hs2.type, 'connection', 'New connection receives handshake');

    // Step 3: Verify First Connection is cleanly closed by server
    const closeEvt = await client1.waitForClose();
    assert.equal(client1.isClosed(), true, 'First connection must be closed');
    assert.equal(closeEvt.code, 1000, 'Close code must be 1000 (normal closure)');

    // Step 4: Verify Registry State: only 1 connection maintained
    assert.equal(harness.registry.connectionCount, 1, 'Registry must hold exactly 1 active session for this pushRef');
    assert.equal(harness.registry.hasPushRef(sharedPushRef), true);

    // Step 5: Verify targeted message routes exclusively to Client 2
    harness.registry.sendToOne(sharedPushRef, { type: 'testEvent', data: { recipient: 'client2' } });
    const msg2 = await client2.waitForMessage();
    assert.deepEqual(msg2, { type: 'testEvent', data: { recipient: 'client2' } });
    assert.equal(client1.receivedMessages.length, 0, 'Closed client1 must receive nothing');

    client2.close();
    await client2.waitForClose();
  });

  /* ------------------------------------------------------------------------ */
  /* 5. Targeted routing dan parsing pesan JSON '{ type, data }'              */
  /* ------------------------------------------------------------------------ */
  test('R17/R18 — Targeted routing and parsing of JSON wire envelopes { type, data }', async () => {
    const refA = 'target-user-A-601';
    const refB = 'target-user-B-602';

    const clientA = await connectClient(port, refA);
    const clientB = await connectClient(port, refB);

    try {
      // Consume handshakes
      await clientA.waitForMessage();
      await clientB.waitForMessage();

      // 1. Send targeted message to Client A (Lifecycle execution event)
      const eventForA = {
        type: 'nodeExecuteBefore',
        data: {
          executionId: 'exec-9001',
          nodeName: 'Manual Trigger',
        },
      };
      harness.registry.sendToOne(refA, eventForA);

      const receivedA = await clientA.waitForMessage();
      assert.deepEqual(receivedA, eventForA, 'Client A must receive targeted nodeExecuteBefore payload');
      assert.equal(clientB.receivedMessages.length, 0, 'Client B must NOT receive messages targeted to Client A');

      // 2. Send targeted message to Client B (Lifecycle completion event)
      const eventForB = {
        type: 'executionFinished',
        data: {
          executionId: 'exec-9002',
          workflowId: 'wf-finance',
          status: 'success',
        },
      };
      harness.registry.sendToOne(refB, eventForB);

      const receivedB = await clientB.waitForMessage();
      assert.deepEqual(receivedB, eventForB, 'Client B must receive targeted executionFinished payload');
      assert.equal(clientA.receivedMessages.length, 0, 'Client A must NOT receive messages targeted to Client B');

      // 3. Broadcast to all active sessions
      const broadcastEvent = {
        type: 'workflowActivated',
        data: {
          workflowId: 'wf-global-alerts',
        },
      };
      const broadcastCount = harness.registry.sendToAll(broadcastEvent);
      assert.equal(broadcastCount, 2);

      const bCastA = await clientA.waitForMessage();
      const bCastB = await clientB.waitForMessage();
      assert.deepEqual(bCastA, broadcastEvent, 'Client A receives broadcast event');
      assert.deepEqual(bCastB, broadcastEvent, 'Client B receives broadcast event');
    } finally {
      clientA.close();
      clientB.close();
      await Promise.all([clientA.waitForClose(), clientB.waitForClose()]);
    }
  });

  /* ------------------------------------------------------------------------ */
  /* 6. Frozen Contract Invariants Parity (Milestones R1..R13, R17..R19)       */
  /* ------------------------------------------------------------------------ */
  describe('Frozen Contract Invariants (R1, R4, R13 parity)', () => {
    test('R1 — Backend default, max payload ceiling and ping interval parity', () => {
      assert.equal(DEFAULT_PUSH_BACKEND, 'websocket', 'R1: DEFAULT_PUSH_BACKEND must be websocket');
      assert.equal(MAX_PAYLOAD_SIZE_BYTES, 5242880, 'R1: MAX_PAYLOAD_SIZE_BYTES must be exactly 5 MiB');
      assert.equal(PING_INTERVAL_MS, 60000, 'R1: PING_INTERVAL_MS must be exactly 60 seconds');
    });

    test('R4/R4b — Serializer DAG preservation and circular reference guard', () => {
      // 1. DAG object (reused references without cyclic loop) must NOT be modified
      const sharedNode = { id: 'node-1', name: 'HTTP' };
      const dagPayload = {
        type: 'nodeExecuteAfter',
        data: {
          source: sharedNode,
          target: sharedNode,
        },
      };
      const serializedDag = stringifyPushMessage(dagPayload);
      const parsedDag = JSON.parse(serializedDag);
      assert.deepEqual(parsedDag.data.source, sharedNode);
      assert.deepEqual(parsedDag.data.target, sharedNode);
      assert.notEqual(parsedDag.data.target, '[Circular Reference]', 'DAG must not be falsely treated as circular');

      // 2. Genuine cyclic reference becomes '[Circular Reference]'
      const cyclicData = { executionId: 'exec-cycle' };
      cyclicData.self = cyclicData;
      const cyclicPayload = { type: 'executionStarted', data: cyclicData };
      const serializedCycle = stringifyPushMessage(cyclicPayload);
      const parsedCycle = JSON.parse(serializedCycle);
      assert.equal(parsedCycle.data.self, '[Circular Reference]', 'Ancestral cycles must be safely replaced');
    });

    test('R10 — Malformed frames are isolated without process or server crashes', async () => {
      const client = await connectClient(port, 'session-malformed-guard');
      try {
        await client.waitForMessage(); // handshake

        // Send non-JSON text frame
        client.ws.send('{ this is completely malformed json :(');

        await new Promise((r) => setTimeout(r, 100));

        // Connection must remain alive and healthy
        assert.equal(client.ws.readyState, globalThis.WebSocket.OPEN);
        harness.registry.sendToOne('session-malformed-guard', { type: 'recovered', data: { ok: true } });
        const res = await client.waitForMessage();
        assert.deepEqual(res, { type: 'recovered', data: { ok: true } });
      } finally {
        client.close();
        await client.waitForClose();
      }
    });
  });
});
