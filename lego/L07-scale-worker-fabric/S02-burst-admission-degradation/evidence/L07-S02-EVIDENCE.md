# Architecture Evidence Ledger: L07.S02 Burst admission and graceful degradation

## 1. Sub-LEGO Identity
- **ID**: `L07.S02`
- **Name**: Burst admission and graceful degradation
- **Owning LEGO**: `L07-scale-worker-fabric`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `degradation-thresholds`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Degradation Thresholds State Domain**:
   - Manages state domain `degradation-thresholds` defining monotonic pressure metrics (CPU, Memory, Queue Depth).
   - Dynamically transitions through degradation tiers: Nominal, ShedBackground, CriticalShedding, and EmergencyLockdown.
2. **Prioritized Workload Protection**:
   - Critical workflows remain admitted even in EmergencyLockdown.
   - Non-critical, telemetry, and background tasks are shed gracefully with exponential backoff / retry advice.
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.scale.admission.throttle.v1`.
   - Requires runtime envelope via `port.runtime.contract.envelope.v1`.
   - Rejects unauthorized invocations via security context scope validation.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test verification:
  - Nominal tier admittance: PASS.
  - Shed background tier deferrals: PASS.
  - Critical shedding and emergency lockdown: PASS.
  - Dynamic pressure metric updates: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test admission_throttle_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
