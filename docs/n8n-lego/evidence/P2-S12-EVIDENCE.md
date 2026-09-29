# P2-S12 Auth Surface Pilot - Delivery Evidence

**Slice:** P2-S12 (Layer 4 surface split out of P2-S03; master prompt REQ-0003
section 6: frontend surface migration only)
**Scope:** packages/frontend-lego/src/auth.mjs + test/49-auth.test.mjs + manifests
**Mode:** pilot; rollback pilot-not-primary; the original n8n editor stays the default path

## Out of scope (stated, not touched)

Credential verification and the `/rest/login` exchange (the auth runtime and
the Credentials/identity backend own them), session issuance and renewal,
password reset and owner setup flows beyond the handed-over identity state,
role writes (a role change is a DECLARED request; the write stays with the
user-management backend), LDAP/SAML/SSO transports, and the reference
`n8n-editor-ui` sign-in pages themselves. No backend dependency was built.

## Security boundary (the load-bearing rule)

**Credentials and session material never reach the surface.** A payload,
identity or directory row carrying a secret-bearing field (`password`,
`passwordHash`, `token`, `refreshToken`, `sessionToken`, `sessionId`,
`mfaCode`, `apiKey`, `credentials`, `cookie`, ...) is refused with an explicit
security error, never silently dropped. Identity and the directory arrive in
ONE hand-over payload (`loadSuccess({identity, entries})`); the surface
**issues no login call**, holds no private data path and **never re-derives
identity locally** - rows never imply a session (identity stays exactly what
the payload carried, including `null`). Pinned by the refusal tests in
test/49-auth.test.mjs (group A).

## What shipped (one surface = one delivery scope)

- **Hand-over boundary (CP-01).** The sign-in, user-management and
  membership facets enter only through the single `loadSuccess()` payload;
  the surface performs no fetch and issues no login call - sign-in, sign-out
  and role changes are declared interactions with closed result vocabularies
  (`accepted | already-signed-in | not-ready`,
  `accepted | not-signed-in | not-ready`,
  `accepted | not-ready | unknown-id | invalid-role | same-role |
  owner-unchangeable`). States pinned to REGION_STATES exactly (a directory
  facet with no rows is empty/filtered, no fifth state). Closed vocabularies:
  facets `signin | users | membership`, roles pinned to the reference n8n
  2.9.4 system roles - global `global:owner|admin|member|chatUser`
  (user.schema ROLE), membership `project:admin|editor|viewer|chatUser`
  (teamRoleSchema). Custom roles exist upstream and are refused here,
  fail-closed (see Findings).
- **Pilot + rollback (CP-02).** `ui.auth.identity` registered
  `pilot-available` / `contractStatus: consuming` / `rollbackStrategy:
  pilot-not-primary` in surface-migrations.json (category
  `credentials-settings`, dependencies `[]` - sign-in precedes the shell);
  the `auth` capability is declared in capabilities.json (`./src/auth.mjs`,
  message namespace `auth`, degradation `native-behavior`). The
  surface-migration and pilot tests pin both entries (test/37, test/39,
  test/49 group B).
- **Parity (CP-03).** Differential parity through the existing parity harness
  (compareObservations, fail-closed): loading, empty (both reasons: `none`
  on the users facet, `filtered` on membership), ready (sign-in, users and
  membership views) and error (declared error kinds) are parity-equivalent
  to the declared reference observations; a drifted field is
  `migration-required`, an incomparable observation throws ParityError -
  never silently passes. Candidate and reference interactions derive from the
  SAME `authActionsFor` rule, so the two sides cannot drift by construction
  (test/49 group C).
- **Accessibility (CP-04).** The a11y intent is derived once from `AUTH_A11Y`
  and shared by the contract observables and the view-model: ready is the
  `region` landmark (the form or directory inside carries its widget roles),
  only error is aria-live assertive, only loading is aria-busy (test/49
  group D).
- **Budget + failure (CP-05).** Bounded visible directory (default 20, hard
  max 50, truncation reported in the display model), the facet switch as the
  observable mutation with explicit empty reasons, explicit error region with
  the `refresh` retry affordance instead of a silent blank, deterministic
  history and a degraded mode that counts unrendered events (test/49
  group E).

## Findings (recorded, not hidden)

1. **Reference owner rule carried over.** The reference
   `assignableGlobalRoleSchema` excludes `global:owner` ("Owner cannot be
   changed"). The surface encodes this as the closed
   `owner-unchangeable` result - an owner row never silently accepts a role
   change. Verified against the pinned reference source during design.
2. **Closed role vocabulary vs upstream custom roles (recorded divergence).**
   The reference allows custom global/project role slugs
   (`customProjectRoleSchema` and friends); this pilot's vocabulary is closed
   and refuses them (`invalid-role`). That is a deliberate fail-closed
   boundary of the pilot, not a parity claim over custom roles; widening the
   vocabulary is a governance decision for a later authorized slice.
3. **Identity roles pinned to the four authenticated global roles.** The
   reference also defines the bootstrap-only `default` role (a user with no
   email during instance setup); the handed-over identity vocabulary excludes
   it. Setup-flow identity belongs to the owner-setup screen, out of this
   slice's scope.

## Verification (numbers)

- Focused suite: packages/frontend-lego/test/49-auth.test.mjs - 22/22
  (groups A-E map to CP-01..CP-05).
- Full frontend-lego battery: 736 tests, 0 fail (1 pre-existing skip).
- Pins refreshed for the new pilot: test/37 (pilot sets x4), test/39 (pilot
  set), test/12 (card + curated capability index), card.md 8157/8192 B;
  pack total 85,993 B / 86,016 B budget.
- Post-merge battery and R1/R2 reconciliation: recorded in the closeout block.
