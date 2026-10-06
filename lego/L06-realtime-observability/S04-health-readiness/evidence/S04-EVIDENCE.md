# Architecture Evidence Ledger: L06.S04 Health/readiness

## 1. Sub-LEGO Identity
- **ID**: `L06.S04`
- **Name**: Health/readiness
- **Owning LEGO**: `L06-realtime-observability`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `system-readiness-map`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Multi-Component Readiness Tracking**:
   - Manages state domain `system-readiness-map` tracking readiness of all core subsystems (storage, execution, queue, wal, network).
   - Component state machine transitions through `Initializing` -> `Ready` / `Degraded` / `NotReady`.
2. **Fail-Closed Aggregate Evaluation**:
   - If any component is in `NotReady` state, overall system readiness fails-closed to `NotReady` with HTTP 503 status code.
   - Degraded components result in `Degraded` status (HTTP 200 with degraded indication).
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.observability.health.check.v1`.
   - Requires and integrates lifecycle probe from `port.runtime.lifecycle.probe.v1`.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test compilation & execution:
  `rustc --test --edition=2021 lego/L06-realtime-observability/S04-health-readiness/implementation/mod.rs -L target/debug/deps --extern serde=... --extern serde_json=... -o target/debug/test_l06_s04.exe`
  - Result: 7/7 tests PASS (Exit code 0).
- Port contract integration tests:
  `cargo test -p n8n-port-contract --test health_readiness_port_test`
  - Result: 2/2 tests PASS (Exit code 0).
- Full workspace tests:
  `cargo test -p n8n-port-contract`
  - Result: All tests PASS (Exit code 0).
- Architecture CI Enforcement:
  `python scripts/ci_architecture_check.py`
  - Result: 11/11 checks PASS (Exit code 0).
