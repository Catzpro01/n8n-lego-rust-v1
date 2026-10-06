# Architecture Evidence Ledger: L09.S05 Enterprise-facing compatibility surfaces

## 1. Sub-LEGO Identity
- **ID**: `L09.S05`
- **Name**: Enterprise-facing compatibility surfaces
- **Owning LEGO**: `L09-ui-compatibility`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `enterprise-license-claims`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Enterprise License & Feature Matrix**:
   - Manages state domain `enterprise-license-claims` validating multi-tenant feature flags, license expiration dates, and tier allocations (Community, Starter, Pro, Enterprise).
   - Enforces tier quotas (max active workflows, max seats) and tenant isolation.
2. **Expired License Fail-Closed**:
   - Expired licenses automatically downgrade features to community baseline, rejecting enterprise capability invocations.
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.ui.enterprise.features.v1`.
   - Requires authorization integration via `port.security.authz.authorize.v1`.
   - Rejects unauthorized invocations via security context scope validation.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test compilation & execution:
  `rustc --test --edition=2021 lego/L09-ui-compatibility/S05-enterprise-compatibility-surfaces/implementation/mod.rs -L target/debug/deps --extern serde=... --extern serde_json=... -o target/debug/test_l09_s05.exe`
  - Result: 6/6 tests PASS (Exit code 0).
- Port contract integration tests:
  `cargo test -p n8n-port-contract --test enterprise_features_port_test`
  - Result: 2/2 tests PASS (Exit code 0).
- Full workspace tests:
  `cargo test -p n8n-port-contract`
  - Result: All tests PASS (Exit code 0).
- Architecture CI Enforcement:
  `python scripts/ci_architecture_check.py`
  - Result: 11/11 checks PASS (Exit code 0).
