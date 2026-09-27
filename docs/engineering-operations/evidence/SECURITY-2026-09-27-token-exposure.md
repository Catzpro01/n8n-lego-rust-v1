# Security finding — runtime token material in git history (OPEN / NOT remediated)

Date recorded: 2026-09-27
Recorded by: MANAGER-01
Status: **OPEN — external action required (rotate/revoke). This finding is NOT fixed.**

## What

`.arena/gateway_tokens.json` — runtime token material for the legacy Arena
gateway (a manager-role token and a worker-role token, `agm_`-prefixed) — was
committed to the repository in commit `7d8157c5`
("feat(orchestrator): finalize Arena Manager ... v1.7") and remained reachable
in history and on at least one stale branch (since deleted).

Token values are intentionally NOT reproduced in this document, in issues, in
PRs, in commits or in chat. They live in git history at the commit above; that
is the exposure.

A second exposure class: the GitHub PAT used for repository management was
transmitted in plaintext in operator chat (outside the repository). It is
recorded here as an open item only; the value is not repeated anywhere.

## Why deletion is not remediation

Branch deletion, file deletion, `.gitignore` coverage
(`.gitignore` line: `.arena/gateway_tokens.json`) and sensitive-path scanning
(`.arena/policies/sensitive-paths.yaml`, pattern `*token*`) are **prevention
only**. Per the owner's security rule, a credential that has been in history is
classified by validity:

| Credential | Validity | Classification |
|---|---|---|
| Legacy gateway token pair (`agm_…`, two roles) | **UNKNOWN** — the gateway tooling was removed from the repo by DEC-0019, but no evidence proves every deployed gateway instance rejected these tokens | **Treat as compromised** |
| Management PAT (operator chat) | Active at time of use | **Treat as compromised** |

## Required external actions (outside Manager authority)

1. **Owner**: revoke/rotate the legacy gateway token pair wherever the gateway
   was deployed; if the gateway is confirmed decommissioned everywhere, record
   that as the revocation evidence and close item 1.
2. **Owner**: rotate the management PAT
   (https://github.com/settings/tokens), then confirm the old value is dead.
3. Optional hardening (owner's call): enable secret scanning + push protection
   on the repository so `agm_`/`ghp_` patterns cannot re-enter history.

## Evidence anchors

- Commit carrying the token file: `7d8157c5`
- Prevention: `.gitignore` (`.arena/gateway_tokens.json`), `.arena/policies/sensitive-paths.yaml` (`*token*`), `docs/engineering-operations/RUNNER-PROTOCOL.md` §9 ("Runtime token material ... never commit")
- Removal of the legacy gateway: `docs/engineering-operations/evidence/DEC-0019-legacy-removal.md`
- Stale branch that still carried the file (deleted 2026-09-27): `chore/ci-fail-fast`

## Closure criteria

This finding closes ONLY when either (a) rotation/revocation evidence is
recorded for both rows above, or (b) the owner records that the legacy gateway
is decommissioned everywhere and the PAT is rotated. Until then, any report
that calls this "fixed" is wrong.
