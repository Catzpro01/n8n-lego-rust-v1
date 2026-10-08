# CONTRACT: L08.S07 — Token/execution budgets

## 1. Sub-LEGO Identity
- **ID**: `L08.S07`
- **Name**: Token/execution budgets
- **Owning LEGO**: `L08-agent-mcp`
- **Ownership Team**: `agent-runtime`
- **Execution Model**: `in-process`
- **Runtime Host**: `H06` (Agent Host)
- **State Ownership**: `token-consumption-counters`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.agent.budget.enforce.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.runtime.budget.allocate.v1` (Provider: `L00.S03`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`token-consumption-counters`).
4. Model eksekusi mematuhi batasan runtime host `H06` (Agent Host).
