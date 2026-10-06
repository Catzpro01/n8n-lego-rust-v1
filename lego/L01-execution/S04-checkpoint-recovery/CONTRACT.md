# CONTRACT: L01.S04 — Checkpoint and Crash Recovery

## 1. Sub-LEGO Identity
- **ID**: `L01.S04`
- **Name**: Checkpoint and crash recovery
- **Owning LEGO**: `L01-execution`
- **Ownership Team**: `execution-engine`
- **Execution Model**: `stateful-component`
- **Runtime Host**: `H03` (Execution Host)
- **State Ownership**: `execution-checkpoint-index`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `rolling-dual-version`

---

## 2. Provided Ports

### `port.execution.checkpoint.save.v1`
- **Category**: Command / Data
- **Purpose**: Menyimpan titik checkpoint eksekusi workflow secara atomik ke durable WAL journal.
- **Request Shape**: `{ "execution_id": string, "node_name": string, "step_index": u64, "state_payload": Value }`
- **Response Shape**: `{ "checkpoint_id": string, "persisted_at_ms": u64, "lsn": u64 }`
- **Error Taxonomy**: `PortErrorCode::InternalError`, `PortErrorCode::BadRequest`

### `port.execution.recovery.replay.v1`
- **Category**: Query / Lifecycle
- **Purpose**: Membaca kembali checkpoint terakhir dan replay frame eksekusi pasca crash restart.
- **Request Shape**: `{ "execution_id": string, "from_step": u64 }`
- **Response Shape**: `{ "recovered_steps": Vec<FrameCheckpoint>, "last_successful_node": Option<string> }`

---

## 3. Required Ports
- `port.storage.wal.append.v1` (Provider: `L05.S02`)
- `port.storage.wal.read.v1` (Provider: `L05.S02`)

---

## 4. Invariants & Fail-Closed Rules
1. Checkpoint save wajib fail-closed: kegagalan append ke WAL tidak boleh diabaikan atau downgrade ke memori.
2. Replay harus deterministik sesuai urutan LSN (Log Sequence Number).
