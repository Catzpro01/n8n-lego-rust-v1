# n8n Lego Rust v1

Monorepo eksperimen dan alpha foundation untuk migrasi execution engine n8n ke Rust.

## Tiga Project & Port Instances

| Port | Service | Directory | Deskripsi |
|:---|:---|:---|:---|
| **5677** | **n8n Lego frontend** | `apps/n8n-lego/` | Frontend UI adapter (Vue 3 / n8n-editor-ui bundle) & lightweight server |
| **5678** | **n8n Rust backend** | `apps/n8n-rust/` | High-performance standalone Rust DAG execution engine (Axum + Tokio) |
| **5680** | **official n8n reference** | `apps/n8n-reference/` | Upstream official n8n acting as authoritative Truth Oracle for semantic diffs |

---

## Topologi Arsitektur

```text
                           ┌─────────────────────────┐
                           │    Browser / Web UI     │
                           └────────────┬────────────┘
                                        │
                 ┌──────────────────────┼──────────────────────┐
                 │ :5677                │ :5678                │ :5680
                 ▼                      ▼                      ▼
        ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
        │  apps/n8n-lego  │    │  apps/n8n-rust  │    │apps/n8n-referenc│
        │   (Frontend)    │    │ (Rust Backend)  │    │(Official Oracle)│
        └────────┬────────┘    └────────┬────────┘    └────────┬────────┘
                 │                      │                      │
                 │ REST / Workflows     │ Tokio Execution      │ Golden Replay
                 ▼                      ▼                      ▼
        ┌───────────────────────────────────────────────────────────────┐
        │                       crates/ Workspace                       │
        │  n8n-common  │  n8n-workflow  │  n8n-nodes-rust  │ ...       │
        └───────────────────────────────┬───────────────────────────────┘
                                        │
                                        ▼
                             ┌─────────────────────┐
                             │ compatibility/ diff │
                             │  oracle validation  │
                             └─────────────────────┘
```

---

## Struktur Direktori Monorepo

```text
n8n-lego-rust-v1/
├── apps/
│   ├── n8n-lego/             # Frontend adapter (Port 5677)
│   ├── n8n-rust/             # Rust core backend (Port 5678)
│   └── n8n-reference/        # Official n8n oracle (Port 5680)
│
├── crates/                   # Cargo Workspace Shared Libraries
│   ├── n8n-common/           # Core contracts and error types
│   ├── n8n-workflow/         # Workflow graph lowering & runtime engine
│   ├── n8n-connection/       # Connection routing & graph edges
│   ├── n8n-validation/       # Parameter & schema validation
│   ├── n8n-node-model/       # Official node metadata models
│   ├── n8n-execution-data/   # INodeExecutionData & pairedItem plane
│   ├── n8n-expression/       # Expression evaluation engine
│   └── n8n-nodes-rust/       # Native Rust nodes & runtime registry
│
├── workers/                  # Future Out-of-Process Execution Workers
│   ├── code-worker/          # JavaScript, Python, PHP workers (Planned)
│   └── node-compat-worker/   # Sidecar Node.js compatibility worker (Planned)
│
├── compatibility/            # Oracle Semantic Diff Testing Suite
│   ├── workflows/            # Workflow test definitions (.gitkeep)
│   ├── fixtures/             # Input mock payloads (.gitkeep)
│   ├── expected/             # Golden reference outputs (.gitkeep)
│   └── reports/              # Diff verification reports (.gitkeep)
│
├── scripts/
│   └── start-all.mjs         # Multi-instance orchestrator launcher
├── docs/
│   └── architecture-v4-foundation.md
├── data/                     # Local Instance State (Strictly Git-Ignored)
│   ├── lego/                 # Local sqlite / sessions
│   ├── rust/                 # Local sqlite DB
│   ├── reference/            # Local n8n user folder
│   └── test/                 # Test scratch
│
├── Cargo.toml                # Root Cargo workspace manifest
├── Cargo.lock                # Pinned Cargo lockfile
├── package.json              # Monorepo management scripts
├── README.md                 # Project documentation
├── .env.example              # Environment variables template
└── .gitignore                # Strict ignore policy (no db, no binaries)
```

---

## Cara Menjalankan Instance

### 1. Menjalankan Ketiga Instance Sekaligus
```bash
node scripts/start-all.mjs
# Atau via npm:
npm start
```

### 2. Menjalankan Masing-Masing Secara Terpisah

- **n8n Lego Frontend (Port 5677)**:
  ```bash
  N8N_LEGO_PORT=5677 node apps/n8n-lego/bin/n8n-lego.mjs start
  ```

- **n8n Rust Backend (Port 5678)**:
  ```bash
  N8N_RUST_PORT=5678 cargo run --manifest-path apps/n8n-rust/Cargo.toml
  ```

- **Official n8n Reference (Port 5680)**:
  ```bash
  N8N_REFERENCE_PORT=5680 node apps/n8n-reference/index.mjs
  ```

---

## Oracle Verification Workflow

```text
workflow.json
   ├──> official n8n :5680  ───> golden_output.json
   │
   └──> Rust n8n     :5678  ───> candidate_output.json
             │
             ▼
   semantic diff comparison (node sequence, item mutation, pairedItem)
```
