# Architecture Evidence Ledger: L07.S03 Queue/lease model

## 1. Sub-LEGO Identity
- **ID**: `L07.S03`
- **Name**: Queue/lease model
- **Owning LEGO**: `L07-scale-worker-fabric`
- **Runtime Host**: `H05` (Data Host)
- **State Ownership**: `job-queue-leases`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Multi-Tenant Queue Partitioning**:
   - Manages state domain `job-queue-leases` partitioned strictly per tenant.
   - Enforces isolation between tenants; worker dequeue operations never cross tenant boundaries.
2. **Priority Ordering**:
   - High priority jobs are dequeued strictly ahead of Normal and Low priority jobs.
3. **Lease State Machine & Reclaim**:
   - Dequeued jobs transition to `Active` with lease tokens and expiration timestamps.
   - Acknowledgment (`Complete`, `Fail`, `Retry`) verifies lease tokens and updates job state machine.
   - Expired leases are reclaimed automatically on subsequent dequeue operations.
4. **Transport-Neutral Port Contract**:
   - Provides `port.scale.queue.enqueue.v1`, `port.scale.queue.dequeue.v1`, and `port.scale.queue.ack.v1`.
   - Rejects unauthorized invocations via security context scope validation.
5. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test compilation & execution:
  `rustc --test --edition=2021 lego/L07-scale-worker-fabric/S03-queue-lease-model/implementation/mod.rs -L target/debug/deps --extern serde=... --extern serde_json=... -o target/debug/test_l07_s03.exe`
  - Result: 7/7 tests PASS (Exit code 0).
- Port contract integration tests:
  `cargo test -p n8n-port-contract --test queue_lease_port_test`
  - Result: 3/3 tests PASS (Exit code 0).
- Full workspace tests:
  `cargo test -p n8n-port-contract`
  - Result: All tests PASS (Exit code 0).
- Architecture CI Enforcement:
  `python scripts/ci_architecture_check.py`
  - Result: 11/11 checks PASS (Exit code 0).
