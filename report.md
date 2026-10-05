# Laporan Reorganisasi Monorepo: n8n Rust v4

## 1. Lokasi Source Ketiga Project Sebelum Reorganisasi
- **n8n Lego / Frontend (Port 5677)**:
  - Sebelum: `apps/n8n-lego/` dan mirror di `n8n lego/apps/n8n-lego/`
- **n8n Rust Core / Backend (Port 5678)**:
  - Sebelum: Tersebar antara `/home/catzpro01/n8n-rust/n8n_rust_core/` di WSL, file root scratch `server.rs`, serta workspace libraries di `crates/`
- **Official n8n Reference / Oracle (Port 5680)**:
  - Sebelum: `reference/n8n/` dan instalasi global npm n8n di WSL `/home/catzpro01/.nvm/versions/node/v22.23.2/lib/node_modules/n8n/`

---

## 2. Lokasi Setelah Reorganisasi
- **`apps/n8n-lego/`**: Frontend UI adapter (Vue 3 / n8n-editor-ui bundle) & server ringan (Port 5677).
- **`apps/n8n-rust/`**: Standalone Axum backend server + workflow scheduler & executor (Port 5678).
- **`apps/n8n-reference/`**: Official n8n oracle runner & configuration wrapper (Port 5680).
- **`crates/`**: 8 Core Cargo Workspace Shared Libraries (`n8n-common`, `n8n-workflow`, `n8n-connection`, `n8n-validation`, `n8n-node-model`, `n8n-execution-data`, `n8n-expression`, `n8n-nodes-rust`).

---

## 3. Struktur Directory Final
```text
n8n-rust-v.4/
├── apps/
│   ├── n8n-lego/             # Frontend adapter (Port 5677)
│   ├── n8n-rust/             # Rust core backend (Port 5678)
│   └── n8n-reference/        # Official n8n oracle (Port 5680)
│
├── crates/                   # Cargo Workspace Libraries
│   ├── n8n-common/
│   ├── n8n-workflow/
│   ├── n8n-connection/
│   ├── n8n-validation/
│   ├── n8n-node-model/
│   ├── n8n-execution-data/
│   ├── n8n-expression/
│   └── n8n-nodes-rust/
│
├── workers/                  # Future Out-of-Process Execution Workers
│   ├── code-worker/
│   │   ├── javascript/       # Planned (Not Implemented)
│   │   ├── python/           # Planned (Not Implemented)
│   │   └── php/              # Planned (Not Implemented)
│   └── node-compat-worker/   # Planned (Not Implemented)
│
├── compatibility/            # Oracle Semantic Diff Testing Suite
│   ├── workflows/            # Workflow test definitions (.gitkeep)
│   ├── fixtures/             # Input mock fixtures (.gitkeep)
│   ├── expected/             # Golden reference outputs (.gitkeep)
│   └── reports/              # Diff reports (.gitkeep)
│
├── scripts/
│   └── start-all.mjs         # Multi-instance orchestrator
├── docs/
│   └── architecture-v4-foundation.md
├── data/                     # Local data directories (Git-Ignored)
│   ├── lego/                 # Local sqlite / sessions
│   ├── rust/                 # Local sqlite DB
│   ├── reference/            # Local n8n user folder
│   └── test/                 # Test scratch
│
├── .env.example              # Environment variables template
├── .gitignore                # Strict ignore rules
├── Cargo.toml                # Root workspace manifest
└── README.md                 # Monorepo architecture & run instructions
```

---

## 4. Repository Git yang Digunakan
- **Repository Aktif (Monorepo Baru)**: `n8n-rust-v.4`
- **Remote URL**: `https://github.com/Catzpro01/n8n-rust-v.4.git`

---

## 5. Repository Lama yang TIDAK Disentuh (Read-Only)
- **`n8nrustv.4` / `n8n-rust` (WSL clone upstream n8n-io/n8n)**: 100% READ-ONLY, tidak ada modifikasi, commit, delete, ataupun push.
- Seluruh file hanya disalin (*read/copy*) ke repository baru `n8n-rust-v.4`.

---

## 6. File yang Dipindahkan / Disalin
- Disalin source Axum backend dari WSL ke `apps/n8n-rust/`:
  - `src/` (`main.rs`, `server.rs`, `db.rs`, `executor.rs`, `scheduler.rs`, `evaluator.rs`, `events.rs`, `workflow.rs`, `parser.rs`, `nodes/`)
  - File metadata JSON (`roles.json`, `settings_complete.json`, `global_scopes.json`, `project_relations.json`, `project_scopes.json`)
  - `Cargo.toml`, `build.rs`, `package.json`, `README.md`
- Dibuat `apps/n8n-reference/` (`package.json`, `index.mjs`, `README.md`).
- Dibuat struktur placeholder `workers/` dan `compatibility/`.
- Dibuat launcher `scripts/start-all.mjs`.

---

## 7. File yang Sengaja Tidak Dimasukkan Git (Ignored)
- **Database & State**: `*.db`, `*.sqlite`, `*.sqlite3`, `*.sqlite-wal`, `*.sqlite-shm`
- **Dependencies & Build**: `node_modules/`, `target/`, `dist/`, `*.tsbuildinfo`, `*.node`
- **Credentials & Secrets**: `.env`, `.env.*`
- **Instance Runtime Data**: `data/lego/*`, `data/rust/*`, `data/reference/*`, `data/test/*` (hanya `.gitkeep` yang disimpan)
- **Logs & Temporary**: `logs/`, `tmp/`, `*.log`, `.runtime/`
- **Local Scratch & Mirror**: Folder lokal `/n8n lego/`, `/n8n-rust/`, dan file scratch `*.rs` di root.

---

## 8. Hasil `git status`
```text
On branch audit/v4-foundation
Your branch is up to date with 'origin/audit/v4-foundation'.

nothing to commit, working tree clean
```

---

## 9. Hasil `cargo check`
- **Workspace Crates**:
  ```text
  cargo check --workspace
  Finished dev profile [unoptimized + debuginfo] target(s) in 0.15s (Exit Code: 0)
  ```
- **Backend App (`apps/n8n-rust`)**:
  ```text
  cargo check --manifest-path apps/n8n-rust/Cargo.toml
  Finished dev profile [unoptimized + debuginfo] target(s) in 7.12s (Exit Code: 0)
  ```
- **Workspace Tests**:
  `cargo test --workspace` -> 111 tests passed, 0 failed.

---

## 10. Hasil Pengecekan Bahwa Port 5677, 5678, dan 5680 Dapat Dikonfigurasi
- **Port 5677 (`apps/n8n-lego`)**: Dikonfigurasi via `N8N_LEGO_PORT` atau `N8N_PORT` di `apps/n8n-lego/src/config.mjs` (default: 5677).
- **Port 5678 (`apps/n8n-rust`)**: Dikonfigurasi via `N8N_RUST_PORT` atau `PORT` di `apps/n8n-rust/src/main.rs` (default: 5678).
- **Port 5680 (`apps/n8n-reference`)**: Dikonfigurasi via `N8N_REFERENCE_PORT` atau `N8N_PORT` di `apps/n8n-reference/index.mjs` (default: 5680).
- Pengecekan parsing lingkungan:
  ```json
  { "legoPort": 5677, "rustPort": 5678, "refPort": 5680 }
  ```

---

## 11. Commit Hash
- **`5b0fd5e25`** (`chore(v4): organize three projects into monorepo`)

---

## 12. Branch
- **`audit/v4-foundation`**

---

## 13. Remote Git yang Digunakan
- **`origin`**: `https://github.com/Catzpro01/n8n-rust-v.4.git`
