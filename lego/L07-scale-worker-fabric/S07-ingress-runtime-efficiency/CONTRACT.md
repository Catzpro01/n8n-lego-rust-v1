# CONTRACT: L07.S07 — Ingress/runtime efficiency

## 1. Sub-LEGO Identity
- **ID**: `L07.S07`
- **Name**: Ingress/runtime efficiency
- **Owning LEGO**: `L07-scale-worker-fabric`
- **Ownership Team**: `fabric-scale`
- **Execution Model**: `in-process`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `backpressure-tuning-state`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.scale.runtime.tune.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.scale.efficiency.buffer_pool.v1`
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
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`backpressure-tuning-state`).
4. Model eksekusi mematuhi batasan runtime host `H01` (Gateway Host).
