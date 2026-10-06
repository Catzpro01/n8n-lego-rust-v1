# CONTRACT: L01.S02 — Wait and resume

## 1. Sub-LEGO Identity
- **ID**: `L01.S02`
- **Name**: Wait and resume
- **Owning LEGO**: `L01-execution`
- **Ownership Team**: `execution-engine`
- **Execution Model**: `stateful-component`
- **Runtime Host**: `H03` (Execution Host)
- **State Ownership**: `wait-resumption-index`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.execution.wait.suspend.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.execution.wait.resume.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.execution.run.workflow.v1` (Provider: `L01.S01`)
- `port.storage.wal.append.v1` (Provider: `L05.S02`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`wait-resumption-index`).
4. Model eksekusi mematuhi batasan runtime host `H03` (Execution Host).
