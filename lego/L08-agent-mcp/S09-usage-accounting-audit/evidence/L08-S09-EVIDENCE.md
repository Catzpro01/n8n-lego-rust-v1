# Architecture Evidence Ledger: L08.S09 Usage accounting and audit

## 1. Sub-LEGO Identity
- **ID**: `L08.S09`
- **Name**: Usage accounting and audit
- **Owning LEGO**: `L08-agent-mcp`
- **Runtime Host**: `H06` (Agent Host)
- **State Ownership**: `token-audit-records`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Token Audit Records State Domain**:
   - Manages state domain `token-audit-records` providing append-only, immutable token consumption records, prompt/completion tracking, and cost computation.
   - Provides granular querying and statistical summarization across tenants, sessions, and temporal intervals.
2. **Fail-Closed Record Ingestion Validation**:
   - Rejects empty audit identifiers, missing session/tenant references, zero-token submissions, and invalid negative costs fail-closed.
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.agent.usage.record.v1`.
   - Dispatches audit events to central observability via `port.observability.audit.record.v1`.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication strictly governed by public port interfaces.

## 3. Verification Commands & Results
- Unit test verification:
  - Record usage and total token aggregation: PASS.
  - Empty audit and tenant identifiers fail-closed rejection: PASS.
  - Zero token counts validation rejection: PASS.
  - Negative cost fail-closed rejection: PASS.
  - Query filtering and multi-dimensional summarization: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test agent_mcp_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
