# CONTRACT: L06.S04 — Health/readiness

## 1. Sub-LEGO Identity
- **ID**: `L06.S04`
- **Name**: Health/readiness
- **Owning LEGO**: `L06-realtime-observability`
- **Ownership Team**: `observability`
- **Execution Model**: `in-process`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `system-readiness-map`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `IMPLEMENTED`

---

## 2. Provided Ports
### `port.observability.health.check.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.runtime.lifecycle.probe.v1` (Provider: `L00.S04`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`system-readiness-map`).
4. Model eksekusi mematuhi batasan runtime host `H02` (Control Host).
