/**
 * P8-S07 — conformance harness runs against the local reference provider.
 * The same harness is the acceptance gate for any future provider (shared,
 * multi-host, Rust port): wire the provider factory here (or call
 * runStorageConformance directly) and it must pass every case.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/lego/storage/contract.mjs';
import { createLocalStorage } from '../src/lego/storage/local-provider.mjs';
import { runStorageConformance } from '../src/lego/storage/conformance.mjs';

test('conformance: the local reference provider passes every contract case', async () => {
  const { passed, failed } = await runStorageConformance(
    ({ clock, persistence }) => createLocalStorage({ clock, persistence }),
    { wrap: (provider) => createStorage(provider) },
  );
  assert.deepEqual(failed.map((f) => `${f.name}: ${f.error.message}`), [], 'no conformance case may fail');
  assert.ok(passed.length >= 12, `expected the full battery, ran ${passed.length}: ${passed.join(' | ')}`);
});

test('conformance: the harness itself detects a broken provider (meta-proof, not vacuous green)', async () => {
  // A provider that keeps deleted keys readable violates the contract; the
  // harness must report the failure instead of passing.
  const { failed } = await runStorageConformance(
    ({ clock }) => {
      const provider = createLocalStorage({ clock });
      const realDelete = provider.delete.bind(provider);
      return Object.create(provider, {
        delete: { value: (namespace, key) => { void realDelete(namespace, key); return { deleted: true }; } },
        get: { value: (namespace, key) => ({ found: true, value: Buffer.from('ghost'), version: 'o1', expiresAt: null }) },
      });
    },
    { wrap: (provider) => createStorage(provider) },
  );
  assert.ok(failed.length > 0, 'the broken provider must fail conformance');
});
