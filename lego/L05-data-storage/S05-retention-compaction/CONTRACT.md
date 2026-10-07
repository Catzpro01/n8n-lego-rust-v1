# CONTRACT: L05.S05 — Retention/compaction

## 1. Sub-LEGO Identity
- **ID**: `L05.S05`
- **Name**: Retention/compaction
- **Owning LEGO**: `L05-data-storage`
- **Ownership Team**: `data-persistence`
- **Execution Model**: `control-component`
- **Runtime Host**: `H05` (Data Host)
- **State Ownership**: `retention-policy-index`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.storage.retention.compact.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.storage.persistence.load.v1` (Provider: `L05.S01`)
- `port.storage.wal.read.v1` (Provider: `L05.S02`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`retention-policy-index`).
4. Model eksekusi mematuhi batasan runtime host `H05` (Data Host).
5. Compaction and retention policy enforcement must be idempotent and crash-resilient.
6. Deletion tombstones are preserved until the retention grace period has elapsed.
