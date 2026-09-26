# P7-S07 — Plugin/Provider Runtime Boundary

**Issue:** #223 §17, §19, §22, §32-33, §35-36, §42 rung P7.7 (authorized by DEC-0024)
**Status:** in-progress until delivery merge + post-merge verification (DEC-0014, DEC-0015)
**Branch:** `delivery/p7-s07-provider-boundary`
**Contract:** domain `dynamic-parameters` (owner `agent-4`), module `src/lego/parameter-provider-boundary.mjs`
**Gate:** DEC-0025 temporary gate in force (self-hosted fleet offline; GitHub-hosted green is the effective merge gate)

## 1. What was delivered

`apps/n8n-lego/src/lego/parameter-provider-boundary.mjs`: the **boundary** slice — it fixes what a
provider/plugin may declare and carry across the P7 boundary, and what P7 will NOT become. P7 owns
parameter resolution; P6 owns node/runtime admission and trust; P8 owns storage; P9 owns
observability. This module enforces those seams.

| #223 § | Requirement | Where it is met |
|---|---|---|
| §17/§33 | a provider may live in a node/plugin, but registration must DECLARE identity, version, capability requirements, locality, runtime trust class, resource budgets; P7 does not import vendor models into public contracts; P6 owns admission/trust, P7 owns resolution | `registerProvider`: validates the full declaration (rejecting incomplete/malformed), normalizes to a frozen canonical descriptor, and **excludes** vendor-specific business-model fields; the trust class is declared + validated (not admitted) |
| §22 | a base schema + a bounded provider fragment (versioned, size-bounded, validated, capability-scoped, cacheable, replaceable); a provider cannot replace the canonical P7 contract or security model | `validateProviderSchemaFragment`: enforces versioned/size-bounded/capability-scoped/cacheable; a fragment carrying a security/canonical override field is rejected (`SCHEMA_FRAGMENT_SECURITY_OVERRIDE`); the base schema is always authoritative |
| §32 | existing node definitions work without mandatory rewrite: accept the canonical n8n declaration, compile, preserve supported fields, reject only truly invalid/unsafe forms, expose diagnostics, fallback only where required; P7 is a compatibility layer, not a new authoring language | `compileCommunityNodeDeclaration`: preserves `SUPPORTED_NODE_FIELDS`, downgrades unsupported fields to diagnostics (warnings, not rejections), rejects only non-object / missing-name, and applies fallbacks (type→name, parameters→{}, typeVersion→1) only where upstream semantics require it |
| §35 | P7 does not become P8: only bounded derived/cache state belongs here; canonical workflows and durable records stay in their proper domains | `assertBoundedDerivedState`: rejects canonical/durable markers (`workflows`/`connections`/`durable`/`persistent`) and unbounded state (`STORAGE_BOUNDARY_VIOLATION`); accepts bounded derived state within the size limit |
| §36 | emit bounded P9 events from a closed set; never emit secret material or full sensitive parameter payloads | `createObservabilitySink` + `OBSERVABILITY_EVENTS` (the 9-event closed set); the sink is bounded (max events), rejects unknown events (`EVENT_INVALID`), and scrubs any secret material from payloads (reusing P7-S06 `scrub`) |

## 2. Design decisions worth recording

- **The descriptor is the public contract; vendor models are excluded (§17).** `registerProvider`
  returns a frozen descriptor carrying ONLY the canonical fields (id, version, capabilities,
  locality, trustClass, budgets). Any vendor-specific field is dropped, so P7 never imports a
  vendor business model into a public parameter contract. Capabilities and budgets are normalized
  (sorted) for determinism.
- **Trust is declared, not admitted (§33).** The trust class must be one of
  `PROVIDER_TRUST_CLASSES` (local/node/application/remote) and is validated, but **admission and
  trust decisions are P6's** — P7 only owns parameter resolution. This keeps the P6/P7 seam clean.
- **A provider cannot override security (§22).** `validateProviderSchemaFragment` rejects any
  fragment carrying a security/canonical override field (`security`/`authorization`/`auth`/
  `credentials`/`canonical`/`permission`/`policy`). The base schema is always authoritative
  (`baseAuthoritative: true`); the fragment is a bounded, versioned, capability-scoped, cacheable,
  replaceable add-on.
- **Compatibility, not authoring (§32).** Unsupported node fields are **diagnostics** (warnings)
  preserved as opaque metadata, never rejections — so existing nodes work without mandatory
  rewrite. Only truly invalid/unsafe forms (non-object, missing/invalid name) are rejected.
  Fallbacks are applied only where upstream semantics require them, each with a reason.
- **Bounded, scrubbed observability (§36).** The sink emits only the closed 9-event set, is bounded
  (max events retained), rejects unknown events, and scrubs secret material from every payload
  (reusing the P7-S06 `scrub` — no second redaction subsystem).

## 3. Verification

- **New unit suite** `test/lego-parameter-provider-boundary.test.mjs`: **17/17 pass**
  (`node --test apps/n8n-lego/test/lego-parameter-provider-boundary.test.mjs`).
- **Architecture gate** `npm run lego:arch`: OK — the module is registered in the
  `dynamic-parameters` domain (`manifest/domains.json` `paths` + `contract.tests`), 100 locked
  public contracts, every import respects its declared boundary.
- **Full LEGO gate** `npm run lego:gate`: arch / scaleout / ai:check green (the `lego:test`
  quoted-glob step is a local Node 20 limitation; CI's Node expands it — the full backend suite is
  run directly and is clean).
- **Full backend suite** `node --test apps/n8n-lego/test/`: clean except the pre-existing
  catalog/REST tests that require `N8N_LEGO_CATALOG_DIR` (CI-provided).

## 4. Boundary

P7-S07 is the provider/plugin **boundary** semantics. It does NOT implement a provider, a
credential store, an admission/trust system (P6), a storage engine (P8), or an observability
backend (P9); it changes no Rust, workflow, Cargo, runner, contract, or `packages/` file.
