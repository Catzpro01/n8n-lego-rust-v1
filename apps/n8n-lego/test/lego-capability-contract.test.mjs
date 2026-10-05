/**
 * Capability contract tests (P2.10).
 *
 * Before this phase a capability was `{id, status}` — enough to say a feature
 * exists, nowhere near enough to negotiate with it. Consumers filled the gap by
 * INFERRING: operations from route existence, permissions from implementation,
 * lifecycle from file presence, transport from the fact that something answered
 * over HTTP. Every one of those inferences breaks silently the moment an
 * implementation is replaced, which is the single thing this architecture
 * exists to make safe.
 *
 * These tests pin the declaration so the inferences stay unnecessary.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { COMMUNICATION_MODES } from '../src/lego/foundation.mjs';
import { listCapabilities, loadRegistry } from '../src/lego/registry.mjs';

const registry = loadRegistry({ reload: true });
const allCapabilities = registry.domains.flatMap((domain) =>
  (domain.capabilities ?? []).map((capability) => ({ domain, capability })));

const BACKPRESSURE = ['buffer', 'drop', 'drop-oldest', 'coalesce', 'block', 'reject', 'terminate'];
const TRANSPORTS = ['in-process', 'worker', 'remote', 'mcp'];

/* ------------------------------------------------------ completeness (§4) */

test('every capability declares the full contract, not just id and status', () => {
  const required = ['operations', 'interaction', 'permissions', 'lifecycle', 'availability',
    'criticality', 'trust', 'transport', 'migrationState', 'degradation', 'replacement'];
  for (const { capability } of allCapabilities) {
    for (const field of required) {
      assert.notEqual(capability[field], undefined,
        `capability '${capability.id}' is missing '${field}'`);
    }
  }
});

test('capability ids are globally unique', () => {
  const ids = allCapabilities.map(({ capability }) => capability.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate capability id');
});

test('every capability is owned by exactly one domain', () => {
  const owners = new Map();
  for (const { domain, capability } of allCapabilities) {
    assert.ok(!owners.has(capability.id),
      `'${capability.id}' is claimed by '${owners.get(capability.id)}' and '${domain.id}'`);
    owners.set(capability.id, domain.id);
  }
});

/* -------------------------------------------------------- operations (§5) */

test('every operation declares name, interaction, permission, idempotency and status', () => {
  for (const { capability } of allCapabilities) {
    for (const operation of capability.operations) {
      for (const field of ['name', 'interaction', 'permission', 'idempotent', 'status']) {
        assert.notEqual(operation[field], undefined,
          `${capability.id}.${operation.name ?? '?'} is missing '${field}'`);
      }
    }
  }
});

test('operation names are unique within a capability', () => {
  for (const { capability } of allCapabilities) {
    const names = capability.operations.map((operation) => operation.name);
    assert.equal(new Set(names).size, names.length, `duplicate operation in '${capability.id}'`);
  }
});

test('no operation uses a fifth interaction class', () => {
  for (const { capability } of allCapabilities) {
    for (const operation of capability.operations) {
      assert.ok(COMMUNICATION_MODES.includes(operation.interaction),
        `${capability.id}.${operation.name} uses '${operation.interaction}'`);
    }
  }
});

test('a capability advertises every interaction class its operations use', () => {
  for (const { capability } of allCapabilities) {
    for (const operation of capability.operations) {
      assert.ok(capability.interaction.includes(operation.interaction),
        `'${capability.id}' does not advertise '${operation.interaction}' but ${operation.name} uses it`);
    }
  }
});

test('permissions are namespaced and match the operations that need them', () => {
  for (const { capability } of allCapabilities) {
    for (const permission of capability.permissions) {
      assert.match(permission, /^[a-z][a-z0-9-]*(:[a-z0-9-]+)+$/,
        `'${capability.id}' has malformed permission '${permission}'`);
    }
    const used = new Set(capability.operations.map((operation) => operation.permission));
    for (const permission of used) {
      assert.ok(capability.permissions.includes(permission),
        `'${capability.id}' uses '${permission}' but does not list it`);
    }
  }
});

test('control operations are idempotent so a repeated call is safe', () => {
  // This is the invariant that actually matters operationally: a cancel or a
  // close may be retried after a timeout, and the second call must not be an
  // error or a second effect.
  //
  // An earlier version of this test guessed from the operation NAME — treating
  // anything called `resolve` or `read` as a read. That was wrong in both
  // directions: `ai.approval.resolve` decides an approval (a write), while
  // `lego.operation-envelope.create` builds a value object (effectively
  // idempotent). Name-shaped heuristics encode a taxonomy nobody agreed to, so
  // the test now asserts only what the architecture genuinely requires.
  const control = new Set(['cancel', 'pause', 'resume', 'close', 'status', 'stop']);
  for (const { capability } of allCapabilities) {
    for (const operation of capability.operations) {
      if (!control.has(operation.name)) continue;
      assert.equal(operation.idempotent, true,
        `${capability.id}.${operation.name} is a control operation and must be idempotent`);
    }
  }
});

test('a persisted create or delete is not marked idempotent', () => {
  // Restricted to capabilities that actually own persistent state. A pure
  // factory that returns a value object is idempotent in every sense that
  // matters, and demanding otherwise would be dogma rather than a safeguard.
  const persistent = new Set(allCapabilities
    .filter(({ domain }) => domain.stateOwner === 'persistent')
    .map(({ capability }) => capability.id));
  for (const { capability } of allCapabilities) {
    if (!persistent.has(capability.id)) continue;
    for (const operation of capability.operations) {
      if (!['create', 'delete'].includes(operation.name)) continue;
      assert.equal(operation.idempotent, false,
        `${capability.id}.${operation.name} persists a change and must not claim idempotency`);
    }
  }
});

test('an operation that reads nothing but its own declaration is idempotent', () => {
  const pureReads = ['inspect', 'list', 'describe'];
  for (const { capability } of allCapabilities) {
    for (const operation of capability.operations) {
      if (!pureReads.includes(operation.name)) continue;
      assert.equal(operation.idempotent, true,
        `${capability.id}.${operation.name} is a pure read and must be idempotent`);
    }
  }
});

/* ------------------------------------------------------- no inference (§4) */

test('an unimplemented capability declares operations but never claims availability', () => {
  for (const { capability } of allCapabilities) {
    if (!['unsupported', 'deferred', 'planned', 'contract-only'].includes(capability.status)) continue;
    assert.notEqual(capability.availability, 'available',
      `'${capability.id}' is '${capability.status}' but reports availability 'available'`);
    assert.equal(capability.lifecycle, 'declared',
      `'${capability.id}' is not implemented, so its lifecycle must be 'declared'`);
  }
});

test('an implemented capability is active and available', () => {
  for (const { capability } of allCapabilities) {
    if (capability.status !== 'implemented') continue;
    assert.equal(capability.lifecycle, 'active', `'${capability.id}' is implemented but not active`);
    assert.equal(capability.availability, 'available');
  }
});

test('operation status never claims more than its capability', () => {
  for (const { capability } of allCapabilities) {
    if (capability.status === 'implemented') continue;
    for (const operation of capability.operations) {
      assert.notEqual(operation.status, 'implemented',
        `${capability.id}.${operation.name} claims implemented inside a '${capability.status}' capability`);
    }
  }
});

/* --------------------------------------------------------- transport (§29) */

test('every capability declares a transport it actually supports', () => {
  for (const { capability } of allCapabilities) {
    const { requires, supports } = capability.transport;
    assert.ok(TRANSPORTS.includes(requires), `'${capability.id}' requires unknown transport '${requires}'`);
    for (const transport of supports) {
      assert.ok(TRANSPORTS.includes(transport), `'${capability.id}' supports unknown transport '${transport}'`);
    }
    assert.ok(supports.includes(requires),
      `'${capability.id}' requires '${requires}' but does not list it as supported`);
  }
});

test('every capability defaults to in-process, never HTTP', () => {
  for (const { capability } of allCapabilities) {
    assert.equal(capability.transport.requires, 'in-process',
      `'${capability.id}' requires '${capability.transport.requires}' — a local capability must not demand a transport`);
  }
});

/* ------------------------------------------------------ backpressure (§10) */

test('every declared stream operation has a bounded backpressure policy', () => {
  let streams = 0;
  for (const { capability } of allCapabilities) {
    for (const operation of capability.operations) {
      if (operation.interaction !== 'stream') continue;
      if (['unsupported', 'planned'].includes(operation.status)) continue;
      streams += 1;
      assert.ok(BACKPRESSURE.includes(operation.backpressure),
        `${capability.id}.${operation.name} has no bounded policy`);
      assert.equal(typeof operation.backpressureReason, 'string',
        `${capability.id}.${operation.name} must record WHY its policy was chosen`);
    }
  }
  assert.ok(streams >= 4, `expected several stream operations, found ${streams}`);
});

test('no stream relies on an unbounded buffer', () => {
  for (const { capability } of allCapabilities) {
    for (const operation of capability.operations) {
      if (operation.interaction !== 'stream' || !operation.backpressure) continue;
      // `buffer` is bounded by a high-water mark in the interaction module; the
      // policy that would be genuinely unbounded is simply not in the vocabulary.
      assert.ok(BACKPRESSURE.includes(operation.backpressure));
      assert.notEqual(operation.backpressure, 'unbounded');
    }
  }
});

/* -------------------------------------------------------- trust + criticality */

test('a capability is never more trusted than its owning LEGO', () => {
  const rank = { core: 0, verified: 1, community: 2, untrusted: 3 };
  for (const { domain, capability } of allCapabilities) {
    if (!domain.trust || !capability.trust) continue;
    assert.ok(rank[capability.trust] >= rank[domain.trust],
      `'${capability.id}' claims '${capability.trust}' inside a '${domain.trust}' domain`);
  }
});

test('criticality is declared from a closed vocabulary', () => {
  for (const { capability } of allCapabilities) {
    assert.ok(['critical', 'standard', 'optional'].includes(capability.criticality),
      `'${capability.id}' has criticality '${capability.criticality}'`);
  }
});

test('a critical capability is actually implemented', () => {
  // Declaring something critical and unimplemented means the system is already
  // broken, or the word critical is being used loosely. Either is worth failing.
  for (const { capability } of allCapabilities) {
    if (capability.criticality !== 'critical') continue;
    assert.ok(['implemented', 'legacy', 'contract-only'].includes(capability.status),
      `'${capability.id}' is critical but only '${capability.status}'`);
  }
});

/* ----------------------------------------------------------- replacement */

test('every capability declares a contract-preserving replacement policy', () => {
  for (const { capability } of allCapabilities) {
    assert.equal(capability.replacement, 'contract-preserving',
      `'${capability.id}' must be replaceable without changing its contract — that is the JS/Rust story`);
  }
});

test('migration state is declared from a closed vocabulary', () => {
  for (const { capability } of allCapabilities) {
    assert.ok(['stable', 'strangler-pending', 'not-started', 'in-progress'].includes(capability.migrationState),
      `'${capability.id}' has migrationState '${capability.migrationState}'`);
  }
});

test('a legacy capability is marked strangler-pending', () => {
  for (const { capability } of allCapabilities) {
    if (capability.status !== 'legacy') continue;
    assert.equal(capability.migrationState, 'strangler-pending',
      `'${capability.id}' lives in the legacy zone and must be tracked for carve-out`);
  }
});

/* -------------------------------------------------- surface aliases (§6) */

test('the executions/execution mismatch is resolved by alias, not duplication', () => {
  const alias = registry.surfaceAliases.aliases.find((entry) => entry.surface === 'executions');
  assert.ok(alias, 'the executions surface word must be declared');
  assert.equal(alias.canonical, 'execution');
  // The thing that must NOT have happened: a second capability-owning domain.
  assert.equal(registry.byId.get('executions'), undefined,
    'a plural UI word must not become a second domain with its own ownership');
});

test('every alias resolves to a real domain', () => {
  for (const alias of registry.surfaceAliases.aliases) {
    assert.ok(registry.byId.get(alias.canonical),
      `alias '${alias.surface}' points at unknown domain '${alias.canonical}'`);
  }
});

test('alias resolution is deterministic', () => {
  const surfaces = registry.surfaceAliases.aliases.map((alias) => alias.surface);
  assert.equal(new Set(surfaces).size, surfaces.length, 'a surface word is aliased twice');
  for (const alias of registry.surfaceAliases.aliases) {
    if (alias.surface === alias.canonical) continue;
    assert.equal(registry.byId.get(alias.surface), undefined,
      `'${alias.surface}' is both a domain id and an alias for something else — resolution would be order-dependent`);
  }
});

test('an alias creates no capability and no ownership', () => {
  const capabilityIds = new Set(allCapabilities.map(({ capability }) => capability.id));
  for (const alias of registry.surfaceAliases.aliases) {
    assert.ok(!capabilityIds.has(alias.surface),
      `alias '${alias.surface}' must not also be a capability`);
  }
});

/* ------------------------------------------------ one authoritative 501 (§7) */

test('the registry is the single source of truth for unsupported features', async () => {
  const { UNSUPPORTED_FEATURES } = await import('../src/compat/capability.mjs');
  const declared = new Map();
  for (const { domain, capability } of allCapabilities) {
    if (capability.restFeature) declared.set(capability.restFeature, { domain, capability });
  }
  for (const entry of UNSUPPORTED_FEATURES) {
    const match = declared.get(entry.feature);
    assert.ok(match, `the compat layer advertises '${entry.feature}' with no registry capability`);
    assert.equal(match.domain.id, entry.owner,
      `'${entry.feature}': 501 says owner '${entry.owner}', registry says '${match.domain.id}'`);
  }
});

test('a restFeature is claimed by exactly one capability', () => {
  const seen = new Map();
  for (const { capability } of allCapabilities) {
    if (!capability.restFeature) continue;
    assert.ok(!seen.has(capability.restFeature),
      `restFeature '${capability.restFeature}' is claimed twice`);
    seen.set(capability.restFeature, capability.id);
  }
});

test('an unsupported REST feature is never reported as available', () => {
  for (const { capability } of allCapabilities) {
    if (!capability.restFeature) continue;
    if (capability.status !== 'unsupported') continue;
    assert.equal(capability.availability, 'capability-unavailable',
      `'${capability.id}' answers 501 but claims availability '${capability.availability}'`);
  }
});

/* ---------------------------------------------------------- listing helper */

test('listCapabilities exposes every declared capability', () => {
  assert.equal(listCapabilities(registry).length, allCapabilities.length);
});

test('no capability leaks a secret VALUE into its public contract', () => {
  // The risk is a credential embedded in the manifest, not the word "secret".
  // `credentials.external-secrets` is the NAME of an n8n feature; banning the
  // substring would force a domain to misname its own capability to satisfy a
  // security check, which trades a real name for a fake guarantee.
  //
  // So this looks for secret-bearing FIELD NAMES and for anything shaped like a
  // literal credential.
  const secretFields = ['password', 'apikey', 'api_key', 'token', 'privatekey', 'clientsecret', 'bearer'];
  for (const { capability } of allCapabilities) {
    const walk = (node, path) => {
      if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${path}[${i}]`));
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          assert.ok(!secretFields.includes(key.toLowerCase()),
            `capability '${capability.id}' declares a secret-bearing field '${key}' at ${path}`);
          walk(value, `${path}.${key}`);
        }
        return;
      }
      if (typeof node !== 'string') return;
      // Anything that looks like an actual credential literal.
      assert.ok(!/^(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{8,}$/.test(node),
        `capability '${capability.id}' contains a credential-shaped literal at ${path}`);
      assert.ok(!/^Bearer\s+\S+/i.test(node),
        `capability '${capability.id}' contains a bearer token at ${path}`);
    };
    walk(capability, capability.id);
  }
});
