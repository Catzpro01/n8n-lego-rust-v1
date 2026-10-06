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
- **Purpose**: Memulai atau melanjutkan eksekusi frame workflow berdasarkan graph topological step dan trigger input.
- **Request Shape**: `{ "workflow_id": string, "execution_id": string, "trigger_data": Value }`
- **Response Shape**: `{ "execution_id": string, "status": "Running" | "Completed" | "Failed", "steps_executed": usize }`
- **Error Taxonomy**: `PortErrorCode::BadRequest`, `PortErrorCode::Timeout`, `PortErrorCode::InternalError`
- **Idempotency**: Non-idempotent

### `port.execution.cancel.workflow.v1`
- **Category**: Command
- **Purpose**: Membatalkan eksekusi workflow yang sedang aktif dan membersihkan frame resource.
- **Request Shape**: `{ "execution_id": string, "reason": string }`
- **Response Shape**: `{ "execution_id": string, "cancelled": bool }`
- **Error Taxonomy**: `PortErrorCode::NotFound`, `PortErrorCode::Conflict`
- **Idempotency**: Idempotent

---

## 3. Required Ports
- `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)
- `port.runtime.budget.allocate.v1` (Provider: `L00.S03`)
- `port.node.execute.invoke.v1` (Provider: `L04.S02`)
- `port.storage.wal.append.v1` (Provider: `L05.S02`)

---

## 4. Invariants & Rules
1. Eksekusi frame bersifat terisolasi: setiap run memiliki frame state konteks mandiri.
2. Setiap transisi status frame harus dapat diaudit dan dicatat ke durable WAL journal.
3. Pembatalan workflow wajib menyebarkan sinyal pembatalan ke seluruh task anak aktif secara fail-closed.
