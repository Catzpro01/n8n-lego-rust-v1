# Architecture Evidence Ledger: L04.S02 Trust/quarantine/runtime locality

## 1. Sub-LEGO Identity
- **ID**: `L04.S02`
- **Name**: Trust/quarantine/runtime locality
- **Owning LEGO**: `L04-node-ecosystem`
- **Runtime Host**: `H04` (Worker Host)
- **State Ownership**: `node-trust-tiers`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Node Trust Tiers State Domain**:
   - Manages state domain `node-trust-tiers` classifying node implementations across CoreVerified, VerifiedCommunity, UnverifiedCommunity, and Quarantined tiers.
   - Enforces execution locality mapping: InProcess, WorkerPool, SandboxedWorker, or Blocked.
2. **Quarantine Fail-Closed Guard**:
   - Quarantined nodes transition strictly to Blocked locality with non-executable status and audit reason.
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.node.trust.evaluate.v1`.
   - Requires authorization via `port.security.authz.authorize.v1`.
   - Rejects unauthorized invocations via security context scope validation.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test verification:
  - Core verified node evaluation: PASS.
  - Unknown node fallback to SandboxedWorker: PASS.
  - Quarantining mechanics and execution block: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test node_trust_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
