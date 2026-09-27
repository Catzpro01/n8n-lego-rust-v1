/**
 * P5-M14 — data-table backing model over the storage facade: column schema +
 * row records with typed cells. Schema evolution + row CRUD; API routes stay
 * gated upstream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/lego/storage/contract.mjs';
import { createLocalStorage } from '../src/lego/storage/local-provider.mjs';
import { createTestClock } from '../src/lego/storage/conformance.mjs';
import {
  createDataTableModel, DataTableModelError, TABLE_ERROR_CODES, COLUMN_TYPES,
} from '../src/lego/data-table-model.mjs';

const SCHEMA = [
  { name: 'id', type: 'string', required: true },
  { name: 'age', type: 'number' },
  { name: 'active', type: 'boolean', default: true },
  { name: 'joined', type: 'date' },
  { name: 'meta', type: 'json' },
];

const setup = (name) => {
  const clock = createTestClock();
  const provider = createLocalStorage({ clock });
  let n = 0;
  const idFactory = () => `tbl-${String(++n).padStart(6, '0')}-id`;
  const namespace = `dtab-${name.replace(/\W+/g, '_')}`;
  const hostA = createDataTableModel(createStorage(provider), { clock, idFactory, namespace });
  const hostB = createDataTableModel(createStorage(provider), { clock, idFactory, namespace });
  return { clock, hostA, hostB };
};

const seedTable = (host, columns = SCHEMA) =>
  host.createTable({ name: 'users', columns });

test('1. table: create/get/rename lifecycle; closed column-type vocabulary', () => {
  const { hostA } = setup('t1');
  const created = seedTable(hostA);
  assert.equal(created.tableId, 'tbl-000001-id', 'injected idFactory is deterministic');
  assert.equal(created.columns.length, 5);
  assert.deepEqual(COLUMN_TYPES, ['string', 'number', 'boolean', 'date', 'json']);

  const got = hostA.getTable(created.tableId);
  assert.equal(typeof got.version, 'string');
  const renamed = hostA.renameTable(created.tableId, 'users-2026', { version: got.version });
  assert.equal(renamed.name, 'users-2026');
  assert.notEqual(renamed.version, got.version);

  assert.throws(() => hostA.createTable({ name: 'x', columns: [{ name: 'a', type: 'blob' }] }),
    (e) => e instanceof DataTableModelError && e.code === TABLE_ERROR_CODES.INVALID);
  assert.throws(() => hostA.createTable({ name: 'x', columns: [{ name: 'a', type: 'string' }, { name: 'a', type: 'number' }] }),
    (e) => e.code === TABLE_ERROR_CODES.INVALID, 'duplicate column names are refused');
});

test('2. row CRUD: typed cells validated on create and update', () => {
  const { hostA } = setup('t2');
  const { tableId } = seedTable(hostA);
  const row = hostA.createRow(tableId, {
    cells: { id: 'u1', age: 30, joined: 1700000000000, meta: { plan: 'pro' } },
  });
  assert.equal(row.cells.active, true, 'default backfilled on create');
  assert.equal(row.cells.age, 30);

  const updated = hostA.updateRow(tableId, row.rowId, { age: 31 }, { version: row.version });
  assert.equal(updated.cells.age, 31);
  assert.equal(updated.cells.id, 'u1', 'partial patch keeps other cells');

  assert.throws(() => hostA.updateRow(tableId, row.rowId, { age: 'old' }, { version: updated.version }),
    (e) => e.code === TABLE_ERROR_CODES.INVALID, 'type mismatch refused');
  assert.throws(() => hostA.createRow(tableId, { cells: { nope: 1 } }),
    (e) => e.code === TABLE_ERROR_CODES.INVALID, 'unknown column refused');
  assert.throws(() => hostA.createRow(tableId, { cells: { age: 1 } }),
    (e) => e.code === TABLE_ERROR_CODES.INVALID, 'missing required column refused');

  const deleted = hostA.deleteRow(tableId, row.rowId, { version: updated.version });
  assert.equal(deleted.deleted, true);
  assert.throws(() => hostA.getRow(tableId, row.rowId),
    (e) => e.code === TABLE_ERROR_CODES.NOT_FOUND, 'backing-model reads throw NOT_FOUND (family convention)');
});

test('3. schema evolution: addColumn backfills; required-without-default on non-empty is CONFLICT', () => {
  const { hostA } = setup('t3');
  const created = seedTable(hostA);
  const added = hostA.addColumn(created.tableId, { name: 'nickname', type: 'string' }, { version: created.version });
  assert.equal(added.columns.length, 6);
  const row = hostA.createRow(created.tableId, { cells: { id: 'u1' } });
  assert.equal(row.cells.nickname, null, 'absent optional cells read null');

  assert.throws(
    () => hostA.addColumn(created.tableId, { name: 'email', type: 'string', required: true }, { version: added.version }),
    (e) => e.code === TABLE_ERROR_CODES.CONFLICT,
    'required-without-default on a non-empty table is an explicit refusal',
  );
  const withDefault = hostA.addColumn(created.tableId,
    { name: 'email', type: 'string', required: true, default: 'unknown' }, { version: added.version });
  assert.equal(withDefault.columns.length, 7);
});

test('4. schema evolution: renameColumn/dropColumn rewrite schema AND rows atomically', () => {
  const { hostA } = setup('t4');
  const created = seedTable(hostA);
  hostA.createRow(created.tableId, { rowId: 'row-000001', cells: { id: 'u1', age: 1 } });
  hostA.createRow(created.tableId, { rowId: 'row-000002', cells: { id: 'u2', age: 2 } });

  const renamed = hostA.renameColumn(created.tableId, 'age', 'years', { version: created.version });
  assert.equal(renamed.columns.find((c) => c.name === 'years').type, 'number');
  const row = hostA.getRow(created.tableId, 'row-000001');
  assert.equal(row.cells.years, 1, 'row cells follow the rename');
  assert.equal('age' in row.cells, false);

  const dropped = hostA.dropColumn(created.tableId, 'meta', { version: renamed.version });
  assert.equal(dropped.columns.length, 4);
  assert.equal('meta' in hostA.getRow(created.tableId, 'row-000002').cells, false, 'cells follow the drop');

  assert.throws(() => hostA.renameColumn(created.tableId, 'ghost', 'x', { version: dropped.version }),
    (e) => e.code === TABLE_ERROR_CODES.NOT_FOUND);
  const single = hostA.createTable({ name: 'one', columns: [{ name: 'only', type: 'string' }] });
  assert.throws(() => hostA.dropColumn(single.tableId, 'only', { version: single.version }),
    (e) => e.code === TABLE_ERROR_CODES.INVALID, 'a table must keep at least one column');
});

test('5. conflict semantics: stale CAS never silently wins (rows and schema)', () => {
  const { hostA } = setup('t5');
  const created = seedTable(hostA);
  const row = hostA.createRow(created.tableId, { cells: { id: 'u1' } });
  const stale = row.version;
  hostA.updateRow(created.tableId, row.rowId, { age: 1 }, { version: stale });
  assert.throws(() => hostA.updateRow(created.tableId, row.rowId, { age: 2 }, { version: stale }),
    (e) => e.code === TABLE_ERROR_CODES.CONFLICT);
  assert.equal(hostA.getRow(created.tableId, row.rowId).cells.age, 1, 'winning write survives');

  hostA.renameTable(created.tableId, 'first', { version: created.version });
  assert.throws(() => hostA.renameTable(created.tableId, 'second', { version: created.version }),
    (e) => e.code === TABLE_ERROR_CODES.CONFLICT, 'schema CAS refuses stale tokens (row writes do not bump the schema version)');
  assert.throws(() => hostA.updateRow(created.tableId, row.rowId, { age: 3 }),
    (e) => e.code === TABLE_ERROR_CODES.INVALID, 'CAS updates REQUIRE the explicit version token');
  assert.throws(() => hostA.getRow('tbl-999999-id', 'row-000001'),
    (e) => e.code === TABLE_ERROR_CODES.NOT_FOUND);
});

test('6. multi-host: shared table, cross-host row + schema conflicts are explicit', () => {
  const { hostA, hostB } = setup('t6');
  const created = hostA.createTable({ name: 'shared', columns: [{ name: 'k', type: 'string', required: true }] });
  const row = hostB.createRow(created.tableId, { cells: { k: 'v' } });
  hostA.updateRow(created.tableId, row.rowId, { k: 'a' }, { version: row.version });
  assert.throws(() => hostB.updateRow(created.tableId, row.rowId, { k: 'b' }, { version: row.version }),
    (e) => e.code === TABLE_ERROR_CODES.CONFLICT, 'cross-host lost update is explicit');
  assert.equal(hostB.getRow(created.tableId, row.rowId).cells.k, 'a');

  hostA.addColumn(created.tableId, { name: 'extra', type: 'number' }, { version: created.version });
  assert.throws(() => hostB.addColumn(created.tableId, { name: 'extra2', type: 'number' }, { version: created.version }),
    (e) => e.code === TABLE_ERROR_CODES.CONFLICT, 'stale schema version refused across hosts');
  assert.equal(hostB.getTable(created.tableId).columns.length, 2, 'evolution visible to the other host');
});

test('7. listRows: filter-aware cursor paging, stable order, no empty page with nextCursor', () => {
  const { hostA } = setup('t7');
  const { tableId } = seedTable(hostA);
  for (let i = 0; i < 5; i += 1) {
    hostA.createRow(tableId, { rowId: `row-00000${i}`, cells: { id: `u${i}` } });
  }
  const page1 = hostA.listRows(tableId, { limit: 2 });
  assert.deepEqual(page1.rows.map((r) => r.rowId), ['row-000000', 'row-000001']);
  assert.ok(page1.nextCursor);
  const page2 = hostA.listRows(tableId, { limit: 2, cursor: page1.nextCursor });
  assert.deepEqual(page2.rows.map((r) => r.rowId), ['row-000002', 'row-000003']);
  const page3 = hostA.listRows(tableId, { limit: 2, cursor: page2.nextCursor });
  assert.deepEqual(page3.rows.map((r) => r.rowId), ['row-000004']);
  assert.equal(page3.nextCursor, null, 'no more rows -> cursor null');
});

test('8. rollback = unmount: namespace isolation leaves history untouched but hidden', () => {
  const { hostA, clock } = setup('t8');
  const created = seedTable(hostA);
  hostA.createRow(created.tableId, { cells: { id: 'u1' } });
  const other = createDataTableModel(createStorage(createLocalStorage({ clock })), {
    clock,
    idFactory: () => 'tbl-999999-id',
    namespace: 'dtab_t8_v2',
  });
  assert.throws(() => other.getTable(created.tableId),
    (e) => e.code === TABLE_ERROR_CODES.NOT_FOUND);
  assert.equal(hostA.getTable(created.tableId).name, 'users', 'original history stays intact');
});

test('9. surface pin + determinism: closed model keys and stable serialization', () => {
  const { hostA } = setup('t9');
  assert.deepEqual(Object.keys(hostA).sort(), [
    'addColumn', 'capabilities', 'createRow', 'createTable', 'deleteRow', 'dropColumn',
    'getRow', 'getTable', 'listRows', 'namespace', 'renameColumn', 'renameTable', 'updateRow',
  ].sort(), 'model surface is closed');

  const clock = createTestClock();
  const mk = (ns) => createDataTableModel(createStorage(createLocalStorage({ clock })), {
    clock, idFactory: () => 'tbl-000001-id', namespace: ns,
  });
  const a = mk('deta').createTable({ name: 'x', columns: [{ name: 'a', type: 'string' }] });
  const b = mk('detb').createTable({ name: 'x', columns: [{ name: 'a', type: 'string' }] });
  const { version: _va, ...ba } = a;
  const { version: _vb, ...bb } = b;
  assert.equal(JSON.stringify(ba), JSON.stringify(bb), 'identical inputs, identical records');
});
