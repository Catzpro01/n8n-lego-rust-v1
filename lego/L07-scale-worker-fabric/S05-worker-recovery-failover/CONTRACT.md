# CONTRACT: L07.S05 — Worker recovery and failover

## 1. Sub-LEGO Identity
- **ID**: `L07.S05`
- **Name**: Worker recovery and failover
- **Owning LEGO**: `L07-scale-worker-fabric`
- **Ownership Team**: `fabric-scale`
- **Execution Model**: `control-component`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `failover-election-state`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.scale.worker.failover.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.scale.failover.reclaim.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.scale.queue.ack.v1` (Provider: `L07.S03`)
- `port.scale.worker.heartbeat.v1` (Provider: `L07.S04`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`failover-election-state`).
4. Model eksekusi mematuhi batasan runtime host `H02` (Control Host).
