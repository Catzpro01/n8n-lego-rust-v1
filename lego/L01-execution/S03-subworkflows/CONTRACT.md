# CONTRACT: L01.S03 — Sub-workflows

## 1. Sub-LEGO Identity
- **ID**: `L01.S03`
- **Name**: Sub-workflows
- **Owning LEGO**: `L01-execution`
- **Ownership Team**: `execution-engine`
- **Execution Model**: `in-process`
- **Runtime Host**: `H03` (Execution Host)
- **State Ownership**: `subworkflow-call-hierarchy`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.execution.subworkflow.invoke.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.execution.run.workflow.v1` (Provider: `L01.S01`)
- `port.runtime.budget.allocate.v1` (Provider: `L00.S03`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`subworkflow-call-hierarchy`).
4. Model eksekusi mematuhi batasan runtime host `H03` (Execution Host).
