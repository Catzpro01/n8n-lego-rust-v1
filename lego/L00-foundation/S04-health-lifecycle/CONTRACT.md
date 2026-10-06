# CONTRACT: L00.S04 — Health and Lifecycle

## 1. Sub-LEGO Identity
- **ID**: `L00.S04`
- **Name**: Health and lifecycle
- **Owning LEGO**: `L00-foundation`
- **Ownership Team**: `runtime-core`
- **Execution Model**: `in-process`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `lifecycle-state`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`

---

## 2. Provided Ports

### `port.runtime.lifecycle.probe.v1`
- **Category**: Query / Lifecycle
- **Purpose**: Mengambil status liveness, readiness, dan observasi anomali dari host atau Sub-LEGO.
- **Request Shape**: `{ "component_id": string }`
- **Response Shape**: `{ "component_id": string, "status": "Healthy" | "Degraded" | "Quarantined" | "Terminated", "consecutive_failures": u32 }`
- **Error Taxonomy**: `PortErrorCode::NotFound`, `PortErrorCode::InternalError`
- **Idempotency**: Idempotent

### `port.runtime.lifecycle.quarantine.v1`
- **Category**: Command / Lifecycle
- **Purpose**: Mengisolasi komponen yang gagal secara berulang ke mode karantina untuk mencegah cascading failure.
- **Request Shape**: `{ "component_id": string, "reason": string }`
- **Response Shape**: `{ "quarantined": bool, "component_id": string }`
- **Error Taxonomy**: `PortErrorCode::Conflict`, `PortErrorCode::BadRequest`
- **Idempotency**: Idempotent

---

## 3. Required Ports
- `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)

---

## 4. Invariants & Rules
1. Transisi state lifecycle harus deterministik dan mengikuti siklus: Initializing -> Healthy -> Degraded -> Quarantined -> Terminated.
2. Komponen berstatus Quarantined atau Terminated dilarang menerima dispatch tugas baru dari runtime scheduler.
3. Health check probe harus bersifat non-blocking (in-memory atomic/RwLock state access).
