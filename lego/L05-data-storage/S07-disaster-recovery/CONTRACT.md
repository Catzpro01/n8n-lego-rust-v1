# CONTRACT: L05.S07 — Disaster recovery

## 1. Sub-LEGO Identity
- **ID**: `L05.S07`
- **Name**: Disaster recovery
- **Owning LEGO**: `L05-data-storage`
- **Ownership Team**: `data-persistence`
- **Execution Model**: `control-component`
- **Runtime Host**: `H05` (Data Host)
- **State Ownership**: `dr-replica-offsets`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.storage.dr.sync.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.storage.backup.restore.v1` (Provider: `L05.S06`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`dr-replica-offsets`).
4. Model eksekusi mematuhi batasan runtime host `H05` (Data Host).
