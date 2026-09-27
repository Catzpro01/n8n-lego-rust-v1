# P5-M02 Foundation - Smallest Credential-Consuming Node (REQ-0003 section 7)

**Status:** acceptance proposal prepared (P6-S05 PROPOSED, not authorized)
**Purpose:** an actionable foundation path for P5-M02 without starting implementation.

## Verified dependency audit (main e7a72b4f)

- Engine node registry (`packages/reconstructed-engine/node-registry.mjs`) exposes
  only the manual node set: manualTrigger, start, noOp, set, code, function,
  functionItem. None consumes a credential - there is no legitimate integration
  consumer in the execution path (this is the P5-M02 blocker, unchanged).
- SecretRef plumbing exists: `apps/n8n-lego/src/auth/security/secret-ref.mjs`,
  `credential-envelope.mjs`, and `apps/n8n-lego/src/lego/parameter-credential.mjs`
  documents the chain: P5 authorization -> request-bound SecretRef -> P2.27 Secret
  Broker -> narrowly scoped credential at execution.
- P6-S04 ("Native high-performance node catalog", #116) is **proposed**. Per owner
  rule, "proposed" is not authorization.

## Determination: dedicated child, not P6-S04

P6-S04 scope is the native high-performance catalog (candidates N1-N12); the P5-M02
need is a minimal integration consumer exercising the SecretRef/broker path. Mixing
them would couple a contract exercise to a performance catalog. Determination: a
dedicated minimal child slice **P6-S05** (proposed), smallest legitimate consumer.

## Exact acceptance list (smallest authorized implementation)

1. One node type with a credential-consuming operation (e.g. HTTP-ish request with
   auth header from a credential), registered through the engine node-registry path.
2. SecretRef -> P2.27 Secret Broker -> credential resolution -> execution path ->
   real node consumer - end to end, through the canonical broker, no parallel path.
3. Explicit failure when the reference is missing, invalid, or unauthorized
   (no empty success, no silent fallthrough).
4. Raw secret values never enter workflow data, execution data or logs (engine
   assertion + test).
5. Full regression suite: unit (resolution, failure matrix, lifetime) + integration
   (node execution with and without credential) + existing suites unchanged.
6. One delivery PR with rollback path (feature-gated node registration; removal
   restores the manual node set).

## Authorization request

Requested: authorize P6-S05 as scoped above (owner master prompt or explicit owner
approval of this proposal). Until then P5-M02 stays blocked and no node code is
written. #116/P6-S04 authorization, if granted separately, does NOT implicitly
authorize P6-S05 and vice versa.
