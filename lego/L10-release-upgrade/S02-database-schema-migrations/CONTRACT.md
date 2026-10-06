# CONTRACT: L10.S02 — Database/schema migrations

## 1. Sub-LEGO Identity
- **ID**: `L10.S02`
- **Name**: Database/schema migrations
- **Owning LEGO**: `L10-release-upgrade`
- **Ownership Team**: `release-lifecycle`
- **Execution Model**: `tooling`
- **Runtime Host**: `H05` (Data Host)
- **State Ownership**: `migration-version-ledger`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `rolling-dual-version`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.release.migration.apply.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active
- **Capability**: Manages sequential database schema migrations, version ledger tracking, rollback steps, and status verification.

---

## 3. Required Ports
- `port.storage.persistence.save.v1` (Provider: `L05.S01`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`migration-version-ledger`).
4. Model eksekusi mematuhi batasan runtime host `H05` (Data Host).
