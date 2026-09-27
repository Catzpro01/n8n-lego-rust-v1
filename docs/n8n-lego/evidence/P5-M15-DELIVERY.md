# P5-M15 — Workflow/credential transfer backing model (P5-M10-E)

Scope mapping (register P5-M15):

| Scope | Delivered | Evidence |
| --- | --- | --- |
| versioned export bundle + transfer record | `apps/n8n-lego/src/lego/transfer-model.mjs` — `createTransferModel(storage,{clock,idFactory,namespace})`; bundle `{tag, bundleId, kind, schemaVersion, manifest, payload}` (closed kinds `workflow-export\|credential-export\|mixed`); transfer `{tag, transferId, bundleId, from/toPrincipal, state, bundleDigest}` | test 1 |
| never raw secrets: credential transfer moves envelopes/refs only | **secret-free invariant enforced on write**: forbidden secret-bearing keys (`password/secret/token/apiKey/privateKey/clientSecret/credentials/...`) refused at ANY depth in payload/manifest/metadata; `credential-ref` items REQUIRE opaque `envelopeRef` and refuse raw fields; round-trip never widens exposure | test 2 |
| persistence = shared store (P8) | storage facade only; multi-host shared state over one provider | test 6 |
| API gated until the model exists | no HTTP surface added; model layer only (mounts later) | surface pin test 9 |
| tests: bundle round-trip | byte-stable round-trip (`get` body === create body); deterministic bundle digest (`bundleDigestOf` FNV-1a over canonical JSON) pinned on seal | tests 1, 3, 9 |
| transfer lifecycle | closed vocabulary `created\|sealed\|completed\|aborted` with legal transitions (`created→sealed\|aborted`, `sealed→completed\|aborted`); seal pins the bundle digest; every transition pure CAS (version token REQUIRED) | tests 3–5 |
| rollback: unmount | no destructive API; namespace isolation leaves history intact but hidden | test 8 |
| deps: P8-S01 (+ P5 credential envelope) | P8-S01 delivered (PR #356); credential material represented as envelope refs (P5 envelope semantics: opaque `envelopeRef` pointers only) | register |

Model surface (closed, pinned in test 9): `createBundle/getBundle`, `createTransfer/getTransfer/sealTransfer/completeTransfer/abortTransfer`, `listBundles/listTransfers`, `capabilities/namespace`.

## Semantics recorded (explicit)

1. **Bundles are create-only** (append-only like the P5-M12 audit store); versioning is the bundle `schemaVersion` + the seal-time digest.
2. **Create-if-absent pattern** (documented P8-S01 deviation, same as P5-M12..M14): pre-check + `put` + read-back verify.
3. **CAS transitions require the explicit version token** (P5-M13 lesson applied from the start; no `?? current` fallback).
4. **Lists are filter-aware result cursors** (P5-M13 lesson applied from the start).

## Battery

See PR CI + post-merge battery (lego suite + engine + runtime + lego:gate + isolation + decisions).
