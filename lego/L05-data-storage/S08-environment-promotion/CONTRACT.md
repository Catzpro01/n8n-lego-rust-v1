# CONTRACT: L05.S08 — Environment promotion

## 1. Sub-LEGO Identity
- **ID**: `L05.S08`
- **Name**: Environment promotion
- **Owning LEGO**: `L05-data-storage`
- **Ownership Team**: `data-persistence`
- **Execution Model**: `in-process`
- **Runtime Host**: `H05` (Data Host)
- **State Ownership**: `promotion-manifest-store`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.storage.promotion.export.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.storage.promotion.import.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.storage.environment.promote.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.storage.persistence.load.v1` (Provider: `L05.S01`)
- `port.security.credential.release.v1` (Provider: `L02.S04`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`promotion-manifest-store`).
4. Model eksekusi mematuhi batasan runtime host `H05` (Data Host).
5. All exported promotion bundles must sanitize secrets and credentials before cross-environment transit.
6. Target environment manifest import must validate compatibility and support clean rollback.
