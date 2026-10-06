# CONTRACT: L08.S06 — Memory

## 1. Sub-LEGO Identity
- **ID**: `L08.S06`
- **Name**: Memory
- **Owning LEGO**: `L08-agent-mcp`
- **Ownership Team**: `agent-runtime`
- **Execution Model**: `stateful-component`
- **Runtime Host**: `H06` (Agent Host)
- **State Ownership**: `conversation-history-chunks`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.agent.memory.store.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.agent.memory.retrieve.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`conversation-history-chunks`).
4. Model eksekusi mematuhi batasan runtime host `H06` (Agent Host).
