# Audit & Execution Report: 3 Isolated Environments Monorepo Setup

## NEW REPOSITORY
**Name**: Catzpro01/n8n-lego-rust-v1  
**URL**: https://github.com/Catzpro01/n8n-lego-rust-v1  
**Branch**: main  

## OLD REPOSITORIES TOUCHED: MUST BE NONE
- `Catzpro01/n8n-rust-v.4`: **READ-ONLY / NOT TOUCHED**
- `Catzpro01/n8nrustv.4`: **READ-ONLY / NOT TOUCHED**

## LOCAL ROOT
`C:\Users\user\Downloads\n8n-lego-rust-v1`

## 3 ISOLATED ENVIRONMENTS SPECIFICATION

### 1. n8n Lego (UI & Frontend Adapter)
- **App Path**: `apps/n8n-lego`
- **Port**: `5677`
- **Data Folder**: `data/lego/`
- **Database**: `data/lego/*.json` (Atomic file store)
- **Environment**: `apps/n8n-lego/.env.example` (`PORT=5677`, `N8N_USER_FOLDER=../../data/lego`)
- **Dependencies**: `apps/n8n-lego/package.json` (`n8n-editor-ui@2.9.4`)
- **Process Lifecycle**: Terdaftar dalam `data/.pids.json`

### 2. n8n Rust (DAG Execution Engine Core)
- **App Path**: `apps/n8n-rust`
- **Port**: `5678`
- **Data Folder**: `data/rust/`
- **Database**: SQLite terisolasi di `data/rust/n8n.sqlite` (`DATABASE_URL=sqlite://../../data/rust/n8n.sqlite`)
- **Environment**: `apps/n8n-rust/.env.example` (`N8N_RUST_PORT=5678`, `N8N_RUST_DATA_DIR=../../data/rust`)
- **Dependencies**: Terisolasi di `apps/n8n-rust/Cargo.toml` & `apps/n8n-rust/Cargo.lock`
- **Build Target**: `apps/n8n-rust/target/` (terpisah dari shared crates workspace)
- **Process Lifecycle**: Terdaftar dalam `data/.pids.json`

### 3. Official n8n Reference (Truth Oracle)
- **App Path**: `apps/n8n-reference`
- **Port**: `5680`
- **Data Folder**: `data/reference/`
- **Database**: Official SQLite di `data/reference/database.sqlite`
- **Environment**: `apps/n8n-reference/.env.example` (`N8N_PORT=5680`, `N8N_USER_FOLDER=../../data/reference`)
- **Dependencies**: `apps/n8n-reference/package.json` (`n8n@2.9.4`)
- **Process Lifecycle**: Terdaftar dalam `data/.pids.json`

## SHARED ASSETS (STRICTLY SHARED ONLY)
- `crates/`: 8 shared Rust crates (`n8n-common`, `n8n-workflow`, `n8n-connection`, `n8n-validation`, `n8n-node-model`, `n8n-execution-data`, `n8n-expression`, `n8n-nodes-rust`)
- `workers/`: runtime worker definitions
- `compatibility/`: oracle diff tests, fixtures, dan expected golden outputs

## ORCHESTRATION & SAFE PROCESS MANAGEMENT
- `scripts/start-all.mjs` / `npm start`: Menjalankan ketiga instance secara bersamaan dan mencatat PID ke `data/.pids.json`.
- `scripts/stop-all.mjs` / `npm run stop`: Membaca PID dari `data/.pids.json` dan mematikan proses terdaftar saja tanpa membunuh proses sistem secara global.

## AUDIT & VALIDATION RESULTS
1. **Filesystem Audit**:
   - Nested `.git`: **NONE**
   - Active secrets (`.env`): **NONE**
   - Active database files (`*.db`, `*.sqlite`, `*.sqlite3`): **NONE** (git-ignored)
   - Runtime noise: **NONE**
2. **Database Isolation Audit**:
   - Lego: File-based JSON store di `data/lego`
   - Rust: SQLite di `data/rust/n8n.sqlite`
   - Reference: SQLite di `data/reference/database.sqlite`
   - Status: **100% DISJOINT & ISOLATED**
3. **Rust Compilation & Tests**:
   - `cargo check --workspace`: **PASSED** (0 errors)
   - `cargo test --workspace`: **PASSED** (111 tests passed, 0 failed)
   - `cargo check --manifest-path apps/n8n-rust/Cargo.toml`: **PASSED** (0 errors)
4. **Port & Config Contract Validation**:
   - 5677 -> Lego (data/lego) -> **VERIFIED**
   - 5678 -> Rust (data/rust) -> **VERIFIED**
   - 5680 -> Reference (data/reference) -> **VERIFIED**
