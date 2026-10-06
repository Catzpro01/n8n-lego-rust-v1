# CONTRACT: L06.S06 — Resource pressure and queue metrics

## 1. Sub-LEGO Identity
- **ID**: `L06.S06`
- **Name**: Resource pressure and queue metrics
- **Owning LEGO**: `L06-realtime-observability`
- **Ownership Team**: `observability`
- **Execution Model**: `in-process`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `pressure-gauge-counters`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.observability.pressure.poll.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.runtime.budget.allocate.v1` (Provider: `L00.S03`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`pressure-gauge-counters`).
4. Model eksekusi mematuhi batasan runtime host `H02` (Control Host).
