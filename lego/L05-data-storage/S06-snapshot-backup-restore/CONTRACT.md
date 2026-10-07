# CONTRACT: L05.S06 — Snapshot/backup/restore

## 1. Sub-LEGO Identity
- **ID**: `L05.S06`
- **Name**: Snapshot/backup/restore
- **Owning LEGO**: `L05-data-storage`
- **Ownership Team**: `data-persistence`
- **Execution Model**: `control-component`
- **Runtime Host**: `H05` (Data Host)
- **State Ownership**: `backup-snapshot-metadata`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.storage.backup.create.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.storage.backup.restore.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.storage.backup.snapshot.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.storage.persistence.load.v1` (Provider: `L05.S01`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`backup-snapshot-metadata`).
4. Model eksekusi mematuhi batasan runtime host `H05` (Data Host).
5. Backup snapshots must include cryptographic integrity checksums (SHA-256) and atomic manifest verification.
6. Restores must be fail-closed against corrupted snapshots or tenant mismatches.
