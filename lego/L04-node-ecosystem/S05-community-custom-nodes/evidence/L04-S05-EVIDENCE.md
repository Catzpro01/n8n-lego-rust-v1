# Architecture Evidence Ledger: L04.S05 Community/private/custom node compatibility

## 1. Sub-LEGO Identity
- **ID**: `L04.S05`
- **Name**: Community/private/custom node compatibility
- **Owning LEGO**: `L04-node-ecosystem`
- **Runtime Host**: `H07` (Compatibility Host)
- **State Ownership**: `custom-node-tarballs`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Custom Node Tarballs State Domain**:
   - Manages state domain `custom-node-tarballs` tracking custom package tarballs, manifests, versions, and checksum hashes.
   - Enforces cryptographic tarball checksum verification against tampering.
2. **Package Lifecycle & Safety Controls**:
   - Supports atomic package installation, activation, and administrative disabling.
   - Disabled packages are blocked from execution fail-closed.
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.node.custom.load.v1`.
   - Requires trust evaluation via `port.node.trust.evaluate.v1` and JS compatibility invocation via `port.node.compat.invoke_js.v1`.
   - Rejects unauthorized invocations via security context scope validation.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test verification:
  - Custom node descriptor resolution: PASS.
  - Nonexistent package rejection: PASS.
  - Package disabling guard: PASS.
  - Checksum verification & tampering detection: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test custom_node_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
