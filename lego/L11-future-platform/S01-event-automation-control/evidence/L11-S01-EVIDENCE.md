# Architecture Evidence Ledger: L11.S01 Event/automation control plane

## 1. Sub-LEGO Identity
- **ID**: `L11.S01`
- **Name**: Event/automation control plane
- **Owning LEGO**: `L11-future-platform`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `event-control-bus`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Event Control Plane & Automation Plane**:
   - Manages state domain `event-control-bus` providing tenant-isolated publish/subscribe routing, pattern-based topic dispatching, and queue management.
   - Enforces separation of control event metadata from large execution payloads (`MAX_INLINE_PAYLOAD_BYTES = 64KB`), directing large payloads to `DataHandle` and stream references.
2. **Delivery State Machine & Bounded Retries**:
   - Implements explicit delivery states: `Pending`, `Delivered`, `Acknowledged`, `Retrying`, `DeadLettered`.
   - Bounded retry policy with dead-letter escalation upon exceeding maximum retry counts.
3. **Idempotency & Backpressure Guards**:
   - Tenant-scoped idempotency key deduplication rejecting duplicate submissions fail-closed.
   - Backpressure limit validation rejecting event ingestion when subscriber queue reaches capacity.
   - Deadline validation rejecting expired event submissions (`DeadlineExpired`).
4. **Transport-Neutral Port Contract**:
   - Implements provided port `port.future.event_bus.publish.v1`.
   - Requires envelope contracts via `port.runtime.contract.envelope.v1`.
5. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication strictly routed via public typed ports.

## 3. Verification Commands & Results
- Unit test verification:
  - Topic routing with wildcards and exact match: PASS.
  - Idempotency key deduplication: PASS.
  - Deadline expiration fail-closed: PASS.
  - Multi-tenant boundary isolation: PASS.
  - Backpressure queue capacity rejection: PASS.
  - Nack retry and dead-letter escalation: PASS.
  - Large payload rejection (>64KB): PASS.
  - Port invocation handler: PASS.
- Port contract integration tests:
  - Port lifecycle verified in `crates/n8n-port-contract`.
