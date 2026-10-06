# CONTRACT: L01.S02 — Graph Evaluation Engine

## 1. Sub-LEGO Identity
- **ID**: `L01.S02`
- **Name**: Graph Evaluation Engine
- **Owning LEGO**: `L01-execution`
- **Ownership Team**: `execution-engine`
- **Execution Model**: `in-process`
- **Runtime Host**: `H03` (Execution Host)
- **State Ownership**: `graph-evaluation-index`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports

### `port.execution.graph.evaluate.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active
- **Description**: Evaluates workflow DAG topologies, validates acyclicity (cycle detection), discovers root triggers and terminal nodes, detects multi-parent diamond convergence, and determines topological execution ordering.

### `port.execution.node.status.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active
- **Description**: Manages node execution lifecycle states, enforces valid FSM transitions (`Pending`, `Running`, `Succeeded`, `Failed`, `Skipped`, `Waiting`), and guarantees terminal state immutability.

### `port.execution.wait.suspend.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active
- **Description**: Suspends an execution frame at a wait node (for webhook/delay/event resume paths).

### `port.execution.wait.resume.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active
- **Description**: Resumes a suspended wait frame back into active execution.

---

## 3. Required Ports
- `port.execution.run.workflow.v1` (Provider: `L01.S01`)
- `port.storage.wal.append.v1` (Provider: `L05.S02`)

---

## 4. Invariants & Rules
1. **DAG Acyclicity Invariant**: Evaluator wajib mendeteksi dan menolak siklus pada graf sebelum eksekusi dimulai.
2. **Topological Precedence**: Urutan eksekusi menjamin seluruh parent node dieksekusi sebelum node anak, termasuk pola konvergensi diamond (multi-parent).
3. **Node Status FSM Immutability**:
   - `Pending -> Running | Skipped | Failed`
   - `Running -> Succeeded | Failed | Waiting`
   - `Waiting -> Running | Failed`
   - Terminal states (`Succeeded`, `Failed`, `Skipped`) bersifat absolut imutabel dan menolak transisi lebih lanjut.
4. **Zero Cross-Sub-LEGO Private Imports**: Kode implementasi terisolasi mandiri dan hanya berinteraksi melalui typed port contracts.
5. **Runtime Host Compatibility**: Dirancang netral terhadap transport dan mematuhi batasan host eksekusi `H03`.
