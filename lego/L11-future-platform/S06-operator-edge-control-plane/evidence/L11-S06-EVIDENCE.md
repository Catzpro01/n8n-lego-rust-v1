# Architecture Evidence Ledger: L11.S06 Operator/edge control plane

## 1. Sub-LEGO Identity
- **ID**: `L11.S06`
- **Name**: Operator/edge control plane
- **Owning LEGO**: `L11-future-platform`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `edge-cluster-nodes`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Edge Cluster Nodes State Domain**:
   - Manages state domain `edge-cluster-nodes` tracking edge node health, status (`Healthy`, `Quarantined`, `Draining`, `Stopped`), and configuration versions.
   - Enforces configuration version monotonicity, rejecting version rollbacks fail-closed (`ConfigRollbackRejected`).
2. **Operator Authorization Boundary**:
   - Privileged lifecycle operations (`Quarantine`, `Drain`, `Stop`, `Recover`) require authenticated operator credentials carrying the `operator.admin` scope.
   - Unauthorized attempts are rejected fail-closed (`Unauthorized`).
   - Re-applying the same status operates idempotently without side-effects (`is_idempotent_noop`).
3. **Audit Trail Accountability**:
   - Every administrative mutation is recorded with operator principal, target node, action, before/after status, and timestamp.
4. **Transport-Neutral Port Contract**:
   - Implements provided port `port.future.edge.sync.v1`.
   - Requires envelope contracts via `port.runtime.contract.envelope.v1`.
5. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication strictly routed via public typed ports.

## 3. Verification Commands & Results
- Unit, authorization, and edge sync test verification:
  - Operator command lifecycle and idempotency: PASS.
  - Unauthorized operator command rejection: PASS.
  - Edge configuration sync and rollback rejection: PASS.
  - Operator audit trail logging: PASS.
  - Port invocation sync and command: PASS.
- Port contract integration tests:
  - Port lifecycle verified in `crates/n8n-port-contract`.
