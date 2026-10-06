# CONTRACT: L05.S01 — Workflow/execution persistence

## 1. Sub-LEGO Identity
- **ID**: `L05.S01`
- **Name**: Workflow/execution persistence
- **Owning LEGO**: `L05-data-storage`
- **Ownership Team**: `data-persistence`
- **Execution Model**: `stateful-component`
- **Runtime Host**: `H05` (Data Host)
- **State Ownership**: `workflow-metadata-store`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `rolling-dual-version`
- **Status**: `IMPLEMENTED`

---

## 2. Provided Ports
### `port.storage.persistence.save.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.storage.persistence.load.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.security.context.validate.v1` (Provider: `L02.S01`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`workflow-metadata-store`).
4. Model eksekusi mematuhi batasan runtime host `H05` (Data Host).
