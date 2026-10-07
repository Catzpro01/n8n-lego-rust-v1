# Architecture Evidence Ledger: L07.S06 HA control plane

## 1. Sub-LEGO Identity
- **ID**: `L07.S06`
- **Name**: HA control plane
- **Owning LEGO**: `L07-scale-worker-fabric`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `cluster-control-lease`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Cluster Control Lease State Domain**:
   - Manages state domain `cluster-control-lease` governing distributed leader election leases and monotonic epoch fencing tokens.
   - Prevents split-brain state mutations by requiring strictly increasing epoch tokens on every leader transition.
2. **Lease Expiration and Graceful Step-Down**:
   - Leases automatically lapse upon TTL expiration if not renewed by the incumbent leader.
   - Incumbent leaders can voluntarily step down, enabling instant failover election without waiting for full TTL timeout.
3. **Transport-Neutral Port Contract**:
   - Implements provided ports `port.scale.ha.election.v1` and `port.scale.ha.leader_query.v1`.
   - Requires runtime envelope access via `port.runtime.contract.envelope.v1`.
   - Fail-closed security authorization verifies caller authority scope.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication strictly via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test verification:
  - Initial leader assignment and active lease query: PASS.
  - Heartbeat lease renewal with epoch preservation: PASS.
  - Split-brain conflicting election rejection: PASS.
  - Expired lease transition and epoch advance: PASS.
  - Controlled step-down and re-election: PASS.
  - Stale epoch step-down rejection: PASS.
  - Port contract payload handling: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test ha_control_plane_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
