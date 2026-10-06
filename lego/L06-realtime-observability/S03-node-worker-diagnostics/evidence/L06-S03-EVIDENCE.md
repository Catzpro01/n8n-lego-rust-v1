# Architecture Evidence Ledger: L06.S03 Node/plugin/worker diagnostics

## 1. Sub-LEGO Identity
- **ID**: `L06.S03`
- **Name**: Node/plugin/worker diagnostics
- **Owning LEGO**: `L06-realtime-observability`
- **Runtime Host**: `H04` (Worker Host)
- **State Ownership**: `diagnostics-ring-buffer`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Diagnostics Ring Buffer State Domain**:
   - Manages state domain `diagnostics-ring-buffer` tracking structured diagnostic events, worker status traces, and execution telemetry in a fixed-size ring buffer.
   - Prevents memory leaks by automatically discarding the oldest entries when capacity is reached.
2. **Deterministic Query & Filtering**:
   - Supports filtering by source entity, minimum diagnostic level, and result count limit.
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.observability.diagnostics.capture.v1`.
   - Requires runtime envelope via `port.runtime.contract.envelope.v1`.
   - Rejects unauthorized invocations via security context scope validation.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test verification:
  - Event capture and retrieval: PASS.
  - Ring buffer eviction of oldest entries: PASS.
  - Diagnostic level filtering: PASS.
  - Port contract payload handling: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test diagnostics_capture_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
