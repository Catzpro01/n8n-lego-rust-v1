# Architecture Evidence Ledger: L06.S07 Audit and bounded retention

## 1. Sub-LEGO Identity
- **ID**: `L06.S07`
- **Name**: Audit and bounded retention
- **Owning LEGO**: `L06-realtime-observability`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `audit-retention-ledger`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Audit Retention Ledger State Domain**:
   - Manages state domain `audit-retention-ledger` recording immutable audit events with strictly monotonic sequence identifiers.
   - Enforces strict tenant partitioning across query interfaces to prevent unauthorized cross-tenant data leakage.
2. **Bounded Capacity and TTL Pruning**:
   - Enforces dual retention bounds: maximum capacity eviction via FIFO ring buffer and time-based TTL expiration pruning.
3. **Transport-Neutral Port Contract**:
   - Implements provided ports `port.observability.audit.record.v1` and `port.observability.audit.query.v1`.
   - Requires security validation from `port.security.context.validate.v1`.
   - Fail-closed security authorization verifies caller credentials and invocation authority scope.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All interactions via public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test verification:
  - Monotonic sequence assignment: PASS.
  - Multi-tenant query isolation: PASS.
  - Bounded memory capacity FIFO pruning: PASS.
  - Time-to-live (TTL) expiration pruning: PASS.
  - Port contract payload handling: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test audit_retention_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
