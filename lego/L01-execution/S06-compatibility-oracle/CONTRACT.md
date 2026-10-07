# CONTRACT: L01.S06 — Compatibility oracle

## 1. Sub-LEGO Identity
- **ID**: `L01.S06`
- **Name**: Compatibility oracle
- **Owning LEGO**: `L01-execution`
- **Ownership Team**: `execution-engine`
- **Execution Model**: `tooling`
- **Runtime Host**: `H07` (Compatibility Host)
- **State Ownership**: `golden-differential-corpus`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.execution.oracle.verify.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.execution.run.workflow.v1` (Provider: `L01.S01`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`golden-differential-corpus`).
4. Model eksekusi mematuhi batasan runtime host `H07` (Compatibility Host).
