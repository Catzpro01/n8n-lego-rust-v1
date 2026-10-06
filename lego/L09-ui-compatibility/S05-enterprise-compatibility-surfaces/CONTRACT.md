# CONTRACT: L09.S05 — Enterprise-facing compatibility surfaces

## 1. Sub-LEGO Identity
- **ID**: `L09.S05`
- **Name**: Enterprise-facing compatibility surfaces
- **Owning LEGO**: `L09-ui-compatibility`
- **Ownership Team**: `ui-compat`
- **Execution Model**: `in-process`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `enterprise-license-claims`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `IMPLEMENTED`

---

## 2. Provided Ports
### `port.ui.enterprise.features.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.security.authz.authorize.v1` (Provider: `L02.S03`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`enterprise-license-claims`).
4. Model eksekusi mematuhi batasan runtime host `H01` (Gateway Host).
