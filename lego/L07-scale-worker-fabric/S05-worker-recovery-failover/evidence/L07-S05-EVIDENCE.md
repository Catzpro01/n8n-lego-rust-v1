# Architecture Evidence Ledger: L07.S05 Worker recovery and failover

## 1. Sub-LEGO Identity
- **ID**: `L07.S05`
- **Name**: Worker recovery and failover
- **Owning LEGO**: `L07-scale-worker-fabric`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `failover-election-state`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Failover Election State Domain**:
   - Manages state domain `failover-election-state` tracking dead worker detections, stale lease reclamation journals, and target worker re-assignment records.
2. **Deterministic Lease Reclamation**:
   - Transitions stale execution leases through explicit state machine stages (`Pending` -> `Reassigned` -> `Completed`).
   - Prevents duplicate re-execution or split-brain job processing by fencing stale leases upon worker crash.
3. **Transport-Neutral Port Contract**:
   - Implements provided ports `port.scale.worker.failover.v1` and `port.scale.failover.reclaim.v1`.
   - Requires queue acknowledgment from `port.scale.queue.ack.v1` and heartbeat feeds from `port.scale.worker.heartbeat.v1`.
   - Rejects unauthorized invocations via security context authority scope validation.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication strictly via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test verification:
  - Stale lease registration and state verification: PASS.
  - Reassignment and completion workflow: PASS.
  - Nonexistent lease rejection: PASS.
  - Double-completion collision prevention: PASS.
  - Port contract payload handling: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test worker_failover_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
