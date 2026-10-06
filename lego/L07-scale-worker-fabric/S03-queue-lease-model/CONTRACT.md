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
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.scale.queue.enqueue.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active
- **Capability**: Enqueues jobs with tenant isolation, priority scheduling, and retry budget.

### `port.scale.queue.dequeue.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active
- **Capability**: Dequeues eligible jobs for workers under exclusive leases with expiration timeouts.

### `port.scale.queue.ack.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active
- **Capability**: Acknowledges job completion, failure, or retry with lease token validation.

---

## 3. Required Ports
- `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`job-queue-leases`).
4. Model eksekusi mematuhi batasan runtime host `H05` (Data Host).
5. Multi-tenant isolation: Antrean dan lease terisolasi penuh per tenant; worker tidak dapat mengambil antrean lintas tenant tanpa izin.
