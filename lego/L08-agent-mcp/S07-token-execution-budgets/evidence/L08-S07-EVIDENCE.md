# Architecture Evidence Ledger: L08.S07 Token/execution budgets

## 1. Sub-LEGO Identity
- **ID**: `L08.S07`
- **Name**: Token/execution budgets
- **Owning LEGO**: `L08-agent-mcp`
- **Runtime Host**: `H06` (Agent Host)
- **State Ownership**: `token-consumption-counters`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Token Consumption Counters State Domain**:
   - Manages state domain `token-consumption-counters` tracking prompt tokens, completion tokens, executed steps, and estimated dollar costs per entity/tenant.
   - Computes real-time remaining quotas and issues proactive warnings upon crossing safety threshold ratio (e.g. 80%).
2. **Fail-Closed Budget Limit Gating**:
   - Strictly enforces limits: token overflow fails closed with `TokenLimitExceeded`, step limit overflow with `StepLimitExceeded`, and financial cost overflow with `CostLimitExceeded`.
   - Rejects unallocated entities and empty identifiers fail-closed.
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.agent.budget.enforce.v1`.
   - Integrates with foundation resource allocations via `port.runtime.budget.allocate.v1`.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All interactions routed via typed public port envelopes.

## 3. Verification Commands & Results
- Unit test verification:
  - Budget allocation and pre-flight check: PASS.
  - Empty entity ID and unregistered entity fail-closed: PASS.
  - Warning threshold ratio trigger: PASS.
  - Hard token limit overflow fail-closed rejection: PASS.
  - Hard cost limit overflow rejection: PASS.
  - Hard step limit overflow rejection: PASS.
  - Consumption counter reset lifecycle: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test agent_mcp_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
