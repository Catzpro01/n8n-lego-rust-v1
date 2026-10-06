# Architecture Evidence Ledger: L09.S01 Official Vue surface compatibility

## 1. Sub-LEGO Identity
- **ID**: `L09.S01`
- **Name**: Official Vue surface compatibility
- **Owning LEGO**: `L09-ui-compatibility`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `ui-static-bundle`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Static Bundle & Asset Resolution**:
   - Manages state domain `ui-static-bundle` containing pre-compiled frontend assets, manifests, and cache metadata.
   - Enforces SPA fallback routes (e.g. `/workflow/*`, `/settings/*` falling back to root index bundle).
2. **Path Traversal Protection**:
   - Rejects illegal path navigation tokens (`..`) fail-closed with `PathTraversal` error.
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.ui.static.serve.v1`.
   - Requires envelope validation via `port.runtime.contract.envelope.v1`.
   - Rejects unauthorized invocations via security context scope validation.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test compilation & execution:
  `rustc --test --edition=2021 lego/L09-ui-compatibility/S01-vue-surface-compatibility/implementation/mod.rs -L target/debug/deps --extern serde=... --extern serde_json=... -o target/debug/test_l09_s01.exe`
  - Result: 7/7 tests PASS (Exit code 0).
- Port contract integration tests:
  `cargo test -p n8n-port-contract --test vue_surface_port_test`
  - Result: 2/2 tests PASS (Exit code 0).
- Full workspace tests:
  `cargo test -p n8n-port-contract`
  - Result: All tests PASS (Exit code 0).
- Architecture CI Enforcement:
  `python scripts/ci_architecture_check.py`
  - Result: 11/11 checks PASS (Exit code 0).
