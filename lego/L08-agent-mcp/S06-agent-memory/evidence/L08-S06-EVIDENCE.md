# Architecture Evidence Ledger: L08.S06 Memory

## 1. Sub-LEGO Identity
- **ID**: `L08.S06`
- **Name**: Memory
- **Owning LEGO**: `L08-agent-mcp`
- **Runtime Host**: `H06` (Agent Host)
- **State Ownership**: `conversation-history-chunks`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Conversation History Chunks State Domain**:
   - Manages state domain `conversation-history-chunks` isolating agent session chat records and context chunks.
   - Preserves message roles (`System`, `User`, `Assistant`, `Tool`) with timestamp sequencing and metadata tags.
2. **Fail-Closed Budget & Eviction Governance**:
   - Rejects empty session identifiers and empty chunk contents fail-closed.
   - Enforces sliding window max-token budgets and evicts oldest non-system chunks upon capacity limit while protecting system prompt directives.
3. **Transport-Neutral Port Contract**:
   - Implements provided ports `port.agent.memory.store.v1` and `port.agent.memory.retrieve.v1`.
   - Requires envelope validation via `port.runtime.contract.envelope.v1`.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All external communications mediated through typed ports.

## 3. Verification Commands & Results
- Unit test verification:
  - Store and retrieve basic roundtrip: PASS.
  - Empty session ID and content fail-closed: PASS.
  - Role-based memory filtering: PASS.
  - Sliding window max tokens retrieval: PASS.
  - Capacity eviction preserving system prompt: PASS.
  - Session summary and cleanup lifecycle: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test agent_mcp_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
