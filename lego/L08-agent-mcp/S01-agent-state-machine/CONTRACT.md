# CONTRACT: L08.S01 — Agent state machine

## 1. Sub-LEGO Identity
- **ID**: `L08.S01`
- **Name**: Agent state machine
- **Owning LEGO**: `L08-agent-mcp`
- **Ownership Team**: `agent-runtime`
- **Execution Model**: `stateful-component`
- **Runtime Host**: `H06` (Agent Host)
- **State Ownership**: `agent-execution-tree`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.agent.engine.run.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.agent.tool.invoke.v1` (Provider: `L08.S02`)
- `port.agent.provider.chat.v1` (Provider: `L08.S05`)
- `port.agent.memory.retrieve.v1` (Provider: `L08.S06`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`agent-execution-tree`).
4. Model eksekusi mematuhi batasan runtime host `H06` (Agent Host).
