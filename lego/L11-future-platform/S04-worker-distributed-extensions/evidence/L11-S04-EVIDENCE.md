# Architecture Evidence Ledger: L11.S04 Worker/distributed execution extensions

## 1. Sub-LEGO Identity
- **ID**: `L11.S04`
- **Name**: Worker/distributed execution extensions
- **Owning LEGO**: `L11-future-platform`
- **Runtime Host**: `H04` (Worker Host)
- **State Ownership**: `mesh-worker-leases`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Mesh Worker Leases State Domain**:
   - Manages state domain `mesh-worker-leases` capturing cluster worker nodes, capability advertisements, active concurrency counts, and ephemeral lease tokens.
   - Enforces single authoritative ownership of lease states (`Assigned`, `Acknowledged`, `Completed`, `Expired`, `Reassigned`).
2. **Heartbeat Monitoring & Stale Worker Failover**:
   - Tracks worker heartbeats against bounded TTLs (`heartbeat_ttl_ms`).
   - Automatically marks missing workers as `Dead`, expires orphaned leases, and reassigns tasks to healthy capable workers via `sweep_stale_workers_and_reassign`.
3. **Graceful Drain & Capacity Safety**:
   - Supports safe node drainage (`drain_worker`), stopping new task dispatches and transitioning `Draining` -> `Drained` once active leases reach zero.
   - Rejects duplicate task assignments, duplicate acknowledgements, invalid tokens, and expired leases.
4. **Transport-Neutral Port Contract**:
   - Implements provided port `port.future.cluster.dispatch.v1`.
   - Requires worker registration primitives via `port.scale.worker.register.v1`.
5. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication strictly routed via public typed ports.

## 3. Verification Commands & Results
- Unit & distributed lifecycle test verification:
  - Registration and task dispatch lifecycle: PASS.
  - Duplicate task assignment rejection: PASS.
  - Duplicate acknowledgement rejection: PASS.
  - Invalid lease token rejection: PASS.
  - Worker graceful drain transition: PASS.
  - Heartbeat timeout stale worker failover and reassignment: PASS.
  - Port invocation dispatch and heartbeat: PASS.
- Port contract integration tests:
  - Port lifecycle verified in `crates/n8n-port-contract`.
