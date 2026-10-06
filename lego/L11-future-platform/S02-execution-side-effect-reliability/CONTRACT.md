# CONTRACT: L11.S02 — Execution side-effect reliability

## 1. Sub-LEGO Identity
- **ID**: `L11.S02`
- **Name**: Execution side-effect reliability
- **Owning LEGO**: `L11-future-platform`
- **Ownership Team**: `platform-future`
- **Execution Model**: `stateful-component`
- **Runtime Host**: `H03` (Execution Host)
- **State Ownership**: `side-effect-outbox`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `DESIGNED (Architecture Blueprint Only - Implementation Pending)`

---

## 2. Provided Ports
### `port.future.side_effect.record.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.storage.wal.append.v1` (Provider: `L05.S02`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`side-effect-outbox`).
4. Model eksekusi mematuhi batasan runtime host `H03` (Execution Host).
