# CONTRACT: L06.S02 — Execution telemetry

## 1. Sub-LEGO Identity
- **ID**: `L06.S02`
- **Name**: Execution telemetry
- **Owning LEGO**: `L06-realtime-observability`
- **Ownership Team**: `observability`
- **Execution Model**: `in-process`
- **Runtime Host**: `H03` (Execution Host)
- **State Ownership**: `telemetry-metrics-ring`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `IMPLEMENTED`

---

## 2. Provided Ports
### `port.observability.telemetry.record.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`telemetry-metrics-ring`).
4. Model eksekusi mematuhi batasan runtime host `H03` (Execution Host).
