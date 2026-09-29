# P2-S11 Webhooks Surface Pilot - Delivery Evidence

**Slice:** P2-S11 (Layer 4 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only)
**Scope:** packages/frontend-lego/src/webhooks.mjs + test/48-webhooks.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

Trigger routing and activation (the webhook/scheduler roadmap items own them),
webhook registration writes (the trigger/activation runtime owns
addWebhooks/clearWebhooks), node-level auth evaluation (basicAuth/headerAuth/
jwtAuth run inside the Webhook node against the Credentials runtime - the
P2.27/P5 boundary is finding-only here, never modified), form/waiting endpoints
beyond the URL rows the reference UI publishes, and the settings-published
endpoint pages. No backend dependency was built.

## Security boundary (the load-bearing rule)

**Auth material never reaches the surface.** A registration carrying a
secret-bearing field (`auth`, `headers`, `token`, `password`, `apiKey`,
`basicAuth`, `headerAuth`, `jwtAuth`, `webhookId`, ...) is refused with an
explicit security error, never silently dropped. Registrations arrive through
declared capabilities only (hand-over); the surface **issues no register call**
(registration is handed over, never requested or created here) and holds no
private data path and no second source of truth. The URL shown is exactly the
endpoint the reference UI publishes - the surface adds nothing to it. Pinned by
the refusal tests in test/48-webhooks.test.mjs (group A).

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** Entries enter only through `loadSuccess()`;
  the surface never fetches registrations and issues no register call - copy is
  a declared interaction with the closed `requested | unknown-id | not-ready`
  result vocabulary. States pinned to REGION_STATES exactly (a resource filter
  with no registrations is empty/filtered, no fifth state). Closed
  vocabularies: methods `DELETE GET HEAD PATCH POST PUT` (the webhook
  contract's method guard; OPTIONS is CORS handling answered without executing,
  so it is not a registration method), resources `node | workflow` (what a
  registration is shown with), url kinds `test | production` (the two endpoint
  URLs the reference UI publishes), actions, request results, empty reasons.
- **Pilot + rollback (CP-02).** `ui.webhooks.registrations` registered
  `pilot-available` / `contractStatus: consuming` / `rollbackStrategy:
  pilot-not-primary` in surface-migrations.json; the `webhooks` capability is
  declared in capabilities.json (`./src/webhooks.mjs`, message namespace
  `webhooks`, degradation `native-behavior`). The surface-migration and pilot
  tests pin both entries (test/37, test/39, test/48 group B).
- **Parity (CP-03).** Differential parity through the existing parity harness
  (compareObservations, fail-closed): loading, empty (both reasons), ready
  (both resource views) and error (declared error kinds) are parity-equivalent
  to the declared reference observations; a drifted field is
  `migration-required`, an incomparable observation throws ParityError - never
  silently passes. Candidate and reference interactions derive from the SAME
  `webhookActionsFor` rule, so the two sides cannot drift by construction
  (test/48 group C).
- **Accessibility (CP-04).** The a11y intent is derived once from
  `WEBHOOK_A11Y` and shared by the contract observables and the view-model:
  only error is aria-live assertive, only loading is aria-busy, the ready list
  is role list announced politely (test/48 group D).
- **Budget + failure (CP-05).** Bounded visible list (default 20, hard max 50,
  truncation reported in the display model), explicit error region with the
  `refresh` retry affordance instead of a silent blank, deterministic history
  and a degraded mode that counts unrendered events (test/48 group E).

## Findings (recorded, not hidden)

1. **Dual-origin naming (design note from P2-S10 applied).** The backend
   advertises capability `webhook` (surfaces.json), while the frontend surface
   and capability are declared `webhooks`. Declaring under the surface id
   instead of the backend-advertised id avoids the merge ambiguity the P2-S10
   cycle found (a frontend declaration shadows a backend advertisement in
   negotiation.mjs's resolve order) by construction - no shared-rule change, no
   fixture rewrite. The general fix for dual-origin merge semantics remains a
   future shared-rule slice.
2. **Projection fingerprint covers `lastVerifiedMain` (operational, from the
   P2-S10 cycle).** Every register edit - including tail-pointer-only edits -
   must regenerate the projections in the same commit (rule adopted in the
   P2-S10 closeout and applied at the P2-S11 START).

## Verification (numbers)

- Focused suite: packages/frontend-lego/test/48-webhooks.test.mjs - 20/20
  (groups A-E map to CP-01..CP-05).
- Full frontend-lego battery: 714 tests, 0 fail (1 pre-existing skip).
- Pins refreshed for the new pilot: test/37 (pilot sets x4), test/39 (pilot
  set), test/12 (card + curated capability index), card.md 8190/8192 B.
- Post-merge battery and R1/R2 reconciliation: recorded in the closeout block.
