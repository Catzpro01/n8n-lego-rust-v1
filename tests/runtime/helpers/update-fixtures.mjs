#!/usr/bin/env node
/**
 * Regenerate `tests/fixtures/runtime/expected/*.json` from the REAL runtime.
 *
 * Golden files must never be hand-written or edited to make a failing test
 * pass: run this script against a runtime whose behaviour you have reviewed,
 * then read the diff before committing it.
 *
 *   node tests/runtime/helpers/update-fixtures.mjs [--check]
 */
import { Runtime } from './process.mjs';
import { loadFixtures, normalizeRunResult, readExpected, requestBodyFor, writeExpected } from './fixtures.mjs';

const checkOnly = process.argv.includes('--check');
const runtime = await Runtime.start();
let changed = 0;
let failures = 0;

try {
  for (const fixture of await loadFixtures()) {
    const response = await runtime.post('/api/v1/workflows/run', requestBodyFor(fixture));
    if (response.status !== 200) {
      failures += 1;
      console.error(`✗ ${fixture.id}: HTTP ${response.status} ${JSON.stringify(response.body)}`);
      continue;
    }
    const normalized = normalizeRunResult(response.body.data);
    const current = await readExpected(fixture.id);
    const same = JSON.stringify(current) === JSON.stringify(normalized);
    if (same) {
      console.log(`= ${fixture.id} (unchanged)`);
      continue;
    }
    changed += 1;
    if (checkOnly) {
      console.error(`✗ ${fixture.id}: expected file differs from the live runtime`);
      continue;
    }
    await writeExpected(fixture.id, normalized);
    console.log(`↻ ${fixture.id} (updated)`);
  }
} finally {
  await runtime.cleanup();
}

console.log(
  `\n${changed} fixture(s) ${checkOnly ? 'out of date' : 'updated'}, ${failures} failure(s)`,
);
if (failures > 0 || (checkOnly && changed > 0)) process.exit(1);
