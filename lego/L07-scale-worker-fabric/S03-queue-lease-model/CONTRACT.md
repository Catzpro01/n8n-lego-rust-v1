# CONTRACT: L07.S03 — Queue/lease model

## 1. Sub-LEGO Identity
- **ID**: `L07.S03`
- **Name**: Queue/lease model
- **Owning LEGO**: `L07-scale-worker-fabric`
- **Ownership Team**: `fabric-scale`
- **Execution Model**: `stateful-component`
- **Runtime Host**: `H05` (Data Host)
- **State Ownership**: `job-queue-leases`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `rolling-dual-version`
- **Status**: `IMPLEMENTED`

---

## 2. Provided Ports
### `port.scale.queue.enqueue.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.scale.queue.dequeue.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.scale.queue.ack.v1`
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
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`job-queue-leases`).
4. Model eksekusi mematuhi batasan runtime host `H05` (Data Host).
