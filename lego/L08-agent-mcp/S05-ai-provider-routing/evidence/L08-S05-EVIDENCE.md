# Architecture Evidence Ledger: L08.S05 AI provider routing

## 1. Sub-LEGO Identity
- **ID**: `L08.S05`
- **Name**: AI provider routing
- **Owning LEGO**: `L08-agent-mcp`
- **Runtime Host**: `H06` (Agent Host)
- **State Ownership**: `provider-routing-table`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Provider Routing Table State Domain**:
   - Manages state domain `provider-routing-table` storing provider endpoints, model aliases, cost per 1k tokens, and fallback configurations.
   - Dynamically resolves healthy provider candidates for models (`gpt-4o`, `claude-3-5-sonnet`, etc.).
2. **Fail-Closed Fallback & Budget Accounting**:
   - If the primary provider experiences downtime, routing fails over gracefully to registered fallback providers.
   - If all providers are degraded or the model is unregistered, request fails closed with `AllProvidersUnavailable` or `ModelNotRegistered`.
   - Enforces execution budget constraints; calls exceeding available budget fail closed with `BudgetExceeded`.
3. **Transport-Neutral Port Contract**:
   - Implements provided ports `port.agent.provider.route.v1` and `port.agent.provider.chat.v1`.
   - Requires credential retrieval via `port.security.credential.release.v1` and budget validation via `port.agent.budget.enforce.v1`.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All external access is mediated by public ports and typed contracts.

## 3. Verification Commands & Results
- Unit test verification:
  - Primary provider route resolution: PASS.
  - Multi-tier fallback provider failover on outage: PASS.
  - Degradation of all providers fail-closed: PASS.
  - Unregistered model lookup rejection: PASS.
  - Strict token budget limit enforcement: PASS.
  - Chat dispatch token and cost calculation: PASS.
  - Port handler routing and chat dispatch: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test agent_mcp_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
