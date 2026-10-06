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
- Unit test verification:
  - Token bucket consumption and refill mechanics: PASS.
  - Admission decisions (Allowed vs RateLimited vs ShedDueToBackpressure): PASS.
  - Concurrency ceiling and release mechanics: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test admission_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
