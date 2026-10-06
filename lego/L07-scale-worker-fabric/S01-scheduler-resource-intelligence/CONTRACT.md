# CONTRACT: L07.S01 — Scheduler/resource intelligence

## 1. Sub-LEGO Identity
- **ID**: `L07.S01`
- **Name**: Scheduler/resource intelligence
- **Owning LEGO**: `L07-scale-worker-fabric`
- **Ownership Team**: `fabric-scale`
- **Execution Model**: `control-component`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `worker-capacity-table`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.scale.scheduler.dispatch.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.scale.queue.dequeue.v1` (Provider: `L07.S03`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`worker-capacity-table`).
4. Model eksekusi mematuhi batasan runtime host `H02` (Control Host).
