/**
 * P5.5 (#218) — the versioned, authenticated credential envelope.
 *
 *   { cryptoVersion: 1, alg: 'A256GCM', keyRef, iv, ct, tag }   (base64url)
 *
 * AES-256-GCM authenticates BOTH the ciphertext and the associated data. The
 * associated data binds the envelope to exactly one identity:
 *
 *   ['n8n-lego/credential', cryptoVersion, tenantId, credentialId, type, keyRef]
 *
 * So an attacker with write access to the store cannot:
 *   - copy credential A's envelope onto credential B        (credentialId)
 *   - move a credential into another tenant                 (tenantId)
 *   - relabel a credential as a different type              (type)
 *   - swap the keyRef to point at a different key           (keyRef)
 *   - downgrade the format                                  (cryptoVersion)
 * Every one of those fails authentication and is refused. There is no path
 * that returns partial plaintext, and no path that falls back to plaintext.
 *
 * `credentialVersion` is deliberately NOT in the AAD: it changes on every edit,
 * whereas the envelope must survive key rotation with identity intact (#218
 * "credential identity survives key rotation"). Version binding is SecretRef's
 * job (P5.4).
 */

import { createCipheriv, createDecipheriv, randomBytes as nodeRandomBytes } from 'node:crypto';
import { SecurityError } from './security-error.mjs';
import { isKeyRef } from './key-provider.mjs';

export const CRYPTO_VERSION = 1;
export const ENVELOPE_ALG = 'A256GCM';

const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Bound on sealed payload size — a credential is a handful of fields, not a blob store. */
export const MAX_PLAINTEXT_BYTES = 64 * 1024;

const B64URL = /^[A-Za-z0-9_-]+$/;

export const ENVELOPE_REASON = Object.freeze({
  MALFORMED: 'envelope-malformed',
  UNSUPPORTED_VERSION: 'crypto-version-unsupported',
  AUTHENTICATION_FAILED: 'authentication-failed',
  TOO_LARGE: 'plaintext-too-large',
  BAD_BINDING: 'binding-invalid',
});

function fail(code, reason, message, details = {}) {
  return new SecurityError(code, message, { details: { reason, ...details } });
}

function assertBinding(binding) {
  const { tenantId, credentialId, type } = binding ?? {};
  for (const [field, value] of [['tenantId', tenantId], ['credentialId', credentialId], ['type', type]]) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
      throw fail('lego.contract_violation', ENVELOPE_REASON.BAD_BINDING, `envelope binding field ${field} is invalid`, { field });
    }
  }
}

/** Canonical AAD. A JSON array: unambiguous, so no two bindings encode alike. */
export function associatedData({ tenantId, credentialId, type }, keyRef, cryptoVersion = CRYPTO_VERSION) {
  return Buffer.from(JSON.stringify(['n8n-lego/credential', cryptoVersion, tenantId, credentialId, type, keyRef]), 'utf8');
}

/**
 * Strict structural check. Anything unexpected is refused BEFORE any crypto
 * runs, so a malformed envelope can never reach the decipher.
 */
export function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw fail('lego.contract_violation', ENVELOPE_REASON.MALFORMED, 'credential envelope is not an object');
  }
  const keys = Object.keys(envelope).sort().join(',');
  if (keys !== 'alg,cryptoVersion,ct,iv,keyRef,tag') {
    throw fail('lego.contract_violation', ENVELOPE_REASON.MALFORMED, 'credential envelope has unexpected fields');
  }
  if (envelope.cryptoVersion !== CRYPTO_VERSION) {
    throw fail('lego.version_incompatible', ENVELOPE_REASON.UNSUPPORTED_VERSION, 'credential envelope version is not supported', {
      cryptoVersion: envelope.cryptoVersion,
    });
  }
  if (envelope.alg !== ENVELOPE_ALG) {
    throw fail('lego.version_incompatible', ENVELOPE_REASON.UNSUPPORTED_VERSION, 'credential envelope algorithm is not supported');
  }
  if (!isKeyRef(envelope.keyRef)) throw fail('lego.contract_violation', ENVELOPE_REASON.MALFORMED, 'credential envelope keyRef is malformed');
  for (const field of ['iv', 'ct', 'tag']) {
    if (typeof envelope[field] !== 'string' || !B64URL.test(envelope[field])) {
      throw fail('lego.contract_violation', ENVELOPE_REASON.MALFORMED, `credential envelope ${field} is malformed`, { field });
    }
  }
  if (Buffer.from(envelope.iv, 'base64url').length !== IV_BYTES || Buffer.from(envelope.tag, 'base64url').length !== TAG_BYTES) {
    throw fail('lego.contract_violation', ENVELOPE_REASON.MALFORMED, 'credential envelope iv/tag length is wrong');
  }
  return envelope;
}

/**
 * Seal a secret object.
 *
 * @param {object} secret the runtime-secret fields
 * @param {{ tenantId: string, credentialId: string, type: string }} binding
 * @param {{ keyRef: string, key: Buffer }} keying a subkey from KeyProvider.deriveKey
 * @returns {object} frozen envelope
 */
export function sealEnvelope(secret, binding, { keyRef, key }, { randomBytes = nodeRandomBytes } = {}) {
  assertBinding(binding);
  if (!isKeyRef(keyRef) || !Buffer.isBuffer(key) || key.length !== 32) {
    throw fail('lego.unavailable', ENVELOPE_REASON.BAD_BINDING, 'no usable key to seal with');
  }
  const plaintext = Buffer.from(JSON.stringify(secret ?? {}), 'utf8');
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw fail('lego.contract_violation', ENVELOPE_REASON.TOO_LARGE, 'credential secret exceeds the size bound', {
      bytes: plaintext.length,
      max: MAX_PLAINTEXT_BYTES,
    });
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(binding, keyRef));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  plaintext.fill(0);
  return Object.freeze({
    cryptoVersion: CRYPTO_VERSION,
    alg: ENVELOPE_ALG,
    keyRef,
    iv: iv.toString('base64url'),
    ct: ct.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  });
}

/**
 * Open an envelope. Every failure — wrong key, tampered bytes, substituted AAD —
 * surfaces as one indistinguishable `authentication-failed`, so the error itself
 * is not an oracle.
 *
 * @returns {object} the secret object
 */
export function openEnvelope(envelope, binding, { key }) {
  validateEnvelope(envelope);
  assertBinding(binding);
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw fail('lego.unavailable', ENVELOPE_REASON.BAD_BINDING, 'no usable key to open with');
  }
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'), { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData(binding, envelope.keyRef, envelope.cryptoVersion));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64url')), decipher.final()]);
  } catch {
    throw fail('storage.unavailable', ENVELOPE_REASON.AUTHENTICATION_FAILED, 'credential envelope failed authentication', {
      keyRef: envelope.keyRef,
      credentialId: binding.credentialId,
    });
  }
  try {
    const parsed = JSON.parse(plaintext.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    // Authenticated but not an object: a writer bug, still fail closed.
    throw fail('storage.unavailable', ENVELOPE_REASON.MALFORMED, 'credential envelope payload is not an object');
  } finally {
    plaintext.fill(0);
  }
}
