/**
 * P5-M14 data-table backing model (P5-M10-D): column schema + row records with
 * typed cells over the P8 storage facade. The /api/v1/data-tables surface stays
 * gated upstream; it mounts on this model later.
 *
 * Records (closed shapes):
 *   table {tag:1, tableId, name, columns:[{name,type,required,default}], createdAt, updatedAt, metadata}
 *   row   {tag:2, tableId, rowId, cells:{col: typedValue}, createdAt, updatedAt}
 *
 * Column types (closed): string | number | boolean | date | json
 *   - string/number/boolean: strict typeof (number must be finite)
 *   - date: integer ms timestamp
 *   - json: any structured value (cloned on write)
 *
 * Schema evolution (race-safe, no silent data reinterpretation):
 *   - addColumn: appends an optional column (existing rows read null); a required
 *     column without a default on a non-empty table is TABLE_CONFLICT (explicit
 *     refusal, no implicit backfill);
 *   - renameColumn / dropColumn rewrite schema AND rows in ONE applyBatch
 *     (all-or-nothing, every op carries its expectedVersion) - a concurrent row
 *     or schema change fails the whole batch as TABLE_CONFLICT;
 *   - every evolution step bumps the table version (CAS, version token REQUIRED).
 *
 * Row CRUD: typed-cell validation on write; updates and deletes are pure CAS.
 * Creates use pre-check + put + read-back verify (P8-S01 has no atomic
 * create-if-absent; documented deviation). List cursors are filter-aware result
 * cursors (stateless, key of the last returned row).
 *
 * Error set (closed): TABLE_INVALID | TABLE_NOT_FOUND | TABLE_CONFLICT.
 * Storage errors propagate unchanged.
 */

export const TABLE_ERROR_CODES = Object.freeze({
  INVALID: 'TABLE_INVALID',
  NOT_FOUND: 'TABLE_NOT_FOUND',
  CONFLICT: 'TABLE_CONFLICT',
});

export class DataTableModelError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'DataTableModelError';
    this.code = code;
    this.details = options.details ?? {};
    if (!Object.values(TABLE_ERROR_CODES).includes(code)) {
      throw new TypeError(`DataTableModelError: unknown code ${String(code)}`);
    }
  }
}

const invalid = (message, details) => new DataTableModelError(TABLE_ERROR_CODES.INVALID, message, { details });
const notFound = (message, details) => new DataTableModelError(TABLE_ERROR_CODES.NOT_FOUND, message, { details });
const conflict = (message, details) => new DataTableModelError(TABLE_ERROR_CODES.CONFLICT, message, { details });

/** Closed column-type vocabulary. */
export const COLUMN_TYPES = Object.freeze(['string', 'number', 'boolean', 'date', 'json']);

const TABLE_TAG = 1;
const ROW_TAG = 2;

const tableKey = (tableId) => `t:${tableId}`;
const rowKey = (tableId, rowId) => `r:${tableId}:${rowId}`;

const assertId = (value, field) => {
  if (typeof value !== 'string' || value.length < 6 || value.length > 128) {
    throw invalid(`${field} must be an opaque string of 6..128 characters`);
  }
  return value;
};
const assertName = (value, field) => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    throw invalid(`${field} must be a non-empty name of at most 200 characters`);
  }
  return value.trim();
};

const cellValueOk = (type, value) => {
  if (value === null) return true; // explicit null is a typed absence
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'date': return Number.isInteger(value);
    case 'json': return true;
    default: return false;
  }
};

const assertColumnShape = (column) => {
  if (column === null || typeof column !== 'object' || Array.isArray(column)) {
    throw invalid('column must be an object');
  }
  const name = assertName(column.name, 'column.name');
  if (!COLUMN_TYPES.includes(column.type)) {
    throw invalid(`column.type must be one of ${COLUMN_TYPES.join('|')}`, { type: String(column.type).slice(0, 32) });
  }
  const required = Boolean(column.required ?? false);
  const hasDefault = Object.prototype.hasOwnProperty.call(column, 'default') && column.default !== undefined;
  if (hasDefault && !cellValueOk(column.type, column.default)) {
    throw invalid('column.default does not match column.type');
  }
  if (required && !hasDefault && column.default !== null) {
    // required without default is legal at CREATE time (empty table) - checked
    // against non-empty tables at addColumn time.
  }
  return {
    name,
    type: column.type,
    required,
    ...(hasDefault ? { default: structuredClone(column.default) } : {}),
  };
};

const assertColumns = (columns) => {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw invalid('columns must be a non-empty array');
  }
  const seen = new Set();
  return columns.map((column) => {
    const clean = assertColumnShape(column);
    if (seen.has(clean.name)) throw invalid(`duplicate column name ${clean.name}`);
    seen.add(clean.name);
    return clean;
  });
};

/**
 * @param {object} storage storage facade handle - the ONLY persistence boundary
 * @param {object} options
 * @param {{ now: () => number }} options.clock REQUIRED deterministic clock (ms)
 * @param {() => string} options.idFactory REQUIRED opaque id factory
 * @param {string} [options.namespace='data-tables']
 */
export function createDataTableModel(storage, { clock, idFactory, namespace = 'data-tables' } = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.putIfVersion !== 'function') {
    throw invalid('createDataTableModel requires a storage facade handle');
  }
  if (!clock || typeof clock.now !== 'function') throw invalid('an injected clock is required');
  if (typeof idFactory !== 'function') throw invalid('an injected idFactory is required');

  const readJson = (key, tag, kind) => {
    const got = storage.get(namespace, key);
    if (!got.found) return null;
    let record;
    try {
      record = JSON.parse(got.value.toString('utf8'));
    } catch (error) {
      throw conflict(`${kind} record is unreadable`, { cause: error });
    }
    if (record.tag !== tag) throw conflict(`${kind} record has an unsupported shape`);
    return { record, version: got.version };
  };

  const readTable = (tableId) => {
    const found = readJson(tableKey(tableId), TABLE_TAG, 'table');
    if (!found) throw notFound('table not found', { tableId: tableId.slice(0, 8) });
    return found;
  };
  const readRow = (tableId, rowId) => {
    const found = readJson(rowKey(tableId, rowId), ROW_TAG, 'row');
    if (!found) throw notFound('row not found', { rowId: rowId.slice(0, 8) });
    return found;
  };

  const requireVersion = (version) => {
    if (typeof version !== 'string' || version.length === 0) {
      throw invalid('a CAS version token is required for this update');
    }
    return version;
  };

  /** Unique-id create: pre-check + put + read-back verify. */
  const createRecord = (key, record) => {
    if (storage.get(namespace, key).found) throw conflict('record already exists');
    const bytes = Buffer.from(JSON.stringify(record), 'utf8');
    storage.put(namespace, key, bytes);
    const verify = storage.get(namespace, key);
    if (!verify.found || !verify.value.equals(bytes)) {
      throw conflict('create lost a concurrent write');
    }
    return Object.freeze({ ...record, version: verify.version });
  };

  const casUpdate = (key, record, version, kind) => {
    requireVersion(version);
    const applied = storage.putIfVersion(
      namespace, key, Buffer.from(JSON.stringify(record), 'utf8'), version,
    );
    if (!applied.applied) {
      throw conflict(`${kind} update lost a concurrent update`, { reason: applied.reason });
    }
    return Object.freeze({ ...record, version: applied.version });
  };

  /** Validate + normalize a partial cell patch against the schema. */
  const cleanCells = (columns, cells, { partial }) => {
    if (cells === null || typeof cells !== 'object' || Array.isArray(cells)) {
      throw invalid('cells must be an object');
    }
    const byName = new Map(columns.map((c) => [c.name, c]));
    const out = {};
    for (const [name, value] of Object.entries(cells)) {
      const column = byName.get(name);
      if (!column) throw invalid(`unknown column ${name}`, { column: name });
      if (!cellValueOk(column.type, value)) {
        throw invalid(`cell ${name} does not match column type ${column.type}`, { column: name });
      }
      out[name] = value === null ? null : structuredClone(value);
    }
    if (!partial) {
      for (const column of columns) {
        if (!Object.prototype.hasOwnProperty.call(out, column.name)) {
          if (column.required && !Object.prototype.hasOwnProperty.call(column, 'default')) {
            throw invalid(`required column ${column.name} is missing`, { column: column.name });
          }
          if (Object.prototype.hasOwnProperty.call(column, 'default')) {
            out[column.name] = structuredClone(column.default);
          } else {
            out[column.name] = null;
          }
        }
      }
    } else {
      for (const [name, value] of Object.entries(out)) {
        const column = byName.get(name);
        if (value === null && column.required && !Object.prototype.hasOwnProperty.call(column, 'default')) {
          throw invalid(`required column ${name} cannot be null`, { column: name });
        }
      }
    }
    return out;
  };

  const allRows = (tableId) => {
    const rows = [];
    let scan;
    for (;;) {
      const page = storage.list(namespace, { cursor: scan, limit: 1000 });
      for (const entry of page.keys) {
        if (!entry.key.startsWith(`r:${tableId}:`)) continue;
        const found = readJson(entry.key, ROW_TAG, 'row');
        if (found) rows.push({ key: entry.key, record: found.record, version: entry.version });
      }
      if (!page.nextCursor) break;
      scan = page.nextCursor;
    }
    rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return rows;
  };

  /** Atomic schema rewrite of schema + rows in one all-or-nothing batch. */
  const evolveSchema = (tableId, { version, nextColumns, rowTransform }) => {
    requireVersion(version);
    const { record: table, version: tableVersion } = readTable(tableId);
    if (tableVersion !== version) throw conflict('table schema changed concurrently');
    const rows = allRows(tableId);
    const now = clock.now();
    const nextTable = { ...table, columns: nextColumns, updatedAt: now };
    const ops = [{
      type: 'put', namespace, key: tableKey(tableId),
      value: Buffer.from(JSON.stringify(nextTable), 'utf8'), expectedVersion: version,
    }];
    for (const row of rows) {
      const cells = rowTransform(row.record.cells);
      const nextRow = { ...row.record, cells, updatedAt: now };
      ops.push({
        type: 'put', namespace, key: row.key,
        value: Buffer.from(JSON.stringify(nextRow), 'utf8'), expectedVersion: row.version,
      });
    }
    const result = storage.applyBatch(ops);
    if (!result.applied) {
      throw conflict('schema evolution lost a concurrent update (all-or-nothing batch aborted)', {
        failedOpIndex: result.failedOpIndex, reason: result.reason,
      });
    }
    return Object.freeze({ ...nextTable, version: storage.get(namespace, tableKey(tableId)).version });
  };

  return Object.freeze({
    capabilities: storage.capabilities,
    namespace,

    /* ------------------------------------------------------------ tables */

    createTable({ name, columns, metadata = null } = {}) {
      const tableId = assertId(idFactory(), 'idFactory output');
      const now = clock.now();
      const record = {
        tag: TABLE_TAG,
        tableId,
        name: assertName(name, 'name'),
        columns: assertColumns(columns),
        createdAt: now,
        updatedAt: now,
        metadata: metadata === undefined ? null : structuredClone(metadata),
      };
      return createRecord(tableKey(tableId), record);
    },

    getTable(tableId) {
      assertId(tableId, 'tableId');
      const { record, version } = readTable(tableId);
      return Object.freeze({ ...record, version });
    },

    renameTable(tableId, name, { version } = {}) {
      assertId(tableId, 'tableId');
      const { record } = readTable(tableId);
      return casUpdate(tableKey(tableId), { ...record, name: assertName(name, 'name'), updatedAt: clock.now() }, version, 'table');
    },

    /* ------------------------------------------------- schema evolution */

    /** Append a column. Required-without-default on a non-empty table = CONFLICT. */
    addColumn(tableId, column, { version } = {}) {
      assertId(tableId, 'tableId');
      requireVersion(version);
      const clean = assertColumnShape(column);
      const { record: table, version: tableVersion } = readTable(tableId);
      if (tableVersion !== version) throw conflict('table schema changed concurrently');
      if (table.columns.some((c) => c.name === clean.name)) {
        throw invalid(`duplicate column name ${clean.name}`);
      }
      const rows = allRows(tableId);
      if (clean.required && !Object.prototype.hasOwnProperty.call(clean, 'default') && rows.length > 0) {
        throw conflict('a required column without a default cannot be added to a non-empty table');
      }
      return evolveSchema(tableId, {
        version,
        nextColumns: [...table.columns, clean],
        rowTransform: (cells) => ({ ...cells, [clean.name]: clean.default ?? null }),
      });
    },

    /** Rename a column atomically across schema AND rows (one batch). */
    renameColumn(tableId, oldName, newName, { version } = {}) {
      assertId(tableId, 'tableId');
      requireVersion(version);
      const cleanNew = assertName(newName, 'newName');
      const { record: table } = readTable(tableId);
      const column = table.columns.find((c) => c.name === oldName);
      if (!column) throw notFound('column not found', { column: String(oldName).slice(0, 32) });
      if (oldName === cleanNew) return this.getTable(tableId);
      if (table.columns.some((c) => c.name === cleanNew)) {
        throw invalid(`duplicate column name ${cleanNew}`);
      }
      const nextColumns = table.columns.map((c) => (c.name === oldName ? { ...c, name: cleanNew } : c));
      return evolveSchema(tableId, {
        version,
        nextColumns,
        rowTransform: (cells) => {
          const next = {};
          for (const [key, value] of Object.entries(cells)) {
            next[key === oldName ? cleanNew : key] = value;
          }
          return next;
        },
      });
    },

    /** Drop a column atomically (schema + row cells, one batch). */
    dropColumn(tableId, name, { version } = {}) {
      assertId(tableId, 'tableId');
      requireVersion(version);
      const { record: table } = readTable(tableId);
      const column = table.columns.find((c) => c.name === name);
      if (!column) throw notFound('column not found', { column: String(name).slice(0, 32) });
      const nextColumns = table.columns.filter((c) => c.name !== name);
      if (nextColumns.length === 0) throw invalid('a table must keep at least one column');
      return evolveSchema(tableId, {
        version,
        nextColumns,
        rowTransform: (cells) => {
          const next = {};
          for (const [key, value] of Object.entries(cells)) {
            if (key !== name) next[key] = value;
          }
          return next;
        },
      });
    },

    /* --------------------------------------------------------------- rows */

    createRow(tableId, { rowId, cells, metadata = null } = {}) {
      assertId(tableId, 'tableId');
      const { record: table } = readTable(tableId);
      const cleanRowId = rowId === undefined ? assertId(idFactory(), 'idFactory output') : assertId(rowId, 'rowId');
      const now = clock.now();
      const record = {
        tag: ROW_TAG,
        tableId,
        rowId: cleanRowId,
        cells: cleanCells(table.columns, cells ?? {}, { partial: false }),
        createdAt: now,
        updatedAt: now,
        metadata: metadata === undefined ? null : structuredClone(metadata),
      };
      return createRecord(rowKey(tableId, cleanRowId), record);
    },

    getRow(tableId, rowId) {
      assertId(tableId, 'tableId');
      assertId(rowId, 'rowId');
      const { record, version } = readRow(tableId, rowId);
      return Object.freeze({ ...record, version });
    },

    /** Partial cell patch (pure CAS). */
    updateRow(tableId, rowId, cells, { version } = {}) {
      assertId(tableId, 'tableId');
      assertId(rowId, 'rowId');
      const { record: table } = readTable(tableId);
      const { record: row } = readRow(tableId, rowId);
      const patch = cleanCells(table.columns, cells, { partial: true });
      const next = { ...row, cells: { ...row.cells, ...patch }, updatedAt: clock.now() };
      return casUpdate(rowKey(tableId, rowId), next, version, 'row');
    },

    deleteRow(tableId, rowId, { version } = {}) {
      assertId(tableId, 'tableId');
      assertId(rowId, 'rowId');
      requireVersion(version);
      const result = storage.deleteIfVersion(namespace, rowKey(tableId, rowId), version);
      if (!result.applied) {
        throw conflict('row delete lost a concurrent update', { reason: result.reason });
      }
      return Object.freeze({ deleted: true });
    },

    /** Filter-aware cursor paging over rows (stable key order, opaque cursor). */
    /**
     * Bounded listing over tables (P5-M10: GET /data-tables). Stable key
     * order, opaque cursor = table key of the last returned item.
     */
    listTables({ cursor = null, limit = 100 } = {}) {
      if (cursor !== null && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 256)) {
        throw invalid('cursor must be an opaque token issued by a previous list call');
      }
      if (!Number.isInteger(limit) || limit <= 0) throw invalid('limit must be a positive integer');
      const collected = [];
      let scan;
      for (;;) {
        const page = storage.list(namespace, { cursor: scan, limit: 1000 });
        for (const entry of page.keys) {
          if (!entry.key.startsWith('t:')) continue;
          const found = readJson(entry.key, TABLE_TAG, 'table');
          if (found) collected.push({ ...found.record, version: entry.version });
        }
        if (!page.nextCursor) break;
        scan = page.nextCursor;
      }
      collected.sort((a, b) => (tableKey(a.tableId) < tableKey(b.tableId) ? -1 : 1));
      const after = cursor === null ? collected : collected.filter((r) => tableKey(r.tableId) > cursor);
      const items = after.slice(0, limit);
      const last = items[items.length - 1];
      return Object.freeze({
        tables: Object.freeze(items),
        nextCursor: after.length > items.length && last ? tableKey(last.tableId) : null,
      });
    },

    /**
     * Delete a table with all of its rows in ONE all-or-nothing batch (P5-M10
     * DELETE /data-tables/{id}: upstream "also deletes all rows"). Pure CAS:
     * the table's version token is required; every row delete carries its own
     * expectedVersion, so a mid-batch conflict applies NOTHING.
     */
    deleteTable(tableId, { version } = {}) {
      assertId(tableId, 'tableId');
      requireVersion(version);
      const rows = allRows(tableId);
      const ops = [
        { type: 'delete', namespace, key: tableKey(tableId), expectedVersion: version },
        ...rows.map((entry) => ({ type: 'delete', namespace, key: entry.key, expectedVersion: entry.version })),
      ];
      const result = storage.applyBatch(ops);
      if (!result.applied) {
        throw conflict('table delete lost a concurrent update (all-or-nothing batch aborted)', {
          failedOpIndex: result.failedOpIndex, reason: result.reason,
        });
      }
      return Object.freeze({ deleted: true, rows: rows.length });
    },

    listRows(tableId, { cursor = null, limit = 100 } = {}) {
      assertId(tableId, 'tableId');
      readTable(tableId);
      if (cursor !== null && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 256)) {
        throw invalid('cursor must be an opaque token issued by a previous list call');
      }
      if (!Number.isInteger(limit) || limit <= 0) throw invalid('limit must be a positive integer');
      const rows = allRows(tableId).map((entry) => ({ ...entry.record, version: entry.version }));
      const after = cursor === null ? rows : rows.filter((r) => rowKey(tableId, r.rowId) > cursor);
      const items = after.slice(0, limit);
      const last = items[items.length - 1];
      return Object.freeze({
        rows: Object.freeze(items),
        nextCursor: after.length > items.length && last ? rowKey(tableId, last.rowId) : null,
      });
    },
  });
}

export const DATA_TABLE_MODEL_VERSION = 1;
