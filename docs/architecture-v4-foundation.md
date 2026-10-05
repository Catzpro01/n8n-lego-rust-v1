# n8n Rust Engine v4 Architecture Specification
**Version**: `v4.0.0-alpha.2` (Foundation Workspace Integration)  
**Status**: Integrated Workspace Foundation  
**Auditor Target**: Internal & External Code Review (Staff Engineer / Principal Tier)

---

## 1. System Topology & 3-Environment Oracle Strategy

Untuk mencapai 100% paritas perilaku dengan n8n resmi tanpa menebak semantik edge-case, arsitektur mempertahankan tiga lingkungan layanan:

| Port | Service Name | Purpose |
|---|---|---|
| **5677** | `n8n-lego` | Frontend UI adapter ringan (Vue 3 / editor bundle). |
| **5678** | `n8n-rust` | Engine eksekusi workflow Rust berkinerja tinggi. |
| **5680** | `n8n-reference` | Instance resmi n8n (Docker / Node) sebagai authoritative truth Oracle. |

### Semantic Diff Testing
Alih-alih sekadar membandingkan HTTP status code, workflow uji dieksekusi secara identik di `n8n-reference` (port 5680) dan `n8n-rust` (port 5678), membandingkan:
- Urutan eksekusi node (DAG traversal order)
- Jumlah item dan mutasi properti JSON
- Metadata `pairedItem` linking
- Routing percabangan (port IF / Switch)
- Propagasi error state dan retry failure semantics

---

## 2. Workspace Monorepo Integration (Official 8-Crate Architecture)

Seluruh implementasi runtime dan node terintegrasi langsung ke dalam arsitektur Cargo workspace resmi (tanpa crate paralel terpisah):
- `crates/n8n-common`: Primitive tipe, ID, dan error contracts.
- `crates/n8n-workflow`: DAG IR lowering, runtime scheduler, execution frames, loop manager, sub-workflow isolator, dan cancellation tokens.
- `crates/n8n-connection`: Graph edge resolution dan connection matrix.
- `crates/n8n-validation`: Schema validator dan parameter conformance.
- `crates/n8n-node-model`: Model metadata node resmi dan definisi parameter.
- `crates/n8n-execution-data`: Data plane memory structures (`INodeExecutionData`, `pairedItem`).
- `crates/n8n-expression`: Expression resolver engine.
- `crates/n8n-nodes-rust`: Registry node eksekusi bawaan:
  - `IfNode`, `SetNode`
  - `CodePolyglotNode` (Piped IPC Fast Execution)
  - `DynamicIntegrationNode` (Declarative Integration IR)
  - `RuntimeRegistry` (Deterministic language runtime resolution & cache)

---

## 3. Tiered Node Execution Model

```
                      ┌─────────────────────────┐
                      │    n8n Vue Editor UI    │
                      └────────────┬────────────┘
                                   │ REST / WebSocket
                      ┌────────────▼────────────┐
                      │    Workflow Runtime     │
                      │  (n8n-workflow Engine)  │
                      └────────────┬────────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         │                         │                         │
┌────────▼────────┐       ┌────────▼────────┐       ┌────────▼────────┐
│  Tier 1: Native │       │ Tier 2: Decl IR │       │ Tier 3: Compat  │
│   Rust Nodes    │       │ IntegrationSpec │       │  Worker Pool    │
│ (Core Nodes)    │       │ (Reqwest Proxy) │       │  (Node.js SDK)  │
└─────────────────┘       └─────────────────┘       └─────────────────┘
```

### Tier 1 — Native Rust Core Nodes
Node dengan eksekusi instan di Rust (`IfNode`, `SetNode`, kontrol alur data).

### Tier 2 — Declarative Integration IR (`IntegrationSpec`)
Untuk integrasi REST eksternal eksplisit (Telegram, Slack, Discord, Explicit HttpRequest):
- Parameter dikompilasi secara deterministik ke `IntegrationSpec`.
- **Strict Error Handling**: Tidak ada fallback ke `httpbin.org`. Node yang belum didukung langsung mengembalikan error eksplisit (`NodeExecutionError::InvalidParameter`), menolak false-success.
- **Fail-Closed Network**: Network failure dikembalikan sebagai `NodeExecutionError::ExecutionFailed`, bukan disamarkan sebagai item sukses berisi JSON error.

### Tier 3 — Node.js Compatibility Worker (Planned)
Untuk node kompleks berbasis SDK proprietary / OAuth dinamis yang memerlukan kompatibilitas 100% n8n runtime.

---

## 4. Polyglot Code Node Execution & Security Controls

### Piped In-Memory IPC
- **Zero-Disk I/O**: Tidak menulis skrip/payload ke file sementara `/tmp`.
- **Concurrent I/O Anti-Deadlock**: Pembacaan stream `stdout` dan `stderr` dilakukan secara paralel melalui `tokio::join!(read_stdout, read_stderr)` untuk mencegah kebuntuan buffer pipe saat child process menghasilkan output besar.
- **Process Lifecycle Guard**: Menggunakan `Command::kill_on_drop(true)` pada child process untuk mencegah zombie/orphan process saat timeout atau pembatalan eksekusi.
- **PairedItem Preservation**: Mempertahankan tracking `pairedItem` pada setiap item data untuk menjaga kompatibilitas semantik n8n.

### Deterministic Runtime Registry
- Memetakan `(language, version)` ke binary absolut (misal `/usr/bin/node`, `/bin/python3`).
- Runtime default di-resolve saat inisialisasi; runtime versi spesifik di-resolve melalui `mise which` dan di-cache.
- **Strict Version Pinning (Fail-Closed)**: Jika runtime versi spesifik yang diminta (contoh `python@3.13`) tidak ditemukan, eksekusi **gagal dengan error deterministik**, tidak ada fallback diam-diam ke runtime default sistem.
