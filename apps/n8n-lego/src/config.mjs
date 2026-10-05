/**
 * n8n lego — configuration.
 *
 * Every knob is an environment variable. n8n-style `N8N_*` names work so that
 * existing n8n deployments can switch over by changing the port only; the
 * namespaced `N8N_LEGO_*` form always wins when both are set.
 *
 * Invalid values abort the boot (exit code 78, EX_CONFIG) instead of silently
 * falling back: a workflow runtime that comes up with the wrong data directory
 * or the wrong port is worse than one that does not come up at all.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export const APP_NAME = 'n8n lego';
export const APP_ID = 'n8n-lego';
export const VERSION = '0.1.0';
export const REFERENCE_VERSION = '2.9.4';

/** apps/n8n-lego/src/config.mjs -> <repo root> */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** apps/n8n-lego/src/config.mjs -> the package itself (== apps/n8n-lego) */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Default data directory, n8n-style: `~/.n8n-lego`, overridable with
 * `N8N_LEGO_USER_FOLDER` / `N8N_USER_FOLDER`. A globally installed package must
 * never write inside its own (read-only, shared) install directory.
 */
export function defaultDataDir(env = process.env) {
  const configured = readEnv(env, 'USER_FOLDER');
  return configured === undefined ? join(homedir(), '.n8n-lego') : dir(configured);
}

/** Where the node catalog and the extracted icons live. */
export function defaultCatalogDir(env = process.env) {
  const configured = readEnv(env, 'CATALOG_DIR');
  return configured === undefined ? join(defaultDataDir(env), 'catalog') : dir(configured);
}

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * Reads `N8N_LEGO_<name>` first, then `N8N_<name>`, then the default.
 * Returns `undefined` when nothing is set.
 */
export function readEnv(env, name) {
  const namespaced = env[`N8N_LEGO_${name}`];
  if (namespaced !== undefined && namespaced !== '') return namespaced;
  const legacy = env[`N8N_${name}`];
  if (legacy !== undefined && legacy !== '') return legacy;
  return undefined;
}

function str(env, name, fallback) {
  const value = readEnv(env, name);
  return value === undefined ? fallback : value.trim();
}

function bool(env, name, fallback) {
  const raw = readEnv(env, name);
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new ConfigError(`${name} must be one of true/false/1/0/yes/no/on/off (got "${raw}")`);
}

function int(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = readEnv(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value)) throw new ConfigError(`${name} must be an integer (got "${raw}")`);
  if (value < min || value > max) throw new ConfigError(`${name} must be between ${min} and ${max} (got ${value})`);
  return value;
}

function oneOf(env, name, fallback, allowed) {
  const raw = readEnv(env, name);
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (!allowed.includes(value)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(' | ')} (got "${raw}")`);
  }
  return value;
}

/** Resolves `~`, relative paths, and `${VAR}`-free plain paths against the repo root. */
function dir(value) {
  if (value.startsWith('~')) return resolve(process.env.HOME ?? '/root', value.slice(2));
  return resolve(REPO_ROOT, value);
}

/**
 * A stable instance id + secret, generated on first boot and kept in the data
 * directory. Sessions and (later) credential encryption are derived from it.
 */
function instanceIdentity(dataDir) {
  const file = join(dataDir, '.instance.json');
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof parsed.instanceId === 'string' && typeof parsed.secret === 'string') return parsed;
    } catch {
      /* fall through and regenerate below */
    }
  }
  const identity = {
    instanceId: randomBytes(8).toString('hex'),
    secret: randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(),
  };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  return identity;
}

export function loadConfig(env = process.env) {
  const dataDir = defaultDataDir(env);
  mkdirSync(dataDir, { recursive: true });

  const identity = instanceIdentity(dataDir);
  const protocol = oneOf(env, 'PROTOCOL', 'http', ['http', 'https']);
  const host = str(env, 'HOST', '0.0.0.0');
  const port = int(env, 'PORT', 5678, { min: 0, max: 65535 });
  // Resolved from the package, not the repo: the same code must work when the
  // app is installed globally with `npm install -g n8n-lego`.
  const editorDist = dir(str(env, 'EDITOR_DIST', join(APP_ROOT, 'node_modules', 'n8n-editor-ui', 'dist')));

  return {
    appName: APP_NAME,
    appId: APP_ID,
    version: VERSION,
    referenceVersion: REFERENCE_VERSION,

    host,
    port,
    protocol,
    basePath: normalizeBasePath(str(env, 'PATH', '/')),
    publicUrl: str(env, 'EDITOR_BASE_URL', `${protocol}://${host === '0.0.0.0' ? 'localhost' : host}:${port}`),

    env: oneOf(env, 'ENV', 'development', ['development', 'production', 'test']),
    logLevel: oneOf(env, 'LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error']),
    timezone: str(env, 'GENERIC_TIMEZONE', Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'),

    dataDir,
    storage: oneOf(env, 'STORAGE', 'file', ['file', 'memory']),
    editorDist,
    catalogDir: defaultCatalogDir(env),

    instanceId: identity.instanceId,
    secret: identity.secret,

    /** First-run owner. When unset n8n lego shows the n8n owner-setup screen. */
    ownerEmail: str(env, 'OWNER_EMAIL', ''),
    ownerPassword: str(env, 'OWNER_PASSWORD', ''),
    ownerFirstName: str(env, 'OWNER_FIRST_NAME', 'n8n lego'),
    ownerLastName: str(env, 'OWNER_LAST_NAME', 'owner'),

    executionTimeoutMs: int(env, 'EXECUTION_TIMEOUT', 300_000, { min: 1_000 }),
    maxBodyBytes: int(env, 'MAX_BODY_BYTES', 16 * 1024 * 1024, { min: 1024 }),
    executionHistory: int(env, 'EXECUTION_HISTORY', 200, { min: 0 }),

    saveDataSuccessExecution: oneOf(env, 'SAVE_DATA_SUCCESS_EXECUTION', 'all', ['all', 'none']),
    saveDataErrorExecution: oneOf(env, 'SAVE_DATA_ERROR_EXECUTION', 'all', ['all', 'none']),
    saveManualExecutions: bool(env, 'SAVE_MANUAL_EXECUTIONS', true),
    saveExecutionProgress: bool(env, 'SAVE_EXECUTION_PROGRESS', true),
    maxExecutionTimeout: int(env, 'MAX_EXECUTION_TIMEOUT', 3600),

    /** REST surface tuning */
    locale: str(env, 'DEFAULT_LOCALE', 'en'),

    // Endpoint segments, exactly like `endpoints.*` in @n8n/config. They are bare
    // path segments: the editor concatenates them onto `window.BASE_PATH`, so a
    // leading or trailing slash here breaks every REST call.
    restEndpoint: str(env, 'ENDPOINT_REST', 'rest'),
    formEndpoint: str(env, 'ENDPOINT_FORM', 'form'),
    formTestEndpoint: str(env, 'ENDPOINT_FORM_TEST', 'form-test'),
    formWaitingEndpoint: str(env, 'ENDPOINT_FORM_WAITING', 'form-waiting'),
    webhookEndpoint: str(env, 'ENDPOINT_WEBHOOK', 'webhook'),
    webhookTestEndpoint: str(env, 'ENDPOINT_WEBHOOK_TEST', 'webhook-test'),
    webhookWaitingEndpoint: str(env, 'ENDPOINT_WEBHOOK_WAITING', 'webhook-waiting'),
    telemetryDisabled: bool(env, 'DIAGNOSTICS_ENABLED', false) === false,
    versionNotificationsEnabled: bool(env, 'VERSION_NOTIFICATIONS_ENABLED', false),
    communityNodesEnabled: bool(env, 'COMMUNITY_NODES_ENABLED', false),
    /**
     * Whether the "Usage and plan" settings page is hidden. Upstream default is
     * false (`@n8n/config` N8N_HIDE_USAGE_PAGE) — a community instance shows it.
     * `N8N_HIDE_USAGE_PAGE` works too (legacy alias), the namespaced form wins.
     */
    hideUsagePage: bool(env, 'HIDE_USAGE_PAGE', false),
  };
}

function normalizeBasePath(value) {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
}

export function describeConfig(config) {
  const { secret, ...rest } = config;
  return { ...rest, secret: `${secret.slice(0, 4)}…` };
}
