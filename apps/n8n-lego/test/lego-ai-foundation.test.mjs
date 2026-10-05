/**
 * AI Foundation contract tests (P2.10).
 *
 * These test a CONTRACT, not an implementation — there is no inference, agent
 * runtime, gateway client or MCP adapter in this repository, and several tests
 * below exist specifically to prove that remains true.
 *
 * The tests are organised around the ways this kind of contract normally rots:
 *
 *   1. a vendor name leaks from an example into a structural field, and the
 *      "provider-neutral" contract quietly becomes one vendor's shape;
 *   2. capability, provider, transport and runtime get conflated, so an
 *      implementation can no longer be replaced without a rename;
 *   3. a safety default is written as fail-open because that is the shape a
 *      plain `list.includes()` produces;
 *   4. contract-only slowly becomes "contract plus a little code".
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AGENT_EVENT_TYPES,
  AGENT_SESSION_STATES,
  AI_CONCEPTS,
  AI_FOUNDATION,
  AI_RESOURCE_PROFILES,
  AI_TRANSPORTS,
  ARTIFACT_KINDS,
  ARTIFACT_RETENTION,
  CONTEXT_SCOPES,
  PROVIDER_KINDS,
  RISK_LEVELS,
  RUNTIME_LOCALITIES,
  TOOL_SIDE_EFFECTS,
  checkDelegationGrant,
  describeProviderKind,
  isZeroInstallState,
  listAiContracts,
  operationsFor,
  requiresApproval,
  transportCanCarry,
} from '../src/lego/ai-foundation.mjs';
import { COMMUNICATION_MODES } from '../src/lego/foundation.mjs';
import { loadRegistry } from '../src/lego/registry.mjs';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = loadRegistry({ reload: true });

/* ------------------------------------------------------- taxonomy (§13) */

test('the five concepts are distinct and named', () => {
  assert.deepEqual(AI_CONCEPTS, ['capability', 'implementation', 'provider', 'transport', 'runtime']);
});

test('every provider kind declares a contract and required fields', () => {
  for (const kind of PROVIDER_KINDS) {
    const described = describeProviderKind(kind);
    assert.ok(described, `provider kind '${kind}' must be describable`);
    assert.ok(described.contract, `'${kind}' must name a contract`);
    assert.ok(Array.isArray(described.required) && described.required.length > 0,
      `'${kind}' must declare required fields`);
    assert.ok(Array.isArray(described.examples) && described.examples.length > 0,
      `'${kind}' must give at least one example so the kind is unambiguous`);
  }
});

test('provider kinds cover model, tool, application, agent and simulation', () => {
  for (const kind of ['model-provider', 'tool-provider', 'application-provider', 'agent-runtime', 'simulation-runtime']) {
    assert.ok(PROVIDER_KINDS.includes(kind), `missing provider kind '${kind}'`);
  }
});

/* -------------------------------------------------- vendor neutrality (§14) */

test('no vendor name appears in any contract id', () => {
  const vendors = ['9router', 'composio', 'hermes', 'claude', 'gemini', 'antigravity', 'openclaw', 'deepseek', 'mirofish'];
  for (const contract of listAiContracts()) {
    for (const vendor of vendors) {
      assert.ok(!contract.toLowerCase().includes(vendor),
        `contract id '${contract}' names vendor '${vendor}' — a contract must outlive any provider`);
    }
  }
});

test('vendor names appear only inside examples arrays', () => {
  // Walk the raw JSON. A vendor in prose or an `examples` array is fine; a
  // vendor in a structural position means the contract has been shaped around
  // one provider and the next one will not fit.
  const raw = JSON.parse(readFileSync(join(APP_ROOT, 'src/lego/manifest/ai-foundation.json'), 'utf8'));
  const vendors = ['9router', 'composio', 'hermes', 'antigravity', 'openclaw', 'deepseek', 'mirofish'];
  const offences = [];
  const walk = (node, path, insideExamples) => {
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${path}[${i}]`, insideExamples));
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        for (const vendor of vendors) {
          if (key.toLowerCase().includes(vendor)) offences.push(`key ${path}.${key}`);
        }
        walk(value, `${path}.${key}`, insideExamples || key === 'examples');
      }
      return;
    }
    if (typeof node !== 'string' || insideExamples) return;
    if (!/\.(id|contract|name|kind|type|default|permission|transport)$/.test(path)) return;
    for (const vendor of vendors) {
      if (node.toLowerCase().includes(vendor)) offences.push(`${path} = '${node}'`);
    }
  };
  walk(raw, 'ai', false);
  assert.deepEqual(offences, [], `vendor names in structural fields: ${offences.join('; ')}`);
});

test('GitHub is representable as an application provider without any gateway', () => {
  const example = AI_FOUNDATION.applicationProvider.exampleCapabilities;
  assert.equal(example.application, 'github');
  const ids = example.capabilities.map((capability) => capability.id);
  for (const expected of ['repo.read', 'repo.write', 'branch.create', 'commit.create',
    'pr.create', 'issue.create', 'actions.read', 'webhook.receive']) {
    assert.ok(ids.includes(expected), `missing GitHub capability '${expected}'`);
  }
  // The point of the rule: a native path must not be forced through a gateway.
  assert.match(AI_FOUNDATION.applicationProvider.firstClassRule, /native/i);
  for (const id of ids) {
    assert.ok(!id.includes('composio'), 'an application capability must not name a gateway');
  }
});

test('every application capability declares its side effects', () => {
  for (const capability of AI_FOUNDATION.applicationProvider.exampleCapabilities.capabilities) {
    assert.ok(TOOL_SIDE_EFFECTS.includes(capability.sideEffects),
      `'${capability.id}' has side effects '${capability.sideEffects}', which is not a declared class`);
  }
});

/* ------------------------------------------------- gateways + operations (§15,16) */

test('the model gateway declares provider-neutral operations', () => {
  const names = operationsFor('ai.model-gateway').map((operation) => operation.name);
  assert.deepEqual(names, ['models.list', 'model.describe', 'generate', 'stream', 'embed', 'countTokens']);
});

test('the tool gateway covers tools, resources and prompts', () => {
  const names = operationsFor('ai.tool-gateway').map((operation) => operation.name);
  for (const expected of ['tools.list', 'tool.describe', 'tool.call', 'resources.list',
    'resource.read', 'prompts.list', 'prompt.get']) {
    assert.ok(names.includes(expected), `missing tool gateway operation '${expected}'`);
  }
});

test('every AI operation uses one of the four interaction classes', () => {
  for (const contract of ['ai.model-gateway', 'ai.tool-gateway', 'ai.agent-runtime']) {
    for (const operation of operationsFor(contract)) {
      assert.ok(COMMUNICATION_MODES.includes(operation.interaction),
        `${contract}.${operation.name} uses '${operation.interaction}', which is not one of the four classes`);
    }
  }
});

test('every AI operation declares a permission and idempotency', () => {
  for (const contract of listAiContracts()) {
    for (const operation of operationsFor(contract)) {
      assert.equal(typeof operation.permission, 'string', `${contract}.${operation.name} has no permission`);
      assert.equal(typeof operation.idempotent, 'boolean', `${contract}.${operation.name} has no idempotency`);
    }
  }
});

test('every streaming AI operation declares a backpressure policy', () => {
  const policies = ['buffer', 'drop', 'drop-oldest', 'coalesce', 'block', 'reject', 'terminate'];
  for (const contract of listAiContracts()) {
    for (const operation of operationsFor(contract)) {
      if (operation.interaction !== 'stream') continue;
      assert.ok(policies.includes(operation.backpressure),
        `${contract}.${operation.name} streams without a declared policy — that means unbounded buffering`);
    }
  }
});

test('token streaming blocks rather than dropping or buffering', () => {
  const stream = operationsFor('ai.model-gateway').find((operation) => operation.name === 'stream');
  assert.equal(stream.backpressure, 'block',
    'dropping tokens corrupts output; unbounded buffering exhausts memory on a low-end device');
});

test('model cost and latency are optional and must not be read as zero', () => {
  const metadata = AI_FOUNDATION.modelGateway.modelMetadata;
  assert.ok(!metadata.required.includes('costPerInputToken'));
  assert.ok(metadata.optional.includes('costPerInputToken'));
  assert.match(metadata.rule, /unknown/i);
});

test('a tool must declare side effects, and unknown means destructive', () => {
  const metadata = AI_FOUNDATION.toolGateway.toolMetadata;
  assert.ok(metadata.required.includes('sideEffects'));
  assert.match(metadata.rule, /destructive/i);
});

/* ------------------------------------------------------ agent runtime (§18) */

test('the agent runtime declares the full lifecycle', () => {
  const names = operationsFor('ai.agent-runtime').map((operation) => operation.name);
  assert.deepEqual(names, ['create', 'start', 'send', 'pause', 'resume', 'cancel', 'status', 'stream', 'artifact', 'close']);
});

test('control operations are idempotent so a repeated cancel is safe', () => {
  const byName = new Map(operationsFor('ai.agent-runtime').map((operation) => [operation.name, operation]));
  for (const name of ['pause', 'resume', 'cancel', 'close', 'status']) {
    assert.equal(byName.get(name).idempotent, true, `'${name}' must be idempotent`);
  }
  assert.equal(byName.get('send').idempotent, false, 'send appends to a conversation and is not idempotent');
});

test('a runtime declares its locality and what it actually supports', () => {
  const metadata = AI_FOUNDATION.agentRuntime.runtimeMetadata;
  assert.deepEqual(RUNTIME_LOCALITIES, ['in-process', 'local-process', 'local-network', 'remote']);
  for (const field of ['session', 'background', 'stream', 'cancellation', 'delegation']) {
    assert.ok(metadata.supports[field], `runtime metadata must declare support for '${field}'`);
  }
  // A runtime that cannot stop must be able to say so.
  assert.match(metadata.rule, /cancellation: false/);
});

test('a runtime that cannot pause refuses rather than faking it', () => {
  assert.match(AI_FOUNDATION.agentRuntime.pauseRule, /operation_unsupported/);
});

/* ------------------------------------------------------ session + delegation */

test('session state is references, never inlined transcripts', () => {
  const session = AI_FOUNDATION.agentSession;
  for (const reference of ['contextRef', 'artifactRef', 'traceRef']) {
    assert.ok(session.references.includes(reference));
  }
  for (const forbidden of ['transcript', 'messages', 'history', 'prompt']) {
    assert.ok(!session.fields.includes(forbidden),
      `session must not inline '${forbidden}' — session records must stay bounded`);
  }
});

test('session states cover the real outcomes including cancellation', () => {
  for (const state of ['created', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled']) {
    assert.ok(AGENT_SESSION_STATES.includes(state), `missing session state '${state}'`);
  }
});

test('delegation requires an explicit capability subset', () => {
  assert.match(AI_FOUNDATION.delegation.authorityRule, /SUBSET/);
  assert.deepEqual(checkDelegationGrant(['a', 'b', 'c'], ['a', 'b']), { ok: true, escalated: [] });
});

test('a child cannot be granted a capability its parent lacks', () => {
  const result = checkDelegationGrant(['repo.read'], ['repo.read', 'repo.write']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.escalated, ['repo.write'],
    'privilege escalation through delegation must be detectable, not implicit');
});

test('a child of a parent with no capabilities gets nothing', () => {
  assert.equal(checkDelegationGrant([], ['anything']).ok, false);
  assert.equal(checkDelegationGrant([], []).ok, true);
});

test('delegation requires a budget and clamps the deadline', () => {
  const budget = AI_FOUNDATION.delegation.budget;
  for (const field of ['maxTokens', 'maxToolCalls', 'maxDurationMs', 'maxChildren']) {
    assert.ok(budget.fields.includes(field), `budget must bound '${field}'`);
  }
  assert.match(AI_FOUNDATION.delegation.deadlineRule, /clamp/i);
});

/* ------------------------------------------------------------- events (§21) */

test('the event vocabulary covers the full agent lifecycle', () => {
  for (const type of ['agent.created', 'agent.started', 'agent.waiting', 'agent.paused',
    'agent.resumed', 'agent.delegated', 'agent.completed', 'agent.failed', 'agent.cancelled',
    'context.loaded', 'context.compacted', 'tool.requested', 'tool.started', 'tool.completed',
    'tool.failed', 'decision.created', 'decision.approved', 'decision.rejected',
    'approval.requested', 'approval.granted', 'approval.denied', 'artifact.created',
    'artifact.updated', 'runtime.connected', 'runtime.disconnected', 'runtime.unavailable']) {
    assert.ok(AGENT_EVENT_TYPES.includes(type), `missing event type '${type}'`);
  }
});

test('event types are unique and namespaced', () => {
  assert.equal(new Set(AGENT_EVENT_TYPES).size, AGENT_EVENT_TYPES.length, 'duplicate event type');
  for (const type of AGENT_EVENT_TYPES) {
    assert.match(type, /^[a-z]+\.[a-z-]+$/, `event '${type}' must be namespaced lowercase`);
  }
});

test('events carry identity and references, never reasoning or secrets', () => {
  const events = AI_FOUNDATION.events;
  for (const field of ['eventId', 'timestamp', 'type', 'sessionId', 'scope']) {
    assert.ok(events.envelope.required.includes(field), `event envelope must require '${field}'`);
  }
  const all = [...events.envelope.required, ...events.envelope.optional];
  for (const forbidden of ['reasoning', 'thoughts', 'prompt', 'completion', 'token', 'credential', 'apiKey']) {
    assert.ok(!all.includes(forbidden), `event envelope must not carry '${forbidden}'`);
  }
  assert.match(events.privacyRule, /chain-of-thought/i);
});

/* --------------------------------------------- decision + approval (§22,23) */

test('a decision records the choice and evidence, not the reasoning trace', () => {
  const decision = AI_FOUNDATION.decision;
  for (const field of ['decisionId', 'selectedOption', 'alternativeRefs', 'reasonSummary', 'evidenceRefs', 'risk', 'approvalState']) {
    assert.ok(decision.fields.includes(field), `decision must record '${field}'`);
  }
  assert.match(decision.privacyRule, /chain-of-thought must NOT be stored/i);
  assert.deepEqual(RISK_LEVELS, ['low', 'medium', 'high', 'critical']);
});

test('approval is fail-closed: an expired approval is a deny', () => {
  assert.match(AI_FOUNDATION.approval.failClosedRule, /DENY/);
  assert.ok(AI_FOUNDATION.approval.decision.includes('expired'));
});

test('an unknown action requires approval', () => {
  // The fail-open trap: `list.includes(action)` returns false for anything new,
  // so a newly added destructive action would need no approval until someone
  // remembered to extend the list.
  assert.equal(requiresApproval('some-action-nobody-declared'), true);
  assert.equal(requiresApproval(''), true);
  assert.equal(requiresApproval(undefined), true);
  assert.equal(requiresApproval(null), true);
});

test('a declared high-risk action always requires approval', () => {
  for (const action of ['execute workflow', 'modify credential', 'change system setting',
    'delete resource', 'push code', 'merge pull request', 'send external message']) {
    assert.equal(requiresApproval(action), true, `'${action}' must require approval`);
  }
});

test('a declared action cannot be downgraded by claiming read-only', () => {
  assert.equal(requiresApproval('push code', { sideEffects: 'read-only' }), true,
    'the declared list wins — otherwise a caller could opt out of the safety layer');
});

test('a proven read-only action skips approval', () => {
  assert.equal(requiresApproval('repo.read', { sideEffects: 'read-only' }), false);
  assert.equal(requiresApproval('repo.write', { sideEffects: 'writes' }), true);
});

/* ----------------------------------------------- artifact + context (§24,25) */

test('artifacts are references with checksums and retention', () => {
  const artifact = AI_FOUNDATION.artifact;
  for (const field of ['artifactId', 'kind', 'size', 'mime', 'storageRef', 'checksum', 'retention']) {
    assert.ok(artifact.fields.includes(field), `artifact must declare '${field}'`);
  }
  assert.ok(ARTIFACT_KINDS.includes('patch') && ARTIFACT_KINDS.includes('simulation-result'));
  assert.deepEqual(ARTIFACT_RETENTION, ['ephemeral', 'session', 'retained', 'pinned']);
  assert.ok(!artifact.fields.includes('content') && !artifact.fields.includes('data'),
    'an artifact record must not inline its payload');
});

test('the artifact contract does not know what storage it sits on', () => {
  assert.match(AI_FOUNDATION.artifact.storageRule, /opaque/i);
});

test('context scopes are hierarchical and selectively loadable', () => {
  assert.deepEqual(CONTEXT_SCOPES, ['GLOBAL', 'WORKFLOW', 'NODE', 'EXECUTION', 'EVENT', 'AGENT', 'TASK']);
  assert.match(AI_FOUNDATION.context.selectiveLoadRule, /no mandatory load-everything/i);
});

test('context compaction is observable and checksum-chained', () => {
  assert.match(AI_FOUNDATION.context.compactionRule, /context\.compacted/);
  assert.ok(AI_FOUNDATION.context.fields.includes('checksum'));
});

/* ------------------------------------------ resources + zero install (§26,27) */

test('resource profiles include a low-resource target', () => {
  assert.deepEqual(AI_RESOURCE_PROFILES, ['low-resource', 'standard', 'high-resource', 'remote']);
  assert.match(AI_FOUNDATION.resourceProfiles.profiles['low-resource'], /Termux|phone/i);
});

test('no external runtime may become a local install requirement', () => {
  assert.match(AI_FOUNDATION.resourceProfiles.noLocalInstallRule, /never become a local installation requirement|No external runtime/i);
});

test('all five deployment shapes are supported', () => {
  assert.equal(AI_FOUNDATION.resourceProfiles.deploymentShapes.length, 5);
});

test('AI foundation with no provider configured is a valid state', () => {
  assert.equal(isZeroInstallState({}), true);
  assert.equal(isZeroInstallState({ modelProvider: 'not-configured' }), true);
  assert.equal(isZeroInstallState({ modelProvider: 'some-gateway' }), false);
  assert.equal(AI_FOUNDATION.zeroInstall.state.aiFoundation, 'ready');
});

test('zero-install reports honestly instead of faking inference', () => {
  assert.match(AI_FOUNDATION.zeroInstall.honestyRule, /never fake inference/i);
  assert.equal(AI_FOUNDATION.zeroInstall.reportedAs, "capability-unavailable with reason 'no inference provider configured'");
});

/* ----------------------------------------------------- MCP boundary (§28,29) */

test('MCP is an edge adapter, never the internal architecture', () => {
  assert.match(AI_FOUNDATION.mcp.rule, /adapter/i);
  assert.match(AI_FOUNDATION.mcp.internalRule, /No internal LEGO may call another LEGO over MCP/);
});

test('MCP maps onto the tool gateway, not the reverse', () => {
  assert.match(AI_FOUNDATION.mcp.mappingRule, /onto the tool gateway/i);
});

test('MCP capability export is explicit, never export-everything', () => {
  assert.match(AI_FOUNDATION.mcp.exportRule, /explicitly/i);
  assert.match(AI_FOUNDATION.mcp.exportRule, /no export-everything switch/i);
});

test('transport routing never forces HTTP between local LEGO', () => {
  assert.match(AI_FOUNDATION.transportRouting.prohibition, /Never force every call through HTTP/);
  const inProcess = AI_FOUNDATION.transportRouting.ladder.find((step) => step.when === 'same process');
  assert.equal(inProcess.transport, 'in-process');
});

test('a transport advertises what it carries and never downgrades a stream', () => {
  assert.deepEqual(AI_TRANSPORTS, ['in-process', 'worker', 'remote', 'mcp']);
  for (const transport of ['in-process', 'worker', 'remote']) {
    for (const interaction of COMMUNICATION_MODES) {
      assert.equal(transportCanCarry(transport, interaction), true,
        `'${transport}' should carry '${interaction}'`);
    }
  }
  // MCP has no native batch; the adapter must decompose it rather than pretend.
  assert.equal(transportCanCarry('mcp', 'batch'), false);
  assert.equal(transportCanCarry('mcp', 'call'), true);
  assert.match(AI_FOUNDATION.transportRouting.carryRule, /never silently downgrade/i);
});

/* ------------------------------------------------- contract-only proof (§14) */

test('the AI foundation is manager-owned, and only published registries are implemented', () => {
  // P2.14 DELIBERATE EDIT. P2.12 published the Skill registry; P2.13 publishes
  // the bounded Context & Session registries; P2.14 publishes the bounded Memory registry.
  // The explicit allow-list prevents a runtime/provider capability from becoming implemented accidentally.
  // P2.16 DELIBERATE EDIT. ai.agent-machine joins the allow-list as the bounded execution
  // FOUNDATION (identity, lifecycle, step bookkeeping, budgets, deterministic transitions,
  // provider/executor seam). It is not the agent loop: ai.agent-runtime above it stays
  // contract-only, and the AI set's agent-machine LEGO keeps its contract-only status.
  // P2.24 DELIBERATE EDIT. ai.token-usage joins as the bounded honest-accounting
  // REGISTRY (record/query/budget over injected time and identity). It computes no
  // provider call, fetches no price and settles nothing: ai.model-gateway above it
  // stays contract-only, and the AI set's token-usage LEGO keeps its in-progress
  // status — accounting being implemented says nothing about a runtime existing.
  const IMPLEMENTED = new Set(['ai.skill', 'ai.context', 'ai.agent-session', 'ai.memory', 'ai.agent-machine', 'ai.token-usage']);
  const domain = registry.byId.get('ai-foundation');
  assert.ok(domain, 'ai-foundation must be a registered domain');
  assert.equal(domain.owner, 'manager',
    'shared cross-domain contracts must be manager-owned, not owned by whoever wrote them first');
  assert.equal(domain.status, 'partial',
    'one capability is implemented and the rest are not: the status must say so');

  for (const capability of domain.capabilities) {
    if (IMPLEMENTED.has(capability.id)) {
      assert.equal(capability.status, 'implemented');
      assert.equal(capability.lifecycle, 'active');
      continue;
    }
    assert.equal(capability.status, 'contract-only', `'${capability.id}' must be contract-only`);
    assert.equal(capability.lifecycle, 'declared');
    assert.equal(capability.availability, 'optional-absent');
  }

  // The runtime capabilities specifically must remain unimplemented.
  for (const id of ['ai.model-gateway', 'ai.tool-gateway', 'ai.agent-runtime', 'ai.application-provider']) {
    const capability = domain.capabilities.find((entry) => entry.id === id);
    assert.equal(capability.status, 'contract-only', `${id} must never be quietly implemented`);
  }
});

test('the AI foundation depends only on the capability registry, and never on a feature domain', () => {
  // P2.12 DELIBERATE EDIT. It was a dependency-free leaf. The skill registry has
  // to ask the capability registry whether a skill's required capabilities are
  // DECLARED, and the alternative — keeping a second copy of the capability
  // list — is the drift this architecture exists to prevent. The edge is
  // one-way and to the foundation only; the original point of the rule, that
  // the AI foundation must never become a prerequisite for booting, is asserted
  // directly below rather than approximated by an empty list.
  const domain = registry.byId.get('ai-foundation');
  assert.deepEqual(domain.dependsOn, ['lego-foundation']);

  // No cycle: the capability registry must know nothing about AI.
  const foundation = registry.byId.get('lego-foundation');
  assert.equal((foundation.dependsOn ?? []).includes('ai-foundation'), false);

  // Still not a boot prerequisite: nothing on the boot path imports it.
  const server = readFileSync(join(APP_ROOT, 'src/server.mjs'), 'utf8');
  assert.equal(server.includes('ai-foundation'), false);
  assert.equal(server.includes('lego/skill'), false);
});

test('the AI foundation module performs no I/O beyond reading its own manifest', () => {
  const source = readFileSync(join(APP_ROOT, 'src/lego/ai-foundation.mjs'), 'utf8');
  for (const forbidden of ['fetch(', 'http.request', 'https.request', 'net.connect',
    'child_process', 'spawn(', 'exec(', 'WebSocket', 'setInterval(']) {
    assert.ok(!source.includes(forbidden),
      `the contract module must not contain '${forbidden}' — it is vocabulary, not a client`);
  }
  // It may read its own manifest, and nothing else.
  const reads = source.match(/readFileSync\([^)]*\)/g) ?? [];
  assert.equal(reads.length, 1, 'exactly one file read is expected: its own manifest');
  assert.match(reads[0], /ai-foundation\.json/);
});

test('no vendor SDK has been added as a dependency', () => {
  const pkg = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const vendor of ['openai', 'anthropic', '@anthropic-ai/sdk', 'composio', 'mcp',
    '@modelcontextprotocol/sdk', 'langchain', '9router']) {
    assert.ok(!deps.includes(vendor), `dependency '${vendor}' must not exist — this phase is contract-only`);
  }
});

test('the manifest states plainly what is not implemented', () => {
  assert.equal(AI_FOUNDATION.status, 'contract-only');
  assert.ok(AI_FOUNDATION.notImplemented.length >= 5);
  const text = AI_FOUNDATION.notImplemented.join(' ').toLowerCase();
  for (const claim of ['inference', 'mcp', 'agent runtime']) {
    assert.ok(text.includes(claim), `the honesty list must mention '${claim}'`);
  }
});

/* ------------------------------------------------ Rust stays a choice (§30) */

test('Rust remains an implementation choice under these contracts', () => {
  const policy = AI_FOUNDATION.rustPolicy;
  assert.match(policy.prohibition, /No Rust is written in this phase/);
  assert.match(policy.prohibition, /never require a compiler on an end-user device/);
  assert.match(policy.contractPreservation, /identical contract/);
  assert.ok(policy.justification.includes('latency') && policy.justification.includes('memory'));
});
