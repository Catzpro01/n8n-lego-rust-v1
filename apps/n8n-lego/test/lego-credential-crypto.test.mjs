/**
 * P5.5 (#218) — KeyProvider, envelope encryption, rotation and recovery.
 *
 * Maps one-to-one onto the #218 acceptance list:
 *   round-trip · tamper/AAD substitution · rotation + interrupted-rotation
 *   recovery · backup restore drill in isolated state · no secret material in
 *   logs/test artifacts · every failure mode fails closed.
 *
 * Interrupted rotation is exercised with the REAL file provider: a "crash" is a
 * fresh provider + vault built from the same keyring file and the same stored
 * records, exactly what a restarted process sees.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KEY_PURPOSE,
  createLocalKeyProvider,
  createMemoryKeyProvider,
  isKeyRef,
} from '../src/auth/security/key-provider.mjs';
import {
  CRYPTO_VERSION,
  MAX_PLAINTEXT_BYTES,
  associatedData,
  openEnvelope,
  sealEnvelope,
} from '../src/auth/security/credential-envelope.mjs';
import {
  KEYRING_FILE,
  bootCredentialVault,
  createCredentialVault,
} from '../src/auth/security/credential-vault.mjs';
import { credentialRoutes } from '../src/compat/credentials.mjs';
import { Collection } from '../src/store.mjs';

/** Unmistakable secrets: any appearance in output is a leak, never a coincidence. */
const SECRET = 'P55-SECRET-a91f7c3e-DO-NOT-LEAK';
const secretFor = (i) => `P55-SECRET-${i}-7d2b9e41-DO-NOT-LEAK`;
const HEADER = new Set(['value']);
const secretFieldsFor = (type) => (type === 'httpHeaderAuth' ? HEADER : null);

function memoryCollection(initial = []) {
  const docs = structuredClone(initial);
  return {
    docs,
    all: () => docs,
    get: (id) => docs.find((d) => d.id === id) ?? null,
    update(id, patch) {
      const i = docs.findIndex((d) => d.id === id);
      if (i === -1) return null;
      docs[i] = typeof patch === 'function' ? patch(docs[i]) : { ...docs[i], ...patch };
      return docs[i];
    },
    replaceAll(next) {
      docs.length = 0;
      docs.push(...next);
    },
  };
}

function sealedRecords(vault, n, tenantId = 'default') {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const base = { id: `cred${i}`, type: 'httpHeaderAuth', tenantId, credentialVersion: 1, name: `c${i}` };
    out.push({ ...base, ...vault.sealData(base, { name: `X-${i}`, value: secretFor(i) }) });
  }
  return out;
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'n8n-lego-p55-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/* ================================================================ round trip */

describe('envelope round-trip', () => {
  const provider = createMemoryKeyProvider();
  const keyRef = provider.currentKeyRef();
  const key = provider.deriveKey(keyRef, KEY_PURPOSE.CREDENTIAL);
  const binding = { tenantId: 'default', credentialId: 'abc', type: 'httpHeaderAuth' };

  test('seal then open returns the exact object', () => {
    const secret = { value: SECRET, nested: { a: [1, 2, 3] }, unicode: 'kunci rahasia — 秘密 🔑' };
    const envelope = sealEnvelope(secret, binding, { keyRef, key });
    assert.deepEqual(openEnvelope(envelope, binding, { key }), secret);
  });

  test('the envelope has exactly the versioned shape and no plaintext', () => {
    const envelope = sealEnvelope({ value: SECRET }, binding, { keyRef, key });
    assert.deepEqual(Object.keys(envelope).sort(), ['alg', 'cryptoVersion', 'ct', 'iv', 'keyRef', 'tag']);
    assert.equal(envelope.cryptoVersion, CRYPTO_VERSION);
    assert.equal(envelope.alg, 'A256GCM');
    assert.equal(JSON.stringify(envelope).includes(SECRET), false);
  });

  test('two seals of the same secret differ (fresh IV every time)', () => {
    const a = sealEnvelope({ value: SECRET }, binding, { keyRef, key });
    const b = sealEnvelope({ value: SECRET }, binding, { keyRef, key });
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ct, b.ct);
  });

  test('an empty secret round-trips', () => {
    assert.deepEqual(openEnvelope(sealEnvelope({}, binding, { keyRef, key }), binding, { key }), {});
  });

  test('an oversized secret is refused at seal time', () => {
    assert.throws(
      () => sealEnvelope({ value: 'x'.repeat(MAX_PLAINTEXT_BYTES + 1) }, binding, { keyRef, key }),
      (e) => e.details?.reason === 'plaintext-too-large',
    );
  });
});

/* =================================================== tamper / AAD substitution */

describe('tampering and associated-data substitution fail closed', () => {
  const provider = createMemoryKeyProvider();
  const keyRef = provider.currentKeyRef();
  const key = provider.deriveKey(keyRef, KEY_PURPOSE.CREDENTIAL);
  const binding = { tenantId: 't1', credentialId: 'cred-A', type: 'httpHeaderAuth' };
  const envelope = sealEnvelope({ value: SECRET }, binding, { keyRef, key });

  const flip = (b64) => {
    const bytes = Buffer.from(b64, 'base64url');
    bytes[0] ^= 0x01;
    return bytes.toString('base64url');
  };
  const authFailed = (e) => e.code === 'storage.unavailable' && e.details?.reason === 'authentication-failed';

  for (const field of ['ct', 'tag', 'iv']) {
    test(`a flipped bit in ${field} is refused`, () => {
      assert.throws(() => openEnvelope({ ...envelope, [field]: flip(envelope[field]) }, binding, { key }), authFailed);
    });
  }

  for (const [label, changed] of [
    ['credentialId (copy A onto B)', { credentialId: 'cred-B' }],
    ['tenantId (move across tenants)', { tenantId: 't2' }],
    ['type (relabel the credential)', { type: 'oAuth2Api' }],
  ]) {
    test(`substituting ${label} is refused`, () => {
      assert.throws(() => openEnvelope(envelope, { ...binding, ...changed }, { key }), authFailed);
    });
  }

  test('swapping keyRef to another key is refused', () => {
    const other = createMemoryKeyProvider();
    const otherRef = other.currentKeyRef();
    // Same bytes, different declared key: the AAD no longer matches.
    assert.throws(() => openEnvelope({ ...envelope, keyRef: otherRef }, binding, { key }), authFailed);
  });

  test('the wrong key is refused, indistinguishably from tampering', () => {
    const other = createMemoryKeyProvider();
    const wrong = other.deriveKey(other.currentKeyRef(), KEY_PURPOSE.CREDENTIAL);
    assert.throws(() => openEnvelope(envelope, binding, { key: wrong }), authFailed);
  });

  test('a version downgrade/upgrade is refused before any crypto', () => {
    assert.throws(
      () => openEnvelope({ ...envelope, cryptoVersion: 2 }, binding, { key }),
      (e) => e.code === 'lego.version_incompatible',
    );
    assert.throws(
      () => openEnvelope({ ...envelope, alg: 'A128GCM' }, binding, { key }),
      (e) => e.code === 'lego.version_incompatible',
    );
  });

  test('an extra or missing field is refused as malformed', () => {
    assert.throws(() => openEnvelope({ ...envelope, plaintext: SECRET }, binding, { key }), (e) => e.details?.reason === 'envelope-malformed');
    const { tag: _t, ...missing } = envelope;
    assert.throws(() => openEnvelope(missing, binding, { key }), (e) => e.details?.reason === 'envelope-malformed');
    assert.throws(() => openEnvelope(null, binding, { key }), (e) => e.details?.reason === 'envelope-malformed');
  });

  test('the AAD encodes every binding field unambiguously', () => {
    const a = associatedData({ tenantId: 'a|b', credentialId: 'c', type: 't' }, keyRef).toString();
    const b = associatedData({ tenantId: 'a', credentialId: 'b|c', type: 't' }, keyRef).toString();
    assert.notEqual(a, b);
  });

  test('no failure message or detail carries the secret', () => {
    try {
      openEnvelope({ ...envelope, ct: flip(envelope.ct) }, binding, { key });
    } catch (error) {
      assert.equal(JSON.stringify({ m: error.message, d: error.details }).includes(SECRET), false);
    }
  });
});

/* ================================================================ KeyProvider */

describe('KeyProvider custody and the controlled read window', () => {
  test('a missing keyring is an error unless creation is explicitly allowed', () => {
    const file = join(dir, KEYRING_FILE);
    assert.throws(() => createLocalKeyProvider({ file }), (e) => e.code === 'lego.unavailable' && e.details.reason === 'keyring-missing');
    assert.equal(existsSync(file), false, 'nothing was silently created');
    createLocalKeyProvider({ file, allowCreate: true });
    assert.equal(existsSync(file), true);
  });

  test('the keyring file is written 0600', () => {
    const file = join(dir, KEYRING_FILE);
    createLocalKeyProvider({ file, allowCreate: true });
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  test('a corrupt keyring is refused, never regenerated', () => {
    const file = join(dir, KEYRING_FILE);
    writeFileSync(file, '{not json');
    assert.throws(() => createLocalKeyProvider({ file, allowCreate: true }), (e) => e.details.reason === 'unparseable');
    writeFileSync(file, JSON.stringify({ version: 1, keys: [] }));
    assert.throws(() => createLocalKeyProvider({ file, allowCreate: true }), (e) => e.details.reason === 'no-keys');
  });

  test('state() exposes lineage and fingerprints but no key material', () => {
    const file = join(dir, KEYRING_FILE);
    const provider = createLocalKeyProvider({ file, allowCreate: true });
    const material = JSON.parse(readFileSync(file, 'utf8')).keys[0].material;
    const state = JSON.stringify(provider.state());
    assert.equal(state.includes(material), false);
    assert.ok(isKeyRef(provider.currentKeyRef()));
    assert.match(provider.fingerprint(provider.currentKeyRef()), /^[a-f0-9]{32}$/);
  });

  test('subkeys are separated by purpose', () => {
    const provider = createMemoryKeyProvider();
    const ref = provider.currentKeyRef();
    assert.notDeepEqual(provider.deriveKey(ref, KEY_PURPOSE.CREDENTIAL), provider.deriveKey(ref, KEY_PURPOSE.BACKUP));
    assert.throws(() => provider.deriveKey(ref, 'something-else'), (e) => e.details.reason === 'unknown-purpose');
  });

  test('the read window never exceeds current + one previous', () => {
    const provider = createMemoryKeyProvider();
    provider.beginRotation();
    assert.equal(provider.readableKeyRefs().length, 2);
    assert.throws(() => provider.beginRotation(), (e) => e.code === 'lego.migration_required' && e.details.reason === 'previous-key-still-live');
    assert.equal(provider.readableKeyRefs().length, 2);
  });

  test('retiring destroys material; a retired key derives nothing', () => {
    const file = join(dir, KEYRING_FILE);
    const provider = createLocalKeyProvider({ file, allowCreate: true });
    const { from } = provider.beginRotation();
    provider.retire(from);
    assert.throws(() => provider.deriveKey(from, KEY_PURPOSE.CREDENTIAL), (e) => e.details.reason === 'key-retired');
    const onDisk = JSON.parse(readFileSync(file, 'utf8')).keys.find((k) => k.keyRef === from);
    assert.equal(onDisk.material, undefined, 'material is gone from the file');
    assert.ok(onDisk.fingerprint, 'a fingerprint remains for recovery forensics');
  });

  test('only a previous key may be retired', () => {
    const provider = createMemoryKeyProvider();
    assert.throws(() => provider.retire(provider.currentKeyRef()), (e) => e.details.reason === 'only-previous-keys-may-retire');
  });
});

/* ====================================================== vault: no plaintext */

describe('the vault has no plaintext fallback', () => {
  test('a legacy plaintext record is refused on open', () => {
    const vault = createCredentialVault({ provider: createMemoryKeyProvider(), secretFieldsFor });
    assert.throws(
      () => vault.open({ id: 'old', type: 'httpHeaderAuth', data: { value: SECRET } }),
      (e) => e.code === 'lego.migration_required',
    );
  });

  test('legacy migration seals, verifies, and removes the plaintext', () => {
    const vault = createCredentialVault({ provider: createMemoryKeyProvider(), secretFieldsFor });
    const col = memoryCollection([{ id: 'old', type: 'httpHeaderAuth', data: { name: 'X-Old', value: SECRET } }]);
    assert.deepEqual(vault.migrateLegacyPlaintext(col), { migrated: 1 });
    const [record] = col.docs;
    assert.equal('data' in record, false);
    assert.equal(JSON.stringify(record).includes(SECRET), false);
    assert.deepEqual(record.config, { name: 'X-Old' }, 'non-secret config stays readable');
    assert.deepEqual(record.secretKeys, ['value']);
    assert.equal(vault.open(record).value, SECRET);
    assert.deepEqual(vault.migrateLegacyPlaintext(col), { migrated: 0 }, 'idempotent');
  });

  test('an unknown type seals every field', () => {
    const vault = createCredentialVault({ provider: createMemoryKeyProvider(), secretFieldsFor });
    const sealed = vault.sealData({ id: 'u', type: 'mystery', tenantId: 'default' }, { user: 'u', password: SECRET });
    assert.deepEqual(sealed.config, {});
    assert.deepEqual(sealed.secretKeys, ['password', 'user']);
  });

  test('a record whose key has been retired fails closed', () => {
    const provider = createMemoryKeyProvider();
    const vault = createCredentialVault({ provider, secretFieldsFor });
    const [stale] = sealedRecords(vault, 1);
    const col = memoryCollection(sealedRecords(vault, 3));
    vault.rotate(col);
    assert.throws(() => vault.open(stale), (e) => e.code === 'lego.unavailable' && e.details.reason === 'key-outside-read-window');
  });
});

/* ================================================================== rotation */

describe('rotation is incremental, verified, and preserves identity', () => {
  test('a full rotation moves every record and retires the old key', () => {
    const provider = createMemoryKeyProvider();
    const vault = createCredentialVault({ provider, secretFieldsFor });
    const col = memoryCollection(sealedRecords(vault, 10));
    const before = col.docs.map((r) => ({ id: r.id, v: r.credentialVersion, type: r.type, tenant: r.tenantId }));
    const result = vault.rotate(col, { batchSize: 3 });
    assert.equal(result.steps, 4, '10 records in batches of 3');
    assert.equal(result.retired, result.from);
    for (const record of col.docs) assert.equal(record.secret.keyRef, result.to);
    // Identity survives rotation: same id, version, type, tenant.
    assert.deepEqual(col.docs.map((r) => ({ id: r.id, v: r.credentialVersion, type: r.type, tenant: r.tenantId })), before);
    col.docs.forEach((record, i) => assert.equal(vault.open(record).value, secretFor(i)));
  });

  test('finish refuses while any record still references the previous key', () => {
    const vault = createCredentialVault({ provider: createMemoryKeyProvider(), secretFieldsFor });
    const col = memoryCollection(sealedRecords(vault, 5));
    vault.startRotation();
    vault.stepRotation(col, { batchSize: 2 });
    assert.throws(() => vault.finishRotation(col), (e) => e.details.reason === 'rotation-incomplete' && e.details.remaining === 3);
  });

  test('batch size is bounded', () => {
    const vault = createCredentialVault({ provider: createMemoryKeyProvider(), secretFieldsFor });
    const col = memoryCollection();
    for (const bad of [0, -1, 1.5, 10_000]) {
      assert.throws(() => vault.stepRotation(col, { batchSize: bad }), (e) => e.details.reason === 'bad-batch-size');
    }
  });

  test('abort rolls back: records return to the original key, nothing is lost', () => {
    const provider = createMemoryKeyProvider();
    const vault = createCredentialVault({ provider, secretFieldsFor });
    const col = memoryCollection(sealedRecords(vault, 6));
    const original = provider.currentKeyRef();
    vault.startRotation();
    vault.stepRotation(col, { batchSize: 4 }); // a mixed state
    const result = vault.abortRotation(col);
    assert.equal(provider.currentKeyRef(), original);
    for (const record of col.docs) assert.equal(record.secret.keyRef, original);
    assert.equal(result.retired, result.from, 'the aborted target key is retired');
    col.docs.forEach((record, i) => assert.equal(vault.open(record).value, secretFor(i)));
  });
});

/* ================================================= interrupted-rotation recovery */

describe('an interrupted rotation is recovered by a restarted process', () => {
  /** Build what a freshly started process would: a new provider from the same file. */
  const restart = (file) => {
    const provider = createLocalKeyProvider({ file });
    return { provider, vault: createCredentialVault({ provider, secretFieldsFor }) };
  };

  for (const [label, crash] of [
    ['right after the new key was minted, before any record moved', (vault, col) => vault.startRotation()],
    ['half-way through re-encryption', (vault, col) => {
      vault.startRotation();
      vault.stepRotation(col, { batchSize: 4 });
    }],
    ['after every record moved but before the old key was retired', (vault, col) => {
      vault.startRotation();
      while (!vault.stepRotation(col, { batchSize: 3 }).done);
    }],
  ]) {
    test(`crash ${label}`, () => {
      const file = join(dir, KEYRING_FILE);
      const first = createCredentialVault({ provider: createLocalKeyProvider({ file, allowCreate: true }), secretFieldsFor });
      const col = memoryCollection(sealedRecords(first, 9));
      crash(first, col);

      // ---- process dies here; a new one starts from the same keyring + store ----
      const { provider, vault } = restart(file);
      assert.ok(provider.pendingRotation(), 'the keyring remembers the rotation');
      assert.equal(vault.verify(col).unreadable.length, 0, 'mid-rotation, every record is still readable');

      const result = vault.recover(col);
      assert.equal(result.recovered, true);
      assert.equal(provider.previousKeyRef(), null, 'window closed again');
      assert.equal(provider.pendingRotation(), null);
      col.docs.forEach((record, i) => {
        assert.equal(record.secret.keyRef, provider.currentKeyRef());
        assert.equal(vault.open(record).value, secretFor(i));
      });
    });
  }

  test('recover() is a no-op when nothing is pending', () => {
    const file = join(dir, KEYRING_FILE);
    const vault = createCredentialVault({ provider: createLocalKeyProvider({ file, allowCreate: true }), secretFieldsFor });
    assert.deepEqual(vault.recover(memoryCollection()), { recovered: false });
  });
});


/* ============================================= end-to-end on the real store */

describe('real Collection + real keyring file, re-read from disk', () => {
  test('rotation persists in batches and a fresh process reads every record', () => {
    const file = join(dir, KEYRING_FILE);
    const store = join(dir, 'credentials.json');
    const vault = createCredentialVault({ provider: createLocalKeyProvider({ file, allowCreate: true }), secretFieldsFor });
    const col = new Collection(store);
    col.replaceAll(sealedRecords(vault, 600));
    const result = vault.rotate(col, { batchSize: 256 });
    assert.equal(result.steps, 3);

    // A new process: new provider from the keyring file, new Collection from disk.
    const reborn = createCredentialVault({ provider: createLocalKeyProvider({ file }), secretFieldsFor });
    const fromDisk = new Collection(store);
    assert.equal(fromDisk.count(), 600);
    assert.equal(readFileSync(store, 'utf8').includes(secretFor(123)), false, 'no plaintext on disk');
    fromDisk.all().forEach((record, i) => assert.equal(reborn.open(record).value, secretFor(i)));
    assert.equal(reborn.verify(fromDisk).unreadable.length, 0);
  });
});

/* ======================================================= backup / restore drill */

describe('backup restore drill in isolated state', () => {
  function setup(n = 5) {
    const provider = createMemoryKeyProvider();
    const vault = createCredentialVault({ provider, secretFieldsFor });
    const col = memoryCollection([...sealedRecords(vault, n), ...sealedRecords(vault, 2, 'tenant-other').map((r) => ({ ...r, id: `o-${r.id}` }))]);
    return { provider, vault, col };
  }

  test('the backup contains no plaintext secret and no key material', () => {
    const { vault, col } = setup();
    const bundle = JSON.stringify(vault.exportBackup(col));
    for (let i = 0; i < 5; i += 1) assert.equal(bundle.includes(secretFor(i)), false);
    assert.equal(bundle.includes('material'), false);
  });

  test('restore into an EMPTY, separate store round-trips every credential', () => {
    const { vault, col } = setup();
    const bundle = vault.exportBackup(col, { tenantId: 'default' });
    const isolated = memoryCollection(); // a different store, nothing shared
    assert.deepEqual(vault.restoreBackup(bundle, isolated), { restored: 5, mode: 'replace' });
    isolated.docs.forEach((record) => {
      const i = Number(record.id.replace('cred', ''));
      assert.equal(vault.open(record).value, secretFor(i));
    });
  });

  test('replace mode leaves other tenants untouched', () => {
    const { vault, col } = setup();
    const bundle = vault.exportBackup(col, { tenantId: 'default' });
    vault.restoreBackup(bundle, col);
    assert.equal(col.docs.filter((r) => r.tenantId === 'tenant-other').length, 2);
  });

  test('a cross-tenant restore is refused and writes nothing', () => {
    const { vault, col } = setup();
    const bundle = vault.exportBackup(col, { tenantId: 'default' });
    const target = memoryCollection([{ id: 'keep', tenantId: 'tenant-other', type: 'x', secret: undefined }]);
    const before = JSON.stringify(target.docs);
    assert.throws(() => vault.restoreBackup(bundle, target, { tenantId: 'tenant-other' }), (e) => e.code === 'auth.forbidden' && e.details.reason === 'cross-tenant');
    assert.equal(JSON.stringify(target.docs), before);
  });

  test('relabelling the outer tenant does not bypass the check (it is in the AAD)', () => {
    const { vault, col } = setup();
    const bundle = { ...vault.exportBackup(col, { tenantId: 'default' }), tenantId: 'tenant-other' };
    assert.throws(() => vault.validateBackup(bundle, { tenantId: 'tenant-other' }), (e) => e.details.reason === 'authentication-failed');
  });

  test('a corrupt manifest is refused', () => {
    const { vault, col } = setup();
    const bundle = vault.exportBackup(col);
    const bytes = Buffer.from(bundle.manifest.ct, 'base64url');
    bytes[10] ^= 0xff;
    const bad = { ...bundle, manifest: { ...bundle.manifest, ct: bytes.toString('base64url') } };
    assert.throws(() => vault.validateBackup(bad), (e) => e.details.reason === 'authentication-failed');
  });

  /** Re-seal a doctored manifest with the real backup key, to test the inner checks. */
  function doctor(provider, bundle, mutate) {
    const binding = { tenantId: bundle.tenantId, credentialId: `backup:${bundle.backupId}`, type: 'n8n-lego/backup-manifest' };
    const key = provider.deriveKey(bundle.manifest.keyRef, KEY_PURPOSE.BACKUP);
    const manifest = openEnvelope(bundle.manifest, binding, { key });
    mutate(manifest);
    return { ...bundle, manifest: sealEnvelope(manifest, binding, { keyRef: bundle.manifest.keyRef, key }) };
  }

  test('a partial backup (a record dropped) is refused', () => {
    const { provider, vault, col } = setup();
    const bad = doctor(provider, vault.exportBackup(col), (m) => m.records.pop());
    assert.throws(() => vault.validateBackup(bad), (e) => e.details.reason === 'partial-backup');
  });

  test('a record altered inside the manifest is refused by its digest', () => {
    const { provider, vault, col } = setup();
    const bad = doctor(provider, vault.exportBackup(col), (m) => {
      m.records[1].name = 'renamed';
    });
    assert.throws(() => vault.validateBackup(bad), (e) => e.details.reason === 'digest-mismatch');
  });

  test('a record from another tenant smuggled into the manifest is refused', () => {
    const { provider, vault, col } = setup();
    const bad = doctor(provider, vault.exportBackup(col), (m) => {
      m.records[0] = { ...m.records[0], tenantId: 'tenant-other' };
      m.digests[0] = undefined;
    });
    assert.throws(() => vault.validateBackup(bad), (e) => ['digest-mismatch', 'cross-tenant'].includes(e.details.reason));
  });

  test('restoring without the right key is refused and writes nothing', () => {
    const { vault, col } = setup();
    const bundle = vault.exportBackup(col);
    const stranger = createCredentialVault({ provider: createMemoryKeyProvider(), secretFieldsFor });
    const target = memoryCollection();
    assert.throws(() => stranger.restoreBackup(bundle, target), (e) => e.code === 'lego.unavailable');
    assert.equal(target.docs.length, 0);
  });

  test('a backup from before a rotation still restores while its key is in the window', () => {
    const { provider, vault, col } = setup(3);
    const bundle = vault.exportBackup(col);
    vault.startRotation(); // old key is now `previous`, still readable
    const target = memoryCollection();
    assert.equal(vault.restoreBackup(bundle, target).restored, 3);
    assert.ok(provider.previousKeyRef());
  });
});

/* ======================================================================= boot */

describe('boot fails closed and self-heals', () => {
  const store = (docs) => ({ credentials: memoryCollection(docs) });

  test('first boot with nothing sealed creates the keyring', async () => {
    const result = await bootCredentialVault({ config: { storage: 'file', dataDir: dir }, store: store([]), secretFieldsFor });
    assert.ok(result.vault);
    assert.equal(existsSync(join(dir, KEYRING_FILE)), true);
  });

  test('sealed records + a missing keyring => no vault, never a fresh key', async () => {
    const first = await bootCredentialVault({ config: { storage: 'file', dataDir: dir }, store: store([]), secretFieldsFor });
    const docs = sealedRecords(first.vault, 2);
    rmSync(join(dir, KEYRING_FILE));
    const second = await bootCredentialVault({ config: { storage: 'file', dataDir: dir }, store: store(docs), secretFieldsFor });
    assert.equal(second.vault, null);
    assert.equal(second.error.reason, 'keyring-missing');
    assert.equal(existsSync(join(dir, KEYRING_FILE)), false, 'no replacement key was minted');
  });

  test('boot migrates legacy plaintext and resumes a pending rotation', async () => {
    const first = await bootCredentialVault({ config: { storage: 'file', dataDir: dir }, store: store([]), secretFieldsFor });
    const s = store([...sealedRecords(first.vault, 4), { id: 'legacy', type: 'httpHeaderAuth', data: { name: 'L', value: SECRET } }]);
    first.vault.startRotation(); // then "crash"
    const second = await bootCredentialVault({ config: { storage: 'file', dataDir: dir }, store: s, secretFieldsFor });
    assert.equal(second.report.migrated, 1);
    assert.equal(second.report.recovered, true);
    assert.equal(second.report.unreadable, 0);
    assert.equal(JSON.stringify(s.credentials.docs).includes(SECRET), false);
  });

  test('memory storage uses an in-memory keyring and writes no file', async () => {
    const result = await bootCredentialVault({ config: { storage: 'memory', dataDir: dir }, store: store([]), secretFieldsFor });
    assert.ok(result.vault);
    assert.equal(existsSync(join(dir, KEYRING_FILE)), false);
  });
});

/* ====================================================== REST without a vault */

describe('the REST surface refuses to store a secret it cannot seal', () => {
  test('create answers 503 and stores nothing when the vault is unavailable', () => {
    const route = credentialRoutes({ logger: { info() {} }, vault: null }).find((r) => r.method === 'POST' && r.path === '/rest/credentials');
    const inserted = [];
    const ctx = {
      user: { id: 'u1', role: 'global:owner' },
      config: { catalogDir: dir },
      body: { name: 'n', type: 'httpHeaderAuth', data: { value: SECRET } },
      store: { credentials: { insert: (d) => inserted.push(d), all: () => [] } },
      res: {},
    };
    assert.throws(() => route.handler(ctx), (e) => e.status === 503 && e.code === 'lego.unavailable');
    assert.equal(inserted.length, 0, 'no plaintext fallback: nothing was written');
  });
});

/* ======================================================= leakage in artifacts */

describe('no secret material reaches audit events or recovery metadata', () => {
  test('every emitted event is identifiers and counts only', () => {
    const events = [];
    const provider = createMemoryKeyProvider();
    const vault = createCredentialVault({ provider, secretFieldsFor, onEvent: (e, d) => events.push([e, d]) });
    const col = memoryCollection([...sealedRecords(vault, 3), { id: 'legacy', type: 'httpHeaderAuth', data: { value: SECRET } }]);
    vault.migrateLegacyPlaintext(col);
    vault.rotate(col);
    vault.restoreBackup(vault.exportBackup(col), memoryCollection());
    assert.ok(events.length >= 5);
    const dump = JSON.stringify(events);
    assert.equal(dump.includes(SECRET), false);
    for (let i = 0; i < 3; i += 1) assert.equal(dump.includes(secretFor(i)), false);
  });

  test('recovery metadata carries no material and no secret', () => {
    const vault = createCredentialVault({ provider: createMemoryKeyProvider(), secretFieldsFor });
    const col = memoryCollection(sealedRecords(vault, 3));
    const meta = vault.recoveryMetadata(col);
    assert.equal(Object.values(meta.recordsByKeyRef)[0], 3);
    const dump = JSON.stringify(meta);
    assert.equal(dump.includes('material'), false);
    for (let i = 0; i < 3; i += 1) assert.equal(dump.includes(secretFor(i)), false);
  });
});
