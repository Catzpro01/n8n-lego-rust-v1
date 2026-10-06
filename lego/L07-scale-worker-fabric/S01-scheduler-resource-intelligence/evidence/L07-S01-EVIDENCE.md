# Architecture Evidence Ledger: L07.S01 Scheduler/resource intelligence

## 1. Sub-LEGO Identity
- **ID**: `L07.S01`
- **Name**: Scheduler/resource intelligence
- **Owning LEGO**: `L07-scale-worker-fabric`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `worker-capacity-table`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Worker Capacity Table State Domain**:
   - Manages state domain `worker-capacity-table` tracking worker nodes, slot allocations, memory buffers, CPU percentages, and heartbeat status.
   - Selects dispatch targets dynamically based on capacity and lowest relative load.
2. **Exhaustion Guard & Job Accounting**:
   - When all worker capacities are saturated, dispatch fails closed with `NoAvailableWorkers`.
   - Releasing jobs decrements active allocation accurately.
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.scale.scheduler.dispatch.v1`.
   - Requires queue dequeue via `port.scale.queue.dequeue.v1`.
   - Rejects unauthorized invocations via security context scope validation.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test verification:
  - Initial worker capacity and slot dispatch: PASS.
  - Load balancing across multiple worker candidates: PASS.
  - Full capacity saturation guard: PASS.
  - Worker heartbeat and job completion: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test scheduler_dispatch_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
