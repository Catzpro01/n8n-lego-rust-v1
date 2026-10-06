# CONTRACT: L01.S05 — Unlimited/lazy workflow graph

## 1. Sub-LEGO Identity
- **ID**: `L01.S05`
- **Name**: Unlimited/lazy workflow graph
- **Owning LEGO**: `L01-execution`
- **Ownership Team**: `execution-engine`
- **Execution Model**: `in-process`
- **Runtime Host**: `H03` (Execution Host)
- **State Ownership**: `lazy-graph-frontier`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.execution.graph.expand_frontier.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)
- `port.runtime.budget.allocate.v1` (Provider: `L00.S03`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`lazy-graph-frontier`).
4. Model eksekusi mematuhi batasan runtime host `H03` (Execution Host).
