# Architecture Evidence Ledger: L10.S04 Upgrade/rollback

## 1. Sub-LEGO Identity
- **ID**: `L10.S04`
- **Name**: Upgrade/rollback
- **Owning LEGO**: `L10-release-upgrade`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `upgrade-stage-offsets`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Upgrade Stage Offsets State Domain**:
   - Manages state domain `upgrade-stage-offsets` tracking cluster upgrade stages (`PreflightCheck`, `WorkerDrain`, `MigrationApply`, `HealthVerification`, `Completed`, `RolledBack`).
   - Ensures monotonic progression and deterministic stage offsets enabling resume/recovery.
2. **Fail-Closed Automated Rollback Gating**:
   - Rejects empty identifiers and invalid stage transitions fail-closed.
   - Triggers automated rollback to offset 0 with detailed incident logs upon migration or health probe failure.
3. **Transport-Neutral Port Contract**:
   - Implements provided ports `port.release.lifecycle.upgrade_step.v1` and `port.release.lifecycle.rollback_step.v1`.
   - Requires migration integration via `port.release.migration.apply.v1` and worker drain via `port.scale.worker.drain.v1`.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication strictly routed via public typed ports.

## 3. Verification Commands & Results
- Unit test verification:
  - Multi-stage upgrade progression to Completed: PASS.
  - Empty identifier fail-closed rejection: PASS.
  - Trigger rollback and stage-offset zeroization: PASS.
  - Invalid state transition after completion rejection: PASS.
- Port contract integration tests:
  - Port lifecycle verified in `crates/n8n-port-contract`.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
