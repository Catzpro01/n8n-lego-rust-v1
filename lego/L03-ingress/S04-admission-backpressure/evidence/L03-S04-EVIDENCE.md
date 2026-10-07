# Architecture Evidence Ledger: L03.S04 Admission and backpressure

## 1. Sub-LEGO Identity
- **ID**: `L03.S04`
- **Name**: Admission and backpressure
- **Owning LEGO**: `L03-ingress`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `rate-limit-buckets`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Rate Limit Buckets State Domain**:
   - Manages state domain `rate-limit-buckets` with token bucket mechanics per key (tenant/IP/webhook).
   - Enforces configurable maximum capacity and token refill rate over time.
2. **Backpressure & Concurrency Shedding**:
   - Enforces hard ceiling on concurrent in-flight invocations (`max_inflight`).
   - Automatically sheds load fail-closed when system limits are exceeded.
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.ingress.admission.filter.v1`.
   - Requires runtime envelope via `port.runtime.contract.envelope.v1`.
   - Rejects unauthorized invocations via security context scope validation.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test verification (`lego/L03-ingress/S04-admission-backpressure/tests/admission_backpressure_test.rs`):
  - `test_token_bucket_consume_and_refill`: PASS
  - `test_admission_service_allowed_and_rate_limited`: PASS
  - `test_cost_exceeding_capacity_rejected`: PASS
  - `test_tenant_rate_limit_isolation_and_clock_skew`: PASS
  - `test_backpressure_load_shedding_at_concurrency_ceiling`: PASS
  - `test_port_handler_admission_lifecycle`: PASS
  - `test_concurrent_multithreaded_backpressure_concurrency_ceiling`: PASS
- Direct compilation & test execution command:
  `rustc --test --edition=2021 lego/L03-ingress/S04-admission-backpressure/implementation/mod.rs -L target/debug/deps --extern serde=... --extern serde_json=... -o target/debug/test_l03_s04.exe`
  Result: 7/7 unit tests PASS (Exit Code 0).
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test admission_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
