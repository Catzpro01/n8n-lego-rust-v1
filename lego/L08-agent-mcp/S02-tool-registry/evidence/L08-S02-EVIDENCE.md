# Architecture Evidence Ledger: L08.S02 Tool registry

## 1. Sub-LEGO Identity
- **ID**: `L08.S02`
- **Name**: Tool registry
- **Owning LEGO**: `L08-agent-mcp`
- **Runtime Host**: `H06` (Agent Host)
- **State Ownership**: `mcp-tool-catalog`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **MCP Tool Catalog State Domain**:
   - Manages state domain `mcp-tool-catalog` housing schema manifests, capability flags, timeouts, and required permissions for native, workflow, and MCP tools.
   - Categorizes and exposes tool definitions for model function calling.
2. **Fail-Closed Argument Schema Validation**:
   - Validates invocation arguments against registered parameter definitions (`type`, `required`).
   - Rejects missing required parameters or type mismatches fail-closed with `ValidationError`.
   - Rejects unregistered tools with `ToolNotFound` and disabled tools with `ToolDisabled`.
3. **Transport-Neutral Port Contract**:
   - Implements provided ports `port.agent.tool.register.v1` and `port.agent.tool.invoke.v1`.
   - Requires authorization check via `port.security.authz.authorize.v1`.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All external access routed through public contracts and typed ports.

## 3. Verification Commands & Results
- Unit test verification:
  - Register and retrieve tool from catalog: PASS.
  - Successful tool invocation with parameter validation: PASS.
  - Missing required parameter rejection: PASS.
  - Parameter type mismatch rejection: PASS.
  - Disabled tool fail-closed rejection: PASS.
  - Unregistered tool lookup rejection: PASS.
  - Port handler registration and invocation: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test agent_mcp_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
