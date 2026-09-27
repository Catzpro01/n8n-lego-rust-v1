# P5-M10 Backing-Model Decomposition (REQ-0003 section 10)

**Status:** prepared (children PROPOSED, not authorized)
**Source:** owner master prompt REQ-0003 (2026-09-27) section 10; P5-M08-EVIDENCE.md section 1 (P5-F-DEBT-012)
**Children:** P5-M11 .. P5-M18 (canonical sequential maintenance ids in the P5 series)

P5-M10 groups the /api/v1 resources that need a backing model this product does not
have yet. It must not continue as one blocked mega-slice. Each model below is one
child slice with its own definition. The umbrella P5-M10 stays blocked until the
declared resource scope is delivered or formally re-scoped.

## Resource groups (verified against P5-M08-EVIDENCE.md section 1)

| Child | Model | Contract | Persistence boundary | API surface | Compatibility | Tests | Rollback | Dependencies |
|---|---|---|---|---|---|---|---|---|
| P5-M11 | project, membership, share-role records | /api/v1/projects + sharing semantics | shared store boundary (P8-S01 contract) | gated until the model exists | upstream /api/v1/projects shapes | model unit + API contract + sharing matrix | unmount the resource routes | P8-S01 storage contract |
| P5-M12 | append-only audit event (actor/action/target/attestation) | /api/v1/audit query semantics | shared store (P8) | gated | upstream audit query filters | immutability + query contract | unmount | P8-S01 |
| P5-M13 | repository, branch, changeset records (provider-neutral) | /api/v1/source-control semantics | shared store (P8) | gated | upstream source-control resource shape | round-trip + conflict semantics | unmount | P8-S01 |
| P5-M14 | column schema + typed row records | /api/v1/data-tables CRUD semantics | shared store (P8) | gated | upstream data-table shapes | schema evolution + row CRUD | unmount | P8-S01 |
| P5-M15 | versioned export bundle + transfer record | workflow/credential transfer semantics | shared store (P8) | gated | upstream transfer bundle format | bundle round-trip + secret-free invariant (envelopes/refs only, never raw secrets) | unmount | P8-S01, P5 credential envelope (P2.27) |
| P5-M16 | immutable workflow version records (parent links, diff metadata) | /api/v1/workflow-versions semantics | shared store (P8) | gated | upstream version resource shape | immutability + ancestry | unmount | P8-S01 |
| P5-M17 | retry-request record bound to an original execution | retry semantics (idempotent, terminal-state rules) | execution store extension | gated | upstream retry execution behavior | double-retry refusal + linkage | unmount | engine execution records (exist) |
| P5-M18 | AnnotationTag-equivalent entity + attach/detach | /api/v1 execution annotation tags | store extension | gated | upstream AnnotationTag semantics | tag lifecycle + orphan cleanup | unmount | execution records (exist) |

## Rules

1. No /api/v1 resource is mounted before its model exists (owner: "Do not implement the API surface unless the backing model exists").
2. No project/ownership/sharing authorization is inferred where no project model exists (P5.8 SECURITY-EXPLICIT documentation).
3. No fake data-table backed by process memory, no synthetic audit history, no secret values in any transfer bundle.
4. Persistence goes through the provider-neutral storage contract (P8-S01/P8-S02..P8-S07) once it exists; local-only storage must not claim multi-host semantics.
5. Each child delivers one resource, one contract scope, one test suite, one delivery PR, one rollback path (unmount).

## Authorization state

All eight children are **PROPOSED**. They become execution candidates only when
authorized (owner master prompt or future mandate). Until then no implementation
work starts.
