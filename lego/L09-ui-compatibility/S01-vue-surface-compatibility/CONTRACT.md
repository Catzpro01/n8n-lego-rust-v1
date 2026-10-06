# CONTRACT: L09.S01 — Official Vue surface compatibility

## 1. Sub-LEGO Identity
- **ID**: `L09.S01`
- **Name**: Official Vue surface compatibility
- **Owning LEGO**: `L09-ui-compatibility`
- **Ownership Team**: `ui-compat`
- **Execution Model**: `in-process`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `ui-static-bundle`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.ui.static.serve.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active
- **Capability**: Serves static web frontend bundles, assets, manifests, and SPA fallback routes for the Vue editor surface.

---

## 3. Required Ports
- `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`ui-static-bundle`).
4. Model eksekusi mematuhi batasan runtime host `H01` (Gateway Host).
