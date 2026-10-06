# LEGO Architecture Baseline Audit (D0 Gate)

## 1. Executive Summary

Audit ini memetakan kondisi pohon sumber repository `Catzpro01/n8n-lego-rust-v1` terhadap arsitektur target **LEGO → Sub-LEGO → Port → Adapter → Runtime Host** (Issue #4).

Baseline commit: `e83b94ed9bb7f56c20ca631e6c58b73a3361c2d9` (origin/main).

Repository saat ini memiliki 16 workspace crates di `crates/` dan 1 standalone binary app di `apps/n8n-rust`. Struktur ini mewarisi pengelompokan lama berbasis crate monolitik / semi-modular dan mengandung *mixed ownership* serta *in-memory durability downgrades* yang melanggar aturan isolasi.

---

## 2. Inventaris Crates Eksisting vs Sub-LEGO Ownership

| Komponen Eksisting | Path | Capability Saat Ini | Sub-LEGO Pemilik Utama | Mixed Ownership / Isu Arsitektur |
|---|---|---|---|---|
| `crates/n8n-common` | `crates/n8n-common` | Primitif tipe node data (`INodeExecutionData`), item list | `L00.S01` (Runtime Contracts), `L05.S03` | Bercampur antara envelope runtime dengan data plane payload |
| `crates/n8n-workflow` | `crates/n8n-workflow` | Definisi workflow, Graph traversal, validator, checksum | `L01.S01` (Execution Semantics), `L01.S05` | Memuat traversal, static validator, dan metadata workflow sekaligus |
| `crates/n8n-connection` | `crates/n8n-connection` | Graph edge connection, pin connection data | `L01.S01`, `L05.S03` | Mengikat topological edge dengan data pinning |
| `crates/n8n-validation` | `crates/n8n-validation` | Parameter validation, schema assertion | `L04.S08` (Dynamic schema/param), `L00.S03` | Validasi parameter terpisah dari node-model |
| `crates/n8n-node-model` | `crates/n8n-node-model` | Deklarasi node, property specification, node category | `L04.S01` (Node Registry & Admission) | Relatif terisolasi, namun belum memakai Port typed contract |
| `crates/n8n-execution-data` | `crates/n8n-execution-data` | Execution task run data structures | `L05.S03` (Execution Data Plane) | Masih memakai format representasi serialisasi langsung |
| `crates/n8n-expression` | `crates/n8n-expression` | AST parser & evaluator untuk ekspresi `{{ $json... }}` | `L01.S01` (Execution Semantics - pure library) | Komponen pure yang sehat, perlu port contract neutral |
| `crates/n8n-nodes-rust` | `crates/n8n-nodes-rust` | Implementasi node native Rust (Set, Code, HttpRequest, dll) | `L04.S03` (Native Rust Node Catalog) | Sebagian node berinteraksi langsung dengan network/env tanpa sandboxing |
| `crates/n8n-realtime` | `crates/n8n-realtime` | WebSocket broadcaster, connection session pool | `L06.S01` (Realtime Event Contract), `L09.S03` | Broadcaster generic belum memisahkan audit vs browser push |
| `crates/n8n-events` | `crates/n8n-events` | Struct event lifecycle (NodeStart, NodeFinish, etc) | `L06.S01`, `L06.S02` | Event primitif belum menggunakan envelope typed port |
| `crates/n8n-queue` | `crates/n8n-queue` | In-memory priority queue | `L07.S03` (Queue / Lease Model) | Masih murni in-memory, belum mendukung durable lease |
| `crates/n8n-binary-data` | `crates/n8n-binary-data` | Storage buffer binary, mime type detection | `L05.S04` (Binary Data & Streaming) | Masih buffer lokal memori/file sementara |
| `crates/n8n-subworkflow` | `crates/n8n-subworkflow` | Runner isolated child workflow | `L01.S03` (Sub-workflows) | Terikat langsung pada executor kernel |
| `crates/n8n-error-recovery`| `crates/n8n-error-recovery` | Retry policy, exponential backoff, circuit breaker | `L01.S01`, `L07.S02` | Logic terisolasi tapi belum diekspos sebagai reusable port |
| `crates/n8n-credentials` | `crates/n8n-credentials` | Secret storage, encryption key, SecretRef | `L02.S04` (Credential Broker), `L02.S05` | Sudah memiliki konsep SecretRef, perlu pengetatan boundary |
| `crates/n8n-runtime-kernel`| `crates/n8n-runtime-kernel` | `KernelScheduler`, `ExecutionPlan`, `ExecutionJournal`, `MemoryGovernor`, `LoopManager` | `L01.S01`, `L01.S04`, `L00.S03`, `L05.S02` | **GOD CRATE**: Menggabungkan scheduling, memory limits, loop handling, dan WAL ke dalam satu crate |
| `apps/n8n-rust` | `apps/n8n-rust` | Axum HTTP server, SQLite database, IPC headless CLI | `H01` (Gateway Host), `H03` (Execution), `L05.S01` (DB) | **MIXED APPLICATION**: Menggabungkan HTTP routing, DB schema/queries, CLI IPC, dan engine invocation |

---

## 3. Identifikasi Masalah Kritis & Pelanggaran Arsitektur

### 3.1 Masalah Commit 1d5701841: WAL Silently Downgrade ke In-Memory (Issue #4 Poin 13)
Pada `apps/n8n-rust/src/main.rs`:
```rust
let scheduler = match KernelScheduler::new_with_durable_wal(SchedulerOptions::default(), &wal_file).await {
    Ok(s) => s,
    Err(err) => {
        eprintln!("[WAL-ERROR] Gagal inisialisasi durable WAL ..., fallback ke default");
        KernelScheduler::default()
    }
};
```
- **Pelanggaran**: Ketika path WAL tidak bisa dibuat atau file WAL korup/tidak bisa dibuka, sistem diam-diam downgrade ke in-memory journal (`KernelScheduler::default()`).
- **Dampak**: Kehilangan jaminan ketahanan data (durability) dan melanggar prinsip *fail-closed* untuk production IPC.
- **Tindakan Perbaikan**: Wajib fail-closed: gagal buat dir WAL atau gagal inisialisasi WAL harus langsung membatalkan eksekusi dengan exit code 1 dan structured JSON error.

### 3.2 God Module & Mixed Responsibilities
- `crates/n8n-runtime-kernel` mengelola lifecycle, resource governors, loop management, WAL journal, dan task execution.
- `apps/n8n-rust` mengelola REST server, WebSocket server, SQLite persistence, dan scheduler execution.
- Tidak ada batas Port yang jelas: komponen memanggil fungsi internal satu sama lain secara langsung (`scheduler.execute_plan(...)`, `db.save_execution(...)`).

### 3.3 Status Registry Eksisting
- File `docs/migration/LEGO-SUBLEGO-REGISTRY.yaml` sebelumnya memiliki sintaks YAML invalid (parsing error pada blok inline dict).
- Port yang dideklarasikan sebelumnya hanyalah nama placeholder generik (`Lxx.Syy.provided.v1`, `Lxx.Syy.required.v1`).
- Belum ada model kontraktual port yang typed, versioned, transport-neutral, dan dapat divalidasi secara otomatis.

---

## 4. Rencana Aksi Delivery Stages (D0 → D7)

1. **D0 (Baseline & Freeze)**: Validasi dan standarisasi registry 83 Sub-LEGO lengkap, rekam ownership debt.
2. **D1 (Contract & Port Foundation)**: Implementasi crate `n8n-port-contract` dengan tipe Rust untuk Port, Invocation, Response, SecurityContext, DataHandle, StreamPort, dan Port Lifecycle.
3. **D2 (Dependency & Runtime Composition)**: Bangun acyclic dependency graph validator, Runtime Host matrix (H01–H07), dan Version Negotiation (v1+v2).
4. **D3 (Security, Reliability & Data Boundaries)**: Security default-deny, SecretRef enforcement, DataHandle large payload vs control-plane separation, observability metrics.
5. **D4 (Physical Sub-LEGO Migration)**: Pembentukan canonical directory `lego/` untuk Sub-LEGO prioritas (`L00.S01`, `L01.S04`, `L02.S04`, `L05.S02`) dengan `CONTRACT.md`, `ports/`, `implementation/`, `tests/`, `evidence/`.
6. **D5 (Runtime Extraction & Scalability)**: In-process adapter dan Framed IPC adapter yang menjalankan port contract yang sama.
7. **D6 (Upgrade, Recovery & WAL Fail-Closed)**: Perbaikan fail-closed WAL di `apps/n8n-rust`, negative tests, recovery tests, dan dual-version upgrade test.
8. **D7 (Architecture Certification & CI Enforcement)**: Tool CI architecture checker otomatis, verifikasi menyeluruh, dan pembaruan `report.md`.
