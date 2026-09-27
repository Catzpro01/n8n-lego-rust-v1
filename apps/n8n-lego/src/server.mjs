/**
 * n8n lego — server entry point.
 *
 *   node apps/n8n-lego/src/server.mjs        (or: n8n-lego start)
 *
 * Boot order: config → logger → store → engine → compat router (domains) → static UI → /push.
 * Request pipeline: base path → CORS → session → compat route → domain handler →
 * normalized JSON envelope → log. Unsupported `/rest/*` paths get an explicit 501.
 *
 * Exit codes: 78 invalid configuration (EX_CONFIG), 1 fatal boot error,
 * 0 clean shutdown.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ConfigError, APP_NAME, VERSION, describeConfig } from './config.mjs';
import { createLogger } from './logger.mjs';
import { createStore, seedExecutionCounter } from './store.mjs';
import { createEngine } from './engine.mjs';
import { createUi } from './ui.mjs';
import { loadFrontend } from './frontend.mjs';
import { frontendRoutes } from './frontend/routes.mjs';
import { createPushServer } from './push.mjs';
import { createRouter } from './compat/route.mjs';
import { HttpError } from './compat/error.mjs';
import { readBody, sendError, sendJson } from './compat/response.mjs';
import { createUnsupportedHandler } from './compat/capability.mjs';
import { authRoutes } from './auth/routes.mjs';
import { assertMailTransport, createConsoleMailTransport } from './auth/security/mail-transport.mjs';
import { createPasswordResetDelivery } from './auth/password-reset-delivery.mjs';
import { handlePublicApiRequest, isPublicApiPath, mountPublicApiOperations } from './auth/public-api-routes.mjs';
import { backingResourceOperations, createBackingModels } from './auth/public-api-backing.mjs';
import { createLocalStorage } from './lego/storage/local-provider.mjs';
import { settingsRoutes } from './settings/routes.mjs';
import { buildRoutes } from './rest/routes.mjs';
import { bootCredentialVault } from './auth/security/credential-vault.mjs';
import { createCredentialTypeIndex } from './compat/credentials.mjs';
import { catalogPresent, loadCatalog } from './catalog.mjs';
import { checkCsrf, createOwner, currentUser, hasOwner } from './auth.mjs';

const EX_CONFIG = 78;
const SHUTDOWN_GRACE_MS = 10_000;

export async function startServer({ env = process.env, mailTransport = null } = {}) {
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'invalid configuration', error: message })}\n`);
    process.exit(EX_CONFIG);
  }

  const logger = createLogger({
    level: config.logLevel,
    format: config.env === 'development' ? 'text' : 'json',
    base: { service: config.appId, pid: process.pid },
  });

  logger.info(`${APP_NAME} starting`, { version: VERSION, node: process.versions.node, env: config.env });
  logger.debug('effective configuration', describeConfig(config));

  const store = createStore(config);

  /* P5-M10: the /api/v1 backing resources (projects, audit, source-control,
   * data-tables, transfer, workflow versions, execution retry, execution tags)
   * mount over the P8 storage facade. ONE facade handle backs all eight models;
   * write-through persistence makes it durable under the instance data dir; the
   * API layer holds no shadow state. Rollback = unmount the routes only —
   * mountPublicApiOperations() returns the unmount handle; the models and their
   * history stay intact. */
  const backingPersistenceFile = join(config.dataDir, 'public-api-backing.json');
  const backingStorage = createLocalStorage({
    clock: { now: () => Date.now() },
    persistence: {
      load() {
        try {
          return readFileSync(backingPersistenceFile);
        } catch {
          return null;
        }
      },
      save(bytes) {
        const tmp = `${backingPersistenceFile}.tmp`;
        writeFileSync(tmp, bytes);
        renameSync(tmp, backingPersistenceFile);
      },
    },
  });
  const executionStatusState = {
    new: 'running', running: 'running', waiting: 'running', unknown: 'running',
    success: 'succeeded', succeeded: 'succeeded',
    error: 'failed', failed: 'failed', crashed: 'failed',
    canceled: 'cancelled', cancelled: 'cancelled',
  };
  const backingModels = createBackingModels({
    storage: backingStorage,
    clock: { now: () => Date.now() },
    idFactory: () => randomUUID(),
    executionLookup: (id) => {
      // route params are strings; the collection may key numeric ids (the
      // P5-M08 execution handlers do the same coercion in loadExecution)
      const execution = store.executions.get(id) ?? store.executions.get(Number(id));
      if (!execution) return null;
      return { state: executionStatusState[String(execution.status ?? '').toLowerCase()] ?? 'running' };
    },
  });
  mountPublicApiOperations(backingResourceOperations(backingModels, { store }));
  // P5.5: credential secrets are sealed at rest. A vault that cannot start
  // (missing/unreadable keyring while sealed records exist) leaves the editor up
  // but makes every secret operation fail closed with 503 — never plaintext.
  const credentialTypes = createCredentialTypeIndex(loadCatalog(config)?.credentials ?? []);
  const { vault, error: vaultError, report: vaultReport } = await bootCredentialVault({
    config,
    store,
    secretFieldsFor: (type) => credentialTypes.secretFields(type),
    onEvent: (event, detail) => logger.info(event, detail),
  });
  if (vaultError) logger.error('credential vault unavailable — secret operations will fail closed', vaultError);
  else logger.info('credential vault ready', vaultReport);
  const engine = createEngine(config, logger);
  // Frontend LEGO (P2.5): fail-soft — an unavailable descriptor never blocks the
  // editor, it only means the UI is served without extension metadata.
  const frontend = await loadFrontend({ config, logger });
  logger.info('frontend contract', frontend.describe());
  const ui = createUi({ config, logger, frontend });
  const push = createPushServer({ config, logger });

  /* P5-M06 (DEC-0028 rev 2, option A): password-recovery mail goes through an
   * injected MailTransport — pure values in, frozen values out, the host does
   * the IO. Default = the console transport (dev-safe: redacted body to the
   * logger, no network). A deployment injects its SMTP/provider adapter at this
   * composition root; `mailTransport: false` unplants delivery entirely and the
   * route answers with the pinned upstream "email not set up" 500 (rollback).
   * The product bundles no SMTP client and no provider SDK. */
  const mailTransportHandle = mailTransport === false
    ? null
    : assertMailTransport(mailTransport ?? createConsoleMailTransport({ logger }));
  const mailDelivery = mailTransportHandle ? createPasswordResetDelivery({ transport: mailTransportHandle, logger }) : null;
  // Compatibility boundary: one router mounts the domain modules (auth,
  // settings, the legacy aggregate). Any `/rest/*` path without an owner is
  // answered by the capability handler with the explicit 501 "unsupported"
  // semantics — never a fake `200 {}` (docs/n8n-lego/FRONTEND_COMPATIBILITY.md).
  const router = createRouter([
    ...settingsRoutes(),
    ...frontendRoutes({ frontend }),
    ...authRoutes({ logger, vault, delivery: mailDelivery }),
    ...buildRoutes({ engine, logger, push, vault }),
  ]);
  const unsupported = createUnsupportedHandler(logger);

  // Execution ids continue after the highest one already stored.
  const highestExecutionId = store.executions.all().reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);
  seedExecutionCounter(highestExecutionId);

  // First-run owner from the environment (n8n's N8N_USER_MANAGEMENT_DISABLED
  // equivalent): when set, the editor skips the owner-setup screen entirely.
  if (!hasOwner(store)) {
    if (config.ownerEmail && config.ownerPassword) {
      createOwner(store, {
        email: config.ownerEmail,
        password: config.ownerPassword,
        firstName: config.ownerFirstName,
        lastName: config.ownerLastName,
      });
      logger.info('owner account created from N8N_LEGO_OWNER_EMAIL', { email: config.ownerEmail });
    }
  }
  if (!catalogPresent(config)) {
    logger.warn('node catalog missing — the editor palette will be empty until `npm run catalog` runs', {
      catalogDir: config.catalogDir,
    });
  }
  logger.info('engine ready', engine.metadata);

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      logger.error('unhandled request error', { cause: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal server error' });
      else res.end();
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  server.on('upgrade', (req, socket, head) => {
    const url = safeUrl(req, config);
    if (!url) return socket.destroy();
    if ([...push.paths].some((pushPath) => url.pathname === pushPath || url.pathname.startsWith(pushPath))) {
      push.handleUpgrade(req, socket, head);
      return;
    }
    socket.destroy();
  });

  async function handleRequest(req, res) {
    const started = Date.now();
    const url = safeUrl(req, config);
    if (!url) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad request');
      return;
    }

    const cors = corsHeaders(req, config);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    for (const [key, value] of Object.entries(cors)) res.setHeader(key, value);

    // Base path: everything n8n lego serves lives behind N8N_LEGO_PATH.
    let pathname = url.pathname;
    if (config.basePath !== '/') {
      if (!pathname.startsWith(config.basePath.slice(0, -1))) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }
      pathname = pathname.slice(config.basePath.length - 1);
    }

    // P5-M03 — the public API. API-key authenticated (never the session
    // cookie), upstream `{ message }` error bodies; must win over the editor
    // SPA fallback, which would otherwise answer API clients with HTML.
    if (isPublicApiPath(pathname)) {
      // P5-M09: the credential surface needs the same backing store the editor
      // uses — the P5.5 vault (secrets are sealed at rest, never plaintext) and
      // the credential-type index that decides which fields are secret.
      const ctx = { req, res, config, logger, store, engine, vault, credentialTypes, credentialTypeList: loadCatalog(config)?.credentials ?? [], method: req.method ?? 'GET', path: pathname, query: Object.fromEntries(url.searchParams), params: {}, body: undefined, user: null };
      const user = await handlePublicApiRequest(ctx);
      logAccess(req, res, pathname, started, user ?? undefined);
      return;
    }

    if (!pathname.startsWith('/rest/')) {
      // Node icons, resolved from the relative `iconUrl` in the catalog
      // (`n8n` mounts the same route in server.ts). Public: icons carry no data.
      if (pathname.startsWith('/icons/')) {
        ui.serveIcon(res, pathname);
        logAccess(req, res, pathname, started);
        return;
      }

      // n8n serves the node/credential type files at the root as well, protected
      // by the session (server.ts `protectedTypeFiles`). The editor asks for both.
      if (pathname.startsWith('/types/')) {
        // `/types/nodes.json`, `/types/node-versions.json`, `/types/credentials.json`
        // carry the same payloads as their `/rest/types/*` twins, but n8n serves
        // them from the static cache and protects them with the session cookie.
        const user = currentUser(store, config, req);
        try {
          if (!user) throw new HttpError(401, 'Unauthorized');
          const catalog = loadCatalog(config);
          if (!catalog) throw new HttpError(404, 'Node catalog is not installed — run `npm run catalog`');
          if (pathname === '/types/nodes.json') {
            sendJson(res, 200, JSON.parse(catalog.raw.nodes().toString('utf8')), { 'cache-control': 'public, max-age=60' });
          } else if (pathname === '/types/node-versions.json') {
            sendJson(res, 200, catalog.versions, { 'cache-control': 'public, max-age=60' });
          } else if (pathname === '/types/credentials.json') {
            sendJson(res, 200, JSON.parse(catalog.raw.credentials().toString('utf8')), { 'cache-control': 'public, max-age=60' });
          } else {
            throw new HttpError(404, 'Not found');
          }
        } catch (error) {
          sendError(res, error);
        }
        logAccess(req, res, pathname, started, user?.email);
        return;
      }

      // n8n-compatible health endpoints — used by docker/compose healthchecks,
      // load balancers and `deploy/systemd` unit readiness checks.
      if (pathname === '/healthz' || pathname === '/healthz/readiness') {
        const ready = catalogPresent(config) && ui.available;
        sendJson(res, ready ? 200 : 503, {
          status: ready ? 'ok' : 'degraded',
          checks: {
            editorUi: ui.available ? 'ok' : 'missing',
            nodeCatalog: catalogPresent(config) ? 'ok' : 'missing',
            engine: engine.metadata.version,
          },
        });
        logAccess(req, res, pathname, started);
        return;
      }
      ui.serve(req, res, pathname === '' ? '/' : pathname);
      logAccess(req, res, pathname, started);
      return;
    }

    const ctx = {
      req,
      res,
      config,
      logger,
      store,
      engine,
      method: req.method ?? 'GET',
      path: pathname,
      query: Object.fromEntries(url.searchParams),
      params: {},
      body: undefined,
      user: null,
    };

    try {
      const match = router.match(ctx.method, ctx.path);

      // Authentication runs before the body is read, so an unauthenticated POST
      // never gets as far as parsing (and 401 is honest about why).
      if (!match || !match.public) {
        ctx.user = currentUser(store, config, req);
        if (!ctx.user) throw new HttpError(401, 'Unauthorized');
      } else {
        ctx.user = currentUser(store, config, req);
      }

      // P5.2 — CSRF boundary. Runs after authentication (so we know whether
      // there is ambient cookie authority to protect) and before the body is
      // read, so a forged request never reaches a handler.
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(ctx.method)) {
        const csrf = checkCsrf(config, req);
        if (!csrf.allowed) {
          throw new HttpError(403, 'Cross-origin request blocked', { meta: { verdict: csrf.verdict } });
        }
      }

      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(ctx.method)) {
        ctx.body = await readBody(req, { limit: config.maxBodyBytes });
      }

      if (match) {
        ctx.params = match.params;
        await match.handler(ctx);
      } else {
        unsupported(ctx);
      }
      logAccess(req, res, pathname, started, ctx.user?.email);
    } catch (error) {
      sendError(res, error);
      logAccess(req, res, pathname, started, ctx.user?.email, error);
    }
  }

  function logAccess(req, res, pathname, started, user, error) {
    const status = res.statusCode;
    const fields = {
      method: req.method,
      path: pathname,
      status,
      ms: Date.now() - started,
      ...(user ? { user } : {}),
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    };
    if (status >= 500) logger.error('request failed', fields);
    else if (status >= 400) logger.debug('request rejected', fields);
    else logger.debug('request', fields);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
  logger.info(`${APP_NAME} listening`, {
    editor: `http://${shownHost}:${port}${config.basePath}`,
    rest: `http://${shownHost}:${port}${config.basePath}rest/`,
    push: `ws://${shownHost}:${port}${push.path}`,
    storage: store.kind,
    dataDir: config.dataDir,
    ui: ui.available ? 'editor-ui 2.9.4' : 'missing',
    catalog: catalogPresent(config) ? 'ready' : 'missing',
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown requested', { signal });
    push.closeAll();
    const forced = setTimeout(() => {
      logger.warn('shutdown grace period elapsed — destroying remaining connections');
      server.closeAllConnections?.();
    }, SHUTDOWN_GRACE_MS);
    forced.unref();
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
    });
    clearTimeout(forced);
    logger.info(`${APP_NAME} stopped`);
    process.exit(0);
  };

  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void shutdown(signal));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { cause: reason instanceof Error ? reason.message : String(reason) });
  });

  return { server, config, logger, store, engine, push, ui, frontend, backing: backingModels, mailTransport: mailTransportHandle };
}

function safeUrl(req, config) {
  try {
    return new URL(req.url ?? '/', `http://${req.headers.host ?? `localhost:${config.port}`}`);
  } catch {
    return null;
  }
}

function corsHeaders(req, config) {
  const origin = req.headers.origin;
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type, x-n8n-api-key, browser-id, authorization',
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  startServer().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', msg: 'failed to start', error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exit(1);
  });
}
