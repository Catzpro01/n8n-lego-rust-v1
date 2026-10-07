# Architecture Evidence Ledger: L08.S03 Workflow-as-tool

## 1. Sub-LEGO Identity
- **ID**: `L08.S03`
- **Name**: Workflow-as-tool
- **Owning LEGO**: `L08-agent-mcp`
- **Runtime Host**: `H06` (Agent Host)
- **State Ownership**: `workflow-tool-manifests`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Workflow Tool Manifests State Domain**:
   - Manages state domain `workflow-tool-manifests` registering sub-workflows and dynamic workflows as callable agent tools.
   - Generates standardized model function schemas (`type: function`) from workflow parameter descriptors.
2. **Fail-Closed Recursion Guard & Depth Boundary**:
   - Enforces execution call depth tracking (`call_depth`).
   - If an agent tool call exceeds `max_call_depth`, execution fails closed with `RecursionDepthExceeded`, preventing infinite subworkflow loops.
   - Disabled manifests are rejected fail-closed with `ManifestDisabled`.
3. **Transport-Neutral Port Contract**:
   - Implements provided ports `port.agent.workflow.tool.v1` and `port.agent.wf_tool.bridge.v1`.
   - Bridges workflow execution to `port.execution.run.workflow.v1` and registers tools via `port.agent.tool.register.v1`.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test verification:
  - Register manifest and function schema generation: PASS.
  - Synchronous workflow tool invocation and output mapping: PASS.
  - Strict recursion depth limit enforcement: PASS.
  - Disabled manifest fail-closed rejection: PASS.
  - Unregistered manifest lookup rejection: PASS.
  - Port handler workflow bridge execution: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test agent_mcp_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
