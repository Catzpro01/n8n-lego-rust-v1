# Architecture Evidence Ledger: L09.S06 Frontend migration/decommission plan

## 1. Sub-LEGO Identity
- **ID**: `L09.S06`
- **Name**: Frontend migration/decommission plan
- **Owning LEGO**: `L09-ui-compatibility`
- **Runtime Host**: `H07` (Compatibility Host)
- **State Ownership**: `decommission-milestones`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Decommission Milestones State Domain**:
   - Manages state domain `decommission-milestones` governing the systematic deprecation, traffic shifting, and decommissioning of legacy Node/Vue frontend surfaces.
   - Enforces lifecycle state transitions (`Planned` -> `InFlight` -> `Decommissioned` -> `Archived`).
2. **Fail-Closed Validation & Progress Gating**:
   - Rejects empty identifiers and out-of-range traffic percentages (>100%) fail-closed.
   - Computes aggregate parity audit metrics across all monitored surface endpoints.
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.ui.decommission.audit.v1`.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication strictly governed by public port interfaces.

## 3. Verification Commands & Results
- Unit test verification:
  - Milestone registration and audit report calculation: PASS.
  - Empty identifier fail-closed rejection: PASS.
  - Traffic percentage shift and status transition: PASS.
  - Out-of-bounds traffic percentage (>100%) rejection: PASS.
- Port contract integration tests:
  - Port lifecycle verified in `crates/n8n-port-contract`.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
