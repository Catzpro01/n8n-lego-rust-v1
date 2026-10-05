/**
 * Backend LEGO foundation — machine-readable error contract.
 *
 * PUBLIC CONTRACT (`lego.error-contract`, v1.0.0, owner: manager).
 *
 * The backend's job is to return a *stable semantic identity* for a failure.
 * Presentation — wording, tone, language — belongs to the frontend. A code such
 * as `workflow.not_found` therefore never changes because a message changed,
 * and the future Translation LEGO keys off codes, never off English strings.
 *
 * The catalogue lives in `contracts/errors.contract.json` so tooling and the
 * frontend can read it without executing JavaScript; this module is the typed
 * accessor plus the assertion helper domains use in their handlers.
 *
 * Deliberately NOT here: HTTP transport. `src/compat/error.mjs` owns HttpError
 * and the wire shape; a domain raises identity, the compatibility layer renders
 * it. That keeps this module importable by any domain without pulling in the
 * compatibility boundary.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'contracts', 'errors.contract.json');

const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));

/** @type {ReadonlyArray<{ code: string, status: number, summary: string }>} */
export const ERROR_CODES = Object.freeze(contract.codes.map((entry) => Object.freeze({ ...entry })));

export const ERROR_CONTRACT_VERSION = contract.version;

const BY_CODE = new Map(ERROR_CODES.map((entry) => [entry.code, entry]));

/** Codes as a frozen lookup object: `errorCode.workflow_not_found` style is intentionally NOT provided — use the string. */
export function errorCode(code) {
  const entry = BY_CODE.get(code);
  if (!entry) throw new Error(`unknown error code '${code}' — declare it in src/lego/contracts/errors.contract.json first`);
  return entry;
}

export function isErrorCode(code) {
  return BY_CODE.has(code);
}

export function statusForCode(code) {
  return errorCode(code).status;
}

/**
 * Guard for domain authors: fail loudly at development time rather than ship a
 * made-up code the frontend cannot map.
 */
export function assertErrorCode(code) {
  errorCode(code);
  return code;
}

/** Every code belonging to one domain namespace, e.g. `codesForNamespace('workflow')`. */
export function codesForNamespace(namespace) {
  return ERROR_CODES.filter((entry) => entry.code.startsWith(`${namespace}.`));
}
