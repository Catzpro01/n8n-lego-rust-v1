# Architecture Evidence Ledger: L08.S08 MCP interoperability

## 1. Sub-LEGO Identity
- **ID**: `L08.S08`
- **Name**: MCP interoperability
- **Owning LEGO**: `L08-agent-mcp`
- **Runtime Host**: `H06` (Agent Host)
- **State Ownership**: `mcp-server-processes`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **MCP Server Processes State Domain**:
   - Manages state domain `mcp-server-processes` tracking external MCP server configs, runtime sessions, and connection lifecycles (Stdio, SSE, WebSocket).
   - Handles protocol handshake, version negotiation, and dynamic tool capability discovery.
2. **Fail-Closed Tool Execution & Transport Validation**:
   - Rejects empty server identifiers, empty executable commands, and unregistered tools fail-closed.
   - Enforces disconnection state transitions prohibiting invocation against disconnected or failed server sessions.
3. **Transport-Neutral Port Contract**:
   - Implements provided ports `port.agent.mcp.connect.v1` and `port.agent.mcp.call_tool.v1`.
   - Discovered tools register into central catalog via `port.agent.tool.register.v1`.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. Isolation strictly preserved via typed port boundaries.

## 3. Verification Commands & Results
- Unit test verification:
  - Connect server and tool discovery lifecycle: PASS.
  - Empty server identifier fail-closed rejection: PASS.
  - Call tool execution lifecycle with arguments: PASS.
  - Non-existent tool call fail-closed rejection: PASS.
  - Unconnected / disconnected server invocation rejection: PASS.
  - Disconnect server session lifecycle: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test agent_mcp_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
