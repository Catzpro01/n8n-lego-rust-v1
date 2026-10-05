/**
 * P5.8 (#221) — the operator entrypoint to the P5.5 credential vault.
 *
 * Before P5.8, key rotation, rotation recovery, backup and quarantine restore
 * existed only as a library: no operator could run them against an install.
 * This module is that entrypoint, reached through `n8n-lego credentials <verb>`.
 * It adds NO cryptography and no second vault — every verb is a thin driver over
 * `createCredentialVault` / `createLocalKeyProvider`.
 *
 * Operating rules, all enforced here (not just documented):
 *
 *   - OFFLINE ONLY for mutations. `Collection` persists whole files and the
 *     running server holds its keyring in memory: rotating or restoring under a
 *     live server would be overwritten by its next write, and it could re-seal a
 *     record under a key this tool just retired. `rotate`, `recover` and
 *     `restore` therefore refuse while the configured server port answers.
 *   - NEVER MINTS A KEY. The provider is opened with `allowCreate: false`; a
 *     missing keyring is reported, never silently replaced (P5.5 no-plaintext /
 *     no-fresh-key-over-sealed-data rule).
 *   - FILE STORAGE ONLY. Memory storage has no durable keyring to operate on.
 *   - NO MATERIAL IN OUTPUT. Output is lineage, fingerprints, identifiers and
 *     counts — the same fields the vault's audit hook already emits.
 *   - A backup is written 0600, atomically (tmp + rename), and never over an
 *     existing file.
 *
 * `auth` may not import storage (arch R3): the composition root (bin) builds the
 * config and the store and injects them.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { KEYRING_FILE, VAULT_LIMITS, createCredentialVault } from './security/credential-vault.mjs';
import { createLocalKeyProvider } from './security/key-provider.mjs';
import { mfaSecretCollection } from './security/mfa.mjs';

export const OPERATOR_COMMANDS = Object.freeze(['status', 'verify', 'rotate', 'recover', 'backup', 'restore-check', 'restore']);

/** Verbs that write the store or the keyring and therefore need the server stopped. */
const MUTATING = new Set(['rotate', 'recover', 'restore']);

/** Exit codes: 0 ok, 1 check failed (verify/restore-check found a problem), 2 refused/usage. */
export const OPERATOR_EXIT = Object.freeze({ OK: 0, FAILED: 1, REFUSED: 2 });

const USAGE = [
  'usage: n8n-lego credentials <command>',
  '',
  '  status                      key lineage, fingerprints and record counts (no material)',
  '  verify                      open every sealed record; exit 1 if any is unreadable',
  '  rotate [--batch N] [--max-batches M]',
  '                              rotate the credential key (server must be stopped);',
  '                              --max-batches stops early, `recover` finishes the rest',
  '  recover                     finish an interrupted rotation (server must be stopped)',
  '  backup <file>               write an encrypted credential backup (0600, never overwrites)',
  '  restore-check <file>        quarantine-validate a backup; writes nothing',
  '  restore <file> [--merge]    restore a validated backup (server must be stopped)',
  '',
  'A backup is sealed with the CURRENT key. A finished rotation destroys the previous',
  "key's material, so backups taken before it can no longer be restored: take a new",
  'backup right after every rotation.',
].join('\n');

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function positiveInt(value, name, max) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw new OperatorRefusal(`${name} must be an integer between 1 and ${max}`);
  }
  return number;
}

class OperatorRefusal extends Error {}

function positional(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      if (args[i] === '--batch' || args[i] === '--max-batches') i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/**
 * @param {object} params
 * @param {string} params.command one of OPERATOR_COMMANDS (or help)
 * @param {string[]} [params.args]
 * @param {object} params.config loadConfig() result (storage, dataDir)
 * @param {object} params.store createStore(config) result
 * @param {() => Promise<boolean>} params.serverRunning probe of the configured port
 * @param {{ out: (line: string) => void, err: (line: string) => void }} params.io
 * @returns {Promise<number>} exit code
 */
export async function runCredentialCommand({ command, args = [], config, store, serverRunning, io }) {
  const out = (value) => io.out(typeof value === 'string' ? value : JSON.stringify(value));
  const fail = (message) => {
    io.err(`n8n-lego credentials: ${message}`);
    return OPERATOR_EXIT.REFUSED;
  };

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.out(USAGE);
    return command === undefined ? OPERATOR_EXIT.REFUSED : OPERATOR_EXIT.OK;
  }
  if (!OPERATOR_COMMANDS.includes(command)) return fail(`unknown command '${command}'\n${USAGE}`);
  if (config?.storage !== 'file') return fail('operator commands need file storage (N8N_LEGO_STORAGE=file); memory storage has no durable keyring');

  if (MUTATING.has(command)) {
    let running = true;
    try {
      running = await serverRunning();
    } catch {
      running = true; // cannot prove it is stopped -> refuse
    }
    if (running) {
      return fail(`'${command}' refused: the server is running on the configured port. Stop it first — a live server would overwrite this change and could re-seal records under a retired key.`);
    }
  }

  const sealedSets = [store.credentials, mfaSecretCollection(store.users)];
  const sealedCount = store.credentials.all().filter((record) => record.secret !== undefined).length + sealedSets[1].all().length;
  const keyringFile = join(config.dataDir, KEYRING_FILE);

  if (!existsSync(keyringFile)) {
    if (command === 'status') {
      out({ keyring: null, sealedRecords: sealedCount, note: sealedCount === 0 ? 'no keyring yet: nothing is sealed' : 'KEYRING MISSING while sealed records exist' });
      return sealedCount === 0 ? OPERATOR_EXIT.OK : OPERATOR_EXIT.FAILED;
    }
    return fail(sealedCount === 0 ? 'no keyring yet: nothing is sealed, nothing to operate on' : `keyring missing (${KEYRING_FILE}) while ${sealedCount} sealed records exist. Restore the keyring file from your key backup; this tool never mints a replacement key.`);
  }

  let provider;
  try {
    provider = createLocalKeyProvider({ file: keyringFile, allowCreate: false });
  } catch (error) {
    return fail(`keyring unreadable: ${error?.details?.reason ?? error?.code ?? 'unknown'}`);
  }
  const vault = createCredentialVault({
    provider,
    onEvent: (event, detail) => out({ audit: event, ...detail }),
  });

  try {
    switch (command) {
      case 'status': {
        const metadata = vault.recoveryMetadata(store.credentials);
        out({
          keyring: metadata.keyring,
          rotationPending: provider.previousKeyRef() !== null,
          credentialsByKeyRef: metadata.recordsByKeyRef,
          mfaSecrets: sealedSets[1].all().length,
          legacyPlaintext: metadata.legacyPlaintext,
          cryptoVersion: metadata.cryptoVersion,
        });
        return OPERATOR_EXIT.OK;
      }
      case 'verify': {
        const report = vault.verify(sealedSets);
        out({ total: report.total, readable: report.readable, unreadable: report.unreadable });
        return report.unreadable.length === 0 ? OPERATOR_EXIT.OK : OPERATOR_EXIT.FAILED;
      }
      case 'rotate': {
        if (provider.previousKeyRef() !== null) {
          return fail("a rotation is already pending: run 'n8n-lego credentials recover' to finish it first");
        }
        const batchSize = positiveInt(option(args, '--batch'), '--batch', VAULT_LIMITS.maxBatchSize);
        const maxBatches = positiveInt(option(args, '--max-batches'), '--max-batches', 1_000_000);
        vault.startRotation();
        let batches = 0;
        let step = { done: false, remaining: sealedCount };
        while (!step.done && (maxBatches === undefined || batches < maxBatches)) {
          step = vault.stepRotation(sealedSets, batchSize === undefined ? {} : { batchSize });
          batches += 1;
        }
        if (!step.done) {
          out({ rotation: 'paused', batches, remaining: step.remaining, next: "run 'n8n-lego credentials recover' to finish" });
          return OPERATOR_EXIT.OK;
        }
        const { retired } = vault.finishRotation(sealedSets);
        out({ rotation: 'finished', batches, retired, current: provider.currentKeyRef(), warning: 'backups taken before this rotation can no longer be restored; take a new backup now' });
        return OPERATOR_EXIT.OK;
      }
      case 'recover': {
        const result = vault.recover(sealedSets);
        out({ ...result, current: provider.currentKeyRef() });
        return OPERATOR_EXIT.OK;
      }
      case 'backup': {
        const [file] = positional(args);
        if (!file) return fail('backup needs a target file');
        if (existsSync(file)) return fail(`refusing to overwrite existing file ${file}`);
        const bundle = vault.exportBackup(store.credentials);
        const tmp = `${file}.tmp-${process.pid}`;
        writeFileSync(tmp, `${JSON.stringify(bundle)}\n`, { mode: 0o600, flag: 'wx' });
        renameSync(tmp, file);
        out({ backup: file, backupId: bundle.backupId, tenantId: bundle.tenantId, createdAt: bundle.createdAt, sealedWith: bundle.manifest.keyRef });
        return OPERATOR_EXIT.OK;
      }
      case 'restore-check':
      case 'restore': {
        const [file] = positional(args);
        if (!file) return fail(`${command} needs a backup file`);
        let bundle;
        try {
          bundle = JSON.parse(readFileSync(file, 'utf8'));
        } catch {
          return fail(`${file} is not a readable backup file`);
        }
        if (command === 'restore-check') {
          try {
            const checked = vault.validateBackup(bundle);
            out({ valid: true, backupId: bundle.backupId, count: checked.count, keyFingerprints: checked.keyFingerprints });
            return OPERATOR_EXIT.OK;
          } catch (error) {
            out({ valid: false, reason: error?.details?.reason ?? 'unknown', code: error?.code ?? null });
            return OPERATOR_EXIT.FAILED;
          }
        }
        const result = vault.restoreBackup(bundle, store.credentials, { mode: args.includes('--merge') ? 'merge' : 'replace' });
        out({ ...result, backupId: bundle.backupId });
        return OPERATOR_EXIT.OK;
      }
      default:
        return fail(`unknown command '${command}'`);
    }
  } catch (error) {
    if (error instanceof OperatorRefusal) return fail(error.message);
    // Vault errors carry a code and a reason; never a stack or material.
    io.err(`n8n-lego credentials: ${command} failed: ${error?.details?.reason ?? error?.code ?? 'unknown'}`);
    return OPERATOR_EXIT.FAILED;
  }
}
