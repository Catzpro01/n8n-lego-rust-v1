/**
 * P5.5 (#218) — KeyProvider: provider-neutral key custody for credential crypto.
 *
 * The contract every provider implements (local file today; an external KMS is
 * explicitly non-scope, but must be able to satisfy the same shape):
 *
 *   currentKeyRef()            the key new envelopes are sealed under
 *   readableKeyRefs()          the CONTROLLED READ WINDOW: current + at most one
 *                              previous key. Nothing else decrypts, ever.
 *   deriveKey(keyRef, purpose) a 32-byte subkey for one purpose, or throws.
 *                              Raw key material never leaves the provider.
 *   fingerprint(keyRef)        a non-reversible id for recovery metadata
 *   beginRotation()            mint a new current key; the old one becomes
 *                              `previous` (still readable)
 *   abortRotation()            rollback: previous becomes current again
 *   retire(keyRef)             destroy a previous key's material. Irreversible.
 *   state()                    lineage WITHOUT material — safe to log/audit
 *
 * Hard rules from #218, and where each is enforced:
 *   - no master/root key inside ordinary credential records: records only ever
 *     carry a `keyRef`; material lives in the keyring file (0600) alone
 *   - no plaintext fallback: there is no code path here that returns "no key,
 *     so skip encryption". A missing key throws `lego.unavailable`.
 *   - the read window is bounded: `beginRotation` refuses while a previous key
 *     is still live, so there are never more than two readable keys
 *   - a retired key is gone: its material is deleted from the keyring, so a
 *     record still pointing at it fails closed rather than being readable
 */

import { createHash, hkdfSync, randomBytes as nodeRandomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { SecurityError } from './security-error.mjs';

export const KEYRING_VERSION = 1;
export const KEY_BYTES = 32;

/** Purposes are closed: a subkey derived for one can never be used for another. */
export const KEY_PURPOSE = Object.freeze({
  CREDENTIAL: 'n8n-lego/credential-envelope/v1',
  BACKUP: 'n8n-lego/backup-manifest/v1',
});

const PURPOSES = new Set(Object.values(KEY_PURPOSE));

export const KEY_STATUS = Object.freeze({
  CURRENT: 'current',
  PREVIOUS: 'previous',
  RETIRED: 'retired',
});

const KEYREF_SHAPE = /^k[0-9]{1,6}_[a-f0-9]{8}$/;

export function isKeyRef(value) {
  return typeof value === 'string' && KEYREF_SHAPE.test(value);
}

function unavailable(reason, details = {}) {
  return new SecurityError('lego.unavailable', `credential key unavailable: ${reason}`, {
    details: { reason, ...details },
  });
}

function conflict(reason, details = {}) {
  return new SecurityError('lego.migration_required', `key rotation refused: ${reason}`, {
    details: { reason, ...details },
  });
}

function malformed(reason, details = {}) {
  return new SecurityError('lego.contract_violation', `keyring is malformed: ${reason}`, {
    details: { reason, ...details },
  });
}

/**
 * Validates a loaded keyring. A keyring that does not parse cleanly is refused
 * outright — silently regenerating it would orphan every sealed credential.
 */
function validateKeyring(state) {
  if (!state || typeof state !== 'object') throw malformed('not-an-object');
  if (state.version !== KEYRING_VERSION) throw malformed('unsupported-version', { version: state.version });
  if (!Array.isArray(state.keys) || state.keys.length === 0) throw malformed('no-keys');
  let current = 0;
  let previous = 0;
  const seen = new Set();
  for (const key of state.keys) {
    if (!isKeyRef(key?.keyRef)) throw malformed('bad-keyref');
    if (seen.has(key.keyRef)) throw malformed('duplicate-keyref', { keyRef: key.keyRef });
    seen.add(key.keyRef);
    if (!Object.values(KEY_STATUS).includes(key.status)) throw malformed('bad-status', { keyRef: key.keyRef });
    if (key.status === KEY_STATUS.CURRENT) current += 1;
    if (key.status === KEY_STATUS.PREVIOUS) previous += 1;
    if (key.status === KEY_STATUS.RETIRED) {
      if (key.material !== undefined) throw malformed('retired-key-has-material', { keyRef: key.keyRef });
    } else {
      const bytes = typeof key.material === 'string' ? Buffer.from(key.material, 'base64') : null;
      if (!bytes || bytes.length !== KEY_BYTES) throw malformed('bad-material-length', { keyRef: key.keyRef });
    }
  }
  if (current !== 1) throw malformed('exactly-one-current-required', { current });
  if (previous > 1) throw malformed('read-window-exceeded', { previous });
  return state;
}

/**
 * The provider core, independent of where the keyring is persisted.
 *
 * @param {{ load(): object|null, save(state: object): void }} persistence
 * @param {{ now?: () => number, randomBytes?: (n: number) => Buffer }} [options]
 */
function createKeyProviderCore(persistence, { now = Date.now, randomBytes = nodeRandomBytes, kind } = {}) {
  let state = persistence.load();
  if (state === null) {
    // First boot only. From here on a missing keyring is an error, not a reason
    // to mint a new one (see createLocalKeyProvider).
    state = { version: KEYRING_VERSION, sequence: 0, keys: [] };
    state = appendKey(state, KEY_STATUS.CURRENT);
    persistence.save(state);
  }
  validateKeyring(state);

  /** Derived subkeys, memoised per (keyRef, purpose). Bounded by the read window. */
  const derived = new Map();

  function appendKey(s, status) {
    const sequence = (s.sequence ?? 0) + 1;
    const material = randomBytes(KEY_BYTES);
    const keyRef = `k${sequence}_${createHash('sha256').update(material).digest('hex').slice(0, 8)}`;
    return {
      ...s,
      sequence,
      keys: [...s.keys, { keyRef, status, createdAt: new Date(now()).toISOString(), material: material.toString('base64') }],
    };
  }

  function find(keyRef) {
    return state.keys.find((key) => key.keyRef === keyRef) ?? null;
  }

  function commit(next) {
    validateKeyring(next);
    // Persist FIRST. If this throws, in-memory state is unchanged, so the
    // provider never believes in a key that is not durably recorded.
    persistence.save(next);
    state = next;
    derived.clear();
  }

  const provider = {
    kind,

    currentKeyRef() {
      return state.keys.find((key) => key.status === KEY_STATUS.CURRENT).keyRef;
    },

    previousKeyRef() {
      return state.keys.find((key) => key.status === KEY_STATUS.PREVIOUS)?.keyRef ?? null;
    },

    readableKeyRefs() {
      return state.keys
        .filter((key) => key.status === KEY_STATUS.CURRENT || key.status === KEY_STATUS.PREVIOUS)
        .map((key) => key.keyRef);
    },

    /**
     * @param {string} keyRef
     * @param {string} purpose one of KEY_PURPOSE
     * @returns {Buffer} 32-byte subkey
     */
    deriveKey(keyRef, purpose) {
      if (!PURPOSES.has(purpose)) throw malformed('unknown-purpose');
      if (!isKeyRef(keyRef)) throw unavailable('malformed-keyref');
      const cacheKey = `${keyRef}\u241f${purpose}`;
      const hit = derived.get(cacheKey);
      if (hit) return hit;
      const key = find(keyRef);
      if (!key) throw unavailable('unknown-keyref', { keyRef });
      if (key.status === KEY_STATUS.RETIRED) throw unavailable('key-retired', { keyRef });
      // HKDF domain separation: the credential subkey and the backup subkey of
      // the same key share nothing an attacker can use.
      const subkey = Buffer.from(
        hkdfSync('sha256', Buffer.from(key.material, 'base64'), Buffer.from(keyRef, 'utf8'), Buffer.from(purpose, 'utf8'), KEY_BYTES),
      );
      derived.set(cacheKey, subkey);
      return subkey;
    },

    /** Non-reversible identifier of a key, for recovery metadata. */
    fingerprint(keyRef) {
      const key = find(keyRef);
      if (!key || key.material === undefined) return key?.fingerprint ?? null;
      return createHash('sha256').update('n8n-lego/key-fingerprint/v1\0').update(Buffer.from(key.material, 'base64')).digest('hex').slice(0, 32);
    },

    /** Mint a new current key; the old current becomes previous (still readable). */
    beginRotation() {
      const live = provider.previousKeyRef();
      if (live) {
        // Bounded window: a third readable key is never allowed. Finish (retire)
        // or abort the previous rotation first.
        throw conflict('previous-key-still-live', { previous: live });
      }
      const from = provider.currentKeyRef();
      let next = {
        ...state,
        keys: state.keys.map((key) => (key.keyRef === from ? { ...key, status: KEY_STATUS.PREVIOUS } : key)),
      };
      next = appendKey(next, KEY_STATUS.CURRENT);
      next.rotation = { from, to: next.keys[next.keys.length - 1].keyRef, startedAt: new Date(now()).toISOString() };
      commit(next);
      return { from, to: provider.currentKeyRef() };
    },

    /**
     * Rollback: the previous key becomes current again, the rotation target
     * becomes previous (still readable, so records already moved to it can be
     * moved back). Nothing is destroyed.
     */
    abortRotation() {
      const previous = provider.previousKeyRef();
      if (!previous) throw conflict('no-rotation-to-abort');
      const current = provider.currentKeyRef();
      const next = {
        ...state,
        keys: state.keys.map((key) => {
          if (key.keyRef === previous) return { ...key, status: KEY_STATUS.CURRENT };
          if (key.keyRef === current) return { ...key, status: KEY_STATUS.PREVIOUS };
          return key;
        }),
        rotation: { from: current, to: previous, startedAt: new Date(now()).toISOString(), aborted: true },
      };
      commit(next);
      return { from: current, to: previous };
    },

    /**
     * Destroy a previous key's material. The CALLER (the vault) must first prove
     * that no record references it — the provider cannot see records.
     */
    retire(keyRef) {
      const key = find(keyRef);
      if (!key) throw unavailable('unknown-keyref', { keyRef });
      if (key.status !== KEY_STATUS.PREVIOUS) throw conflict('only-previous-keys-may-retire', { keyRef, status: key.status });
      const fingerprint = provider.fingerprint(keyRef);
      const next = {
        ...state,
        keys: state.keys.map((k) => {
          if (k.keyRef !== keyRef) return k;
          const { material: _dropped, ...rest } = k;
          return { ...rest, status: KEY_STATUS.RETIRED, retiredAt: new Date(now()).toISOString(), fingerprint };
        }),
        rotation: null,
      };
      commit(next);
    },

    /** An in-flight rotation, if the process died mid-way. */
    pendingRotation() {
      return state.rotation ?? null;
    },

    /** Lineage without material — the only view of the keyring that may be logged. */
    state() {
      return Object.freeze({
        kind,
        version: state.version,
        current: provider.currentKeyRef(),
        previous: provider.previousKeyRef(),
        rotation: state.rotation ?? null,
        keys: state.keys.map((key) => Object.freeze({
          keyRef: key.keyRef,
          status: key.status,
          createdAt: key.createdAt,
          retiredAt: key.retiredAt ?? null,
          fingerprint: key.material !== undefined ? provider.fingerprint(key.keyRef) : key.fingerprint ?? null,
        })),
      });
    },
  };
  return Object.freeze(provider);
}

/**
 * In-memory provider — for `N8N_LEGO_STORAGE=memory`, where the credentials
 * themselves do not survive a restart either.
 */
export function createMemoryKeyProvider(options = {}) {
  let held = options.initialState ?? null;
  return createKeyProviderCore(
    {
      load: () => (held ? structuredClone(held) : null),
      save: (state) => {
        held = structuredClone(state);
      },
    },
    { ...options, kind: 'memory' },
  );
}

/**
 * Local/VPS-native provider: a keyring file, mode 0600, written atomically
 * (tmp + fsync + rename), so a crash mid-write leaves either the old keyring or
 * the new one — never a torn file.
 *
 * `allowCreate` must be true only when there is provably nothing sealed yet.
 * Otherwise a deleted keyring would be silently replaced by a fresh key, and
 * every existing credential would become permanently unreadable without an
 * error anyone notices. With allowCreate=false a missing keyring throws.
 *
 * @param {{ file: string, allowCreate?: boolean, now?: () => number, randomBytes?: (n: number) => Buffer }} options
 */
export function createLocalKeyProvider({ file, allowCreate = false, ...options }) {
  if (typeof file !== 'string' || file === '') throw new TypeError('createLocalKeyProvider requires a file path');
  return createKeyProviderCore(
    {
      load: () => {
        if (!existsSync(file)) {
          if (!allowCreate) throw unavailable('keyring-missing');
          return null;
        }
        let parsed;
        try {
          parsed = JSON.parse(readFileSync(file, 'utf8'));
        } catch {
          throw malformed('unparseable');
        }
        return parsed;
      },
      save: (state) => {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        const fd = openSync(tmp, 'w', 0o600);
        try {
          writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, file);
      },
    },
    { ...options, kind: 'local-file' },
  );
}
