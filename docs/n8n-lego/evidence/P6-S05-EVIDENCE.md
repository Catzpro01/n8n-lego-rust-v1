# P6-S05 Evidence — Minimal credential-consuming node (SecretRef integration path)

Slice: P6-S05 — Minimal credential-consuming node for the SecretRef integration path.
Owner authorization: master prompt REQ-0003 section 6 (option 2: minimal consumer).
Date: 2026-09-27. Contract version: `http-request-contract.json` `contractVersion: p1`.

## 1. Reference (component / version / commit)

- Reference repository: `n8n/n8n` tag **`2.9.4`** (source checked out under `reference/n8n/`).
- Components copied as behavior sources:
  - `packages/nodes-base/nodes/HttpRequest/V2/HttpRequestV2.node.ts` — main-branch contract of the
    credential-consuming HTTP node: `typeVersion: 2`, `credentials: { httpBearerAuth | httpHeaderAuth |
    genericCredentialType }`, auth modes `none | httpBearerAuth | httpHeaderAuth`, request build/execute,
    per-item execution, response/error semantics.
  - `packages/nodes-base/nodes/HttpRequest/V1/HttpRequestV1.node.ts`, `V3/HttpRequestV3.node.ts` —
    versioned behavior (V3 is the default in current n8n).
  - `packages/nodes-base/nodes/HttpRequest/GenericFunctions.ts` — request helpers, response handling,
    error surfaces.
  - `packages/nodes-base/credentials/HttpBearerAuth.credentials.ts` — `name: 'httpBearerAuth'`, `token`
    property; secret is sent as `Authorization: Bearer <token>`.
  - `packages/nodes-base/credentials/HttpHeaderAuth.credentials.ts` — `name: 'httpHeaderAuth'`, `name` +
    `value`; secret is sent as a caller-named header.

## 2. Behavior extracted (what was frozen)

1. **Node contract** — a credential-consuming node exposes named credential types; execution resolves the
   credential and places the secret material only in the outgoing HTTP request.
2. **Credential semantics** — bearer: `Authorization: Bearer <token>`; header auth: `<name>: <value>`.
3. **Auth modes** — `none | httpBearerAuth | httpHeaderAuth` at contract p1.
4. **Request construction** — method + URL + headers + body (JSON or raw), one request per input item,
   literal parameters only (expressions refused at p1).
5. **Error semantics** — every failure is explicit and distinguishable; there is no empty success.
6. **Serialization** — response returned as structured JSON (`status`, `headers` allowlist, `body`).
7. **Sensitive-data handling** — the raw secret never appears in workflow JSON, execution output, error
   objects, warnings, or evidence.
8. **Fixtures/compat** — the contract fixture file (`fixtures/http-request-contract.json`) is the
   replayable parity input for the Rust implementation.

## 3. Scope copied vs main branch (explicit)

Copied at p1: auth modes `none/httpBearerAuth/httpHeaderAuth`; JSON + raw body; literal parameters;
one request per item; explicit error set.

Not copied at p1 (main-branch features deliberately out of scope): generic OAuth2/OAuth1, predefined
credential types beyond bearer/header, cookie handling, batching/pagination, option `fullResponse`,
n8n expression evaluation in node parameters, retry/backoff policies, proxy options, binary data.

## 4. Deviations (documented, tested)

| # | Deviation | Reason |
|---|-----------|--------|
| D1 | Error codes are a closed namespaced set `HTTP_REQUEST_INVALID_PARAMETERS \| HTTP_REQUEST_CREDENTIAL_MISSING \| HTTP_REQUEST_CREDENTIAL_UNAUTHORIZED \| HTTP_REQUEST_CREDENTIAL_INVALID \| HTTP_REQUEST_CREDENTIAL_MALFORMED_REF \| HTTP_REQUEST_CREDENTIAL_BROKER_FAILURE \| HTTP_REQUEST_TARGET_REQUEST_FAILURE`. n8n raises plain messages (`NodeApiError` etc.). | Error codes belong in the contract: consumers can branch on a published code (LEGO F16 discipline), and Rust parity can mirror the set exactly. |
| D2 | `validateParameters` runs **before** credential resolution. n8n interleaves parameter evaluation with credential lookup. | A malformed request must not touch the Secret Broker (least privilege, deterministic failure order). Tested. |
| D3 | The HTTP transport is an injected seam (`http-transport.mjs`: `request({method,url,headers,body}) -> {status,headers,body}`; `TransportError{kind:network\|timeout}`) instead of an inline `axios` call. | The registry stays deterministic (existing 30/30 registry guarantee), the chain is testable against a real local server, and the seam is the JS↔Rust parity boundary. `createFetchTransport` is the real-fetch implementation with AbortController timeout. |
| D4 | `shapeResponse` strips `set-cookie` and any `authorization`-like response headers from the output envelope. | Sensitive-data rule: response echoes must not re-introduce secrets into execution output. |
| D5 | HTTP status ≥ 300 is returned as a result item (`status`, body) — network/transport failures throw `HTTP_REQUEST_TARGET_REQUEST_FAILURE`. | n8n returns non-2xx as data when `neverError` semantics apply; at p1 the status is data and only transport failure is an execution error. |

## 5. Deliverables + tests

| Artifact | Path |
|----------|------|
| Transport seam | `packages/reconstructed-engine/http-transport.mjs` |
| Node handler | `packages/reconstructed-engine/http-request.mjs` |
| Registry integration | `packages/reconstructed-engine/node-registry.mjs` (`n8n-nodes-base.httpRequest`, `httpTransport`/`credentials` seams) |
| Contract fixture (Rust parity input) | `packages/reconstructed-engine/fixtures/http-request-contract.json` (11 cases, sentinel `P6S05-SENTINEL-SECRET-7c2d`, provenance block) |
| Engine tests | `packages/reconstructed-engine/test/04-http-request.test.mjs` — 19 new (unit + fixture replay + redaction + seam) |
| Credential runtime glue (canonical path for P5-M02) | `apps/n8n-lego/src/lego/credential-runtime.mjs` (`createCredentialRuntime`, `CredentialResolutionError` `CREDENTIAL_*`, `asContext`) |
| Integration chain tests | `apps/n8n-lego/test/lego-credential-chain.test.mjs` — 15 tests |

Test counts at delivery: engine **49/49** (30 baseline + 19 new), lego suite **2909/2909**
(2894 baseline + 15 new), frontend **672/672**, `lego:gate` green (incl. foundation F16 error-code
publication check), `isolation:check` green, `decisions-check` green.

### Integration chain proof (apps/n8n-lego/test/lego-credential-chain.test.mjs)

The chain is exercised against a **real** `node:http` mock server bound to 127.0.0.1 (the test proves
the loopback address, not a fake): workflow node → `credentialRef` → SecretRef → P2.27 Secret Broker →
resolve → HTTP node → `Authorization` header → server.

- Bearer auth reaches the server as `Authorization: Bearer P6S05-SENTINEL-SECRET-7c2d`; header auth as
  `X-Api-Key: <secret>`.
- Negative matrix (all explicit, no empty success): missing ref, missing material, empty token,
  unauthorized capability grant (`NOT_ALLOWED`), malformed ref (`parse`), broker failure
  (`CREDENTIAL_BROKER_FAILURE`), target transport failure (`HTTP_REQUEST_TARGET_REQUEST_FAILURE`),
  wrong credential kind (`HTTP_REQUEST_CREDENTIAL_INVALID`).
- Leak sweep: the sentinel secret is absent from workflow JSON, execution output JSON, error objects and
  warnings (and surfaces only in the server-side header, where it belongs).
- Authority proofs: secret material is single-use (liveCount back to baseline), replay denied
  (`ref.already_redeemed`), TTL expiry refused at authority level.
- Round-trips: workflow JSON and execution JSON round-trip preserve the safe shape.

## 6. Rust readiness (contract-first, per §16)

1. Reference frozen → `fixtures/http-request-contract.json` (replayable input) → JS implementation →
   contract tests (JS) → future Rust implementation replays the same fixture → parity harness compares
   outputs incl. the closed error-code set → cutover after parity.
2. No JS-only behavior beyond the documented deviations D1–D5.

## 7. P5-M02 relationship (why this slice unblocks it)

`apps/n8n-lego/src/lego/credential-runtime.mjs` is the **single canonical resolution path** P5-M02 must
use (master prompt §6: "P5-M02 must use exactly this path and must not add a second credential-resolution
path"). Its acceptance list (missing/unauthorized/invalid credentials, redaction, workflow/execution
round-trips, integration regression) is covered by the 15 chain tests above. P5-M02 unblock therefore
references this evidence + the merged implementation SHA and follows the §7 completion rule
(`implemented` only after integration regression lands — it has landed as the chain suite).
