#!/usr/bin/env node
/**
 * P5-M04 — measure-first: does the rotation work-list scan dominate?
 *
 * The P5.5 technical debt (P5.8-CERTIFICATION-EVIDENCE §7): "rotation work-list
 * is an O(n) filter." Before deciding whether to index the work-list (to avoid
 * the per-batch O(n) scan), P5-M04 MEASURES, at several scales, the per-batch
 * cost of the SCAN (recordsNotOnCurrent: all().filter) vs the O(n) replaceAll
 * PERSIST (commitBatch: all().map + replaceAll), plus the per-record re-encrypt
 * cost — on file-backed storage (real I/O) and in memory.
 *
 * Decision rule (P5-M04, encoded as `shouldIndex`): index the work-list ONLY IF
 * the scan dominates the persist. If the persist dominates, indexing the scan
 * does not help and the O(n) filter stays.
 *
 *   node tools/p5/rotation-worklist-benchmark.mjs
 *
 * Every number printed is from this process on this machine — nothing is
 * estimated. Writes nothing to the repository (file-backed runs use a temp dir
 * that is removed afterwards).
 */
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryKeyProvider, KEY_PURPOSE } from '../../src/auth/security/key-provider.mjs';
import { sealEnvelope, openEnvelope } from '../../src/auth/security/credential-envelope.mjs';
import { createCredentialVault } from '../../src/auth/security/credential-vault.mjs';
import { Collection } from '../../src/store.mjs';

const secretFieldsFor = () => new Set(['value']);

/** Average wall time (ms) of `fn` over `runs` iterations (with a short warm-up). */
function avgMs(fn, runs = 5, warmup = 2) {
  for (let i = 0; i < warmup; i += 1) fn();
  const samples = new Array(runs);
  for (let i = 0; i < runs; i += 1) {
    const t = performance.now();
    fn();
    samples[i] = performance.now() - t;
  }
  return samples.reduce((a, b) => a + b, 0) / runs;
}

/**
 * Build a collection of `n` sealed credential records on `backend`
 * ('file' -> a real file-backed Collection; 'memory' -> an in-memory array).
 * Returns { collection, sample } where `sample` is one sealed record.
 */
function build({ n, backend, dir }) {
  const provider = createMemoryKeyProvider();
  const vault = createCredentialVault({ provider, secretFieldsFor });
  const docs = [];
  for (let i = 0; i < n; i += 1) {
    const base = { id: `c${i}`, type: 'httpHeaderAuth', tenantId: 'default' };
    docs.push({ ...base, ...vault.sealData(base, { name: 'X', value: `secret-${i}` }) });
  }
  let collection;
  if (backend === 'file') {
    const col = new Collection(join(dir, 'credentials.json'));
    col.replaceAll(docs);
    collection = col;
  } else {
    collection = { all: () => docs, update(id, patch) { docs[docs.findIndex((d) => d.id === id)] = patch(docs[docs.findIndex((d) => d.id === id)]); return docs[0]; }, replaceAll(next) { docs.splice(0, docs.length, ...next); } };
  }
  return { collection, provider, sample: docs[0] };
}

/**
 * Measure the three cost components of one rotation of `n` records:
 *   - perBatchScanMs:    one work-list scan = all().filter(keyRef !== current) over n records
 *   - perBatchPersistMs: one persist = all().map(identity) + replaceAll() over n records
 *   - perRecordCryptoMs: one re-encrypt proxy = sealEnvelope + openEnvelope
 * and project them to a full rotation (≈ n/batchSize steps).
 *
 * @returns {{ n:number, batchSize:number, backend:string, perBatchScanMs:number,
 *   perBatchPersistMs:number, perRecordCryptoMs:number, steps:number,
 *   estScanMs:number, estPersistMs:number, estCryptoMs:number, indexJustified:boolean }}
 */
export function measureRotation({ n, batchSize = 256, backend = 'file', dir = null, runs = 5 } = {}) {
  const createdDir = dir == null && backend === 'file';
  const workDir = dir ?? (createdDir ? mkdtempSync(join(tmpdir(), 'p5m04-')) : null);
  try {
    const { collection, provider, sample } = build({ n, backend, dir: workDir });
    const current = 'k_current_sentinel'; // a keyRef no record holds -> the scan checks all n
    const identity = (record) => record;

    const perBatchScanMs = avgMs(
      () => {
        let hits = 0;
        for (const record of collection.all()) if (record.secret && record.secret.keyRef !== current) hits += 1;
        if (hits < 0) throw new Error('unreachable'); // keep the filter from being optimised away
      },
      runs,
    );
    const perBatchPersistMs = avgMs(() => collection.replaceAll(collection.all().map(identity)), runs);
    const keyRef = provider.currentKeyRef();
    const perRecordCryptoMs = avgMs(() => {
      const binding = { tenantId: 'default', credentialId: sample.id, type: sample.type };
      const key = provider.deriveKey(keyRef, KEY_PURPOSE.CREDENTIAL);
      const sealed = sealEnvelope({ value: 'x'.repeat(48) }, binding, { keyRef, key });
      openEnvelope(sealed, binding, { key });
    }, runs);

    const steps = Math.max(1, Math.ceil(n / batchSize));
    const estScanMs = steps * perBatchScanMs;
    const estPersistMs = steps * perBatchPersistMs;
    const estCryptoMs = n * perRecordCryptoMs;
    return {
      n,
      batchSize,
      backend,
      perBatchScanMs: +perBatchScanMs.toFixed(4),
      perBatchPersistMs: +perBatchPersistMs.toFixed(3),
      perRecordCryptoMs: +perRecordCryptoMs.toFixed(4),
      steps,
      estScanMs: +estScanMs.toFixed(3),
      estPersistMs: +estPersistMs.toFixed(2),
      estCryptoMs: +estCryptoMs.toFixed(2),
      indexJustified: shouldIndex({ estScanMs, estPersistMs }),
    };
  } finally {
    if (createdDir && workDir) rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * P5-M04 decision rule: index the work-list ONLY IF the scan dominates the
 * persist. A strictly-greater scan (not "comparable") is required, so a
 * near-tie does not trigger an index.
 */
export function shouldIndex({ estScanMs, estPersistMs }) {
  return estScanMs > estPersistMs;
}

/* --------------------------------------------------------------------- CLI */
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const BATCH = Number(process.env.BATCH ?? 256);
  const BACKENDS = (process.env.BACKENDS ?? 'file,memory').split(',').map((s) => s.trim());
  const NS = (process.env.NS ?? '1000,10000,50000,100000').split(',').map((s) => Number(s.trim()));
  console.log(`# node ${process.version} ${process.platform}/${process.arch}, batchSize ${BATCH}`);
  for (const backend of BACKENDS) {
    for (const n of NS) {
      const row = measureRotation({ n, batchSize: BATCH, backend });
      console.log(JSON.stringify(row));
    }
  }
  console.log('# decision: indexJustified=true ONLY when estScanMs > estPersistMs (scan dominates)');
}
