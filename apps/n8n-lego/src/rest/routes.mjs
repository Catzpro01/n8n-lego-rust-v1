/**
 * n8n lego REST surface — LEGACY AGGREGATE.
 *
 * Route ownership is split by domain (see `src/compat/route.mjs` for the
 * boundary). As of P2 the AUTH (`src/auth/`) and SETTINGS (`src/settings/`)
 * LEGOs have their own modules; everything below remains in this single
 * aggregate and is peeled off domain by domain in later phases:
 *
 *   node-registry               /rest/types/*, /rest/node-*
 *   workflow LEGO        (P3)   /rest/workflows/*, /rest/active-workflows, tags
 *   execution LEGO       (P3)   /rest/executions/*
 *   workspace LEGO       (P3)   /rest/projects/* (incl. personalProject scopes)
 *   credentials LEGO     (P5)   /rest/credentials/*
 *   compatibility-owned         /rest/license, cosmetic/bootstrap endpoints
 *
 * Rules for anything staying here: no new business logic — the compatibility
 * layer owns envelope (`src/compat/response.mjs`), errors
 * (`src/compat/error.mjs`) and the auth context (`src/compat/auth-context.mjs`).
 * Unimplemented `/rest/*` paths never fall through to a fake success: the
 * capability handler (`src/compat/capability.mjs`) answers them with an
 * explicit 501 "unsupported".
 */
import { randomUUID } from 'node:crypto';
import { HttpError, badRequest, notFound } from '../compat/error.mjs';
import { sendBare, sendData, sendJson } from '../compat/response.mjs';
import { requireUser } from '../compat/auth-context.mjs';
import { loadCatalog, findNodeType } from '../catalog.mjs';
import { credentialRoutes } from '../compat/credentials.mjs';
import { calculateWorkflowChecksum } from '../checksum.mjs';

const WORKFLOW_NAME_DEFAULT = 'My workflow';

/* ------------------------------------------------------------------ helpers */

function parseFilter(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function emptyWorkflow(name = WORKFLOW_NAME_DEFAULT) {
  return { name, nodes: [], connections: {}, settings: {}, pinData: {} };
}

function workflowSummary(workflow, { includeNodes = false } = {}) {
  const base = {
    id: workflow.id,
    resource: 'workflow',
    name: workflow.name,
    active: Boolean(workflow.active),
    isArchived: Boolean(workflow.isArchived),
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    description: workflow.description ?? null,
    versionId: workflow.versionId ?? randomUUID(),
    activeVersionId: workflow.active ? (workflow.activeVersionId ?? workflow.versionId ?? null) : null,
    tags: workflow.tags ?? [],
    meta: workflow.meta ?? null,
    settings: workflow.settings ?? {},
    staticData: workflow.staticData ?? null,
    pinData: workflow.pinData ?? {},
    // Per-resource permissions: without `scopes` the editor treats a workflow as
    // read-only (`getResourcePermissions([]).workflow.update === undefined`).
    checksum: calculateWorkflowChecksum(workflow),
    scopes: workflow.scopes ?? [
      'workflow:create',
      'workflow:read',
      'workflow:update',
      'workflow:delete',
      'workflow:move',
      'workflow:share',
      'workflow:execute',
      'workflow:list',
    ],
  };
  if (includeNodes) {
    base.nodes = workflow.nodes ?? [];
    base.connections = workflow.connections ?? {};
    base.shared = workflow.shared ?? [];
  }
  return base;
}

/**
 * Credential as the editor expects it (`ICredentialsResponse`). Secrets only
 * travel when the caller explicitly asked for them (`includeData`).
 */
function credentialSummary(credential, { includeData = false } = {}) {
  const base = {
    id: credential.id,
    name: credential.name,
    type: credential.type,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
    isManaged: false,
    isGlobal: false,
    isResolvable: false,
    shared: [],
    scopes: [],
    resource: 'credential',
  };
  if (includeData) base.data = credential.data ?? {};
  return base;
}

function executionSummary(execution) {
  return {
    id: execution.id,
    finished: execution.finished ?? true,
    mode: execution.mode ?? 'manual',
    retryOf: execution.retryOf ?? null,
    retrySuccessId: execution.retrySuccessId ?? null,
    status: execution.status,
    createdAt: execution.createdAt,
    startedAt: execution.startedAt,
    stoppedAt: execution.stoppedAt,
    workflowId: execution.workflowId,
    workflowName: execution.workflowName ?? null,
    waitingFor: null,
    customData: {},
    annotation: { tags: [], vote: null },
  };
}

/* -------------------------------------------------------------------- routes */

export function buildRoutes({ engine, logger, push, vault = null }) {
  return [
    /* ------------------------------------------------------- node type catalog */
    {
      method: 'GET',
      path: '/rest/types/nodes.json',
      public: true,
      handler: (ctx) => {
        const catalog = loadCatalog(ctx.config);
        if (!catalog) throw notFound('Node catalog is not installed — run `npm run catalog`');
        sendJson(ctx.res, 200, JSON.parse(catalog.raw.nodes().toString('utf8')), { 'cache-control': 'public, max-age=60' });
      },
    },
    {
      method: 'GET',
      path: '/rest/types/node-versions.json',
      public: true,
      handler: (ctx) => {
        const catalog = loadCatalog(ctx.config);
        if (!catalog) throw notFound('Node catalog is not installed — run `npm run catalog`');
        sendJson(ctx.res, 200, catalog.versions);
      },
    },
    {
      method: 'GET',
      path: '/rest/types/credentials.json',
      public: true,
      handler: (ctx) => {
        const catalog = loadCatalog(ctx.config);
        if (!catalog) throw notFound('Node catalog is not installed — run `npm run catalog`');
        sendJson(ctx.res, 200, JSON.parse(catalog.raw.credentials().toString('utf8')));
      },
    },
    {
      method: 'GET',
      path: '/rest/node-translation-headers',
      public: true,
      handler: (ctx) => sendData(ctx.res, {}),
    },
    {
      method: 'GET',
      path: '/rest/credential-translation',
      public: true,
      handler: (ctx) => sendData(ctx.res, {}),
    },
    {
      // `getNodesInformation`: full descriptions for the node versions the editor
      // is about to render (`nodeInfos: [{ name, version }]`).
      method: 'POST',
      path: '/rest/node-types',
      handler: (ctx) => {
        requireUser(ctx);
        const catalog = loadCatalog(ctx.config);
        if (!catalog) throw notFound('Node catalog is not installed — run `npm run catalog`');
        const nodeInfos = Array.isArray(ctx.body?.nodeInfos) ? ctx.body.nodeInfos : [];
        const descriptions = nodeInfos
          .map(({ name, version }) => findNodeType(catalog, name, version))
          .filter((description) => description !== null);
        sendData(ctx.res, descriptions);
      },
    },
    {
      method: 'POST',
      path: '/rest/node-types/by-identifier',
      handler: (ctx) => {
        requireUser(ctx);
        const catalog = loadCatalog(ctx.config);
        if (!catalog) throw notFound('Node catalog is not installed — run `npm run catalog`');
        const identifiers = Array.isArray(ctx.body?.identifiers) ? ctx.body.identifiers : [];
        const found = [];
        for (const identifier of identifiers) {
          // "name@version" where the name itself may contain dots but not '@'
          const text = String(identifier);
          const at = text.lastIndexOf('@');
          const name = at === -1 ? text : text.slice(0, at);
          const version = at === -1 ? undefined : Number(text.slice(at + 1));
          const node = findNodeType(catalog, name, Number.isFinite(version) ? version : undefined);
          if (node) found.push(node);
        }
        sendData(ctx.res, found);
      },
    },

    /* -------------------------------------------------------------- workflows */
    {
      method: 'GET',
      path: '/rest/workflows',
      handler: (ctx) => {
        requireUser(ctx);
        const filter = parseFilter(ctx.query.filter);
        const limit = toPositiveInt(ctx.query.limit, 100);
        const workflows = ctx.store.workflows
          .all()
          .filter((workflow) => (filter.name ? String(workflow.name).toLowerCase().includes(String(filter.name).toLowerCase()) : true))
          .filter((workflow) => (filter.active !== undefined ? Boolean(workflow.active) === Boolean(filter.active) : true))
          .slice()
          .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        // read with `getFullApiResponse` — must be the bare { count, data } body
        sendBare(ctx.res, { count: workflows.length, data: workflows.slice(0, limit).map((w) => workflowSummary(w)) });
      },
    },
    {
      method: 'POST',
      path: '/rest/workflows/with-node-types',
      handler: (ctx) => {
        requireUser(ctx);
        const nodeTypes = Array.isArray(ctx.body?.nodeTypes) ? ctx.body.nodeTypes.map(String) : [];
        const matching = ctx.store.workflows
          .all()
          .filter((workflow) => (workflow.nodes ?? []).some((node) => nodeTypes.includes(node.type)));
        sendBare(ctx.res, {
          count: matching.length,
          data: matching.map((workflow) => workflowSummary(workflow, { includeNodes: true })),
        });
      },
    },
    {
      method: 'GET',
      path: '/rest/workflows/new',
      handler: (ctx) => {
        requireUser(ctx);
        sendData(ctx.res, emptyWorkflow());
      },
    },
    {
      method: 'POST',
      path: '/rest/workflows',
      handler: (ctx) => {
        requireUser(ctx);
        const body = ctx.body ?? {};
        const now = new Date().toISOString();
        // The editor opens a fresh workflow at `/workflow/<id>?new=true` and sends
        // that same id on the first save; n8n honours it (`create()` in
        // workflows.controller.ts) and rejects duplicates by id.
        const requestedId = typeof body.id === 'string' && body.id.trim() !== '' ? body.id.trim() : null;
        if (requestedId && ctx.store.workflows.get(requestedId)) {
          throw badRequest(`Workflow with id ${requestedId} exists already.`);
        }
        const workflow = ctx.store.workflows.insert({
          ...(requestedId ? { id: requestedId } : {}),
          name: typeof body.name === 'string' && body.name.trim() !== '' ? body.name : WORKFLOW_NAME_DEFAULT,
          description: body.description ?? null,
          active: false,
          nodes: body.nodes ?? [],
          connections: body.connections ?? {},
          settings: body.settings ?? {},
          pinData: body.pinData ?? {},
          staticData: body.staticData ?? null,
          meta: body.meta ?? null,
          tags: [],
          versionId: randomUUID(),
          createdAt: now,
          updatedAt: now,
        });
        logger.info('workflow created', { workflowId: workflow.id, name: workflow.name });
        sendData(ctx.res, workflowSummary(workflow, { includeNodes: true }));
      },
    },
    {
      method: 'GET',
      path: '/rest/workflows/:workflowId',
      handler: (ctx) => {
        requireUser(ctx);
        const workflow = ctx.store.workflows.get(ctx.params.workflowId);
        if (!workflow) throw notFound('Workflow not found');
        sendData(ctx.res, workflowSummary(workflow, { includeNodes: true }));
      },
    },
    {
      method: 'PATCH',
      path: '/rest/workflows/:workflowId',
      handler: (ctx) => {
        requireUser(ctx);
        const existing = ctx.store.workflows.get(ctx.params.workflowId);
        if (!existing) throw notFound('Workflow not found');
        const body = ctx.body ?? {};
        // A stale `expectedChecksum` means someone else saved in the meantime —
        // same guard (and message) as `WorkflowService._detectConflicts`.
        if (typeof body.expectedChecksum === 'string' && body.expectedChecksum !== '') {
          const current = calculateWorkflowChecksum(existing);
          if (current !== body.expectedChecksum) {
            throw new HttpError(
              400,
              'Your most recent changes may be lost, because someone else just updated this workflow. Open this workflow in a new tab to see those new updates.',
            );
          }
        }
        const patch = { updatedAt: new Date().toISOString(), versionId: randomUUID() };
        for (const key of ['name', 'nodes', 'connections', 'settings', 'pinData', 'staticData', 'meta', 'description', 'active']) {
          if (body[key] !== undefined) patch[key] = body[key];
        }
        const updated = ctx.store.workflows.update(existing.id, patch);
        sendData(ctx.res, workflowSummary(updated, { includeNodes: true }));
      },
    },
    {
      method: 'DELETE',
      path: '/rest/workflows/:workflowId',
      handler: (ctx) => {
        requireUser(ctx);
        const removed = ctx.store.workflows.remove(ctx.params.workflowId);
        if (!removed) throw notFound('Workflow not found');
        sendData(ctx.res, { id: ctx.params.workflowId, deleted: true });
      },
    },
    {
      method: 'GET',
      path: '/rest/workflows/:workflowId/collaboration/write-lock',
      handler: (ctx) => {
        requireUser(ctx);
        // Single-user instance: no other session can hold the editor write lock.
        sendData(ctx.res, { userId: null });
      },
    },
    {
      method: 'GET',
      path: '/rest/workflows/:workflowId/exists',
      handler: (ctx) => {
        requireUser(ctx);
        sendData(ctx.res, { exists: ctx.store.workflows.get(ctx.params.workflowId) !== null });
      },
    },
    {
      method: 'POST',
      path: '/rest/workflows/:workflowId/activate',
      handler: (ctx) => {
        requireUser(ctx);
        const workflow = ctx.store.workflows.get(ctx.params.workflowId);
        if (!workflow) throw notFound('Workflow not found');
        const updated = ctx.store.workflows.update(workflow.id, { active: true, updatedAt: new Date().toISOString() });
        sendData(ctx.res, workflowSummary(updated, { includeNodes: true }));
      },
    },
    {
      method: 'POST',
      path: '/rest/workflows/:workflowId/deactivate',
      handler: (ctx) => {
        requireUser(ctx);
        const workflow = ctx.store.workflows.get(ctx.params.workflowId);
        if (!workflow) throw notFound('Workflow not found');
        const updated = ctx.store.workflows.update(workflow.id, { active: false, updatedAt: new Date().toISOString() });
        sendData(ctx.res, workflowSummary(updated, { includeNodes: true }));
      },
    },
    {
      method: 'POST',
      path: '/rest/workflows/:workflowId/archive',
      handler: (ctx) => {
        requireUser(ctx);
        const workflow = ctx.store.workflows.get(ctx.params.workflowId);
        if (!workflow) throw notFound('Workflow not found');
        const updated = ctx.store.workflows.update(workflow.id, {
          isArchived: true,
          active: false,
          updatedAt: new Date().toISOString(),
        });
        sendData(ctx.res, workflowSummary(updated, { includeNodes: true }));
      },
    },
    {
      method: 'POST',
      path: '/rest/workflows/:workflowId/unarchive',
      handler: (ctx) => {
        requireUser(ctx);
        const workflow = ctx.store.workflows.get(ctx.params.workflowId);
        if (!workflow) throw notFound('Workflow not found');
        const updated = ctx.store.workflows.update(workflow.id, {
          isArchived: false,
          updatedAt: new Date().toISOString(),
        });
        sendData(ctx.res, workflowSummary(updated, { includeNodes: true }));
      },
    },
    {
      method: 'PUT',
      path: '/rest/workflows/:workflowId/tags',
      handler: (ctx) => {
        requireUser(ctx);
        const workflow = ctx.store.workflows.get(ctx.params.workflowId);
        if (!workflow) throw notFound('Workflow not found');
        const ids = Array.isArray(ctx.body?.tagIds) ? ctx.body.tagIds.map(String) : [];
        const tags = ctx.store.tags.all().filter((tag) => ids.includes(tag.id));
        ctx.store.workflows.update(workflow.id, { tags, updatedAt: new Date().toISOString() });
        sendData(ctx.res, tags);
      },
    },
    {
      method: 'POST',
      path: '/rest/workflows/:workflowId/run',
      handler: async (ctx) => {
        const user = requireUser(ctx);
        const stored = ctx.store.workflows.get(ctx.params.workflowId);
        if (!stored) throw notFound('Workflow not found');
        const body = ctx.body ?? {};
        const definition = body.workflowData ?? body.workflow ?? {
          name: stored.name,
          nodes: stored.nodes ?? [],
          connections: stored.connections ?? {},
          settings: stored.settings ?? {},
        };
        const startNodes = Array.isArray(body.startNodes) ? body.startNodes : [];
        const startNode = startNodes.length > 0 ? startNodes[0].name ?? startNodes[0] : (body.startNode ?? null);

        const execution = await engine.execute({
          definition,
          startNode,
          input: body.input,
          workflowId: stored.id,
          workflowName: stored.name,
          mode: 'manual',
          requestedBy: user.email,
          store: ctx.store,
        });

        // The editor tracks a running workflow through these push messages and
        // refetches `/rest/executions/:id` when the run finishes. They are emitted
        // after the HTTP response so the client's `activeExecutionId` is set first.
        sendData(ctx.res, { executionId: execution.id, ...executionSummary(execution) });
        setImmediate(() => {
          push?.broadcast?.({
            type: 'executionStarted',
            data: {
              executionId: String(execution.id),
              mode: 'manual',
              startedAt: execution.startedAt,
              workflowId: stored.id,
              workflowName: stored.name,
            },
          });
          push?.broadcast?.({
            type: 'executionFinished',
            data: { executionId: String(execution.id), workflowId: stored.id, status: execution.status },
          });
        });
      },
    },
    {
      method: 'GET',
      path: '/rest/workflows/:workflowId/executions/last-successful',
      handler: (ctx) => {
        requireUser(ctx);
        const last = ctx.store.executions
          .filter((execution) => execution.workflowId === ctx.params.workflowId && execution.status === 'success')
          .sort((a, b) => b.id - a.id)[0];
        sendData(ctx.res, last ? { ...executionSummary(last), data: last.data ?? {} } : null);
      },
    },
    {
      method: 'GET',
      path: '/rest/active-workflows',
      handler: (ctx) => {
        requireUser(ctx);
        const active = ctx.store.workflows.filter((workflow) => workflow.active).map((workflow) => workflow.id);
        sendData(ctx.res, active);
      },
    },

    /* ------------------------------------------------------------- executions */
    {
      method: 'GET',
      path: '/rest/executions',
      handler: (ctx) => {
        requireUser(ctx);
        const filter = parseFilter(ctx.query.filter);
        const limit = toPositiveInt(ctx.query.limit, 20);
        let items = ctx.store.executions.all().slice();
        if (filter.workflowId) items = items.filter((execution) => execution.workflowId === filter.workflowId);
        if (filter.status) items = items.filter((execution) => execution.status === filter.status);
        items.sort((a, b) => Number(b.id) - Number(a.id));
        sendData(ctx.res, {
          count: items.length,
          estimated: false,
          results: items.slice(0, limit).map(executionSummary),
        });
      },
    },
    {
      method: 'GET',
      path: '/rest/executions/:id',
      handler: (ctx) => {
        requireUser(ctx);
        const execution = ctx.store.executions.find((candidate) => String(candidate.id) === String(ctx.params.id));
        if (!execution) throw notFound('Execution not found');
        sendData(ctx.res, {
          ...executionSummary(execution),
          data: execution.data ?? {},
          workflowData: execution.workflowData ?? null,
        });
      },
    },
    {
      method: 'POST',
      path: '/rest/executions/:id/stop',
      handler: (ctx) => {
        requireUser(ctx);
        sendData(ctx.res, true);
      },
    },
    {
      method: 'POST',
      path: '/rest/executions/delete',
      handler: (ctx) => {
        requireUser(ctx);
        const ids = (ctx.body?.ids ?? []).map((id) => String(id));
        for (const id of ids) ctx.store.executions.remove(id);
        sendData(ctx.res, { deleted: ids });
      },
    },
    {
      method: 'DELETE',
      path: '/rest/executions/:id',
      handler: (ctx) => {
        requireUser(ctx);
        ctx.store.executions.remove(ctx.params.id);
        sendData(ctx.res, { id: ctx.params.id, deleted: true });
      },
    },

    /* ----------------------------------------------------------- license */
    {
      method: 'GET',
      path: '/rest/license',
      handler: (ctx) => {
        requireUser(ctx);
        const triggers = ctx.store.workflows.filter((workflow) => workflow.active).length;
        sendData(ctx.res, {
          usage: {
            activeWorkflowTriggers: { value: triggers, limit: -1, warningThreshold: 0.8 },
            workflowsHavingEvaluations: { value: 0, limit: -1 },
          },
          license: { planId: '', planName: 'n8n lego (community)' },
        });
      },
    },

    /* ----------------------------------------------------------- credentials */
    // P5.4 carved these out verbatim into the compatibility domain
    // (`src/compat/credentials.mjs`), where the upstream `ICredentialsResponse`
    // shape belongs. The catalog accessor is injected here because that domain
    // must not depend on node-registry. Secret handling is covered by
    // test/lego-credentials.test.mjs.
    ...credentialRoutes({
      logger,
      vault,
      getCredentialTypes: (config) => {
        const catalog = loadCatalog(config);
        return catalog ? JSON.parse(catalog.raw.credentials().toString('utf8')) : [];
      },
    }),

    /* ------------------------------------------------------- tags & variables */
    {
      method: 'GET',
      path: '/rest/tags',
      handler: (ctx) => {
        requireUser(ctx);
        const tags = ctx.store.tags.all();
        sendData(ctx.res, tags);
      },
    },
    {
      method: 'POST',
      path: '/rest/tags',
      handler: (ctx) => {
        requireUser(ctx);
        const name = String(ctx.body?.name ?? '').trim();
        if (name === '') throw badRequest('Tag name is required');
        const existing = ctx.store.tags.find((tag) => tag.name === name);
        if (existing) return sendData(ctx.res, existing);
        return sendData(ctx.res, ctx.store.tags.insert({ name }));
      },
    },
    {
      method: 'GET',
      path: '/rest/variables',
      handler: (ctx) => {
        requireUser(ctx);
        // Community edition: the variables feature exists but the enterprise
        // limit is 0 — an implemented feature with no data, so 200 [] is the
        // honest answer (not an unsupported stub).
        sendData(ctx.res, []);
      },
    },

    /* ---------------------------------------------- projects (n8n 2.x editor) */
    {
      method: 'GET',
      path: '/rest/projects/personal',
      handler: (ctx) => {
        const user = requireUser(ctx);
        sendData(ctx.res, personalProject(user));
      },
    },
    {
      method: 'GET',
      path: '/rest/projects/my-projects',
      handler: (ctx) => {
        const user = requireUser(ctx);
        sendData(ctx.res, [personalProject(user)]);
      },
    },
    {
      method: 'GET',
      path: '/rest/projects/count',
      handler: (ctx) => sendData(ctx.res, { personal: 1, team: 0 }),
    },
    {
      method: 'GET',
      path: '/rest/projects',
      handler: (ctx) => {
        const user = requireUser(ctx);
        sendData(ctx.res, [personalProject(user)]);
      },
    },

    /* ---------------------------------------------------------- misc the editor */
    {
      method: 'GET',
      path: '/rest/versions',
      handler: (ctx) => sendData(ctx.res, []),
    },
    {
      method: 'GET',
      path: '/rest/community-node-types',
      handler: (ctx) => sendData(ctx.res, []),
    },
    {
      method: 'GET',
      path: '/rest/module-settings',
      handler: (ctx) => sendData(ctx.res, {}),
    },
    {
      method: 'GET',
      path: '/rest/env-feature-flags',
      handler: (ctx) => sendData(ctx.res, {}),
    },
    {
      method: 'GET',
      path: '/rest/ctas/become-creator',
      handler: (ctx) => sendData(ctx.res, null),
    },
    {
      method: 'GET',
      path: '/rest/third-party-licenses',
      handler: (ctx) => sendData(ctx.res, []),
    },
    {
      method: 'GET',
      path: '/rest/banners',
      handler: (ctx) => sendData(ctx.res, []),
    },
    {
      method: 'GET',
      path: '/rest/events',
      handler: (ctx) => sendData(ctx.res, []),
    },
  ];
}

/**
 * Global scopes the owner holds, mirroring `combineScopes({ global })` in
 * `project.controller.ts`. The editor derives canvas write access from
 * `project.scopes`, so omitting them makes every workflow read-only.
 */
const PROJECT_SCOPES = [
  'workflow:create',
  'workflow:read',
  'workflow:update',
  'workflow:delete',
  'workflow:move',
  'workflow:share',
  'workflow:execute',
  'workflow:list',
  'credential:create',
  'credential:read',
  'credential:update',
  'credential:delete',
  'credential:move',
  'credential:list',
  'project:create',
  'project:read',
  'project:update',
  'project:delete',
  'project:list',
  'folder:create',
  'folder:read',
  'folder:update',
  'folder:delete',
  'folder:move',
  'folder:list',
  'execution:read',
  'execution:list',
  'execution:delete',
  'tag:create',
  'tag:read',
  'tag:update',
  'tag:delete',
  'user:read',
  'user:list',
  'variable:create',
  'variable:read',
  'variable:update',
  'variable:delete',
  'variable:list',
];

function personalProject(user) {
  return {
    id: user.id,
    name: 'Personal',
    type: 'personal',
    icon: null,
    createdAt: user.createdAt ?? new Date().toISOString(),
    updatedAt: user.updatedAt ?? new Date().toISOString(),
    role: 'project:personalOwner',
    scopes: PROJECT_SCOPES,
  };
}

export { HttpError };
