#!/usr/bin/env node
/**
 * P5.5 (#218) — measured credential crypto cost and memory.
 *
 *   node --expose-gc tools/p5/credential-crypto-benchmark.mjs
 *
 * Prints measurements; writes nothing to the repository. Every number is from
 * this process on this machine — nothing here is estimated.
 */
import { performance } from 'node:perf_hooks';
import { createMemoryKeyProvider, KEY_PURPOSE } from '../../src/auth/security/key-provider.mjs';
import { openEnvelope, sealEnvelope } from '../../src/auth/security/credential-envelope.mjs';
import { createCredentialVault } from '../../src/auth/security/credential-vault.mjs';

const gc = globalThis.gc ?? (() => {});
const ITER = Number(process.env.ITER ?? 50_000);

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function bench(label, fn, iterations = ITER) {
  for (let i = 0; i < Math.min(2000, iterations); i += 1) fn(i); // warm-up
  gc();
  const heap0 = process.memoryUsage().heapUsed;
  const samples = new Float64Array(iterations);
  const t0 = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const s = performance.now();
    fn(i);
    samples[i] = (performance.now() - s) * 1e6;
  }
  const total = (performance.now() - t0) * 1e6;
  const heap1 = process.memoryUsage().heapUsed;
  const sorted = Array.from(samples).sort((a, b) => a - b);
  const row = {
    op: label,
    'mean ns': Math.round(total / iterations),
    'p50 ns': Math.round(pct(sorted, 50)),
    'p99 ns': Math.round(pct(sorted, 99)),
    'heap B/op': ((heap1 - heap0) / iterations).toFixed(1),
  };
  console.log(JSON.stringify(row));
  return row;
}

const provider = createMemoryKeyProvider();
const keyRef = provider.currentKeyRef();
const key = provider.deriveKey(keyRef, KEY_PURPOSE.CREDENTIAL);
const binding = { tenantId: 'default', credentialId: 'bench-cred-0001', type: 'httpHeaderAuth' };
const secret = { value: 'x'.repeat(48) };
const sealed = sealEnvelope(secret, binding, { keyRef, key });
const secretFieldsFor = () => new Set(['value']);
const vault = createCredentialVault({ provider, secretFieldsFor });
const record = { id: 'bench-cred-0001', type: 'httpHeaderAuth', tenantId: 'default', ...vault.sealData({ id: 'bench-cred-0001', type: 'httpHeaderAuth', tenantId: 'default' }, { name: 'X', ...secret }) };

console.log(`# node ${process.version} ${process.platform}/${process.arch}, iterations ${ITER}`);
bench('deriveKey (memoised)', () => provider.deriveKey(keyRef, KEY_PURPOSE.CREDENTIAL));
bench('sealEnvelope (48-byte secret)', () => sealEnvelope(secret, binding, { keyRef, key }));
bench('openEnvelope (48-byte secret)', () => openEnvelope(sealed, binding, { key }));
bench('vault.open (window check + open)', () => vault.open(record));
bench('vault.sealData (split + seal)', () => vault.sealData(record, { name: 'X', ...secret }));
const tampered = { ...sealed, tag: Buffer.alloc(16).toString('base64url') };
bench('openEnvelope REJECT (tampered)', () => {
  try {
    openEnvelope(tampered, binding, { key });
  } catch {
    /* expected */
  }
}, Math.min(ITER, 20_000));

/* ---------------------------------------------------- rotation throughput */
for (const n of [1_000, 10_000]) {
  const p = createMemoryKeyProvider();
  const v = createCredentialVault({ provider: p, secretFieldsFor });
  const docs = [];
  for (let i = 0; i < n; i += 1) {
    const base = { id: `c${i}`, type: 'httpHeaderAuth', tenantId: 'default' };
    docs.push({ ...base, ...v.sealData(base, { name: 'X', value: `secret-${i}` }) });
  }
  const col = {
    all: () => docs,
    update(id, patch) {
      const i = docs.findIndex((d) => d.id === id);
      docs[i] = patch(docs[i]);
      return docs[i];
    },
  };
  gc();
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const r = v.rotate(col, { batchSize: 256 });
  const ms = performance.now() - t0;
  gc();
  console.log(JSON.stringify({
    op: `rotate ${n} records (batch 256, verify each)`,
    'total ms': Math.round(ms),
    'records/s': Math.round(n / (ms / 1000)),
    steps: r.steps,
    'retained heap KiB': ((process.memoryUsage().heapUsed - heap0) / 1024).toFixed(1),
  }));
}

/* ------------------------------------------- bounded concurrency (async) */
for (const concurrency of [1, 8, 64]) {
  const perWorker = Math.floor(20_000 / concurrency);
  const latencies = [];
  gc();
  const rss0 = process.memoryUsage().rss;
  let heapPeak = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let i = 0; i < perWorker; i += 1) {
        const s = performance.now();
        const env = vault.sealData(record, { name: 'X', value: `v${i}` });
        vault.open({ ...record, ...env });
        latencies.push((performance.now() - s) * 1e6);
        if ((i & 63) === 0) {
          heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
          await new Promise((resolve) => setImmediate(resolve)); // yield like a request would
        }
      }
    }),
  );
  const ms = performance.now() - t0;
  latencies.sort((a, b) => a - b);
  console.log(JSON.stringify({
    op: `seal+open, concurrency ${concurrency}`,
    'ops/s': Math.round((perWorker * concurrency) / (ms / 1000)),
    'p50 ns': Math.round(pct(latencies, 50)),
    'p99 ns': Math.round(pct(latencies, 99)),
    'peak heap MiB': (heapPeak / 1048576).toFixed(1),
    'rss delta MiB': ((process.memoryUsage().rss - rss0) / 1048576).toFixed(1),
  }));
}

/* ---------------------------------- file-backed rotation (real Collection) */
{
  const { Collection } = await import('../../src/store.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  for (const n of [500, 2_000, 10_000]) {
    const dir = mkdtempSync(join(tmpdir(), 'p55-bench-'));
    const col = new Collection(join(dir, 'credentials.json'));
    const v = createCredentialVault({ provider: createMemoryKeyProvider(), secretFieldsFor });
    const docs = [];
    for (let i = 0; i < n; i += 1) {
      const base = { id: `c${i}`, type: 'httpHeaderAuth', tenantId: 'default' };
      docs.push({ ...base, ...v.sealData(base, { name: 'X', value: `secret-${i}` }) });
    }
    col.replaceAll(docs);
    const t0 = performance.now();
    const r = v.rotate(col, { batchSize: 256 });
    const ms = performance.now() - t0;
    console.log(JSON.stringify({ op: `file-backed rotate ${n} records (batch 256)`, 'total ms': Math.round(ms), 'records/s': Math.round(n / (ms / 1000)), steps: r.steps }));
    rmSync(dir, { recursive: true, force: true });
  }
}
