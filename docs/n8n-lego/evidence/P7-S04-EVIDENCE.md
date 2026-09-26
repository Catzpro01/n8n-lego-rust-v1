# P7-S04 — Dynamic Options Runtime

**Issue:** #223 §11, §14-16, §23-26, §34, §42 rung P7.4 (authorized by DEC-0024)
**Status:** in-progress until delivery merge + post-merge verification (DEC-0014, DEC-0015)
**Branch:** `delivery/p7-s04-dynamic-options`
**Contract:** domain `dynamic-parameters` (owner `agent-4`), module `src/lego/parameter-discover.mjs`
**Gate:** DEC-0025 temporary gate in force (self-hosted fleet offline; GitHub-hosted green is the effective merge gate)

## 1. What was delivered

`apps/n8n-lego/src/lego/parameter-discover.mjs`: stage 4 (**DISCOVER**) of the five-stage
P7 pipeline (#223 §4) — the only stage allowed to cross a provider/network boundary, and
only under explicit capability + resource policy. It resolves a dynamic option source into
a bounded, normalized option list, caches it, and protects the instance from slow, broken
or malicious providers.

| #223 § | Requirement | Where it is met |
|---|---|---|
| §11 | parameter → loadOptionsMethod → resolved dependency context → provider operation → normalized option list; malformed provider data rejected, never passed to UI | `DynamicOptionsSession.resolve` over an explicit provider; `normalizeOptionList` reduces results to the canonical `{ name, value, description? }` shape and throws `INVALID_PROVIDER_DATA` on a malformed list/entry |
| §14-15 | bounded, keyed cache with explicit classes; never caches credentials/secrets | `cacheKey` (nodeType + nodeVersion + parameterPath + methodName + normalizedDependencyDigest + normalizedSearchQuery + providerVersion + schemaVersion); `DynamicCache` (bounded LRU) with `STATIC/SESSION/REQUEST/PROVIDER/NEGATIVE` classes and per-class TTL; stores only normalized options |
| §16 | stale-while-revalidate is display-only; authoritative values revalidated; cached UI never authority | a non-authoritative request serves a stale PROVIDER value within the SWR window + triggers a coalesced background revalidation; an `authoritative` resolution never serves stale |
| §24-25 | race protection (requestId + generation + dependency digest); request coalescing | each issued provider call bumps the generation and the result carries it; a dependency-digest change produces a distinct cache key; identical concurrent requests share one in-flight op |
| §26, §34 | concurrency bound, deadline/timeout, max result count, retry budget, negative cache; one slow provider cannot consume the whole budget | `DISCOVER_LIMITS` (maxConcurrency, timeoutMs, maxResultCount, retryBudget=0, negativeTtlMs, providerTtlMs, staleWindowMs); a failing/slow provider is negatively cached (no retry storm) and reported as a marked failure, never a fake empty success |

## 2. Design decisions worth recording

- **Explicit, replaceable provider (§17).** A provider is a plain object
  `{ id, version, locality, loadOptions(context) }`. `createStaticProvider` is the
  local/static provider (tests + the STATIC class); it never crosses a network boundary.
  Remote and credential-aware providers, and the plugin boundary, are P7-S06/S07.
- **A failure is always marked.** A provider error, timeout, or overload returns
  `options: []` *together with* a non-null `error: { code, message }` — never an unmarked
  empty list that a caller could mistake for "no options". The negative cache (short TTL)
  stops a retry storm on a failing provider.
- **Stale-while-revalidate is display-only and non-recursive.** A stale value is served
  only for non-authoritative requests; the background revalidation goes through the same
  coalescing/bounded path (never re-enters the SWR branch), so it cannot recurse.
- **The generation is captured at issue time.** Each provider call bumps the generation
  and the result carries it, so a stale (older-generation) response is distinguishable
  and a dependency-digest change yields a distinct key (no cross-contamination).

## 3. Verification

- **New unit suite** `test/lego-parameter-discover.test.mjs`: **16/16 pass**
  (`node --test apps/n8n-lego/test/lego-parameter-discover.test.mjs`).
- **Architecture gate** `npm run lego:arch`: OK — the module is registered in the
  `dynamic-parameters` domain (`src/lego/manifest/domains.json` `paths` + `contract.tests`).
- **Full LEGO gate** `npm run lego:gate`: arch / foundation / capabilities / scaleout /
  ai:check all green.
- **Full backend suite** `node --test apps/n8n-lego/test/`: the only failures are the
  pre-existing catalog/REST tests that require `N8N_LEGO_CATALOG_DIR` (the fetched
  catalog), which CI provides and this sandbox does not. Unrelated to this slice.

## 4. Boundary

P7-S04 is the DISCOVER stage. It does NOT mount the `/rest/dynamic-node-parameters` REST
surface (that stays 501 until the runtime is wired to it), does not touch credentials or
authentication (P7-S06), does not define the plugin/provider admission boundary (P7-S07),
and changes no Rust, workflow, Cargo, runner, contract, or `packages/` file.
