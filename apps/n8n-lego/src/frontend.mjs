/**
 * The only module that talks to the frontend LEGO.
 *
 * Boundary rule (contract §2, F5): the app serves the stock editor bundle and
 * asks the frontend LEGO for the descriptor it publishes. The app knows nothing
 * about the frontend framework, and the frontend LEGO knows nothing about this
 * application beyond the two values it is handed (`app`, `ui`).
 *
 * Loading is **fail-soft**: a missing or broken frontend LEGO must never stop the
 * editor from being served. The stock UI does not need the descriptor to render —
 * it needs it to be extensible — so a failure degrades to "served without the
 * descriptor" and a warning.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT, REFERENCE_VERSION, REPO_ROOT } from './config.mjs';

/**
 * The frontend LEGO is a sibling package in the repository and a vendored copy
 * inside the published tarballs (`vendor/frontend-lego`, produced by
 * `scripts/release.sh`) — the same resolution order the execution engine uses.
 */
const FRONTEND_CANDIDATES = [
  process.env.N8N_LEGO_FRONTEND_PATH ? join(process.env.N8N_LEGO_FRONTEND_PATH, 'index.mjs') : null,
  join(REPO_ROOT, 'packages', 'frontend-lego', 'index.mjs'),
  join(APP_ROOT, 'vendor', 'frontend-lego', 'index.mjs'),
  join(APP_ROOT, 'node_modules', '@lego', 'frontend', 'index.mjs'),
].filter((candidate) => typeof candidate === 'string');

export const FRONTEND_PATH = FRONTEND_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;

/** The pinned editor bundle's version, read from the installed package. */
export function editorVersion() {
  try {
    return JSON.parse(readFileSync(join(APP_ROOT, 'node_modules', 'n8n-editor-ui', 'package.json'), 'utf8')).version ?? REFERENCE_VERSION;
  } catch {
    return REFERENCE_VERSION;
  }
}

/** What a consumer gets when the LEGO is unavailable: honest, empty, inert. */
function unavailable(reason) {
  return Object.freeze({
    available: false,
    reason,
    bootPayload: null,
    metaTag: '',
    subLegos: null,
    register: () => {
      throw new Error(`the frontend LEGO is not available (${reason})`);
    },
    describe: () => ({ available: false, reason, backendUntouched: true }),
  });
}

/**
 * Loads the frontend LEGO and builds the boot descriptor.
 *
 * @param {{ config: object, logger: object }} init
 * @returns {Promise<{ available: boolean, bootPayload: object|null, metaTag: string, register: Function, describe: Function }>}
 */
export async function loadFrontend({ config, logger }) {
  if (!FRONTEND_PATH) {
    logger.warn('frontend LEGO not found — serving the editor UI without the boot descriptor', {
      lookedIn: FRONTEND_CANDIDATES,
    });
    return unavailable('frontend-lego-not-found');
  }

  try {
    // Resolved at runtime, like the engine: a checkout runs the package it ships
    // with, an installed tarball runs the vendored copy.
    const module = await import(pathToFileURL(FRONTEND_PATH).href);
    const lego = module.createFrontendLego({
      app: {
        name: config.appName,
        version: config.version,
        referenceVersion: config.referenceVersion ?? REFERENCE_VERSION,
      },
      ui: { basePath: config.basePath, restEndpoint: config.restEndpoint },
      logger,
    });
    return Object.freeze({
      available: true,
      path: FRONTEND_PATH,
      bootPayload: lego.bootPayload,
      metaTag: lego.metaTag,
      // The nested units stay queryable in-process (hierarchy walks, upgrade
      // checks); only their identity, version and ports travel to the browser.
      subLegos: lego.subLegos,
      registry: lego.registry,
      // P2.8-F maturity surface: what this frontend can offer (declared, never
      // installed), what a change would touch, and what it would cost to verify.
      availability: lego.availability,
      impactOf: lego.impactOf,
      planChange: lego.planChange,
      register: lego.register,
      warnings: lego.warnings,
      describe: () => ({ available: true, path: FRONTEND_PATH, editorVersion: editorVersion(), ...lego.describe() }),
    });
  } catch (error) {
    logger.warn('frontend LEGO failed to load — the editor UI is served unchanged', {
      cause: error instanceof Error ? error.message : String(error),
      path: FRONTEND_PATH,
    });
    return unavailable('frontend-lego-load-error');
  }
}
