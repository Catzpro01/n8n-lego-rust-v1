/**
 * runtime.cancel@0.1.0 — cancellation and accounting.
 *
 * P6 milestone 23 of 31 (Issue #100). Cancellation is the moment a runtime is most likely to
 * lie. Work that was asked to stop and did not is reported as stopped; a slot that is still
 * held is declared free; a result that arrived after the cancel is quietly dropped. This
 * contract exists to make each of those impossible to do silently.
 *
 * What it adds beyond a flag:
 *
 *  - CANCELLATION IS A STATE MACHINE WITH A DEADLINE. `running` → `cancelling` → `cancelled`,
 *    and a request that is never answered becomes `abandoned` once its grace has passed:
 *    an execution nobody stopped is a fact, and a fact is not made better by a timeout.
 *  - A SECOND REQUEST DOES NOT BUY TIME. Cancelling twice is idempotent and the deadline does
 *    not move, because a grace period that can be extended by asking again is not a bound.
 *  - THE RACE IS RECORDED, NOT RESOLVED. If the work finished anyway, the honest outcome is
 *    `completed-after-cancel`; claiming `completed` is refused, because that erases the
 *    cancellation, and claiming `cancelled` is refused too, because something did happen and
 *    the accounting has to bill it.
 *  - A CANCELLED EXECUTION IS NOT FREE. What it consumed stays consumed; only what can be
 *    handed back is handed back, exactly once. Releasing a slot that was never charged is
 *    refused: a slot returned that was never taken is a slot that never existed.
 *  - AN ABANDONED EXECUTION KEEPS HOLDING ITS SLOT. The ledger does not declare free what it
 *    cannot see released — that is how a pool over-subscribes itself.
 *  - CHARGES ARE ADDRESSED, NOT COUNTED. Each charge carries a reference; the same reference
 *    charged twice with the same amount is a duplicate the caller may ignore, and with a
 *    different amount it is refused: two amounts for one reference is two rumours for one fact.
 *
 * Scope walls (enforced by tests): no scheduler, no queue and no retry policy (P4); no slot
 * table (P6.22 owns granting, this contract records what was charged and returned); no health
 * judgement (P6.11); no rollout decision (P6.19); no telemetry backend (P9). No filesystem,
 * network, clock, randomness or shared-state mutation beyond the structures handed in — the
 * only `node:` import is the hash, and every answer takes the tick it answers for.
 *
 * Authority: this contract records what happened to a cancelled execution and what it cost.
 * It never decides whether something should run, and it never invents a charge or a release.
 */
import { createHash } from 'node:crypto';

export const CANCEL_CONTRACT = 'runtime.cancel@0.1.0';
export const CANCEL_CONTRACT_VERSION = '0.1.0';
export const CANCEL_SCHEMA_VERSION = 1;

export const CANCEL_OPERATIONS = Object.freeze(['request', 'checkpoint', 'settle', 'charge', 'release', 'describe']);
export const CANCEL_PERMISSIONS = Object.freeze(['node:read']);

/** Where an execution stands with respect to cancellation. */
export const CANCEL_STATES = Object.freeze(['running', 'cancelling', 'cancelled', 'completed', 'abandoned']);

/** What settling may say happened. `completed-after-cancel` is a first-class answer. */
export const SETTLE_OUTCOMES = Object.freeze(['cancelled', 'completed', 'completed-after-cancel', 'abandoned']);

/** Why a cancellation was asked for. A closed list, because "why" is the question afterwards. */
export const CANCEL_CAUSES = Object.freeze(['operator', 'timeout', 'quota', 'rollout-halt', 'revocation', 'health', 'shutdown']);

/** What can be charged for. One list, so a total has one meaning. */
export const CHARGE_KINDS = Object.freeze(['slot', 'ticks', 'bytes', 'side-effects']);

export const DEFAULT_GRACE_TICKS = 30;
export const MAX_GRACE_TICKS = 600;

export const CANCEL_REASONS = Object.freeze([
  'cancel.input', 'cancel.state', 'cancel.request', 'cancel.settle', 'cancel.deadline', 'accounting.charge', 'accounting.release', 'accounting.duplicate',
]);

export const CANCEL_RULES = Object.freeze({
  state: 'cancellation is a state machine with a deadline: running, cancelling, cancelled, and abandoned when nobody answered',
  once: 'a second request is idempotent and does not move the deadline: a grace that grows when you ask again is not a bound',
  race: 'if the work finished anyway the honest answer is completed-after-cancel, because something happened and it has to be billed',
  free: 'a cancelled execution is not free: what it consumed stays consumed, and only what can be handed back is handed back',
  exactlyOnce: 'a slot is returned once; releasing one that was never charged is refused, because it never existed',
  outstanding: 'an abandoned execution keeps holding its slot: the ledger does not declare free what it cannot see released',
  addressed: 'a charge carries a reference, so a duplicate is visible and two amounts for one reference are refused',
  authority: 'this contract records what happened and what it cost; it never decides whether something should run',
});

export class CancelError extends Error {
  constructor(message, { code = 'cancel.input', meta = {} } = {}) {
    super(message);
    this.name = 'CancelError';
    this.code = 'lego.contract_violation';
    this.meta = { code, ...meta };
  }
}

const fail = (message, detail = {}) => { throw new CancelError(message, detail); };

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isTick = (value) => Number.isInteger(value) && value >= 0;

/** Canonical JSON: key order must not change a digest. */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** A digest over a set of fields, so a token or a ledger can be cited by content. */
export function cancelDigest(fields) {
  return sha256(stableJson(fields ?? {}));
}

/* -------------------------------------------------------------------- token */

export function createCancelToken({ executionId, tick, grace = DEFAULT_GRACE_TICKS } = {}) {
  if (!isNonEmptyString(executionId)) {
    fail('a cancellation token belongs to an execution: an unnamed execution cannot be cancelled or billed', { code: 'cancel.input', field: 'executionId' });
  }
  if (!isTick(tick)) fail('a token starts at a tick', { code: 'cancel.input', field: 'tick' });
  checkGrace(grace);
  const body = {
    contract: CANCEL_CONTRACT,
    schemaVersion: CANCEL_SCHEMA_VERSION,
    executionId,
    startedAt: tick,
    grace,
    state: 'running',
    cancelRequestedAt: null,
    cause: null,
    reason: null,
    deadline: null,
    checkpoints: 0,
    abandonedAt: null,
    settledAt: null,
    outcome: null,
    producedOutput: null,
  };
  return { ...body, tokenDigest: cancelDigest(body) };
}

function checkGrace(grace) {
  if (!Number.isInteger(grace) || grace < 1 || grace > MAX_GRACE_TICKS) {
    fail(`grace must be a whole number of ticks between 1 and ${MAX_GRACE_TICKS}; got ${String(grace)}`, { code: 'cancel.deadline', field: 'grace' });
  }
  return grace;
}

/** Where settling leaves the token. `completed-after-cancel` is a completed execution, named. */
const SETTLE_STATES = Object.freeze({ cancelled: 'cancelled', completed: 'completed', 'completed-after-cancel': 'completed', abandoned: 'abandoned' });

export function isCancelToken(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === CANCEL_CONTRACT && isNonEmptyString(value.executionId) && CANCEL_STATES.includes(value.state);
}

function requireToken(token, who) {
  if (!isCancelToken(token)) fail(`${who} reads a token made by createCancelToken`, { code: 'cancel.input', field: 'token' });
  return token;
}

/**
 * Asking for a cancellation marks the intent and starts the clock. The request is idempotent
 * and the deadline does not move: a grace that grows every time somebody asks again is not a
 * bound, it is a negotiation.
 */
export function requestCancel(token, { tick, cause, reason, grace } = {}) {
  requireToken(token, 'requestCancel');
  if (!isTick(tick)) fail('a cancellation request records the tick it was made at', { code: 'cancel.input', field: 'tick' });
  if (!CANCEL_CAUSES.includes(cause)) {
    fail(`cause '${String(cause)}' is not one a cancellation may carry: "why" is the question asked afterwards`, { code: 'cancel.request', field: 'cause' });
  }
  if (!isNonEmptyString(reason)) fail('a cancellation records a reason a human can read', { code: 'cancel.request', field: 'reason' });
  if (token.state === 'cancelled' || token.state === 'completed' || token.state === 'abandoned') {
    fail(`this execution is '${token.state}': cancelling it now would rewrite what happened`, { code: 'cancel.state', field: 'state' });
  }
  if (token.state === 'cancelling') {
    return Object.freeze({
      ok: true,
      requested: false,
      already: true,
      token,
      message: `cancellation was already requested at tick ${token.cancelRequestedAt} for ${token.cause}: asking again does not extend the grace`,
    });
  }
  const window = grace === undefined ? token.grace : checkGrace(grace);
  token.state = 'cancelling';
  token.cancelRequestedAt = tick;
  token.cause = cause;
  token.reason = reason;
  token.grace = window;
  token.deadline = tick + window;
  return Object.freeze({
    ok: true,
    requested: true,
    token,
    deadline: token.deadline,
    message: `cancellation requested at tick ${tick} for ${cause}; the execution has until tick ${token.deadline}`,
  });
}

/**
 * A checkpoint is where a runner asks whether it may continue. It is also how a missed
 * deadline is noticed: nobody has to remember to sweep.
 */
export function checkpoint(token, { tick } = {}) {
  requireToken(token, 'checkpoint');
  if (!isTick(tick)) fail('a checkpoint happens at a tick', { code: 'cancel.input', field: 'tick' });
  if (token.state === 'cancelling' && token.deadline !== null && tick >= token.deadline) {
    // Abandonment is noticed here, but the *settlement* is a separate act: the accounting
    // still has to be written, and the ledger must be told the slot stays held.
    token.state = 'abandoned';
    token.abandonedAt = tick;
    return Object.freeze({
      ok: false,
      proceed: false,
      abandoned: true,
      reason: 'cancel.deadline',
      token,
      message: `the cancellation grace expired at tick ${token.deadline} and the execution did not stop: it is abandoned, and its slot stays in the ledger`,
    });
  }
  if (token.state === 'running') {
    token.checkpoints += 1;
    return Object.freeze({ ok: true, proceed: true, token, checkpoint: token.checkpoints, message: `checkpoint ${token.checkpoints}: no cancellation has been asked for` });
  }
  if (token.state === 'cancelling') {
    token.checkpoints += 1;
    return Object.freeze({ ok: true, proceed: false, reason: 'cancel.request', token, checkpoint: token.checkpoints, message: `cancellation was asked for at tick ${token.cancelRequestedAt}: starting new work is refused, and so is pretending it was not asked` });
  }
  return Object.freeze({ ok: true, proceed: false, reason: 'cancel.state', token, message: `the execution is '${token.state}': nothing new starts here` });
}

/**
 * Settling says what happened. The outcome has to be consistent with the request: a race is
 * named as a race, and an outcome that would erase the cancellation is refused.
 */
export function settleToken(token, { tick, outcome, producedOutput = null } = {}) {
  requireToken(token, 'settleToken');
  if (!isTick(tick)) fail('settling happens at a tick', { code: 'cancel.input', field: 'tick' });
  if (!SETTLE_OUTCOMES.includes(outcome)) {
    fail(`outcome '${String(outcome)}' is not one of ${SETTLE_OUTCOMES.join(', ')}`, { code: 'cancel.settle', field: 'outcome' });
  }
  if (token.settledAt !== null) {
    fail(`this execution settled at tick ${token.settledAt} as '${token.outcome}': a second settlement would rewrite what happened`, { code: 'cancel.settle', field: 'token' });
  }
  if (token.state === 'running' && outcome === 'cancelled') {
    fail('nothing was cancelled: this execution is still running and nobody asked it to stop', { code: 'cancel.settle', field: 'outcome' });
  }
  if (token.state !== 'running' && outcome === 'completed') {
    fail("the work finished after it was asked to stop: the honest outcome is 'completed-after-cancel', because claiming 'completed' erases the cancellation", { code: 'cancel.settle', field: 'outcome' });
  }
  if (outcome === 'abandoned' && token.state !== 'abandoned') {
    fail(`an execution is abandoned when its grace has passed, not when somebody says so: this one is '${token.state}'`, { code: 'cancel.settle', field: 'outcome' });
  }
  if (outcome === 'completed-after-cancel' && producedOutput !== true && producedOutput !== false) {
    fail('a completed-after-cancel settlement says whether output was produced: the result is a fact, not a secret', { code: 'cancel.settle', field: 'producedOutput' });
  }
  // The race keeps both facts: `outcome` names it, and the state says the work did finish.
  token.state = SETTLE_STATES[outcome];
  token.settledAt = tick;
  token.outcome = outcome;
  token.producedOutput = outcome === 'completed-after-cancel' ? producedOutput : null;
  return Object.freeze({ ok: true, settled: true, outcome, token, message: `settled at tick ${tick} as '${outcome}'` });
}

/* ------------------------------------------------------------------- ledger */

export function createAccountingLedger() {
  return { contract: CANCEL_CONTRACT, schemaVersion: CANCEL_SCHEMA_VERSION, entries: new Map(), releases: new Map(), sequence: 0 };
}

export function isAccountingLedger(value) {
  return Boolean(value) && typeof value === 'object' && value.contract === CANCEL_CONTRACT && value.entries instanceof Map && value.releases instanceof Map;
}

const entryKey = (executionId, kind, reference) => `${executionId}|${kind}|${reference}`;

/**
 * Charging is addressed: the same reference charged twice with the same amount is a duplicate
 * the caller may ignore; with a different amount it is refused. A total built from two
 * amounts for one fact is a total nobody can defend.
 */
export function charge(ledger, { executionId, kind, amount, tick, reference } = {}) {
  if (!isAccountingLedger(ledger)) fail('charge reads a ledger made by createAccountingLedger', { code: 'cancel.input', field: 'ledger' });
  if (!isNonEmptyString(executionId)) fail('a charge belongs to an execution', { code: 'accounting.charge', field: 'executionId' });
  if (!CHARGE_KINDS.includes(kind)) {
    fail(`kind '${String(kind)}' is not one of ${CHARGE_KINDS.join(', ')}: one list, so a total has one meaning`, { code: 'accounting.charge', field: 'kind' });
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    fail(`a charge is a positive whole amount; got ${String(amount)}`, { code: 'accounting.charge', field: 'amount' });
  }
  if (!isTick(tick)) fail('a charge is made at a tick', { code: 'cancel.input', field: 'tick' });
  if (!isNonEmptyString(reference)) {
    fail('a charge carries a reference: an unaddressed charge cannot be released exactly once', { code: 'accounting.charge', field: 'reference' });
  }
  const key = entryKey(executionId, kind, reference);
  const existing = ledger.entries.get(key) ?? null;
  if (existing) {
    if (existing.amount !== amount) {
      fail(`reference '${reference}' was already charged ${existing.amount} ${kind} at tick ${existing.tick} and is now charged ${amount}: two amounts for one reference is two rumours for one fact`, { code: 'accounting.duplicate', field: 'reference' });
    }
    return Object.freeze({ ok: true, charged: false, duplicate: true, entry: existing, message: `'${reference}' was already charged ${amount} ${kind}: the duplicate is ignored, not added` });
  }
  ledger.sequence += 1;
  const body = {
    contract: CANCEL_CONTRACT,
    schemaVersion: CANCEL_SCHEMA_VERSION,
    id: `charge#${ledger.sequence}`,
    executionId,
    kind,
    reference,
    amount,
    tick,
    released: 0,
    releaseTicks: [],
  };
  const entry = { ...body, entryDigest: cancelDigest(body) };
  ledger.entries.set(key, entry);
  return Object.freeze({ ok: true, charged: true, entry, message: `charged ${amount} ${kind} for '${reference}'` });
}

/**
 * Releasing hands something back exactly once. Releasing what was never charged, or more than
 * is outstanding, is refused: an accounting that can go negative is not an accounting.
 */
export function releaseCharge(ledger, { executionId, kind, reference, amount, tick } = {}) {
  if (!isAccountingLedger(ledger)) fail('releaseCharge reads a ledger made by createAccountingLedger', { code: 'cancel.input', field: 'ledger' });
  if (!isTick(tick)) fail('a release records the tick it was made at', { code: 'cancel.input', field: 'tick' });
  const key = entryKey(executionId, kind, reference);
  const entry = ledger.entries.get(key) ?? null;
  if (!entry) {
    fail(`nothing was charged for '${String(reference)}': a release that never had a charge is a slot that never existed`, { code: 'accounting.release', field: 'reference' });
  }
  const outstanding = entry.amount - entry.released;
  if (outstanding === 0) {
    fail(`'${reference}' was already fully released at tick ${entry.releaseTicks[entry.releaseTicks.length - 1]}: the same charge does not come back twice`, { code: 'accounting.release', field: 'reference' });
  }
  if (!Number.isInteger(amount) || amount <= 0 || amount > outstanding) {
    fail(`a release of ${String(amount)} does not fit the outstanding ${outstanding} for '${reference}'`, { code: 'accounting.release', field: 'amount' });
  }
  entry.released += amount;
  entry.releaseTicks = [...entry.releaseTicks, tick];
  ledger.releases.set(key, [...entry.releaseTicks]);
  return Object.freeze({
    ok: true,
    released: amount,
    outstanding: entry.amount - entry.released,
    entry,
    message: `released ${amount} ${kind} of ${entry.amount} for '${reference}'`,
  });
}

/**
 * Settling an execution is where the two halves meet: the token says what happened and the
 * ledger says what it cost. A cancellation hands back the slot exactly once; an abandoned
 * execution keeps it, and the ledger says why.
 */
export function settleExecution(ledger, token, { tick, outcome, producedOutput = null, slotReference = 'slot' } = {}) {
  if (!isAccountingLedger(ledger)) fail('settleExecution reads a ledger made by createAccountingLedger', { code: 'cancel.input', field: 'ledger' });
  requireToken(token, 'settleExecution');
  const settled = settleToken(token, { tick, outcome, producedOutput });
  const key = entryKey(token.executionId, 'slot', slotReference);
  const entry = ledger.entries.get(key) ?? null;
  if (!entry) {
    return Object.freeze({
      ok: true,
      settled: true,
      outcome,
      token,
      slot: Object.freeze({ held: false, note: 'no slot was charged for this execution, so none is returned' }),
      message: `${settled.message}; nothing was charged for '${slotReference}'`,
    });
  }
  if (outcome === 'abandoned') {
    return Object.freeze({
      ok: true,
      settled: true,
      outcome,
      token,
      slot: Object.freeze({ held: true, entry, note: 'the slot stays in the ledger: it was not released' }),
      message: `${settled.message}; the slot stayed in the ledger, because nothing was released`,
    });
  }
  const outstanding = entry.amount - entry.released;
  if (outstanding === 0) {
    return Object.freeze({ ok: true, settled: true, outcome, token, slot: Object.freeze({ held: false, entry, note: 'already returned' }), message: `${settled.message}; the slot had already been returned` });
  }
  const released = releaseCharge(ledger, { executionId: token.executionId, kind: 'slot', reference: slotReference, amount: outstanding, tick });
  return Object.freeze({
    ok: true,
    settled: true,
    outcome,
    token,
    slot: Object.freeze({ held: false, entry, note: `returned ${released.released}` }),
    message: `${settled.message}; the slot came back once`,
  });
}

/** The totals a review opens with, per kind and per execution, with what is still outstanding. */
export function describeLedger(ledger, { tick } = {}) {
  if (!isAccountingLedger(ledger)) fail('describeLedger reads a ledger made by createAccountingLedger', { code: 'cancel.input', field: 'ledger' });
  if (tick !== undefined && !isTick(tick)) fail('a census answers for a tick', { code: 'cancel.input', field: 'tick' });
  const entries = [...ledger.entries.values()];
  const byKind = {};
  for (const entry of entries) {
    byKind[entry.kind] = byKind[entry.kind] ?? { charged: 0, released: 0, outstanding: 0 };
    byKind[entry.kind].charged += entry.amount;
    byKind[entry.kind].released += entry.released;
    byKind[entry.kind].outstanding += entry.amount - entry.released;
  }
  const byExecution = {};
  for (const entry of entries) {
    byExecution[entry.executionId] = byExecution[entry.executionId] ?? { charged: 0, released: 0, outstanding: 0, entries: 0 };
    byExecution[entry.executionId].charged += entry.amount;
    byExecution[entry.executionId].released += entry.released;
    byExecution[entry.executionId].outstanding += entry.amount - entry.released;
    byExecution[entry.executionId].entries += 1;
  }
  const outstandingSlots = entries
    .filter((entry) => entry.kind === 'slot' && entry.amount - entry.released > 0)
    .map((entry) => `${entry.executionId}:${entry.reference}`);
  const body = {
    contract: CANCEL_CONTRACT,
    tick: tick ?? null,
    entries: entries.length,
    byKind: Object.freeze(Object.fromEntries(Object.entries(byKind).sort().map(([kind, totals]) => [kind, Object.freeze(totals)]))),
    byExecution: Object.freeze(Object.fromEntries(Object.entries(byExecution).sort().map(([id, totals]) => [id, Object.freeze(totals)]))),
    outstandingSlots: Object.freeze(outstandingSlots.sort()),
  };
  return Object.freeze({ ...body, ledgerDigest: cancelDigest(body) });
}

/** One readable line per execution, because a cost nobody can read is a cost nobody reviews. */
export function explainToken(token) {
  requireToken(token, 'explainToken');
  const asked = token.cancelRequestedAt === null ? 'no cancellation was asked for' : `cancelled for ${token.cause} at tick ${token.cancelRequestedAt} (grace to ${token.deadline})`;
  const ended = token.settledAt === null
    ? (token.abandonedAt === null ? 'not settled' : `abandoned at tick ${token.abandonedAt}, not yet settled`)
    : `settled at tick ${token.settledAt} as '${token.outcome}'${token.producedOutput === null ? '' : `, output produced: ${token.producedOutput}`}`;
  return `execution ${token.executionId}: ${token.state} — ${asked}; ${token.checkpoints} checkpoint(s); ${ended}`;
}

export function explainLedger(ledger) {
  const described = describeLedger(ledger);
  const kinds = Object.entries(described.byKind).map(([kind, totals]) => `${kind} ${totals.released}/${totals.charged}`).join(', ') || 'nothing charged';
  const outstanding = described.outstandingSlots.length === 0
    ? 'no slot is outstanding'
    : `${described.outstandingSlots.length} slot(s) outstanding (${described.outstandingSlots.join(', ')})`;
  return `${described.entries} charge(s) — ${kinds}; ${outstanding}`;
}
