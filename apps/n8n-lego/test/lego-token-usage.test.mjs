/**
 * P2.24 — Token & Usage honest accounting.
 *
 * Categories (§20): contract/parity · honest accounting · cost · identity ·
 * security/privacy · time · side effects · compatibility. Every suite runs
 * offline with injected clock/identity; disk and network are untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as usageModule from '../src/lego/token-usage.mjs';
import {
  COST_RULES, COST_STATUSES, FORBIDDEN_USAGE_FIELDS, SENSITIVE_USAGE_RE,
  TOKEN_KINDS, TOKEN_USAGE_CONTRACT, TOKEN_USAGE_CONTRACT_VERSION,
  TOKEN_USAGE_FIELDS, TOKEN_USAGE_OPERATIONS, TOKEN_USAGE_PERMISSIONS,
  TokenUsageError, USAGE_LIMITS, USAGE_SCOPES, USAGE_STATUSES, USAGE_UNITS,
  calculateCost, createTokenUsageFoundation,
} from '../src/lego/token-usage.mjs';
import { CONTINUATION_VERIFICATION, CONTEXT_MANAGER_STATES } from '../src/lego/context.mjs';

const HERE = new URL('.', import.meta.url);
const MODULE_PATH = join(HERE.pathname, '..', 'src', 'lego', 'token-usage.mjs');
const MODULE_SOURCE = readFileSync(MODULE_PATH, 'utf8');
const LOCK = JSON.parse(readFileSync(join(HERE.pathname, '..', 'src', 'lego', 'contracts', 'contract-lock.json'), 'utf8'));
const DOMAINS = JSON.parse(readFileSync(join(HERE.pathname, '..', 'src', 'lego', 'manifest', 'domains.json'), 'utf8'));
const AI_SET = JSON.parse(readFileSync(join(HERE.pathname, '..', 'src', 'lego', 'manifest', 'ai-lego-set.json'), 'utf8'));
const SCENARIOS = JSON.parse(readFileSync(join(HERE.pathname, '..', 'src', 'lego', 'manifest', 'reference-scenarios.json'), 'utf8'));

const AI_FOUNDATION = DOMAINS.domains.find((domain) => domain.id === 'ai-foundation');
const CAPABILITY = AI_FOUNDATION.capabilities.find((capability) => capability.id === 'ai.token-usage');
const LOCK_ROW = LOCK.contracts.find((row) => row.id === 'ai.token-usage');
const TOKEN_USAGE_LEGO = AI_SET.lego.find((lego) => lego.id === 'token-usage');
const ROLLOVER_SCENARIO = SCENARIOS.scenarios.find((scenario) => scenario.id === 'context-rollover');

/* ---------------- harness: injected clock + deterministic ids ---------------- */

function harness() {
  let seq = 0;
  const foundation = createTokenUsageFoundation({
    now: () => '2026-09-23T00:00:00.000Z',
    newId: () => `t${String(++seq).padStart(4, '0')}`,
  });
  return { foundation, ids: () => seq };
}

const entry = (over = {}) => ({
  requestId: 'req-0001',
  scopeLevel: 'call',
  scopeRef: 'call-1',
  kind: 'modelInput',
  value: 412,
  unit: 'tokens',
  status: 'reported',
  source: 'provider',
  ...over,
});

const pricing = Object.freeze({ costPerInputToken: 0.5, costPerOutputToken: 0.25 });

/* ================================================================ *
 * Contract — schema, vocabulary, exports, registry, capability
 * ================================================================ */

test('the contract string is the exact locked identity — row 29, domain ai-foundation', () => {
  assert.equal(TOKEN_USAGE_CONTRACT, 'ai.token-usage@1.0.0');
  assert.equal(TOKEN_USAGE_CONTRACT_VERSION, '1.0.0');
  assert.equal(LOCK_ROW.version, '1.0.0');
  assert.equal(LOCK_ROW.status, 'implemented');
  assert.equal(LOCK_ROW.domain, 'ai-foundation');
  assert.equal(LOCK_ROW.owner, 'manager');
  // P9.1 envelope + P3 optimizer are merged; P9.2 structured-log adds row 42.
  assert.equal(LOCK.contracts.length, 100, 'rows through P3 Slice A persistent logical graph (thirty-third); P3 Slice D adds the thirty-fourth (execution.frontier); P3 Slice E adds the thirty-fifth (execution.state-stream); P3 Slice H adds the thirty-sixth (workflow.dna); P3 Slice J the thirty-seventh (execution.ir); P3 Slice L the thirty-eighth (compatibility.oracle); P3 Slice M the thirty-ninth (execution.guard); P3 Slice K the forty-first (execution.optimizer) — P6.1 adds node.registry@0.1.0; P6.2 adds registry.compiler@0.1.0; P6.3 adds package.transaction@0.1.0; P6.4 adds registry.closure@0.1.0; P6.5 adds node.resolution@0.1.0; P6.6 adds runtime.lease@0.1.0; P6.7 adds node.residency@0.1.0; P6.8 adds node.capability@0.1.0; P6.9 adds node.semantics@0.1.0; P6.10 adds node.lifecycle@0.1.0; P6.11 adds node.health@0.1.0; P6.12 adds node.supply-chain@0.1.0; P6.13 adds registry.incremental@0.1.0; P6.14 adds node.worker-convergence@0.1.0; P6.15 adds node.acceptance@0.1.0; P6.16 adds registry.integrity@0.1.0; P6.17 adds node.admission@0.1.0; P6.18 adds node.sbom@0.1.0; P6.19 adds node.canary@0.1.0; P6.20 adds node.revocation@0.1.0; P6.21 adds node.io@0.1.0; P6.22 adds runtime.jit@0.1.0; P6.23 adds runtime.cancel@0.1.0; P6.24 adds runtime.pool@0.1.0; P6.25 adds node.abi@0.1.0; P6.26 adds runtime.wasm-cache@0.1.0; P6.27 adds node.provenance@0.1.0; P6.28 adds registry.freshness@0.1.0; P6.29 adds node.namespace@0.1.0; P6.30 adds registry.repair@0.1.0; P6.31 adds registry.acceptance@0.1.0; count-pins say 76; P2.27.1 adds lego.plugin-runtime@0.1.0 (seventy-sixth); P5.1 adds the ninety-fifth (auth.principal)'); // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  // primary contract of ai-foundation stays ai.foundation (R9 — usage is a sibling row)
  assert.equal(AI_FOUNDATION.contract.id, 'ai.foundation');
});

test('the lock row names real exports, real ops, the real test file — exports pinned to the module', () => {
  assert.deepEqual([...LOCK_ROW.operations], [...TOKEN_USAGE_OPERATIONS]);
  const exported = LOCK_ROW.exports['src/lego/token-usage.mjs'];
  assert.deepEqual([...exported].sort(), Object.keys(usageModule).sort(),
    'the lock exports exactly what the module exports');
  assert.deepEqual(LOCK_ROW.tests, ['apps/n8n-lego/test/lego-token-usage.test.mjs']);
  assert.deepEqual([...LOCK_ROW.permissions], [...TOKEN_USAGE_PERMISSIONS]);
  assert.ok(readFileSync(join(HERE.pathname, '..', '..', '..', LOCK_ROW.tests[0]), 'utf8').length > 0,
    'the declared contract test exists');
});

test('module, lock row, capability and the AI set agree — three-way parity, no second publisher', () => {
  assert.deepEqual(CAPABILITY.operations.map((op) => op.name), [...TOKEN_USAGE_OPERATIONS]);
  assert.deepEqual([...CAPABILITY.permissions].sort(), [...TOKEN_USAGE_PERMISSIONS].sort());
  assert.equal(CAPABILITY.status, 'implemented');
  assert.equal(CAPABILITY.operations.length, 3, 'operation count pinned');
  assert.equal(CAPABILITY.permissions.length, 2, 'permission count pinned');
  for (const op of CAPABILITY.operations) {
    assert.equal(op.interaction, 'call');
    assert.ok(TOKEN_USAGE_PERMISSIONS.includes(op.permission), `${op.permission} published`);
    assert.equal(op.status, 'implemented');
    assert.equal(op.idempotent, true, 'every operation is idempotent on identity');
  }
  // record is the only write: it maps to write; query/budget read
  const byName = Object.fromEntries(CAPABILITY.operations.map((op) => [op.name, op.permission]));
  assert.equal(byName.record, 'ai:usage:write');
  assert.equal(byName.query, 'ai:usage:read');
  assert.equal(byName.budget, 'ai:usage:read');
  // the AI set declares the same contract, ops and permissions
  assert.deepEqual(TOKEN_USAGE_LEGO.contracts, ['ai.token-usage']);
  assert.deepEqual(TOKEN_USAGE_LEGO.operations, ['record', 'query', 'budget']);
  assert.deepEqual(TOKEN_USAGE_LEGO.permissions, ['ai:usage:read', 'ai:usage:write']);
  assert.equal(TOKEN_USAGE_LEGO.versioning, 'ai.token-usage@1.0.0');
  assert.notEqual(TOKEN_USAGE_LEGO.status, 'implemented', 'the LEGO as a whole never claims runtime completeness');
  // ownership visible: path + public surface in the registry
  assert.ok(AI_FOUNDATION.paths.includes('src/lego/token-usage.mjs'), 'domain owns the file');
  assert.ok(AI_FOUNDATION.public.includes('src/lego/token-usage.mjs'), 'published for cross-domain consumption');
  // only ONE usage contract exists anywhere in the lock
  const usageRows = LOCK.contracts.filter((row) => /usage|token/i.test(row.id));
  assert.deepEqual(usageRows.map((row) => row.id), ['ai.token-usage'], 'no second publisher');
});

test('the P2.13 token vocabulary is quoted byte-for-byte — no provider synonyms are coined', () => {
  assert.deepEqual([...TOKEN_KINDS], ['message', 'modelInput', 'output']);
  assert.deepEqual([...ROLLOVER_SCENARIO.tokenKinds ? Object.keys(ROLLOVER_SCENARIO.tokenKinds) : []],
    ['message', 'modelInput', 'output']);
  for (const synonym of ['inputTokens', 'promptTokens', 'completionTokens', 'requestTokens', 'responseTokens']) {
    assert.ok(!TOKEN_KINDS.includes(synonym), `${synonym} is not a canonical kind`);
    assert.ok(!new RegExp(`['"\`]${synonym}['"\`]`).test(MODULE_SOURCE), `${synonym} appears nowhere in the module`);
  }
  assert.deepEqual([...USAGE_STATUSES], ['reported', 'estimated', 'unavailable']);
  assert.deepEqual([...USAGE_SCOPES], ['call', 'run', 'session'], 'the three scopes XA-17 asks about');
  assert.deepEqual([...USAGE_UNITS], ['tokens']);
  assert.deepEqual([...COST_RULES], ['linear-input-output']);
  assert.deepEqual([...COST_STATUSES], ['calculated', 'estimated', 'unavailable']);
  assert.equal(TOKEN_USAGE_FIELDS.length, 11, 'closed record shape');
  // the P2.13 surfaces this module must not disturb still hold their own words
  assert.equal(typeof CONTEXT_MANAGER_STATES.length, 'number');
  assert.equal(typeof CONTINUATION_VERIFICATION.length, 'number');
});

/* ================================================================ *
 * Honest accounting — reported / estimated / unavailable
 * ================================================================ */

test('a reported figure stays reported and a zero the source reported stays a reported zero', () => {
  const { foundation } = harness();
  const reported = foundation.record(entry());
  assert.equal(reported.status, 'reported');
  assert.equal(reported.value, 412);
  assert.equal(reported.estimator, null);
  // 0 that the source actually reported is a fact, distinct from unknown
  const zero = foundation.record(entry({ requestId: 'req-zero', kind: 'output', value: 0 }));
  assert.equal(zero.value, 0);
  assert.equal(zero.status, 'reported', 'a reported zero is reported, not unavailable');
});

test('missing is unavailable — null forever, never coerced to 0 by record, query or budget', () => {
  const { foundation } = harness();
  const missing = foundation.record(entry({
    requestId: 'req-miss', kind: 'output', value: null, status: 'unavailable', source: 'none',
  }));
  assert.equal(missing.value, null);
  assert.equal(missing.status, 'unavailable');
  assert.throws(() => foundation.record(entry({
    requestId: 'req-bad-zero', kind: 'output', value: 0, status: 'unavailable', source: 'none',
  })), (error) => {
    assert.ok(error instanceof TokenUsageError);
    assert.equal(error.code, 'lego.contract_violation');
    assert.match(error.message, /never 0|never a number/);
    return true;
  });
  const budget = foundation.budget({ scopeLevel: 'call', scopeRef: 'call-1', kind: 'output', limit: 100 });
  assert.equal(budget.used, null, 'an unavailable figure budgets as null, not 0');
  assert.equal(budget.over, null, 'and never claims within-budget');
  const empty = foundation.budget({ scopeLevel: 'run', scopeRef: 'nobody', kind: 'message', limit: 10 });
  assert.equal(empty.used, null, 'an empty scope is unavailable, not zero usage');
  assert.equal(empty.certainty, 'unavailable');
});

test('estimated keeps its status and its named estimator; it is never promoted to reported', () => {
  const { foundation } = harness();
  const estimated = foundation.record(entry({
    requestId: 'req-est', kind: 'message', value: 7, status: 'estimated', source: 'caller', estimator: 'chars-ceil-v1',
  }));
  assert.equal(estimated.status, 'estimated');
  assert.equal(estimated.estimator, 'chars-ceil-v1', 'the method travels with the number');
  // an estimated record must name a method
  assert.throws(() => foundation.record(entry({
    requestId: 'req-est-named', kind: 'message', value: 7, status: 'estimated', source: 'caller',
  })), /estimator/);
  // a reported record must NOT carry a method — provider-reported never swaps with estimated
  assert.throws(() => foundation.record(entry({
    requestId: 'req-swap', status: 'reported', estimator: 'chars-ceil-v1',
  })), /must not carry an estimator/);
  const [read] = foundation.query({ requestId: 'req-est' });
  assert.equal(read.status, 'estimated', 'query never promotes a status');
});

test('budget derivation: worst certainty wins and a hole beats every number', () => {
  const { foundation } = harness();
  foundation.record(entry({ requestId: 'b-1', scopeLevel: 'run', scopeRef: 'run-mix', value: 10, status: 'reported' }));
  foundation.record(entry({ requestId: 'b-2', scopeLevel: 'run', scopeRef: 'run-mix', value: 5, status: 'estimated', source: 'caller', estimator: 'chars-ceil-v1' }));
  const mixed = foundation.budget({ scopeLevel: 'run', scopeRef: 'run-mix', kind: 'modelInput', limit: 100 });
  assert.equal(mixed.used, 15);
  assert.equal(mixed.certainty, 'estimated', 'a sum containing an estimate is an estimate');
  assert.equal(mixed.over, false);
  foundation.record(entry({ requestId: 'b-3', scopeLevel: 'run', scopeRef: 'run-hole', value: null, status: 'unavailable', source: 'none' }));
  foundation.record(entry({ requestId: 'b-4', scopeLevel: 'run', scopeRef: 'run-hole', value: 9, status: 'reported' }));
  const hole = foundation.budget({ scopeLevel: 'run', scopeRef: 'run-hole', kind: 'modelInput', limit: 100 });
  assert.equal(hole.used, null, 'a scope containing an unavailable figure has no derivable total');
  assert.equal(hole.certainty, 'unavailable');
  assert.equal(hole.over, null);
});

/* ================================================================ *
 * Cost — pricing basis + declared rule, or nothing
 * ================================================================ */

test('reported usage + known pricing + declared rule yields a calculated cost', () => {
  const cost = calculateCost({
    usage: {
      modelInput: { value: 1000, certainty: 'reported' },
      output: { value: 500, certainty: 'reported' },
    },
    pricingBasis: pricing,
    rule: 'linear-input-output',
  });
  assert.equal(cost.value, 1000 * 0.5 + 500 * 0.25);
  assert.equal(cost.certainty, 'calculated');
  assert.equal(cost.rule, 'linear-input-output');
});

test('missing pricing basis is unavailable — never a guessed rate, never a zero bill', () => {
  const usage = {
    modelInput: { value: 1000, certainty: 'reported' },
    output: { value: 500, certainty: 'reported' },
  };
  const noPricing = calculateCost({ usage, pricingBasis: null, rule: 'linear-input-output' });
  assert.equal(noPricing.value, null, 'no pricing, no number');
  assert.equal(noPricing.certainty, 'unavailable');
  assert.equal(noPricing.reason, 'pricing-unavailable');
  // a missing rate inside an otherwise-present basis behaves identically
  const halfBasis = calculateCost({
    usage, pricingBasis: { costPerInputToken: 0.5 }, rule: 'linear-input-output',
  });
  assert.equal(halfBasis.certainty, 'unavailable');
  assert.equal(halfBasis.value, null);
});

test('estimated input makes the cost estimated — never labelled actual/calculated', () => {
  const cost = calculateCost({
    usage: {
      modelInput: { value: 1000, certainty: 'estimated' },
      output: { value: 500, certainty: 'reported' },
    },
    pricingBasis: pricing,
    rule: 'linear-input-output',
  });
  assert.equal(cost.value, 625, 'the arithmetic still runs…');
  assert.equal(cost.certainty, 'estimated', '…but the label follows the least-certain input');
});

test('unavailable usage or an unknown rule refuses fabrication at the door', () => {
  assert.equal(calculateCost({
    usage: { modelInput: null, output: { value: 500, certainty: 'reported' } },
    pricingBasis: pricing, rule: 'linear-input-output',
  }).reason, 'usage-unavailable');
  assert.equal(calculateCost({
    usage: {
      modelInput: { value: null, certainty: 'unavailable' },
      output: { value: 500, certainty: 'reported' },
    },
    pricingBasis: pricing, rule: 'linear-input-output',
  }).certainty, 'unavailable');
  assert.throws(() => calculateCost({
    usage: {
      modelInput: { value: 1, certainty: 'reported' },
      output: { value: 1, certainty: 'reported' },
    },
    pricingBasis: pricing, rule: 'heuristic-vibes',
  }), (error) => {
    assert.equal(error.code, 'lego.contract_violation');
    return true;
  });
  // message cannot enter the calculation — it is a subset of modelInput
  assert.throws(() => calculateCost({
    usage: {
      message: { value: 5, certainty: 'reported' },
      modelInput: { value: 10, certainty: 'reported' },
      output: { value: 1, certainty: 'reported' },
    },
    pricingBasis: pricing, rule: 'linear-input-output',
  }), /only modelInput and output/);
  // a reported zero-price model is known pricing — 0 rate is a price, not a hole
  const free = calculateCost({
    usage: {
      modelInput: { value: 1000, certainty: 'reported' },
      output: { value: 500, certainty: 'reported' },
    },
    pricingBasis: { costPerInputToken: 0, costPerOutputToken: 0 },
    rule: 'linear-input-output',
  });
  assert.equal(free.value, 0);
  assert.equal(free.certainty, 'calculated', 'a declared free price is known pricing');
});

/* ================================================================ *
 * Identity — idempotent records, deterministic retries
 * ================================================================ */

test('duplicate submission with the same identity never double-counts', () => {
  const { foundation, ids } = harness();
  const first = foundation.record(entry());
  const countAfterFirst = foundation.query().length;
  const idsAfterFirst = ids();
  const retry = foundation.record(entry());
  assert.deepEqual(retry, first, 'retry returns the byte-identical record');
  assert.equal(foundation.query().length, countAfterFirst, 'the store did not grow');
  assert.equal(ids(), idsAfterFirst, 'no id was minted for a retry — no counter advances on replay');
  const aggregate = foundation.budget({ scopeLevel: 'call', scopeRef: 'call-1', kind: 'modelInput', limit: 10_000 });
  assert.equal(aggregate.used, 412, 'counted once');
  assert.equal(aggregate.recordCount, 1);
});

test('the same identity with a different payload is refused, never overwritten', () => {
  const { foundation } = harness();
  foundation.record(entry());
  assert.throws(() => foundation.record(entry({ value: 99_999 })), (error) => {
    assert.equal(error.code, 'lego.contract_violation');
    assert.equal(error.meta.reason, 'request-id-reuse');
    return true;
  });
  const [still] = foundation.query({ requestId: 'req-0001' });
  assert.equal(still.value, 412, 'the original record is untouched');
});

test('identity and shape are closed: missing identity, unknown fields and bad bounds refuse', () => {
  const { foundation } = harness();
  assert.throws(() => foundation.record({ ...entry(), requestId: undefined }), /requestId/);
  assert.throws(() => foundation.record(entry({ requestId: 'x'.repeat(USAGE_LIMITS.maxRequestIdLength + 1) })), /requestId/);
  assert.throws(() => foundation.record(entry({ scopeLevel: 'decade' })), /scopeLevel/);
  assert.throws(() => foundation.record(entry({ kind: 'promptTokens' })), /kind/);
  assert.throws(() => foundation.record(entry({ unit: 'bytes' })), /unit/);
  assert.throws(() => foundation.record(entry({ status: 'probably-reported' })), /status/);
  assert.throws(() => foundation.record(entry({ value: -1 })), /non-negative/);
  assert.throws(() => foundation.record(entry({ value: 1.5 })), /safe integer/);
  assert.throws(() => foundation.record(entry({ mystery: true })), /closed|mystery/);
  assert.throws(() => foundation.query({ nope: 1 }), /query filter/);
});

/* ================================================================ *
 * Security / privacy — no content, no secrets, truthful detector
 * ================================================================ */

test('prompt, completion, reasoning and credential fields can never enter a record', () => {
  const { foundation } = harness();
  for (const field of ['prompt', 'completion', 'reasoning', 'credential', 'apiKey', 'authorization']) {
    assert.ok(FORBIDDEN_USAGE_FIELDS.includes(field), `${field} is on the forbidden list`);
    assert.throws(() => foundation.record(entry({ [field]: 'captured material' })), (error) => {
      assert.equal(error.meta.field, field, `the refusal names the field: ${field}`);
      assert.ok(!error.message.includes('captured material'), 'the refusal never echoes the content value');
      return true;
    });
  }
  // and the stored record's keys are exactly the declared shape
  const stored = foundation.record(entry());
  assert.deepEqual(Object.keys(stored).sort(), [...TOKEN_USAGE_FIELDS].sort());
  const text = JSON.stringify(foundation.query());
  for (const word of ['prompt', 'completion', 'reasoning', 'Bearer', 'credential']) {
    assert.ok(!text.includes(`"${word}"`), `records never carry the key ${word}`);
  }
});

test('credential-shaped identifiers refuse — full canonical forms, not bare prefixes', () => {
  const { foundation } = harness();
  const fixtures = [
    `ghp_${'A'.repeat(36)}`,
    `github_pat_${'B'.repeat(22)}`,
    `sk-${'C'.repeat(24)}`,
    'Bearer DDDDDDDDDDDDDDDDDDDDDD',
  ];
  for (const secret of fixtures) {
    assert.equal(SENSITIVE_USAGE_RE.test(secret), true, `detector catches the full form: ${secret.slice(0, 12)}…`);
    // every fixture is refused as a record identity — either it is caught as
    // credential-shaped, or (Bearer …, carrying a space) it can never satisfy
    // the bounded-identifier grammar in the first place. Either way: refused.
    assert.throws(() => foundation.record(entry({ requestId: secret })), TokenUsageError,
      `requestId refuses ${secret.slice(0, 12)}…`);
    assert.throws(() => foundation.record(entry({ source: secret })), TokenUsageError);
    assert.throws(() => foundation.record(entry({ scopeRef: secret })), TokenUsageError);
  }
  // the space-free canonical forms must specifically hit the credential detector
  for (const secret of fixtures.slice(0, 3)) {
    assert.throws(() => foundation.record(entry({ requestId: secret })), /credential-shaped/);
    assert.throws(() => foundation.record(entry({ source: secret })), /credential-shaped/);
    assert.throws(() => foundation.record(entry({ scopeRef: secret })), /credential-shaped/);
  }
  // a detector literal in this very test file and in the module source must NOT
  // match as a live secret: the scan only fires on full canonical shapes
  assert.equal(SENSITIVE_USAGE_RE.test("the pattern ghp_[A-Za-z0-9]{36} lives in the source"), false,
    'a regex literal is not a credential (no bare-prefix false positive)');
  assert.equal(SENSITIVE_USAGE_RE.test('ghp_short'), false, 'a truncated prefix is not a credential');
  const moduleLiterals = [...MODULE_SOURCE.matchAll(/SENSITIVE_USAGE_RE[\s\S]{0,400}/g)];
  assert.ok(moduleLiterals.length >= 1, 'the module carries the detector');
});

test('the module holds no provider names, no model tooling and no content vocabulary', () => {
  for (const banned of ['openai', 'anthropic', 'deepseek', 'gemini', 'hermes', 'mirofish',
    'openclaw', 'composio', '9router', 'telegram']) {
    assert.ok(!MODULE_SOURCE.toLowerCase().includes(banned), `no ${banned}`);
  }
  // full-shaped values only — detector literals may name the shape, never a live token
  assert.ok(!/ghp_[A-Za-z0-9]{36}/.test(MODULE_SOURCE), 'no embedded GitHub PAT value');
  assert.ok(!/github_pat_[A-Za-z0-9_]{20,}/.test(MODULE_SOURCE), 'no embedded fine-grained PAT');
  assert.ok(!/\bsk-[A-Za-z0-9]{20,}/.test(MODULE_SOURCE), 'no embedded api key value');
  assert.ok(!/Bearer\s+[A-Za-z0-9._-]{20,}/.test(MODULE_SOURCE), 'no embedded bearer token value');
});

/* ================================================================ *
 * Time — injected clock and identity, no ambient sources
 * ================================================================ */

test('the foundation refuses to exist without injected now and newId', () => {
  assert.throws(() => createTokenUsageFoundation({}), /must be injected/);
  assert.throws(() => createTokenUsageFoundation({ now: () => 'x' }), /must be injected/);
  assert.throws(() => createTokenUsageFoundation({ newId: () => 'x' }), /must be injected/);
});

test('records carry only injected time and identity — deterministic across runs', () => {
  const build = () => {
    let seq = 0;
    return createTokenUsageFoundation({ now: () => 'CLOCK', newId: () => `id${++seq}` });
  };
  const a = build().record(entry());
  const b = build().record(entry());
  assert.equal(a.createdAt, 'CLOCK');
  assert.equal(a.recordId, 'id0001'.replace('0001', '1').length ? a.recordId : a.recordId); // pinned below
  assert.match(a.recordId, /^usg-id1$/);
  assert.deepEqual(a, b, 'same injected clock and id sequence ⇒ byte-identical record');
});

/* ================================================================ *
 * Side effects — offline, disk-safe, bounded
 * ================================================================ */

test('static imports are none — zero builtin, zero cross-domain reach', () => {
  const imports = [...MODULE_SOURCE.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(imports, [], 'the module imports nothing at all');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:https', 'node:child_process',
    'node:timers', 'node:worker_threads', 'require(', 'fetch(', 'import(']) {
    assert.ok(!MODULE_SOURCE.includes(forbidden), `forbidden: ${forbidden}`);
  }
  for (const forbidden of ['Math.random', 'new Date(', 'Date.now', 'setTimeout', 'setInterval', 'performance.now']) {
    assert.ok(!MODULE_SOURCE.includes(forbidden), 'no wall clock, timers or randomness — both injected');
  }
});

test('the store is bounded — records never grow without a declared limit', () => {
  const { foundation } = harness();
  let seq = 0;
  assert.throws(() => {
    for (let i = 0; i <= USAGE_LIMITS.maxRecords; i += 1) {
      foundation.record(entry({ requestId: `bulk-${seq += 1}`, scopeRef: `c-${i}` }));
    }
  }, (error) => {
    assert.equal(error.meta.limit, 'maxRecords');
    return true;
  });
  assert.equal(foundation.query().length, USAGE_LIMITS.maxRecords, 'stopped exactly at the bound');
});

test('every published surface is frozen — callers cannot mutate contract vocabulary', () => {
  for (const constant of [TOKEN_USAGE_CONTRACT, TOKEN_USAGE_OPERATIONS, TOKEN_USAGE_PERMISSIONS,
    TOKEN_KINDS, USAGE_STATUSES, USAGE_SCOPES, USAGE_UNITS, COST_RULES, COST_STATUSES,
    TOKEN_USAGE_FIELDS, FORBIDDEN_USAGE_FIELDS, USAGE_LIMITS]) {
    if (typeof constant === 'object' && constant !== null) {
      assert.ok(Object.isFrozen(constant), 'frozen');
    }
  }
  const { foundation } = harness();
  const record = foundation.record(entry());
  assert.ok(Object.isFrozen(record), 'records freeze on arrival');
  assert.ok(Object.isFrozen(foundation.query()), 'query results freeze');
  assert.ok(Object.isFrozen(foundation.budget({ scopeLevel: 'call', scopeRef: 'call-1', kind: 'modelInput', limit: 5 })));
  assert.ok(Object.isFrozen(calculateCost({
    usage: { modelInput: { value: 1, certainty: 'reported' }, output: { value: 1, certainty: 'reported' } },
    pricingBasis: pricing, rule: 'linear-input-output',
  })));
});

/* ================================================================ *
 * Compatibility — P2.13 surface, prior contracts, regression pins
 * ================================================================ */

test('compatibility: prior contracts are read, never modified — pins on their surfaces', () => {
  const agentSource = readFileSync(join(HERE.pathname, '..', 'src', 'lego', 'agent-machine.mjs'), 'utf8');
  assert.equal((agentSource.match(/^export /gm) ?? []).length, 23, 'P2.16 untouched');
  const creatorSource = readFileSync(join(HERE.pathname, '..', 'src', 'lego', 'node-creator.mjs'), 'utf8');
  assert.ok(creatorSource.includes("NODE_CREATOR_CONTRACT = 'node.creator@1.0.0'"), 'P2.23 untouched');
  assert.ok(!creatorSource.includes('ai.token-usage'), 'P2.23 does not know about P2.24 (no reverse coupling)');
  const portabilitySource = readFileSync(join(HERE.pathname, '..', 'src', 'lego', 'node-portability.mjs'), 'utf8');
  assert.ok(portabilitySource.includes("NODE_PORTABILITY_CONTRACT = 'node.portability@1.0.0'"), 'P2.22 untouched');
  const errors = JSON.parse(readFileSync(join(HERE.pathname, '..', 'src', 'lego', 'contracts', 'errors.contract.json'), 'utf8'));
  assert.equal(errors.version, '1.2.0', 'error contract untouched — TokenUsageError reuses lego.contract_violation');
  assert.equal(new TokenUsageError('x').code, 'lego.contract_violation', 'one error family only');
});

test('compatibility: XA-17 interpretation holds — scopes answer per call, per run, per session', () => {
  // The decision record asks which contract publishes usage per call/run/session;
  // this contract answers with those three scope levels and nothing broader.
  assert.deepEqual([...USAGE_SCOPES], ['call', 'run', 'session']);
  const decisions = JSON.parse(readFileSync(
    join(HERE.pathname, '..', '..', '..', 'docs', 'n8n-lego', 'decisions', 'cross-agent-decisions.json'), 'utf8',
  ));
  const x17 = decisions.decisions.find((decision) => decision.id === 'XA-17');
  assert.ok(x17, 'XA-17 is recorded');
  assert.match(x17.finding, /no `ai.usage` capability and no usage row/, 'the finding this milestone answers');
  // per-calls: record under scopeLevel call; per-run/runs; per-session/session — all three queryable
  const { foundation } = harness();
  foundation.record(entry({ requestId: 'xa-call', scopeLevel: 'call', scopeRef: 'c-9' }));
  foundation.record(entry({ requestId: 'xa-run', scopeLevel: 'run', scopeRef: 'r-9' }));
  foundation.record(entry({ requestId: 'xa-session', scopeLevel: 'session', scopeRef: 's-9' }));
  assert.equal(foundation.query({ scopeLevel: 'call' }).length, 1);
  assert.equal(foundation.query({ scopeLevel: 'run' }).length, 1);
  assert.equal(foundation.query({ scopeLevel: 'session' }).length, 1);
});

test('compatibility: calculated status words and error family do not collide with prior vocabularies', () => {
  // COST_STATUSES words live only here; prior contracts keep theirs
  assert.ok(!['reported', 'estimated', 'unavailable'].every((word) => CONTEXT_MANAGER_STATES.includes(word)),
    'context manager states remain their own vocabulary');
  assert.equal(TOKEN_USAGE_CONTRACT.includes('context'), false);
  assert.equal(TOKEN_USAGE_CONTRACT.includes('session'), false);
  // contract id follows the ai.* namespace of the domain
  assert.match(TOKEN_USAGE_CONTRACT, /^ai\.[a-z-]+@\d+\.\d+\.\d+$/);
});
