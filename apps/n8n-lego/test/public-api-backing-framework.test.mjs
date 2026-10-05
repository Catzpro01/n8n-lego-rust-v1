/**
 * P5-M10 CP-01/CP-04 — API mounting framework: the closed model-error ->
 * HTTP mapping, the deterministic data-table filter engine, the mount/unmount
 * lifecycle (rollback = unmount routes; backing models and history untouched),
 * and the static route table's integrity (scopes from the pinned vocabulary,
 * no drift between descriptors and bound handlers).
 *
 * Pure unit level over the P8 local storage facade — no server, no network.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError } from '../src/compat/error.mjs';
import {
  BACKING_RESOURCE_ROUTES,
  backingResourceOperations,
  createBackingModels,
  mapBackingError,
  parseRowFilter,
  rowMatches,
  rowSearchMatches,
  sortRows,
  withBackingErrors,
} from '../src/auth/public-api-backing.mjs';
import { matchPublicApiRoute, mountPublicApiOperations, PUBLIC_API_OPERATIONS } from '../src/auth/public-api-routes.mjs';
import { createLocalStorage } from '../src/lego/storage/local-provider.mjs';
import { StorageError, invalid as storageInvalid, unavailable as storageUnavailable, conflict as storageConflict } from '../src/lego/storage/contract.mjs';
import { ProjectModelError, PROJECT_ERROR_CODES } from '../src/lego/project-sharing-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');
// The pinned upstream API-key vocabulary the P5.3 kernel authorizes against.
const SCOPES = JSON.parse(readFileSync(join(APP_DIR, 'data', 'api-key-scopes.json'), 'utf8'));

const clock = { now: () => 1_760_000_000_000 };
let seq = 0;
const idFactory = () => `id-${String(++seq).padStart(6, '0')}`;

function harness() {
  const storage = createLocalStorage({ clock });
  const lookup = new Map();
  const models = createBackingModels({
    storage,
    clock,
    idFactory,
    executionLookup: (id) => lookup.get(id) ?? null,
  });
  return { storage, models, lookup };
}

function fakeRes() {
  return {
    statusCode: null,
    body: undefined,
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
      return this;
    },
    end(body) {
      this.body = body;
    },
  };
}

describe('mapBackingError — closed model-error -> HTTP mapping (CP-01)', () => {
  test('model codes map by closed suffix: INVALID 400, NOT_FOUND 404, CONFLICT 409', () => {
    assert.equal(mapBackingError(new ProjectModelError(PROJECT_ERROR_CODES.INVALID, 'bad')).status, 400);
    assert.equal(mapBackingError(new ProjectModelError(PROJECT_ERROR_CODES.NOT_FOUND, 'gone')).status, 404);
    assert.equal(mapBackingError(new ProjectModelError(PROJECT_ERROR_CODES.CONFLICT, 'clash')).status, 409);
  });

  test('storage errors: UNAVAILABLE/TIMEOUT 503, INVALID/NOT_FOUND/CONFLICT 400/404/409', () => {
    assert.equal(mapBackingError(storageUnavailable('down')).status, 503);
    assert.equal(mapBackingError(new StorageError('STORAGE_TIMEOUT', 'slow')).status, 503);
    assert.equal(mapBackingError(storageInvalid('shape')).status, 400);
    assert.equal(mapBackingError(storageConflict('race')).status, 409);
  });

  test('unknown failures become 500 without leaking internals', () => {
    const mapped = mapBackingError(new Error('secret internal detail'));
    assert.equal(mapped.status, 500);
    assert.equal(mapped.message, 'Internal Server Error');
  });

  test('HttpError passes through untouched', () => {
    const original = new HttpError(404, 'Not Found');
    assert.equal(mapBackingError(original), original);
  });

  test('withBackingErrors routes model failures through the mapping', async () => {
    const wrapped = withBackingErrors(() => {
      throw new ProjectModelError(PROJECT_ERROR_CODES.CONFLICT, 'taken');
    });
    await assert.rejects(() => wrapped({}), (error) => error instanceof HttpError && error.status === 409 && error.message === 'taken');
  });
});

describe('createBackingModels — one P8 facade, injected clock/ids/lookup', () => {
  test('every dependency is required (no ambient fallbacks)', () => {
    const storage = createLocalStorage({ clock });
    assert.throws(() => createBackingModels({ storage, clock, idFactory }), /executionLookup/);
    assert.throws(() => createBackingModels({ storage, clock, executionLookup: () => null }), /idFactory/);
    assert.throws(() => createBackingModels({ storage, idFactory, executionLookup: () => null }), /clock/);
    assert.throws(() => createBackingModels({ clock, idFactory, executionLookup: () => null }), /storage facade/);
  });

  test('the eight backing models expose their surfaces over the same facade', () => {
    const { models } = harness();
    assert.ok(models.projects && models.audit && models.sourceControl && models.dataTables
      && models.transfers && models.workflowVersions && models.executionRetries && models.executionTags);
    for (const model of Object.values(models)) {
      if (typeof model !== 'function') assert.equal(model.capabilities.durable, false);
    }
    assert.equal(models.projects.capabilities, models.executionTags.capabilities);
  });
});

describe('mount/unmount lifecycle — rollback = unmount routes (CP-04)', () => {
  test('unmount removes the routes; backing models and history stay intact and remount serves again', () => {
    const { models } = harness();
    const project = models.projects.createProject({ name: 'Keep Me', owner: 'owner@example.test' });

    const unmount = mountPublicApiOperations(backingResourceOperations(models, {}));
    assert.equal(matchPublicApiRoute('GET', '/projects').operation.scope, 'project:list');

    // rollback: unmount the API surface
    unmount();
    assert.throws(() => matchPublicApiRoute('GET', '/projects'), (error) => error.status === 404);
    assert.throws(() => matchPublicApiRoute('POST', '/audit'), (error) => error.status === 404);

    // models + history are untouched by the rollback
    const readBack = models.projects.getProject(project.projectId);
    assert.equal(readBack.name, 'Keep Me');
    assert.equal(models.projects.listProjects({}).projects.length, 1);

    // re-mount (roll forward again) serves the same history
    mountPublicApiOperations(backingResourceOperations(models, {}));
    assert.equal(matchPublicApiRoute('GET', '/projects').operation.scope, 'project:list');
    mountPublicApiOperations([]);
  });

  test('base P5-M03..M09 routes survive a backing unmount', () => {
    const { models } = harness();
    const unmount = mountPublicApiOperations(backingResourceOperations(models, {}));
    unmount();
    assert.equal(matchPublicApiRoute('GET', '/workflows').operation.scope, 'workflow:list');
  });

  test('mount binds exactly the static BACKING_RESOURCE_ROUTES table (no drift)', () => {
    const { models } = harness();
    const unmount = mountPublicApiOperations(backingResourceOperations(models, {}));
    for (const route of BACKING_RESOURCE_ROUTES) {
      const matched = matchPublicApiRoute(route.method, route.path.replace(/:([A-Za-z]+)/g, 'x'));
      assert.equal(matched.operation.scope, route.scope, `${route.method} ${route.path}`);
      assert.equal(matched.operation.body ?? false, route.body ?? false);
    }
    assert.equal(backingResourceOperations(models, {}).length, BACKING_RESOURCE_ROUTES.length);
    unmount();
    mountPublicApiOperations([]);
  });

  test('every backing scope exists in the pinned API-key vocabulary (auth boundary)', () => {
    const known = new Set(SCOPES.all);
    for (const route of BACKING_RESOURCE_ROUTES) {
      assert.ok(known.has(route.scope), `${route.method} ${route.path} -> ${route.scope}`);
    }
  });

  test('paths mirror upstream parameter names exactly (the extractor depends on them)', () => {
    for (const route of BACKING_RESOURCE_ROUTES) {
      assert.doesNotMatch(route.path, /\s/);
      for (const param of route.path.matchAll(/:([A-Za-z]+)/g)) {
        assert.ok(['id', 'versionId', 'dataTableId', 'projectId', 'userId'].includes(param[1]),
          `${route.path} uses pinned param name ${param[1]}`);
      }
    }
    // and no base operation collides with a backing route
    const base = new Set(PUBLIC_API_OPERATIONS.map((op) => `${op.method} ${op.path}`));
    for (const route of BACKING_RESOURCE_ROUTES) {
      assert.equal(base.has(`${route.method} ${route.path}`), false, `${route.method} ${route.path}`);
    }
  });
});

describe('data-table filter engine — deterministic, fail-closed', () => {
  const row = (rowId, cells) => ({ rowId, cells, createdAt: 1, updatedAt: 1 });

  test('parseRowFilter validates shape with closed 400s', () => {
    assert.throws(() => parseRowFilter('not json'), (error) => error.status === 400);
    assert.throws(() => parseRowFilter({ type: 'xor', filters: [{ columnName: 'a', condition: 'eq', value: 1 }] }), /and\|or/);
    assert.throws(() => parseRowFilter({ filters: [] }), /non-empty/);
    assert.throws(() => parseRowFilter({ filters: [{ columnName: 'a', condition: 'regex', value: 1 }] }), /eq\|neq/);
    assert.throws(() => parseRowFilter({ filters: [{ columnName: 'a', condition: 'eq' }] }), /required property 'value'/);
  });

  test('and/or semantics over the eight conditions', () => {
    const filter = parseRowFilter({ type: 'and', filters: [
      { columnName: 'status', condition: 'eq', value: 'active' },
      { columnName: 'age', condition: 'gte', value: 18 },
    ] });
    assert.equal(rowMatches(row('1', { status: 'active', age: 21 }), filter), true);
    assert.equal(rowMatches(row('2', { status: 'active', age: 17 }), filter), false);
    const any = parseRowFilter({ type: 'or', filters: [
      { columnName: 'status', condition: 'eq', value: 'active' },
      { columnName: 'age', condition: 'lt', value: 5 },
    ] });
    assert.equal(rowMatches(row('3', { status: 'idle', age: 3 }), any), true);
    assert.equal(rowMatches(row('4', { status: 'idle', age: 30 }), any), false);
  });

  test('like/ilike substring matching; neq; numeric coercion on eq', () => {
    assert.equal(rowMatches(row('1', { name: 'Ada Lovelace' }), parseRowFilter({ filters: [{ columnName: 'name', condition: 'like', value: 'love' }] })), false);
    assert.equal(rowMatches(row('1', { name: 'Ada Lovelace' }), parseRowFilter({ filters: [{ columnName: 'name', condition: 'ilike', value: 'love' }] })), true);
    assert.equal(rowMatches(row('2', { n: '42' }), parseRowFilter({ filters: [{ columnName: 'n', condition: 'eq', value: 42 }] })), true);
    assert.equal(rowMatches(row('3', { n: 1 }), parseRowFilter({ filters: [{ columnName: 'n', condition: 'neq', value: 1 }] })), false);
  });

  test('unknown columns never match (fail-closed: a typo cannot widen a delete)', () => {
    const filter = parseRowFilter({ filters: [{ columnName: 'nope', condition: 'eq', value: 1 }] });
    assert.equal(rowMatches(row('1', { a: 1 }), filter), false);
  });

  test('sortRows is deterministic with rowId tiebreak, asc/desc', () => {
    const rows = [row('b', { n: 1 }), row('a', { n: 1 }), row('c', { n: 0 })];
    assert.deepEqual(sortRows(rows, 'n:asc').map((r) => r.rowId), ['c', 'a', 'b']);
    assert.deepEqual(sortRows(rows, 'n:desc').map((r) => r.rowId), ['a', 'b', 'c']);
    assert.throws(() => sortRows(rows, 'n:sideways'), /field:asc or field:desc/);
  });

  test('rowSearchMatches scans only string cells, case-insensitively', () => {
    assert.equal(rowSearchMatches(row('1', { a: 'Hello World', b: 42 }), 'world'), true);
    assert.equal(rowSearchMatches(row('2', { a: 42 }), '42'), false);
  });
});
