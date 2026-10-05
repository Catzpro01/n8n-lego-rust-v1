/**
 * Communication foundation tests (P2.9).
 *
 * Covers the operation envelope, cancellation, the four interaction classes,
 * backpressure, capability negotiation, lifecycle and graceful degradation.
 *
 * The bar these tests hold: every guarantee the architecture *claims* must be
 * demonstrated by a mechanism, not by a document. Where a rule cannot fail,
 * there is a test that makes it fail.
 */
import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';

/** assert.throws() returns undefined; this captures the thrown error for inspection. */
function caught(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the function to throw, but it did not' });
}

import {
  CancellationError,
  ENVELOPE_FIELDS,
  boundaryRecord,
  createCancellableScope,
  createEnvelope,
  deriveEnvelope,
  deserializeEnvelope,
  isCancelled,
  remainingMs,
  serializeEnvelope,
  throwIfCancelled,
} from '../src/lego/envelope.mjs';
import {
  BACKPRESSURE_POLICIES,
  BackpressureError,
  DEGRADATION_STATES,
  INTERACTION_CLASSES,
  UnavailableError,
  applyBackpressure,
  batch,
  call,
  degradationFor,
  emit,
  getProvider,
  listProviders,
  registerProvider,
  resetProviders,
  resetSubscribers,
  stream,
  subscribe,
} from '../src/lego/interaction.mjs';
import {
  LIFECYCLE_STATES,
  LIFECYCLE_TRANSITIONS,
  canTransitionLifecycle,
  describeCapability,
  discoverFor,
  getLifecycleState,
  isCallable,
  negotiate,
  resetLifecycleStates,
  setLifecycleState,
} from '../src/lego/negotiation.mjs';
import { loadRegistry } from '../src/lego/registry.mjs';

afterEach(() => {
  resetProviders();
  resetSubscribers();
  resetLifecycleStates();
});

/* ------------------------------------------------------------------ envelope */

test('the envelope carries every declared field', () => {
  const envelope = createEnvelope({ legoId: 'workflow', operation: 'get' });
  for (const field of ENVELOPE_FIELDS) assert.ok(field in envelope, `envelope is missing '${field}'`);
});

test('a root call starts its own correlation', () => {
  const envelope = createEnvelope({ legoId: 'a', operation: 'b' });
  assert.equal(envelope.correlationId, envelope.requestId);
});

test('a derived envelope inherits correlation but gets a fresh request id', () => {
  const parent = createEnvelope({ legoId: 'a', operation: 'b' });
  const child = deriveEnvelope(parent, { legoId: 'c', operation: 'd' });
  assert.equal(child.correlationId, parent.correlationId);
  assert.notEqual(child.requestId, parent.requestId);
});

test('a child may not outlive its parent deadline', () => {
  const parent = createEnvelope({ legoId: 'a', operation: 'b', timeoutMs: 50 });
  const child = deriveEnvelope(parent, { legoId: 'c', operation: 'd', timeoutMs: 100_000 });
  assert.equal(child.deadline, parent.deadline, 'a greedy child must be clamped to the parent deadline');
});

test('a child may ask for less time than its parent', () => {
  const parent = createEnvelope({ legoId: 'a', operation: 'b', timeoutMs: 100_000 });
  const child = deriveEnvelope(parent, { legoId: 'c', operation: 'd', timeoutMs: 10 });
  assert.ok(child.deadline < parent.deadline);
});

test('an envelope with no deadline stays unbounded rather than inventing one', () => {
  const envelope = createEnvelope({ legoId: 'a', operation: 'b' });
  assert.equal(envelope.deadline, null);
  assert.equal(remainingMs(envelope), null);
});

test('the envelope is frozen — a callee cannot rewrite its own context', () => {
  const envelope = createEnvelope({ legoId: 'a', operation: 'b' });
  assert.throws(() => {
    envelope.actor = { admin: true };
  }, TypeError);
});

test('creating an envelope requires an identity', () => {
  assert.throws(() => createEnvelope({ operation: 'x' }), /legoId/);
  assert.throws(() => createEnvelope({ legoId: 'x' }), /operation/);
});

test('the envelope carries no secret material', () => {
  const envelope = createEnvelope({ legoId: 'a', operation: 'b', actor: { id: 'u1', scopes: ['workflow:read'] } });
  const serialized = JSON.stringify(envelope);
  for (const forbidden of ['password', 'token', 'secret', 'apiKey', 'credential']) {
    assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()), `envelope leaked '${forbidden}'`);
  }
});

/* -------------------------------------------------------------- cancellation */

test('cancellation is explicit and produces a distinguishable error', () => {
  const scope = createCancellableScope({ legoId: 'execution', operation: 'run' });
  scope.cancel('user pressed stop');
  const error = caught(() => throwIfCancelled(scope.envelope));
  assert.ok(error instanceof CancellationError);
  assert.equal(error.code, 'lego.cancelled');
  assert.equal(error.retryable, false, 'a deliberate cancellation is not retryable');
});

test('a passed deadline is reported as a deadline, not a generic cancellation', () => {
  const envelope = createEnvelope({ legoId: 'a', operation: 'b', deadline: Date.now() - 1 });
  const error = caught(() => throwIfCancelled(envelope));
  assert.equal(error.code, 'lego.deadline_exceeded');
  assert.equal(error.retryable, true, 'a timeout may be worth retrying; an explicit cancel is not');
});

test('cancellation is idempotent', () => {
  const scope = createCancellableScope({ legoId: 'a', operation: 'b' });
  scope.cancel();
  scope.cancel();
  scope.cancel();
  assert.equal(isCancelled(scope.envelope), true);
  const first = caught(() => throwIfCancelled(scope.envelope));
  const second = caught(() => throwIfCancelled(scope.envelope));
  assert.equal(first.code, second.code);
});

test('cancelling a parent propagates to a derived child', () => {
  const scope = createCancellableScope({ legoId: 'execution', operation: 'run' });
  const child = deriveEnvelope(scope.envelope, { legoId: 'workflow', operation: 'step' });
  assert.equal(isCancelled(child), false);
  scope.cancel('stop');
  assert.equal(isCancelled(child), true, 'a cancelled parent must not leave children running');
});

test('a child scope inherits an already-cancelled parent immediately', () => {
  const parent = createCancellableScope({ legoId: 'a', operation: 'b' });
  parent.cancel();
  const child = createCancellableScope({ legoId: 'c', operation: 'd', signal: parent.envelope.signal });
  assert.equal(isCancelled(child.envelope), true);
});

test('an uncancelled operation reports no cancellation', () => {
  const scope = createCancellableScope({ legoId: 'a', operation: 'b', timeoutMs: 60_000 });
  assert.equal(isCancelled(scope.envelope), false);
  assert.doesNotThrow(() => throwIfCancelled(scope.envelope));
  scope.dispose();
});

test('a cancelled call never dispatches', async () => {
  let invoked = false;
  registerProvider({ legoId: 'slow', contractVersion: '1.0.0', operations: { work: () => { invoked = true; } } });
  const scope = createCancellableScope({ legoId: 'slow', operation: 'work' });
  scope.cancel();
  await assert.rejects(() => call('slow', 'work', {}, scope.envelope), /cancelled/);
  assert.equal(invoked, false, 'a cancelled caller must not start new work');
});

/* ---------------------------------------------------------------- transport */

test('serializing an envelope drops the signal and says so', () => {
  const scope = createCancellableScope({ legoId: 'a', operation: 'b' });
  const wire = serializeEnvelope(scope.envelope);
  assert.ok(!('signal' in wire), 'an AbortSignal cannot cross a process boundary');
  assert.equal(wire.cancellable, false, 'the far side must know it needs its own cancellation channel');
});

test('an envelope round-trips across a boundary as plain JSON', () => {
  const envelope = createEnvelope({ legoId: 'a', operation: 'b', actor: { id: 'u1' }, timeoutMs: 1000 });
  const restored = deserializeEnvelope(JSON.parse(JSON.stringify(serializeEnvelope(envelope))));
  assert.equal(restored.requestId, envelope.requestId);
  assert.equal(restored.correlationId, envelope.correlationId);
  assert.equal(restored.deadline, envelope.deadline);
  assert.deepEqual(restored.actor, envelope.actor);
});

test('the boundary record captures identity, timing and outcome — and nothing else', () => {
  const envelope = createEnvelope({ legoId: 'workflow', operation: 'get', contractVersion: '1.0.0' });
  const record = boundaryRecord(envelope, { status: 'ok', durationMs: 4, implementation: 'js', source: 'legacy-rest' });
  assert.deepEqual(Object.keys(record).sort(), [
    'contractVersion', 'correlationId', 'durationMs', 'errorCode', 'implementation',
    'legoId', 'operation', 'requestId', 'sourceLegoId', 'status', 'traceId',
  ]);
  assert.ok(!('payload' in record), 'observability records must never carry payloads');
});

/* ------------------------------------------------------- interaction classes */

test('there are exactly four interaction classes', () => {
  assert.deepEqual([...INTERACTION_CLASSES].sort(), ['batch', 'call', 'event', 'stream']);
});

test('CALL dispatches in-process with no serialization', async () => {
  const seen = [];
  registerProvider({
    legoId: 'node-registry',
    contractVersion: '1.0.0',
    operations: { resolve: (payload, envelope) => { seen.push(payload); return { type: payload.type, envelope: envelope.operation }; } },
  });
  const payload = { type: 'httpRequest' };
  const result = await call('node-registry', 'resolve', payload);
  assert.equal(result.type, 'httpRequest');
  assert.equal(seen[0], payload, 'the payload must arrive by reference, not as a copy');
});

test('calling an unregistered LEGO fails with a machine-readable code', async () => {
  const error = await call('nope', 'x', {}).catch((caught) => caught);
  assert.ok(error instanceof UnavailableError);
  assert.equal(error.code, 'lego.capability_unavailable');
});

test('calling an unknown operation is distinguishable from an unknown LEGO', async () => {
  registerProvider({ legoId: 'demo', contractVersion: '1.0.0', operations: { a: () => 1 } });
  const error = await call('demo', 'b', {}).catch((caught) => caught);
  assert.equal(error.code, 'lego.operation_unsupported');
});

test('invoking a STREAM operation as a CALL is rejected', async () => {
  registerProvider({
    legoId: 'demo',
    contractVersion: '1.0.0',
    operations: { ticks: { interaction: 'stream', backpressure: { policy: 'drop' }, handler: async function* () { yield 1; } } },
  });
  const error = await call('demo', 'ticks', {}).catch((caught) => caught);
  assert.equal(error.code, 'lego.interaction_mismatch');
});

test('EVENT is fire-and-forget and survives a throwing subscriber', () => {
  const errors = [];
  subscribe('execution.finished', () => { throw new Error('audit listener exploded'); });
  let secondRan = false;
  subscribe('execution.finished', () => { secondRan = true; });

  const result = emit('execution.finished', { id: 1 }, null, { onError: (error) => errors.push(error) });

  assert.equal(result.delivered, 2);
  assert.equal(secondRan, true, 'one bad subscriber must not starve the others');
  assert.equal(errors.length, 1, 'the failure is reported, not swallowed and not thrown at the emitter');
});

test('EVENT with no subscribers is a no-op, not an error', () => {
  assert.deepEqual(emit('nobody.listening', {}), { delivered: 0 });
});

test('EVENT is not delivered for a cancelled operation', () => {
  let delivered = false;
  subscribe('topic', () => { delivered = true; });
  const scope = createCancellableScope({ legoId: 'a', operation: 'b' });
  scope.cancel();
  emit('topic', {}, scope.envelope);
  assert.equal(delivered, false);
});

test('unsubscribing actually stops delivery', () => {
  let count = 0;
  const off = subscribe('t', () => { count += 1; });
  emit('t', {});
  off();
  emit('t', {});
  assert.equal(count, 1);
});

test('STREAM yields items in order', async () => {
  registerProvider({
    legoId: 'execution',
    contractVersion: '1.0.0',
    operations: { output: { interaction: 'stream', backpressure: { policy: 'buffer' }, handler: async function* () { yield 'a'; yield 'b'; yield 'c'; } } },
  });
  const seen = [];
  for await (const item of stream('execution', 'output', {})) seen.push(item);
  assert.deepEqual(seen, ['a', 'b', 'c']);
});

test('cancelling a STREAM stops the producer and runs its cancel hook', async () => {
  let produced = 0;
  let cancelled = false;
  registerProvider({
    legoId: 'execution',
    contractVersion: '1.0.0',
    operations: {
      output: {
        interaction: 'stream',
        backpressure: { policy: 'buffer' },
        onCancel: () => { cancelled = true; },
        handler: async function* () {
          while (true) { produced += 1; yield produced; }
        },
      },
    },
  });

  const scope = createCancellableScope({ legoId: 'execution', operation: 'output' });
  const seen = [];
  await assert.rejects(async () => {
    for await (const item of stream('execution', 'output', {}, scope.envelope)) {
      seen.push(item);
      if (seen.length === 3) scope.cancel('enough');
    }
  }, CancellationError);

  assert.equal(seen.length, 3);
  assert.equal(cancelled, true, 'a stopped consumer must stop the producer');
  assert.ok(produced < 10, `producer kept running after cancellation (produced ${produced})`);
});

test('a STREAM operation must declare a backpressure policy', () => {
  assert.throws(
    () => registerProvider({ legoId: 'x', operations: { s: { interaction: 'stream', handler: () => {} } } }),
    /must declare a backpressure policy/,
  );
});

test('BATCH reports per-item outcomes instead of failing wholesale', async () => {
  registerProvider({
    legoId: 'node-registry',
    contractVersion: '1.0.0',
    operations: {
      resolveMany: {
        interaction: 'batch',
        handler: (item) => {
          if (item === 'bad') throw new Error('unknown node');
          return `resolved:${item}`;
        },
      },
    },
  });
  const results = await batch('node-registry', 'resolveMany', ['a', 'bad', 'c']);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(results[1].index, 1, 'the caller must learn WHICH item failed');
  assert.equal(results[2].value, 'resolved:c', 'one bad item must not discard good work');
});

test('an atomic BATCH fails fast', async () => {
  registerProvider({
    legoId: 'demo',
    contractVersion: '1.0.0',
    operations: { many: { interaction: 'batch', handler: (item) => { if (item === 2) throw new Error('nope'); return item; } } },
  });
  await assert.rejects(() => batch('demo', 'many', [1, 2, 3], undefined, { atomic: true }), /nope/);
});

test('a cancelled BATCH stops processing further items', async () => {
  const processed = [];
  registerProvider({
    legoId: 'demo',
    contractVersion: '1.0.0',
    operations: { many: { interaction: 'batch', handler: (item) => { processed.push(item); return item; } } },
  });
  const scope = createCancellableScope({ legoId: 'demo', operation: 'many' });
  scope.cancel();
  const results = await batch('demo', 'many', [1, 2, 3], scope.envelope).catch(() => null);
  assert.equal(processed.length, 0, 'nothing should be processed after cancellation');
  assert.ok(results === null || results.every((result) => result.status === 'cancelled'));
});

/* ------------------------------------------------------------- backpressure */

test('every backpressure policy is documented', () => {
  for (const policy of ['buffer', 'drop', 'drop-oldest', 'coalesce', 'block', 'reject', 'terminate']) {
    assert.ok(policy in BACKPRESSURE_POLICIES, `missing policy ${policy}`);
  }
});

test('drop sheds the newest item when full', () => {
  const bp = applyBackpressure({ policy: 'drop', highWaterMark: 2 });
  bp.push(1); bp.push(2);
  assert.equal(bp.push(3).accepted, false);
  assert.deepEqual(bp.drain(), [1, 2]);
  assert.equal(bp.stats.dropped, 1);
});

test('drop-oldest keeps the freshest state', () => {
  const bp = applyBackpressure({ policy: 'drop-oldest', highWaterMark: 2 });
  bp.push(1); bp.push(2); bp.push(3);
  assert.deepEqual(bp.drain(), [2, 3]);
});

test('coalesce merges rather than discards', () => {
  const bp = applyBackpressure({ policy: 'coalesce', highWaterMark: 1, coalesce: (a, b) => a + b });
  bp.push(1); bp.push(2); bp.push(3);
  assert.deepEqual(bp.drain(), [6]);
  assert.equal(bp.stats.coalesced, 2);
});

test('reject raises a retryable backpressure error', () => {
  const bp = applyBackpressure({ policy: 'reject', highWaterMark: 1, legoId: 'x', operation: 'y' });
  bp.push(1);
  const error = caught(() => bp.push(2));
  assert.ok(error instanceof BackpressureError);
  assert.equal(error.code, 'lego.backpressure');
  assert.equal(error.retryable, true);
});

test('terminate ends the stream and stays ended', () => {
  const bp = applyBackpressure({ policy: 'terminate', highWaterMark: 1 });
  bp.push(1);
  assert.throws(() => bp.push(2));
  assert.equal(bp.push(3).action, 'terminated');
});

test('an unknown backpressure policy is rejected at declaration time', () => {
  assert.throws(() => applyBackpressure({ policy: 'pray' }), /unknown backpressure policy/);
  assert.throws(
    () => registerProvider({ legoId: 'x', operations: { s: { interaction: 'stream', backpressure: { policy: 'pray' }, handler: () => {} } } }),
    /unknown backpressure policy/,
  );
});

/* ------------------------------------------------------------------ lifecycle */

test('all eleven lifecycle states exist', () => {
  for (const state of ['declared', 'available', 'installed', 'loaded', 'active', 'idle', 'unloaded', 'disabled', 'failed', 'degraded', 'deprecated']) {
    assert.ok(state in LIFECYCLE_STATES, `missing lifecycle state ${state}`);
  }
});

test('only active, idle, degraded and deprecated are callable', () => {
  const callable = Object.keys(LIFECYCLE_STATES).filter(isCallable).sort();
  assert.deepEqual(callable, ['active', 'degraded', 'deprecated', 'idle']);
});

test('lifecycle transitions are enforced', () => {
  assert.equal(canTransitionLifecycle('available', 'loaded').allowed, true);
  assert.equal(canTransitionLifecycle('loaded', 'active').allowed, true);
  assert.equal(canTransitionLifecycle('declared', 'active').allowed, false, 'a declared LEGO cannot skip straight to active');
  assert.equal(canTransitionLifecycle('unloaded', 'active').allowed, false);
});

test('an unknown lifecycle state is rejected, not tolerated', () => {
  assert.equal(canTransitionLifecycle('vibing', 'active').allowed, false);
  assert.equal(canTransitionLifecycle('active', 'vibing').allowed, false);
});

test('every transition target is itself a declared state', () => {
  for (const [from, targets] of Object.entries(LIFECYCLE_TRANSITIONS)) {
    assert.ok(from in LIFECYCLE_STATES, `transition table has unknown source '${from}'`);
    for (const to of targets) assert.ok(to in LIFECYCLE_STATES, `'${from}' can transition to unknown state '${to}'`);
  }
});

test('an illegal runtime transition throws rather than silently correcting', () => {
  setLifecycleState('demo', 'available');
  assert.throws(() => setLifecycleState('demo', 'active'), /illegal lifecycle transition/);
  assert.equal(getLifecycleState('demo'), 'available', 'a rejected transition must not mutate state');
});

test('a LEGO starts as declared', () => {
  assert.equal(getLifecycleState('never-seen'), 'declared');
});

test('failure and disablement are different states', () => {
  assert.notEqual(LIFECYCLE_STATES.failed.summary, LIFECYCLE_STATES.disabled.summary);
  assert.equal(isCallable('failed'), false);
  assert.equal(isCallable('disabled'), false);
});

/* ------------------------------------------------- capability negotiation */

const registry = loadRegistry({ reload: true });

test('an unknown capability negotiates to a clear failure', () => {
  const result = negotiate({ consumer: 'settings', capability: 'does.not.exist' }, registry);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'lego.capability_unavailable');
});

test('describing a capability reports owner, domain and lifecycle', () => {
  const description = describeCapability('kernel.config', registry);
  assert.equal(description.found, true);
  assert.equal(description.domain, 'platform-kernel');
  assert.equal(description.owner, 'manager');
  assert.ok('lifecycle' in description && 'callable' in description && 'degradation' in description);
});

test('a capability with no registered provider is not callable', () => {
  const result = negotiate({ consumer: 'settings', capability: 'kernel.config' }, registry);
  assert.equal(result.ok, false, 'nothing is registered at runtime in this test process');
  assert.equal(result.description.callable, false);
});

test('an undeclared consumer is denied access before anything else is revealed', () => {
  // workflow never declared a dependency on auth.identity.
  const result = negotiate({ consumer: 'workflow', capability: 'auth.identity-projection' }, registry);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'lego.access_denied');
});

test('nesting does not grant access to a nested capability', () => {
  // The rule that matters: being allowed to depend on a parent is not
  // permission to reach the children it composes.
  const result = negotiate({ consumer: 'legacy-rest', capability: 'auth.identity-projection' }, registry);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'lego.access_denied');
  assert.match(result.reason, /nesting does not grant access|may not use/);
});

test('a declared consumer passes the access check', () => {
  const result = negotiate({ consumer: 'compatibility', capability: 'auth.identity-projection' }, registry);
  // Access is granted; it then fails only because no provider is registered at runtime.
  assert.notEqual(result.code, 'lego.access_denied');
});

test('version incompatibility is reported distinctly from absence', () => {
  registerProvider({ legoId: 'platform-kernel', contractVersion: '1.0.0', operations: { read: () => ({}) } });
  setLifecycleState('platform-kernel', 'available');
  setLifecycleState('platform-kernel', 'loaded');
  setLifecycleState('platform-kernel', 'active');

  const ok = negotiate({ consumer: 'compatibility', capability: 'kernel.config', requires: '^1.0.0' }, registry);
  assert.equal(ok.ok, true, ok.reason);

  const bad = negotiate({ consumer: 'compatibility', capability: 'kernel.config', requires: '^2.0.0' }, registry);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'lego.version_incompatible');
});

test('a required operation that does not exist is reported by name', () => {
  registerProvider({ legoId: 'platform-kernel', contractVersion: '1.0.0', operations: { read: () => ({}) } });
  setLifecycleState('platform-kernel', 'available');
  setLifecycleState('platform-kernel', 'loaded');
  setLifecycleState('platform-kernel', 'active');

  const result = negotiate({ consumer: 'compatibility', capability: 'kernel.config', operations: ['read', 'write'] }, registry);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'lego.operation_unsupported');
  assert.deepEqual(result.missing, ['write']);
});

test('a disabled dependency is distinguishable from a missing one', () => {
  registerProvider({ legoId: 'platform-kernel', contractVersion: '1.0.0', operations: { read: () => ({}) } });
  setLifecycleState('platform-kernel', 'available');
  setLifecycleState('platform-kernel', 'loaded');
  setLifecycleState('platform-kernel', 'disabled');

  const result = negotiate({ consumer: 'compatibility', capability: 'kernel.config' }, registry);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'lego.dependency_disabled');
});

test('discovery lists only what a consumer may actually see', () => {
  const visible = discoverFor('compatibility', registry);
  assert.ok(visible.length > 0);
  for (const entry of visible) {
    assert.ok('capability' in entry && 'usable' in entry && 'owner' in entry && 'lifecycle' in entry);
  }
});

test('the provider registry reports transport and implementation', () => {
  registerProvider({ legoId: 'demo', contractVersion: '2.1.0', operations: { a: () => 1 }, implementation: 'js', transport: 'in-process' });
  const [entry] = listProviders();
  assert.equal(entry.implementation, 'js');
  assert.equal(entry.transport, 'in-process');
  assert.equal(entry.contractVersion, '2.1.0');
  assert.deepEqual(entry.operations, ['a']);
});

test('replacing an implementation leaves the consumer untouched', async () => {
  // The replacement story, mechanically: same contract, same call site, two
  // different implementations. This is what ADR-0001 and ADR-0005 rest on.
  const consumer = () => call('hasher', 'hash', 'abc');

  registerProvider({ legoId: 'hasher', contractVersion: '1.0.0', implementation: 'js', operations: { hash: (input) => `js:${input}` } });
  assert.equal(await consumer(), 'js:abc');

  registerProvider({ legoId: 'hasher', contractVersion: '1.0.0', implementation: 'rust-simulated', operations: { hash: (input) => `native:${input}` } });
  assert.equal(await consumer(), 'native:abc');

  assert.equal(getProvider('hasher').implementation, 'rust-simulated');
});

/* ------------------------------------------------------------- degradation */

test('all eight degradation states are declared with an action', () => {
  for (const state of ['available', 'degraded', 'capability-unavailable', 'optional-absent', 'version-incompatible', 'dependency-disabled', 'migration-required', 'feature-unsupported']) {
    assert.ok(state in DEGRADATION_STATES, `missing degradation state ${state}`);
    assert.ok(DEGRADATION_STATES[state].action.length > 0);
  }
});

test('an absent optional dependency is explicitly not an error', () => {
  const state = degradationFor('optional-absent');
  assert.equal(state.usable, false);
  assert.match(state.action, /not an error/);
});

test('version incompatibility must never silently adapt', () => {
  assert.match(degradationFor('version-incompatible').action, /never silently adapt/);
});

test('an unknown degradation state is rejected', () => {
  assert.throws(() => degradationFor('mostly-fine'), /unknown degradation state/);
});
