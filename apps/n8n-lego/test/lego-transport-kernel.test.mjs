import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KERNEL_LIMITS,
  KernelViolationError,
  validateEnvelope,
  encodeMessage,
  decodeMessage,
} from '../src/lego/transport-kernel.mjs';
import {
  createEnvelope,
  deriveEnvelope,
  serializeEnvelope,
  remainingMs,
  isCancelled,
} from '../src/lego/envelope.mjs';
import {
  BACKPRESSURE_POLICIES,
  BATCH_LIMITS,
  applyBackpressure,
  registerProvider,
  batch,
  stream,
  BackpressureError,
} from '../src/lego/interaction.mjs';

const caught = (block) => {
  try {
    block();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw, got none');
};
/* ------------------------------------------------------------ declared bounds */

test('KERNEL_LIMITS is frozen and every bound is a positive integer ceiling', () => {
  assert.ok(Object.isFrozen(KERNEL_LIMITS));
  assert.ok(Number.isInteger(KERNEL_LIMITS.maxMessageBytes) && KERNEL_LIMITS.maxMessageBytes > 0);
  assert.ok(Number.isInteger(KERNEL_LIMITS.maxIdLength) && KERNEL_LIMITS.maxIdLength > 0);
  assert.ok(Number.isInteger(KERNEL_LIMITS.maxJsonDepth) && KERNEL_LIMITS.maxJsonDepth > 1);
  assert.throws(() => { KERNEL_LIMITS.maxMessageBytes = 1; }, TypeError);
});

test('the kernel raises the published lego.contract_violation code — no new error contract', () => {
  const error = caught(() => decodeMessage('not-json'));
  assert.ok(error instanceof KernelViolationError);
  assert.equal(error.code, 'lego.contract_violation');
  assert.equal(error.retryable, false);
});

/* --------------------------------------------------- 1. round-trip determinism */

test('the same logical message always encodes to the same string (key order is irrelevant)', () => {
  const envelope = createEnvelope({ legoId: 'workflow', operation: 'run', actor: { id: 'u1', scopes: ['w'] }, timeoutMs: 5000 });
  const payload = { a: 1, nested: { z: true, m: 'x' }, list: [1, 2, 3] };

  const reorderedEnvelope = {
    operation: envelope.operation,
    legoId: envelope.legoId,
    requestId: envelope.requestId,
    correlationId: envelope.correlationId,
    causationId: envelope.causationId,
    traceId: envelope.traceId,
    contractVersion: envelope.contractVersion,
    actor: envelope.actor,
    scope: envelope.scope,
    deadline: envelope.deadline,
    idempotencyKey: envelope.idempotencyKey,
  };
  const reorderedPayload = { list: [1, 2, 3], nested: { m: 'x', z: true }, a: 1 };

  const first = encodeMessage(envelope, payload);
  const second = encodeMessage(reorderedEnvelope, reorderedPayload);
  assert.equal(first, second, 'canonical encoding must ignore input key order');
});

test('decode(encode(x)) is a fixed point — round-tripping twice yields the identical string', () => {
  const envelope = createEnvelope({ legoId: 'a', operation: 'b', timeoutMs: 1000 });
  const payload = { n: 42, s: 'text', b: false, nil: null, arr: [1, { deep: true }] };
  const wire = encodeMessage(envelope, payload);
  const once = decodeMessage(wire);
  const twice = encodeMessage(once.envelope, once.payload);
  assert.equal(twice, wire, 'encode ∘ decode ∘ encode must be a fixed point');
  assert.deepEqual(once.payload, payload);
});

test('a round trip preserves every identity and timing field', () => {
  const envelope = createEnvelope({
    legoId: 'router',
    operation: 'inspect',
    contractVersion: '9.9.9',
    actor: { id: 'u9', scopes: ['scope:x'] },
    scope: { tenant: 't1' },
    timeoutMs: 7777,
    idempotencyKey: 'idem-123',
  });
  const restored = decodeMessage(encodeMessage(envelope, { ok: true })).envelope;
  assert.equal(restored.legoId, envelope.legoId);
  assert.equal(restored.operation, envelope.operation);
  assert.equal(restored.contractVersion, envelope.contractVersion);
  assert.equal(restored.requestId, envelope.requestId);
  assert.equal(restored.correlationId, envelope.correlationId);
  assert.equal(restored.causationId, envelope.causationId);
  assert.equal(restored.traceId, envelope.traceId);
  assert.equal(restored.deadline, envelope.deadline);
  assert.equal(restored.idempotencyKey, envelope.idempotencyKey);
  assert.deepEqual(restored.actor, envelope.actor);
  assert.deepEqual(restored.scope, envelope.scope);
});

/* --------------------------------------------- 2. malformed is rejected (closed) */

test('truncated or non-object JSON is refused, never repaired', () => {
  const wire = encodeMessage(createEnvelope({ legoId: 'a', operation: 'b' }), {});
  assert.throws(() => decodeMessage(wire.slice(0, wire.length - 5)), /malformed message/);
  assert.throws(() => decodeMessage('null'), /malformed message/);
  assert.throws(() => decodeMessage('[1,2,3]'), /malformed message/);
  assert.throws(() => decodeMessage('"just a string"'), /malformed message/);
});

test('a message missing envelope or payload is refused', () => {
  assert.throws(() => decodeMessage('{"envelope":{}}'), /both envelope and payload/);
  assert.throws(() => decodeMessage('{"payload":1}'), /both envelope and payload/);
  assert.throws(() => decodeMessage('{"envelope":{},"payload":1,"extra":2}'), /unknown top-level field/);
});

test('an envelope with a missing, mistyped or unknown field is refused', () => {
  const envelope = createEnvelope({ legoId: 'a', operation: 'b' });
  const wire = JSON.parse(encodeMessage(envelope, {}));
  const without = { ...wire.envelope };
  delete without.correlationId;
  assert.throws(() => decodeMessage(JSON.stringify({ envelope: without, payload: {} })), /missing 'correlationId'/);

  assert.throws(() => decodeMessage(JSON.stringify({
    envelope: { ...wire.envelope, deadline: 'tomorrow' },
    payload: {},
  })), /deadline must be/);

  assert.throws(() => decodeMessage(JSON.stringify({
    envelope: { ...wire.envelope, surprise: 1 },
    payload: {},
  })), /unknown field 'surprise'/);

  assert.throws(() => decodeMessage(JSON.stringify({
    envelope: { ...wire.envelope, requestId: 42 },
    payload: {},
  })), /requestId/);

  assert.throws(() => decodeMessage(JSON.stringify({
    envelope: { ...wire.envelope, requestId: 'x'.repeat(KERNEL_LIMITS.maxIdLength + 1) },
    payload: {},
  })), /at most 128 characters/);
});

test('an AbortSignal never crosses the wire, even when smuggled in', () => {
  const envelope = createEnvelope({ legoId: 'a', operation: 'b' });
  const wire = JSON.parse(encodeMessage(envelope, {}));
  wire.envelope.signal = 'fake';
  assert.throws(() => decodeMessage(JSON.stringify(wire)), /must not carry a signal/);
});

test('lossy payloads are refused instead of silently changed', () => {
  const envelope = createEnvelope({ legoId: 'a', operation: 'b' });
  assert.throws(() => encodeMessage(envelope, { fn: () => 1 }), /plain JSON values/);
  assert.throws(() => encodeMessage(envelope, { when: new Date() }), /non-plain object/);
  assert.throws(() => encodeMessage(envelope, { big: 1n }), /plain JSON values/);
  assert.throws(() => encodeMessage(envelope, { bad: Number.NaN }), /non-finite/);
  assert.throws(() => encodeMessage(envelope, { bad: Number.POSITIVE_INFINITY }), /non-finite/);
  const circular = { name: 'root' };
  circular.self = circular;
  assert.throws(() => encodeMessage(envelope, circular), /circular/);
  const u = { undefinedish: undefined };
  assert.throws(() => encodeMessage(envelope, u), /plain JSON values/);
});

test('payloads deeper than the declared ceiling are refused — the validator itself is bounded', () => {
  const envelope = createEnvelope({ legoId: 'a', operation: 'b' });
  let deep = { leaf: true };
  for (let i = 0; i <= KERNEL_LIMITS.maxJsonDepth + 2; i += 1) deep = { down: deep };
  assert.throws(() => encodeMessage(envelope, deep), /maxJsonDepth/);
});

test('an oversize message is refused on both encode and decode', () => {
  const envelope = createEnvelope({ legoId: 'a', operation: 'b' });
  const big = 'x'.repeat(KERNEL_LIMITS.maxMessageBytes + 100);
  assert.throws(() => encodeMessage(envelope, { big }), /maxMessageBytes/);

  const overflowText = JSON.stringify({ envelope: serializeEnvelope(envelope), payload: { big } });
  assert.ok(overflowText.length > KERNEL_LIMITS.maxMessageBytes);
  assert.throws(() => decodeMessage(overflowText), /maxMessageBytes/);
});

test('validateEnvelope is the reusable entry gate with the same fail-closed rules', () => {
  const wire = serializeEnvelope(createEnvelope({ legoId: 'a', operation: 'b' }));
  assert.deepEqual(validateEnvelope(wire), wire, 'a valid wire envelope passes through unchanged');
  assert.throws(() => validateEnvelope(null), /plain object/);
  assert.throws(() => validateEnvelope({ ...wire, legoId: '' }), /legoId/);
});

/* ------------------------- 3. correlation / causation / trace / deadline pass through */

test('causation links a derived envelope to the parent request that caused it', () => {
  const parent = createEnvelope({ legoId: 'a', operation: 'b' });
  const child = deriveEnvelope(parent, { legoId: 'c', operation: 'd' });
  assert.equal(child.causationId, parent.requestId, 'the default cause is the parent request');
  assert.equal(child.correlationId, parent.correlationId, 'the correlation root still passes through');

  const explicit = deriveEnvelope(parent, { legoId: 'c', operation: 'd', causationId: 'explicit-cause' });
  assert.equal(explicit.causationId, 'explicit-cause', 'an explicit cause may override the default');
});

test('correlation, causation, trace, deadline, cancellation and idempotency survive the kernel', () => {
  const parent = createEnvelope({ legoId: 'a', operation: 'b', timeoutMs: 5000, idempotencyKey: 'parent-idem', traceId: 'trace-abc' });
  const child = deriveEnvelope(parent, { legoId: 'c', operation: 'd', idempotencyKey: 'child-idem' });

  const restored = decodeMessage(encodeMessage(child, { step: 1 })).envelope;
  assert.equal(restored.correlationId, parent.correlationId);
  assert.equal(restored.causationId, parent.requestId);
  assert.equal(restored.traceId, 'trace-abc');
  assert.equal(restored.idempotencyKey, 'child-idem', 'an explicit idempotency key rides the derived envelope');
  assert.equal(restored.deadline, child.deadline, 'the deadline passes through unchanged');
  assert.ok(restored.deadline <= parent.deadline, 'a child still cannot outlive its parent after a round trip');
});

test('cancellation travels as a flag; the receiving side re-establishes its own signal', () => {
  const envelope = createEnvelope({ legoId: 'a', operation: 'b' });
  const wire = JSON.parse(encodeMessage(envelope, {}));
  assert.equal('signal' in wire.envelope, false, 'no signal on the wire');
  assert.equal(wire.envelope.cancellable, false, 'the far side knows it needs its own channel');

  const controller = new AbortController();
  const restored = decodeMessage(JSON.stringify(wire), { signal: controller.signal });
  assert.equal(isCancelled(restored.envelope), false);
  controller.abort();
  assert.equal(isCancelled(restored.envelope), true, 'the receiving-side signal governs the decoded envelope');
});

test('an expired deadline still reads as cancelled after a round trip', () => {
  const envelope = createEnvelope({ legoId: 'a', operation: 'b', timeoutMs: 1 });
  const past = { ...envelope, deadline: 1 };
  const restored = decodeMessage(JSON.stringify({ envelope: serializeEnvelope(past), payload: null }));
  assert.ok(restored.envelope.deadline < Date.now());
  assert.ok(remainingMs(restored.envelope) <= 0, 'remaining time of an expired deadline is at most zero');
  assert.equal(isCancelled(restored.envelope), true);
});

/* ----------------------------------------------- 4. bounded queues — under load */

test('buffer without a declared overflow handler refuses loudly instead of queueing past the watermark', () => {
  const bp = applyBackpressure({ policy: 'buffer', highWaterMark: 2, legoId: 'x', operation: 'y' });
  bp.push(1);
  bp.push(2);
  assert.equal(bp.size, 2);
  const error = caught(() => bp.push(3));
  assert.ok(error instanceof BackpressureError);
  assert.equal(error.code, 'lego.backpressure');
  assert.equal(bp.size, 2, 'the refused item never entered the buffer');
  assert.equal(error.pending, 2, 'the refusal reports the exact pending depth');
});

test('buffer with a declared onOverflow handler resolves overflow without growing the queue', () => {
  const overflowed = [];
  const bp = applyBackpressure({
    policy: 'buffer',
    highWaterMark: 1,
    legoId: 'x',
    operation: 'y',
    onOverflow: (item) => { overflowed.push(item); return false; },
  });
  bp.push('kept');
  const result = bp.push('overflow');
  assert.equal(result.accepted, false);
  assert.equal(result.action, 'overflow-dropped');
  assert.deepEqual(overflowed, ['overflow'], 'the declared handler saw the item');
  assert.equal(bp.size, 1, 'the buffer stayed at the watermark');
  assert.equal(bp.stats.dropped, 1);
});

test('buffer onOverflow may handle in place of dropping — but the buffer itself never grows', () => {
  const bp = applyBackpressure({
    policy: 'buffer',
    highWaterMark: 1,
    legoId: 'x',
    operation: 'y',
    onOverflow: (item) => `handled:${item}`,
  });
  bp.push('a');
  const result = bp.push('b');
  assert.equal(result.accepted, true);
  assert.equal(result.action, 'overflow-handled');
  assert.equal(bp.size, 1, 'still bounded by the watermark');
});

test('block tells a synchronous producer to pause instead of buffering without bound', () => {
  const bp = applyBackpressure({ policy: 'block', highWaterMark: 2, legoId: 'x', operation: 'y' });
  bp.push(1);
  bp.push(2);
  const result = bp.push(3);
  assert.equal(result.accepted, false);
  assert.equal(result.action, 'blocked');
  assert.equal(bp.size, 2, 'the blocked item is not queued');
  assert.deepEqual(bp.drain(), [1, 2]);
});

test('block pushAsync actually waits for the consumer — and wakes below the watermark', async () => {
  const bp = applyBackpressure({ policy: 'block', highWaterMark: 2, legoId: 'x', operation: 'y' });
  bp.push(1);
  bp.push(2);
  let settled = false;
  const third = bp.pushAsync(3).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'the producer is blocked while the buffer is full');
  assert.equal(bp.size, 2);
  assert.deepEqual(bp.drain(), [1, 2]);
  const result = await third;
  assert.equal(result.accepted, true);
  assert.equal(result.action, 'buffered');
  assert.equal(bp.size, 1);
});

test('every policy stays under its watermark while a fast producer outruns the consumer', () => {
  const policies = Object.keys(BACKPRESSURE_POLICIES);
  const WATERMARK = 4;
  const OFFERED = 64;
  for (const policy of policies) {
    const bp = applyBackpressure({
      policy,
      highWaterMark: WATERMARK,
      legoId: 'x',
      operation: 'y',
      coalesce: (a, b) => ({ n: a.n + b.n, t: b.t }),
      onOverflow: () => false,
    });
    let thrown = 0;
    for (let i = 0; i < OFFERED; i += 1) {
      try {
        bp.push({ n: 1, t: i });
      } catch (error) {
        thrown += 1;
        assert.ok(error instanceof BackpressureError, `${policy}: ${error.message}`);
        assert.equal(error.code, 'lego.backpressure', `${policy}: typed code required`);
      }
      assert.ok(bp.size <= WATERMARK, `${policy}: queue grew to ${bp.size} past watermark ${WATERMARK}`);
    }
    const shed = bp.stats.dropped + bp.stats.rejected + bp.stats.coalesced + thrown;
    assert.ok(shed > 0, `${policy}: 64 items against a watermark of 4 must shed ${JSON.stringify(bp.stats)}`);
    assert.ok(bp.size <= WATERMARK, `${policy}: final size ${bp.size} past watermark`);
    const rest = bp.drain();
    assert.ok(rest.length <= WATERMARK, `${policy}: drain returned ${rest.length} > watermark`);
    if (!bp.stats.terminated) {
      const after = bp.push({ n: 1, t: 'after-drain' });
      assert.equal(after.accepted, true, `${policy}: producer may resume once the consumer drained`);
      assert.ok(bp.size <= WATERMARK, `${policy}: resumed past watermark`);
    }
  }
});

test('backpressure is observed under load — a fast producer meets a slow consumer', async () => {
  const bp = applyBackpressure({ policy: 'reject', highWaterMark: 4, legoId: 'x', operation: 'y' });
  let refused = 0;
  // Phase 1: the producer bursts before the consumer has run at all.
  for (let i = 0; i < 50; i += 1) {
    try {
      bp.push(i);
    } catch (error) {
      refused += 1;
      assert.ok(error instanceof BackpressureError);
      assert.equal(error.code, 'lego.backpressure');
      assert.equal(error.retryable, true, 'a shed under overload stays retryable');
    }
    assert.ok(bp.size <= 4, `buffer grew to ${bp.size}`);
  }
  assert.ok(refused > 0, 'the overload is visible as backpressure, not hidden in a growing queue');
  assert.equal(bp.size, 4, 'the buffer is full at exactly the watermark');
  // Phase 2: the slow consumer drains; the producer may resume.
  const taken = bp.drain();
  assert.equal(taken.length, 4);
  const resumed = bp.push(50);
  assert.equal(resumed.accepted, true);
  assert.ok(bp.size <= 4);
});

test('STREAM items ride the same envelope/payload shape through the kernel', async () => {
  const legoId = `stream-kernel-${Math.random().toString(36).slice(2)}`;
  const off = registerProvider({
    legoId,
    operations: {
      ticks: {
        interaction: 'stream',
        backpressure: { policy: 'buffer' },
        async *handler() {
          yield 'a';
          yield 'b';
          yield 'c';
        },
      },
    },
  });
  try {
    const envelope = createEnvelope({ legoId, operation: 'ticks', timeoutMs: 10_000 });
    const seen = [];
    for await (const item of stream(legoId, 'ticks', {}, envelope)) {
      const restored = decodeMessage(encodeMessage(envelope, item));
      assert.equal(restored.payload, item, 'every streamed item survives the kernel round trip');
      assert.equal(restored.envelope.requestId, envelope.requestId, 'one envelope rides with every item');
      seen.push(restored.payload);
    }
    assert.deepEqual(seen, ['a', 'b', 'c']);
  } finally {
    off();
  }
});

test('BATCH_LIMITS is a declared ceiling and batch refuses to exceed it', async () => {
  assert.ok(Object.isFrozen(BATCH_LIMITS));
  assert.ok(Number.isInteger(BATCH_LIMITS.maxItems) && BATCH_LIMITS.maxItems > 0);

  const legoId = `batch-bound-${Math.random().toString(36).slice(2)}`;
  const off = registerProvider({
    legoId,
    operations: {
      each: {
        interaction: 'batch',
        handler: ({ items }) => items.map((entry) => ({ echo: entry })),
      },
    },
  });
  try {
    const ok = await batch(legoId, 'each', [{ a: 1 }, { a: 2 }]);
    assert.equal(ok.length, 2);

    const oversize = Array.from({ length: BATCH_LIMITS.maxItems + 1 }, (_, i) => i);
    await assert.rejects(() => batch(legoId, 'each', oversize), /BATCH_LIMITS.maxItems/);
    await assert.rejects(() => batch(legoId, 'each', 'not-an-array'), /must be an array/);

    const exactlyAtCeiling = Array.from({ length: BATCH_LIMITS.maxItems }, (_, i) => i);
    const atCeiling = await batch(legoId, 'each', exactlyAtCeiling);
    assert.equal(atCeiling.length, BATCH_LIMITS.maxItems, 'the declared ceiling itself stays usable');
  } finally {
    off();
  }
});
