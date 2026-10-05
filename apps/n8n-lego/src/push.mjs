/**
 * `/rest/push` — the WebSocket the editor keeps open (it dials `restUrl + '/push'`).
 *
 * Implemented directly on `node:http`'s `upgrade` event (RFC 6455 handshake +
 * text frames) so n8n lego has no runtime dependencies. The editor uses it for
 * execution progress and collaboration presence; n8n lego uses it to announce
 * execution lifecycle events, which is what makes the canvas show a running
 * workflow without polling.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 1024 * 1024;

export function createPushServer({ config, logger }) {
  const paths = new Set([`${config.basePath}${config.restEndpoint}/push`, `${config.basePath}push`]);
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const sockets = new Set();

  function handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const client = { socket, alive: true, buffer: Buffer.alloc(0) };
    sockets.add(client);
    logger.debug('push client connected', { clients: sockets.size });

    socket.on('data', (chunk) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      if (client.buffer.length > MAX_FRAME_BYTES) {
        close(client, 1009, 'message too big');
        return;
      }
      let frame = decodeFrame(client.buffer);
      while (frame) {
        client.buffer = client.buffer.subarray(frame.consumed);
        handleFrame(client, frame);
        frame = decodeFrame(client.buffer);
      }
    });
    socket.on('close', () => {
      sockets.delete(client);
      logger.debug('push client disconnected', { clients: sockets.size });
    });
    socket.on('error', () => {
      sockets.delete(client);
      socket.destroy();
    });
  }

  function handleFrame(client, frame) {
    if (frame.opcode === 0x8) {
      close(client, 1000, 'bye');
      return;
    }
    if (frame.opcode === 0x9) {
      client.socket.write(encodeFrame(frame.payload, 0xa));
      return;
    }
    if (frame.opcode !== 0x1) return;
    let message;
    try {
      message = JSON.parse(frame.payload.toString('utf8'));
    } catch {
      return;
    }
    // The editor subscribes to a session and sends heartbeats; answering the
    // heartbeat keeps its reconnect logic quiet.
    if (message?.type === 'ping' || message?.type === 'heartbeat') {
      send(client, { type: 'pong', data: { ts: Date.now() } });
      return;
    }
    bus.emit('message', message, client);
  }

  function send(client, payload) {
    if (!client.socket.writable) return;
    client.socket.write(encodeFrame(Buffer.from(JSON.stringify(payload), 'utf8'), 0x1));
  }

  function broadcast(payload) {
    for (const client of sockets) send(client, payload);
  }

  function close(client, code = 1000, reason = '') {
    try {
      const reasonBuffer = Buffer.from(reason, 'utf8');
      const payload = Buffer.alloc(2 + reasonBuffer.length);
      payload.writeUInt16BE(code, 0);
      reasonBuffer.copy(payload, 2);
      client.socket.write(encodeFrame(payload, 0x8));
    } catch {
      /* socket already gone */
    }
    client.socket.end();
    sockets.delete(client);
  }

  function closeAll() {
    for (const client of sockets) close(client, 1001, 'server shutting down');
  }

  return {
    // `restUrl` already ends with a slash, so the editor dials `/rest/push`.
    paths,
    path: `${config.basePath}${config.restEndpoint}/push`,
    handleUpgrade,
    broadcast,
    closeAll,
    clientCount: () => sockets.size,
    onMessage: (listener) => bus.on('message', listener),
  };
}

/* --------------------------------------------------------------- frame codec */

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) === 0x80;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(MAX_FRAME_BYTES)) throw new Error('frame too large');
    length = Number(big);
    offset += 8;
  }

  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (maskKey) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
  }
  return { opcode, payload, consumed: offset + length };
}

function encodeFrame(payload, opcode) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}
