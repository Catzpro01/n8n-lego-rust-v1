# P7-S05 — Resource Locator & Search

**Issue:** #223 §12-13, §24-27, §34, §42 rung P7.5 (authorized by DEC-0024)
**Status:** in-progress until delivery merge + post-merge verification (DEC-0014, DEC-0015)
**Branch:** `delivery/p7-s05-resource-locator`
**Contract:** domain `dynamic-parameters` (owner `agent-4`), module `src/lego/parameter-locator.mjs`
**Gate:** DEC-0025 temporary gate in force (self-hosted fleet offline; GitHub-hosted green is the effective merge gate)

## 1. What was delivered

`apps/n8n-lego/src/lego/parameter-locator.mjs`: the **resourceLocator** first-class P7
semantics and the bounded **list search** (stage 4, DISCOVER-adjacent). A locator parameter
has one of four compatible modes and an n8n-compatible stored value `{ mode, value }`; list
mode is the only mode that reaches a provider, and it performs a bounded, targeted search —
never an unbounded enumeration to populate a dropdown.

| #223 § | Requirement | Where it is met |
|---|---|---|
| §12 | resourceLocator as first-class semantics; modes list/name/id/url; stored values remain n8n-compatible | `parseResourceLocator` / `normalizeLocatorValue`: the four `LOCATOR_MODES`, a canonical frozen `{ mode, value }` (extra n8n fields ignored), unknown modes / malformed values rejected (SCHEMA_INVALID / INVALID_URL), never silently coerced |
| §13 | bounded page size, bounded result count, next-page token, cancellation, query length limits, deterministic result ordering; targeted search over a full catalog; never unbounded enumeration | `ResourceLocatorSession.search/nextPage`: `maxPageSize` / `maxResultCount` / `maxQueryLength` / `maxPageTokenLength` bounds; results normalized + deterministically ordered (value then name); opaque next-page token; a `maxPagesPerSession` cap stops enumeration |
| §24 | requestId + generation + dependency digest; only a current-generation response updates state | each issued provider call bumps the generation (carried on the result); the §14 cache key is over the normalized query digest + page token |
| §25 | identical concurrent requests share one in-flight op | `inFlight` map keyed by the full page key; coalesced results are marked `cache: 'coalesced'` |
| §26 | concurrency bound, deadline/timeout, max page size, cancellation; one slow provider cannot consume the budget | `maxConcurrency` / `timeoutMs` / `maxPageSize`; `createCancelToken` + `session.cancel(requestId)`; a bounded/cancelled op is a marked OVERLOADED / CANCELLED |
| §27 | a provider failure is never a fake empty success | a failing/slow/cancelled provider returns `items: []` **together with** a non-null `error: { code, message }` (closed `LOCATOR_FAILURE_CODES`); a genuine empty provider result is a SUCCESS (no error) |

## 2. Design decisions worth recording

- **Explicit, replaceable search provider (§17).** A provider is a plain object
  `{ id, version, locality, search(context, page) -> { items, nextToken } }`.
  `createStaticLocatorProvider` is the local/static provider (tests); it filters + paginates
  a static list and never crosses a network boundary. Remote/credential-aware search providers
  are P7-S06/S07.
- **Deterministic ordering is the session's job (§13).** The session re-sorts every page by
  `(value, name)` so the result order is independent of provider order — a hard requirement for
  a stable dropdown.
- **Bounded pagination is a hard cap, not a hint.** `maxPagesPerSession` bounds the number of
  provider pages a single search identity may fetch; hitting it is a *marked* OVERLOADED, not a
  silent empty page. Combined with `maxPageSize`/`maxResultCount`, the session cannot walk an
  entire remote catalog.
- **Failure vs. empty are distinct.** A real empty result (`{ items: [], nextToken: null }`)
  is a success with `error: undefined`; a provider fault is a marked failure with `items: []`
  and a non-null `error`. This is the §27 invariant pinned by tests.
- **Reuses stable same-domain primitives.** The session reuses `DynamicCache` / `CACHE_CLASSES`
  (P7-S04) and `canonicalJson` (P7-S01) — no second cache or budget subsystem (§34).

## 3. Verification

- **New unit suite** `test/lego-parameter-locator.test.mjs`: **25/25 pass**
  (`node --test apps/n8n-lego/test/lego-parameter-locator.test.mjs`).
- **Architecture gate** `npm run lego:arch`: OK — the module is registered in the
  `dynamic-parameters` domain (`manifest/domains.json` `paths` + `contract.tests`), 100 locked
  public contracts, every import respects its declared boundary.
- **Full LEGO gate** `npm run lego:gate`: arch / scaleout / ai:check green (the `lego:test`
  quoted-glob step is a local Node 20 limitation; CI's Node expands it — the full backend suite
  is run directly and is clean).
- **Full backend suite** `node --test apps/n8n-lego/test/`: clean except the pre-existing
  catalog/REST tests that require `N8N_LEGO_CATALOG_DIR` (CI-provided).

## 4. Boundary

P7-S05 is the resourceLocator + list-search semantics. It does NOT mount any REST surface,
does not touch credentials/authentication (P7-S06), does not define the plugin/provider
admission boundary (P7-S07), and changes no Rust, workflow, Cargo, runner, contract, or
`packages/` file.
