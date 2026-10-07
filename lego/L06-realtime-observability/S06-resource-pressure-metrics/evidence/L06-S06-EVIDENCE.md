# Architecture Evidence Ledger: L06.S06 Resource pressure and queue metrics

## 1. Sub-LEGO Identity
- **ID**: `L06.S06`
- **Name**: Resource pressure and queue metrics
- **Owning LEGO**: `L06-realtime-observability`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `pressure-telemetry-sampler`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Pressure Telemetry Sampler State Domain**:
   - Manages state domain `pressure-telemetry-sampler` tracking CPU utilization, memory pressure, queue depth, active worker jobs, and dispatch latency.
   - Computes weighted composite pressure scores and classifies operational states into `Normal`, `Warning`, and `Critical`.
2. **Adaptive Degradation Guidance**:
   - Recommends throttling and admission backpressure when composite pressure score exceeds defined thresholds (0.5 for Warning, 0.8 for Critical).
   - Bounds historical telemetry ring buffer to prevent unbounded memory growth.
3. **Transport-Neutral Port Contract**:
   - Implements provided ports `port.observability.metrics.pressure.v1` and `port.observability.pressure.poll.v1`.
   - Requires budget allocation from `port.runtime.budget.allocate.v1`.
   - Fail-closed security authorization verifies caller credentials and invocation authority scope.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication strictly via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test verification:
  - Baseline metrics sampling and report retrieval: PASS.
  - Warning and Critical pressure transition logic: PASS.
  - Bounded history queue eviction: PASS.
  - Port contract payload handling: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test resource_pressure_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
