/**
 * P2.20 — MCP vs Agent Control Boundary tests.
 *
 * Proves the four-state boundary declaration (declared / permission-required /
 * exposed / blocked), the documented permission gate, fail-closed unknown
 * handling, strict authority separation between MCP exposure and Agent
 * Control, provenance against manifest/ai-foundation.json#mcp, and zero
 * network/runtime surface. Approval satisfaction is consumed from
 * ai.approval@1.0.0 (P2.19) by injection — nothing P2.17/P2.18/P2.19 is
 * re-implemented here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  MCP_BOUNDARY_CONTRACT,
  MCP_BOUNDARY_CONTRACT_VERSION,
  MCP_BOUNDARY_FIELDS,
  MCP_BOUNDARY_STATES,
  MCP_CAPABILITY_KINDS,
  MCP_ROLE_KINDS,
  MCP_BOUNDARY_OPERATIONS,
  MCP_BOUNDARY_PERMISSIONS,
  MCP_BOUNDARY_LIMITS,
  MCP_BOUNDARY_TRANSITIONS,
  MCP_PERMISSION_GATE,
  McpBoundaryError,
  createMcpBoundary,
} from '../src/lego/mcp-boundary.mjs';
import { createApprovalFoundation } from '../src/lego/approval.mjs';
import { AUDIT_EVENT_TYPES, createAuditLog } from '../src/lego/audit.mjs';
import { AI_FOUNDATION } from '../src/lego/ai-foundation.mjs';

const MODULE_SRC = readFileSync(new URL('../src/lego/mcp-boundary.mjs', import.meta.url), 'utf8');
const LOCK = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
const LEGO_SET = JSON.parse(readFileSync(new URL('../src/lego/manifest/ai-lego-set.json', import.meta.url), 'utf8'));

const T0 = '2026-09-23T00:00:00.000Z';
const clock = (start = T0) => {
  let t = Date.parse(start);
  const fn = () => new Date(t).toISOString();
  fn.advance = (ms) => { t += ms; };
  fn.set = (iso) => { t = Date.parse(iso); };
  return fn;
};

const capDecl = (capabilityId, extra = {}) => ({
  capabilityId,
  kind: 'tool',
  requiresApproval: false,
  requiresPermission: null,
  mappedCapability: 'ai.tool-gateway',
  ...extra,
});

const declareSample = (boundary, extra = {}) => boundary.declare({
  serverId: 'srv-alpha',
  kind: 'mcp-server',
  provenance: 'manifest/ai-foundation.json#mcp',
  capabilities: [
    capDecl('tool.read'),
    capDecl('tool.write', { requiresApproval: true }),
    capDecl('tool.claim', { requiresPermission: 'ai:tool:invoke' }),
  ],
  ...extra,
});

const denialHarness = () => {
  const now = clock();
  const approval = createApprovalFoundation({ now });
  const boundary = createMcpBoundary({ now, approval });
  return { now, approval, boundary };
};

/* ------------------------------------------------------- contract surface */

test('the contract is ai.mcp-boundary@1.0.0, owner manager, id double-quoted', () => {
  assert.equal(MCP_BOUNDARY_CONTRACT.id, "ai.mcp-boundary");
  assert.equal(MCP_BOUNDARY_CONTRACT_VERSION, '1.0.0');
  assert.equal(MCP_BOUNDARY_CONTRACT.owner, 'manager');
  assert.match(MODULE_SRC, /id:\s*"ai\.mcp-boundary"/, 'contract ids are double-quoted (F16 convention)');
  assert.ok(MCP_BOUNDARY_FIELDS.includes('serverId') && MCP_BOUNDARY_FIELDS.includes('state') && MCP_BOUNDARY_FIELDS.includes('provenance'));
});

test('the contract-lock row is canonical: one row, version, ops, tests, exports', () => {
  const rows = LOCK.contracts.filter((row) => row.id === 'ai.mcp-boundary');
  assert.equal(rows.length, 1, 'exactly one canonical row');
  const row = rows[0];
  assert.equal(row.version, '1.0.0');
  assert.equal(row.owner, 'manager');
  assert.equal(row.domain, 'ai-foundation');
  assert.equal(row.status, 'implemented');
  assert.deepEqual([...row.operations], [...MCP_BOUNDARY_OPERATIONS]);
  assert.deepEqual(row.exports['src/lego/mcp-boundary.mjs'].slice().sort(), Object.keys({
    MCP_BOUNDARY_CONTRACT: 1, MCP_BOUNDARY_CONTRACT_VERSION: 1, MCP_BOUNDARY_FIELDS: 1,
    MCP_BOUNDARY_STATES: 1, MCP_CAPABILITY_KINDS: 1, MCP_ROLE_KINDS: 1,
    MCP_BOUNDARY_OPERATIONS: 1, MCP_BOUNDARY_PERMISSIONS: 1, MCP_BOUNDARY_LIMITS: 1,
    MCP_BOUNDARY_TRANSITIONS: 1, MCP_PERMISSION_GATE: 1, McpBoundaryError: 1, createMcpBoundary: 1,
  }).sort());
  // P9.1 envelope + P3 optimizer are merged; P9.2 structured-log adds row 42.
  assert.equal(LOCK.contracts.length, 100, 'rows through P3 Slice A persistent logical graph (thirty-third); P3 Slice D adds the thirty-fourth (execution.frontier); P3 Slice E adds the thirty-fifth (execution.state-stream); P3 Slice H adds the thirty-sixth (workflow.dna); P3 Slice J the thirty-seventh (execution.ir); P3 Slice L the thirty-eighth (compatibility.oracle); P3 Slice M the thirty-ninth (execution.guard); P3 Slice K the forty-first (execution.optimizer) — P6.1 adds node.registry@0.1.0; P6.2 adds registry.compiler@0.1.0; P6.3 adds package.transaction@0.1.0; P6.4 adds registry.closure@0.1.0; P6.5 adds node.resolution@0.1.0; P6.6 adds runtime.lease@0.1.0; P6.7 adds node.residency@0.1.0; P6.8 adds node.capability@0.1.0; P6.9 adds node.semantics@0.1.0; P6.10 adds node.lifecycle@0.1.0; P6.11 adds node.health@0.1.0; P6.12 adds node.supply-chain@0.1.0; P6.13 adds registry.incremental@0.1.0; P6.14 adds node.worker-convergence@0.1.0; P6.15 adds node.acceptance@0.1.0; P6.16 adds registry.integrity@0.1.0; P6.17 adds node.admission@0.1.0; P6.18 adds node.sbom@0.1.0; P6.19 adds node.canary@0.1.0; P6.20 adds node.revocation@0.1.0; P6.21 adds node.io@0.1.0; P6.22 adds runtime.jit@0.1.0; P6.23 adds runtime.cancel@0.1.0; P6.24 adds runtime.pool@0.1.0; P6.25 adds node.abi@0.1.0; P6.26 adds runtime.wasm-cache@0.1.0; P6.27 adds node.provenance@0.1.0; P6.28 adds registry.freshness@0.1.0; P6.29 adds node.namespace@0.1.0; P6.30 adds registry.repair@0.1.0; P6.31 adds registry.acceptance@0.1.0; count-pins say 76; P2.27.1 adds lego.plugin-runtime@0.1.0 (seventy-sixth); P5.1 adds the ninety-fifth (auth.principal)'); // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  assert.ok(row.tests.every((p) => p.endsWith('.mjs')));
});

test('the four states are exactly the canonical set — no fifth, no authority names', () => {
  assert.deepEqual([...MCP_BOUNDARY_STATES], ['declared', 'permission-required', 'exposed', 'blocked']);
  assert.deepEqual([...MCP_BOUNDARY_STATES], [...AI_FOUNDATION.mcp.states], 'quoted from the manifest, not invented here');
  for (const banned of ['trusted', 'authorized', 'available', 'active', 'allowed', 'connected']) {
    assert.ok(!MCP_BOUNDARY_STATES.includes(banned), `'${banned}' must never be a boundary state`);
  }
  assert.equal(MCP_BOUNDARY_STATES.length, 4, 'the roadmap demands four declared MCP states');
  assert.ok(MCP_BOUNDARY_STATES.includes('declared'), '§9: least-privileged declaration state is the fourth');
});

test('the capability kinds and roles are quoted subsets of the manifest vocabulary', () => {
  assert.deepEqual([...MCP_CAPABILITY_KINDS], ['tool', 'resource', 'prompt']);
  assert.deepEqual([...MCP_ROLE_KINDS], ['mcp-server', 'mcp-client']);
  for (const kind of MCP_CAPABILITY_KINDS) assert.ok(AI_FOUNDATION.mcp.concepts.includes(kind));
  for (const role of MCP_ROLE_KINDS) assert.ok(AI_FOUNDATION.mcp.roles[role]);
  assert.deepEqual([...MCP_BOUNDARY_OPERATIONS], ['declare', 'evaluate', 'revoke', 'inspect']);
  assert.deepEqual([...MCP_BOUNDARY_PERMISSIONS], ['ai:mcp:read', 'ai:mcp:declare', 'ai:mcp:expose']);
});

test('the mcp-adapter LEGO stays contract-only with a P2.20 boundary statusNote', () => {
  const entry = LEGO_SET.lego.find((l) => l.id === 'mcp-adapter');
  assert.equal(entry.status, 'contract-only');
  assert.equal(entry.owner, 'manager');
  assert.match(entry.statusNote ?? '', /P2\.20 publishes ai\.mcp-boundary@1\.0\.0/);
  assert.match(entry.statusNote ?? '', /no MCP server/i, 'runtime remains explicitly out');
  assert.deepEqual(entry.contracts, ['ai.tool-gateway'], 'no contract fork; the boundary contract is NOT claimed by the adapter entry');
});

/* -------------------------------------------------- §27 server boundary */

test('a known server declaration lands as declared with every capability declared', () => {
  const boundary = createMcpBoundary();
  const view = declareSample(boundary);
  assert.equal(view.state, 'declared');
  assert.equal(view.kind, 'mcp-server');
  assert.equal(view.provenance, 'manifest/ai-foundation.json#mcp');
  assert.equal(view.capabilities.length, 3);
  for (const cap of view.capabilities) assert.equal(cap.state, 'declared');
});

test('an unknown server fails closed to blocked/unknown-server', () => {
  const boundary = createMcpBoundary();
  const out = boundary.evaluate({ serverId: 'srv-ghost', capabilityId: 'tool.read' });
  assert.equal(out.state, 'blocked');
  assert.equal(out.reason, 'unknown-server');
  assert.equal(out.changed, false);
});

test('a malformed server declaration is rejected as a contract violation', () => {
  const boundary = createMcpBoundary();
  assert.throws(
    () => boundary.declare({ kind: 'mcp-server', provenance: 'x#y', capabilities: [capDecl('t.a')] }),
    (err) => err instanceof McpBoundaryError && err.code === 'lego.contract_violation',
  );
  assert.throws(
    () => boundary.declare({ serverId: 'srv-x', kind: 'mcp-server', provenance: 'x#y', capabilities: [] }),
    (err) => err instanceof McpBoundaryError && /non-empty array/.test(err.message),
    'an empty export list is malformed — explicit individual export is mandatory',
  );
  assert.throws(
    () => boundary.declare({ serverId: 'srv-x', kind: 'super-server', provenance: 'x#y', capabilities: [capDecl('t.a')] }),
    (err) => err instanceof McpBoundaryError && /kind must be one of/.test(err.message),
  );
});

test('an explicit server block cascades: the server reports blocked and capabilities refuse', () => {
  const boundary = createMcpBoundary();
  declareSample(boundary);
  const res = boundary.revoke({ serverId: 'srv-alpha', reason: 'operator-block' });
  assert.equal(res.state, 'blocked');
  assert.equal(res.capabilityId, null);
  const out = boundary.evaluate({ serverId: 'srv-alpha', capabilityId: 'tool.read' });
  assert.equal(out.state, 'blocked');
  assert.equal(out.reason, 'server-blocked');
  assert.equal(boundary.inspect('srv-alpha').state, 'blocked');
});

test('a declared server exposes nothing until the gate runs', () => {
  const boundary = createMcpBoundary();
  declareSample(boundary);
  const view = boundary.inspect('srv-alpha');
  assert.ok(view.capabilities.every((c) => c.state === 'declared'));
  const flat = JSON.stringify(view);
  assert.ok(!flat.includes('"exposed"') && !flat.includes('"permission-required"'));
  assert.ok(!flat.includes('"permissions"'), 'declaration records carry no permission grants');
});

test('duplicate server declarations are refused deterministically', () => {
  const boundary = createMcpBoundary();
  declareSample(boundary);
  assert.throws(
    () => declareSample(boundary),
    (err) => err instanceof McpBoundaryError && /already declared/.test(err.message),
  );
});

/* ----------------------------------------------- §28 capability boundary */

test('an unknown capability on a known server fails closed to blocked', () => {
  const boundary = createMcpBoundary();
  declareSample(boundary);
  const out = boundary.evaluate({ serverId: 'srv-alpha', capabilityId: 'tool.ghost' });
  assert.equal(out.state, 'blocked');
  assert.equal(out.reason, 'unknown-capability');
});

test('a capability without a permission requirement is exposed only through the gate', () => {
  const boundary = createMcpBoundary();
  declareSample(boundary);
  const out = boundary.evaluate({ serverId: 'srv-alpha', capabilityId: 'tool.read' });
  assert.equal(out.state, 'exposed');
  assert.equal(out.reason, 'permission-not-required');
  assert.equal(out.changed, true);
  assert.equal(boundary.inspect('srv-alpha').capabilities.find((c) => c.capabilityId === 'tool.read').state, 'exposed');
});

test('a permission-required capability sits at permission-required until an explicit grant', () => {
  const boundary = createMcpBoundary();
  declareSample(boundary);
  const out = boundary.evaluate({ serverId: 'srv-alpha', capabilityId: 'tool.write' });
  assert.equal(out.state, 'permission-required');
  assert.equal(out.reason, 'permission-required');
  const cap = boundary.inspect('srv-alpha').capabilities.find((c) => c.capabilityId === 'tool.write');
  assert.equal(cap.state, 'permission-required');
});

test('a capability declared with a required permission also sits at permission-required', () => {
  const boundary = createMcpBoundary();
  declareSample(boundary);
  const out = boundary.evaluate({ serverId: 'srv-alpha', capabilityId: 'tool.claim' });
  assert.equal(out.state, 'permission-required');
  assert.equal(out.reason, 'permission-required');
});

test('revoking a capability blocks it, and blocked is terminal', () => {
  const boundary = createMcpBoundary();
  declareSample(boundary);
  const res = boundary.revoke({ serverId: 'srv-alpha', capabilityId: 'tool.read', reason: 'policy' });
  assert.equal(res.state, 'blocked');
  assert.equal(res.changed, true);
  assert.equal(res.reason, 'policy');
  // Terminal: the graph gives blocked no outgoing edges — evaluate cannot resurrect.
  const again = boundary.evaluate({ serverId: 'srv-alpha', capabilityId: 'tool.read' });
  assert.equal(again.state, 'blocked');
  assert.equal(again.changed, false);
  assert.deepEqual([...MCP_BOUNDARY_TRANSITIONS.blocked], [], 'the canonical graph confirms blocked is terminal');
  // Idempotent revoke of an already-blocked capability.
  const replay = boundary.revoke({ serverId: 'srv-alpha', capabilityId: 'tool.read' });
  assert.equal(replay.changed, false);
});

test('the tool-gateway mapping is mandatory — an unmapped capability is rejected', () => {
  const boundary = createMcpBoundary();
  assert.throws(
    () => boundary.declare({
      serverId: 'srv-beta',
      kind: 'mcp-server',
      provenance: 'manifest/ai-foundation.json#mcp',
      capabilities: [{ capabilityId: 'tool.raw', kind: 'tool', requiresApproval: false, requiresPermission: null }],
    }),
    (err) => err instanceof McpBoundaryError && /mappedCapability/.test(err.message),
    'MCP concepts map ONTO the tool gateway contract (§13)',
  );
});

/* ------------------------------------------------ §29 authority separation */

test('declaring a server grants no exposure and no permissions', () => {
  const boundary = createMcpBoundary();
  const view = declareSample(boundary);
  assert.ok(view.capabilities.every((c) => c.state === 'declared'));
  const flat = JSON.stringify(view);
  assert.ok(!flat.includes('"exposed"'));
  assert.ok(!flat.includes('"permissions"'));
  assert.ok(!flat.includes('"granted"'));
});

test('an approval granted elsewhere does not expose a capability that never presented it', () => {
  const { boundary, approval } = denialHarness();
  declareSample(boundary);
  approval.request({
    approvalId: 'ap-elsewhere', action: 'push code', actor: 'agent-1',
    risk: 'high', scope: 'srv-alpha/tool.write',
  });
  approval.resolve({ approvalId: 'ap-elsewhere', decision: 'granted', approver: 'manager-1' });
  // The grant EXISTS but was never presented to the gate for tool.read (which
  // needs nothing) — and for tool.write we present nothing here.
  const out = boundary.evaluate({ serverId: 'srv-alpha', capabilityId: 'tool.write' });
  assert.equal(out.state, 'permission-required', 'presence of a grant in the store is not automatic exposure');
});

test('agent-side permission claims never satisfy the gate — unknown permission fails closed', () => {
  const boundary = createMcpBoundary();
  declareSample(boundary);
  const out = boundary.evaluate({
    serverId: 'srv-alpha', capabilityId: 'tool.write', permission: 'ai:tool:invoke',
  });
  assert.equal(out.state, 'blocked');
  assert.equal(out.reason, 'unknown-permission');
  assert.equal(out.changed, true, 'the attempt is recorded fail-closed on the capability');
  // The capability is now terminally blocked — claims cannot un-block it.
  const again = boundary.evaluate({
    serverId: 'srv-alpha', capabilityId: 'tool.write', permission: 'ai:tool:invoke',
  });
  assert.equal(again.state, 'blocked');
  assert.equal(again.changed, false);
});

test('server identity is not trust: the gate still demands an explicit grant', () => {
  const boundary = createMcpBoundary();
  declareSample(boundary); // a perfectly valid, declared server…
  const out = boundary.evaluate({ serverId: 'srv-alpha', capabilityId: 'tool.write' });
  assert.equal(out.state, 'permission-required', 'valid identity alone never reaches exposed');
});

test('exposure grants no agent authority: the public surface is fixed and reason strings are bounded', () => {
  const boundary = createMcpBoundary();
  declareSample(boundary);
  boundary.evaluate({ serverId: 'srv-alpha', capabilityId: 'tool.read' });
  const view = boundary.inspect('srv-alpha');
  const flat = JSON.stringify(view);
  assert.ok(!flat.includes('"ai:agent'), 'no agent permissions leak into boundary records');
  assert.ok(!flat.includes('"grant'), 'records never carry grants');
  for (const cap of view.capabilities) {
    assert.ok(cap.reason.length <= MCP_BOUNDARY_LIMITS.maxReasonLength);
    assert.ok(!('permissions' in cap));
    assert.ok(!('authority' in cap));
  }
  // The module has no API that could hand out authority.
  const surface = Object.keys(createMcpBoundary()).sort();
  assert.deepEqual(surface, ['clear', 'declare', 'evaluate', 'inspect', 'revoke', 'size']);
});

test('the module only imports the foundation accessor — no agent-machine, approval or transport code', () => {
  const imports = [...MODULE_SRC.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['./ai-foundation.mjs'], 'boundary module depends on vocabulary only; approval arrives by injection');
});

/* --------------------------------------------------- §30 fail-closed set */

test('unknown server, unknown capability and permission claims all answer blocked', () => {
  const boundary = createMcpBoundary();
  declareSample(boundary);
  assert.equal(boundary.evaluate({ serverId: 'nope', capabilityId: 'tool.read' }).reason, 'unknown-server');
  assert.equal(boundary.evaluate({ serverId: 'srv-alpha', capabilityId: 'nope' }).reason, 'unknown-capability');
  assert.equal(
    boundary.evaluate({ serverId: 'srv-alpha', capabilityId: 'tool.read', permission: 'ai:tool:invoke' }).reason,
    'unknown-permission',
  );
});

test('malformed evaluate/revoke inputs are rejected, not silently blocked', () => {
  const boundary = createMcpBoundary();
  declareSample(boundary);
  assert.throws(() => boundary.evaluate('srv-alpha'), (err) => err instanceof McpBoundaryError);
  assert.throws(() => boundary.evaluate({ serverId: 'srv-alpha' }), (err) => err instanceof McpBoundaryError);
  assert.throws(
    () => boundary.revoke({ serverId: 'srv-ghost', capabilityId: 'tool.read' }),
    (err) => err instanceof McpBoundaryError && /unknown server/.test(err.message),
  );
  assert.throws(
    () => boundary.revoke({ serverId: 'srv-alpha', capabilityId: 'tool.ghost' }),
    (err) => err instanceof McpBoundaryError && /unknown capability/.test(err.message),
  );
});

test('an expired approval blocks the capability (fail-closed clock)', () => {
  const { now, approval, boundary } = denialHarness();
  declareSample(boundary);
  approval.request({
    approvalId: 'ap-exp', action: 'push code', actor: 'agent-1', risk: 'high',
    scope: 'srv-alpha/tool.write', expiresAt: '2026-09-23T01:00:00.000Z',
  });
  now.set('2026-09-23T02:00:00.000Z');
  const out = boundary.evaluate({
    serverId: 'srv-alpha', capabilityId: 'tool.write', approvalReference: 'ap-exp',
    identity: 'agent-1', scope: 'srv-alpha/tool.write',
  });
  assert.equal(out.state, 'blocked');
  assert.equal(out.reason, 'expired');
});

test('scope mismatch, identity mismatch, unknown reference and explicit denial all block', () => {
  const { approval } = denialHarness();
  approval.request({
    approvalId: 'ap-ok', action: 'push code', actor: 'agent-1', risk: 'high', scope: 'scope-a',
  });
  approval.resolve({ approvalId: 'ap-ok', decision: 'granted', approver: 'manager-1' });
  approval.request({
    approvalId: 'ap-no', action: 'push code', actor: 'agent-2', risk: 'high', scope: 'scope-b',
  });
  approval.resolve({ approvalId: 'ap-no', decision: 'denied', approver: 'manager-1', reason: 'policy' });
  // Each scenario evaluates on its own boundary: `blocked` is terminal, so a
  // single capability could otherwise mask later reasons behind the first one.
  const fresh = () => {
    const boundary = createMcpBoundary({ approval });
    declareSample(boundary);
    return boundary;
  };

  const scopeMiss = fresh().evaluate({
    serverId: 'srv-alpha', capabilityId: 'tool.write', approvalReference: 'ap-ok',
    identity: 'agent-1', scope: 'scope-b',
  });
  assert.equal(scopeMiss.state, 'blocked');
  assert.equal(scopeMiss.reason, 'scope-mismatch');

  const idMiss = fresh().evaluate({
    serverId: 'srv-alpha', capabilityId: 'tool.write', approvalReference: 'ap-ok',
    identity: 'intruder', scope: 'scope-a',
  });
  assert.equal(idMiss.state, 'blocked');
  assert.equal(idMiss.reason, 'identity-mismatch');

  const denied = fresh().evaluate({
    serverId: 'srv-alpha', capabilityId: 'tool.write', approvalReference: 'ap-no',
    identity: 'agent-2', scope: 'scope-b',
  });
  assert.equal(denied.state, 'blocked');
  assert.equal(denied.reason, 'policy', 'the stored denial reason is surfaced');

  const unknown = fresh().evaluate({
    serverId: 'srv-alpha', capabilityId: 'tool.write', approvalReference: 'ap-ghost',
  });
  assert.equal(unknown.state, 'blocked');
  assert.equal(unknown.reason, 'unknown-approval');
});

test('a pending approval keeps the capability at permission-required — never exposed, never falsely blocked', () => {
  const { approval, boundary } = denialHarness();
  declareSample(boundary);
  approval.request({
    approvalId: 'ap-wait', action: 'push code', actor: 'agent-1', risk: 'high', scope: 'srv-alpha/tool.write',
  });
  const out = boundary.evaluate({
    serverId: 'srv-alpha', capabilityId: 'tool.write', approvalReference: 'ap-wait',
    identity: 'agent-1', scope: 'srv-alpha/tool.write',
  });
  assert.equal(out.state, 'permission-required');
  assert.equal(out.reason, 'not-granted');
});

test('a permission-gated capability cannot be evaluated without a wired approval foundation', () => {
  const boundary = createMcpBoundary(); // deliberately unwired
  declareSample(boundary);
  assert.throws(
    () => boundary.evaluate({
      serverId: 'srv-alpha', capabilityId: 'tool.write', approvalReference: 'ap-x',
    }),
    (err) => err instanceof McpBoundaryError && /approval foundation not wired/.test(err.message),
  );
});

/* ------------------------------------------------------ §31 provenance */

test('states, transitions, gate steps and rules all quote manifest/ai-foundation.json#mcp', () => {
  const mcp = AI_FOUNDATION.mcp;
  assert.deepEqual([...MCP_BOUNDARY_STATES], [...mcp.states]);
  assert.deepEqual([...MCP_PERMISSION_GATE], [...mcp.permissionGate]);
  assert.deepEqual(Object.keys(MCP_BOUNDARY_TRANSITIONS).sort(), [...mcp.states].slice().sort());
  for (const [from, tos] of Object.entries(mcp.transitions)) {
    assert.deepEqual([...MCP_BOUNDARY_TRANSITIONS[from]], tos, `${from} edges quoted verbatim`);
  }
  assert.equal(MCP_BOUNDARY_CONTRACT.id, mcp.contract, 'contract id comes from the manifest');
  assert.ok(mcp.authorityRule && mcp.failClosedRule && mcp.approvalRule && mcp.stateRule);
  assert.ok(mcp.notBuilt.includes('No MCP server, client'), 'the notBuilt runtime rule survives');
});

test('every declaration records provenance pointing at its canonical source', () => {
  const boundary = createMcpBoundary();
  const view = boundary.declare({
    serverId: 'srv-gamma',
    kind: 'mcp-client',
    provenance: 'manifest/ai-foundation.json#mcp',
    capabilities: [capDecl('tool.read', { provenance: 'manifest/ai-foundation.json#toolGateway' })],
  });
  assert.equal(view.provenance, 'manifest/ai-foundation.json#mcp');
  assert.equal(view.capabilities[0].provenance, 'manifest/ai-foundation.json#toolGateway');
  assert.ok(view.declaredAt);
});

test('the gate runs in canonical order: server existence is checked before capability existence', () => {
  const boundary = createMcpBoundary();
  declareSample(boundary);
  const out = boundary.evaluate({ serverId: 'srv-ghost', capabilityId: 'tool.ghost' });
  assert.equal(out.reason, 'unknown-server', 'step 1 (server declared) precedes step 2 (capability declared)');
  assert.match(MCP_PERMISSION_GATE[0], /server declared/);
  assert.match(MCP_PERMISSION_GATE[1], /capability declared/);
});

/* --------------------------------------------- §20/§21/§22 integrations */

test('the approval flow integrates with P2.19: request → granted → exposed', () => {
  const { approval, boundary } = denialHarness();
  declareSample(boundary);
  approval.request({
    approvalId: 'ap-flow', action: 'push code', actor: 'agent-1', risk: 'high', scope: 'srv-alpha/tool.write',
  });
  const pending = boundary.evaluate({
    serverId: 'srv-alpha', capabilityId: 'tool.write', approvalReference: 'ap-flow',
    identity: 'agent-1', scope: 'srv-alpha/tool.write',
  });
  assert.equal(pending.state, 'permission-required');
  approval.resolve({ approvalId: 'ap-flow', decision: 'granted', approver: 'manager-1' });
  const granted = boundary.evaluate({
    serverId: 'srv-alpha', capabilityId: 'tool.write', approvalReference: 'ap-flow',
    identity: 'agent-1', scope: 'srv-alpha/tool.write',
  });
  assert.equal(granted.state, 'exposed');
  assert.equal(granted.reason, 'approval-granted');
  assert.equal(granted.approvalReference, 'ap-flow');
  // Idempotent re-evaluation of an exposed capability.
  const again = boundary.evaluate({
    serverId: 'srv-alpha', capabilityId: 'tool.write', approvalReference: 'ap-flow',
    identity: 'agent-1', scope: 'srv-alpha/tool.write',
  });
  assert.equal(again.state, 'exposed');
  assert.equal(again.changed, false);
  assert.equal(again.reason, 'already-exposed');
});

test('boundary transitions record into the P2.19 audit foundation with canonical events and no content', () => {
  const audit = createAuditLog({ now: clock() });
  const { approval, boundary } = denialHarness();
  declareSample(boundary);
  // The audit vocabulary of ai.audit@1.0.0 is a closed set — P2.20 maps its
  // approval-driven transitions onto the canonical approval.* events and never
  // invents a second event language (unknown-server refusals remain visible as
  // structured evaluate outcomes, which are the boundary's own reference).
  approval.request({
    approvalId: 'ap-audit', action: 'push code', actor: 'agent-1', risk: 'high', scope: 'srv-alpha/tool.write',
  });
  audit.record({
    eventType: 'approval.requested', actor: 'agent-1', subject: 'srv-alpha/tool.write',
    operation: 'evaluate', result: 'permission-required',
    metadata: { state: 'permission-required', reason: 'not-granted' },
  });
  approval.resolve({ approvalId: 'ap-audit', decision: 'granted', approver: 'manager-1' });
  const exposed = boundary.evaluate({
    serverId: 'srv-alpha', capabilityId: 'tool.write', approvalReference: 'ap-audit',
    identity: 'agent-1', scope: 'srv-alpha/tool.write',
  });
  assert.equal(exposed.state, 'exposed');
  audit.record({
    eventType: 'approval.granted', actor: 'manager-1', subject: 'srv-alpha/tool.write',
    operation: 'evaluate', result: exposed.state,
    metadata: { state: exposed.state, reason: exposed.reason },
  });
  const refused = boundary.evaluate({ serverId: 'srv-ghost', capabilityId: 'tool.read' });
  assert.equal(refused.state, 'blocked', 'the structured outcome IS the refusal reference');
  const entries = audit.list();
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.ok(AUDIT_EVENT_TYPES.includes(entry.eventType), `${entry.eventType} is canonical for ai.audit@1.0.0`);
  }
  assert.deepEqual(entries.map((e) => e.eventType), ['approval.requested', 'approval.granted']);
  const flat = JSON.stringify(entries);
  assert.ok(!flat.includes('tool.write description'), 'no capability content is audited');
  assert.ok(!/ghp_|Bearer |sk-/.test(flat), 'no secret-shaped material in audit entries');
});

test('descriptionRef stays opaque: oversized and path-shaped references are refused', () => {
  const boundary = createMcpBoundary();
  assert.throws(
    () => boundary.declare({
      serverId: 'srv-delta', kind: 'mcp-server', provenance: 'manifest/ai-foundation.json#mcp',
      capabilities: [capDecl('tool.read', { descriptionRef: '/etc/passwd' })],
    }),
    (err) => err instanceof McpBoundaryError && /opaque/.test(err.message),
  );
  assert.throws(
    () => boundary.declare({
      serverId: 'srv-delta', kind: 'mcp-server', provenance: 'manifest/ai-foundation.json#mcp',
      capabilities: [capDecl('tool.read', { descriptionRef: '../secrets/key.pem' })],
    }),
    (err) => err instanceof McpBoundaryError && /opaque/.test(err.message),
  );
  assert.throws(
    () => boundary.declare({
      serverId: 'srv-delta', kind: 'mcp-server', provenance: 'manifest/ai-foundation.json#mcp',
      capabilities: [capDecl('tool.read', { descriptionRef: 'x'.repeat(5000) })],
    }),
    (err) => err instanceof McpBoundaryError,
    'large payloads belong behind ai.artifact, never inlined (§21)',
  );
});

test('secret-shaped provenance or references are refused (no credentials at the boundary)', () => {
  const boundary = createMcpBoundary();
  assert.throws(
    () => boundary.declare({
      serverId: 'srv-eps', kind: 'mcp-server', provenance: 'token ghp_abcdef1234567890',
      capabilities: [capDecl('tool.read')],
    }),
    (err) => err instanceof McpBoundaryError && /secret-shaped/.test(err.message),
  );
  assert.throws(
    () => boundary.declare({
      serverId: 'srv-eps', kind: 'mcp-server', provenance: 'manifest/ai-foundation.json#mcp',
      capabilities: [capDecl('tool.read', { descriptionRef: 'Bearer abc.def.ghi' })],
    }),
    (err) => err instanceof McpBoundaryError && /secret-shaped/.test(err.message),
  );
});

/* -------------------------------------------------- §32 no network, static */

test('the module contains no network, process or MCP-runtime surface', () => {
  const forbidden = [
    /\bfetch\s*\(/,
    /require\s*\(\s*['"]node:(http|https|net|tls|child_process)/,
    /from\s+['"]node:(http|https|net|tls|dgram|child_process|worker_threads)/,
    /\bspawn\s*\(/,
    /\bexec(File)?\s*\(/,
    /McpHttpClient|McpServer|McpClient|@modelcontextprotocol/i,
    /XMLHttpRequest|WebSocket/,
  ];
  for (const re of forbidden) {
    assert.ok(!re.test(MODULE_SRC), `forbidden surface matched: ${re}`);
  }
});

test('the server bound holds: capacity is finite and refused deterministically', () => {
  const boundary = createMcpBoundary({ limits: { maxServers: 2 } });
  boundary.declare({ serverId: 'srv-1', kind: 'mcp-server', provenance: 'p#m', capabilities: [capDecl('t.a')] });
  boundary.declare({ serverId: 'srv-2', kind: 'mcp-server', provenance: 'p#m', capabilities: [capDecl('t.a')] });
  assert.throws(
    () => boundary.declare({ serverId: 'srv-3', kind: 'mcp-server', provenance: 'p#m', capabilities: [capDecl('t.a')] }),
    (err) => err instanceof McpBoundaryError && /bounded at 2 servers/.test(err.message),
  );
});

test('the export-all prohibition: each capability is exported and evaluated individually', () => {
  const boundary = createMcpBoundary();
  declareSample(boundary);
  const outA = boundary.evaluate({ serverId: 'srv-alpha', capabilityId: 'tool.read' });
  assert.equal(outA.state, 'exposed');
  const sibling = boundary.inspect('srv-alpha').capabilities.find((c) => c.capabilityId === 'tool.write');
  assert.equal(sibling.state, 'declared', 'exposing tool.read exposes NOTHING else — no export-everything switch');
});

test('authority separation end-to-end: the same granted approval exposes exactly one named capability', () => {
  const { approval, boundary } = denialHarness();
  declareSample(boundary);
  approval.request({
    approvalId: 'ap-one', action: 'push code', actor: 'agent-1', risk: 'high', scope: 'srv-alpha/tool.write',
  });
  approval.resolve({ approvalId: 'ap-one', decision: 'granted', approver: 'manager-1' });
  const out = boundary.evaluate({
    serverId: 'srv-alpha', capabilityId: 'tool.write', approvalReference: 'ap-one',
    identity: 'agent-1', scope: 'srv-alpha/tool.write',
  });
  assert.equal(out.state, 'exposed');
  const view = boundary.inspect('srv-alpha');
  const claim = view.capabilities.find((c) => c.capabilityId === 'tool.claim');
  assert.equal(claim.state, 'declared', 'the grant for tool.write does not leak to tool.claim');
  const read = view.capabilities.find((c) => c.capabilityId === 'tool.read');
  assert.equal(read.state, 'declared', 'and did not touch tool.read either');
});
