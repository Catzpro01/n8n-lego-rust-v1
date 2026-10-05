/**
 * P5.5 (#218) — the credential vault: the ONLY place a credential secret is
 * sealed or opened.
 *
 * Stored record shape after P5.5 (metadata and non-secret configuration stay in
 * the clear so the editor never needs a decrypt; only the runtime secret is
 * sealed — this is P5.4's split, made physical):
 *
 *   { id, name, type, tenantId, ownerId, credentialVersion, createdAt, updatedAt,
 *     config: { ...non-secret fields },
 *     secretKeys: [ ...names of sealed fields ],   // schema, not secret
 *     secret: <envelope> }
 *
 * Operations and their failure direction (#218: everything fails CLOSED):
 *
 *   seal / open               missing key, wrong key, tamper, AAD substitution,
 *                             version mismatch -> throw; never plaintext
 *   rotation                  start -> step (incremental, bounded batches) ->
 *                             finish. Each moved record is verified by opening
 *                             it under the new key BEFORE it is written.
 *   interrupted rotation      the keyring records the rotation; `recover()`
 *                             resumes it. Both keys stay readable meanwhile.
 *   abort (rollback)          previous key becomes current; records are moved
 *                             back by the same step machinery; nothing is lost
 *   legacy plaintext          `migrateLegacyPlaintext` seals pre-P5.5 records
 *                             once; afterwards `open` REFUSES a plaintext record
 *                             instead of reading it
 *   backup                    an encrypted manifest wrapping the already-sealed
 *                             records plus per-record digests
 *   restore                   full quarantine validation first; commit is one
 *                             atomic replace; any failure writes nothing
 */

import { createHash, randomBytes } from 'node:crypto';
import { SecurityError } from './security-error.mjs';
import { KEY_PURPOSE } from './key-provider.mjs';
import { CRYPTO_VERSION, openEnvelope, sealEnvelope } from './credential-envelope.mjs';

export const VAULT_LIMITS = Object.freeze({
  defaultBatchSize: 64,
  maxBatchSize: 1024,
  maxBackupRecords: 100_000,
});

export const BACKUP_FORMAT = 'n8n-lego/credential-backup';
export const BACKUP_FORMAT_VERSION = 1;

function vaultError(code, reason, message, details = {}) {
  return new SecurityError(code, message, { details: { reason, ...details } });
}

function bindingOf(record) {
  return {
    tenantId: typeof record?.tenantId === 'string' && record.tenantId !== '' ? record.tenantId : 'default',
    credentialId: record?.id,
    type: record?.type,
  };
}

function digestOf(record) {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

/**
 * Apply a batch of record replacements with ONE persist when the collection
 * supports it. `Collection.update` rewrites the whole file on every call, so
 * per-record updates make rotation O(n^2) in I/O (measured: 2,000 records took
 * 5.3 s). A batch is still atomic — `replaceAll` is a single tmp+rename — and a
 * crash between batches is exactly the resumable state rotation is built for.
 *
 * @param {object} collection
 * @param {Map<string, (current: object) => object>} changes id -> transform
 */
function commitBatch(collection, changes) {
  if (changes.size === 0) return;
  if (typeof collection.replaceAll === 'function') {
    collection.replaceAll(collection.all().map((record) => (changes.has(record.id) ? changes.get(record.id)(record) : record)));
    return;
  }
  for (const [id, transform] of changes) collection.update(id, transform);
}

/**
 * P5.6: the vault can manage several record sets on ONE key lineage (the
 * credentials collection plus the MFA-secret view over users). Every rotation
 * entry point accepts a collection or an array of collections, and a key is
 * only retired after ALL of them are verified on the current key.
 */
function collectionsOf(input) {
  const list = Array.isArray(input) ? input : [input];
  if (list.length === 0 || list.some((c) => !c || typeof c.all !== 'function')) {
    throw vaultError('lego.contract_violation', 'bad-collection', 'rotation needs one or more collections');
  }
  return list;
}

function isLegacyPlaintext(record) {
  return record && record.secret === undefined && record.data !== undefined;
}

/**
 * @param {object} options
 * @param {object} options.provider a KeyProvider
 * @param {(type: string) => Set<string>|null} [options.secretFieldsFor]
 *   which fields of a type are secret; null => all (used by legacy migration)
 * @param {(event: string, detail: object) => void} [options.onEvent]
 *   audit hook. Details are identifiers and counts only — never material.
 */
export function createCredentialVault({ provider, secretFieldsFor = () => null, onEvent = null, now = Date.now } = {}) {
  if (!provider || typeof provider.deriveKey !== 'function') {
    throw new TypeError('createCredentialVault requires a KeyProvider');
  }
  const emit = (event, detail) => {
    if (onEvent) onEvent(event, detail);
  };

  /* ------------------------------------------------------------ seal / open */

  function seal(binding, secret) {
    const keyRef = provider.currentKeyRef();
    return sealEnvelope(secret, binding, { keyRef, key: provider.deriveKey(keyRef, KEY_PURPOSE.CREDENTIAL) });
  }

  function openWithBinding(envelope, binding) {
    if (!provider.readableKeyRefs().includes(envelope?.keyRef)) {
      // Outside the controlled read window (unknown, retired or malformed ref):
      // refuse before touching any key material.
      throw vaultError('lego.unavailable', 'key-outside-read-window', 'credential key is not in the read window', {
        keyRef: typeof envelope?.keyRef === 'string' ? envelope.keyRef.slice(0, 24) : null,
        credentialId: binding.credentialId,
      });
    }
    return openEnvelope(envelope, binding, { key: provider.deriveKey(envelope.keyRef, KEY_PURPOSE.CREDENTIAL) });
  }

  /** Open a stored record's secret. No plaintext fallback, by construction. */
  function open(record) {
    if (isLegacyPlaintext(record)) {
      throw vaultError('lego.migration_required', 'legacy-plaintext-record', 'credential predates encryption and must be migrated', {
        credentialId: record.id,
      });
    }
    if (record?.secret === undefined) return {};
    return openWithBinding(record.secret, bindingOf(record));
  }

  /**
   * Build the stored secret-bearing fields for a record from a full `data`
   * object, splitting by the type's secret field set.
   */
  function sealData(record, data) {
    const secretFields = secretFieldsFor(record.type);
    const config = {};
    const secret = {};
    for (const [key, value] of Object.entries(data && typeof data === 'object' ? data : {})) {
      if (secretFields === null || secretFields.has(key)) secret[key] = value;
      else config[key] = value;
    }
    const envelope = seal(bindingOf(record), secret);
    return { config, secretKeys: Object.keys(secret).sort(), secret: envelope, cryptoVersion: CRYPTO_VERSION };
  }

  /**
   * P5.6: seal a whole secret object for a non-credential record (e.g. a
   * user's TOTP secret). Same envelope, same AAD discipline, same key lineage.
   * @param {{ id: string, tenantId?: string, type: string }} record binding
   */
  function sealSecret(record, secret) {
    return seal(bindingOf(record), secret);
  }

  /** The full `data` object (config + opened secret) — for the write boundary only. */
  function openData(record) {
    return { ...(record?.config ?? {}), ...open(record) };
  }

  /* --------------------------------------------------- legacy plaintext */

  /**
   * Seal every pre-P5.5 record that still holds plaintext `data`. Each record is
   * verified by opening it before the plaintext is dropped.
   *
   * @param {{ all(): object[], update(id: string, patch: Function): object|null }} collection
   */
  function migrateLegacyPlaintext(collection) {
    const changes = new Map();
    for (const record of collection.all()) {
      if (!isLegacyPlaintext(record)) continue;
      const bound = { ...record, tenantId: bindingOf(record).tenantId };
      const sealed = sealData(bound, record.data);
      const check = openWithBinding(sealed.secret, bindingOf(bound));
      const expected = Object.fromEntries(sealed.secretKeys.map((k) => [k, record.data[k]]));
      if (JSON.stringify(check) !== JSON.stringify(expected)) {
        throw vaultError('storage.unavailable', 'migration-verify-failed', 'sealed credential did not verify', { credentialId: record.id });
      }
      changes.set(record.id, (current) => {
        const { data: _plaintext, ...rest } = current;
        return { ...rest, tenantId: bound.tenantId, ...sealed };
      });
    }
    commitBatch(collection, changes);
    const migrated = changes.size;
    if (migrated > 0) emit('credential.legacy-migrated', { migrated });
    return { migrated };
  }

  /* ------------------------------------------------------------- rotation */

  function recordsNotOnCurrent(collection) {
    const current = provider.currentKeyRef();
    return collection.all().filter((record) => record.secret !== undefined && record.secret !== null && record.secret.keyRef !== current);
  }

  /** Re-seal one record onto the current key, verified; returns the transform to apply. */
  function reencrypt(record) {
    const binding = bindingOf(record);
    const secret = openWithBinding(record.secret, binding);
    const envelope = seal(binding, secret);
    const verify = openWithBinding(envelope, binding);
    if (JSON.stringify(verify) !== JSON.stringify(secret)) {
      throw vaultError('storage.unavailable', 'reencrypt-verify-failed', 're-encrypted credential did not verify', { credentialId: record.id });
    }
    return (current) => ({ ...current, secret: envelope });
  }

  function startRotation() {
    const result = provider.beginRotation();
    emit('credential.rotation-started', result);
    return result;
  }

  /**
   * Re-encrypt up to `batchSize` records. Idempotent and resumable: the work
   * list is recomputed from the store every call, so a crash between batches
   * (or between records) loses nothing.
   */
  function stepRotation(collection, { batchSize = VAULT_LIMITS.defaultBatchSize } = {}) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > VAULT_LIMITS.maxBatchSize) {
      throw vaultError('lego.contract_violation', 'bad-batch-size', 'batchSize is out of bounds', { batchSize });
    }
    // The batch budget is shared across collections, filled in order.
    let budget = batchSize;
    let moved = 0;
    let remaining = 0;
    for (const target of collectionsOf(collection)) {
      const pending = recordsNotOnCurrent(target);
      const batch = pending.slice(0, budget);
      budget -= batch.length;
      // Verify every record in the batch BEFORE anything is written; then one
      // atomic persist for the whole batch.
      const changes = new Map(batch.map((record) => [record.id, reencrypt(record)]));
      commitBatch(target, changes);
      moved += batch.length;
      remaining += pending.length - batch.length;
    }
    return { moved, remaining, done: remaining === 0 };
  }

  /**
   * Retire the previous key — only after proving that no record references it
   * and that every record opens under the current key.
   */
  function finishRotation(collection) {
    const previous = provider.previousKeyRef();
    if (!previous) return { retired: null };
    const stragglers = collectionsOf(collection).flatMap((target) => recordsNotOnCurrent(target));
    if (stragglers.length > 0) {
      throw vaultError('lego.migration_required', 'rotation-incomplete', 'records still reference the previous key', {
        remaining: stragglers.length,
      });
    }
    const report = verify(collection);
    if (report.unreadable.length > 0) {
      throw vaultError('storage.unavailable', 'verification-failed', 'some credentials do not open under the current key', {
        unreadable: report.unreadable.length,
      });
    }
    provider.retire(previous);
    emit('credential.rotation-finished', { retired: previous, current: provider.currentKeyRef(), records: report.total });
    return { retired: previous };
  }

  /** Convenience: the whole rotation in bounded batches. */
  function rotate(collection, { batchSize } = {}) {
    const started = startRotation();
    let steps = 0;
    for (;;) {
      const { done } = stepRotation(collection, { batchSize });
      steps += 1;
      if (done) break;
    }
    const { retired } = finishRotation(collection);
    return { ...started, steps, retired };
  }

  /** Rollback: previous becomes current, records move back, the target is retired. */
  function abortRotation(collection, { batchSize } = {}) {
    const flipped = provider.abortRotation();
    emit('credential.rotation-aborted', flipped);
    for (;;) {
      if (stepRotation(collection, { batchSize }).done) break;
    }
    const { retired } = finishRotation(collection);
    return { ...flipped, retired };
  }

  /**
   * Resume whatever an interrupted process left behind. Safe to call on every
   * boot: with no rotation pending it is a no-op.
   */
  function recover(collection, { batchSize } = {}) {
    if (!provider.previousKeyRef()) return { recovered: false };
    for (;;) {
      if (stepRotation(collection, { batchSize }).done) break;
    }
    const { retired } = finishRotation(collection);
    emit('credential.rotation-recovered', { retired });
    return { recovered: true, retired };
  }

  /* ------------------------------------------------- verification / recovery */

  /** Open every record; report (never throw) which do not. Material is discarded. */
  function verify(collection) {
    const unreadable = [];
    let total = 0;
    for (const record of collectionsOf(collection).flatMap((target) => target.all())) {
      total += 1;
      try {
        open(record);
      } catch (error) {
        unreadable.push({ credentialId: record.id, reason: error?.details?.reason ?? 'unknown' });
      }
    }
    return { total, readable: total - unreadable.length, unreadable };
  }

  /** What an operator needs to recover: lineage, fingerprints, counts. No material. */
  function recoveryMetadata(collection) {
    const byKeyRef = {};
    let plaintext = 0;
    for (const record of collection.all()) {
      if (isLegacyPlaintext(record)) plaintext += 1;
      else if (record.secret) byKeyRef[record.secret.keyRef] = (byKeyRef[record.secret.keyRef] ?? 0) + 1;
    }
    return Object.freeze({ keyring: provider.state(), recordsByKeyRef: byKeyRef, legacyPlaintext: plaintext, cryptoVersion: CRYPTO_VERSION });
  }

  /* ------------------------------------------------------ backup / restore */

  function backupBinding(tenantId, backupId) {
    return { tenantId, credentialId: `backup:${backupId}`, type: 'n8n-lego/backup-manifest' };
  }

  /**
   * Export an encrypted backup of one tenant's credentials. The records inside
   * are ALREADY sealed; the manifest adds a second, backup-purpose envelope so
   * even record metadata is not readable from the file.
   */
  function exportBackup(collection, { tenantId = 'default' } = {}) {
    const records = collection.all().filter((record) => bindingOf(record).tenantId === tenantId);
    if (records.some(isLegacyPlaintext)) {
      throw vaultError('lego.migration_required', 'legacy-plaintext-record', 'refusing to back up unencrypted credentials');
    }
    if (records.length > VAULT_LIMITS.maxBackupRecords) {
      throw vaultError('lego.contract_violation', 'backup-too-large', 'too many records for one backup', { count: records.length });
    }
    const backupId = randomBytes(9).toString('base64url');
    const createdAt = new Date(now()).toISOString();
    const keyRefs = [...new Set(records.map((record) => record.secret?.keyRef).filter(Boolean))].sort();
    const manifest = {
      tenantId,
      createdAt,
      count: records.length,
      keyFingerprints: Object.fromEntries(keyRefs.map((ref) => [ref, provider.fingerprint(ref)])),
      digests: records.map(digestOf),
      records,
    };
    const keyRef = provider.currentKeyRef();
    const envelope = sealEnvelope(manifest, backupBinding(tenantId, backupId), {
      keyRef,
      key: provider.deriveKey(keyRef, KEY_PURPOSE.BACKUP),
    });
    emit('credential.backup-exported', { tenantId, backupId, count: records.length });
    return Object.freeze({ format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, backupId, tenantId, createdAt, manifest: envelope });
  }

  /**
   * Quarantine validation. Runs every check and returns the decoded records, or
   * throws. Writes nothing — this is also the restore DRILL.
   */
  function validateBackup(bundle, { tenantId = 'default' } = {}) {
    const reject = (reason, details = {}) =>
      vaultError(reason === 'cross-tenant' ? 'auth.forbidden' : 'lego.contract_violation', reason, `backup rejected: ${reason}`, details);

    if (!bundle || bundle.format !== BACKUP_FORMAT) throw reject('not-a-backup');
    if (bundle.formatVersion !== BACKUP_FORMAT_VERSION) throw reject('unsupported-backup-version', { formatVersion: bundle.formatVersion });
    if (typeof bundle.backupId !== 'string' || typeof bundle.tenantId !== 'string') throw reject('malformed-backup');
    if (bundle.tenantId !== tenantId) throw reject('cross-tenant', { backupTenant: bundle.tenantId, targetTenant: tenantId });

    if (!provider.readableKeyRefs().includes(bundle.manifest?.keyRef)) {
      throw vaultError('lego.unavailable', 'backup-key-unavailable', 'the key this backup was sealed with is not available', {
        keyRef: typeof bundle.manifest?.keyRef === 'string' ? bundle.manifest.keyRef.slice(0, 24) : null,
      });
    }
    // Outer tenant is authenticated here: it is part of the AAD.
    const manifest = openEnvelope(bundle.manifest, backupBinding(bundle.tenantId, bundle.backupId), {
      key: provider.deriveKey(bundle.manifest.keyRef, KEY_PURPOSE.BACKUP),
    });

    if (manifest.tenantId !== tenantId) throw reject('cross-tenant', { manifestTenant: manifest.tenantId });
    if (!Array.isArray(manifest.records) || !Array.isArray(manifest.digests)) throw reject('malformed-manifest');
    if (manifest.count !== manifest.records.length || manifest.count !== manifest.digests.length) {
      throw reject('partial-backup', { declared: manifest.count, records: manifest.records.length, digests: manifest.digests.length });
    }
    const ids = new Set();
    manifest.records.forEach((record, index) => {
      if (digestOf(record) !== manifest.digests[index]) throw reject('digest-mismatch', { index });
      if (bindingOf(record).tenantId !== tenantId) throw reject('cross-tenant', { index });
      if (ids.has(record.id)) throw reject('duplicate-record', { index });
      ids.add(record.id);
      if (isLegacyPlaintext(record)) throw reject('plaintext-in-backup', { index });
      // Trial-open every record; the plaintext is discarded immediately. A
      // missing key or a corrupt envelope fails the whole restore.
      open(record);
    });
    return { records: manifest.records, count: manifest.count, keyFingerprints: manifest.keyFingerprints };
  }

  /**
   * Restore after quarantine. Commit is a single `replaceAll`, i.e. one atomic
   * persist — either every record lands or none does.
   *
   * @param {'replace'|'merge'} [mode] replace = the tenant's records become
   *   exactly the backup's; merge = backup records win on id conflict
   */
  function restoreBackup(bundle, collection, { tenantId = 'default', mode = 'replace' } = {}) {
    if (mode !== 'replace' && mode !== 'merge') throw vaultError('lego.contract_violation', 'bad-restore-mode', 'unknown restore mode');
    const { records, count } = validateBackup(bundle, { tenantId });
    const others = collection.all().filter((record) => bindingOf(record).tenantId !== tenantId);
    const restoredIds = new Set(records.map((record) => record.id));
    const kept =
      mode === 'merge'
        ? collection.all().filter((record) => bindingOf(record).tenantId === tenantId && !restoredIds.has(record.id))
        : [];
    collection.replaceAll([...others, ...kept, ...records.map((record) => structuredClone(record))]);
    emit('credential.backup-restored', { tenantId, backupId: bundle.backupId, count, mode });
    return { restored: count, mode };
  }

  return Object.freeze({
    seal,
    open,
    sealData,
    sealSecret,
    openData,
    migrateLegacyPlaintext,
    startRotation,
    stepRotation,
    finishRotation,
    rotate,
    abortRotation,
    recover,
    verify,
    recoveryMetadata,
    exportBackup,
    validateBackup,
    restoreBackup,
    provider: Object.freeze({ state: () => provider.state() }),
  });
}

/* ------------------------------------------------------------------ boot */

/** Keyring file name inside the data directory. Never inside a credential record. */
export const KEYRING_FILE = '.credential-keys.json';

/**
 * Composition-root helper: build the vault for a running instance.
 *
 *   - file storage   -> local-file keyring at `<dataDir>/.credential-keys.json`
 *   - memory storage -> in-memory keyring (the credentials are not durable either)
 *
 * A NEW key may be minted only while nothing is sealed yet. If sealed records
 * exist and the keyring is missing or unreadable, this returns
 * `{ vault: null, error }` — the caller keeps serving metadata but every secret
 * operation answers 503. That is failing closed without taking the editor down.
 *
 * On success it also (1) migrates any pre-P5.5 plaintext record and (2) resumes
 * a rotation an earlier process was interrupted in.
 *
 * @returns {{ vault: object|null, error: object|null, report: object|null }}
 */
export async function bootCredentialVault({ config, store, secretFieldsFor, onEvent = null }) {
  const { createLocalKeyProvider, createMemoryKeyProvider } = await import('./key-provider.mjs');
  const { mfaSecretCollection } = await import('./mfa.mjs');
  const { join } = await import('node:path');
  try {
    // P5.6: users' sealed TOTP secrets live on the same key lineage. They count
    // as sealed material (so a missing keyring can never mint a fresh key over
    // them) and they are recovered and verified with the credentials.
    const mfaSecrets = store.users ? mfaSecretCollection(store.users) : null;
    const sealedSets = mfaSecrets ? [store.credentials, mfaSecrets] : [store.credentials];
    const nothingSealed =
      store.credentials.all().every((record) => record.secret === undefined) && (!mfaSecrets || mfaSecrets.all().length === 0);
    const provider =
      config.storage === 'memory'
        ? createMemoryKeyProvider()
        : createLocalKeyProvider({ file: join(config.dataDir, KEYRING_FILE), allowCreate: nothingSealed });
    const vault = createCredentialVault({ provider, secretFieldsFor, onEvent });
    const migrated = vault.migrateLegacyPlaintext(store.credentials);
    const recovered = vault.recover(sealedSets);
    const verified = vault.verify(sealedSets);
    return { vault, error: null, report: { ...migrated, ...recovered, total: verified.total, unreadable: verified.unreadable.length } };
  } catch (error) {
    return {
      vault: null,
      error: { code: error?.code ?? 'lego.unavailable', reason: error?.details?.reason ?? 'unknown' },
      report: null,
    };
  }
}
