# CONTRACT: L08.S03 — Workflow-as-tool

## 1. Sub-LEGO Identity
- **ID**: `L08.S03`
- **Name**: Workflow-as-tool
- **Owning LEGO**: `L08-agent-mcp`
- **Ownership Team**: `agent-runtime`
- **Execution Model**: `in-process`
- **Runtime Host**: `H06` (Agent Host)
- **State Ownership**: `workflow-tool-bridges`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.agent.wf_tool.bridge.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.execution.run.workflow.v1` (Provider: `L01.S01`)
- `port.agent.tool.register.v1` (Provider: `L08.S02`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`workflow-tool-bridges`).
4. Model eksekusi mematuhi batasan runtime host `H06` (Agent Host).
