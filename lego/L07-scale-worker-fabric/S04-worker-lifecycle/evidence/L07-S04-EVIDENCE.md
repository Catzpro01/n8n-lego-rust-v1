# Architecture Evidence Ledger: L07.S04 Worker lifecycle

## 1. Sub-LEGO Identity
- **ID**: `L07.S04`
- **Name**: Worker lifecycle
- **Owning LEGO**: `L07-scale-worker-fabric`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `worker-heartbeat-state`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Worker Heartbeat State Domain**:
   - Manages state domain `worker-heartbeat-state` maintaining the cluster-wide registry of active execution nodes, available execution slots, and heartbeat liveness timestamps.
2. **Graceful Drain and Eviction**:
   - Manages the complete lifecycle state transitions (`Active` -> `Draining` -> `Drained` -> `Dead`).
   - Prevents dispatching new work to draining nodes while allowing in-flight jobs to conclude cleanly.
3. **Transport-Neutral Port Contract**:
   - Implements provided ports `port.scale.worker.register.v1`, `port.scale.worker.heartbeat.v1`, and `port.scale.worker.drain.v1`.
   - Requires runtime lifecycle probes via `port.runtime.lifecycle.probe.v1`.
   - Rejects unauthorized invocations via security context scope validation.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication strictly via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test verification:
  - Worker node registration and duplicate rejection: PASS.
  - Heartbeat status and slot tracking: PASS.
  - Two-stage graceful drain state transitions: PASS.
  - Heartbeat timeout and stale worker isolation: PASS.
  - Port contract payload handling: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test worker_lifecycle_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
