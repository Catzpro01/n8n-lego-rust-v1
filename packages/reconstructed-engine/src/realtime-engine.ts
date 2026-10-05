/**
 * Reconstructed Engine — Realtime Push (SSE + WebSocket) Subsystem.
 *
 * Implements the frozen realtime contract R1..R13 matching n8n 2.9.4.
 */

import { EventEmitter } from 'node:events';

export type PushBackend = 'sse' | 'websocket';

export const DEFAULT_PUSH_BACKEND: PushBackend = 'websocket';
export const MAX_PAYLOAD_SIZE_BYTES = 5 * 1024 * 1024;
export const PING_INTERVAL_MS = 60 * 1000;

export const PUSH_MESSAGE_TYPE_GROUPS = {
  execution: [
    'executionStarted',
    'executionWaiting',
    'executionFinished',
    'executionRecovered',
    'nodeExecuteBefore',
    'nodeExecuteAfter',
    'nodeExecuteAfterData',
  ],
  workflow: ['workflowActivated', 'workflowDeactivated'],
  webhook: ['testWebhookReceived', 'testWebhookDeleted'],
  collaboration: ['collaboratorsChanged'],
} as const;

export type PushMessageType = string;

export interface PushMessage {
  type: PushMessageType;
  data?: unknown;
}

export interface HeartbeatMessage {
  type: 'heartbeat';
}

export function createHeartbeatMessage(): HeartbeatMessage {
  return { type: 'heartbeat' };
}

export function isHeartbeatMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const keys = Object.keys(msg);
  return keys.length === 1 && (msg as Record<string, unknown>).type === 'heartbeat';
}

/**
 * Ancestor-scoped circular reference serializer.
 * Genuine cycles become "[Circular Reference]", while multiple occurrences of the
 * same sub-object across disjoint branches (DAG) are preserved.
 */
export function stringifyPushMessage(val: unknown): string {
  const stack: unknown[] = [];
  return JSON.stringify(val, function (this: unknown, key: string, value: unknown) {
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

export function parseForwardedHeader(header?: string): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  const parts = header.split(';');
  for (const part of parts) {
    const [k, v] = part.trim().split('=');
    if (k && v) {
      result[k.toLowerCase()] = v.replace(/^"|"$/g, '');
    }
  }
  return result;
}

function stripDefaultPort(host?: string, proto?: string): string | undefined {
  if (!host) return host;
  const isHttps = proto === 'https';
  if (isHttps && host.endsWith(':443')) return host.slice(0, -4);
  if (!isHttps && host.endsWith(':80')) return host.slice(0, -3);
  return host;
}

export interface OriginValidationResult {
  isValid: boolean;
  originInfo?: { protocol: string; host: string };
  expectedHost?: string;
  expectedProtocol?: string;
  rawExpectedHost?: string;
  error?: string;
}

export function validateOriginHeaders(headers: Record<string, string | undefined> = {}): OriginValidationResult {
  const origin = headers.origin;
  if (!origin || typeof origin !== 'string') {
    return { isValid: false, error: 'Origin header is missing or malformed' };
  }

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return { isValid: false, error: 'Origin header is missing or malformed' };
  }

  const originProto = originUrl.protocol.replace(':', '');
  const originHost = stripDefaultPort(originUrl.host, originProto) ?? originUrl.host;

  let rawExpectedHost = headers.host;
  let expectedProto = originProto;

  const fwd = parseForwardedHeader(headers.forwarded);
  if (fwd.host) {
    rawExpectedHost = fwd.host;
    if (fwd.proto) expectedProto = fwd.proto;
  } else if (headers['x-forwarded-host']) {
    rawExpectedHost = headers['x-forwarded-host'];
    if (headers['x-forwarded-proto']) {
      expectedProto = headers['x-forwarded-proto'];
    }
  }

  const expectedHost = stripDefaultPort(rawExpectedHost, expectedProto);
  const normOriginHost = originHost.replace(/\[|\]/g, '');
  const normExpectedHost = expectedHost ? expectedHost.replace(/\[|\]/g, '') : '';

  const isValid = normOriginHost === normExpectedHost;
  return {
    isValid,
    originInfo: { protocol: originProto, host: originHost },
    expectedHost,
    expectedProtocol: expectedProto,
    rawExpectedHost,
    error: isValid ? undefined : 'Origin header does not match expected host',
  };
}

export interface PushRequest {
  query?: { pushRef?: string };
  headers?: Record<string, string | undefined>;
  userId?: string;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
}

export interface PushResponse {
  statusCode?: number;
  headers?: Record<string, string>;
  chunks?: string[];
  flushCount?: number;
  ended?: boolean;
  setHeader(name: string, value: string): void;
  status(code: number): this;
  write(chunk: string): boolean;
  end(data?: string): void;
  flush?(): void;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
}

export function createMemoryResponse(): PushResponse & EventEmitter {
  const emitter = new EventEmitter() as PushResponse & EventEmitter;
  emitter.statusCode = 200;
  emitter.headers = {};
  emitter.chunks = [];
  emitter.flushCount = 0;
  emitter.ended = false;

  emitter.setHeader = (name: string, value: string) => {
    emitter.headers![name] = value;
  };
  emitter.status = (code: number) => {
    emitter.statusCode = code;
    return emitter;
  };
  emitter.write = (chunk: string) => {
    emitter.chunks!.push(chunk);
    return true;
  };
  emitter.flush = () => {
    emitter.flushCount! += 1;
  };
  emitter.end = (chunk?: string) => {
    if (chunk) emitter.chunks!.push(chunk);
    emitter.ended = true;
    emitter.emit('finish');
  };
  return emitter;
}

export function createMemoryRequest(options: {
  pushRef?: string;
  userId?: string;
  headers?: Record<string, string | undefined>;
} = {}): PushRequest & EventEmitter {
  const emitter = new EventEmitter() as PushRequest & EventEmitter;
  emitter.query = { pushRef: options.pushRef };
  emitter.userId = options.userId;
  emitter.headers = options.headers ?? {};
  return emitter;
}

export interface WebSocketLike extends EventEmitter {
  isAlive: boolean;
  pingCount: number;
  terminated: boolean;
  sent: string[];
  send(data: string): void;
  ping(): void;
  terminate(): void;
}

export function createMemoryWebSocket(): WebSocketLike {
  const ws = new EventEmitter() as WebSocketLike;
  ws.isAlive = true;
  ws.pingCount = 0;
  ws.terminated = false;
  ws.sent = [];

  ws.send = (data: string) => {
    ws.sent.push(data);
  };
  ws.ping = () => {
    ws.pingCount += 1;
  };
  ws.terminate = () => {
    ws.terminated = true;
    ws.emit('close');
  };
  return ws;
}

export abstract class AbstractPush {
  protected connections = new Map<string, any>();

  hasPushRef(pushRef: string): boolean {
    return this.connections.has(pushRef);
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  abstract sendToOne(msg: PushMessage, pushRef: string): void;
  abstract sendToUsers(msg: PushMessage, userIds: string[]): void;
  abstract sendToAll(msg: PushMessage): void;
  abstract pingAll(): void;
  abstract closeAllConnections(): void;
}

export interface SSEConnection {
  req: PushRequest;
  res: PushResponse;
  userId: string;
}

export class SSEPush extends AbstractPush {
  protected override connections = new Map<string, SSEConnection>();

  add(pushRef: string, userId: string, { req, res }: { req: PushRequest; res: PushResponse }): void {
    const existing = this.connections.get(pushRef);
    if (existing) {
      existing.res.end();
      this.connections.delete(pushRef);
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=UTF-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.statusCode = 200;
    res.write(':ok\n\n');
    res.flush?.();

    this.connections.set(pushRef, { req, res, userId });

    const cleanup = () => {
      if (this.connections.get(pushRef)?.res === res) {
        this.connections.delete(pushRef);
      }
    };
    req.on('end', cleanup);
    req.on('close', cleanup);
    res.on('finish', cleanup);
  }

  sendToOne(msg: PushMessage, pushRef: string): void {
    const conn = this.connections.get(pushRef);
    if (!conn) return;
    const data = stringifyPushMessage(msg);
    conn.res.write('data: ' + data + '\n\n');
    conn.res.flush?.();
  }

  sendToUsers(msg: PushMessage, userIds: string[]): void {
    const targetSet = new Set(userIds);
    for (const conn of this.connections.values()) {
      if (targetSet.has(conn.userId)) {
        const data = stringifyPushMessage(msg);
        conn.res.write('data: ' + data + '\n\n');
        conn.res.flush?.();
      }
    }
  }

  sendToAll(msg: PushMessage): void {
    for (const conn of this.connections.values()) {
      const data = stringifyPushMessage(msg);
      conn.res.write('data: ' + data + '\n\n');
      conn.res.flush?.();
    }
  }

  pingAll(): void {
    for (const conn of this.connections.values()) {
      conn.res.write(':ping\n\n');
      conn.res.flush?.();
    }
  }

  closeAllConnections(): void {
    for (const conn of this.connections.values()) {
      conn.res.end();
    }
    this.connections.clear();
  }
}

export type OnPushMessage = (msg: { pushRef: string; userId: string; msg: PushMessage }) => void;

export class WebSocketPush extends EventEmitter {
  private connections = new Map<string, { userId: string; connection: any }>();
  public errors: Error[] = [];

  hasPushRef(pushRef: string): boolean {
    return this.connections.has(pushRef);
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  add(pushRef: string, userId: string, connection: any): void {
    const existing = this.connections.get(pushRef);
    if (existing) {
      existing.connection.terminate?.();
      this.connections.delete(pushRef);
    }

    connection.isAlive = true;
    const heartbeat = () => {
      connection.isAlive = true;
    };
    connection.on('pong', heartbeat);

    connection.on('message', (raw: string) => {
      let msg: any;
      try {
        msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        this.errors.push(new Error('Error parsing push message'));
        return;
      }

      if (isHeartbeatMessage(msg)) {
        return;
      }

      this.emit('message', { pushRef, userId, msg });
    });

    connection.on('close', () => {
      if (this.connections.get(pushRef)?.connection === connection) {
        this.connections.delete(pushRef);
      }
    });

    this.connections.set(pushRef, { userId, connection });
  }

  sendToOne(msg: PushMessage, pushRef: string): void {
    const conn = this.connections.get(pushRef);
    if (!conn) return;
    conn.connection.send(stringifyPushMessage(msg));
  }

  sendToUsers(msg: PushMessage, userIds: string[]): void {
    const targetSet = new Set(userIds);
    for (const conn of this.connections.values()) {
      if (targetSet.has(conn.userId)) {
        conn.connection.send(stringifyPushMessage(msg));
      }
    }
  }

  sendToAll(msg: PushMessage): void {
    for (const conn of this.connections.values()) {
      conn.connection.send(stringifyPushMessage(msg));
    }
  }

  pingAll(): void {
    for (const [pushRef, entry] of Array.from(this.connections.entries())) {
      const { connection } = entry;
      if (!connection.isAlive) {
        this.connections.delete(pushRef);
        return connection.terminate();
      }
      connection.isAlive = false;
      connection.ping();
    }
  }

  closeAllConnections(): void {
    for (const entry of this.connections.values()) {
      entry.connection.terminate?.();
    }
    this.connections.clear();
  }
}

export interface PushPublisher {
  publishCommand(cmd: { command: string; payload: unknown }): Promise<void> | void;
}

export interface PushServiceOptions {
  backend?: PushBackend;
  inProduction?: boolean;
  isWorker?: boolean;
  publisher?: PushPublisher;
}

export class PushService {
  public backend: PushBackend;
  public inProduction: boolean;
  public isWorker: boolean;
  public publisher?: PushPublisher;
  public warnings: string[] = [];
  public errors: Error[] = [];
  public events = new EventEmitter();
  private pushBackendInstance: SSEPush | WebSocketPush;

  constructor(options: PushServiceOptions = {}) {
    this.backend = options.backend ?? DEFAULT_PUSH_BACKEND;
    this.inProduction = Boolean(options.inProduction);
    this.isWorker = Boolean(options.isWorker);
    this.publisher = options.publisher;
    this.pushBackendInstance = this.backend === 'sse' ? new SSEPush() : new WebSocketPush();
  }

  hasPushRef(pushRef: string): boolean {
    return this.pushBackendInstance.hasPushRef(pushRef);
  }

  handleRequest(
    req: PushRequest,
    res: PushResponse,
  ): { ok: boolean; error?: string; status?: number } {
    const pushRef = req.query?.pushRef;
    if (!pushRef) {
      return {
        ok: false,
        error: 'The query parameter "pushRef" is missing!',
        status: 400,
      };
    }

    if (this.inProduction && req.headers) {
      const val = validateOriginHeaders(req.headers);
      if (!val.isValid) {
        let connectionError = 'Invalid origin!';
        this.warnings.push('Origin header does NOT match the expected origin. ' + (val.error ?? ''));
        return { ok: false, error: connectionError, status: 400 };
      }
    }

    if (this.backend === 'websocket') {
      return { ok: false, error: 'Unauthorized', status: 401 };
    }

    if (this.pushBackendInstance instanceof SSEPush) {
      this.pushBackendInstance.add(pushRef, req.userId ?? 'default-user', { req, res });
    }

    this.events.emit('editorUiConnected', pushRef);
    return { ok: true };
  }

  async send(msg: PushMessage, pushRef: string): Promise<void> {
    const serialized = stringifyPushMessage(msg);
    const byteLength = Buffer.byteLength(serialized, 'utf8');

    if (byteLength > MAX_PAYLOAD_SIZE_BYTES) {
      this.warnings.push(`Size of "${msg.type}" (5 MB) exceeds max size 5 MB. Skipping...`);
      return;
    }

    if (this.isWorker && this.publisher) {
      await this.publisher.publishCommand({
        command: 'relay-execution-lifecycle-event',
        payload: {
          type: msg.type,
          data: msg.data,
          pushRef,
          asBinary: false,
        },
      });
      return;
    }

    if (this.pushBackendInstance.hasPushRef(pushRef)) {
      this.pushBackendInstance.sendToOne(msg, pushRef);
    }
  }

  handleRelayExecutionLifecycleEvent(event: {
    type: string;
    data?: unknown;
    pushRef: string;
    asBinary?: boolean;
  }): void {
    if (this.pushBackendInstance.hasPushRef(event.pushRef)) {
      this.pushBackendInstance.sendToOne({ type: event.type, data: event.data }, event.pushRef);
    }
  }
}
