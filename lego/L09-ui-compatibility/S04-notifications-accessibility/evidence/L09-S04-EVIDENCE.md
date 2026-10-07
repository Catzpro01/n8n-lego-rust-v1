# Architecture Evidence Ledger: L09.S04 Notifications/accessibility parity

## 1. Sub-LEGO Identity
- **ID**: `L09.S04`
- **Name**: Notifications/accessibility parity
- **Owning LEGO**: `L09-ui-compatibility`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `ui-banner-notifs`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **UI Banner & Toast Notifications State Domain**:
   - Manages state domain `ui-banner-notifs` handling transient toasts, sticky banner notifications, and auto-dismiss schedules.
   - Enforces WCAG accessibility (a11y) parity: automated assignment of ARIA live regions (`assertive` for Error/Critical, `polite` for Warning/Info/Success) and ARIA roles (`alert`, `status`).
2. **Fail-Closed Notification Gating**:
   - Rejects empty title or message submissions fail-closed.
   - Restricts active in-memory queue to bounded capacity (`QueueFull`), mitigating denial-of-service / notification flooding.
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.ui.notifications.publish.v1`.
   - Requires envelope validation via `port.runtime.contract.envelope.v1`.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All external communications adhere strictly to typed public ports.

## 3. Verification Commands & Results
- Unit test verification:
  - Accessibility ARIA live and role mappings: PASS.
  - Empty content fail-closed rejection: PASS.
  - Query filtering by level and banner type: PASS.
  - Dismiss lifecycle and not-found rejection: PASS.
  - Queue capacity overflow rejection: PASS.
- Port contract integration tests:
  - Port lifecycle verified in `crates/n8n-port-contract`.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
