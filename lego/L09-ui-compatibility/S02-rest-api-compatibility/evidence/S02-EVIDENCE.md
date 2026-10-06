# Architecture Evidence Ledger: L09.S02 REST/API compatibility

## 1. Sub-LEGO Identity
- **ID**: `L09.S02`
- **Name**: REST/API compatibility
- **Owning LEGO**: `L09-ui-compatibility`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `rest-endpoint-specs`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **REST Route Specifications & Routing**:
   - Manages state domain `rest-endpoint-specs` registering standard n8n endpoints (`/rest/workflows`, `/rest/executions`, `/rest/credentials`).
   - Supports parameter extraction (`:id`) and HTTP method validation.
2. **Authentication Gate**:
   - Routes requiring permissions enforce valid session authentication or reject with `Unauthorized` fail-closed.
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.ui.rest.dispatch.v1`.
   - Requires dependencies from `port.storage.persistence.load.v1`, `port.execution.run.workflow.v1`, and `port.security.session.create.v1`.
   - Rejects unauthorized invocations via security context scope validation.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test compilation & execution:
  `rustc --test --edition=2021 lego/L09-ui-compatibility/S02-rest-api-compatibility/implementation/mod.rs -L target/debug/deps --extern serde=... --extern serde_json=... -o target/debug/test_l09_s02.exe`
  - Result: 7/7 tests PASS (Exit code 0).
- Port contract integration tests:
  `cargo test -p n8n-port-contract --test rest_dispatch_port_test`
  - Result: 2/2 tests PASS (Exit code 0).
- Full workspace tests:
  `cargo test -p n8n-port-contract`
  - Result: All tests PASS (Exit code 0).
- Architecture CI Enforcement:
  `python scripts/ci_architecture_check.py`
  - Result: 11/11 checks PASS (Exit code 0).
