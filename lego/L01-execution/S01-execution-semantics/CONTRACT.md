# CONTRACT: L01.S01 — Execution Semantics

## 1. Sub-LEGO Identity
- **ID**: `L01.S01`
- **Name**: Execution semantics
- **Owning LEGO**: `L01-execution`
- **Ownership Team**: `execution-engine`
- **Execution Model**: `in-process`
- **Runtime Host**: `H03` (Execution Host)
- **State Ownership**: `workflow-execution-frames`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `rolling-dual-version`

---

## 2. Provided Ports

### `port.execution.run.workflow.v1`
- **Category**: Command
- **Purpose**: Mengelola lifecycle eksekusi frame alur kerja (create, start, advance step, suspend, resume, complete, fail).
- **Request Shape**: `{ "workflow_id": string, "execution_id": Option<string>, "action": "start" | "create" | "advance" | "suspend" | "resume" | "complete" | "fail", "trigger_data": Option<Value>, "correlation_id": Option<string>, "tenant_id": Option<string> }`
- **Response Shape**: `{ "execution_id": string, "workflow_id": string, "status": "Created" | "Running" | "Waiting" | "Completed" | "Failed", "current_step": usize, "steps_executed": usize, "correlation_id": Option<string> }`
- **Error Taxonomy**: `PortErrorCode::BadRequest`, `PortErrorCode::Timeout`, `PortErrorCode::InternalError`, `PortErrorCode::Conflict`
- **Idempotency**: Non-idempotent (Stateful FSM progression)

### `port.execution.cancel.workflow.v1`
- **Category**: Command
- **Purpose**: Membatalkan eksekusi workflow yang sedang aktif atau menunggu, serta membersihkan sumber daya frame.
- **Request Shape**: `{ "execution_id": string, "reason": Option<string>, "correlation_id": Option<string> }`
- **Response Shape**: `{ "execution_id": string, "cancelled": bool, "status": "Cancelled", "reason": string, "correlation_id": Option<string> }`
- **Error Taxonomy**: `PortErrorCode::NotFound`, `PortErrorCode::Conflict`
- **Idempotency**: Idempotent (pemanggilan berulang pada frame yang sudah `Cancelled` menghasilkan sukses tanpa mutasi ulang)

---

## 3. Required Ports
- `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)
- `port.runtime.budget.allocate.v1` (Provider: `L00.S03`)
- `port.node.execute.invoke.v1` (Provider: `L04.S03`)
- `port.storage.wal.append.v1` (Provider: `L05.S02`)

---

## 4. Invariants & Rules
1. **Frame Context Isolation**: Setiap run alur kerja memiliki frame state konteks mandiri tanpa kontaminasi silang.
2. **Strict FSM Immutability**: Transisi valid mengikuti alur `Created -> Running -> Waiting -> Running -> Completed | Failed | Cancelled`. Seluruh terminal state (`Completed`, `Failed`, `Cancelled`) absolut imutabel dan menolak transisi status lanjutan.
3. **Fail-Closed Durable WAL Journal**: Seluruh transisi status wajib dipersistensikan secara append-only ke WAL (`port.storage.wal.append.v1`) dengan Log Sequence Number (LSN) monotonik. Bila WAL gagal, mutasi in-memory wajib dibatalkan (rollback); dilarang keras melakukan silent fallback.
4. **Resource Budget Enforcement**: Alokasi batas step dan timeout (`port.runtime.budget.allocate.v1`) ditegakkan secara fail-closed; pelanggaran budget mentransisikan frame ke status `Failed`.
5. **Fail-Closed Cancellation**: Pembatalan frame menghentikan eksekusi secara seketika dan bersifat idempoten; pembatalan terhadap frame yang telah mencapai status terminal `Completed` atau `Failed` wajib ditolak fail-closed.
