# CONTRACT: L06.S05 — Replay and causal diagnostics

## 1. Sub-LEGO Identity
- **ID**: `L06.S05`
- **Name**: Replay and causal diagnostics
- **Owning LEGO**: `L06-realtime-observability`
- **Ownership Team**: `observability`
- **Execution Model**: `stateful-component`
- **Runtime Host**: `H03` (Execution Host)
- **State Ownership**: `causal-trace-index`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.observability.replay.trace.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.storage.wal.read.v1` (Provider: `L05.S02`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`causal-trace-index`).
4. Model eksekusi mematuhi batasan runtime host `H03` (Execution Host).
