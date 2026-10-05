/**
 * Fixture plumbing for the regression suite.
 *
 * Volatile fields (ids, timestamps, durations) are normalised away so the
 * snapshot compares *behaviour* only — that is what makes these expected files
 * usable as the equivalence baseline for the later Rust migration.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_TESTS = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_ROOT = join(RUNTIME_TESTS, '..', 'fixtures', 'runtime');
export const WORKFLOW_DIR = join(FIXTURE_ROOT, 'workflows');
export const EXPECTED_DIR = join(FIXTURE_ROOT, 'expected');

export async function loadFixtures() {
  const entries = await readdir(WORKFLOW_DIR);
  const fixtures = [];
  for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
    const fixture = JSON.parse(await readFile(join(WORKFLOW_DIR, entry), 'utf8'));
    fixtures.push({ ...fixture, file: entry, id: fixture.id ?? entry.replace(/\.json$/, '') });
  }
  return fixtures;
}

export async function readExpected(id) {
  try {
    return JSON.parse(await readFile(join(EXPECTED_DIR, `${id}.json`), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeExpected(id, value) {
  await writeFile(join(EXPECTED_DIR, `${id}.json`), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Strip everything that legitimately changes between runs. */
export function normalizeRunResult(run) {
  const log = (run.executionLog ?? []).map((entry) => {
    const copy = { ...entry };
    delete copy.durationMs;
    return copy;
  });
  return {
    status: run.status,
    finished: run.finished,
    executionLog: log,
    data: run.data,
    warnings: (run.warnings ?? []).map((warning) => ({ ...warning })),
  };
}

/** Fixtures are pinned to English so the snapshots do not depend on the default locale. */
export const FIXTURE_LOCALE = 'en';

export function requestBodyFor(fixture) {
  const body = { workflow: fixture.workflow, requestedBy: 'http', locale: fixture.locale ?? FIXTURE_LOCALE };
  if (fixture.input !== undefined && fixture.input !== null) body.input = fixture.input;
  if (fixture.startNode) body.startNode = fixture.startNode;
  return body;
}
