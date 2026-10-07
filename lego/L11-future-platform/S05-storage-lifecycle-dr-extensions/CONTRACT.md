# CONTRACT: L11.S05 — Storage lifecycle/DR extensions

## 1. Sub-LEGO Identity
- **ID**: `L11.S05`
- **Name**: Storage lifecycle/DR extensions
- **Owning LEGO**: `L11-future-platform`
- **Ownership Team**: `platform-future`
- **Execution Model**: `control-component`
- **Runtime Host**: `H05` (Data Host)
- **State Ownership**: `cold-archive-tiers`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.future.cold_archive.store.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.storage.backup.create.v1` (Provider: `L05.S05`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`cold-archive-tiers`).
4. Model eksekusi mematuhi batasan runtime host `H05` (Data Host).
5. Mandatory WAL rule: kegagalan inisialisasi WAL atau direktori wajib fail-closed tanpa silent in-memory fallback.
