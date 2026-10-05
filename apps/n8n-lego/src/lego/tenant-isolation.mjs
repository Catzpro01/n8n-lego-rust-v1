/** P9.19 multi-tenant telemetry isolation readiness. Product owner agent-6;
 * implementation delegate Agent 4 (Issue #101). Tenant scope exists in the
 * contract where authorized; queries and export routing enforce it;
 * cross-tenant leakage fails closed; global aggregates are structurally
 * separated from tenant data; tenant identifiers never become metric labels;
 * single-tenant deployments stay lightweight (flat bucket, no tenant map).
 * No I/O, no clock, no workflow/execution import.
 */
import { containsSecretShape } from './telemetry-redaction.mjs';

export const TENANTISO_CONTRACT = Object.freeze({
  id: 'observability.tenant-isolation', version: '1.0.0', owner: 'agent-6',
});
export const TENANTISO_SCHEMA_VERSION = '1.0.0';

/** single = one deployment, no tenant map (lightweight). multi = scoped. */
export const TENANTISO_MODES = Object.freeze(['single', 'multi']);

/** Report scopes: tenant data and global aggregates never share a scope tag. */
export const TENANTISO_SCOPES = Object.freeze(['tenant', 'global']);

/** Metric label keys that must never carry tenant identity (deny on sight). */
export const TENANTISO_LABEL_DENY = Object.freeze([
  'tenantId', 'tenant', 'tenant_id', 'tenantID', 'tenantIdentifier',
  'orgId', 'organizationId', 'workspaceId', 'customerId',
]);

export const TENANTISO_LIMITS = Object.freeze({
  identifierBytes: 128,
  minMaxRecords: 1,
  maxMaxRecords: 65536,
  defaultMaxRecords: 1024,
  minMaxTenants: 1,
  maxMaxTenants: 1000,
  defaultMaxTenants: 64,
  maxChannels: 64,
  channelBytes: 64,
  maxQueryLimit: 1000,
  maxLabels: 16,
  labelKeyBytes: 64,
});

export const TENANTISO_NOTES = Object.freeze([
  'tenant-scope-where-authorized',
  'queries-enforce-scope',
  'export-routing-respects-scope',
  'cross-tenant-fail-closed',
  'global-aggregates-separated',
  'tenant-ids-not-metric-labels',
  'single-tenant-lightweight',
]);

const CONFIG_KEYS = Object.freeze(['mode', 'maxRecords', 'maxTenants', 'globalAggregates']);
const AUTH_KEYS = Object.freeze(['tenantId', 'scope']);
const QUERY_KEYS = Object.freeze(['tenantId', 'limit']);
const RECORD_KEYS = Object.freeze(['id', 'tenantId', 'channel']);
const ROUTE_KEYS = Object.freeze(['id', 'tenantId', 'channel']);
const IDENT = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;

function isPlain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function err(code, message, extra = undefined) {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message, ...(extra ? { ...extra } : {}) }),
  });
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= TENANTISO_LIMITS.identifierBytes &&
    IDENT.test(value) && !value.includes('://');
}

/**
 * Create a tenant-isolation controller. Config:
 *  mode ('single' default = lightweight flat bucket; 'multi' = tenant-scoped),
 *  maxRecords, maxTenants (multi), globalAggregates (grant for scope:'global').
 * Auth is per call: { tenantId } in multi, { scope:'global' } for aggregates.
 * Fail closed → null.
 */
export function createTenantIsolation(config = {}) {
  if (!isPlain(config)) return null;
  if (Reflect.ownKeys(config).some(k => !CONFIG_KEYS.includes(k))) return null;

  const mode = config.mode === undefined ? 'single' : config.mode;
  if (!TENANTISO_MODES.includes(mode)) return null;

  const maxRecords = config.maxRecords === undefined
    ? TENANTISO_LIMITS.defaultMaxRecords : config.maxRecords;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < TENANTISO_LIMITS.minMaxRecords ||
      maxRecords > TENANTISO_LIMITS.maxMaxRecords) return null;

  const maxTenants = config.maxTenants === undefined
    ? TENANTISO_LIMITS.defaultMaxTenants : config.maxTenants;
  if (!Number.isSafeInteger(maxTenants) || maxTenants < TENANTISO_LIMITS.minMaxTenants ||
      maxTenants > TENANTISO_LIMITS.maxMaxTenants) return null;

  const globalAggregates = config.globalAggregates === undefined
    ? false : config.globalAggregates;
  if (typeof globalAggregates !== 'boolean') return null;

  // single-tenant stays lightweight: no multi-tenant grant surface
  const state = {
    mode,
    globalAggregates,
    // single → one flat array (no Map ever allocated); multi → Map by tenant
    flat: mode === 'single' ? [] : null,
    byTenant: mode === 'multi' ? new Map() : null,
    total: 0,
    counters: {
      ingested: 0,
      queried: 0,
      routed: 0,
      cross_tenant_blocked: 0,
      global_unauthorized: 0,
      tenant_label_rejected: 0,
      records_shed: 0,
    },
  };

  function tenantBucket(tenantId) {
    let b = state.byTenant.get(tenantId);
    if (b === undefined) {
      if (state.byTenant.size >= maxTenants) return null;
      b = [];
      state.byTenant.set(tenantId, b);
    }
    return b;
  }

  function validateAuth(auth, needGlobal = false) {
    if (needGlobal) {
      if (auth !== undefined && !isPlain(auth)) return err('tenantisolation.invalid_auth', 'auth must be an object');
      if (auth !== undefined && Reflect.ownKeys(auth).some(k => !AUTH_KEYS.includes(k))) {
        return err('tenantisolation.invalid_auth', 'unknown auth field');
      }
      const scope = auth === undefined ? undefined : auth.scope;
      if (scope !== undefined && !TENANTISO_SCOPES.includes(scope)) {
        return err('tenantisolation.invalid_auth', 'scope invalid');
      }
      if (scope === 'global') {
        if (!state.globalAggregates) {
          state.counters.global_unauthorized++;
          return err('tenantisolation.unauthorized_global', 'global aggregates not granted');
        }
        return { ok: true, auth: Object.freeze({ scope: 'global' }) };
      }
      // fall through to tenant auth when scope omitted or 'tenant'
      return validateAuth(
        auth === undefined ? undefined : { ...auth, scope: undefined },
        false,
      );
    }
    if (mode === 'single') {
      // lightweight: auth may be absent; if present it must not request a tenant
      if (auth === undefined) return { ok: true, auth: Object.freeze({}) };
      if (!isPlain(auth) || Reflect.ownKeys(auth).some(k => !AUTH_KEYS.includes(k))) {
        return err('tenantisolation.invalid_auth', 'unknown auth field');
      }
      if (auth.tenantId !== undefined) {
        return err('tenantisolation.invalid_auth', 'single-tenant deployment has no tenant scope');
      }
      if (auth.scope === 'global') {
        if (!state.globalAggregates) {
          state.counters.global_unauthorized++;
          return err('tenantisolation.unauthorized_global', 'global aggregates not granted');
        }
        return { ok: true, auth: Object.freeze({ scope: 'global' }) };
      }
      return { ok: true, auth: Object.freeze({}) };
    }
    // multi
    if (!isPlain(auth) || Reflect.ownKeys(auth).some(k => !AUTH_KEYS.includes(k))) {
      return err('tenantisolation.invalid_auth', 'multi-tenant query requires { tenantId }');
    }
    if (auth.scope === 'global') {
      if (!state.globalAggregates) {
        state.counters.global_unauthorized++;
        return err('tenantisolation.unauthorized_global', 'global aggregates not granted');
      }
      return { ok: true, auth: Object.freeze({ scope: 'global' }) };
    }
    if (!validId(auth.tenantId) || containsSecretShape(auth.tenantId)) {
      return err('tenantisolation.invalid_auth', 'tenantId invalid');
    }
    return { ok: true, auth: Object.freeze({ tenantId: auth.tenantId }) };
  }

  /**
   * Ingest a telemetry record into the tenant-scoped store.
   * multi: tenantId required and becomes the bucket key. single: tenantId forbidden.
   */
  function ingest(record) {
    if (!isPlain(record)) return err('tenantisolation.invalid_record', 'record must be an object');
    if (Reflect.ownKeys(record).some(k => !RECORD_KEYS.includes(k))) {
      return err('tenantisolation.invalid_record', 'unknown record field');
    }
    if (!validId(record.id) || containsSecretShape(record)) {
      return err('tenantisolation.invalid_record', 'id invalid');
    }
    if (record.channel !== undefined &&
        (typeof record.channel !== 'string' || record.channel.length === 0 ||
         record.channel.length > TENANTISO_LIMITS.channelBytes)) {
      return err('tenantisolation.invalid_record', 'channel invalid');
    }
    if (state.total >= maxRecords) {
      state.counters.records_shed++;
      return err('tenantisolation.full', 'maxRecords reached');
    }
    const entry = Object.freeze({
      id: record.id,
      channel: record.channel === undefined ? null : record.channel,
      tenantId: null,
    });
    if (mode === 'single') {
      if (record.tenantId !== undefined) {
        return err('tenantisolation.invalid_record', 'single-tenant store rejects tenantId');
      }
      state.flat.push(entry);
    } else {
      if (!validId(record.tenantId) || containsSecretShape(record.tenantId)) {
        return err('tenantisolation.invalid_record', 'tenantId required/invalid');
      }
      const bucket = tenantBucket(record.tenantId);
      if (bucket === null) {
        return err('tenantisolation.tenant_cap', 'maxTenants reached');
      }
      bucket.push(Object.freeze({ ...entry, tenantId: record.tenantId }));
    }
    state.total++;
    state.counters.ingested++;
    return Object.freeze({ ok: true, outcome: 'ingested', id: record.id });
  }

  /**
   * Scoped query. multi: auth.tenantId required; filter.tenantId (if any) must
   * equal auth.tenantId — cross-tenant request fails closed. single: flat scan.
   * Returns records tagged with the query scope.
   */
  function query(auth, filter = undefined) {
    const a = validateAuth(auth, false);
    if (!a.ok) return a;
    if (filter !== undefined) {
      if (!isPlain(filter) || Reflect.ownKeys(filter).some(k => !QUERY_KEYS.includes(k))) {
        return err('tenantisolation.invalid_query', 'unknown filter field');
      }
      if (filter.limit !== undefined &&
          (!Number.isSafeInteger(filter.limit) || filter.limit < 1 ||
           filter.limit > TENANTISO_LIMITS.maxQueryLimit)) {
        return err('tenantisolation.invalid_query', 'limit invalid');
      }
      if (filter.tenantId !== undefined) {
        if (mode === 'single') {
          return err('tenantisolation.cross_scope', 'single-tenant query has no tenant filter');
        }
        if (a.auth.tenantId === undefined || filter.tenantId !== a.auth.tenantId) {
          state.counters.cross_tenant_blocked++;
          return err('tenantisolation.cross_scope', 'filter tenant exceeds authorization');
        }
      }
    }
    const limit = filter !== undefined && filter.limit !== undefined
      ? filter.limit : TENANTISO_LIMITS.maxQueryLimit;
    let rows;
    let scope;
    let tenantId = null;
    if (mode === 'single') {
      rows = state.flat;
      scope = 'tenant';
    } else if (a.auth.scope === 'global') {
      // global grant may read across buckets, but the report is tagged 'global'
      // and built from tenantAggregate primitives — see globalAggregate() for
      // the aggregate-only path. Raw cross-tenant dump is never returned here:
      // global auth on query() still resolves to empty tenant scope fail-closed.
      state.counters.cross_tenant_blocked++;
      return err('tenantisolation.cross_scope', 'global scope cannot raw-query tenant rows');
    } else {
      tenantId = a.auth.tenantId;
      rows = state.byTenant.get(tenantId) || [];
      scope = 'tenant';
    }
    const slice = rows.slice(0, limit);
    state.counters.queried++;
    return Object.freeze({
      ok: true,
      report: Object.freeze({
        scope,
        tenantId,
        rows: Object.freeze(slice.map(r => Object.freeze({ ...r }))),
        count: slice.length,
        truncated: rows.length > slice.length,
      }),
    });
  }

  /**
   * Export routing respects scope: the record's tenant must equal the
   * authorizing tenant (multi) or be absent (single). Cross → fail closed.
   */
  function routeExport(auth, job) {
    const a = validateAuth(auth, false);
    if (!a.ok) return a;
    if (!isPlain(job) || Reflect.ownKeys(job).some(k => !ROUTE_KEYS.includes(k))) {
      return err('tenantisolation.invalid_route', 'job must be { id, tenantId?, channel }');
    }
    if (!validId(job.id) || containsSecretShape(job)) {
      return err('tenantisolation.invalid_route', 'id invalid');
    }
    if (job.channel === undefined || typeof job.channel !== 'string' ||
        job.channel.length === 0 || job.channel.length > TENANTISO_LIMITS.channelBytes) {
      return err('tenantisolation.invalid_route', 'channel required');
    }
    if (mode === 'single') {
      if (job.tenantId !== undefined) {
        state.counters.cross_tenant_blocked++;
        return err('tenantisolation.cross_scope', 'single-tenant route rejects tenantId');
      }
      state.counters.routed++;
      return Object.freeze({
        ok: true, route: Object.freeze({ channel: job.channel, scope: 'tenant', tenantId: null }),
      });
    }
    if (a.auth.tenantId === undefined) {
      return err('tenantisolation.invalid_auth', 'multi-tenant route requires tenant auth');
    }
    if (job.tenantId !== a.auth.tenantId) {
      state.counters.cross_tenant_blocked++;
      return err('tenantisolation.cross_scope', 'export route crosses tenant scope');
    }
    state.counters.routed++;
    return Object.freeze({
      ok: true,
      route: Object.freeze({ channel: job.channel, scope: 'tenant', tenantId: a.auth.tenantId }),
    });
  }

  /** Tenant-scoped aggregate — tagged scope:'tenant'. */
  function tenantAggregate(auth) {
    const a = validateAuth(auth, false);
    if (!a.ok) return a;
    let rows;
    let tenantId = null;
    if (mode === 'single') {
      rows = state.flat;
    } else {
      if (a.auth.tenantId === undefined) {
        return err('tenantisolation.invalid_auth', 'tenant aggregate requires tenantId');
      }
      tenantId = a.auth.tenantId;
      rows = state.byTenant.get(tenantId) || [];
    }
    const byChannel = {};
    for (const r of rows) {
      const k = r.channel === null ? 'none' : r.channel;
      byChannel[k] = (byChannel[k] || 0) + 1;
    }
    return Object.freeze({
      ok: true,
      aggregate: Object.freeze({
        scope: 'tenant',
        tenantId,
        records: rows.length,
        byChannel: Object.freeze(byChannel),
      }),
    });
  }

  /**
   * Global aggregate — ONLY with scope:'global' auth + deployment grant.
   * Structurally separated: counts only, never tenant row bodies; scope tag
   * is 'global' so consumers cannot confuse it with tenant reports.
   */
  function globalAggregate(auth) {
    const a = validateAuth({ ...(isPlain(auth) ? auth : {}), scope: 'global' }, true);
    if (!a.ok) return a;
    let tenantCount = 0;
    let records = 0;
    const byChannel = {};
    if (mode === 'single') {
      records = state.flat.length;
      for (const r of state.flat) {
        const k = r.channel === null ? 'none' : r.channel;
        byChannel[k] = (byChannel[k] || 0) + 1;
      }
      tenantCount = 0; // single-tenant deployments report zero tenants by design
    } else {
      tenantCount = state.byTenant.size;
      for (const bucket of state.byTenant.values()) {
        records += bucket.length;
        for (const r of bucket) {
          const k = r.channel === null ? 'none' : r.channel;
          byChannel[k] = (byChannel[k] || 0) + 1;
        }
      }
    }
    return Object.freeze({
      ok: true,
      aggregate: Object.freeze({
        scope: 'global',
        tenantCount,
        records,
        byChannel: Object.freeze(byChannel),
        // explicit separator: no per-tenant rows in a global report
        containsTenantRows: false,
      }),
    });
  }

  /**
   * Metric-label isolation: any tenant-identifying key fails closed.
   * Tenant identifiers do not automatically become metric labels.
   */
  function sanitizeMetricLabels(labels) {
    if (!isPlain(labels)) return err('tenantisolation.invalid_labels', 'labels must be an object');
    const keys = Reflect.ownKeys(labels);
    if (keys.length > TENANTISO_LIMITS.maxLabels) {
      return err('tenantisolation.invalid_labels', 'too many labels');
    }
    const denied = [];
    for (const key of keys) {
      if (typeof key !== 'string' || key.length === 0 ||
          key.length > TENANTISO_LIMITS.labelKeyBytes) {
        return err('tenantisolation.invalid_labels', 'label key invalid');
      }
      if (TENANTISO_LABEL_DENY.includes(key) || /tenant/i.test(key)) {
        denied.push(key);
      }
      const d = Object.getOwnPropertyDescriptor(labels, key);
      if (!d || !('value' in d) || !d.enumerable) {
        return err('tenantisolation.invalid_labels', 'label descriptor invalid');
      }
      if (typeof d.value !== 'string' || d.value.length > TENANTISO_LIMITS.labelKeyBytes) {
        return err('tenantisolation.invalid_labels', 'label value invalid');
      }
      if (containsSecretShape(d.value)) {
        return err('tenantisolation.secret', 'secret-shaped label value');
      }
    }
    if (denied.length > 0) {
      state.counters.tenant_label_rejected++;
      return err('tenantisolation.tenant_label',
        'tenant identifiers must not become metric labels',
        Object.freeze({ denied: Object.freeze(denied) }));
    }
    const clean = {};
    for (const key of keys) clean[key] = labels[key];
    return Object.freeze({
      ok: true,
      labels: Object.freeze(clean),
      denied: Object.freeze([]),
    });
  }

  function snapshot() {
    const tenantIds = mode === 'multi' ? [...state.byTenant.keys()].sort() : [];
    return Object.freeze({
      schemaVersion: TENANTISO_SCHEMA_VERSION,
      contract: Object.freeze({ ...TENANTISO_CONTRACT }),
      mode,
      globalAggregates,
      total: state.total,
      maxRecords,
      tenants: mode === 'multi' ? state.byTenant.size : 0,
      tenantIds: Object.freeze(tenantIds),
      counters: Object.freeze({ ...state.counters }),
      lightweight: mode === 'single'
        ? Object.freeze({ tenantMapAllocated: false, flatBucket: true })
        : Object.freeze({ tenantMapAllocated: true, flatBucket: false }),
    });
  }

  return Object.freeze({
    ingest, query, routeExport, tenantAggregate, globalAggregate,
    sanitizeMetricLabels, snapshot,
    stats: state.counters,
  });
}
