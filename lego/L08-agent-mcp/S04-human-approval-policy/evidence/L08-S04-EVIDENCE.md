# Architecture Evidence Ledger: L08.S04 Human approval and policy boundary

## 1. Sub-LEGO Identity
- **ID**: `L08.S04`
- **Name**: Human approval and policy boundary
- **Owning LEGO**: `L08-agent-mcp`
- **Runtime Host**: `H06` (Agent Host)
- **State Ownership**: `human-approval-inbox`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Human Approval Inbox State Domain**:
   - Manages state domain `human-approval-inbox` holding pending, approved, rejected, and expired authorization requests for agent tool execution.
   - Enforces policy-based risk evaluation (`Low`, `Medium`, `High`, `Critical`).
2. **Fail-Closed Risk Gating & Expiration Handling**:
   - Evaluates actions: low-risk actions pass through while High/Critical actions require human approval.
   - Pending requests that exceed `timeout_seconds` fail closed with `RequestExpired`, prohibiting late or unauthorized execution.
   - Prevents conflicting double decisions fail-closed with `AlreadyDecided`.
3. **Transport-Neutral Port Contract**:
   - Implements provided ports `port.agent.policy.approve.v1`, `port.agent.approval.request.v1`, and `port.agent.approval.submit.v1`.
   - Requires authorization validation via `port.security.authz.authorize.v1`.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All external access is mediated by public ports and typed contracts.

## 3. Verification Commands & Results
- Unit test verification:
  - Policy evaluation distinguishing low risk vs critical risk: PASS.
  - Auto-approval of safe low-risk tools: PASS.
  - Creation and operator approval of critical tool action: PASS.
  - Rejection of unauthorized/destructive tool request: PASS.
  - Double decision rejection (`AlreadyDecided`): PASS.
  - Expiration after timeout fail-closed (`RequestExpired`): PASS.
  - Port handler approval lifecycle: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test agent_mcp_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
