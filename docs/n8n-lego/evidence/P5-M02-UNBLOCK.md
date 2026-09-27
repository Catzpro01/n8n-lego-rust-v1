# P5-M02 Unblock Evidence — Credential runtime integration (SecretRef over the P2.27 broker)

Date: 2026-09-27. Unblock performed in the post-merge governance reconciliation after delivery PR #355.

## 1. Root cause (what kept it blocked — from the register's `blockedBy`)

> "Needs a credential-consuming node in the execution path: engine node-registry.mjs exposes only the
> manual node set, so there is no legitimate integration consumer. The smallest consumer is scoped as
> P6-S05 (proposed, not authorized) ... Stays blocked until authorization exists."

Two conditions: (a) no credential-consuming node existed in the execution path, (b) no owner
authorization for the smallest consumer.

## 2. Root-cause elimination (both conditions)

- (b) Owner master prompt REQ-0003 section 6 authorizes P6-S05 explicitly (minimal credential-consuming
  node, option 2), and section 7 sets the P5-M02 completion rule ("when it is wired through the chain
  above, unblock immediately").
- (a) P6-S05 is delivered and merged: `n8n-nodes-base.httpRequest` now exists in
  `packages/reconstructed-engine/node-registry.mjs`, wired through exactly one canonical resolution
  path: workflow node → `credentialRef` → SecretRef → P2.27 Secret Broker → resolve → HTTP node →
  `Authorization` header → target.

## 3. Implementation SHA (post-merge)

- Delivery PR: #355 ("P6-S05 delivery: minimal credential-consuming node + SecretRef->broker chain").
- Merge commit (main): `d549d40d83d29276fb2a6c565f68cb93bfc2d6e4`.
- Runtime integration glue: `apps/n8n-lego/src/lego/credential-runtime.mjs` (`createCredentialRuntime`,
  `CredentialResolutionError` `CREDENTIAL_*`, `asContext`) — the single canonical path; no second
  credential-resolution path exists (section 6 requirement).

## 4. Tests (integration regression ran BEFORE and AFTER the change)

- Integration suite: `apps/n8n-lego/test/lego-credential-chain.test.mjs` — 15/15 against a real
  `node:http` mock server (the chain proven end to end at the server-seen header).
- Before merge (PR head `c657f2e4` battery): lego 2909/2909 (incl. the 15 chain tests), engine 49/49,
  runtime 79/79, lego:gate 0, isolation:check 0, decisions-check 0, ai:check 0.
- After merge (main `d549d40d` battery): identical counts, all green.

## 5. Acceptance list mapping (docs/n8n-lego/evidence/P5-M02-FOUNDATION.md §"Exact acceptance list")

| # | Acceptance | Evidence |
|---|------------|----------|
| 1 | One node type with a credential-consuming operation | `n8n-nodes-base.httpRequest` (auth modes none/httpBearerAuth/httpHeaderAuth) |
| 2 | SecretRef → P2.27 Secret Broker → credential resolution → execution path → real node consumer | chain tests (server-seen `Authorization: Bearer` / `X-Api-Key`) |
| 3 | Explicit failure when the reference is missing, invalid, or unauthorized | negative matrix: missing ref, missing material, empty token, unauthorized grant, malformed ref, broker failure, target failure, wrong kind |
| 4 | Raw secret values never enter workflow data, execution data or logs | sentinel `P6S05-SENTINEL-SECRET-7c2d` leak sweep over workflow JSON, execution output, error objects, warnings |
| 5 | Full regression: unit (resolution, failure matrix, lifetime) + integration | engine unit + fixture tests (11 cases) + chain 15/15 (incl. single-use, replay refusal, TTL refusal at authority level) + full battery before/after |
| 6 | One delivery PR with rollback path | PR #355 (single delivery PR); rollback = removing the one registry entry + its handler import; no schema/data migration |

## 6. Master prompt §7 completion rule (implemented)

- (1) Success path documented + tested: §2 of P6-S05-EVIDENCE.md + chain success cases. ✓
- (2) Missing/unauthorized/invalid documented + tested: §4 deviations D1-D2 + negative matrix. ✓
- (3) Secret-redaction documented + tested: §2 item 7 + leak sweep. ✓
- (4) Integration regression runs before and after the change: §4 above. ✓

## 7. Dependencies (status at unblock)

- P2.27 Secret Broker (`createSecretBroker`, capability mint/redeem): ready and exercised. ✓
- P6-S05 (minimal consumer + chain): implemented, merge `d549d40d`. ✓
- DEC-0028 (credential path decisions): ACTIVE (option A-injected-transport, decidedBy OWNER). ✓
