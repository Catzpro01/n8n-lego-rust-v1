# Architecture Evidence Ledger: L10.S03 Runtime/node compatibility matrix

## 1. Sub-LEGO Identity
- **ID**: `L10.S03`
- **Name**: Runtime/node compatibility matrix
- **Owning LEGO**: `L10-release-upgrade`
- **Runtime Host**: `H07` (Compatibility Host)
- **State Ownership**: `compat-matrix-rules`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Compatibility Matrix Rules State Domain**:
   - Manages state domain `compat-matrix-rules` asserting version boundaries between workflow node definitions and runtime engines.
   - Evaluates verdicts (`FullyCompatible`, `CompatibleWithDeprecations`, `IncompatibleBreakingChanges`, `UnknownNodeOrVersion`).
2. **Fail-Closed Version Boundary Gating**:
   - Rejects unconfigured node types fail-closed with `RuleNotFound`.
   - Fails closed with breaking change verdicts when runtime version is below min_runtime_version or node version is unsupported.
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.release.compat_matrix.evaluate.v1`.
   - Queries central node catalog via `port.node.registry.query.v1`.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. Isolation strictly preserved via typed port boundaries.

## 3. Verification Commands & Results
- Unit test verification:
  - Fully compatible evaluation roundtrip: PASS.
  - Unsupported node version failure verdict: PASS.
  - Runtime below minimum required version rejection: PASS.
  - Deprecated max boundary warning verdict: PASS.
  - Unknown node type fail-closed rejection: PASS.
- Port contract integration tests:
  - Port lifecycle verified in `crates/n8n-port-contract`.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
