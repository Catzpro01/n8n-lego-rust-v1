# CONTRACT: L08.S08 — MCP interoperability

## 1. Sub-LEGO Identity
- **ID**: `L08.S08`
- **Name**: MCP interoperability
- **Owning LEGO**: `L08-agent-mcp`
- **Ownership Team**: `agent-runtime`
- **Execution Model**: `remote-adapter`
- **Runtime Host**: `H06` (Agent Host)
- **State Ownership**: `mcp-server-processes`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.agent.mcp.connect.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.agent.mcp.call_tool.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.agent.tool.register.v1` (Provider: `L08.S02`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`mcp-server-processes`).
4. Model eksekusi mematuhi batasan runtime host `H06` (Agent Host).
