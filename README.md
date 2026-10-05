# n8n Rust v4

Monorepo containing:

- **n8n Lego frontend** (`apps/n8n-lego`)
- **n8n Rust execution backend** (`apps/n8n-rust`)
- **official n8n reference instance** (`apps/n8n-reference`)

## Ports

| Port | Service | Directory | Purpose |
|:---|:---|:---|:---|
| **5677** | Lego | `apps/n8n-lego/` | Frontend UI adapter (Vue 3 / n8n-editor-ui) & lightweight server |
| **5678** | Rust | `apps/n8n-rust/` | High-performance standalone Rust DAG execution engine |
| **5680** | Reference | `apps/n8n-reference/` | Official upstream n8n serving as Truth Oracle for semantic diffs |

---

## Architecture Overview

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

## Directory Layout

```text
n8n-rust-v.4/
├── apps/
│   ├── n8n-lego/             # Lego frontend adapter (Port 5677)
│   ├── n8n-rust/             # Rust core backend server (Port 5678)
│   └── n8n-reference/        # Official n8n oracle instance (Port 5680)
│
├── crates/                   # Cargo Workspace Libraries
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
│   ├── workflows/            # Standard benchmark workflow definitions
│   ├── fixtures/             # Input mock payloads
│   ├── expected/             # Golden outputs from port 5680
│   └── reports/              # Diff verification reports
│
├── data/                     # Local Instance State (Ignored in Git)
│   ├── lego/                 # Lego data folder (sqlite/sessions)
│   ├── rust/                 # Rust database storage
│   ├── reference/            # Upstream n8n user folder
│   └── test/                 # Test scratch data
│
├── scripts/                  # Management & multi-instance launchers
├── docs/                     # Architectural specifications
├── .env.example              # Environment variables template
├── .gitignore                # Strict ignore policy (no db, no node_modules)
└── Cargo.toml                # Root Cargo workspace manifest
```

---

## Running the Instances

### 1. Run All Three Instances Simultaneously
```bash
node scripts/start-all.mjs
```

### 2. Run Individually

- **Lego Frontend (5677)**:
  ```bash
  N8N_LEGO_PORT=5677 node apps/n8n-lego/bin/n8n-lego.mjs start
  ```

- **Rust Backend (5678)**:
  ```bash
  N8N_RUST_PORT=5678 cargo run -p n8n-rust-app
  ```

- **Reference Oracle (5680)**:
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
   semantic diff comparison (node order, item mutation, pairedItem)
```
