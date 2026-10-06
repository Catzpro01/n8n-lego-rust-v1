# CONTRACT: L05.S02 — Durable WAL and Transactions

## 1. Sub-LEGO Identity
- **ID**: `L05.S02`
- **Name**: Durable WAL and transactions
- **Owning LEGO**: `L05-data-storage`
- **Ownership Team**: `data-persistence`
- **Execution Model**: `stateful-component`
- **Runtime Host**: `H05` (Data Host)
- **State Ownership**: `wal-append-records`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `rolling-dual-version`

---

## 2. Provided Ports

### `port.storage.wal.append.v1`
- **Category**: Command / Data
- **Purpose**: Menulis record eksekusi baru secara durable (append-only + fsync) ke file WAL.
- **Request Shape**: `{ "execution_id": string, "lsn": u64, "record_type": string, "payload": Value }`
- **Response Shape**: `{ "appended_lsn": u64, "bytes_written": u64, "synced": bool }`
- **Error Taxonomy**: `PortErrorCode::InternalError`, `PortErrorCode::Unavailable`

### `port.storage.wal.read.v1`
- **Category**: Query / Data
- **Purpose**: Membaca deretan record WAL untuk proses verifikasi dan restart replay.
- **Request Shape**: `{ "execution_id": string, "from_lsn": u64 }`
- **Response Shape**: `{ "records": Vec<WalRecord>, "eof": bool }`

---

## 3. Required Ports
- `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)

---

## 4. Invariants & Fail-Closed Policy
1. **FAIL-CLOSED ABSOLUT**: Jika direktori WAL tidak dapat dibuat, file WAL tidak dapat dibuka, atau disk penuh/error, operasi penulisan HARUS GAGAL SEKETIKA (FAIL).
2. Sistem DILARANG KERAS melakukan silent downgrade ke in-memory storage bila WAL gagal!
