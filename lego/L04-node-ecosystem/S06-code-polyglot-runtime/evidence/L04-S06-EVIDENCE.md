# Architecture Evidence Ledger: L04.S06 Code/polyglot runtime contracts

## 1. Sub-LEGO Identity
- **ID**: `L04.S06`
- **Name**: Code/polyglot runtime contracts
- **Owning LEGO**: `L04-node-ecosystem`
- **Runtime Host**: `H04` (Worker Host)
- **State Ownership**: `polyglot-isolated-sandbox`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Polyglot Isolated Sandbox State Domain**:
   - Manages state domain `polyglot-isolated-sandbox` tracking isolated sandbox evaluations across multiple languages (JavaScript, Python).
   - Enforces memory limit allocations, timeout limits, and structured input/output envelopes.
2. **Host Escape & Safety Defenses**:
   - Pre-validation and sandbox boundaries detect and block host process escape vectors fail-closed.
   - Syntax validation prevents malformed execution runs.
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.node.polyglot.execute.v1`.
   - Requires budget allocation via `port.runtime.budget.allocate.v1`.
   - Rejects unauthorized invocations via security context scope validation.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test verification:
  - JavaScript sandbox execution: PASS.
  - Python isolate execution: PASS.
  - Empty code syntax error: PASS.
  - Host escape instruction blocking: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test polyglot_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
