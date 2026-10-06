# CONTRACT: L05.S03 — Execution data plane

## 1. Sub-LEGO Identity
- **ID**: `L05.S03`
- **Name**: Execution data plane
- **Owning LEGO**: `L05-data-storage`
- **Ownership Team**: `data-persistence`
- **Execution Model**: `stateful-component`
- **Runtime Host**: `H05` (Data Host)
- **State Ownership**: `execution-item-blobs`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `IMPLEMENTED`

---

## 2. Provided Ports
### `port.storage.dataplane.store_handle.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.storage.dataplane.read_handle.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.runtime.budget.allocate.v1` (Provider: `L00.S03`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`execution-item-blobs`).
4. Model eksekusi mematuhi batasan runtime host `H05` (Data Host).
