# Architecture Evidence Ledger: L09.S03 Realtime/browser compatibility

## 1. Sub-LEGO Identity
- **ID**: `L09.S03`
- **Name**: Realtime/browser compatibility
- **Owning LEGO**: `L09-ui-compatibility`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `browser-sock-clients`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Browser Client Sessions & Channel Routing**:
   - Manages state domain `browser-sock-clients` tracking WebSocket and SSE client connections, session IDs, and active channel subscriptions.
   - Enforces channel subscription isolation so clients only receive events for their subscribed topics.
2. **Heartbeat & Capacity Guard**:
   - Heartbeat timestamps track client liveness.
   - Max client connection capacity is enforced fail-closed against connection flooding.
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.ui.browser_sock.stream.v1`.
   - Requires real-time publishing upstream from `port.observability.realtime.publish.v1`.
   - Rejects unauthorized invocations via security context scope validation.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test compilation & execution:
  `rustc --test --edition=2021 lego/L09-ui-compatibility/S03-browser-realtime-compatibility/implementation/mod.rs -L target/debug/deps --extern serde=... --extern serde_json=... -o target/debug/test_l09_s03.exe`
  - Result: 6/6 tests PASS (Exit code 0).
- Port contract integration tests:
  `cargo test -p n8n-port-contract --test browser_sock_port_test`
  - Result: 2/2 tests PASS (Exit code 0).
- Full workspace tests:
  `cargo test -p n8n-port-contract`
  - Result: All tests PASS (Exit code 0).
- Architecture CI Enforcement:
  `python scripts/ci_architecture_check.py`
  - Result: 11/11 checks PASS (Exit code 0).
