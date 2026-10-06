# Architecture Evidence Ledger: L06.S05 Replay and causal diagnostics

## 1. Sub-LEGO Identity
- **ID**: `L06.S05`
- **Name**: Replay and causal diagnostics
- **Owning LEGO**: `L06-realtime-observability`
- **Runtime Host**: `H03` (Execution Host)
- **State Ownership**: `causal-trace-index`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Causal Trace Index State Domain**:
   - Manages state domain `causal-trace-index` indexing execution trace spans, parent-child linkages, node inputs, and intermediate state mutations.
   - Enables recursive root-cause path reconstruction from failed downstream spans to originating parent inputs.
2. **Deterministic Replay Simulation**:
   - Reads storage log / event snapshots to replay exact execution sequences without mutating production workflow state.
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.observability.replay.trace.v1`.
   - Requires storage log access via `port.storage.wal.read.v1`.
   - Rejects unauthorized invocations via security context scope validation.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test verification:
  - Causal trace graph storage and retrieval: PASS.
  - Parent-child causal path traversal: PASS.
  - Missing trace error handling: PASS.
  - Port contract payload handling: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test causal_replay_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
