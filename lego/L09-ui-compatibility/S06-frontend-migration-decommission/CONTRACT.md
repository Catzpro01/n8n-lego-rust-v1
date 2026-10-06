# CONTRACT: L09.S06 — Frontend migration/decommission plan

## 1. Sub-LEGO Identity
- **ID**: `L09.S06`
- **Name**: Frontend migration/decommission plan
- **Owning LEGO**: `L09-ui-compatibility`
- **Ownership Team**: `ui-compat`
- **Execution Model**: `contract-only`
- **Runtime Host**: `H07` (Compatibility Host)
- **State Ownership**: `decommission-milestones`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.ui.decommission.audit.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- *None*

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`decommission-milestones`).
4. Model eksekusi mematuhi batasan runtime host `H07` (Compatibility Host).
