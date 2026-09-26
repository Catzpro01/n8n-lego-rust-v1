# P7-S06 — Credential-Aware Resolution

**Issue:** #223 §18, §19, §28, §27, §34, §42 rung P7.6 (authorized by DEC-0024)
**Status:** in-progress until delivery merge + post-merge verification (DEC-0014, DEC-0015)
**Branch:** `delivery/p7-s06-credential-resolution`
**Contract:** domain `dynamic-parameters` (owner `agent-4`), module `src/lego/parameter-credential.mjs`
**Gate:** DEC-0025 temporary gate in force (self-hosted fleet offline; GitHub-hosted green is the effective merge gate)

## 1. What was delivered

`apps/n8n-lego/src/lego/parameter-credential.mjs`: credential/security composition for dynamic
lookups that need credentials. P7 **never stores raw credential material** — the material is held
in-memory only for the duration of one narrowly scoped operation, and the no-leak invariant (the
plaintext must never appear in a ParameterPlan, cache, parameter history, logs, telemetry, error
payload, or schema snapshot) is enforced structurally **and** by redaction.

| #223 § | Requirement | Where it is met |
|---|---|---|
| §18 | authorization -> request-bound SecretRef -> P2.27 Secret Broker -> narrowly scoped provider operation -> normalized result; P7 never stores raw material | `createSecretRef` (the only credential handle) + `CredentialResolutionSession.resolve` composing `checkCapability` -> `broker.resolve` -> `provider.invoke` -> normalized result; the material is in-memory only |
| §18 | credential plaintext never in ParameterPlan / cache / history / logs / telemetry / error payloads / schema snapshots | the cache key is over the SecretRef **scope** (never the material); the cache stores only the normalized result; `scrub` + `secretStrings` redact any echoed material from results **and** error payloads; pinned by leak-detection tests |
| §19 | principal -> tenant -> capability -> action -> resource -> SecretRef -> provider enforced before the provider call; option visibility does not grant permission; provider metadata cannot grant itself authority | `checkCapability` (fail-closed, injectable P5 decision) runs **before** the provider call; a denied capability is a marked `CAPABILITY_DENIED` and the provider is never called; the resolved `security.authority` is the original scope (provider elevation fields are ignored) |
| §28 | security-sensitive / execution-authoritative values require revalidation; a cached UI option never becomes authority | results are marked `security: { sensitive: true, revalidationRequired: true }`; an `authoritative` resolution drops the cache and always revalidates (never serves a cached UI option as authority) |
| §27 | a provider/auth failure is a closed, marked failure — never a fake empty success | `CREDENTIAL_FAILURE_CODES` (AUTH_REQUIRED/AUTH_REJECTED/CAPABILITY_DENIED/CREDENTIAL_LEAK/UNAVAILABLE/TIMEOUT/INVALID_PROVIDER_DATA/REVALIDATION_REQUIRED/...); a failure returns `options: []` **with** a non-null `error` |

## 2. Design decisions worth recording

- **The SecretRef is the only credential handle (§18).** A lookup may carry a
  `createSecretRef({ credentialId, principal, tenant, capability, action, resource })` — an
  immutable, opaque, request-bound reference. It **rejects** any plaintext field
  (`secret`/`password`/`token`/`value`/...) with `CREDENTIAL_LEAK`. The ref is safe to log (only
  its scope fields); the material goes through the Secret Broker, never the ref.
- **The broker and provider are explicit, replaceable objects.** `createInMemorySecretBroker`
  holds material in memory only (never persisted/logged) and refuses an unknown credentialId
  (`AUTH_REJECTED`); `createInMemoryCredentialProvider` is the narrowly scoped operation. The real
  P2.27 Secret Broker and remote providers are injected at the composition root (P7-S07 boundary).
- **Capability is checked before the provider call (fail-closed, §19).** `checkCapability` uses an
  injectable P5 authorization decision; a missing authorizer or a denied decision is
  `CAPABILITY_DENIED` and the provider is **never** invoked. Option visibility is not permission.
- **Authority is the original scope, not provider metadata (§19).** The resolved
  `security.authority` is frozen to the SecretRef scope; any `grantedCapability`/`tenant`/etc. in a
  provider result is ignored (provider-returned metadata cannot grant itself new authority).
- **No-leak is structural + redaction (§18).** The material never enters the cache key or the
  cached value (structural). Additionally, `scrub` redacts any echoed material from the returned
  result **and** error payloads (a provider that leaks the credential into an error message is
  scrubbed to `[REDACTED]`). The material is carried for scrubbing only for the duration of the
  operation, then discarded.

## 3. Verification

- **New unit suite** `test/lego-parameter-credential.test.mjs`: **18/18 pass**
  (`node --test apps/n8n-lego/test/lego-parameter-credential.test.mjs`).
- **Architecture gate** `npm run lego:arch`: OK — the module is registered in the
  `dynamic-parameters` domain (`manifest/domains.json` `paths` + `contract.tests`), 100 locked
  public contracts, every import respects its declared boundary.
- **Full LEGO gate** `npm run lego:gate`: arch / scaleout / ai:check green (the `lego:test`
  quoted-glob step is a local Node 20 limitation; CI's Node expands it — the full backend suite is
  run directly and is clean).
- **Full backend suite** `node --test apps/n8n-lego/test/`: clean except the pre-existing
  catalog/REST tests that require `N8N_LEGO_CATALOG_DIR` (CI-provided).

## 4. Boundary

P7-S06 is the credential/security **composition** semantics. It does NOT implement a credential
store, an authentication system, or the P5 authorization policy (those are injected); it does not
define the plugin/provider admission boundary (P7-S07); and it changes no Rust, workflow, Cargo,
runner, contract, or `packages/` file.
